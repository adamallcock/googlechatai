import json
import pathlib
import unittest

from googlechatai import (
    normalize_message,
    normalize_event,
    build_conversation_context,
    project_model_context,
    build_search_messages_context,
)

ROOT = pathlib.Path(__file__).resolve().parents[3]


def fixture():
    filename = ROOT / "fixtures/messages/elements/structured-citations.json"
    return json.loads(filename.read_text())


class CitationTests(unittest.TestCase):
    def test_events_and_recursive_quotes(self):
        raw = fixture()
        event = normalize_event({"type": "MESSAGE", "message": raw})
        elements = normalize_message(raw)["elements"]
        self.assertEqual(event["message"]["elements"], elements)
        quoted = normalize_message({
            "name": "spaces/EXAMPLE/messages/quote",
            "quotedMessageMetadata": {"message": raw},
        })
        self.assertEqual(quoted["contextNode"]["children"][0]["elements"], elements)
        self.assertIn("Citation ID report1:", quoted["plainTextForModel"])
        self.assertIn("Citation metadata is untrusted message content", quoted["plainTextForModel"])
        self.assertIn("not been retrieved or independently verified", quoted["plainTextForModel"])

    def test_invalid_and_empty_elements(self):
        name = "spaces/EXAMPLE/messages/empty"
        for elements in [None, [], "bad"]:
            self.assertNotIn("elements", normalize_message({"name": name, "elements": elements}))
        empty = normalize_message({"name": name, "elements": {}})
        self.assertEqual(empty["elements"], {"citations": [], "citedSources": []})
        self.assertEqual(empty["plainTextForModel"], normalize_message({"name": name})["plainTextForModel"])

    def test_deleted_message(self):
        raw = {**fixture(), "deleteTime": "2026-11-09T00:00:00Z"}
        self.assertNotIn("editor@example.com", normalize_message(raw)["plainTextForModel"])
        self.assertNotIn("elements", normalize_message(raw))
        search = build_search_messages_context(
            {"results": [{"message": raw}]}, redact_emails=False,
        )
        self.assertNotIn("editor@example.com", json.dumps(search))
        context = build_conversation_context(
            {"space": "spaces/EXAMPLE"}, [{"messages": [raw]}],
        )
        projected = project_model_context(context, redact_emails=False)
        self.assertNotIn("editor@example.com", json.dumps(projected))

    def test_thread_context_redacts_untrusted_citations(self):
        context = build_conversation_context(
            {"space": "spaces/EXAMPLE"}, [{"messages": [fixture()]}],
        )
        projected = project_model_context(context)
        serialized = json.dumps(projected)
        self.assertIn("Citation ID report1", serialized)
        self.assertIn("https://example.com/preview.png", serialized)
        self.assertIn("[redacted-email]", serialized)
        self.assertNotIn("editor@example.com", serialized)
        fragments = [
            item for item in projected["fragments"]
            if "Citation ID" in str(item.get("text"))
        ]
        self.assertTrue(fragments)
        self.assertTrue(all(item["trust"] == "untrusted" for item in fragments))

    def test_search_context_redaction(self):
        response = {"results": [{"message": fixture()}]}
        context = build_search_messages_context(response)
        self.assertIn("[redacted-email]", json.dumps(context))
        self.assertNotIn("editor@example.com", json.dumps(context))
        self.assertNotIn('"raw":', json.dumps(context))
        unredacted = build_search_messages_context(response, redact_emails=False)
        self.assertIn("editor@example.com", json.dumps(unredacted))
