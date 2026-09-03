import json
import pathlib
import unittest

from googlechatai.pins import (
    CHAT_PIN_DOCS_LISTED_NOTE,
    CHAT_SPACES_PINS_READONLY_SCOPE,
    CHAT_SPACES_PINS_SCOPE,
    MESSAGE_PINS_DEVELOPER_PREVIEW_NOTE,
    PIN_MESSAGES_SCOPE,
    plan_ensure_message_pinned,
    plan_list_message_pins,
    plan_pin_message,
    plan_unpin_message,
)


ROOT = pathlib.Path(__file__).resolve().parents[3]


def read_json(relative_path: str):
    return json.loads((ROOT / relative_path).read_text(encoding="utf-8"))


PLANNERS = {
    "pins.pin": plan_pin_message,
    "pins.unpin": plan_unpin_message,
    "pins.list": plan_list_message_pins,
    "pins.ensurePinned": plan_ensure_message_pinned,
}


class MessagePinCallPlanTests(unittest.TestCase):
    def test_matches_shared_call_plan_cases(self) -> None:
        for test_case in read_json("conformance/cases/pins.call-plans.json"):
            with self.subTest(test_case["id"]):
                self.assertEqual(
                    PLANNERS[test_case["operation"]](test_case["input"]),
                    test_case["expect"],
                )

    def test_matches_pin_message_fixture(self) -> None:
        fixture = read_json("fixtures/expected/pins/pin-message.json")
        self.assertEqual(
            plan_pin_message(
                {
                    "space": "spaces/AAA",
                    "message": "spaces/AAA/messages/BBB",
                    "authMode": "user",
                }
            ),
            fixture,
        )

    def test_matches_unpin_by_name_fixture(self) -> None:
        fixture = read_json("fixtures/expected/pins/unpin-by-name.json")
        self.assertEqual(
            plan_unpin_message(
                {"messagePin": "spaces/AAA/messagePins/CCC", "authMode": "user"}
            ),
            fixture,
        )

    def test_matches_unpin_by_message_fixture(self) -> None:
        fixture = read_json("fixtures/expected/pins/unpin-by-message.json")
        self.assertEqual(
            plan_unpin_message(
                {
                    "space": "spaces/AAA",
                    "message": "spaces/AAA/messages/BBB",
                    "authMode": "user",
                }
            ),
            fixture,
        )

    def test_matches_list_pins_fixture(self) -> None:
        fixture = read_json("fixtures/expected/pins/list-pins.json")
        self.assertEqual(
            plan_list_message_pins({"space": "spaces/AAA", "authMode": "user"}),
            fixture,
        )

    def test_matches_list_pins_paged_fixture(self) -> None:
        fixture = read_json("fixtures/expected/pins/list-pins-paged.json")
        self.assertEqual(
            plan_list_message_pins(
                {
                    "space": "spaces/AAA",
                    "pageSize": 25,
                    "pageToken": "next-page",
                    "authMode": "user",
                }
            ),
            fixture,
        )

    def test_matches_ensure_pinned_fixture(self) -> None:
        fixture = read_json("fixtures/expected/pins/ensure-pinned.json")
        self.assertEqual(
            plan_ensure_message_pinned(
                {
                    "space": "spaces/AAA",
                    "message": "spaces/AAA/messages/BBB",
                    "authMode": "user",
                }
            ),
            fixture,
        )

    def test_exports_least_privilege_scopes_and_compatibility_aliases(self) -> None:
        self.assertEqual(
            CHAT_SPACES_PINS_SCOPE,
            "https://www.googleapis.com/auth/chat.spaces.pins",
        )
        self.assertEqual(
            CHAT_SPACES_PINS_READONLY_SCOPE,
            "https://www.googleapis.com/auth/chat.spaces.pins.readonly",
        )
        self.assertEqual(PIN_MESSAGES_SCOPE, CHAT_SPACES_PINS_SCOPE)
        self.assertEqual(
            CHAT_PIN_DOCS_LISTED_NOTE, MESSAGE_PINS_DEVELOPER_PREVIEW_NOTE
        )

    def test_carries_developer_preview_warning_on_every_plan(self) -> None:
        plans = [
            plan_pin_message(
                {"space": "spaces/AAA", "message": "spaces/AAA/messages/BBB"}
            ),
            plan_unpin_message({"messagePin": "spaces/AAA/messagePins/CCC"}),
            plan_unpin_message(
                {"space": "spaces/AAA", "message": "spaces/AAA/messages/BBB"}
            ),
            plan_list_message_pins({"space": "spaces/AAA"}),
            plan_ensure_message_pinned(
                {"space": "spaces/AAA", "message": "spaces/AAA/messages/BBB"}
            ),
        ]

        for plan in plans:
            self.assertIn(MESSAGE_PINS_DEVELOPER_PREVIEW_NOTE, plan["warnings"])

    def test_derives_direct_message_pin_delete_path(self) -> None:
        plan = plan_unpin_message(
            {"space": "spaces/AAA", "message": "spaces/AAA/messages/BBB"}
        )
        self.assertEqual(
            plan["requests"],
            [
                {
                    "resource": "spaces.messagePins.delete",
                    "method": "DELETE",
                    "path": "/v1/spaces/AAA/messagePins/BBB",
                    "query": {},
                    "body": None,
                }
            ],
        )
        self.assertEqual(
            plan["pin"],
            {
                "action": "unpin",
                "strategy": "derived-from-message",
                "space": "spaces/AAA",
                "message": "spaces/AAA/messages/BBB",
                "name": "spaces/AAA/messagePins/BBB",
            },
        )

    def test_blocks_app_auth_without_changing_the_principal(self) -> None:
        plan = plan_pin_message(
            {
                "space": "spaces/AAA",
                "message": "spaces/AAA/messages/BBB",
                "authMode": "app",
            }
        )
        self.assertEqual(
            plan["capability"],
            {
                "ok": False,
                "authMode": "app",
                "requiredScopes": [CHAT_SPACES_PINS_SCOPE],
                "reasons": [
                    "Google Chat message pins require user authentication; app authentication is not supported."
                ],
            },
        )

    def test_requires_well_formed_same_space_resource_names(self) -> None:
        with self.assertRaisesRegex(
            TypeError, "Expected message to belong to the supplied space."
        ):
            plan_pin_message(
                {"space": "spaces/AAA", "message": "spaces/BBB/messages/CCC"}
            )
        with self.assertRaisesRegex(TypeError, "Expected message to use the resource name"):
            plan_pin_message({"space": "spaces/AAA", "message": "not-a-message"})
        with self.assertRaisesRegex(TypeError, "Expected messagePin to use the resource name"):
            plan_unpin_message({"messagePin": "spaces/AAA/messages/BBB"})

    def test_requires_basic_planner_inputs(self) -> None:
        with self.assertRaisesRegex(TypeError, "Expected space to be a non-empty string."):
            plan_pin_message({"message": "spaces/AAA/messages/BBB"})
        with self.assertRaisesRegex(TypeError, "Expected message to be a non-empty string."):
            plan_pin_message({"space": "spaces/AAA"})
        with self.assertRaisesRegex(TypeError, "Expected space to be a non-empty string."):
            plan_list_message_pins({})
        with self.assertRaisesRegex(TypeError, "Expected space to be a non-empty string."):
            plan_ensure_message_pinned({"message": "spaces/AAA/messages/BBB"})
        with self.assertRaisesRegex(TypeError, "Expected message to be a non-empty string."):
            plan_ensure_message_pinned({"space": "spaces/AAA"})
        with self.assertRaisesRegex(
            TypeError,
            "Expected messagePin, or both space and message, to be non-empty strings.",
        ):
            plan_unpin_message({})

    def test_clamps_list_page_size_to_documented_range(self) -> None:
        self.assertEqual(
            plan_list_message_pins({"space": "spaces/AAA", "pageSize": 0})[
                "requests"
            ][0]["query"]["pageSize"],
            1,
        )
        self.assertEqual(
            plan_list_message_pins({"space": "spaces/AAA", "pageSize": 5000})[
                "requests"
            ][0]["query"]["pageSize"],
            100,
        )
        self.assertEqual(
            plan_list_message_pins({"space": "spaces/AAA", "pageSize": 12.9})[
                "requests"
            ][0]["query"]["pageSize"],
            12,
        )
        self.assertEqual(
            plan_list_message_pins({"space": "spaces/AAA", "pageSize": float("nan")})[
                "requests"
            ][0]["query"]["pageSize"],
            100,
        )

    def test_requires_a_complete_first_page_for_ensure_pinned(self) -> None:
        with self.assertRaisesRegex(TypeError, "requires pageSize 100"):
            plan_ensure_message_pinned(
                {
                    "space": "spaces/AAA",
                    "message": "spaces/AAA/messages/BBB",
                    "pageSize": 99,
                }
            )
        with self.assertRaisesRegex(TypeError, "does not accept pageToken"):
            plan_ensure_message_pinned(
                {
                    "space": "spaces/AAA",
                    "message": "spaces/AAA/messages/BBB",
                    "pageToken": "next-page",
                }
            )

    def test_defaults_to_installed_user_authentication(self) -> None:
        plan = plan_pin_message(
            {"space": "spaces/AAA", "message": "spaces/AAA/messages/BBB"}
        )
        self.assertEqual(plan["capability"]["authMode"], "user")
        self.assertTrue(plan["capability"]["ok"])


if __name__ == "__main__":
    unittest.main()
