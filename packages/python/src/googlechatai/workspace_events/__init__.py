"""Workspace Events and Pub/Sub ingestion helpers."""

from __future__ import annotations

import base64
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from googlechatai._file_state import atomic_write_text, file_state_lock
from googlechatai.events import normalize_event


RawMapping = Mapping[str, Any]


class InMemoryWorkspaceEventsCheckpointStore:
    """Small checkpoint store useful for tests and local smoke tooling."""

    def __init__(self) -> None:
        self._checkpoints: dict[str, dict[str, Any]] = {}

    def load(self, scope: str) -> dict[str, Any] | None:
        return self._checkpoints.get(scope)

    def save(self, scope: str, checkpoint: dict[str, Any]) -> None:
        self._checkpoints[scope] = checkpoint


class FileWorkspaceEventsCheckpointStore:
    """JSON-file checkpoint store for local smoke and replay experiments."""

    def __init__(self, file_path: str | Path) -> None:
        self._file_path = Path(file_path)

    def load(self, scope: str) -> dict[str, Any] | None:
        return self._read_all().get(scope)

    def save(self, scope: str, checkpoint: dict[str, Any]) -> None:
        with file_state_lock(self._file_path):
            checkpoints = self._read_all()
            checkpoints[scope] = checkpoint
            atomic_write_text(
                self._file_path,
                json.dumps(checkpoints, indent=2) + "\n",
            )

    def _read_all(self) -> dict[str, dict[str, Any]]:
        if not self._file_path.exists():
            return {}

        parsed = json.loads(self._file_path.read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, dict) else {}


def _as_mapping(value: Any) -> RawMapping | None:
    return value if isinstance(value, Mapping) else None


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _as_number(value: Any) -> int | float | None:
    return value if isinstance(value, int | float) and not isinstance(value, bool) else None


def _attributes_from(value: Any) -> dict[str, str]:
    raw = _as_mapping(value)

    if not raw:
        return {}

    return {key: item for key, item in raw.items() if isinstance(item, str)}


def _decode_pubsub_data(data: Any) -> Any:
    encoded = _as_string(data)

    if not encoded:
        return None

    decoded = base64.b64decode(encoded).decode("utf-8")

    if not decoded:
        return None

    try:
        return json.loads(decoded)
    except json.JSONDecodeError:
        return decoded


def _cloud_event_from_pubsub_message(message: RawMapping) -> dict[str, Any]:
    attributes = _attributes_from(message.get("attributes"))

    return {
        "id": attributes.get("ce-id"),
        "source": attributes.get("ce-source"),
        "specversion": attributes.get("ce-specversion"),
        "type": attributes.get("ce-type"),
        "time": attributes.get("ce-time"),
        "subject": attributes.get("ce-subject"),
        "datacontenttype": attributes.get("ce-datacontenttype")
        or attributes.get("content-type"),
        "data": _decode_pubsub_data(message.get("data")),
    }


def _strip_service_resource_name(value: str | None) -> str | None:
    if not value:
        return None

    return value.removeprefix("//chat.googleapis.com/")


def _resource_type_from(event_type: str | None, resource_name: str | None) -> str | None:
    if event_type and ".message." in event_type:
        return "message"

    if event_type and ".space." in event_type:
        return "space"

    if event_type and ".membership." in event_type:
        return "membership"

    if resource_name and "/messages/" in resource_name:
        return "message"

    if resource_name and "/members/" in resource_name:
        return "membership"

    if resource_name and resource_name.startswith("spaces/"):
        return "space"

    return None


def _resource_name_from_workspace_event(
    workspace_event: RawMapping,
    workspace_data: Any,
) -> str | None:
    data = _as_mapping(workspace_data)
    message = _as_mapping(data.get("message")) if data else None
    resource_name = (
        _as_string(message.get("name")) if message else None
    ) or (
        _as_string(data.get("resourceName")) if data else None
    ) or (
        _as_string(data.get("resource")) if data else None
    ) or _strip_service_resource_name(_as_string(workspace_event.get("subject")))

    return _strip_service_resource_name(resource_name)


def _subscription_from_source(source: str | None) -> str | None:
    if source and "/subscriptions/" in source:
        return source

    return None


def _workspace_metadata_from(
    workspace_event: RawMapping,
    event: dict[str, Any],
) -> dict[str, Any]:
    data = workspace_event.get("data")
    event_type = _as_string(workspace_event.get("type"))
    resource_name = _resource_name_from_workspace_event(workspace_event, data)
    data_availability = (
        "available"
        if _as_mapping(data) and _as_mapping(_as_mapping(data).get("message"))
        else "access_limited"
        if resource_name
        else "unavailable"
    )

    return {
        "id": _as_string(workspace_event.get("id")),
        "type": event_type,
        "source": _as_string(workspace_event.get("source")),
        "subject": _as_string(workspace_event.get("subject")),
        "time": _as_string(workspace_event.get("time")),
        "subscription": _subscription_from_source(_as_string(workspace_event.get("source"))),
        "resource": {
            "type": _resource_type_from(event_type, resource_name),
            "name": resource_name,
            "service": "chat.googleapis.com" if resource_name else None,
            "availability": data_availability,
        },
        "actor": event["actor"],
        "actorAvailability": "available" if event["actor"] else "unavailable",
        "resourceDataAvailability": data_availability,
    }


def _checkpoint_from_pubsub(
    pubsub_message: RawMapping,
    subscription: str | None,
    ack_id: str | None,
    delivery_attempt: int | float | None,
) -> dict[str, Any]:
    message_id = _as_string(pubsub_message.get("messageId")) or _as_string(
        pubsub_message.get("message_id")
    )
    publish_time = _as_string(pubsub_message.get("publishTime")) or _as_string(
        pubsub_message.get("publish_time")
    )
    ordering_key = _as_string(pubsub_message.get("orderingKey"))
    cursor_seed = message_id or ack_id or publish_time or "unknown"

    return {
        "type": "pubsub",
        "cursor": f"{subscription}#{cursor_seed}" if subscription else cursor_seed,
        "ackId": ack_id,
        "messageId": message_id,
        "subscription": subscription,
        "publishTime": publish_time,
        "deliveryAttempt": delivery_attempt,
        "orderingKey": ordering_key,
    }


def _pubsub_metadata_from(
    pubsub_message: RawMapping,
    subscription: str | None,
    ack_id: str | None,
    delivery_attempt: int | float | None,
) -> dict[str, Any]:
    checkpoint = _checkpoint_from_pubsub(
        pubsub_message,
        subscription,
        ack_id,
        delivery_attempt,
    )

    return {
        "messageId": checkpoint["messageId"],
        "publishTime": checkpoint["publishTime"],
        "subscription": checkpoint["subscription"],
        "orderingKey": checkpoint["orderingKey"],
        "deliveryAttempt": checkpoint["deliveryAttempt"],
        "attributes": _attributes_from(pubsub_message.get("attributes")),
        "checkpoint": checkpoint,
    }


def _parse_workspace_event_envelope(input_event: Any) -> RawMapping:
    raw = _as_mapping(input_event)

    if not raw:
        raise TypeError("Expected a Workspace Events CloudEvent object.")

    return raw


def parse_workspace_chat_resource_event(
    input_event: Any,
    *,
    source: str | None = None,
    pubsub: dict[str, Any] | None = None,
) -> dict[str, Any]:
    workspace_event = _parse_workspace_event_envelope(input_event)
    event_time = _as_string(workspace_event.get("time"))
    kwargs: dict[str, Any] = {"received_at": event_time}
    if source is not None:
        kwargs["source"] = source
    event = normalize_event(workspace_event, **kwargs)

    event["workspaceEvent"] = _workspace_metadata_from(workspace_event, event)

    if pubsub:
        event["pubSub"] = pubsub

    return {
        "event": event,
        "rawWorkspaceEvent": workspace_event,
    }


def parse_pubsub_push_payload(input_payload: Any) -> dict[str, Any]:
    raw = _as_mapping(input_payload)
    pubsub_message = _as_mapping(raw.get("message")) if raw else None

    if not raw or not pubsub_message:
        raise TypeError("Expected a Pub/Sub push payload with a message object.")

    subscription = _as_string(raw.get("subscription"))
    workspace_event = _cloud_event_from_pubsub_message(pubsub_message)
    pubsub = _pubsub_metadata_from(pubsub_message, subscription, None, None)
    parsed = parse_workspace_chat_resource_event(
        workspace_event,
        pubsub=pubsub,
    )

    parsed["decodedPubSubData"] = workspace_event["data"]
    parsed["rawPubSubPayload"] = input_payload
    return parsed


def _normalize_pull_items(input_payload: Any) -> list[Any]:
    if isinstance(input_payload, list):
        return input_payload

    raw = _as_mapping(input_payload)
    received_messages = raw.get("receivedMessages") if raw else None

    return received_messages if isinstance(received_messages, list) else []


def parse_pubsub_pull_payload(
    input_payload: Any,
    *,
    subscription: str | None = None,
) -> list[dict[str, Any]]:
    parsed_events: list[dict[str, Any]] = []

    for item in _normalize_pull_items(input_payload):
        raw = _as_mapping(item)
        pubsub_message = _as_mapping(raw.get("message")) if raw else None

        if not raw or not pubsub_message:
            raise TypeError("Expected a Pub/Sub pull item with a message object.")

        workspace_event = _cloud_event_from_pubsub_message(pubsub_message)
        item_subscription = subscription or _as_string(raw.get("subscription"))
        pubsub = _pubsub_metadata_from(
            pubsub_message,
            item_subscription,
            _as_string(raw.get("ackId")),
            _as_number(raw.get("deliveryAttempt")),
        )
        parsed = parse_workspace_chat_resource_event(
            workspace_event,
            pubsub=pubsub,
        )
        parsed["decodedPubSubData"] = workspace_event["data"]
        parsed["rawPubSubPayload"] = item
        parsed_events.append(parsed)

    return parsed_events


__all__ = [
    "FileWorkspaceEventsCheckpointStore",
    "InMemoryWorkspaceEventsCheckpointStore",
    "parse_pubsub_pull_payload",
    "parse_pubsub_push_payload",
    "parse_workspace_chat_resource_event",
]
