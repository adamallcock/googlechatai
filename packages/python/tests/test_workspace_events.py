import json
import pathlib
import tempfile
import unittest

from googlechatai import (
    FileWorkspaceEventsCheckpointStore,
    InMemoryWorkspaceEventsCheckpointStore,
    normalize_event,
    parse_pubsub_pull_payload,
    parse_pubsub_push_payload,
    parse_workspace_chat_resource_event,
)


ROOT = pathlib.Path(__file__).resolve().parents[3]


def read_json(relative_path: str):
    return json.loads((ROOT / relative_path).read_text(encoding="utf-8"))


class WorkspaceEventsTests(unittest.TestCase):
    def test_normalizes_workspace_chat_resource_event(self) -> None:
        raw = read_json("fixtures/workspace-events/chat-message-created.event.json")
        expected = read_json(
            "fixtures/expected/workspace-events/chat-message-created.normalized.json"
        )

        parsed = parse_workspace_chat_resource_event(raw)

        self.assertEqual(parsed["event"], expected)
        self.assertEqual(parsed["rawWorkspaceEvent"], raw)

    def test_normalizes_access_limited_workspace_resource(self) -> None:
        raw = read_json(
            "fixtures/workspace-events/chat-message-deleted.access-limited.event.json"
        )
        expected = read_json(
            "fixtures/expected/workspace-events/"
            "chat-message-deleted.access-limited.normalized.json"
        )

        self.assertEqual(parse_workspace_chat_resource_event(raw)["event"], expected)
        normalized = normalize_event(raw)
        self.assertEqual(normalized["kind"], "message.deleted")
        self.assertIsNone(normalized["message"])
        self.assertEqual(
            normalized["transport"]["workspaceEventId"],
            "workspace-events-chat-message-deleted-access-limited-1",
        )

    def test_normalizes_pubsub_push_payload(self) -> None:
        raw = read_json("fixtures/workspace-events/pubsub-push-chat-message-created.json")
        expected = read_json(
            "fixtures/expected/workspace-events/pubsub-push-chat-message-created.normalized.json"
        )

        parsed = parse_pubsub_push_payload(raw)

        self.assertEqual(parsed["event"], expected)
        normalized = normalize_event(raw)
        self.assertEqual(
            normalized["eventId"],
            "workspace_events:workspace-events-chat-message-created-1",
        )
        self.assertEqual(normalized["source"], "workspace_events")
        self.assertEqual(normalized["kind"], "message.created")
        self.assertEqual(normalized["transport"]["pubsubMessageId"], "pubsub-message-1")
        self.assertEqual(parsed["rawPubSubPayload"], raw)
        self.assertEqual(
            parsed["rawWorkspaceEvent"],
            read_json("fixtures/workspace-events/chat-message-created.event.json"),
        )

    def test_normalizes_pubsub_pull_payload_and_checkpoint_store(self) -> None:
        raw = read_json("fixtures/workspace-events/pubsub-pull-chat-message-created.json")
        expected = read_json(
            "fixtures/expected/workspace-events/pubsub-pull-chat-message-created.normalized.json"
        )

        parsed = parse_pubsub_pull_payload(
            raw,
            subscription=(
                "projects/chat-ai-sdk/subscriptions/"
                "chat-ai-sdk-workspace-events-dev-pull"
            ),
        )

        self.assertEqual([item["event"] for item in parsed], expected)
        self.assertEqual(
            parsed[0]["event"]["pubSub"]["checkpoint"]["ackId"],
            "ack-workspace-events-chat-message-created-1",
        )

        store = InMemoryWorkspaceEventsCheckpointStore()
        store.save("dev-subscription", parsed[0]["event"]["pubSub"]["checkpoint"])

        self.assertEqual(
            store.load("dev-subscription"),
            parsed[0]["event"]["pubSub"]["checkpoint"],
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            checkpoint_path = pathlib.Path(temp_dir) / "checkpoints.json"
            file_store = FileWorkspaceEventsCheckpointStore(checkpoint_path)
            file_store.save(
                "dev-subscription",
                parsed[0]["event"]["pubSub"]["checkpoint"],
            )

            reloaded_store = FileWorkspaceEventsCheckpointStore(checkpoint_path)
            self.assertEqual(
                reloaded_store.load("dev-subscription"),
                parsed[0]["event"]["pubSub"]["checkpoint"],
            )


if __name__ == "__main__":
    unittest.main()
