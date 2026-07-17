import json
import unittest
from pathlib import Path

from app import chat


class AppTest(unittest.TestCase):
    def test_sanitized_mention_fixture(self) -> None:
        fixture = json.loads(
            (Path(__file__).parent / "fixtures" / "mention.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(
            chat.dispatch(fixture, source="fixture"),
            {"text": "You said: summarize this"},
        )


if __name__ == "__main__":
    unittest.main()
