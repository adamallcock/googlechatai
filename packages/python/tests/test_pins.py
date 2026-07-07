import json
import pathlib
import unittest

from googlechatai.pins import (
    CHAT_PIN_DOCS_LISTED_NOTE,
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
                    "authMode": "app",
                }
            ),
            fixture,
        )

    def test_matches_unpin_by_name_fixture(self) -> None:
        fixture = read_json("fixtures/expected/pins/unpin-by-name.json")
        self.assertEqual(
            plan_unpin_message(
                {"messagePin": "spaces/AAA/messagePins/CCC", "authMode": "app"}
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
                    "authMode": "app",
                }
            ),
            fixture,
        )

    def test_matches_list_pins_fixture(self) -> None:
        fixture = read_json("fixtures/expected/pins/list-pins.json")
        self.assertEqual(
            plan_list_message_pins({"space": "spaces/AAA", "authMode": "app"}),
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
                    "authMode": "app",
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
                    "authMode": "app",
                }
            ),
            fixture,
        )

    def test_exports_the_messages_scope_and_docs_listed_note_constants(self) -> None:
        self.assertEqual(
            PIN_MESSAGES_SCOPE, "https://www.googleapis.com/auth/chat.messages"
        )
        self.assertEqual(
            CHAT_PIN_DOCS_LISTED_NOTE,
            "spaces.messagePins.* is a docs-listed surface; verify live support before relying on it.",
        )

    def test_carries_the_docs_listed_warning_on_every_planned_operation(self) -> None:
        plans = [
            plan_pin_message({"space": "spaces/AAA", "message": "spaces/AAA/messages/BBB"}),
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
            self.assertIn(CHAT_PIN_DOCS_LISTED_NOTE, plan["warnings"])

    def test_uses_the_resolved_message_pin_placeholder_path_for_two_step_plan(
        self,
    ) -> None:
        plan = plan_unpin_message(
            {"space": "spaces/AAA", "message": "spaces/AAA/messages/BBB"}
        )

        self.assertEqual(len(plan["requests"]), 2)
        self.assertEqual(plan["requests"][0]["resource"], "spaces.messagePins.list")
        self.assertEqual(plan["requests"][0]["method"], "GET")
        self.assertEqual(plan["requests"][0]["path"], "/v1/spaces/AAA/messagePins")
        self.assertEqual(plan["requests"][1]["resource"], "spaces.messagePins.delete")
        self.assertEqual(plan["requests"][1]["method"], "DELETE")
        self.assertEqual(plan["requests"][1]["path"], "/v1/{resolvedMessagePin}")

    def test_requires_a_non_empty_space_for_plan_pin_message(self) -> None:
        with self.assertRaisesRegex(
            TypeError, "Expected space to be a non-empty string."
        ):
            plan_pin_message({"message": "spaces/AAA/messages/BBB"})

    def test_requires_a_non_empty_message_for_plan_pin_message(self) -> None:
        with self.assertRaisesRegex(
            TypeError, "Expected message to be a non-empty string."
        ):
            plan_pin_message({"space": "spaces/AAA"})

    def test_requires_a_non_empty_space_for_plan_list_message_pins(self) -> None:
        with self.assertRaisesRegex(
            TypeError, "Expected space to be a non-empty string."
        ):
            plan_list_message_pins({})

    def test_requires_a_non_empty_space_for_plan_ensure_message_pinned(self) -> None:
        with self.assertRaisesRegex(
            TypeError, "Expected space to be a non-empty string."
        ):
            plan_ensure_message_pinned({"message": "spaces/AAA/messages/BBB"})

    def test_requires_a_non_empty_message_for_plan_ensure_message_pinned(self) -> None:
        with self.assertRaisesRegex(
            TypeError, "Expected message to be a non-empty string."
        ):
            plan_ensure_message_pinned({"space": "spaces/AAA"})

    def test_requires_message_pin_or_space_and_message_for_plan_unpin_message(
        self,
    ) -> None:
        expected_message = (
            "Expected messagePin, or both space and message, to be non-empty strings."
        )
        with self.assertRaisesRegex(TypeError, expected_message):
            plan_unpin_message({})
        with self.assertRaisesRegex(TypeError, expected_message):
            plan_unpin_message({"space": "spaces/AAA"})
        with self.assertRaisesRegex(TypeError, expected_message):
            plan_unpin_message({"message": "spaces/AAA/messages/BBB"})

    def test_clamps_page_size_to_the_1_1000_range_and_floors_fractional_values(
        self,
    ) -> None:
        self.assertEqual(
            plan_list_message_pins({"space": "spaces/AAA", "pageSize": 0})["requests"][
                0
            ]["query"]["pageSize"],
            1,
        )
        self.assertEqual(
            plan_list_message_pins({"space": "spaces/AAA", "pageSize": 5000})[
                "requests"
            ][0]["query"]["pageSize"],
            1000,
        )
        self.assertEqual(
            plan_list_message_pins({"space": "spaces/AAA", "pageSize": 12.9})[
                "requests"
            ][0]["query"]["pageSize"],
            12,
        )

    def test_defaults_page_size_to_100_when_not_provided(self) -> None:
        plan = plan_list_message_pins({"space": "spaces/AAA"})
        self.assertEqual(plan["requests"][0]["query"]["pageSize"], 100)

    def test_defaults_auth_mode_to_app(self) -> None:
        plan = plan_pin_message(
            {"space": "spaces/AAA", "message": "spaces/AAA/messages/BBB"}
        )
        self.assertEqual(plan["capability"]["authMode"], "app")


if __name__ == "__main__":
    unittest.main()
