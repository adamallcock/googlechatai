import base64
import json
import tempfile
import unittest
from pathlib import Path

from googlechatai.queues import (
    CloudTasksQueueAdapter,
    FileAsyncResponseQueue,
    PubSubQueueAdapter,
)


FIXED_LEASE = {"access_token": "lease-token-1", "token_type": "Bearer"}


def _task(task_id: str) -> dict[str, object]:
    return {
        "kind": "chat.async_response_task",
        "taskId": task_id,
        "eventId": None,
        "space": "spaces/AAA",
        "createdAt": "2026-07-06T12:00:00.000Z",
    }


def _decode_base64_json(value: str) -> object:
    return json.loads(base64.b64decode(value).decode("utf8"))


class FakeSend:
    def __init__(self, handler):
        self.handler = handler
        self.requests: list[dict[str, object]] = []

    def __call__(self, request: dict[str, object]) -> dict[str, object]:
        self.requests.append(request)
        return self.handler(request)


def _json_response(status: int, body: object) -> dict[str, object]:
    return {"ok": 200 <= status < 300, "status": status, "json": body, "headers": {}}


class FileAsyncResponseQueueTests(unittest.TestCase):
    def test_returns_none_and_empty_list_for_missing_file_without_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            queue = FileAsyncResponseQueue(Path(tmpdir) / "queue.json")
            self.assertIsNone(queue.dequeue())
            self.assertEqual(queue.list(), [])
            self.assertEqual(queue.drain(), [])

    def test_enqueues_tasks_and_returns_the_documented_enqueue_result_shape(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = Path(tmpdir) / "queue.json"
            queue = FileAsyncResponseQueue(file_path)

            result = queue.enqueue(_task("task-1"))
            self.assertEqual(
                result,
                {
                    "kind": "chat.async_queue_enqueue_result",
                    "status": "enqueued",
                    "depth": 1,
                    "taskId": "task-1",
                },
            )

            second_result = queue.enqueue(_task("task-2"))
            self.assertEqual(second_result["depth"], 2)

    def test_persists_across_instances_with_version_tasks_json_shape_and_atomic_rename(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = Path(tmpdir) / "queue.json"
            queue = FileAsyncResponseQueue(file_path)

            queue.enqueue(_task("task-1"))
            queue.enqueue(_task("task-2"))

            raw = json.loads(file_path.read_text("utf8"))
            self.assertEqual(raw, {"version": 1, "tasks": [_task("task-1"), _task("task-2")]})

            entries = [entry.name for entry in Path(tmpdir).iterdir()]
            self.assertEqual(entries, ["queue.json"])

            second_queue = FileAsyncResponseQueue(file_path)
            self.assertEqual(second_queue.list(), [_task("task-1"), _task("task-2")])

    def test_dequeues_fifo_and_supports_drain_with_and_without_a_limit(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = Path(tmpdir) / "queue.json"
            queue = FileAsyncResponseQueue(file_path)

            queue.enqueue(_task("task-1"))
            queue.enqueue(_task("task-2"))
            queue.enqueue(_task("task-3"))

            self.assertEqual(queue.dequeue(), _task("task-1"))
            self.assertEqual(queue.list(), [_task("task-2"), _task("task-3")])

            drained_one = queue.drain(1)
            self.assertEqual(drained_one, [_task("task-2")])
            self.assertEqual(queue.list(), [_task("task-3")])

            drained_rest = queue.drain()
            self.assertEqual(drained_rest, [_task("task-3")])
            self.assertEqual(queue.list(), [])
            self.assertIsNone(queue.dequeue())

    def test_raises_type_error_when_file_path_is_missing(self) -> None:
        with self.assertRaises(TypeError):
            FileAsyncResponseQueue("")

    def test_raises_type_error_for_a_task_missing_task_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            queue = FileAsyncResponseQueue(Path(tmpdir) / "queue.json")
            with self.assertRaises(TypeError):
                queue.enqueue({"kind": "chat.async_response_task"})

    def test_cross_language_file_format_written_by_node_is_loadable_by_python(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = Path(tmpdir) / "queue.json"
            node_style_payload = {"version": 1, "tasks": [_task("task-1"), _task("task-2")]}
            file_path.write_text(f"{json.dumps(node_style_payload, indent=2)}\n", "utf8")

            queue = FileAsyncResponseQueue(file_path)
            self.assertEqual(queue.list(), [_task("task-1"), _task("task-2")])
            self.assertEqual(queue.dequeue(), _task("task-1"))


class CloudTasksQueueAdapterTests(unittest.TestCase):
    def test_enqueues_via_post_tasks_with_base64_body_and_returns_enqueue_result(self) -> None:
        def handler(request: dict[str, object]) -> dict[str, object]:
            self.assertEqual(
                request["url"],
                "https://cloudtasks.googleapis.com/v2/projects/my-project/locations/us-central1/queues/my-queue/tasks",
            )
            self.assertEqual(request["method"], "POST")
            self.assertEqual(request["headers"]["authorization"], "Bearer lease-token-1")
            body = request["body"]
            http_request = body["task"]["httpRequest"]
            self.assertEqual(http_request["httpMethod"], "POST")
            self.assertEqual(http_request["url"], "https://example.com/tasks/handle")
            self.assertEqual(http_request["headers"], {"content-type": "application/json"})
            decoded = _decode_base64_json(http_request["body"])
            self.assertEqual(decoded, _task("task-1"))
            self.assertNotIn("oidcToken", http_request)
            return _json_response(
                200,
                {"name": "projects/my-project/locations/us-central1/queues/my-queue/tasks/abc123"},
            )

        send = FakeSend(handler)
        adapter = CloudTasksQueueAdapter(
            queue_path="projects/my-project/locations/us-central1/queues/my-queue",
            target_url="https://example.com/tasks/handle",
            send=send,
            get_access_token=lambda force_refresh=False: FIXED_LEASE,
        )

        result = adapter.enqueue(_task("task-1"))
        self.assertEqual(
            result,
            {
                "kind": "chat.async_queue_enqueue_result",
                "status": "enqueued",
                "depth": None,
                "taskId": "task-1",
                "remoteName": "projects/my-project/locations/us-central1/queues/my-queue/tasks/abc123",
            },
        )
        self.assertEqual(len(send.requests), 1)

    def test_includes_oidc_token_service_account_email_when_provided(self) -> None:
        def handler(request: dict[str, object]) -> dict[str, object]:
            http_request = request["body"]["task"]["httpRequest"]
            self.assertEqual(
                http_request["oidcToken"],
                {"serviceAccountEmail": "chat-bot@my-project.iam.gserviceaccount.com"},
            )
            return _json_response(200, {"name": "tasks/abc123"})

        send = FakeSend(handler)
        adapter = CloudTasksQueueAdapter(
            queue_path="projects/my-project/locations/us-central1/queues/my-queue",
            target_url="https://example.com/tasks/handle",
            send=send,
            get_access_token=lambda force_refresh=False: FIXED_LEASE,
            service_account_email="chat-bot@my-project.iam.gserviceaccount.com",
        )

        adapter.enqueue(_task("task-1"))

    def test_raises_on_pull_methods_dequeue_list_drain(self) -> None:
        adapter = CloudTasksQueueAdapter(
            queue_path="projects/my-project/locations/us-central1/queues/my-queue",
            target_url="https://example.com/tasks/handle",
            send=FakeSend(lambda request: _json_response(200, {})),
            get_access_token=lambda force_refresh=False: FIXED_LEASE,
        )

        with self.assertRaises(Exception) as ctx:
            adapter.dequeue()
        self.assertEqual(
            str(ctx.exception), "Cloud Tasks delivers tasks by push; dequeue is not supported."
        )
        with self.assertRaises(Exception):
            adapter.list()
        with self.assertRaises(Exception):
            adapter.drain()

    def test_raises_error_with_status_and_queue_path_no_body_contents_on_non_ok_response(self) -> None:
        send = FakeSend(lambda request: _json_response(500, {"error": {"message": "leaked internal detail"}}))
        adapter = CloudTasksQueueAdapter(
            queue_path="projects/my-project/locations/us-central1/queues/my-queue",
            target_url="https://example.com/tasks/handle",
            send=send,
            get_access_token=lambda force_refresh=False: FIXED_LEASE,
        )

        with self.assertRaises(Exception) as ctx:
            adapter.enqueue(_task("task-1"))
        self.assertEqual(
            str(ctx.exception),
            "Cloud Tasks POST 500 for projects/my-project/locations/us-central1/queues/my-queue",
        )

    def test_raises_type_error_when_send_or_get_access_token_are_missing(self) -> None:
        with self.assertRaises(TypeError):
            CloudTasksQueueAdapter(
                queue_path="projects/my-project/locations/us-central1/queues/my-queue",
                target_url="https://example.com/tasks/handle",
                send=None,
                get_access_token=lambda force_refresh=False: FIXED_LEASE,
            )
        with self.assertRaises(TypeError):
            CloudTasksQueueAdapter(
                queue_path="projects/my-project/locations/us-central1/queues/my-queue",
                target_url="https://example.com/tasks/handle",
                send=FakeSend(lambda request: _json_response(200, {})),
                get_access_token=None,
            )


class PubSubQueueAdapterTests(unittest.TestCase):
    def test_publishes_to_publish_with_base64_data_and_attributes_returning_message_ids_0(self) -> None:
        def handler(request: dict[str, object]) -> dict[str, object]:
            self.assertEqual(
                request["url"],
                "https://pubsub.googleapis.com/v1/projects/my-project/topics/my-topic:publish",
            )
            self.assertEqual(request["method"], "POST")
            self.assertEqual(request["headers"]["authorization"], "Bearer lease-token-1")
            messages = request["body"]["messages"]
            self.assertEqual(len(messages), 1)
            self.assertEqual(
                messages[0]["attributes"], {"taskId": "task-1", "kind": "chat.async_response_task"}
            )
            decoded = _decode_base64_json(messages[0]["data"])
            self.assertEqual(decoded, _task("task-1"))
            return _json_response(200, {"messageIds": ["msg-123"]})

        send = FakeSend(handler)
        adapter = PubSubQueueAdapter(
            topic="projects/my-project/topics/my-topic",
            send=send,
            get_access_token=lambda force_refresh=False: FIXED_LEASE,
        )

        result = adapter.enqueue(_task("task-1"))
        self.assertEqual(
            result,
            {
                "kind": "chat.async_queue_enqueue_result",
                "status": "enqueued",
                "depth": None,
                "taskId": "task-1",
                "remoteName": "msg-123",
            },
        )
        self.assertEqual(len(send.requests), 1)

    def test_raises_on_pull_methods_dequeue_list_drain(self) -> None:
        adapter = PubSubQueueAdapter(
            topic="projects/my-project/topics/my-topic",
            send=FakeSend(lambda request: _json_response(200, {"messageIds": ["msg-1"]})),
            get_access_token=lambda force_refresh=False: FIXED_LEASE,
        )

        with self.assertRaises(Exception) as ctx:
            adapter.dequeue()
        self.assertEqual(
            str(ctx.exception), "Cloud Tasks delivers tasks by push; dequeue is not supported."
        )
        with self.assertRaises(Exception):
            adapter.list()
        with self.assertRaises(Exception):
            adapter.drain()

    def test_raises_error_with_status_and_topic_no_body_contents_on_non_ok_response(self) -> None:
        send = FakeSend(lambda request: _json_response(503, {"error": {"message": "leaked internal detail"}}))
        adapter = PubSubQueueAdapter(
            topic="projects/my-project/topics/my-topic",
            send=send,
            get_access_token=lambda force_refresh=False: FIXED_LEASE,
        )

        with self.assertRaises(Exception) as ctx:
            adapter.enqueue(_task("task-1"))
        self.assertEqual(str(ctx.exception), "Pub/Sub POST 503 for projects/my-project/topics/my-topic")

    def test_raises_type_error_when_send_or_get_access_token_are_missing(self) -> None:
        with self.assertRaises(TypeError):
            PubSubQueueAdapter(
                topic="projects/my-project/topics/my-topic",
                send=None,
                get_access_token=lambda force_refresh=False: FIXED_LEASE,
            )
        with self.assertRaises(TypeError):
            PubSubQueueAdapter(
                topic="projects/my-project/topics/my-topic",
                send=FakeSend(lambda request: _json_response(200, {})),
                get_access_token=None,
            )


if __name__ == "__main__":
    unittest.main()
