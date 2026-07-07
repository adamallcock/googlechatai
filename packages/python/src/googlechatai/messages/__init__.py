"""Dry-run Google Chat message call planners."""

from __future__ import annotations

import math
import re
import json
import random
import uuid
from collections.abc import Mapping
from typing import Any


JsonObject = dict[str, Any]
APP_SCOPE = "https://www.googleapis.com/auth/chat.bot"
DRY_RUN_NOTE = "Dry run only; no Google Chat API call was executed."
DM_DRY_RUN_NOTE = "Direct messages are planned only; W9 never executes DM operations."
PATCH_FIELD_ORDER = ["text", "cardsV2", "accessoryWidgets"]
DEFAULT_STREAM_THROTTLE_MS = 1000
DEFAULT_STREAM_MIN_PATCH_CHARS = 120
DEFAULT_STREAM_MAX_PATCHES = 20
DEFAULT_SYNC_DEADLINE_MS = 30_000
DEFAULT_ASYNC_SAFETY_MARGIN_MS = 5_000
DEFAULT_ASYNC_ERROR_TEXT = "Sorry, something went wrong while preparing the response."
DEFAULT_PLACEHOLDER_TEXTS = [
    "Thinking...",
    "Checking the thread...",
    "Reviewing context...",
]
PLACEHOLDER_SELECTION_MODES = ["first", "roundRobin", "random"]
PLACEHOLDER_HANDLE_KIND = "chat.placeholder_response_handle"
PLACEHOLDER_ALLOWED_UPDATE_MASKS = ["text", "cardsV2", "accessoryWidgets"]
DEFAULT_REPLY_MESSAGE_OPTION = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"
REPLY_MESSAGE_OPTIONS = [
    "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
    "REPLY_MESSAGE_OR_FAIL",
]
REPLY_STRATEGIES = ["mimic", "thread", "topLevel"]
REPLY_ROUTE_MODES = ["thread", "topLevel"]
MISSING_THREAD_MODES = ["threadKey", "topLevel", "fail"]


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _as_number(value: Any) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _as_bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _positive_number(value: Any, fallback: int) -> int | float:
    number = _as_number(value)
    return number if number is not None and number > 0 else fallback


def _non_negative_number(value: Any, fallback: int) -> int | float:
    number = _as_number(value)
    return number if number is not None and number >= 0 else fallback


def _required_string(input_value: Mapping[str, Any], key: str) -> str:
    value = _as_string(input_value.get(key))
    if not value:
        raise TypeError(f"Expected {key} to be a non-empty string.")
    return value


def _auth_mode(input_value: Mapping[str, Any]) -> str:
    return _as_string(input_value.get("authMode")) or "app"


def _capability(
    input_value: Mapping[str, Any],
    ok: bool = True,
    reasons: list[str] | None = None,
) -> JsonObject:
    return {
        "ok": ok,
        "authMode": _auth_mode(input_value),
        "requiredScopes": [APP_SCOPE],
        "reasons": reasons or [],
    }


def _idempotency(request_id: str | None, client_message_id: str | None) -> JsonObject:
    return {
        "requestId": request_id,
        "clientMessageId": client_message_id,
    }


def _safety(direct_message: bool) -> JsonObject:
    return {
        "liveAllowed": False,
        "directMessage": direct_message,
        "notes": [DRY_RUN_NOTE, DM_DRY_RUN_NOTE]
        if direct_message
        else [DRY_RUN_NOTE],
    }


def _call_plan(
    operation: str,
    input_value: Mapping[str, Any],
    requests: list[JsonObject],
    *,
    capability_ok: bool = True,
    capability_reasons: list[str] | None = None,
    request_id: str | None = None,
    client_message_id: str | None = None,
    direct_message: bool = False,
    warnings: list[str] | None = None,
    extra: JsonObject | None = None,
) -> JsonObject:
    plan: JsonObject = {
        "kind": "chat.call_plan",
        "operation": operation,
        "dryRun": True,
        "capability": _capability(
            input_value,
            capability_ok,
            capability_reasons,
        ),
        "requests": requests,
        "idempotency": _idempotency(request_id, client_message_id),
    }
    if extra:
        plan.update(extra)
    plan["safety"] = _safety(direct_message)
    plan["warnings"] = warnings or []
    return plan


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "id"


def generate_request_id(seed: str | None = None) -> str:
    return f"req-{_slugify(seed or str(uuid.uuid4()))}"


def generate_client_message_id(seed: str | None = None) -> str:
    return f"client-{_slugify(seed or str(uuid.uuid4()))}"


def _request_id_for(input_value: Mapping[str, Any], seed: str) -> str:
    return _as_string(input_value.get("requestId")) or generate_request_id(seed)


def _client_message_id_for(input_value: Mapping[str, Any], seed: str) -> str:
    return _as_string(input_value.get("clientMessageId")) or generate_client_message_id(seed)


def _chat_path(resource_name: str) -> str:
    return f"/v1/{resource_name}"


def _user_name_for_email(email: str) -> str:
    return email if email.startswith("users/") else f"users/{email}"


def _create_message_request(space: str, query: JsonObject, body: JsonObject) -> JsonObject:
    return {
        "resource": "spaces.messages.create",
        "method": "POST",
        "path": _chat_path(f"{space}/messages"),
        "query": query,
        "body": body,
    }


def _thread_body(input_value: Mapping[str, Any]) -> JsonObject | None:
    thread = _as_string(input_value.get("thread"))
    thread_key = _as_string(input_value.get("threadKey"))

    if thread and thread_key:
        raise TypeError("Expected only one of thread or threadKey.")
    if thread:
        return {"name": thread}
    if thread_key:
        return {"threadKey": thread_key}
    return None


def _thread_query(thread: Mapping[str, Any] | None) -> JsonObject:
    return (
        {"messageReplyOption": DEFAULT_REPLY_MESSAGE_OPTION}
        if thread is not None
        else {}
    )


def _as_mapping(value: Any) -> Mapping[str, Any] | None:
    return value if isinstance(value, Mapping) else None


def _nested_mapping(value: Mapping[str, Any], *keys: str) -> Mapping[str, Any] | None:
    current: Any = value
    for key in keys:
        current_mapping = _as_mapping(current)
        if current_mapping is None:
            return None
        current = current_mapping.get(key)
    return _as_mapping(current)


def _string_at(value: Mapping[str, Any], *keys: str) -> str | None:
    if not keys:
        return None
    parent = _nested_mapping(value, *keys[:-1])
    return _as_string(parent.get(keys[-1])) if parent is not None else None


def _bool_at(value: Mapping[str, Any], *keys: str) -> bool | None:
    if not keys:
        return None
    parent = _nested_mapping(value, *keys[:-1])
    return _as_bool(parent.get(keys[-1])) if parent is not None else None


def _reply_policy(input_value: Mapping[str, Any]) -> JsonObject:
    raw_policy = _as_mapping(input_value.get("replyRouting")) or _as_mapping(
        input_value.get("replyPolicy")
    ) or {}
    strategy = _as_string(raw_policy.get("strategy")) or "mimic"
    dm = _as_string(raw_policy.get("dm")) or "topLevel"
    room_top_level = _as_string(raw_policy.get("roomTopLevel")) or "thread"
    room_thread_reply = _as_string(raw_policy.get("roomThreadReply")) or "thread"
    missing_thread = _as_string(raw_policy.get("missingThread")) or "threadKey"
    message_reply_option = (
        _as_string(raw_policy.get("messageReplyOption")) or DEFAULT_REPLY_MESSAGE_OPTION
    )

    if strategy not in REPLY_STRATEGIES:
        raise TypeError(
            f"Expected replyRouting.strategy to be one of {', '.join(REPLY_STRATEGIES)}."
        )
    for field, value in (
        ("replyRouting.dm", dm),
        ("replyRouting.roomTopLevel", room_top_level),
        ("replyRouting.roomThreadReply", room_thread_reply),
    ):
        if value not in REPLY_ROUTE_MODES:
            raise TypeError(f"Expected {field} to be one of {', '.join(REPLY_ROUTE_MODES)}.")
    if missing_thread not in MISSING_THREAD_MODES:
        raise TypeError(
            "Expected replyRouting.missingThread to be one of "
            f"{', '.join(MISSING_THREAD_MODES)}."
        )
    if message_reply_option not in REPLY_MESSAGE_OPTIONS:
        raise TypeError(
            "Expected replyRouting.messageReplyOption to be one of "
            f"{', '.join(REPLY_MESSAGE_OPTIONS)}."
        )

    return {
        "strategy": strategy,
        "dm": dm,
        "roomTopLevel": room_top_level,
        "roomThreadReply": room_thread_reply,
        "missingThread": missing_thread,
        "messageReplyOption": message_reply_option,
    }


def _event_like(input_value: Mapping[str, Any]) -> Mapping[str, Any]:
    return _as_mapping(input_value.get("event")) or input_value


def _event_space(input_value: Mapping[str, Any], event: Mapping[str, Any]) -> str:
    space = (
        _as_string(input_value.get("space"))
        or _string_at(event, "space", "name")
        or _string_at(event, "message", "space", "name")
    )
    if not space:
        raise TypeError("Expected space or event.space.name to be a non-empty string.")
    return space


def _event_thread(input_value: Mapping[str, Any], event: Mapping[str, Any]) -> str | None:
    return (
        _as_string(input_value.get("thread"))
        or _string_at(event, "message", "thread", "name")
        or _string_at(event, "thread", "name")
    )


def _event_message_name(
    input_value: Mapping[str, Any], event: Mapping[str, Any]
) -> str | None:
    return (
        _as_string(input_value.get("messageName"))
        or _string_at(event, "message", "ref", "name")
        or _string_at(event, "message", "name")
    )


def _event_is_dm(input_value: Mapping[str, Any], event: Mapping[str, Any]) -> bool:
    space_type = (
        _as_string(input_value.get("spaceType"))
        or _string_at(event, "space", "type")
        or _string_at(event, "space", "spaceType")
        or _string_at(event, "message", "space", "type")
    )
    return (
        _bool_at(event, "message", "state", "directMessage") is True
        or _as_string(event.get("kind")) == "message.direct"
        or space_type in {"DM", "DIRECT_MESSAGE"}
    )


def _event_is_thread_reply(
    input_value: Mapping[str, Any],
    event: Mapping[str, Any],
    thread: str | None,
) -> bool:
    explicit = _as_bool(input_value.get("isThreadReply"))
    if explicit is not None:
        return explicit
    message_state_thread_reply = _bool_at(event, "message", "state", "threadReply")
    if message_state_thread_reply is not None:
        return message_state_thread_reply
    return (
        _as_string(event.get("kind")) == "message.thread_reply"
        or thread is not None
    )


def _target_thread_key(input_value: Mapping[str, Any], event: Mapping[str, Any]) -> str:
    explicit = _as_string(input_value.get("threadKey"))
    if explicit:
        return explicit
    seed = _event_message_name(input_value, event) or f"{_event_space(input_value, event)}-top-level"
    return f"chat-ai-sdk-reply-{_slugify(seed)}"


def _reply_target_result(
    input_value: Mapping[str, Any],
    *,
    conversation: str,
    route: str,
    space: str,
    policy: Mapping[str, Any],
    reason: str,
    thread_name: str | None = None,
    thread_key: str | None = None,
    warnings: list[str] | None = None,
) -> JsonObject:
    message_reply_option = (
        _as_string(policy.get("messageReplyOption")) if route == "thread" else None
    )
    return {
        "kind": "chat.reply_target",
        "status": "ready",
        "source": "event" if _as_mapping(input_value.get("event")) else "explicit",
        "policy": dict(policy),
        "conversation": conversation,
        "route": route,
        "space": space,
        "threadName": thread_name,
        "threadKey": thread_key,
        "messageReplyOption": message_reply_option,
        "reason": reason,
        "warnings": warnings or [],
        "systemNotes": [
            "System Note: Reply routing selected a thread reply target."
            if route == "thread"
            else "System Note: Reply routing selected a top-level message target."
        ],
    }


def _reply_target_for_missing_thread(
    input_value: Mapping[str, Any],
    event: Mapping[str, Any],
    policy: Mapping[str, Any],
    *,
    is_dm: bool,
    space: str,
    reason_prefix: str,
) -> JsonObject:
    missing_thread = _as_string(policy.get("missingThread"))
    if missing_thread == "fail":
        raise TypeError(
            "Reply routing selected a thread target, but the event did not include a thread name."
        )
    if missing_thread == "topLevel":
        return _reply_target_result(
            input_value,
            conversation="dm" if is_dm else "space",
            route="topLevel",
            space=space,
            policy=policy,
            reason=f"{reason_prefix}_missing_thread_top_level",
        )
    return _reply_target_result(
        input_value,
        conversation="dm" if is_dm else "space",
        route="thread",
        space=space,
        thread_key=_target_thread_key(input_value, event),
        policy=policy,
        reason=f"{reason_prefix}_thread_key",
        warnings=[
            "Event did not include a thread name; using a stable threadKey derived from the triggering message."
        ],
    )


def resolve_reply_target(input_value: Mapping[str, Any]) -> JsonObject:
    event = _event_like(input_value)
    policy = _reply_policy(input_value)
    space = _event_space(input_value, event)
    thread = _event_thread(input_value, event)
    is_dm = _event_is_dm(input_value, event)
    is_thread_reply = _event_is_thread_reply(input_value, event, thread)

    if _as_string(input_value.get("thread")) and _as_string(input_value.get("threadKey")):
        raise TypeError("Expected only one of thread or threadKey.")

    if _as_string(input_value.get("thread")):
        return _reply_target_result(
            input_value,
            conversation="dm" if is_dm else "space",
            route="thread",
            space=space,
            thread_name=_as_string(input_value.get("thread")),
            policy=policy,
            reason="explicit_thread",
        )
    if _as_string(input_value.get("threadKey")):
        return _reply_target_result(
            input_value,
            conversation="dm" if is_dm else "space",
            route="thread",
            space=space,
            thread_key=_as_string(input_value.get("threadKey")),
            policy=policy,
            reason="explicit_thread_key",
        )
    if policy["strategy"] == "topLevel":
        return _reply_target_result(
            input_value,
            conversation="dm" if is_dm else "space",
            route="topLevel",
            space=space,
            policy=policy,
            reason="forced_top_level",
        )
    if policy["strategy"] == "thread":
        if thread:
            return _reply_target_result(
                input_value,
                conversation="dm" if is_dm else "space",
                route="thread",
                space=space,
                thread_name=thread,
                policy=policy,
                reason="forced_thread",
            )
        return _reply_target_for_missing_thread(
            input_value, event, policy, is_dm=is_dm, space=space, reason_prefix="forced_thread"
        )
    if is_dm:
        if policy["dm"] == "thread":
            if thread:
                return _reply_target_result(
                    input_value,
                    conversation="dm",
                    route="thread",
                    space=space,
                    thread_name=thread,
                    policy=policy,
                    reason="dm_thread",
                )
            return _reply_target_for_missing_thread(
                input_value, event, policy, is_dm=True, space=space, reason_prefix="dm_thread"
            )
        return _reply_target_result(
            input_value,
            conversation="dm",
            route="topLevel",
            space=space,
            policy=policy,
            reason="dm_top_level",
        )
    if is_thread_reply:
        if policy["roomThreadReply"] == "thread":
            if thread:
                return _reply_target_result(
                    input_value,
                    conversation="space",
                    route="thread",
                    space=space,
                    thread_name=thread,
                    policy=policy,
                    reason="room_thread_reply",
                )
            return _reply_target_for_missing_thread(
                input_value,
                event,
                policy,
                is_dm=False,
                space=space,
                reason_prefix="room_thread_reply",
            )
        return _reply_target_result(
            input_value,
            conversation="space",
            route="topLevel",
            space=space,
            policy=policy,
            reason="room_thread_reply_top_level",
        )
    if policy["roomTopLevel"] == "thread":
        if thread:
            return _reply_target_result(
                input_value,
                conversation="space",
                route="thread",
                space=space,
                thread_name=thread,
                policy=policy,
                reason="room_top_level_thread",
            )
        return _reply_target_for_missing_thread(
            input_value,
            event,
            policy,
            is_dm=False,
            space=space,
            reason_prefix="room_top_level",
        )
    return _reply_target_result(
        input_value,
        conversation="space",
        route="topLevel",
        space=space,
        policy=policy,
        reason="room_top_level_top_level",
    )


def _should_resolve_reply_target(input_value: Mapping[str, Any]) -> bool:
    return any(
        _as_mapping(input_value.get(field)) is not None
        for field in ("replyTarget", "event", "replyRouting", "replyPolicy")
    )


def _reply_target_from_input(input_value: Mapping[str, Any]) -> JsonObject | None:
    existing = _as_mapping(input_value.get("replyTarget"))
    if existing is not None:
        return dict(existing)
    return resolve_reply_target(input_value) if _should_resolve_reply_target(input_value) else None


def _thread_from_reply_target(target: Mapping[str, Any] | None) -> JsonObject | None:
    if not target or target.get("route") != "thread":
        return None
    thread_name = _as_string(target.get("threadName"))
    thread_key = _as_string(target.get("threadKey"))
    if thread_name:
        return {"name": thread_name}
    if thread_key:
        return {"threadKey": thread_key}
    raise TypeError("Reply target selected a thread route without a thread name or thread key.")


def _reply_target_warnings(target: Mapping[str, Any] | None) -> list[str]:
    return [str(item) for item in _as_list(target.get("warnings"))] if target else []


def _reply_target_system_notes(target: Mapping[str, Any] | None) -> list[str]:
    return [str(item) for item in _as_list(target.get("systemNotes"))] if target else []


def _response_body_from_input(input_value: Mapping[str, Any]) -> JsonObject:
    body: JsonObject = {}

    for field in PATCH_FIELD_ORDER:
        if field in input_value:
            body[field] = input_value[field]

    if not body:
        raise TypeError("Expected at least one final response field to update.")

    return body


def _placeholder_auth_mode(
    input_value: Mapping[str, Any],
    handle: Mapping[str, Any] | None = None,
) -> str:
    return (
        _as_string(input_value.get("authMode"))
        or (_as_string(handle.get("authMode")) if handle is not None else None)
        or "app"
    )


def _placeholder_handle(
    input_value: Mapping[str, Any],
    *,
    message_name: str | None = None,
    created_at: str | None = None,
    editable: bool = False,
    reply_target: Mapping[str, Any] | None = None,
) -> JsonObject:
    target_thread = _thread_from_reply_target(reply_target)
    thread = (
        _as_string(target_thread.get("name")) if target_thread else None
    ) or _as_string(input_value.get("thread"))
    thread_key = (
        _as_string(target_thread.get("threadKey")) if target_thread else None
    ) or _as_string(input_value.get("threadKey"))

    if thread and thread_key:
        raise TypeError("Expected only one of thread or threadKey.")

    handle = {
        "kind": PLACEHOLDER_HANDLE_KIND,
        "space": _required_string(input_value, "space"),
        "messageName": message_name,
        "threadName": thread,
        "threadKey": thread_key,
        "requestId": _as_string(input_value.get("requestId")),
        "clientMessageId": _as_string(input_value.get("clientMessageId")),
        "correlationId": _as_string(input_value.get("correlationId")),
        "authMode": _placeholder_auth_mode(input_value),
        "createdAt": created_at,
        "editable": editable,
        "allowedUpdateMasks": list(PLACEHOLDER_ALLOWED_UPDATE_MASKS),
    }
    if reply_target:
        handle["replyTarget"] = dict(reply_target)
    return handle


def _normalize_placeholder_handle(value: Any) -> JsonObject:
    if not isinstance(value, Mapping):
        raise TypeError(f"Expected handle.kind to equal {PLACEHOLDER_HANDLE_KIND}.")
    if value.get("kind") != PLACEHOLDER_HANDLE_KIND:
        raise TypeError(f"Expected handle.kind to equal {PLACEHOLDER_HANDLE_KIND}.")

    allowed_update_masks = _string_list(
        value.get("allowedUpdateMasks") or PLACEHOLDER_ALLOWED_UPDATE_MASKS,
        "allowedUpdateMasks",
    )

    normalized = {
        "kind": PLACEHOLDER_HANDLE_KIND,
        "space": _required_string(value, "space"),
        "messageName": _as_string(value.get("messageName")),
        "threadName": _as_string(value.get("threadName")),
        "threadKey": _as_string(value.get("threadKey")),
        "requestId": _as_string(value.get("requestId")),
        "clientMessageId": _as_string(value.get("clientMessageId")),
        "correlationId": _as_string(value.get("correlationId")),
        "authMode": _as_string(value.get("authMode")) or "app",
        "createdAt": _as_string(value.get("createdAt")),
        "editable": _as_bool(value.get("editable")) or False,
        "allowedUpdateMasks": allowed_update_masks or list(PLACEHOLDER_ALLOWED_UPDATE_MASKS),
    }
    reply_target = _as_mapping(value.get("replyTarget"))
    if reply_target is not None:
        normalized["replyTarget"] = dict(reply_target)
    return normalized


def _assert_editable_placeholder_handle(handle: Mapping[str, Any]) -> None:
    if not handle.get("messageName") or handle.get("editable") is not True:
        raise TypeError("Expected an editable placeholder response handle with messageName.")


def _assert_update_mask_allowed(update_mask: str, handle: Mapping[str, Any]) -> None:
    allowed = set(_string_list(handle.get("allowedUpdateMasks"), "allowedUpdateMasks"))
    for field in (item for item in update_mask.split(",") if item):
        if field not in allowed:
            raise TypeError(f"Placeholder response handle does not allow updating {field}.")


def _patch_request(message_name: str, body: JsonObject, update_mask: str) -> JsonObject:
    return {
        "resource": "spaces.messages.patch",
        "method": "PATCH",
        "path": _chat_path(message_name),
        "query": {"updateMask": update_mask},
        "body": body,
    }


def _fallback_create_request(
    handle: Mapping[str, Any],
    input_value: Mapping[str, Any],
    body: JsonObject,
) -> JsonObject:
    fallback_body = dict(body)
    query: JsonObject = {
        "requestId": _as_string(input_value.get("fallbackRequestId"))
        or generate_request_id(f"{handle.get('messageName')}-fallback"),
        "messageId": _as_string(input_value.get("fallbackClientMessageId"))
        or generate_client_message_id(f"{handle.get('messageName')}-fallback"),
    }
    thread_name = _as_string(handle.get("threadName"))
    thread_key = _as_string(handle.get("threadKey"))

    if thread_name:
        fallback_body["thread"] = {"name": thread_name}
        query.update(_thread_query(fallback_body["thread"]))
    elif thread_key:
        fallback_body["thread"] = {"threadKey": thread_key}
        query.update(_thread_query(fallback_body["thread"]))

    return _create_message_request(_required_string(handle, "space"), query, fallback_body)


def _non_empty_string_list(input_value: Any, field: str) -> list[str]:
    values = [value.strip() for value in _string_list(input_value, field) if value.strip()]
    if not values:
        raise TypeError(f"Expected {field} to include at least one non-empty placeholder.")
    return values


def _parse_placeholder_json(raw: str) -> JsonObject:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise TypeError(f"Expected placeholderConfigJson to be valid JSON: {error}") from error

    if isinstance(parsed, list):
        return {"texts": parsed}
    if isinstance(parsed, Mapping):
        return dict(parsed)
    raise TypeError("Expected placeholderConfigJson to be a JSON array or object.")


def _parse_placeholder_csv(raw: str) -> list[str]:
    values: list[str] = []
    field = ""
    quoted = False
    index = 0

    while index < len(raw):
        char = raw[index]
        next_char = raw[index + 1] if index + 1 < len(raw) else None
        if char == '"':
            if quoted and next_char == '"':
                field += '"'
                index += 1
            else:
                quoted = not quoted
        elif not quoted and char in {",", "\n", "\r"}:
            values.append(field)
            field = ""
            if char == "\r" and next_char == "\n":
                index += 1
        else:
            field += char
        index += 1

    values.append(field)
    return _non_empty_string_list(values, "placeholderConfigCsv")


def _config_texts(config: Mapping[str, Any]) -> list[Any]:
    for key in ("texts", "placeholders", "items"):
        value = config.get(key)
        if isinstance(value, list):
            return value
    return []


def _placeholder_source(input_value: Mapping[str, Any]) -> tuple[str, list[str], JsonObject]:
    explicit_text = _as_string(input_value.get("placeholderText"))
    if explicit_text is not None:
        return (
            "placeholderText",
            _non_empty_string_list([explicit_text], "placeholderText"),
            {},
        )

    if "placeholderTexts" in input_value:
        return (
            "placeholderTexts",
            _non_empty_string_list(input_value.get("placeholderTexts"), "placeholderTexts"),
            {},
        )

    config_json = _as_string(input_value.get("placeholderConfigJson"))
    if config_json is not None:
        config = _parse_placeholder_json(config_json)
        return (
            "placeholderConfigJson",
            _non_empty_string_list(_config_texts(config), "placeholderConfigJson.texts"),
            config,
        )

    config_csv = _as_string(input_value.get("placeholderConfigCsv"))
    if config_csv is not None:
        return ("placeholderConfigCsv", _parse_placeholder_csv(config_csv), {})

    raw_config = input_value.get("placeholderConfig")
    config = None
    if isinstance(raw_config, Mapping):
        config = dict(raw_config)
    elif isinstance(raw_config, str):
        config = _parse_placeholder_json(raw_config)
    if config is not None:
        return (
            "placeholderConfig",
            _non_empty_string_list(_config_texts(config), "placeholderConfig.texts"),
            config,
        )

    return ("default", list(DEFAULT_PLACEHOLDER_TEXTS), {})


def _finite_integer(value: Any, fallback: int) -> int:
    number = _as_number(value)
    if number is None:
        return fallback
    return max(0, int(number))


def _seed_string(value: Any) -> str | None:
    string = _as_string(value)
    if string is not None:
        return string
    number = _as_number(value)
    return None if number is None else str(number)


def _seeded_index(seed: str, count: int) -> int:
    total = 0
    for index, char in enumerate(seed):
        total += ord(char) * (index + 1)
    return total % count


def select_placeholder_text(input_value: Mapping[str, Any]) -> JsonObject:
    source, texts, config = _placeholder_source(input_value)
    mode = (
        _as_string(input_value.get("placeholderMode"))
        or _as_string(config.get("mode"))
        or "first"
    )
    if mode not in PLACEHOLDER_SELECTION_MODES:
        raise TypeError(
            f"Expected placeholderMode to be one of {', '.join(PLACEHOLDER_SELECTION_MODES)}."
        )

    index = 0
    next_cursor = None
    random_seed = None

    if mode == "roundRobin":
        cursor = _finite_integer(input_value.get("placeholderCursor", config.get("cursor")), 0)
        index = cursor % len(texts)
        next_cursor = cursor + 1
    elif mode == "random":
        random_seed = (
            _seed_string(input_value.get("placeholderRandomSeed"))
            or _seed_string(config.get("randomSeed"))
            or _seed_string(input_value.get("correlationId"))
        )
        index = (
            random.randrange(len(texts))
            if random_seed is None
            else _seeded_index(random_seed, len(texts))
        )

    return {
        "kind": "chat.placeholder_text_selection",
        "text": texts[index],
        "mode": mode,
        "index": index,
        "count": len(texts),
        "source": source,
        "nextCursor": next_cursor,
        "randomSeed": random_seed,
        "warnings": [],
    }


def plan_placeholder_response(input_value: Mapping[str, Any]) -> JsonObject:
    reply_target = _reply_target_from_input(input_value)
    space = (
        _required_string(reply_target, "space")
        if reply_target
        else _required_string(input_value, "space")
    )
    text_selection = select_placeholder_text(input_value)
    placeholder_text = _required_string(text_selection, "text")
    request_id = _request_id_for(input_value, f"{space}-{placeholder_text}")
    client_message_id = _client_message_id_for(input_value, f"{space}-{placeholder_text}")
    thread = (
        _thread_from_reply_target(reply_target)
        if reply_target
        else _thread_body(input_value)
    )
    body: JsonObject = {"text": placeholder_text}
    if thread:
        body["thread"] = thread
    plan_input = {
        **dict(input_value),
        "space": space,
        "requestId": request_id,
        "clientMessageId": client_message_id,
        "authMode": _placeholder_auth_mode(input_value),
    }

    return _call_plan(
        "messages.placeholder.create",
        plan_input,
        [
            _create_message_request(
                space,
                {
                    "requestId": request_id,
                    "messageId": client_message_id,
                    **_thread_query(thread),
                },
                body,
            )
        ],
        request_id=request_id,
        client_message_id=client_message_id,
        direct_message=reply_target.get("conversation") == "dm" if reply_target else False,
        warnings=_reply_target_warnings(reply_target),
        extra={
            "placeholder": {
                "strategy": "create-then-edit",
                "state": "pending",
                "systemNotes": [
                    "System Note: A placeholder response will be posted immediately and later edited with the final answer.",
                    *_reply_target_system_notes(reply_target),
                ],
                "textSelection": text_selection,
                **({"replyTarget": reply_target} if reply_target else {}),
                "handle": _placeholder_handle(plan_input, reply_target=reply_target),
            }
        },
    )


def hydrate_placeholder_response_handle(
    handle_seed: Mapping[str, Any],
    created_message: Mapping[str, Any],
) -> JsonObject:
    handle = _normalize_placeholder_handle(handle_seed)
    if not isinstance(created_message, Mapping):
        raise TypeError("Expected createdMessage to be an object.")
    message_name = _as_string(created_message.get("name"))
    if not message_name:
        raise TypeError("Expected createdMessage.name to be a non-empty string.")
    thread = created_message.get("thread")
    thread_name = (
        _as_string(thread.get("name"))
        if isinstance(thread, Mapping)
        else None
    )

    return {
        **handle,
        "messageName": message_name,
        "threadName": thread_name or _as_string(handle.get("threadName")),
        "createdAt": _as_string(created_message.get("createTime"))
        or _as_string(handle.get("createdAt")),
        "editable": True,
    }


def plan_complete_placeholder_response(input_value: Mapping[str, Any]) -> JsonObject:
    handle = _normalize_placeholder_handle(input_value.get("handle"))
    _assert_editable_placeholder_handle(handle)
    body = _response_body_from_input(input_value)
    update_mask = _as_string(input_value.get("updateMask")) or build_update_mask(body)
    _assert_update_mask_allowed(update_mask, handle)
    on_patch_failure = _as_string(input_value.get("onPatchFailure")) or "throw"
    if on_patch_failure not in {"throw", "createNewMessage"}:
        raise TypeError("Expected onPatchFailure to be either throw or createNewMessage.")
    fallback = (
        {
            "onPatchFailure": on_patch_failure,
            "request": _fallback_create_request(handle, input_value, body),
        }
        if on_patch_failure == "createNewMessage"
        else {
            "onPatchFailure": on_patch_failure,
            "request": None,
        }
    )
    plan_input = {
        **dict(input_value),
        "authMode": _placeholder_auth_mode(input_value, handle),
    }

    return _call_plan(
        "messages.placeholder.complete",
        plan_input,
        [_patch_request(_required_string(handle, "messageName"), body, update_mask)],
        request_id=_as_string(handle.get("requestId")),
        client_message_id=_as_string(handle.get("clientMessageId")),
        extra={
            "placeholder": {
                "strategy": "edit-placeholder",
                "state": "complete",
                "updateMask": update_mask,
                "handle": handle,
                "fallback": fallback,
                "systemNotes": [
                    "System Note: The final response should edit the placeholder message instead of creating a second Chat message."
                ],
            }
        },
    )


def plan_buffered_placeholder_completion(input_value: Mapping[str, Any]) -> JsonObject:
    handle = _normalize_placeholder_handle(input_value.get("handle"))
    _assert_editable_placeholder_handle(handle)
    buffering = build_buffered_stream_patches(input_value)
    cadence = buffering["cadence"]
    throttle_ms = cadence["throttleMs"]
    patch_texts = _string_list(buffering["patchTexts"], "patchTexts")
    requests = []

    for index, text in enumerate(patch_texts):
        final = index == len(patch_texts) - 1
        request = _patch_request(_required_string(handle, "messageName"), {"text": text}, "text")
        request["throttle"] = {
            "minDelayMs": 0 if final else throttle_ms,
            "final": final,
        }
        requests.append(request)

    plan_input = {
        **dict(input_value),
        "authMode": _placeholder_auth_mode(input_value, handle),
    }

    return _call_plan(
        "messages.placeholder.bufferedComplete",
        plan_input,
        requests,
        request_id=_as_string(handle.get("requestId")),
        client_message_id=_as_string(handle.get("clientMessageId")),
        extra={
            "streaming": {
                "strategy": "edit-placeholder-buffered",
                "patchCount": len(patch_texts),
                "throttleMs": throttle_ms,
                "buffering": buffering,
            },
            "placeholder": {
                "strategy": "edit-placeholder",
                "state": "complete",
                "updateMask": "text",
                "handle": handle,
                "fallback": {
                    "onPatchFailure": "throw",
                    "request": None,
                },
                "systemNotes": [
                    "System Note: Buffered output should edit the placeholder message instead of creating additional Chat messages."
                ],
            },
        },
    )


def _iso_ms(value: Any) -> int | None:
    string = _as_string(value)
    if not string:
        return None
    from datetime import datetime

    try:
        return round(datetime.fromisoformat(string.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def _elapsed_ms(input_value: Mapping[str, Any]) -> int:
    explicit = _as_number(input_value.get("elapsedMs"))
    if explicit is not None and explicit >= 0:
        return int(explicit)
    received_at = _iso_ms(input_value.get("receivedAt"))
    now = _iso_ms(input_value.get("now"))
    if received_at is not None and now is not None:
        return max(0, now - received_at)
    return 0


def _now_iso(input_value: Mapping[str, Any]) -> str:
    explicit = _as_string(input_value.get("now"))
    if explicit:
        return explicit
    from datetime import datetime, timezone

    return datetime.now(tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _async_id(input_value: Mapping[str, Any]) -> str:
    return (
        _as_string(input_value.get("eventId"))
        or _as_string(input_value.get("correlationId"))
        or _as_string(input_value.get("requestId"))
        or str(uuid.uuid4())
    )


def _placeholder_input(
    input_value: Mapping[str, Any],
    reply_target: Mapping[str, Any] | None,
) -> JsonObject:
    target_thread = _thread_from_reply_target(reply_target)
    result: JsonObject = {
        "space": _required_string(reply_target, "space")
        if reply_target
        else _required_string(input_value, "space"),
        "authMode": _placeholder_auth_mode(input_value),
    }
    if reply_target:
        result["replyTarget"] = dict(reply_target)
    if target_thread and target_thread.get("name"):
        result["thread"] = target_thread["name"]
    elif target_thread and target_thread.get("threadKey"):
        result["threadKey"] = target_thread["threadKey"]
    for field in [
        "requestId",
        "clientMessageId",
        "correlationId",
        "placeholderText",
        "placeholderTexts",
        "placeholderConfig",
        "placeholderConfigJson",
        "placeholderConfigCsv",
        "placeholderMode",
        "placeholderCursor",
        "placeholderRandomSeed",
    ]:
        if field in input_value:
            result[field] = input_value[field]
    if reply_target is None:
        for field in ("thread", "threadKey"):
            if field in input_value:
                result[field] = input_value[field]
    return result


def _async_deadline(
    input_value: Mapping[str, Any],
    respond_with_placeholder: bool,
) -> JsonObject:
    sync_deadline_ms = int(
        _positive_number(input_value.get("syncDeadlineMs"), DEFAULT_SYNC_DEADLINE_MS)
    )
    safety_margin_ms = int(
        _non_negative_number(
            input_value.get("safetyMarginMs"), DEFAULT_ASYNC_SAFETY_MARGIN_MS
        )
    )
    elapsed = _elapsed_ms(input_value)
    remaining_ms = max(0, sync_deadline_ms - elapsed)
    work_budget_ms = max(0, remaining_ms - safety_margin_ms)
    expected_work_ms = int(_non_negative_number(input_value.get("expectedWorkMs"), 0))
    exceeds_sync_budget = expected_work_ms > work_budget_ms
    should_defer = respond_with_placeholder or exceeds_sync_budget
    reason = (
        "expected_work_exceeds_sync_budget"
        if should_defer and exceeds_sync_budget
        else "placeholder_requested"
        if should_defer
        else "within_sync_budget"
    )
    return {
        "syncDeadlineMs": sync_deadline_ms,
        "safetyMarginMs": safety_margin_ms,
        "elapsedMs": elapsed,
        "remainingMs": remaining_ms,
        "workBudgetMs": work_budget_ms,
        "expectedWorkMs": expected_work_ms,
        "shouldDefer": should_defer,
        "reason": reason,
    }


def _production_adapters() -> list[JsonObject]:
    return [
        {"adapter": "cloudTasks", "language": "node", "status": "planned"},
        {"adapter": "bullmq", "language": "node", "status": "planned"},
        {"adapter": "pubsub", "language": "node-python", "status": "planned"},
        {"adapter": "celery", "language": "python", "status": "planned"},
    ]


def _async_final_delivery(
    reply_handle: Mapping[str, Any] | None,
    reply_target: Mapping[str, Any] | None = None,
) -> JsonObject:
    if reply_handle is not None:
        return {
            "strategy": "edit_placeholder",
            "successOperation": "messages.placeholder.complete",
            "errorOperation": "messages.placeholder.complete",
            "onPatchFailure": "createNewMessage",
        }
    if reply_target is not None:
        return {
            "strategy": "create_reply_to_event",
            "successOperation": "messages.replyToEvent",
            "errorOperation": "messages.replyToEvent",
            "onPatchFailure": "createNewMessage",
        }
    return {
        "strategy": "create_message",
        "successOperation": "messages.sendToSpace",
        "errorOperation": "messages.sendToSpace",
        "onPatchFailure": "createNewMessage",
    }


def _async_system_notes(
    strategy: str,
    reply_handle: Mapping[str, Any] | None,
    reply_target: Mapping[str, Any] | None,
) -> list[str]:
    routing_notes = _reply_target_system_notes(reply_target)
    if strategy == "placeholder_then_queue":
        if reply_handle and reply_handle.get("messageName"):
            second = (
                f"System Note: The queued worker should edit {reply_handle['messageName']} "
                "instead of creating a second final-answer message."
            )
        else:
            second = (
                "System Note: The queued worker must hydrate the placeholder reply handle "
                "before editing the final answer."
            )
        return [
            "System Note: This interaction should respond with a placeholder immediately and enqueue final AI work.",
            second,
            *routing_notes,
        ]
    if strategy == "queue_only":
        return [
            "System Note: This interaction should enqueue final AI work and respond asynchronously because no placeholder was requested.",
            *routing_notes,
        ]
    return [
        "System Note: This interaction is expected to finish within the synchronous response budget.",
        *routing_notes,
    ]


def _async_queue_task(
    *,
    input_value: Mapping[str, Any],
    task_id: str,
    event_id: str | None,
    idempotency_key: str,
    space: str,
    reply_target: Mapping[str, Any] | None,
    reply_handle: Mapping[str, Any] | None,
    requires_reply_handle_hydration: bool,
    created_at: str,
    deadline_ms: int,
) -> JsonObject:
    return {
        "kind": "chat.async_response_task",
        "taskId": task_id,
        "eventId": event_id,
        "correlationId": _as_string(input_value.get("correlationId")),
        "idempotencyKey": idempotency_key,
        "authMode": _placeholder_auth_mode(input_value),
        "space": space,
        "payloadRef": _as_string(input_value.get("payloadRef")),
        **({"replyTarget": dict(reply_target)} if reply_target is not None else {}),
        "replyHandle": dict(reply_handle) if reply_handle is not None else None,
        "requiresReplyHandleHydration": requires_reply_handle_hydration,
        "createdAt": created_at,
        "deadlineMs": deadline_ms,
        "finalDelivery": _async_final_delivery(reply_handle, reply_target),
    }


def plan_async_response(input_value: Mapping[str, Any]) -> JsonObject:
    reply_target = _reply_target_from_input(input_value)
    space = (
        _required_string(reply_target, "space")
        if reply_target
        else _required_string(input_value, "space")
    )
    respond_with_placeholder = _as_bool(input_value.get("respondWithPlaceholder"))
    if respond_with_placeholder is None:
        respond_with_placeholder = True
    deadline = _async_deadline(input_value, respond_with_placeholder)
    should_defer = deadline["shouldDefer"] is True
    strategy = (
        "placeholder_then_queue"
        if respond_with_placeholder
        else "queue_only"
        if should_defer
        else "sync_response"
    )
    event_id = _as_string(input_value.get("eventId"))
    id_seed = _async_id(input_value)
    idempotency_key = _as_string(input_value.get("idempotencyKey")) or (
        f"chat-event:{event_id}" if event_id else f"chat-async:{_slugify(id_seed)}"
    )
    placeholder_plan = (
        plan_placeholder_response(_placeholder_input(input_value, reply_target))
        if respond_with_placeholder
        else None
    )
    handle_seed = (
        placeholder_plan.get("placeholder", {}).get("handle")
        if placeholder_plan is not None
        else None
    )
    if handle_seed and "createdMessage" in input_value:
        reply_handle = hydrate_placeholder_response_handle(
            handle_seed,
            input_value["createdMessage"],
        )
    else:
        reply_handle = dict(handle_seed) if isinstance(handle_seed, Mapping) else None
    requires_reply_handle_hydration = bool(handle_seed) and "createdMessage" not in input_value
    queue_config = input_value.get("queue") if isinstance(input_value.get("queue"), Mapping) else {}
    adapter = _as_string(queue_config.get("adapter")) or "localMemory"
    target = _as_string(queue_config.get("target"))
    task_id = _as_string(input_value.get("taskId")) or f"task-{_slugify(id_seed)}"
    queue = (
        {
            "adapter": adapter,
            "target": target,
            "status": "planned",
            "task": _async_queue_task(
                input_value=input_value,
                task_id=task_id,
                event_id=event_id,
                idempotency_key=idempotency_key,
                space=space,
                reply_target=reply_target,
                reply_handle=reply_handle,
                requires_reply_handle_hydration=requires_reply_handle_hydration,
                created_at=_now_iso(input_value),
                deadline_ms=deadline["syncDeadlineMs"],
            ),
            "productionAdapters": _production_adapters(),
        }
        if should_defer or respond_with_placeholder
        else None
    )
    final_delivery = _async_final_delivery(reply_handle, reply_target)
    return {
        "kind": "chat.async_response_plan",
        "status": "defer" if should_defer or respond_with_placeholder else "sync",
        "strategy": strategy,
        "deadline": deadline,
        "idempotency": {
            "idempotencyKey": idempotency_key,
            "duplicateStrategy": "guard_before_placeholder",
            "replaySafe": True,
        },
        **({"replyTarget": reply_target} if reply_target is not None else {}),
        "placeholderPlan": placeholder_plan,
        "replyHandle": reply_handle,
        "queue": queue,
        "completion": {
            "successOperation": final_delivery["successOperation"],
            "errorOperation": final_delivery["errorOperation"],
            "finalDeliveryStrategy": final_delivery["strategy"],
            "errorText": _as_string(input_value.get("errorText")) or DEFAULT_ASYNC_ERROR_TEXT,
        },
        "systemNotes": _async_system_notes(strategy, reply_handle, reply_target),
    }


class InMemoryAsyncResponseQueue:
    def __init__(self) -> None:
        self._tasks: list[JsonObject] = []

    def enqueue(self, task: Mapping[str, Any]) -> JsonObject:
        task_id = _required_string(task, "taskId")
        self._tasks.append(dict(task))
        return {
            "kind": "chat.async_queue_enqueue_result",
            "status": "enqueued",
            "depth": len(self._tasks),
            "taskId": task_id,
        }

    def dequeue(self) -> JsonObject | None:
        if not self._tasks:
            return None
        return self._tasks.pop(0)

    def list(self) -> list[JsonObject]:
        return [dict(task) for task in self._tasks]

    def drain(self, limit: int | None = None) -> list[JsonObject]:
        count = len(self._tasks) if limit is None else max(0, int(limit))
        drained = self._tasks[:count]
        del self._tasks[:count]
        return drained


def plan_send_to_space(input_value: Mapping[str, Any]) -> JsonObject:
    space = _required_string(input_value, "space")
    text = _required_string(input_value, "text")
    request_id = _request_id_for(input_value, f"{space}-{text}")
    client_message_id = _client_message_id_for(input_value, f"{space}-{text}")

    return _call_plan(
        "messages.sendToSpace",
        input_value,
        [
            _create_message_request(
                space,
                {"requestId": request_id, "messageId": client_message_id},
                {
                    "text": text,
                },
            )
        ],
        request_id=request_id,
        client_message_id=client_message_id,
    )


def plan_send_to_user(input_value: Mapping[str, Any]) -> JsonObject:
    email = _required_string(input_value, "email")
    text = _required_string(input_value, "text")
    request_id = _request_id_for(input_value, f"{email}-{text}")
    client_message_id = _client_message_id_for(input_value, f"{email}-{text}")
    user_name = _user_name_for_email(email)

    return _call_plan(
        "messages.sendToUser",
        input_value,
        [
            {
                "resource": "spaces.findDirectMessage",
                "method": "GET",
                "path": "/v1/spaces:findDirectMessage",
                "query": {"name": user_name},
                "body": None,
            },
            {
                "resource": "spaces.messages.create",
                "method": "POST",
                "path": "/v1/{resolvedDirectMessageSpace}/messages",
                "query": {"requestId": request_id, "messageId": client_message_id},
                "body": {
                    "text": text,
                },
            },
        ],
        capability_ok=False,
        capability_reasons=[
            "Direct-message live sends are disabled by W9 safety policy; this plan is dry-run only."
        ],
        request_id=request_id,
        client_message_id=client_message_id,
        direct_message=True,
        warnings=["Direct message targets must be explicitly approved in a live smoke harness."],
    )


def plan_find_or_setup_dm(input_value: Mapping[str, Any]) -> JsonObject:
    email = _required_string(input_value, "email")
    user_name = _user_name_for_email(email)

    return _call_plan(
        "messages.findOrSetupDm",
        input_value,
        [
            {
                "resource": "spaces.findDirectMessage",
                "method": "GET",
                "path": "/v1/spaces:findDirectMessage",
                "query": {"name": user_name},
                "body": None,
            },
            {
                "resource": "spaces.setup",
                "method": "POST",
                "path": "/v1/spaces:setup",
                "query": {},
                "body": {
                    "spaceType": "DIRECT_MESSAGE",
                    "memberships": [
                        {
                            "member": {
                                "name": user_name,
                                "type": "HUMAN",
                            }
                        }
                    ],
                },
            },
        ],
        capability_ok=False,
        capability_reasons=[
            "Direct-message setup is disabled by W9 safety policy; this plan is dry-run only."
        ],
        direct_message=True,
        warnings=["Direct message setup must not run against real users from W9."],
    )


def plan_reply_in_thread(input_value: Mapping[str, Any]) -> JsonObject:
    space = _required_string(input_value, "space")
    thread = _required_string(input_value, "thread")
    text = _required_string(input_value, "text")
    request_id = _request_id_for(input_value, f"{thread}-{text}")
    client_message_id = _client_message_id_for(input_value, f"{thread}-{text}")

    return _call_plan(
        "messages.replyInThread",
        input_value,
        [
            _create_message_request(
                space,
                {
                    "requestId": request_id,
                    "messageId": client_message_id,
                    "messageReplyOption": "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
                },
                {
                    "text": text,
                    "thread": {"name": thread},
                },
            )
        ],
        request_id=request_id,
        client_message_id=client_message_id,
    )


def plan_reply_to_event(input_value: Mapping[str, Any]) -> JsonObject:
    text = _required_string(input_value, "text")
    target = resolve_reply_target(input_value)
    space = _required_string(target, "space")
    request_id = _request_id_for(input_value, f"{space}-{text}")
    client_message_id = _client_message_id_for(input_value, f"{space}-{text}")
    body: JsonObject = {"text": text}
    query: JsonObject = {"requestId": request_id, "messageId": client_message_id}
    thread_name = _as_string(target.get("threadName"))
    thread_key = _as_string(target.get("threadKey"))
    message_reply_option = _as_string(target.get("messageReplyOption"))

    if thread_name:
        body["thread"] = {"name": thread_name}
    elif thread_key:
        body["thread"] = {"threadKey": thread_key}
    if "thread" in body and message_reply_option:
        query["messageReplyOption"] = message_reply_option

    return _call_plan(
        "messages.replyToEvent",
        input_value,
        [_create_message_request(space, query, body)],
        request_id=request_id,
        client_message_id=client_message_id,
        direct_message=target.get("conversation") == "dm",
        warnings=[str(item) for item in _as_list(target.get("warnings"))],
        extra={"replyTarget": target},
    )


def plan_start_thread(input_value: Mapping[str, Any]) -> JsonObject:
    space = _required_string(input_value, "space")
    thread_key = _required_string(input_value, "threadKey")
    text = _required_string(input_value, "text")
    seed = f"{space}-{thread_key}-{text}"
    request_id = _request_id_for(input_value, seed)
    client_message_id = _client_message_id_for(input_value, seed)

    return _call_plan(
        "messages.startThread",
        input_value,
        [
            _create_message_request(
                space,
                {
                    "requestId": request_id,
                    "messageId": client_message_id,
                    "messageReplyOption": "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
                },
                {
                    "text": text,
                    "thread": {"threadKey": thread_key},
                },
            )
        ],
        request_id=request_id,
        client_message_id=client_message_id,
    )


def build_update_mask(fields: Mapping[str, Any]) -> str:
    present = {key for key, value in fields.items() if value is not None}
    ordered = [field for field in PATCH_FIELD_ORDER if field in present]
    extras = sorted(field for field in present if field not in PATCH_FIELD_ORDER)
    return ",".join([*ordered, *extras])


def plan_edit_message(input_value: Mapping[str, Any]) -> JsonObject:
    message = _required_string(input_value, "message")
    body: JsonObject = {}

    for field in PATCH_FIELD_ORDER:
        if field in input_value:
            body[field] = input_value[field]

    update_mask = _as_string(input_value.get("updateMask")) or build_update_mask(body)

    return _call_plan(
        "messages.edit",
        input_value,
        [
            {
                "resource": "spaces.messages.patch",
                "method": "PATCH",
                "path": _chat_path(message),
                "query": {"updateMask": update_mask},
                "body": body,
            }
        ],
    )


def plan_delete_app_message(input_value: Mapping[str, Any]) -> JsonObject:
    message = _required_string(input_value, "message")
    app_created = input_value.get("appCreated") is True

    return _call_plan(
        "messages.deleteAppMessage",
        input_value,
        [
            {
                "resource": "spaces.messages.delete",
                "method": "DELETE",
                "path": _chat_path(message),
                "query": {},
                "body": None,
            }
        ],
        capability_ok=app_created,
        capability_reasons=[]
        if app_created
        else ["Only app-created messages can be deleted by this high-level primitive."],
    )


def plan_stream_message(input_value: Mapping[str, Any]) -> JsonObject:
    space = _required_string(input_value, "space")
    initial_text = _required_string(input_value, "initialText")
    request_id = _request_id_for(input_value, f"{space}-{initial_text}")
    client_message_id = _client_message_id_for(input_value, f"{space}-{initial_text}")
    message = _as_string(input_value.get("message")) or f"{space}/messages/{client_message_id}"
    patch_texts = []

    for patch_text in _as_list(input_value.get("patchTexts")):
        text = _as_string(patch_text)
        if text is None:
            raise TypeError("Expected every patchTexts item to be a string.")
        patch_texts.append(text)

    throttle_ms = _as_number(input_value.get("throttleMs")) or DEFAULT_STREAM_THROTTLE_MS
    requests = [
        _create_message_request(
            space,
            {"requestId": request_id, "messageId": client_message_id},
            {
                "text": initial_text,
            },
        )
    ]

    for index, text in enumerate(patch_texts):
        final = index == len(patch_texts) - 1
        requests.append(
            {
                "resource": "spaces.messages.patch",
                "method": "PATCH",
                "path": _chat_path(message),
                "query": {"updateMask": "text"},
                "body": {"text": text},
                "throttle": {
                    "minDelayMs": 0 if final else throttle_ms,
                    "final": final,
                },
            }
        )

    return _call_plan(
        "messages.stream",
        input_value,
        requests,
        request_id=request_id,
        client_message_id=client_message_id,
        extra={
            "streaming": {
                "strategy": "create-then-patch",
                "throttleMs": throttle_ms,
                "patchCount": len(patch_texts),
            }
        },
    )


def _string_list(input_value: Any, field: str) -> list[str]:
    output: list[str] = []
    for item in _as_list(input_value):
        value = _as_string(item)
        if value is None:
            raise TypeError(f"Expected every {field} item to be a string.")
        output.append(value)
    return output


def build_buffered_stream_patches(input_value: Mapping[str, Any]) -> JsonObject:
    chunks = _string_list(input_value.get("chunks"), "chunks")
    min_patch_chars = _positive_number(
        input_value.get("minPatchChars"),
        DEFAULT_STREAM_MIN_PATCH_CHARS,
    )
    max_patches = max(
        1,
        int(_positive_number(input_value.get("maxPatches"), DEFAULT_STREAM_MAX_PATCHES)),
    )
    throttle_ms = _non_negative_number(input_value.get("throttleMs"), DEFAULT_STREAM_THROTTLE_MS)
    prefix = _as_string(input_value.get("prefix")) or ""
    suffix = _as_string(input_value.get("suffix")) or ""
    initial_text = _as_string(input_value.get("initialText")) or "Thinking..."
    warnings: list[str] = []
    patch_texts: list[str] = []
    content = ""
    last_emitted = ""

    for chunk in chunks:
        content += chunk
        candidate = f"{prefix}{content}{suffix}"
        has_patch_slot_before_final = len(patch_texts) < max_patches - 1
        if has_patch_slot_before_final and len(candidate) - len(last_emitted) >= min_patch_chars:
            patch_texts.append(candidate)
            last_emitted = candidate

    final_body = _as_string(input_value.get("finalText")) or content
    final_text = f"{prefix}{final_body}{suffix}"
    if not patch_texts or patch_texts[-1] != final_text:
        if len(patch_texts) >= max_patches:
            patch_texts[-1] = final_text
            warnings.append("max_patches_replaced_last_patch_with_final_text")
        else:
            patch_texts.append(final_text)

    return {
        "kind": "chat.stream_buffer_plan",
        "strategy": "buffered-text",
        "inputChunkCount": len(chunks),
        "initialText": initial_text,
        "finalText": final_text,
        "patchTexts": patch_texts,
        "patchCount": len(patch_texts),
        "cadence": {
            "minPatchChars": min_patch_chars,
            "maxPatches": max_patches,
            "throttleMs": throttle_ms,
        },
        "warnings": warnings,
    }


def plan_buffered_stream_message(input_value: Mapping[str, Any]) -> JsonObject:
    buffering = build_buffered_stream_patches(input_value)
    cadence = buffering["cadence"]
    stream_plan = plan_stream_message(
        {
            **dict(input_value),
            "initialText": buffering["initialText"],
            "patchTexts": buffering["patchTexts"],
            "throttleMs": cadence["throttleMs"],
        }
    )
    streaming = dict(stream_plan.get("streaming") or {})

    return {
        **stream_plan,
        "streaming": {
            **streaming,
            "buffering": buffering,
        },
    }



_SEARCH_DOCS_LISTED_NOTE = (
    "spaces.messages.search is a docs-listed surface; "
    "verify live support before relying on it."
)
_REPLACE_CARDS_DOCS_LISTED_NOTE = (
    "spaces.messages.replaceCards is a docs-listed surface; "
    "verify live support before relying on it."
)


def plan_search_messages(input_value: Mapping[str, Any]) -> JsonObject:
    space = _required_string(input_value, "space")
    query = _required_string(input_value, "query")
    page_size_number = _as_number(input_value.get("pageSize"))
    if page_size_number is None:
        page_size = 25
    else:
        page_size = min(1000, max(1, int(math.floor(page_size_number))))
    request_query: JsonObject = {"query": query, "pageSize": page_size}
    page_token = _as_string(input_value.get("pageToken"))
    if page_token:
        request_query["pageToken"] = page_token
    order_by = _as_string(input_value.get("orderBy"))
    if order_by:
        request_query["orderBy"] = order_by

    return _call_plan(
        "messages.search",
        input_value,
        [
            {
                "resource": "spaces.messages.search",
                "method": "GET",
                "path": _chat_path(f"{space}/messages:search"),
                "query": request_query,
                "body": None,
            }
        ],
        warnings=[_SEARCH_DOCS_LISTED_NOTE],
        extra={
            "search": {
                "space": space,
                "query": query,
                "pageSize": page_size,
                "pageToken": page_token if page_token else None,
                "orderBy": order_by if order_by else None,
            }
        },
    )


def plan_replace_cards(input_value: Mapping[str, Any]) -> JsonObject:
    message = _required_string(input_value, "message")
    cards = _as_list(input_value.get("cardsV2"))
    if len(cards) == 0:
        raise TypeError("Expected cardsV2 to include at least one card.")

    return _call_plan(
        "messages.replaceCards",
        input_value,
        [
            {
                "resource": "spaces.messages.replaceCards",
                "method": "POST",
                "path": _chat_path(f"{message}:replaceCards"),
                "query": {},
                "body": {"cardsV2": cards},
            }
        ],
        warnings=[_REPLACE_CARDS_DOCS_LISTED_NOTE],
        extra={
            "replaceCards": {
                "message": message,
                "cardCount": len(cards),
            }
        },
    )


__all__ = [
    "build_buffered_stream_patches",
    "build_update_mask",
    "generate_client_message_id",
    "generate_request_id",
    "hydrate_placeholder_response_handle",
    "InMemoryAsyncResponseQueue",
    "plan_async_response",
    "plan_buffered_placeholder_completion",
    "plan_buffered_stream_message",
    "plan_complete_placeholder_response",
    "plan_delete_app_message",
    "plan_edit_message",
    "plan_find_or_setup_dm",
    "plan_placeholder_response",
    "plan_replace_cards",
    "plan_reply_in_thread",
    "plan_reply_to_event",
    "plan_search_messages",
    "plan_send_to_space",
    "plan_send_to_user",
    "plan_start_thread",
    "plan_stream_message",
    "resolve_reply_target",
    "select_placeholder_text",
]
