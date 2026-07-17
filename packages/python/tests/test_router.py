import asyncio
import copy
import json
import logging
import pathlib
import sys
import time
import threading
import types
import unittest
from typing import Any

from googlechatai import GoogleChatAI, InMemoryIdempotencyStore, json_response
from googlechatai.adapters.asgi import ASGIAdapter
from googlechatai.router.replies import ReplyBuilder


ROOT = pathlib.Path(__file__).resolve().parents[3]


def read_json(relative_path: str) -> dict[str, Any]:
    return json.loads((ROOT / relative_path).read_text(encoding="utf-8"))


class _CapturingHandler(logging.Handler):
    """Collects log records so tests can poll for a late-arriving log line
    emitted from a background thread, without repeatedly re-installing
    ``assertLogs`` handlers."""

    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)

    def wait_for(self, substring: str, *, timeout: float = 2.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if any(substring in record.getMessage() for record in self.records):
                return True
            time.sleep(0.01)
        return any(substring in record.getMessage() for record in self.records)


class FakeContextLoader:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def current_message(self, event: dict[str, Any]) -> dict[str, Any] | None:
        self.calls.append("current_message")
        return event["message"]

    async def quoted_message_tree(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        self.calls.append("quoted_message_tree")
        return [{"relationship": "quote", "message": event["message"]}]

    async def thread_history(self, event: dict[str, Any], **options: Any) -> dict[str, Any]:
        self.calls.append(f"thread_history:{options['limit']}")
        return {"status": "partial", "messages": [], "systemNotes": ["thread stub"]}

    async def room_history(self, event: dict[str, Any], **options: Any) -> dict[str, Any]:
        self.calls.append(f"room_history:{options['limit']}")
        return {"status": "unavailable", "messages": [], "systemNotes": ["room stub"]}

    async def attachments(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        self.calls.append("attachments")
        return event["message"]["attachments"]

    async def sender_identities(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        self.calls.append("sender_identities")
        return [event["actor"]]

    def timestamps(self, event: dict[str, Any]) -> dict[str, Any]:
        self.calls.append("timestamps")
        return {"receivedAt": event["receivedAt"]}

    def relationship_system_notes(self, event: dict[str, Any]) -> list[str]:
        self.calls.append("relationship_system_notes")
        return [f"System Note: Received {event['kind']}."]


class RouterTests(unittest.TestCase):
    def test_standalone_placeholder_helper_does_not_require_an_event_target(self) -> None:
        reply = ReplyBuilder()

        placeholder = reply.placeholder("Thinking...")

        self.assertEqual(placeholder.payload, {"text": "Thinking..."})
        self.assertIsNone(placeholder.reply_target)

    def test_dispatches_message_fixture_to_async_handler(self) -> None:
        chat = GoogleChatAI()
        raw = read_json("fixtures/events/message-created/basic.json")
        seen: dict[str, Any] = {}

        @chat.on_message
        async def handle_message(ctx):
            seen["kind"] = ctx.event["kind"]
            seen["plain_text"] = ctx.current_message["plainTextForModel"]
            seen["raw_type"] = ctx.raw_event["type"]
            return ctx.reply.placeholder("Working on it")

        response = asyncio.run(chat.dispatch_async(raw, source="fixture"))

        self.assertEqual(response, {"text": "Working on it"})
        self.assertEqual(seen["kind"], "message.thread_reply")
        self.assertIn("@Ada Lovelace deploy staging https://example.com", seen["plain_text"])
        self.assertIn(
            "System Note: Message spaces/AAA/messages/BBB from Ada Lovelace",
            seen["plain_text"],
        )
        self.assertEqual(seen["raw_type"], "MESSAGE")

    def test_dispatches_card_dialog_and_unknown_handlers(self) -> None:
        chat = GoogleChatAI()
        calls: list[str] = []
        card_raw = read_json("fixtures/events/card-clicked/basic.json")
        dialog_raw = read_json("fixtures/events/dialog-submitted/basic.json")

        @chat.on_card_clicked
        def handle_card(ctx):
            calls.append(ctx.event["kind"])
            return json_response(text="card")

        @chat.on_dialog_submitted
        def handle_dialog(ctx):
            calls.append(ctx.event["kind"])
            return {"text": "dialog"}

        @chat.on_unknown_event
        def handle_unknown(ctx):
            calls.append(ctx.event["kind"])
            return "unknown"

        card_response = chat.dispatch(card_raw, source="fixture")
        dialog_response = chat.dispatch(dialog_raw, source="fixture")
        unknown_response = chat.dispatch({"type": "ADDED_TO_SPACE", "eventTime": "2026-06-29T18:02:00Z"})

        self.assertEqual(card_response, {"text": "card"})
        self.assertEqual(dialog_response, {"text": "dialog"})
        self.assertEqual(unknown_response, {"text": "unknown"})
        self.assertEqual(calls, ["card.clicked", "dialog.submitted", "space.added"])

    def test_context_extension_points_delegate_to_loader(self) -> None:
        loader = FakeContextLoader()
        chat = GoogleChatAI(context_loader=loader)
        raw = read_json("fixtures/events/message-created/basic.json")
        snapshot: dict[str, Any] = {}

        @chat.on_message
        async def handle_message(ctx):
            snapshot["current"] = ctx.current_message
            snapshot["ai"] = await ctx.ai_context(thread_limit=5, room_limit=2)
            return None

        response = asyncio.run(chat.dispatch_async(raw, source="fixture"))

        self.assertEqual(response, {})
        self.assertEqual(snapshot["current"]["ref"]["name"], "spaces/AAA/messages/BBB")
        self.assertEqual(snapshot["ai"]["attachments"][0]["contentName"], "report.pdf")
        self.assertEqual(
            loader.calls,
            [
                "current_message",
                "current_message",
                "quoted_message_tree",
                "thread_history:5",
                "room_history:2",
                "attachments",
                "sender_identities",
                "timestamps",
                "relationship_system_notes",
            ],
        )

    def test_reply_routing_flows_through_reply_helpers_and_ai_context(self) -> None:
        chat = GoogleChatAI(reply_routing={"roomThreadReply": "topLevel"})
        raw = read_json("fixtures/events/message-created/basic.json")
        snapshot: dict[str, Any] = {}

        @chat.on_message
        async def handle_message(ctx):
            snapshot["reply_target"] = ctx.reply.target()
            snapshot["context_reply_target"] = ctx.reply_target()
            ai_context = await ctx.ai_context(thread_limit=1, room_limit=1)
            snapshot["ai_reply_target"] = ai_context["replyTarget"]
            snapshot["notes"] = ai_context["relationshipSystemNotes"]
            placeholder = ctx.reply.placeholder("Working on it.")
            snapshot["placeholder_target"] = placeholder.reply_target
            return placeholder

        response = asyncio.run(chat.dispatch_async(raw, source="fixture"))

        self.assertEqual(response, {"text": "Working on it."})
        self.assertEqual(snapshot["reply_target"]["route"], "topLevel")
        self.assertEqual(snapshot["reply_target"]["reason"], "room_thread_reply_top_level")
        self.assertEqual(snapshot["context_reply_target"], snapshot["reply_target"])
        self.assertEqual(snapshot["ai_reply_target"], snapshot["reply_target"])
        self.assertEqual(snapshot["placeholder_target"], snapshot["reply_target"])
        self.assertIn(
            "System Note: Reply routing selected a top-level message target.",
            snapshot["notes"],
        )

    def test_asgi_adapter_accepts_fixture_post(self) -> None:
        chat = GoogleChatAI()
        raw = read_json("fixtures/events/message-created/basic.json")

        @chat.on_message
        async def handle_message(ctx):
            return ctx.reply.text(f"ack {ctx.event['kind']}")

        adapter = ASGIAdapter(chat, path="/chat/events")
        sent: list[dict[str, Any]] = []
        body = json.dumps(raw).encode("utf-8")
        receive_calls = 0

        async def receive() -> dict[str, Any]:
            nonlocal receive_calls
            receive_calls += 1
            if receive_calls == 1:
                return {"type": "http.request", "body": body, "more_body": False}
            return {"type": "http.disconnect"}

        async def send(message: dict[str, Any]) -> None:
            sent.append(message)

        scope = {
            "type": "http",
            "method": "POST",
            "path": "/chat/events",
            "headers": [(b"content-type", b"application/json")],
        }

        asyncio.run(adapter(scope, receive, send))

        self.assertEqual(sent[0]["status"], 200)
        self.assertEqual(
            json.loads(sent[1]["body"].decode("utf-8")),
            {"text": "ack message.thread_reply"},
        )

    def test_fastapi_adapter_mounts_lazily(self) -> None:
        from googlechatai.adapters.fastapi import FastAPIAdapter

        chat = GoogleChatAI()
        adapter = FastAPIAdapter(chat, path="/chat/events")

        self.assertEqual(adapter.path, "/chat/events")

    def test_fastapi_adapter_registers_concrete_request_annotation(self) -> None:
        from googlechatai.adapters.fastapi import FastAPIAdapter

        class FakeRequest:
            pass

        class FakeJSONResponse:
            pass

        class FakeApp:
            def __init__(self) -> None:
                self.handler = None

            def post(self, path: str):
                self.path = path

                def register(handler):
                    self.handler = handler
                    return handler

                return register

        fastapi_module = types.ModuleType("fastapi")
        fastapi_module.Request = FakeRequest
        responses_module = types.ModuleType("fastapi.responses")
        responses_module.JSONResponse = FakeJSONResponse
        previous_fastapi = sys.modules.get("fastapi")
        previous_responses = sys.modules.get("fastapi.responses")

        try:
            sys.modules["fastapi"] = fastapi_module
            sys.modules["fastapi.responses"] = responses_module

            chat = GoogleChatAI()
            app = FakeApp()
            FastAPIAdapter(chat, path="/chat/events").mount(app)

            self.assertEqual(app.path, "/chat/events")
            self.assertIsNotNone(app.handler)
            self.assertIs(app.handler.__annotations__["request"], FakeRequest)
            self.assertIs(app.handler.__annotations__["return"], FakeJSONResponse)
        finally:
            if previous_fastapi is None:
                sys.modules.pop("fastapi", None)
            else:
                sys.modules["fastapi"] = previous_fastapi
            if previous_responses is None:
                sys.modules.pop("fastapi.responses", None)
            else:
                sys.modules["fastapi.responses"] = previous_responses

    def test_handler_errors_log_and_ack_without_live_reply(self) -> None:
        raw = read_json("fixtures/events/message-created/basic.json")
        logger = logging.getLogger("googlechatai.tests.router_error")
        chat = GoogleChatAI(logger=logger)

        @chat.on_message
        def handle_message(ctx):
            raise RuntimeError(f"boom {ctx.event['kind']}")

        with self.assertLogs(logger, level="ERROR") as logs:
            response = chat.dispatch(raw, source="fixture")

        self.assertEqual(response, {})
        self.assertTrue(any("googlechatai.router.handler_error" in item for item in logs.output))

    def test_app_user_mention_routes_to_on_mention_not_on_message(self) -> None:
        raw = read_json("fixtures/events/message-created/basic.json")
        raw["message"]["text"] = "<users/app> summarize this thread"
        raw["message"]["formattedText"] = "<users/app> summarize this thread"
        raw["message"]["argumentText"] = "summarize this thread"
        raw["message"]["annotations"] = [
            {
                "type": "USER_MENTION",
                "startIndex": 0,
                "length": 11,
                "userMention": {
                    "user": {
                        "name": "users/app",
                        "displayName": "Runtime Bot",
                        "type": "BOT",
                    },
                    "type": "MENTION",
                },
            }
        ]

        chat = GoogleChatAI(app_user={"name": "users/app"})
        message_calls: list[str] = []

        @chat.on_message
        def handle_message(ctx):
            message_calls.append(ctx.event["kind"])
            return None

        @chat.on_mention
        def handle_mention(ctx):
            self.assertEqual(ctx.event["kind"], "message.mentioned_app")
            return json_response(text=f"Mention handled: {ctx.event['message']['argumentText']}")

        response = chat.dispatch(raw, source="fixture")

        self.assertEqual(message_calls, [])
        self.assertEqual(response, {"text": "Mention handled: summarize this thread"})

    def test_mention_falls_back_to_on_message_when_no_mention_handler_registered(self) -> None:
        raw = read_json("fixtures/events/message-created/basic.json")
        raw["message"]["text"] = "<users/app> summarize this thread"
        raw["message"]["formattedText"] = "<users/app> summarize this thread"
        raw["message"]["argumentText"] = "summarize this thread"
        raw["message"]["annotations"] = [
            {
                "type": "USER_MENTION",
                "startIndex": 0,
                "length": 11,
                "userMention": {
                    "user": {"name": "users/app", "displayName": "Runtime Bot", "type": "BOT"},
                    "type": "MENTION",
                },
            }
        ]

        chat = GoogleChatAI(app_user={"name": "users/app"})

        @chat.on_message
        def handle_message(ctx):
            self.assertEqual(ctx.event["kind"], "message.mentioned_app")
            return "message fallback"

        response = chat.dispatch(raw, source="fixture")

        self.assertEqual(response, {"text": "message fallback"})

    def test_routes_slash_commands_by_name_using_the_slash_command_fixture_shape(self) -> None:
        raw = read_json("fixtures/events/message-created/slash-command.json")
        chat = GoogleChatAI()
        seen: list[str] = []

        @chat.on_slash_command("/deploy")
        def handle_deploy(ctx):
            seen.append("deploy")
            self.assertEqual(ctx.event["kind"], "message.slash_command")
            return f"deployed: {ctx.event['message']['argumentText']}"

        @chat.on_slash_command("other")
        def handle_other(ctx):
            seen.append("other")
            return None

        response = chat.dispatch(raw, source="fixture")

        self.assertEqual(seen, ["deploy"])
        self.assertEqual(response, {"text": "deployed: staging"})

    def test_slash_command_name_matches_case_insensitively_without_leading_slash(self) -> None:
        raw = read_json("fixtures/events/message-created/slash-command.json")
        chat = GoogleChatAI()

        @chat.on_slash_command("DEPLOY")
        def handle_deploy(ctx):
            return "matched"

        response = chat.dispatch(raw, source="fixture")

        self.assertEqual(response, {"text": "matched"})

    def test_bare_on_slash_command_handles_unmatched_commands(self) -> None:
        raw = read_json("fixtures/events/message-created/slash-command.json")
        chat = GoogleChatAI()
        named_calls: list[str] = []

        @chat.on_slash_command("not-deploy")
        def handle_named(ctx):
            named_calls.append("not-deploy")
            return None

        @chat.on_slash_command
        def handle_bare(ctx):
            return "bare fallback"

        response = chat.dispatch(raw, source="fixture")

        self.assertEqual(named_calls, [])
        self.assertEqual(response, {"text": "bare fallback"})

    def test_slash_command_falls_back_to_on_message_when_nothing_matches(self) -> None:
        raw = read_json("fixtures/events/message-created/slash-command.json")
        chat = GoogleChatAI()
        calls: list[str] = []

        @chat.on_message
        def handle_message(ctx):
            calls.append("on_message")
            return "message fallback"

        @chat.on_unknown_event
        def handle_unknown(ctx):
            calls.append("on_unknown_event")
            return "unknown fallback"

        response = chat.dispatch(raw, source="fixture")

        self.assertEqual(calls, ["on_message"])
        self.assertEqual(response, {"text": "message fallback"})

    def test_generic_on_routes_reaction_membership_and_space_events(self) -> None:
        chat = GoogleChatAI()
        seen: list[str] = []

        @chat.on("reaction.created")
        def handle_reaction(ctx):
            seen.append(ctx.event["kind"])
            return json_response(text="reaction seen")

        @chat.on("membership.created")
        def handle_membership(ctx):
            seen.append(ctx.event["kind"])
            return json_response(text="membership seen")

        @chat.on("space.added")
        def handle_space(ctx):
            seen.append(ctx.event["kind"])
            return json_response(text="space seen")

        reaction_response = chat.dispatch(read_json("fixtures/events/workspace/reaction-created.json"))
        membership_response = chat.dispatch(
            read_json("fixtures/events/workspace/membership-created.json")
        )
        space_response = chat.dispatch(read_json("fixtures/events/space/added-to-space.json"))

        self.assertEqual(reaction_response, {"text": "reaction seen"})
        self.assertEqual(membership_response, {"text": "membership seen"})
        self.assertEqual(space_response, {"text": "space seen"})
        self.assertEqual(seen, ["reaction.created", "membership.created", "space.added"])

    def test_every_new_dedicated_registration_dispatches_to_its_matching_kind(self) -> None:
        chat = GoogleChatAI()
        seen: list[str] = []

        @chat.on_added_to_space
        def handle_added(ctx):
            seen.append(ctx.event["kind"])
            return "added"

        @chat.on_removed_from_space
        def handle_removed(ctx):
            seen.append(ctx.event["kind"])
            return "removed"

        @chat.on_reaction_deleted
        def handle_reaction_deleted(ctx):
            seen.append(ctx.event["kind"])
            return "reaction deleted"

        @chat.on_membership_updated
        def handle_membership_updated(ctx):
            seen.append(ctx.event["kind"])
            return "membership updated"

        @chat.on_membership_deleted
        def handle_membership_deleted(ctx):
            seen.append(ctx.event["kind"])
            return "membership deleted"

        @chat.on_message_updated
        def handle_message_updated(ctx):
            seen.append(ctx.event["kind"])
            return "message updated"

        @chat.on_message_deleted
        def handle_message_deleted(ctx):
            seen.append(ctx.event["kind"])
            return "message deleted"

        @chat.on_dialog_cancelled
        def handle_dialog_cancelled(ctx):
            seen.append(ctx.event["kind"])
            return "dialog cancelled"

        @chat.on_widget_updated
        def handle_widget_updated(ctx):
            seen.append(ctx.event["kind"])
            return "widget updated"

        responses = [
            chat.dispatch(read_json("fixtures/events/space/added-to-space.json")),
            chat.dispatch(read_json("fixtures/events/space/removed-from-space.json")),
            chat.dispatch(read_json("fixtures/events/workspace/reaction-deleted.json")),
            chat.dispatch(read_json("fixtures/events/workspace/membership-updated.json")),
            chat.dispatch(read_json("fixtures/events/workspace/membership-deleted.json")),
            chat.dispatch(read_json("fixtures/events/workspace/message-updated.json")),
            chat.dispatch(read_json("fixtures/events/workspace/message-deleted.json")),
            chat.dispatch(read_json("fixtures/events/card/dialog-cancelled.json")),
            chat.dispatch(read_json("fixtures/events/card/widget-update.json")),
        ]

        self.assertEqual(
            responses,
            [
                {"text": "added"},
                {"text": "removed"},
                {"text": "reaction deleted"},
                {"text": "membership updated"},
                {"text": "membership deleted"},
                {"text": "message updated"},
                {"text": "message deleted"},
                {"text": "dialog cancelled"},
                {"text": "widget updated"},
            ],
        )
        self.assertEqual(
            seen,
            [
                "space.added",
                "space.removed",
                "reaction.deleted",
                "membership.updated",
                "membership.deleted",
                "message.updated",
                "message.deleted",
                "dialog.cancelled",
                "widget.updated",
            ],
        )

    def test_message_updated_falls_back_to_on_message_without_a_dedicated_handler(self) -> None:
        chat = GoogleChatAI()

        @chat.on_message
        def handle_message(ctx):
            self.assertEqual(ctx.event["kind"], "message.updated")
            return "message fallback"

        response = chat.dispatch(read_json("fixtures/events/workspace/message-updated.json"))

        self.assertEqual(response, {"text": "message fallback"})

    def test_on_with_unknown_kind_raises(self) -> None:
        chat = GoogleChatAI()

        with self.assertRaises(ValueError):
            chat.on("not.a.real.kind", lambda ctx: None)

    def test_dedupe_short_circuits_duplicate_deliveries(self) -> None:
        raw = read_json("fixtures/events/message-created/basic.json")
        store = InMemoryIdempotencyStore()
        logger = logging.getLogger("googlechatai.tests.router_dedupe")
        chat = GoogleChatAI(logger=logger, dedupe={"store": store})
        handler_calls: list[str] = []

        @chat.on_message
        def handle_message(ctx):
            handler_calls.append("handled")
            return "handled once"

        with self.assertLogs(logger, level="INFO") as logs:
            first = chat.dispatch(copy.deepcopy(raw), source="fixture")
            second = chat.dispatch(copy.deepcopy(raw), source="fixture")

        self.assertEqual(first, {"text": "handled once"})
        self.assertEqual(second, {"status": "duplicate_event_ignored"})
        self.assertEqual(handler_calls, ["handled"])
        self.assertTrue(any("chat.event.duplicate" in item for item in logs.output))

    def test_dedupe_accepts_a_bare_store_and_wraps_it(self) -> None:
        raw = read_json("fixtures/events/message-created/basic.json")
        store = InMemoryIdempotencyStore()
        chat = GoogleChatAI(dedupe=store)
        handler_calls: list[str] = []

        @chat.on_message
        def handle_message(ctx):
            handler_calls.append("handled")
            return "handled once"

        first = chat.dispatch(copy.deepcopy(raw), source="fixture")
        second = chat.dispatch(copy.deepcopy(raw), source="fixture")

        self.assertEqual(first, {"text": "handled once"})
        self.assertEqual(second, {"status": "duplicate_event_ignored"})
        self.assertEqual(handler_calls, ["handled"])

    def test_dedupe_accepts_a_structural_store_not_owned_by_the_sdk(self) -> None:
        raw = read_json("fixtures/events/message-created/basic.json")

        class ApplicationStore:
            def __init__(self) -> None:
                self.delegate = InMemoryIdempotencyStore()

            def claim(self, key, *, ttl_ms=None, now_ms=None, metadata=None):
                return self.delegate.claim(
                    key,
                    ttl_ms=ttl_ms,
                    now_ms=now_ms,
                    metadata=metadata,
                )

        chat = GoogleChatAI(dedupe={"store": ApplicationStore()})
        calls: list[str] = []

        @chat.on_message
        def handle_message(ctx):
            calls.append("handled")
            return "handled once"

        self.assertEqual(chat.dispatch(copy.deepcopy(raw), source="fixture"), {"text": "handled once"})
        self.assertEqual(
            chat.dispatch(copy.deepcopy(raw), source="fixture"),
            {"status": "duplicate_event_ignored"},
        )
        self.assertEqual(calls, ["handled"])

    def test_sync_dispatch_preserves_thread_affine_structural_store_execution(self) -> None:
        raw = read_json("fixtures/events/message-created/basic.json")

        class ThreadAffineStore:
            def __init__(self) -> None:
                self.owner_thread = threading.get_ident()
                self.delegate = InMemoryIdempotencyStore()

            def claim(self, key, *, ttl_ms=None, now_ms=None, metadata=None):
                if threading.get_ident() != self.owner_thread:
                    raise RuntimeError("thread-affinity broken")
                return self.delegate.claim(
                    key,
                    ttl_ms=ttl_ms,
                    now_ms=now_ms,
                    metadata=metadata,
                )

        chat = GoogleChatAI(dedupe={"store": ThreadAffineStore()})
        chat.on_message(lambda ctx: "handled")

        self.assertEqual(chat.dispatch(copy.deepcopy(raw), source="fixture"), {"text": "handled"})
        self.assertEqual(
            chat.dispatch(copy.deepcopy(raw), source="fixture"),
            {"status": "duplicate_event_ignored"},
        )

    def test_deadline_exceeded_returns_fallback_and_logs_late_completion(self) -> None:
        raw = read_json("fixtures/events/message-created/basic.json")
        logger = logging.getLogger("googlechatai.tests.router_deadline")
        capture = _CapturingHandler()
        logger.addHandler(capture)
        logger.setLevel(logging.INFO)
        self.addCleanup(logger.removeHandler, capture)
        chat = GoogleChatAI(logger=logger, deadline={"budget_ms": 20})

        @chat.on_message
        async def handle_message(ctx):
            await asyncio.sleep(0.06)
            return "slow result"

        response = chat.dispatch(raw, source="fixture")

        self.assertEqual(response, {"text": "Still working on it..."})
        self.assertTrue(capture.wait_for("chat.event.deadline_exceeded", timeout=0.5))
        self.assertTrue(capture.wait_for("chat.event.late_result"))

    def test_deadline_invokes_custom_on_deadline_handler(self) -> None:
        raw = read_json("fixtures/events/message-created/basic.json")

        async def handle_deadline(ctx):
            return "custom deadline reply"

        chat = GoogleChatAI(
            deadline={"budget_ms": 20, "on_deadline": handle_deadline},
        )

        @chat.on_message
        async def handle_message(ctx):
            await asyncio.sleep(0.06)
            return "slow result"

        response = chat.dispatch(raw, source="fixture")

        self.assertEqual(response, {"text": "custom deadline reply"})

    def test_deadline_logs_late_failure_when_handler_eventually_raises(self) -> None:
        # Use raise_handler_errors=True so the exception actually propagates
        # out of dispatch (the default swallows handler errors into a
        # logged, non-exceptional {} response, which would otherwise always
        # look like a late *success* to the deadline race).
        raw = read_json("fixtures/events/message-created/basic.json")
        logger = logging.getLogger("googlechatai.tests.router_deadline_failure")
        capture = _CapturingHandler()
        logger.addHandler(capture)
        logger.setLevel(logging.INFO)
        self.addCleanup(logger.removeHandler, capture)
        chat = GoogleChatAI(
            logger=logger,
            raise_handler_errors=True,
            deadline={"budget_ms": 20},
        )

        @chat.on_message
        async def handle_message(ctx):
            await asyncio.sleep(0.06)
            raise RuntimeError("late boom")

        response = chat.dispatch(raw, source="fixture")

        self.assertEqual(response, {"text": "Still working on it..."})
        self.assertTrue(capture.wait_for("chat.event.late_failure"))

    def test_deadline_returns_handler_result_within_budget(self) -> None:
        raw = read_json("fixtures/events/message-created/basic.json")
        chat = GoogleChatAI(deadline={"budget_ms": 200})

        @chat.on_message
        async def handle_message(ctx):
            await asyncio.sleep(0.005)
            return "fast result"

        response = chat.dispatch(raw, source="fixture")

        self.assertEqual(response, {"text": "fast result"})

    def test_sync_deadline_dispatch_reuses_one_supervisor_thread(self) -> None:
        raw = read_json("fixtures/events/message-created/basic.json")
        before = [
            thread
            for thread in threading.enumerate()
            if thread.name == "googlechatai-deadline-supervisor"
        ]

        for _ in range(3):
            chat = GoogleChatAI(deadline={"budget_ms": 10})

            @chat.on_message
            async def handle_message(ctx):
                _ = ctx
                await asyncio.sleep(0.03)
                return "late result"

            self.assertEqual(
                chat.dispatch(raw, source="fixture"),
                {"text": "Still working on it..."},
            )

        after = [
            thread
            for thread in threading.enumerate()
            if thread.name == "googlechatai-deadline-supervisor"
        ]
        self.assertLessEqual(len(after), max(1, len(before)))


class AsyncRouterDeadlineTests(unittest.IsolatedAsyncioTestCase):
    async def test_deadline_yields_to_unrelated_event_loop_work(self) -> None:
        raw = read_json("fixtures/events/message-created/basic.json")
        probe_ran = asyncio.Event()
        handler_finished = asyncio.Event()
        chat = GoogleChatAI(deadline={"budget_ms": 30})

        @chat.on_message
        async def handle_message(ctx):
            await asyncio.sleep(0.08)
            handler_finished.set()
            return "slow result"

        async def probe() -> None:
            await asyncio.sleep(0.005)
            probe_ran.set()

        probe_task = asyncio.create_task(probe())
        response = await chat.dispatch_async(raw, source="fixture")

        self.assertEqual(response, {"text": "Still working on it..."})
        self.assertTrue(probe_ran.is_set())
        await probe_task
        await asyncio.wait_for(handler_finished.wait(), timeout=0.5)

    async def test_deadline_offloads_blocking_sync_handlers_from_the_event_loop(self) -> None:
        raw = read_json("fixtures/events/message-created/basic.json")
        handler_started = threading.Event()
        release_handler = threading.Event()
        handler_finished = asyncio.Event()
        chat = GoogleChatAI(deadline={"budget_ms": 20})
        loop = asyncio.get_running_loop()

        @chat.on_message
        def handle_message(ctx):
            _ = ctx
            handler_started.set()
            release_handler.wait(timeout=0.5)
            loop.call_soon_threadsafe(handler_finished.set)
            return "late result"

        probe_ran = asyncio.Event()

        async def probe() -> None:
            while not handler_started.is_set():
                await asyncio.sleep(0)
            probe_ran.set()

        probe_task = asyncio.create_task(probe())
        try:
            response = await chat.dispatch_async(raw, source="fixture")

            self.assertEqual(response, {"text": "Still working on it..."})
            await asyncio.wait_for(probe_task, timeout=0.5)
            self.assertTrue(probe_ran.is_set())
        finally:
            release_handler.set()
            if not probe_task.done():
                probe_task.cancel()
            await asyncio.gather(probe_task, return_exceptions=True)
            if handler_started.is_set():
                await asyncio.wait_for(handler_finished.wait(), timeout=0.5)

    async def test_sync_dedupe_store_is_offloaded_and_deadline_accounted(self) -> None:
        raw = read_json("fixtures/events/message-created/basic.json")
        loop = asyncio.get_running_loop()
        store_started = threading.Event()
        release_store = threading.Event()
        store_finished = asyncio.Event()

        class SlowStore:
            def __init__(self) -> None:
                self.delegate = InMemoryIdempotencyStore()

            def claim(self, key, *, ttl_ms=None, now_ms=None, metadata=None):
                store_started.set()
                release_store.wait(timeout=0.5)
                try:
                    return self.delegate.claim(
                        key,
                        ttl_ms=ttl_ms,
                        now_ms=now_ms,
                        metadata=metadata,
                    )
                finally:
                    loop.call_soon_threadsafe(store_finished.set)

        chat = GoogleChatAI(
            dedupe={"store": SlowStore(), "offload_sync": True},
            deadline={"budget_ms": 20},
        )
        chat.on_message(lambda ctx: "handled")
        probe_ran = asyncio.Event()

        async def probe() -> None:
            while not store_started.is_set():
                await asyncio.sleep(0)
            probe_ran.set()

        probe_task = asyncio.create_task(probe())
        try:
            response = await chat.dispatch_async(raw, source="fixture")

            self.assertEqual(response, {"text": "Still working on it..."})
            await asyncio.wait_for(probe_task, timeout=0.5)
            self.assertTrue(probe_ran.is_set())
        finally:
            release_store.set()
            if not probe_task.done():
                probe_task.cancel()
            await asyncio.gather(probe_task, return_exceptions=True)
            if store_started.is_set():
                await asyncio.wait_for(store_finished.wait(), timeout=0.5)

    async def test_async_dispatch_preserves_thread_affine_store_by_default(self) -> None:
        raw = read_json("fixtures/events/message-created/basic.json")

        class ThreadAffineStore:
            def __init__(self) -> None:
                self.owner_thread = threading.get_ident()
                self.delegate = InMemoryIdempotencyStore()

            def claim(self, key, *, ttl_ms=None, now_ms=None, metadata=None):
                if threading.get_ident() != self.owner_thread:
                    raise RuntimeError("thread-affinity broken")
                return self.delegate.claim(
                    key,
                    ttl_ms=ttl_ms,
                    now_ms=now_ms,
                    metadata=metadata,
                )

        chat = GoogleChatAI(dedupe={"store": ThreadAffineStore()})
        chat.on_message(lambda ctx: "handled")

        self.assertEqual(
            await chat.dispatch_async(copy.deepcopy(raw), source="fixture"),
            {"text": "handled"},
        )
        self.assertEqual(
            await chat.dispatch_async(copy.deepcopy(raw), source="fixture"),
            {"status": "duplicate_event_ignored"},
        )


if __name__ == "__main__":
    unittest.main()
