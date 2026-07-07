import json
import pathlib
import unittest

from googlechatai import normalize_event


ROOT = pathlib.Path(__file__).resolve().parents[3]


def read_json(relative_path: str):
    return json.loads((ROOT / relative_path).read_text(encoding="utf-8"))


def assert_contains(test_case: unittest.TestCase, actual, expected) -> None:
    if isinstance(expected, dict):
        test_case.assertIsInstance(actual, dict)
        for key, value in expected.items():
            test_case.assertIn(key, actual)
            assert_contains(test_case, actual[key], value)
        return

    if isinstance(expected, list):
        test_case.assertEqual(actual, expected)
        return

    test_case.assertEqual(actual, expected)


class NormalizeEventTests(unittest.TestCase):
    def test_matches_shared_event_conformance_fixtures(self) -> None:
        cases = read_json("conformance/cases/events.parse.json")

        for test_case in cases:
            with self.subTest(test_case["id"]):
                raw = read_json(test_case["input"]["fixture"])
                expected = read_json(test_case["expect"]["fixture"])
                source = test_case["input"].get("source")
                actual = normalize_event(raw, source=source) if source else normalize_event(raw)

                self.assertEqual(actual, expected)

    def test_normalizes_message_edge_cases_without_losing_raw_payloads(self) -> None:
        missing_text = read_json("fixtures/events/message-created/missing-text.json")
        missing_text_event = normalize_event(missing_text, source="fixture")

        self.assertEqual(missing_text_event["raw"], missing_text)
        assert_contains(
            self,
            missing_text_event,
            {
                "source": "fixture",
                "kind": "message.created",
                "rawKind": "MESSAGE",
                "actorState": {"status": "available", "reason": None},
                "message": {
                    "text": "",
                    "sender": {"resourceName": "users/789", "accessState": "available"},
                    "state": {"threadReply": False},
                },
                "relationship": {
                    "isThreadReply": False,
                    "isDirectReply": False,
                    "isQuote": False,
                },
            },
        )

        missing_user = read_json("fixtures/events/message-created/missing-user.json")
        missing_user_event = normalize_event(missing_user, source="fixture")

        self.assertEqual(missing_user_event["raw"], missing_user)
        assert_contains(
            self,
            missing_user_event,
            {
                "source": "fixture",
                "kind": "message.created",
                "actor": None,
                "actorState": {
                    "status": "missing",
                    "reason": "event_payload_missing_user",
                },
                "message": {
                    "text": "I arrived without user metadata",
                    "sender": None,
                    "state": {"threadReply": False},
                },
            },
        )

        quoted_reply = read_json("fixtures/events/message-created/quoted-reply.json")
        quoted_reply_event = normalize_event(quoted_reply, source="fixture")

        assert_contains(
            self,
            quoted_reply_event,
            {
                "kind": "message.thread_reply",
                "message": {
                    "state": {"threadReply": True},
                },
                "relationship": {
                    "isQuote": True,
                    "isDirectReply": True,
                    "isThreadReply": True,
                },
            },
        )
        quote_child = quoted_reply_event["message"]["contextNode"]["children"][0]
        assert_contains(
            self,
            quote_child,
            {
                "relationship": "quoted_message",
                "ref": {"name": "spaces/AAA/messages/ROOT"},
                "text": "Should we ship this?",
                "sender": {
                    "resourceName": "users/456",
                    "displayName": "Grace Hopper",
                },
            },
        )

    def test_classifies_direct_app_interaction_event_families(self) -> None:
        slash_event = normalize_event(
            read_json("fixtures/events/message-created/slash-command.json"),
            source="fixture",
        )
        assert_contains(
            self,
            slash_event,
            {
                "kind": "message.slash_command",
                "action": {
                    "actionType": "slash_command",
                    "methodName": "/deploy",
                    "parameters": {"commandId": "1", "commandName": "/deploy"},
                },
                "relationship": {"isUserAction": True, "isCardAction": False},
            },
        )

        app_command_event = normalize_event(
            read_json("fixtures/events/message-created/app-command.json"),
            source="fixture",
        )
        assert_contains(
            self,
            app_command_event,
            {
                "kind": "message.app_command",
                "action": {
                    "actionType": "app_command",
                    "methodName": "Summarize thread",
                    "parameters": {
                        "appCommandId": "summarize-thread",
                        "appCommandType": "USER",
                    },
                },
            },
        )

        assert_contains(
            self,
            normalize_event(
                read_json("fixtures/events/space/added-to-space.json"),
                source="fixture",
            ),
            {"kind": "space.added", "relationship": {"isSpaceEvent": True}},
        )
        assert_contains(
            self,
            normalize_event(
                read_json("fixtures/events/space/removed-from-space.json"),
                source="fixture",
            ),
            {"kind": "space.removed", "relationship": {"isSpaceEvent": True}},
        )

        mentioned_app_event = normalize_event(
            read_json("fixtures/events/message-created/mentioned-app.json"),
            source="fixture",
        )
        assert_contains(
            self,
            mentioned_app_event,
            {
                "kind": "message.mentioned_app",
                "message": {
                    "argumentText": "help me summarize",
                },
                "relationship": {"isUserAction": True},
            },
        )
        self.assertIn(
            "@Google Chat AI SDK Dev help me summarize",
            mentioned_app_event["message"]["plainTextForModel"],
        )

    def test_normalizes_card_dialog_and_widget_actions(self) -> None:
        card_event = normalize_event(
            read_json("fixtures/events/card/click.json"), source="fixture"
        )
        assert_contains(
            self,
            card_event,
            {
                "kind": "card.clicked",
                "action": {
                    "actionType": "card_click",
                    "methodName": "approve_incident",
                    "parameters": {"incident": "INC-1", "source": "card"},
                    "formInputs": {},
                },
                "relationship": {"isCardAction": True},
            },
        )

        dialog_event = normalize_event(
            read_json("fixtures/events/card/dialog-submit.json"), source="fixture"
        )
        assert_contains(
            self,
            dialog_event,
            {
                "kind": "dialog.submitted",
                "locale": "en-US",
                "timeZone": "America/New_York",
                "action": {
                    "actionType": "dialog_submit",
                    "methodName": "submit_incident_dialog",
                    "formInputs": {
                        "decision": {
                            "kind": "string",
                            "values": ["approve"],
                            "value": "approve",
                        },
                        "notes": {
                            "kind": "string",
                            "values": ["Ship it"],
                            "value": "Ship it",
                        },
                    },
                },
                "dialog": {"eventType": "SUBMIT_DIALOG"},
            },
        )

        widget_event = normalize_event(
            read_json("fixtures/events/card/widget-update.json"), source="fixture"
        )
        assert_contains(
            self,
            widget_event,
            {
                "kind": "widget.updated",
                "action": {
                    "actionType": "widget_update",
                    "methodName": "assignee_autocomplete",
                    "parameters": {"query": "ada"},
                },
            },
        )

        dialog_opened_event = normalize_event(
            read_json("fixtures/events/card/dialog-opened.json"), source="fixture"
        )
        assert_contains(
            self,
            dialog_opened_event,
            {
                "kind": "dialog.opened",
                "dialog": {"eventType": "REQUEST_DIALOG"},
                "action": {
                    "actionType": "card_click",
                    "methodName": "open_incident_dialog",
                },
            },
        )

        dialog_cancelled_event = normalize_event(
            read_json("fixtures/events/card/dialog-cancelled.json"), source="fixture"
        )
        assert_contains(
            self,
            dialog_cancelled_event,
            {
                "kind": "dialog.cancelled",
                "dialog": {"eventType": "CANCEL_DIALOG"},
                "action": {
                    "actionType": "dialog_cancel",
                    "methodName": "cancel_incident_dialog",
                },
            },
        )

    def test_unwraps_pubsub_events_and_workspace_events_wrappers(self) -> None:
        pubsub_event = normalize_event(read_json("fixtures/events/pubsub/direct-message.json"))
        assert_contains(
            self,
            pubsub_event,
            {
                "eventId": "pubsub:1001",
                "source": "pubsub",
                "kind": "message.direct",
                "transport": {
                    "kind": "pubsub",
                    "pubsubMessageId": "1001",
                    "pubsubPublishTime": "2026-06-29T18:20:01Z",
                    "pubsubDeliveryAttempt": "1",
                },
                "message": {"text": "hello from pubsub"},
            },
        )

        updated_event = normalize_event(
            read_json("fixtures/events/workspace/message-updated.json")
        )
        assert_contains(
            self,
            updated_event,
            {
                "eventId": "workspace_events:workspace-event-1",
                "source": "workspace_events",
                "kind": "message.updated",
                "rawKind": "google.workspace.chat.message.v1.updated",
                "relationship": {"isEdit": True},
                "message": {
                    "updatedAt": "2026-06-29T18:30:00Z",
                    "text": "edited copy",
                },
            },
        )

        pubsub_workspace_event = normalize_event(
            read_json("fixtures/events/pubsub/workspace-message-updated.json")
        )
        assert_contains(
            self,
            pubsub_workspace_event,
            {
                "eventId": "workspace_events:workspace-pubsub-event-1",
                "source": "workspace_events",
                "kind": "message.updated",
                "transport": {
                    "kind": "workspace_events",
                    "pubsubMessageId": "1002",
                    "workspaceEventType": "google.workspace.chat.message.v1.updated",
                },
                "message": {
                    "text": "workspace pubsub edited copy",
                    "updatedAt": "2026-06-29T18:36:00Z",
                },
            },
        )

        deleted_event = normalize_event(
            read_json("fixtures/events/workspace/message-deleted.json")
        )
        assert_contains(
            self,
            deleted_event,
            {
                "source": "workspace_events",
                "kind": "message.deleted",
                "relationship": {"isDeletion": True},
                "message": {
                    "state": {"deleted": True},
                    "deletedAt": "2026-06-29T18:31:00Z",
                    "systemNotes": [
                        "System Note: Message spaces/AAA/messages/DELETED from Unknown sender (unknown access) created at unknown time.",
                        "System Note: Message was deleted at 2026-06-29T18:31:00Z (USER_DELETED).",
                        "System Note: This message is a thread reply in spaces/AAA/threads/thread-1.",
                    ],
                },
            },
        )

    def test_normalizes_reaction_and_membership_workspace_events(self) -> None:
        reaction_event = normalize_event(
            read_json("fixtures/events/workspace/reaction-created.json")
        )
        assert_contains(
            self,
            reaction_event,
            {
                "kind": "reaction.created",
                "actor": {
                    "name": "users/456",
                    "displayName": "Grace Hopper",
                    "email": "grace@example.com",
                },
                "reaction": {
                    "ref": {"name": "spaces/AAA/messages/BBB/reactions/reaction-1"},
                    "emoji": {"unicode": "👍"},
                    "messageRef": {"name": "spaces/AAA/messages/BBB"},
                },
                "relationship": {"isReaction": True},
            },
        )

        reaction_deleted_event = normalize_event(
            read_json("fixtures/events/workspace/reaction-deleted.json")
        )
        assert_contains(
            self,
            reaction_deleted_event,
            {
                "kind": "reaction.deleted",
                "reaction": {
                    "deletedAt": "2026-06-29T18:34:00Z",
                },
                "relationship": {"isReaction": True},
            },
        )

        membership_event = normalize_event(
            read_json("fixtures/events/workspace/membership-deleted.json")
        )
        assert_contains(
            self,
            membership_event,
            {
                "kind": "membership.deleted",
                "membership": {
                    "ref": {"name": "spaces/AAA/members/users/999"},
                    "state": "NOT_A_MEMBER",
                    "member": {
                        "name": "users/999",
                        "access": {"status": "access_limited"},
                    },
                },
                "relationship": {"isMembershipEvent": True},
            },
        )

        membership_created_event = normalize_event(
            read_json("fixtures/events/workspace/membership-created.json")
        )
        assert_contains(
            self,
            membership_created_event,
            {
                "kind": "membership.created",
                "membership": {
                    "state": "JOINED",
                    "member": {
                        "displayName": "Katherine Johnson",
                        "email": "katherine@example.com",
                    },
                },
                "relationship": {"isMembershipEvent": True},
            },
        )

        membership_updated_event = normalize_event(
            read_json("fixtures/events/workspace/membership-updated.json")
        )
        assert_contains(
            self,
            membership_updated_event,
            {
                "kind": "membership.updated",
                "membership": {
                    "state": "JOINED",
                },
                "relationship": {"isMembershipEvent": True},
            },
        )

    def test_returns_event_unknown_for_unknown_event_types(self) -> None:
        event = normalize_event(
            read_json("fixtures/events/unknown/unknown-type.json"), source="fixture"
        )

        assert_contains(
            self,
            event,
            {
                "kind": "event.unknown",
                "rawKind": "MYSTERY_EVENT",
                "message": None,
                "action": None,
            },
        )

    def test_throws_a_typed_error_for_invalid_non_object_payloads(self) -> None:
        with self.assertRaises(TypeError) as context:
            normalize_event("not an object")

        self.assertEqual(type(context.exception).__name__, "InvalidChatEventError")


if __name__ == "__main__":
    unittest.main()
