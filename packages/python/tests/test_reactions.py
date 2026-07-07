import json
import pathlib
import unittest

from googlechatai import (
    build_reaction_filter_for_emoji,
    feedback_rating_to_emoji,
    plan_add_reaction,
    plan_delete_reaction,
    plan_feedback_reaction,
    plan_list_reactions,
)


ROOT = pathlib.Path(__file__).resolve().parents[3]


def read_json(relative_path: str):
    return json.loads((ROOT / relative_path).read_text(encoding="utf-8"))


PLANNERS = {
    "reactions.add": plan_add_reaction,
    "reactions.delete": plan_delete_reaction,
    "reactions.feedback": plan_feedback_reaction,
    "reactions.list": plan_list_reactions,
}


class ReactionCallPlanTests(unittest.TestCase):
    def test_matches_shared_call_plan_cases(self) -> None:
        for test_case in read_json("conformance/cases/reactions.call-plans.json"):
            with self.subTest(test_case["id"]):
                self.assertEqual(
                    PLANNERS[test_case["operation"]](test_case["input"]),
                    test_case["expect"],
                )

    def test_maps_feedback_ratings_to_visible_thumbs_reactions(self) -> None:
        self.assertEqual(feedback_rating_to_emoji("helpful"), {"unicode": "\U0001F44D"})
        self.assertEqual(feedback_rating_to_emoji("thumbsUp"), {"unicode": "\U0001F44D"})
        self.assertEqual(
            feedback_rating_to_emoji("not_helpful"),
            {"unicode": "\U0001F44E"},
        )
        self.assertEqual(
            feedback_rating_to_emoji("Not helpful"),
            {"unicode": "\U0001F44E"},
        )
        with self.assertRaisesRegex(TypeError, "feedback rating"):
            feedback_rating_to_emoji("meh")

    def test_builds_filters_for_unicode_and_custom_emoji_uid_values(self) -> None:
        self.assertEqual(
            build_reaction_filter_for_emoji("\U0001F44D"),
            'emoji.unicode = "\U0001F44D"',
        )
        self.assertEqual(
            build_reaction_filter_for_emoji(
                {"customEmoji": {"uid": "custom-emoji-123"}}
            ),
            'emoji.custom_emoji.uid = "custom-emoji-123"',
        )

    def test_marks_app_auth_reaction_writes_unavailable(self) -> None:
        self.assertEqual(
            plan_feedback_reaction(
                {
                    "message": "spaces/AAA/messages/BBB",
                    "rating": "up",
                    "authMode": "app",
                }
            )["capability"]["ok"],
            False,
        )


if __name__ == "__main__":
    unittest.main()
