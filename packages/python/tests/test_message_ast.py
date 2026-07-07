import json
import pathlib
import unittest

from googlechatai import normalize_message


ROOT = pathlib.Path(__file__).resolve().parents[3]

CASES = [
    ("annotations.mentions-custom-emoji", "fixtures/messages/annotations/mentions-custom-emoji.json"),
    ("commands.slash-command", "fixtures/messages/commands/slash-command.json"),
    ("links.matched-url-rich-link", "fixtures/messages/links/matched-url-rich-link.json"),
    ("attachments.uploaded-file", "fixtures/messages/attachments/uploaded-file.json"),
    ("quotes.nested-content", "fixtures/messages/quotes/nested-content.json"),
    ("deleted.user-deleted", "fixtures/messages/deleted/user-deleted.json"),
    ("private.thread-reply", "fixtures/messages/private/thread-reply.json"),
    ("gifs.attached-gif", "fixtures/messages/gifs/attached-gif.json"),
]


def read_json(relative_path: str):
    return json.loads((ROOT / relative_path).read_text(encoding="utf-8"))


class NormalizeMessageTests(unittest.TestCase):
    def test_normalizes_shared_message_fixtures(self) -> None:
        for case_id, raw_fixture in CASES:
            with self.subTest(case_id=case_id):
                expected = read_json(f"fixtures/expected/messages/{case_id}.json")

                self.assertEqual(normalize_message(read_json(raw_fixture)), expected)

    def test_emits_nested_quote_context_fixture(self) -> None:
        raw = read_json("fixtures/messages/quotes/nested-content.json")
        expected = read_json("fixtures/expected/context/messages.quoted-nested.context.json")

        self.assertEqual(normalize_message(raw)["contextNode"], expected)


if __name__ == "__main__":
    unittest.main()
