import json
import pathlib
import unittest

from googlechatai import normalize_action, normalize_event


ROOT = pathlib.Path(__file__).resolve().parents[3]


def read_json(relative_path: str):
    return json.loads((ROOT / relative_path).read_text(encoding="utf-8"))


ACTION_CASES = [
    {
        "raw": "fixtures/actions/card-click/approve-basic.json",
        "expected": "fixtures/expected/actions/card-click.approve-basic.json",
        "event_kind": "card.clicked",
    },
    {
        "raw": "fixtures/actions/dialog-submit/complex-form.json",
        "expected": "fixtures/expected/actions/dialog-submit.complex-form.json",
        "event_kind": "dialog.submitted",
    },
    {
        "raw": "fixtures/actions/widget-update/autocomplete-users.json",
        "expected": "fixtures/expected/actions/widget-update.autocomplete-users.json",
        "event_kind": "widget.updated",
    },
    {
        "raw": "fixtures/actions/slash-command/deploy.json",
        "expected": "fixtures/expected/actions/slash-command.deploy.json",
        "event_kind": "message.slash_command",
    },
    {
        "raw": "fixtures/actions/app-command/search-docs.json",
        "expected": "fixtures/expected/actions/app-command.search-docs.json",
        "event_kind": "message.app_command",
    },
    {
        "raw": "fixtures/actions/card-click/invalid-and-unknown-fields.json",
        "expected": "fixtures/expected/actions/card-click.invalid-and-unknown-fields.json",
        "event_kind": "card.clicked",
    },
]


class NormalizeActionTests(unittest.TestCase):
    def test_normalizes_shared_action_fixtures(self) -> None:
        for action_case in ACTION_CASES:
            with self.subTest(action_case["raw"]):
                raw = read_json(action_case["raw"])
                expected = read_json(action_case["expected"])

                self.assertEqual(normalize_action(raw, source="fixture"), expected)

    def test_surfaces_shared_action_fixtures_through_event_normalization(
        self,
    ) -> None:
        for action_case in ACTION_CASES:
            with self.subTest(action_case["raw"]):
                raw = read_json(action_case["raw"])
                expected = read_json(action_case["expected"])
                event = normalize_event(raw, source="fixture")

                self.assertEqual(event["kind"], action_case["event_kind"])
                self.assertEqual(event["action"], expected)

    def test_surfaces_same_normalized_action_shape_through_event_normalization(
        self,
    ) -> None:
        raw = read_json("fixtures/actions/dialog-submit/complex-form.json")
        expected = read_json(
            "fixtures/expected/actions/dialog-submit.complex-form.json"
        )
        event = normalize_event(raw, source="fixture")

        self.assertEqual(event["kind"], "dialog.submitted")
        self.assertEqual(event["action"], expected)


if __name__ == "__main__":
    unittest.main()
