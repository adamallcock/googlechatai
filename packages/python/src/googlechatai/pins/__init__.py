"""Dry-run Google Chat message-pin call planners."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from typing import Any


JsonObject = dict[str, Any]

CHAT_SPACES_PINS_SCOPE = "https://www.googleapis.com/auth/chat.spaces.pins"
CHAT_SPACES_PINS_READONLY_SCOPE = (
    "https://www.googleapis.com/auth/chat.spaces.pins.readonly"
)

# Deprecated compatibility alias. Prefer CHAT_SPACES_PINS_SCOPE.
PIN_MESSAGES_SCOPE = CHAT_SPACES_PINS_SCOPE

MESSAGE_PINS_DEVELOPER_PREVIEW_NOTE = (
    "Message pins are a Google Workspace Developer Preview, user-authorized surface."
)

# Deprecated compatibility alias. Prefer MESSAGE_PINS_DEVELOPER_PREVIEW_NOTE.
CHAT_PIN_DOCS_LISTED_NOTE = MESSAGE_PINS_DEVELOPER_PREVIEW_NOTE

DRY_RUN_NOTE = "Dry run only; no Google Chat API call was executed."
USER_AUTH_REQUIRED_REASON = (
    "Google Chat message pins require user authentication; app authentication is not supported."
)
DEFAULT_PAGE_SIZE = 100
MIN_PAGE_SIZE = 1
MAX_PAGE_SIZE = 100
MESSAGE_RESOURCE_PATTERN = re.compile(r"^(spaces/[^/]+)/messages/([^/]+)$")
MESSAGE_PIN_RESOURCE_PATTERN = re.compile(r"^spaces/[^/]+/messagePins/[^/]+$")


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _as_number(value: Any) -> int | float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value if math.isfinite(value) else None
    return None


def _required_string(input_value: Mapping[str, Any], key: str) -> str:
    value = _as_string(input_value.get(key))
    if not value:
        raise TypeError(f"Expected {key} to be a non-empty string.")
    return value


def _message_parts(message: str) -> tuple[str, str]:
    match = MESSAGE_RESOURCE_PATTERN.fullmatch(message)
    if not match:
        raise TypeError(
            "Expected message to use the resource name format spaces/{space}/messages/{message}."
        )
    return match.group(1), match.group(2)


def _message_for_space(input_value: Mapping[str, Any], space: str) -> str:
    message = _required_string(input_value, "message")
    message_space, _message_id = _message_parts(message)
    if message_space != space:
        raise TypeError("Expected message to belong to the supplied space.")
    return message


def _message_pin_name_for_message(message: str) -> str:
    space, message_id = _message_parts(message)
    return f"{space}/messagePins/{message_id}"


def _required_message_pin(input_value: Mapping[str, Any]) -> str:
    message_pin = _required_string(input_value, "messagePin")
    if not MESSAGE_PIN_RESOURCE_PATTERN.fullmatch(message_pin):
        raise TypeError(
            "Expected messagePin to use the resource name format spaces/{space}/messagePins/{messagePin}."
        )
    return message_pin


def _auth_mode(input_value: Mapping[str, Any]) -> str:
    return _as_string(input_value.get("authMode")) or "user"


def _chat_path(resource_name: str) -> str:
    return f"/v1/{resource_name}"


def _safety() -> JsonObject:
    return {
        "liveAllowed": False,
        "directMessage": False,
        "notes": [DRY_RUN_NOTE],
    }


def _capability(
    input_value: Mapping[str, Any],
    required_scopes: list[str],
    ok: bool = True,
    reasons: list[str] | None = None,
) -> JsonObject:
    mode = _auth_mode(input_value)
    user_auth_ok = mode == "user"

    return {
        "ok": ok and user_auth_ok,
        "authMode": mode,
        "requiredScopes": required_scopes,
        "reasons": (reasons or [])
        if user_auth_ok
        else [*(reasons or []), USER_AUTH_REQUIRED_REASON],
    }


def _call_plan(
    operation: str,
    input_value: Mapping[str, Any],
    required_scopes: list[str],
    requests: list[JsonObject],
    *,
    extra: JsonObject | None = None,
    warnings: list[str] | None = None,
    capability_ok: bool = True,
    capability_reasons: list[str] | None = None,
) -> JsonObject:
    plan: JsonObject = {
        "kind": "chat.call_plan",
        "operation": operation,
        "dryRun": True,
        "capability": _capability(
            input_value,
            required_scopes,
            capability_ok,
            capability_reasons,
        ),
        "requests": requests,
        "idempotency": {
            "requestId": None,
            "clientMessageId": None,
        },
    }
    if extra:
        plan.update(extra)
    plan["safety"] = _safety()
    plan["warnings"] = [MESSAGE_PINS_DEVELOPER_PREVIEW_NOTE, *(warnings or [])]
    return plan


def _page_size_from(input_value: Mapping[str, Any]) -> int:
    value = _as_number(input_value.get("pageSize"))
    if value is None:
        value = DEFAULT_PAGE_SIZE
    return max(MIN_PAGE_SIZE, min(MAX_PAGE_SIZE, int(value)))


def _list_query(input_value: Mapping[str, Any]) -> JsonObject:
    query: JsonObject = {"pageSize": _page_size_from(input_value)}
    page_token = _as_string(input_value.get("pageToken"))
    if page_token:
        query["pageToken"] = page_token
    return query


def _complete_pin_list_query(input_value: Mapping[str, Any]) -> JsonObject:
    if _as_string(input_value.get("pageToken")):
        raise TypeError(
            "planEnsureMessagePinned does not accept pageToken because it must inspect the complete pin collection."
        )
    requested_page_size = _as_number(input_value.get("pageSize"))
    if requested_page_size is not None and requested_page_size != MAX_PAGE_SIZE:
        raise TypeError(
            "planEnsureMessagePinned requires pageSize 100 so it can inspect the complete pin collection."
        )
    return {"pageSize": MAX_PAGE_SIZE}


def _list_message_pins_request(space: str, query: JsonObject) -> JsonObject:
    return {
        "resource": "spaces.messagePins.list",
        "method": "GET",
        "path": _chat_path(f"{space}/messagePins"),
        "query": query,
        "body": None,
    }


def _create_message_pin_request(space: str, message: str) -> JsonObject:
    return {
        "resource": "spaces.messagePins.create",
        "method": "POST",
        "path": _chat_path(f"{space}/messagePins"),
        "query": {},
        "body": {"message": message},
    }


def plan_pin_message(input_value: Mapping[str, Any]) -> JsonObject:
    space = _required_string(input_value, "space")
    message = _message_for_space(input_value, space)

    return _call_plan(
        "pins.pin",
        input_value,
        [CHAT_SPACES_PINS_SCOPE],
        [_create_message_pin_request(space, message)],
        extra={
            "pin": {
                "action": "pin",
                "space": space,
                "message": message,
            }
        },
    )


def plan_unpin_message(input_value: Mapping[str, Any]) -> JsonObject:
    message_pin = _as_string(input_value.get("messagePin"))
    space = _as_string(input_value.get("space"))
    message = _as_string(input_value.get("message"))

    if message_pin:
        name = _required_message_pin(input_value)
        return _call_plan(
            "pins.unpin",
            input_value,
            [CHAT_SPACES_PINS_SCOPE],
            [
                {
                    "resource": "spaces.messagePins.delete",
                    "method": "DELETE",
                    "path": _chat_path(name),
                    "query": {},
                    "body": None,
                }
            ],
            extra={
                "pin": {
                    "action": "unpin",
                    "strategy": "direct",
                    "name": name,
                }
            },
        )

    if space and message:
        validated_message = _message_for_space(input_value, space)
        name = _message_pin_name_for_message(validated_message)
        return _call_plan(
            "pins.unpin",
            input_value,
            [CHAT_SPACES_PINS_SCOPE],
            [
                {
                    "resource": "spaces.messagePins.delete",
                    "method": "DELETE",
                    "path": _chat_path(name),
                    "query": {},
                    "body": None,
                }
            ],
            extra={
                "pin": {
                    "action": "unpin",
                    "strategy": "derived-from-message",
                    "space": space,
                    "message": validated_message,
                    "name": name,
                }
            },
        )

    raise TypeError(
        "Expected messagePin, or both space and message, to be non-empty strings."
    )


def plan_list_message_pins(input_value: Mapping[str, Any]) -> JsonObject:
    space = _required_string(input_value, "space")
    query = _list_query(input_value)

    return _call_plan(
        "pins.list",
        input_value,
        [CHAT_SPACES_PINS_READONLY_SCOPE],
        [_list_message_pins_request(space, query)],
        extra={
            "pin": {
                "action": "list",
                "space": space,
                "pageSize": _as_number(query.get("pageSize")),
                "pageToken": _as_string(query.get("pageToken")),
            }
        },
    )


def plan_ensure_message_pinned(input_value: Mapping[str, Any]) -> JsonObject:
    space = _required_string(input_value, "space")
    message = _message_for_space(input_value, space)
    query = _complete_pin_list_query(input_value)

    create_request = _create_message_pin_request(space, message)
    create_request["condition"] = {
        "kind": "message_pin_absent",
        "message": message,
        "requiresCompleteList": True,
    }

    return _call_plan(
        "pins.ensurePinned",
        input_value,
        [CHAT_SPACES_PINS_SCOPE],
        [_list_message_pins_request(space, query), create_request],
        extra={
            "ensure": {
                "strategy": "list-then-pin-if-absent",
                "alreadyPinnedAction": "skip",
                "requiresCompleteList": True,
            },
            "pin": {
                "action": "ensurePinned",
                "space": space,
                "message": message,
                "pageSize": MAX_PAGE_SIZE,
                "pageToken": None,
            },
        },
    )
