"""Production async-response queue adapters for the Google Chat AI SDK.

Mirrors the Node queues module (packages/node/src/queues/index.ts): an
AsyncResponseQueue protocol, an atomically-written file-backed FIFO queue,
and push-only Cloud Tasks / Pub/Sub adapters.

Note: googlechatai.messages.InMemoryAsyncResponseQueue is synchronous and
is unaffected by this module; these adapters exist for I/O-backed queues.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any, Callable, Protocol
from urllib.parse import quote, urlencode

from .._file_state import atomic_write_text, file_state_lock


DEFAULT_CLOUD_TASKS_BASE_URL = "https://cloudtasks.googleapis.com"
DEFAULT_PUBSUB_BASE_URL = "https://pubsub.googleapis.com"
_PULL_NOT_SUPPORTED_MESSAGE = "Cloud Tasks delivers tasks by push; dequeue is not supported."


class AsyncResponseQueue(Protocol):
    def enqueue(self, task: dict[str, Any]) -> dict[str, Any]: ...

    def dequeue(self) -> dict[str, Any] | None: ...

    def list(self) -> list[dict[str, Any]]: ...

    def drain(self, limit: int | None = None) -> list[dict[str, Any]]: ...


def _required_task_id(task: dict[str, Any]) -> str:
    task_id = task.get("taskId") if isinstance(task, dict) else None
    if not isinstance(task_id, str) or task_id.strip() == "":
        raise TypeError("Expected task['taskId'] to be a non-empty string.")
    return task_id


def _bytes_to_base64(value: str) -> str:
    return base64.b64encode(value.encode("utf8")).decode("ascii")


def _token_value(lease: dict[str, Any]) -> str:
    return str(lease.get("access_token") or lease.get("accessToken") or "")


def _token_type(lease: dict[str, Any]) -> str:
    return str(lease.get("token_type") or lease.get("tokenType") or "Bearer")


def _trim_trailing_slash(base_url: str) -> str:
    return base_url.rstrip("/")


class FileAsyncResponseQueue:
    def __init__(self, file_path: str | Path) -> None:
        if not file_path:
            raise TypeError("FileAsyncResponseQueue requires file_path.")
        self.file_path = Path(file_path)

    def enqueue(self, task: dict[str, Any]) -> dict[str, Any]:
        task_id = _required_task_id(task)
        with file_state_lock(self.file_path):
            tasks = self._read_tasks()
            tasks.append(dict(task))
            self._write_tasks(tasks)
            return {
                "kind": "chat.async_queue_enqueue_result",
                "status": "enqueued",
                "depth": len(tasks),
                "taskId": task_id,
            }

    def dequeue(self) -> dict[str, Any] | None:
        with file_state_lock(self.file_path):
            tasks = self._read_tasks()
            if not tasks:
                return None
            next_task = tasks.pop(0)
            self._write_tasks(tasks)
            return next_task

    def list(self) -> list[dict[str, Any]]:
        return self._read_tasks()

    def drain(self, limit: int | None = None) -> list[dict[str, Any]]:
        with file_state_lock(self.file_path):
            tasks = self._read_tasks()
            count = len(tasks) if limit is None else max(0, int(limit))
            drained = tasks[:count]
            del tasks[:count]
            self._write_tasks(tasks)
            return drained

    def _read_tasks(self) -> list[dict[str, Any]]:
        if not self.file_path.exists():
            return []
        parsed = json.loads(self.file_path.read_text("utf8"))
        return list(parsed.get("tasks", []))

    def _write_tasks(self, tasks: list[dict[str, Any]]) -> None:
        payload = {"version": 1, "tasks": tasks}
        atomic_write_text(self.file_path, f"{json.dumps(payload, indent=2)}\n")


class CloudTasksQueueAdapter:
    def __init__(
        self,
        *,
        queue_path: str,
        target_url: str,
        send: Callable[[dict[str, Any]], dict[str, Any]],
        get_access_token: Callable[..., dict[str, Any]],
        base_url: str | None = None,
        service_account_email: str | None = None,
    ) -> None:
        if not queue_path:
            raise TypeError("CloudTasksQueueAdapter requires queue_path.")
        if not target_url:
            raise TypeError("CloudTasksQueueAdapter requires target_url.")
        if not callable(send):
            raise TypeError("CloudTasksQueueAdapter requires an injected send callable.")
        if not callable(get_access_token):
            raise TypeError("CloudTasksQueueAdapter requires an injected get_access_token callable.")
        self.queue_path = queue_path
        self.target_url = target_url
        self.send = send
        self.get_access_token = get_access_token
        self.base_url = _trim_trailing_slash(base_url or DEFAULT_CLOUD_TASKS_BASE_URL)
        self.service_account_email = service_account_email

    def enqueue(self, task: dict[str, Any]) -> dict[str, Any]:
        task_id = _required_task_id(task)
        lease = self.get_access_token(force_refresh=False)
        url = f"{self.base_url}/v2/{self.queue_path}/tasks"
        http_request: dict[str, Any] = {
            "httpMethod": "POST",
            "url": self.target_url,
            "headers": {"content-type": "application/json"},
            "body": _bytes_to_base64(json.dumps(task)),
        }
        if self.service_account_email:
            http_request["oidcToken"] = {"serviceAccountEmail": self.service_account_email}

        request = {
            "url": url,
            "method": "POST",
            "headers": {
                "content-type": "application/json",
                "authorization": f"{_token_type(lease)} {_token_value(lease)}",
            },
            "body": {"task": {"httpRequest": http_request}},
        }
        response = self.send(request)
        if not response.get("ok"):
            status = int(response.get("status") or 0)
            raise Exception(f"Cloud Tasks POST {status} for {self.queue_path}")

        body = response.get("json") or {}
        remote_name = body.get("name")
        return {
            "kind": "chat.async_queue_enqueue_result",
            "status": "enqueued",
            "depth": None,
            "taskId": task_id,
            "remoteName": remote_name,
        }

    def dequeue(self) -> dict[str, Any] | None:
        raise Exception(_PULL_NOT_SUPPORTED_MESSAGE)

    def list(self) -> list[dict[str, Any]]:
        raise Exception(_PULL_NOT_SUPPORTED_MESSAGE)

    def drain(self, limit: int | None = None) -> list[dict[str, Any]]:
        raise Exception(_PULL_NOT_SUPPORTED_MESSAGE)


class PubSubQueueAdapter:
    def __init__(
        self,
        *,
        topic: str,
        send: Callable[[dict[str, Any]], dict[str, Any]],
        get_access_token: Callable[..., dict[str, Any]],
        base_url: str | None = None,
    ) -> None:
        if not topic:
            raise TypeError("PubSubQueueAdapter requires topic.")
        if not callable(send):
            raise TypeError("PubSubQueueAdapter requires an injected send callable.")
        if not callable(get_access_token):
            raise TypeError("PubSubQueueAdapter requires an injected get_access_token callable.")
        self.topic = topic
        self.send = send
        self.get_access_token = get_access_token
        self.base_url = _trim_trailing_slash(base_url or DEFAULT_PUBSUB_BASE_URL)

    def enqueue(self, task: dict[str, Any]) -> dict[str, Any]:
        task_id = _required_task_id(task)
        lease = self.get_access_token(force_refresh=False)
        url = f"{self.base_url}/v1/{self.topic}:publish"
        request = {
            "url": url,
            "method": "POST",
            "headers": {
                "content-type": "application/json",
                "authorization": f"{_token_type(lease)} {_token_value(lease)}",
            },
            "body": {
                "messages": [
                    {
                        "data": _bytes_to_base64(json.dumps(task)),
                        "attributes": {"taskId": task_id, "kind": "chat.async_response_task"},
                    }
                ]
            },
        }
        response = self.send(request)
        if not response.get("ok"):
            status = int(response.get("status") or 0)
            raise Exception(f"Pub/Sub POST {status} for {self.topic}")

        body = response.get("json") or {}
        message_ids = body.get("messageIds") or []
        remote_name = message_ids[0] if message_ids else None
        return {
            "kind": "chat.async_queue_enqueue_result",
            "status": "enqueued",
            "depth": None,
            "taskId": task_id,
            "remoteName": remote_name,
        }

    def dequeue(self) -> dict[str, Any] | None:
        raise Exception(_PULL_NOT_SUPPORTED_MESSAGE)

    def list(self) -> list[dict[str, Any]]:
        raise Exception(_PULL_NOT_SUPPORTED_MESSAGE)

    def drain(self, limit: int | None = None) -> list[dict[str, Any]]:
        raise Exception(_PULL_NOT_SUPPORTED_MESSAGE)


__all__ = [
    "AsyncResponseQueue",
    "CloudTasksQueueAdapter",
    "DEFAULT_CLOUD_TASKS_BASE_URL",
    "DEFAULT_PUBSUB_BASE_URL",
    "FileAsyncResponseQueue",
    "PubSubQueueAdapter",
]
