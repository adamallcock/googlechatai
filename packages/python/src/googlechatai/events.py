"""Normalization helpers for Google Chat event payloads."""

from __future__ import annotations

import base64
import json
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

from .actions import normalize_action
from .message_ast import normalize_message as normalize_message_ast


RawMapping = Mapping[str, Any]


class InvalidChatEventError(TypeError):
    """Raised when a payload cannot be treated as a Google Chat event."""


def _as_mapping(value: Any) -> RawMapping | None:
    return value if isinstance(value, Mapping) else None


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _default_transport(kind: str) -> dict[str, Any]:
    return {
        "kind": kind,
        "pubsubMessageId": None,
        "pubsubPublishTime": None,
        "pubsubSubscription": None,
        "pubsubDeliveryAttempt": None,
        "workspaceEventId": None,
        "workspaceEventType": None,
        "workspaceEventSource": None,
        "workspaceEventSubject": None,
    }


def _decode_base64_json(data: str) -> dict[str, Any] | None:
    try:
        decoded = json.loads(base64.b64decode(data).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None

    return dict(decoded) if isinstance(decoded, Mapping) else None


def _is_workspace_event_type(value: str | None) -> bool:
    return bool(value and value.startswith("google.workspace.chat."))


def _workspace_event_from_cloud_event(raw: RawMapping) -> dict[str, Any]:
    data = _as_mapping(raw.get("data")) or {}
    return {
        "type": raw.get("type"),
        "eventTime": raw.get("time"),
        "id": raw.get("id"),
        "source": raw.get("source"),
        "subject": raw.get("subject"),
        "data": data,
        "message": data.get("message"),
        "reaction": data.get("reaction"),
        "membership": data.get("membership"),
        "space": data.get("space"),
        "user": data.get("user"),
    }


def _unwrap_event(
    raw: RawMapping,
    *,
    source: str | None,
) -> tuple[dict[str, Any], str, dict[str, Any]]:
    pubsub_message = _as_mapping(raw.get("message"))
    pubsub_data = _as_string(pubsub_message.get("data")) if pubsub_message else None

    if pubsub_message and pubsub_data:
        attributes = _as_mapping(pubsub_message.get("attributes")) or {}
        cloud_event_type = _as_string(attributes.get("ce-type"))
        decoded = _decode_base64_json(pubsub_data) or {}
        is_workspace = _is_workspace_event_type(cloud_event_type)
        event = (
            {
                "type": cloud_event_type,
                "eventTime": _as_string(attributes.get("ce-time"))
                or _as_string(pubsub_message.get("publishTime")),
                "id": _as_string(attributes.get("ce-id")),
                "source": _as_string(attributes.get("ce-source")),
                "subject": _as_string(attributes.get("ce-subject")),
                "data": decoded,
                "message": decoded.get("message"),
                "reaction": decoded.get("reaction"),
                "membership": decoded.get("membership"),
                "space": decoded.get("space"),
                "user": decoded.get("user"),
            }
            if is_workspace
            else decoded
        )
        inferred_source = "workspace_events" if is_workspace else "pubsub"
        transport = {
            **_default_transport("workspace_events" if is_workspace else "pubsub"),
            "pubsubMessageId": _as_string(pubsub_message.get("messageId")),
            "pubsubPublishTime": _as_string(pubsub_message.get("publishTime")),
            "pubsubSubscription": _as_string(raw.get("subscription")),
            "pubsubDeliveryAttempt": _as_string(
                attributes.get("googclient_deliveryattempt")
            ),
            "workspaceEventId": _as_string(attributes.get("ce-id"))
            if is_workspace
            else None,
            "workspaceEventType": cloud_event_type if is_workspace else None,
            "workspaceEventSource": _as_string(attributes.get("ce-source"))
            if is_workspace
            else None,
            "workspaceEventSubject": _as_string(attributes.get("ce-subject"))
            if is_workspace
            else None,
        }
        return dict(event), source or inferred_source, transport

    raw_kind = _as_string(raw.get("type"))
    if _is_workspace_event_type(raw_kind) and _as_mapping(raw.get("data")):
        return (
            _workspace_event_from_cloud_event(raw),
            source or "workspace_events",
            {
                **_default_transport("workspace_events"),
                "workspaceEventId": _as_string(raw.get("id")),
                "workspaceEventType": raw_kind,
                "workspaceEventSource": _as_string(raw.get("source")),
                "workspaceEventSubject": _as_string(raw.get("subject")),
            },
        )

    return dict(raw), source or "chat_http", _default_transport("direct")


def _normalize_user(value: Any) -> dict[str, Any] | None:
    raw = _as_mapping(value)
    name = (
        _as_string(raw.get("name")) or _as_string(raw.get("resourceName"))
        if raw
        else None
    )

    if not raw or not name:
        return None

    display_name = _as_string(raw.get("displayName"))
    email = _as_string(raw.get("email")) or _as_string(raw.get("emailAddress"))
    user_type = _as_string(raw.get("type"))
    is_app = user_type in {"BOT", "APP"} or raw.get("isBot") is True
    raw_access_state = _as_string(raw.get("accessState"))
    if raw_access_state in {"resource_only", "unknown"}:
        access = {
            "status": "access_limited",
            "reason": "display_name_or_email_unavailable",
        }
    elif raw_access_state == "anonymous":
        access = {"status": "access_limited", "reason": "anonymous_user"}
    elif display_name or email:
        access = {"status": "available", "reason": None}
    else:
        access = {
            "status": "access_limited",
            "reason": "display_name_or_email_unavailable",
        }

    return {
        "name": name,
        "displayName": display_name,
        "email": email,
        "type": user_type,
        "isApp": is_app,
        "access": access,
    }


def _normalize_space(value: Any) -> dict[str, Any] | None:
    raw = _as_mapping(value)
    name = _as_string(raw.get("name")) if raw else None

    if not raw or not name:
        return None

    return {
        "name": name,
        "displayName": _as_string(raw.get("displayName")),
        "type": _as_string(raw.get("type")),
        "spaceType": _as_string(raw.get("spaceType")),
    }


def _normalize_thread(value: Any) -> dict[str, str | None] | None:
    raw = _as_mapping(value)
    name = _as_string(raw.get("name")) if raw else None
    return {"name": name, "threadKey": _as_string(raw.get("threadKey"))} if name else None


def _normalize_message(value: Any) -> dict[str, Any] | None:
    raw = _as_mapping(value)
    name = _as_string(raw.get("name")) if raw else None

    if not raw or not name:
        return None

    return normalize_message_ast(raw)


def _normalize_reaction(value: Any) -> dict[str, Any] | None:
    raw = _as_mapping(value)
    name = _as_string(raw.get("name")) if raw else None

    if not raw or not name:
        return None

    emoji = _as_mapping(raw.get("emoji")) or {}
    message_name = _as_string(raw.get("message"))

    return {
        "ref": {"name": name},
        "user": _normalize_user(raw.get("user")),
        "emoji": {
            "unicode": _as_string(emoji.get("unicode")),
            "customEmoji": _as_mapping(emoji.get("customEmoji")),
        },
        "messageRef": {"name": message_name} if message_name else None,
        "createdAt": _as_string(raw.get("createTime")),
        "deletedAt": _as_string(raw.get("deleteTime")),
    }


def _normalize_membership(value: Any) -> dict[str, Any] | None:
    raw = _as_mapping(value)
    name = _as_string(raw.get("name")) if raw else None

    if not raw or not name:
        return None

    return {
        "ref": {"name": name},
        "state": _as_string(raw.get("state")),
        "member": _normalize_user(raw.get("member")),
        "createdAt": _as_string(raw.get("createTime")),
        "deletedAt": _as_string(raw.get("deleteTime")),
    }


def _normalize_dialog(event: RawMapping) -> dict[str, Any] | None:
    event_type = _as_string(event.get("dialogEventType"))
    return {"eventType": event_type} if event_type else None


def _space_is_direct(space: dict[str, Any] | None) -> bool:
    return bool(
        space
        and (space.get("type") == "DM" or space.get("spaceType") == "DIRECT_MESSAGE")
    )


def _message_mentions_app(message: dict[str, Any] | None) -> bool:
    if not message:
        return False

    for annotation in message.get("annotations", []):
        if not isinstance(annotation, Mapping) or annotation.get("kind") != "userMention":
            continue

        user = _as_mapping(annotation.get("user")) or {}
        if user.get("type") in {"BOT", "APP"}:
            return True

    return False


def _classify_event(
    raw_kind: str | None,
    raw_message: RawMapping | None,
    message: dict[str, Any] | None,
    space: dict[str, Any] | None,
) -> str:
    if raw_kind == "MESSAGE":
        if _as_mapping(raw_message.get("slashCommand")) if raw_message else None:
            return "message.slash_command"
        if (message and message.get("state", {}).get("directMessage")) or _space_is_direct(space):
            return "message.direct"
        if _message_mentions_app(message):
            return "message.mentioned_app"
        if message and message.get("state", {}).get("threadReply"):
            return "message.thread_reply"
        return "message.created"

    if raw_kind == "APP_COMMAND":
        return "message.app_command"
    if raw_kind == "ADDED_TO_SPACE":
        return "space.added"
    if raw_kind == "REMOVED_FROM_SPACE":
        return "space.removed"
    if raw_kind == "CARD_CLICKED":
        return "card.clicked"
    if raw_kind == "WIDGET_UPDATED":
        return "widget.updated"

    return {
        "google.workspace.chat.message.v1.created": "message.created",
        "google.workspace.chat.message.v1.updated": "message.updated",
        "google.workspace.chat.message.v1.deleted": "message.deleted",
        "google.workspace.chat.reaction.v1.created": "reaction.created",
        "google.workspace.chat.reaction.v1.deleted": "reaction.deleted",
        "google.workspace.chat.membership.v1.created": "membership.created",
        "google.workspace.chat.membership.v1.updated": "membership.updated",
        "google.workspace.chat.membership.v1.deleted": "membership.deleted",
        "google.workspace.chat.space.v1.updated": "space.updated",
        "google.workspace.chat.space.v1.deleted": "space.deleted",
    }.get(raw_kind, "event.unknown")


def _refine_card_kind(kind: str, event: RawMapping) -> str:
    if kind != "card.clicked":
        return kind

    return {
        "REQUEST_DIALOG": "dialog.opened",
        "SUBMIT_DIALOG": "dialog.submitted",
        "CANCEL_DIALOG": "dialog.cancelled",
    }.get(_as_string(event.get("dialogEventType")), kind)


def _resource_name_for(
    message: dict[str, Any] | None,
    reaction: dict[str, Any] | None,
    membership: dict[str, Any] | None,
    space: dict[str, Any] | None,
    action: dict[str, Any] | None,
) -> str | None:
    if message:
        return message["ref"]["name"]
    if reaction:
        return reaction["ref"]["name"]
    if membership:
        return membership["ref"]["name"]
    if space:
        return space["name"]
    if action:
        return _as_string(action.get("actionId"))
    return None


def _event_id_for(
    source: str,
    raw_kind: str | None,
    resource_name: str | None,
    received_at: str,
    transport: RawMapping,
) -> str:
    if source == "pubsub" and transport.get("pubsubMessageId"):
        return f"pubsub:{transport['pubsubMessageId']}"
    if source == "workspace_events" and transport.get("workspaceEventId"):
        return f"workspace_events:{transport['workspaceEventId']}"
    return f"{source}:{raw_kind or 'UNKNOWN'}:{resource_name or 'no-resource'}:{received_at}"


def _normalize_locale(event: RawMapping) -> str | None:
    common = _as_mapping(event.get("common"))
    return (
        _as_string(common.get("userLocale")) or _as_string(common.get("locale"))
        if common
        else None
    )


def _normalize_time_zone(event: RawMapping) -> str | None:
    common = _as_mapping(event.get("common"))
    time_zone = _as_mapping(common.get("timeZone")) if common else None
    return (
        _as_string(time_zone.get("id"))
        if time_zone
        else (_as_string(common.get("timeZone")) if common else None)
    )


def _auth_context_for(source: str) -> dict[str, Any]:
    return {
        "authType": None,
        "scopes": [],
        "responseMode": "sync"
        if source in {"chat_http", "fixture"}
        else "async"
        if source == "pubsub"
        else "none",
    }


def _capabilities_for(
    source: str,
    kind: str,
    thread: dict[str, Any] | None,
) -> dict[str, Any]:
    is_sync = source in {"chat_http", "fixture"}
    is_card_interaction = kind in {
        "card.clicked",
        "dialog.opened",
        "dialog.submitted",
        "dialog.cancelled",
        "widget.updated",
    }

    return {
        "canRespondSynchronously": is_sync,
        "canRespondAsynchronously": source == "pubsub" or is_sync,
        "canReplyInThread": thread is not None,
        "canOpenDialog": is_sync and kind == "card.clicked",
        "canUpdateCard": is_sync and is_card_interaction,
    }


def _actor_label(actor: dict[str, Any] | None) -> str:
    if not actor:
        return "Unknown actor"
    return actor.get("displayName") or actor.get("email") or actor["name"]


def _space_label(space: dict[str, Any] | None) -> str:
    if not space:
        return "an unknown space"
    return space.get("displayName") or space["name"]


def _system_notes_for(
    kind: str,
    actor: dict[str, Any] | None,
    space: dict[str, Any] | None,
    action: dict[str, Any] | None,
    reaction: dict[str, Any] | None,
) -> list[str]:
    who = _actor_label(actor)
    where = _space_label(space)

    if kind == "message.slash_command":
        method = (action.get("methodName") if action else None) or "unknown"
        return [f"{who} invoked slash command {method}."]
    if kind == "message.app_command":
        method = (action.get("methodName") if action else None) or "unknown"
        return [f"{who} invoked app command {method}."]
    if kind == "message.direct":
        return [f"{who} sent a direct message."]
    if kind == "message.thread_reply":
        return [f"{who} sent a thread reply in {where}."]
    if kind == "message.updated":
        return [f"A message in {where} was edited."]
    if kind == "message.deleted":
        return [f"A message in {where} was deleted."]
    if kind == "space.added":
        return [f"The Chat app was added to {where} by {who}."]
    if kind == "space.removed":
        return [f"The Chat app was removed from {where} by {who}."]
    if kind == "card.clicked":
        method = (action.get("methodName") if action else None) or "unknown"
        return [f"{who} clicked card action {method} in {where}."]
    if kind == "dialog.submitted":
        method = (action.get("methodName") if action else None) or "unknown"
        return [f"{who} submitted dialog action {method} in {where}."]
    if kind == "widget.updated":
        method = (action.get("methodName") if action else None) or "unknown"
        return [f"{who} updated widget {method} in {where}."]
    if kind in {"reaction.created", "reaction.deleted"}:
        emoji = (
            reaction.get("emoji", {}).get("unicode")
            if reaction and isinstance(reaction.get("emoji"), Mapping)
            else None
        ) or "a reaction"
        verb = "added" if kind == "reaction.created" else "removed"
        return [f"{who} {verb} {emoji}."]
    if kind.startswith("membership."):
        return [f"Membership changed in {where}."]
    if kind == "message.created":
        return [f"{who} sent a message in {where}."]

    return []


def _relationship_for(
    kind: str,
    message: dict[str, Any] | None,
    action: dict[str, Any] | None,
    reaction: dict[str, Any] | None,
    actor: dict[str, Any] | None,
    space: dict[str, Any] | None,
) -> dict[str, Any]:
    is_card_action = kind in {
        "card.clicked",
        "dialog.opened",
        "dialog.submitted",
        "dialog.cancelled",
        "widget.updated",
    }
    context_node = _as_mapping((message or {}).get("contextNode"))
    quoted_message = None
    for child in (context_node or {}).get("children", []):
        if isinstance(child, Mapping) and child.get("relationship") == "quoted_message":
            quoted_message = child
            break
    quoted_message_ref = _as_mapping((quoted_message or {}).get("ref"))

    return {
        "isQuote": bool(quoted_message),
        "isDirectReply": bool(
            quoted_message
            and (
                _as_string((quoted_message_ref or {}).get("name"))
                or quoted_message.get("name")
            )
        ),
        "isThreadReply": bool(message and message.get("state", {}).get("threadReply")),
        "isCardAction": is_card_action,
        "isReaction": kind in {"reaction.created", "reaction.deleted"},
        "isEdit": kind == "message.updated",
        "isDeletion": kind == "message.deleted"
        or bool(message and message.get("state", {}).get("deleted")),
        "isMembershipEvent": kind.startswith("membership."),
        "isSpaceEvent": kind.startswith("space."),
        "isUserAction": bool(action)
        or kind.startswith("message.")
        or kind.startswith("reaction."),
        "systemNotes": _system_notes_for(kind, actor, space, action, reaction),
    }


def _actor_candidate_for(
    source: str,
    event: RawMapping,
    message: dict[str, Any] | None,
    reaction: dict[str, Any] | None,
    membership: dict[str, Any] | None,
) -> Any:
    if source == "workspace_events":
        return (
            (reaction or {}).get("user")
            or (membership or {}).get("member")
            or (message or {}).get("sender")
            or event.get("user")
        )

    return event.get("user") or ((message or {}).get("sender"))


def normalize_event(
    input_event: RawMapping,
    *,
    source: str | None = None,
    received_at: str | None = None,
) -> dict[str, Any]:
    """Normalize a Google Chat event payload into the shared event envelope."""

    if not isinstance(input_event, Mapping):
        raise InvalidChatEventError("Expected a Google Chat event object.")

    event, event_source, transport = _unwrap_event(input_event, source=source)
    raw_kind = _as_string(event.get("type"))
    raw_message = _as_mapping(event.get("message"))
    message = _normalize_message(raw_message)
    reaction = _normalize_reaction(event.get("reaction"))
    membership = _normalize_membership(event.get("membership"))
    space = _normalize_space(event.get("space") or ((raw_message or {}).get("space")))
    thread = message["thread"] if message else _normalize_thread(event.get("thread"))
    action = normalize_action(event, source=event_source)
    kind = (
        "widget.updated"
        if action and action.get("actionType") == "widget_update"
        else _refine_card_kind(
            _classify_event(raw_kind, raw_message, message, space),
            event,
        )
    )
    actor_candidate = _actor_candidate_for(
        event_source,
        event,
        message,
        reaction,
        membership,
    )
    actor = _normalize_user(actor_candidate)
    event_received_at = (
        received_at
        or _as_string(event.get("eventTime"))
        or _as_string(event.get("time"))
        or _as_string(transport.get("pubsubPublishTime"))
        or datetime.fromtimestamp(0, timezone.utc).isoformat().replace("+00:00", "Z")
    )
    resource_name = _resource_name_for(message, reaction, membership, space, action)
    event_id = _event_id_for(
        event_source,
        raw_kind,
        resource_name,
        event_received_at,
        transport,
    )

    return {
        "eventId": event_id,
        "receivedAt": event_received_at,
        "source": event_source,
        "kind": kind,
        "rawKind": raw_kind,
        "actor": actor,
        "actorState": actor["access"]
        if actor
        else {
            "status": "missing",
            "reason": "workspace_event_missing_actor"
            if event_source == "workspace_events"
            else "event_payload_missing_user",
        },
        "space": space,
        "thread": thread,
        "message": message,
        "action": action,
        "dialog": _normalize_dialog(event),
        "membership": membership,
        "reaction": reaction,
        "locale": _normalize_locale(event),
        "timeZone": _normalize_time_zone(event),
        "authContext": _auth_context_for(event_source),
        "capabilities": _capabilities_for(event_source, kind, thread),
        "relationship": _relationship_for(kind, message, action, reaction, actor, space),
        "transport": transport,
        "idempotencyKey": event_id,
        "raw": input_event,
    }
