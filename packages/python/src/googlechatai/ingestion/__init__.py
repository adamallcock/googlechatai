"""Passive Google Chat ingestion planners and polling snapshot helpers."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from googlechatai.events import normalize_event


JsonObject = dict[str, Any]

CHAT_MESSAGES_READONLY_SCOPE = "https://www.googleapis.com/auth/chat.messages.readonly"
CHAT_APP_MESSAGES_READONLY_SCOPE = (
    "https://www.googleapis.com/auth/chat.app.messages.readonly"
)
WORKSPACE_EVENTS_SCOPE = "https://www.googleapis.com/auth/workspace.events"
PUBSUB_SCOPE = "https://www.googleapis.com/auth/pubsub"
CHAT_EVENTS_PUBLISHER_PRINCIPAL = (
    "serviceAccount:chat-api-push@system.gserviceaccount.com"
)
DEFAULT_EVENT_TYPES = [
    "google.workspace.chat.message.v1.created",
    "google.workspace.chat.message.v1.updated",
    "google.workspace.chat.message.v1.deleted",
]


def _as_mapping(value: Any) -> Mapping[str, Any] | None:
    return value if isinstance(value, Mapping) else None


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _as_number(value: Any) -> int | float | None:
    return value if isinstance(value, int | float) and not isinstance(value, bool) else None


def _as_bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _required_string(input_value: Mapping[str, Any], key: str) -> str:
    value = _as_string(input_value.get(key))
    if not value:
        raise TypeError(f"Expected {key} to be a non-empty string.")
    return value


def _string_list(value: Any, fallback: list[str]) -> list[str]:
    output = [item for item in _as_list(value) if isinstance(item, str)]
    return output if output else list(fallback)


def _auth_mode(input_value: Mapping[str, Any]) -> str:
    return _as_string(input_value.get("authMode")) or "user"


def _target_resource(input_value: Mapping[str, Any]) -> str:
    explicit = _as_string(input_value.get("targetResource"))
    if explicit:
        return explicit
    return f"//chat.googleapis.com/{_required_string(input_value, 'space')}"


def _page_size(input_value: Mapping[str, Any]) -> int:
    value = _as_number(input_value.get("pageSize")) or 100
    return max(1, min(1000, int(value)))


def _order_by(input_value: Mapping[str, Any]) -> str:
    order = (
        _as_string(input_value.get("order"))
        or _as_string(input_value.get("orderBy"))
        or "ASC"
    ).upper()
    return "createTime DESC" if order in {"DESC", "CREATE_TIME DESC"} else "createTime ASC"


def _build_polling_filter(input_value: Mapping[str, Any]) -> str | None:
    clauses: list[str] = []
    start_time = _as_string(input_value.get("startTime"))
    end_time = _as_string(input_value.get("endTime"))
    thread = _as_string(input_value.get("thread"))

    if start_time:
        clauses.append(f'createTime > "{start_time}"')
    if end_time:
        clauses.append(f'createTime < "{end_time}"')
    if thread:
        clauses.append(f'thread.name = "{thread}"')

    return " AND ".join(clauses) if clauses else None


def _checkpoint_input(input_value: Mapping[str, Any]) -> Mapping[str, Any]:
    return _as_mapping(input_value.get("checkpoint")) or {}


def _page_token(input_value: Mapping[str, Any]) -> str | None:
    checkpoint = _checkpoint_input(input_value)
    return (
        _as_string(input_value.get("pageToken"))
        or _as_string(checkpoint.get("pageToken"))
        or _as_string(checkpoint.get("nextPageToken"))
    )


def _polling_scope(input_value: Mapping[str, Any]) -> str:
    return _as_string(input_value.get("checkpointScope")) or (
        f"{_required_string(input_value, 'space')}#messages"
    )


def _polling_query(input_value: Mapping[str, Any]) -> JsonObject:
    query: JsonObject = {"pageSize": _page_size(input_value)}
    token = _page_token(input_value)
    filter_text = _build_polling_filter(input_value)
    show_deleted = _as_bool(input_value.get("showDeleted"))

    if token:
        query["pageToken"] = token
    if filter_text:
        query["filter"] = filter_text
    query["orderBy"] = _order_by(input_value)
    if show_deleted is not None:
        query["showDeleted"] = show_deleted
    return query


def _capability(input_value: Mapping[str, Any], mode: str) -> JsonObject:
    if mode == "direct_interaction":
        return {
            "authMode": "chat_interaction",
            "requiredScopes": [],
            "requiresAdminApproval": False,
            "requiresMembership": False,
            "readOnly": True,
            "writeCapable": False,
            "notes": [
                "Direct interaction ingestion uses the Chat app endpoint and does not call Google APIs by itself."
            ],
        }

    auth = _auth_mode(input_value)
    if mode == "polling":
        return {
            "authMode": auth,
            "requiredScopes": [
                CHAT_APP_MESSAGES_READONLY_SCOPE
                if auth == "app"
                else CHAT_MESSAGES_READONLY_SCOPE
            ],
            "requiresAdminApproval": auth == "app",
            "requiresMembership": True,
            "readOnly": True,
            "writeCapable": False,
            "notes": [
                "App-auth polling requires administrator approval and only returns public messages."
                if auth == "app"
                else "User-auth polling reads messages visible to the installing user."
            ],
        }

    return {
        "authMode": auth,
        "requiredScopes": [WORKSPACE_EVENTS_SCOPE, PUBSUB_SCOPE],
        "requiresAdminApproval": auth == "app",
        "requiresMembership": True,
        "readOnly": True,
        "writeCapable": False,
        "notes": [
            "App-auth Workspace Events subscriptions require one-time administrator approval."
            if auth == "app"
            else "User-auth Workspace Events subscriptions observe resources visible to the user."
        ],
    }


def _setup_checks(input_value: Mapping[str, Any]) -> list[JsonObject]:
    return [
        {
            "name": "workspace_events_api_enabled",
            "status": "planned",
            "remediation": "Enable workspaceevents.googleapis.com in the Cloud project.",
        },
        {
            "name": "pubsub_topic",
            "status": "configured" if _as_string(input_value.get("pubsubTopic")) else "missing",
            "remediation": "Create a Pub/Sub topic for Workspace Events delivery.",
        },
        {
            "name": "pubsub_publisher_iam",
            "status": "planned",
            "principal": CHAT_EVENTS_PUBLISHER_PRINCIPAL,
            "remediation": (
                "Grant Pub/Sub Publisher on the topic to the Google Chat event publisher principal."
            ),
        },
        {
            "name": "workspace_events_subscription",
            "status": "planned",
            "remediation": (
                "Create a Workspace Events subscription with the chosen target resource and event types."
            ),
        },
        {
            "name": "subscription_lifecycle",
            "status": "planned",
            "remediation": "Renew expiring subscriptions and reactivate suspended subscriptions.",
        },
    ]


def _backoff(input_value: Mapping[str, Any]) -> JsonObject:
    raw = _as_mapping(input_value.get("backoff")) or {}
    return {
        "initialMs": _as_number(raw.get("initialMs")) or 1000,
        "maxMs": _as_number(raw.get("maxMs")) or 60000,
        "multiplier": _as_number(raw.get("multiplier")) or 2,
        "jitter": _as_bool(raw.get("jitter")) if _as_bool(raw.get("jitter")) is not None else True,
    }


def plan_chat_ingestion(input_value: Mapping[str, Any]) -> JsonObject:
    mode = _as_string(input_value.get("mode")) or "direct_interaction"
    cap = _capability(input_value, mode)

    if mode == "direct_interaction":
        return {
            "kind": "chat.ingestion_plan",
            "mode": mode,
            "status": "planned",
            "capability": cap,
            "delivery": {
                "transport": "chat_http",
                "endpointPath": _as_string(input_value.get("endpointPath"))
                or "/api/chat/events",
                "responseMode": "sync_then_optional_async",
            },
            "requests": [],
            "checkpoint": None,
            "safety": {
                "liveAllowed": False,
                "writesMessages": False,
                "notes": [
                    "Normalize delivered Chat interaction events before application routing."
                ],
            },
            "warnings": [],
        }

    if mode in {"workspace_events_push", "workspace_events_pull"}:
        event_types = _string_list(input_value.get("eventTypes"), DEFAULT_EVENT_TYPES)
        topic = _as_string(input_value.get("pubsubTopic"))
        subscription = _as_string(input_value.get("pubsubSubscription"))
        include_resource = _as_bool(input_value.get("includeResource")) or False
        endpoint = _as_string(input_value.get("pushEndpoint"))
        requests: list[JsonObject] = [
            {
                "resource": "workspaceevents.subscriptions.create",
                "method": "POST",
                "path": "/v1/subscriptions",
                "body": {
                    "targetResource": _target_resource(input_value),
                    "eventTypes": event_types,
                    "notificationEndpoint": {"pubsubTopic": topic} if topic else None,
                    "payloadOptions": {"includeResource": include_resource},
                },
            }
        ]
        if mode == "workspace_events_pull" and subscription:
            requests.append(
                {
                    "resource": "pubsub.subscriptions.pull",
                    "method": "POST",
                    "path": f"/v1/{subscription}:pull",
                    "body": {
                        "maxMessages": _as_number(input_value.get("maxMessages")) or 10,
                        "returnImmediately": False,
                    },
                }
            )

        return {
            "kind": "chat.ingestion_plan",
            "mode": mode,
            "status": "planned",
            "capability": cap,
            "targetResource": _target_resource(input_value),
            "eventTypes": event_types,
            "includeResource": include_resource,
            "pubsub": {
                "topic": topic,
                "subscription": subscription,
                "publisherPrincipal": CHAT_EVENTS_PUBLISHER_PRINCIPAL,
            },
            "delivery": {
                "transport": "pubsub_push",
                "endpoint": endpoint,
                "parser": "parsePubSubPushPayload",
            }
            if mode == "workspace_events_push"
            else {
                "transport": "pubsub_pull",
                "subscription": subscription,
                "parser": "parsePubSubPullPayload",
            },
            "setupChecks": _setup_checks(input_value),
            "requests": requests,
            "checkpoint": {
                "type": "pubsub",
                "scope": subscription or topic or _target_resource(input_value),
                "cursor": _as_string(_checkpoint_input(input_value).get("cursor")),
            },
            "safety": {
                "liveAllowed": False,
                "writesMessages": False,
                "notes": [
                    "Workspace Events setup is planned only; creating subscriptions or IAM bindings must be explicitly gated."
                ],
            },
            "warnings": []
            if include_resource
            else [
                "includeResource is false, so delivered events may require follow-up Chat API reads."
            ],
        }

    if mode != "polling":
        raise TypeError(f"Unsupported ingestion mode: {mode}")

    space = _required_string(input_value, "space")
    query = _polling_query(input_value)
    return {
        "kind": "chat.ingestion_plan",
        "mode": mode,
        "status": "planned",
        "capability": cap,
        "polling": {
            "space": space,
            "thread": _as_string(input_value.get("thread")),
            "pageSize": query["pageSize"],
            "filter": _build_polling_filter(input_value),
            "orderBy": query["orderBy"],
            "showDeleted": _as_bool(input_value.get("showDeleted")) or False,
            "backoff": _backoff(input_value),
        },
        "requests": [
            {
                "resource": "spaces.messages.list",
                "method": "GET",
                "path": f"/v1/{space}/messages",
                "query": query,
                "body": None,
            }
        ],
        "checkpoint": {
            "type": "polling",
            "scope": _polling_scope(input_value),
            "cursor": _as_string(_checkpoint_input(input_value).get("cursor")),
            "pageToken": _page_token(input_value),
            "highWatermarkTime": _as_string(
                _checkpoint_input(input_value).get("highWatermarkTime")
            ),
        },
        "idempotency": {
            "duplicateStrategy": "skip_seen_polling_snapshots",
            "keyFields": ["message.name", "lastUpdateTime", "deleteTime", "createTime"],
        },
        "safety": {
            "liveAllowed": False,
            "writesMessages": False,
            "notes": [
                "Polling is read-only and should target spaces the principal can already read."
            ],
        },
        "warnings": [
            "Polling emits snapshots, not authoritative real-time create/update/delete events."
        ],
    }


def _identity_summary(value: Any) -> JsonObject | None:
    raw = _as_mapping(value)
    if not raw:
        return None
    return {
        "name": _as_string(raw.get("name")),
        "displayName": _as_string(raw.get("displayName")),
        "email": _as_string(raw.get("email")),
        "type": _as_string(raw.get("type")),
        "access": _as_string(raw.get("access")),
    }


def _space_summary(value: Any) -> JsonObject | None:
    raw = _as_mapping(value)
    if not raw:
        return None
    return {
        "name": _as_string(raw.get("name")),
        "displayName": _as_string(raw.get("displayName")),
        "type": _as_string(raw.get("type")),
    }


def _thread_summary(value: Any) -> JsonObject | None:
    raw = _as_mapping(value)
    return {"name": _as_string(raw.get("name"))} if raw else None


def _message_summary(value: Any) -> JsonObject | None:
    raw = _as_mapping(value)
    if not raw:
        return None
    state = _as_mapping(raw.get("state"))
    return {
        "name": _as_string(raw.get("name")),
        "text": _as_string(raw.get("text")),
        "plainTextForModel": _as_string(raw.get("plainTextForModel")),
        "createTime": _as_string(raw.get("createTime")),
        "sender": _identity_summary(raw.get("sender")),
        "thread": _thread_summary(raw.get("thread")),
        "state": {
            "deleted": (_as_bool(state.get("deleted")) if state else None) or False,
            "threadReply": (_as_bool(state.get("threadReply")) if state else None)
            or False,
            "directMessage": (_as_bool(state.get("directMessage")) if state else None)
            or False,
        }
        if state
        else None,
    }


def _normalized_event_summary(event: Mapping[str, Any]) -> JsonObject:
    relationship = _as_mapping(event.get("relationship"))
    return {
        "eventId": _as_string(event.get("eventId")),
        "kind": _as_string(event.get("kind")),
        "source": _as_string(event.get("source")),
        "receivedAt": _as_string(event.get("receivedAt")),
        "actor": _identity_summary(event.get("actor")),
        "space": _space_summary(event.get("space")),
        "message": _message_summary(event.get("message")),
        "relationship": {
            "isThreadReply": (_as_bool(relationship.get("isThreadReply")) if relationship else None)
            or False,
            "isDeletion": (_as_bool(relationship.get("isDeletion")) if relationship else None)
            or False,
            "systemNotes": [
                item
                for item in _as_list(relationship.get("systemNotes") if relationship else None)
                if isinstance(item, str)
            ],
        }
        if relationship
        else None,
    }


def _effective_snapshot_time(message: Mapping[str, Any]) -> str | None:
    return (
        _as_string(message.get("lastUpdateTime"))
        or _as_string(message.get("deleteTime"))
        or _as_string(message.get("createTime"))
    )


def _snapshot_kind(message: Mapping[str, Any]) -> str:
    if _as_string(message.get("deleteTime")) or _as_mapping(message.get("deletionMetadata")):
        return "deleted_snapshot"
    create_time = _as_string(message.get("createTime"))
    update_time = _as_string(message.get("lastUpdateTime"))
    if update_time and update_time != create_time:
        return "updated_snapshot"
    return "created_snapshot"


def _duplicate_key(message: Mapping[str, Any]) -> str:
    name = _as_string(message.get("name")) or "{unknownMessage}"
    time = _effective_snapshot_time(message) or "unknown"
    return f"polling:{name}:{time}"


def _parse_time(value: str | None) -> float:
    if not value:
        return float("-inf")
    normalized = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized).timestamp()
    except ValueError:
        return float("-inf")


def _max_timestamp(values: list[str | None]) -> str | None:
    best: str | None = None
    best_value = float("-inf")
    for value in values:
        parsed = _parse_time(value)
        if value and parsed > best_value:
            best = value
            best_value = parsed
    return best


def _polling_event_from_message(
    message: Mapping[str, Any],
    space: str,
    received_at: str | None,
) -> JsonObject:
    event_time = _effective_snapshot_time(message) or received_at
    return normalize_event(
        {
            "type": "MESSAGE",
            "eventTime": event_time,
            "message": dict(message),
            "user": _as_mapping(message.get("sender")),
            "space": _as_mapping(message.get("space")) or {"name": space},
        },
        source="fixture",
        received_at=received_at,
    )


def process_polling_ingestion_page(input_value: Mapping[str, Any]) -> JsonObject:
    space = _required_string(input_value, "space")
    response = _as_mapping(input_value.get("response")) or input_value
    messages = [
        item for item in _as_list(response.get("messages")) if isinstance(item, Mapping)
    ]
    checkpoint = _checkpoint_input(input_value)
    seen_keys_list = [
        item for item in _as_list(checkpoint.get("seenKeys")) if isinstance(item, str)
    ]
    seen_keys = set(seen_keys_list)
    received_at = _as_string(input_value.get("receivedAt"))
    events: list[JsonObject] = []

    for index, message in enumerate(messages):
        key = _duplicate_key(message)
        normalized = _normalized_event_summary(
            _polling_event_from_message(message, space, received_at)
        )
        skipped_as_duplicate = key in seen_keys
        if not skipped_as_duplicate:
            seen_keys.add(key)
            seen_keys_list.append(key)
        events.append(
            {
                "kind": "chat.ingestion_event",
                "source": "polling",
                "sequence": index,
                "normalized": normalized,
                "snapshot": {
                    "kind": _snapshot_kind(message),
                    "messageName": _as_string(message.get("name")),
                    "effectiveTime": _effective_snapshot_time(message),
                    "duplicateKey": key,
                    "skippedAsDuplicate": skipped_as_duplicate,
                },
            }
        )

    next_page_token = _as_string(response.get("nextPageToken"))
    high_watermark_time = _max_timestamp(
        [_effective_snapshot_time(message) for message in messages]
    ) or _as_string(checkpoint.get("highWatermarkTime"))
    next_seen_keys = seen_keys_list
    checkpoint_out = {
        "type": "polling",
        "scope": _polling_scope(input_value),
        "cursor": next_page_token or high_watermark_time,
        "pageToken": next_page_token,
        "nextPageToken": next_page_token,
        "highWatermarkTime": high_watermark_time,
        "seenKeys": next_seen_keys,
    }
    next_request = (
        plan_chat_ingestion(
            {
                **dict(input_value),
                "mode": "polling",
                "response": None,
                "checkpoint": {
                    **dict(checkpoint),
                    "pageToken": next_page_token,
                    "nextPageToken": next_page_token,
                    "highWatermarkTime": high_watermark_time,
                    "seenKeys": next_seen_keys,
                },
            }
        )
        if next_page_token
        else None
    )

    return {
        "kind": "chat.ingestion_batch",
        "mode": "polling",
        "source": "spaces.messages.list",
        "space": space,
        "receivedAt": received_at,
        "events": events,
        "checkpoint": checkpoint_out,
        "pagination": {
            "nextPageToken": next_page_token,
            "hasMore": bool(next_page_token),
            "resultCount": len(events),
        },
        "idempotency": {
            "duplicateStrategy": "skip_seen_polling_snapshots",
            "skippedCount": len(
                [item for item in events if item["snapshot"]["skippedAsDuplicate"]]
            ),
        },
        "nextRequest": next_request,
        "systemNotes": [
            f"System Note: Polling read {len(events)} message snapshot(s) from {space}.",
            "System Note: Polling snapshots can lag real-time Chat events and should be deduplicated before side effects.",
        ],
    }


__all__ = [
    "CHAT_APP_MESSAGES_READONLY_SCOPE",
    "CHAT_EVENTS_PUBLISHER_PRINCIPAL",
    "CHAT_MESSAGES_READONLY_SCOPE",
    "PUBSUB_SCOPE",
    "WORKSPACE_EVENTS_SCOPE",
    "plan_chat_ingestion",
    "process_polling_ingestion_page",
]
