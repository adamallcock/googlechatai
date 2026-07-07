import json
import pathlib
import unittest

from googlechatai import plan_chat_ingestion, process_polling_ingestion_page


ROOT = pathlib.Path(__file__).resolve().parents[3]


def read_json(relative_path: str):
    return json.loads((ROOT / relative_path).read_text(encoding="utf-8"))


class IngestionTests(unittest.TestCase):
    def test_plans_direct_workspace_events_and_polling_modes(self) -> None:
        direct = plan_chat_ingestion(
            {
                "mode": "direct_interaction",
                "endpointPath": "/api/chat/events",
            }
        )
        self.assertEqual(direct["kind"], "chat.ingestion_plan")
        self.assertEqual(direct["mode"], "direct_interaction")
        self.assertEqual(direct["delivery"]["transport"], "chat_http")
        self.assertEqual(direct["capability"]["authMode"], "chat_interaction")
        self.assertEqual(direct["capability"]["requiredScopes"], [])

        push = plan_chat_ingestion(
            {
                "mode": "workspace_events_push",
                "authMode": "user",
                "space": "spaces/AAA",
                "pubsubTopic": "projects/p/topics/chat-events",
                "pushEndpoint": "https://example.test/workspace-events",
                "includeResource": True,
            }
        )
        self.assertEqual(push["targetResource"], "//chat.googleapis.com/spaces/AAA")
        self.assertEqual(push["delivery"]["transport"], "pubsub_push")
        self.assertEqual(
            push["pubsub"]["publisherPrincipal"],
            "serviceAccount:chat-api-push@system.gserviceaccount.com",
        )
        self.assertIn("pubsub_publisher_iam", [item["name"] for item in push["setupChecks"]])

        pull = plan_chat_ingestion(
            {
                "mode": "workspace_events_pull",
                "authMode": "app",
                "space": "spaces/AAA",
                "pubsubSubscription": "projects/p/subscriptions/chat-events",
            }
        )
        self.assertTrue(pull["capability"]["requiresAdminApproval"])
        self.assertIn(
            "pubsub.subscriptions.pull",
            [request["resource"] for request in pull["requests"]],
        )

        polling = plan_chat_ingestion(
            {
                "mode": "polling",
                "authMode": "user",
                "space": "spaces/AAA",
                "startTime": "2026-07-04T00:00:00Z",
                "endTime": "2026-07-04T01:00:00Z",
                "pageSize": 250,
                "showDeleted": True,
                "checkpoint": {"pageToken": "cursor-1"},
            }
        )
        self.assertEqual(
            polling["polling"]["filter"],
            'createTime > "2026-07-04T00:00:00Z" AND createTime < "2026-07-04T01:00:00Z"',
        )
        self.assertEqual(polling["requests"][0]["query"]["pageToken"], "cursor-1")
        self.assertTrue(polling["requests"][0]["query"]["showDeleted"])

    def test_processes_polling_page_with_cursors_and_duplicate_signaling(self) -> None:
        response = read_json("fixtures/api-responses/messages/polling-ingestion-page.json")

        batch = process_polling_ingestion_page(
            {
                "space": "spaces/AAA",
                "receivedAt": "2026-07-04T00:10:00.000Z",
                "response": response,
                "checkpoint": {
                    "seenKeys": ["polling:spaces/AAA/messages/old:2026-07-04T00:04:00Z"]
                },
            }
        )

        self.assertEqual(batch["kind"], "chat.ingestion_batch")
        self.assertEqual(
            [item["snapshot"]["kind"] for item in batch["events"]],
            ["created_snapshot", "updated_snapshot", "deleted_snapshot"],
        )
        self.assertEqual(batch["events"][0]["normalized"]["kind"], "message.thread_reply")
        self.assertIn(
            "First passive message.",
            batch["events"][0]["normalized"]["message"]["plainTextForModel"],
        )
        self.assertIn(
            "Edited passive message.",
            batch["events"][1]["normalized"]["message"]["plainTextForModel"],
        )
        self.assertTrue(batch["events"][2]["snapshot"]["skippedAsDuplicate"])
        self.assertEqual(
            batch["events"][2]["snapshot"]["duplicateKey"],
            "polling:spaces/AAA/messages/old:2026-07-04T00:04:00Z",
        )
        self.assertEqual(batch["checkpoint"]["pageToken"], "cursor-2")
        self.assertEqual(batch["checkpoint"]["highWatermarkTime"], "2026-07-04T00:05:00Z")


if __name__ == "__main__":
    unittest.main()
