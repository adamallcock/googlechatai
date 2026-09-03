import unittest

from googlechatai.execute import CHAT_API_BASE_URL, execute_chat_plan
from googlechatai.messages import (
    plan_complete_placeholder_response,
    plan_send_to_space,
    plan_send_to_user,
    plan_stream_message,
)
from googlechatai.pins import plan_ensure_message_pinned
from googlechatai.transport import InMemoryIdempotencyStore


def get_access_token(force_refresh: bool = False):
    return {"accessToken": "test-token", "refreshed": force_refresh}


class FakeSend:
    def __init__(self, respond):
        self.respond = respond
        self.calls = []

    def __call__(self, request):
        self.calls.append(dict(request))
        status, body = self.respond(request, len(self.calls) - 1)
        return {
            "ok": 200 <= status < 300,
            "status": status,
            "headers": {},
            "json": body,
        }


def send_to_space_plan():
    return plan_send_to_space(
        {
            "space": "spaces/AAA",
            "text": "Hello",
            "requestId": "req-fixed",
            "clientMessageId": "client-fixed",
        }
    )


class ExecuteDryRunTest(unittest.TestCase):
    def test_defaults_to_dry_run_and_never_sends(self) -> None:
        send = FakeSend(lambda request, index: (200, {}))
        execution = execute_chat_plan(
            send_to_space_plan(), auth=get_access_token, send=send
        )
        self.assertEqual(execution["mode"], "dryRun")
        self.assertTrue(execution["ok"])
        self.assertEqual(send.calls, [])
        self.assertEqual(execution["steps"][0]["status"], "planned")
        self.assertEqual(
            execution["steps"][0]["url"],
            f"{CHAT_API_BASE_URL}/v1/spaces/AAA/messages"
            "?requestId=req-fixed&messageId=client-fixed",
        )

    def test_reports_capability_blocks(self) -> None:
        plan = plan_send_to_user(
            {
                "email": "ada@example.com",
                "text": "hi",
                "requestId": "req-fixed",
                "clientMessageId": "client-fixed",
            }
        )
        execution = execute_chat_plan(plan)
        self.assertFalse(execution["ok"])
        self.assertEqual(execution["blocked"]["reason"], "capability")
        self.assertTrue(
            all(step["status"] == "planned" for step in execution["steps"])
        )

    def test_marks_unresolved_placeholders(self) -> None:
        plan = plan_send_to_user(
            {
                "email": "ada@example.com",
                "text": "hi",
                "requestId": "req-fixed",
                "clientMessageId": "client-fixed",
            }
        )
        execution = execute_chat_plan(plan)
        second = execution["steps"][1]
        self.assertEqual(second["skippedReason"], "unresolved_placeholder")
        self.assertIn("{resolvedDirectMessageSpace}", second["url"])

    def test_rejects_plans_without_requests(self) -> None:
        with self.assertRaises(TypeError):
            execute_chat_plan({"kind": "chat.async_response_plan"})

    def test_rejects_unknown_modes(self) -> None:
        with self.assertRaises(TypeError):
            execute_chat_plan(send_to_space_plan(), mode="yolo")


class ExecuteLiveTest(unittest.TestCase):
    def test_skips_ensure_pinned_creation_when_target_is_already_pinned(self) -> None:
        plan = plan_ensure_message_pinned(
            {
                "space": "spaces/AAA",
                "message": "spaces/AAA/messages/BBB",
                "authMode": "user",
            }
        )
        send = FakeSend(
            lambda request, index: (
                200,
                {
                    "messagePins": [
                        {
                            "name": "spaces/AAA/messagePins/BBB",
                            "message": "spaces/AAA/messages/BBB",
                        }
                    ]
                },
            )
        )

        execution = execute_chat_plan(
            plan, mode="live", auth=get_access_token, send=send
        )

        self.assertTrue(execution["ok"])
        self.assertEqual(len(send.calls), 1)
        self.assertEqual(
            [step["status"] for step in execution["steps"]],
            ["executed", "skipped"],
        )
        self.assertEqual(execution["steps"][1]["skippedReason"], "already_pinned")

    def test_creates_message_pin_when_complete_list_does_not_contain_target(self) -> None:
        plan = plan_ensure_message_pinned(
            {
                "space": "spaces/AAA",
                "message": "spaces/AAA/messages/BBB",
                "authMode": "user",
            }
        )

        def respond(request, index):
            if index == 0:
                return 200, {"messagePins": []}
            return 200, {
                "name": "spaces/AAA/messagePins/BBB",
                "message": "spaces/AAA/messages/BBB",
            }

        send = FakeSend(respond)
        execution = execute_chat_plan(
            plan, mode="live", auth=get_access_token, send=send
        )

        self.assertTrue(execution["ok"])
        self.assertEqual(len(send.calls), 2)
        self.assertEqual(send.calls[1]["method"], "POST")
        self.assertEqual(
            send.calls[1]["body"], {"message": "spaces/AAA/messages/BBB"}
        )
        self.assertEqual(
            [step["status"] for step in execution["steps"]],
            ["executed", "executed"],
        )

    def test_fails_closed_when_ensure_pinned_list_is_not_complete(self) -> None:
        plan = plan_ensure_message_pinned(
            {
                "space": "spaces/AAA",
                "message": "spaces/AAA/messages/BBB",
                "authMode": "user",
            }
        )
        send = FakeSend(
            lambda request, index: (200, {"messagePins": [], "nextPageToken": "more-pins"})
        )

        execution = execute_chat_plan(
            plan, mode="live", auth=get_access_token, send=send
        )

        self.assertFalse(execution["ok"])
        self.assertEqual(len(send.calls), 1)
        self.assertEqual(execution["steps"][1]["status"], "failed")
        self.assertEqual(
            execution["steps"][1]["error"],
            {
                "name": "ConditionEvaluationError",
                "message": (
                    "Cannot safely ensure a message pin because "
                    "spaces.messagePins.list returned a nextPageToken."
                ),
            },
        )

    def test_executes_and_captures_created_messages(self) -> None:
        send = FakeSend(
            lambda request, index: (200, {"name": "spaces/AAA/messages/BBB"})
        )
        execution = execute_chat_plan(
            send_to_space_plan(), mode="live", auth=get_access_token, send=send
        )
        self.assertTrue(execution["ok"])
        self.assertEqual(len(send.calls), 1)
        self.assertEqual(
            send.calls[0]["url"],
            f"{CHAT_API_BASE_URL}/v1/spaces/AAA/messages"
            "?requestId=req-fixed&messageId=client-fixed",
        )
        self.assertEqual(execution["steps"][0]["status"], "executed")
        self.assertEqual(execution["steps"][0]["httpStatus"], 200)
        self.assertEqual(
            execution["createdMessages"], [{"name": "spaces/AAA/messages/BBB"}]
        )

    def test_blocks_direct_message_plans(self) -> None:
        plan = plan_send_to_user(
            {
                "email": "ada@example.com",
                "text": "hi",
                "requestId": "req-fixed",
                "clientMessageId": "client-fixed",
            }
        )
        send = FakeSend(lambda request, index: (200, {}))
        execution = execute_chat_plan(
            plan, mode="live", auth=get_access_token, send=send
        )
        self.assertFalse(execution["ok"])
        self.assertEqual(execution["blocked"]["reason"], "capability")
        self.assertTrue(
            all(step["status"] == "skipped" for step in execution["steps"])
        )

    def test_resolves_direct_message_placeholder(self) -> None:
        plan = plan_send_to_user(
            {
                "email": "ada@example.com",
                "text": "hi",
                "requestId": "req-fixed",
                "clientMessageId": "client-fixed",
            }
        )

        def respond(request, index):
            if "findDirectMessage" in request["url"]:
                return 200, {"name": "spaces/DM123"}
            return 200, {"name": "spaces/DM123/messages/M1"}

        send = FakeSend(respond)
        execution = execute_chat_plan(
            plan,
            mode="live",
            auth=get_access_token,
            send=send,
            override_capability=True,
            allow_direct_messages=True,
        )
        self.assertTrue(execution["ok"])
        self.assertIn("/v1/spaces/DM123/messages", send.calls[1]["url"])
        self.assertEqual(
            execution["resolvedPlaceholders"]["resolvedDirectMessageSpace"],
            "spaces/DM123",
        )

    def test_unresolved_placeholder_fails_live_runs(self) -> None:
        plan = plan_send_to_user(
            {
                "email": "ada@example.com",
                "text": "hi",
                "requestId": "req-fixed",
                "clientMessageId": "client-fixed",
            }
        )
        send = FakeSend(lambda request, index: (200, {}))
        execution = execute_chat_plan(
            plan,
            mode="live",
            auth=get_access_token,
            send=send,
            override_capability=True,
            allow_direct_messages=True,
        )
        self.assertFalse(execution["ok"])
        self.assertEqual(
            execution["steps"][1]["error"]["name"], "UnresolvedPlaceholderError"
        )

    def test_applies_stream_throttle_delays(self) -> None:
        plan = plan_stream_message(
            {
                "space": "spaces/AAA",
                "initialText": "Thinking...",
                "message": "spaces/AAA/messages/M1",
                "patchTexts": ["first", "first second"],
                "throttleMs": 750,
                "requestId": "req-fixed",
                "clientMessageId": "client-fixed",
            }
        )
        delays: list[int] = []
        send = FakeSend(
            lambda request, index: (200, {"name": "spaces/AAA/messages/M1"})
        )
        execution = execute_chat_plan(
            plan,
            mode="live",
            auth=get_access_token,
            send=send,
            sleep=delays.append,
        )
        self.assertTrue(execution["ok"])
        self.assertEqual(delays, [750])
        self.assertEqual(execution["steps"][1]["throttleAppliedMs"], 750)
        self.assertEqual(execution["steps"][2]["throttleAppliedMs"], 0)

    def test_skips_duplicate_request_ids(self) -> None:
        store = InMemoryIdempotencyStore()
        send = FakeSend(
            lambda request, index: (200, {"name": "spaces/AAA/messages/BBB"})
        )
        first = execute_chat_plan(
            send_to_space_plan(),
            mode="live",
            auth=get_access_token,
            send=send,
            idempotency_store=store,
        )
        second = execute_chat_plan(
            send_to_space_plan(),
            mode="live",
            auth=get_access_token,
            send=send,
            idempotency_store=store,
        )
        self.assertTrue(first["ok"])
        self.assertTrue(second["ok"])
        self.assertEqual(second["steps"][0]["status"], "skipped")
        self.assertEqual(second["steps"][0]["skippedReason"], "duplicate_request_id")
        self.assertEqual(len(send.calls), 1)

    def test_reports_missing_auth(self) -> None:
        send = FakeSend(lambda request, index: (200, {}))
        execution = execute_chat_plan(
            send_to_space_plan(),
            mode="live",
            auth={"user": get_access_token},
            send=send,
        )
        self.assertFalse(execution["ok"])
        self.assertEqual(execution["blocked"]["reason"], "missing_auth")

    def test_records_failures_and_stops(self) -> None:
        send = FakeSend(
            lambda request, index: (403, {"error": {"message": "denied"}})
        )
        execution = execute_chat_plan(
            send_to_space_plan(), mode="live", auth=get_access_token, send=send
        )
        self.assertFalse(execution["ok"])
        self.assertEqual(execution["steps"][0]["status"], "failed")
        self.assertEqual(execution["steps"][0]["httpStatus"], 403)
        self.assertEqual(len(send.calls), 1)

    def test_falls_back_to_new_message_on_patch_failure(self) -> None:
        plan = plan_complete_placeholder_response(
            {
                "handle": {
                    "kind": "chat.placeholder_response_handle",
                    "space": "spaces/AAA",
                    "messageName": "spaces/AAA/messages/PLACEHOLDER",
                    "editable": True,
                    "authMode": "app",
                    "allowedUpdateMasks": ["text"],
                },
                "text": "final answer",
                "onPatchFailure": "createNewMessage",
                "fallbackRequestId": "req-fallback",
                "fallbackClientMessageId": "client-fallback",
            }
        )

        def respond(request, index):
            if request["method"] == "PATCH":
                return 404, {"error": {"message": "gone"}}
            return 200, {"name": "spaces/AAA/messages/NEW"}

        send = FakeSend(respond)
        execution = execute_chat_plan(
            plan, mode="live", auth=get_access_token, send=send
        )
        self.assertTrue(execution["ok"])
        self.assertEqual(len(send.calls), 2)
        self.assertEqual(execution["steps"][0]["status"], "failed")
        self.assertEqual(execution["steps"][0]["fallback"]["status"], "executed")
        self.assertEqual(
            execution["createdMessages"], [{"name": "spaces/AAA/messages/NEW"}]
        )


if __name__ == "__main__":
    unittest.main()
