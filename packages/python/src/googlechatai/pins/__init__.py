"""Dry-run Google Chat message-pin call planners."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


JsonObject = dict[str, Any]

PIN_MESSAGES_SCOPE = "https://www.googleapis.com/auth/chat.messages"

CHAT_PIN_DOCS_LISTED_NOTE = (
    "spaces.messagePins.* is a docs-listed surface; verify live support before relying on it."
)

DRY_RUN_NOTE = "Dry run only; no Google Chat API call was executed."
DEFAULT_PAGE_SIZE = 100
MIN_PAGE_SIZE = 1
MAX_PAGE_SIZE = 1000
RESOLVED_MESSAGE_PIN_PLACEHOLDER = "/v1/{resolvedMessagePin}"


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _as_number(value: Any) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _required_string(input_value: Mapping[str, Any], key: str) -> str:
    value = _as_string(input_value.get(key))
    if not value:
        raise TypeError(f"Expected {key} to be a non-empty string.")
    return value


def _auth_mode(input_value: Mapping[str, Any]) -> str:
    return _as_string(input_value.get("authMode")) or "app"


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
    return {
        "ok": ok,
        "authMode": _auth_mode(input_value),
        "requiredScopes": required_scopes,
        "reasons": reasons or [],
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
    plan["warnings"] = [CHAT_PIN_DOCS_LISTED_NOTE, *(warnings or [])]
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


def _list_message_pins_request(space: str, query: JsonObject) -> JsonObject:
    return {
        "resource": "spaces.messagePins.list",
        "method": "GET",
        "path": _chat_path(f"{space}/messagePins"),
        "query": query,
        "body": None,
    }


def plan_pin_message(input_value: Mapping[str, Any]) -> JsonObject:
    space = _required_string(input_value, "space")
    message = _required_string(input_value, "message")

    return _call_plan(
        "pins.pin",
        input_value,
        [PIN_MESSAGES_SCOPE],
        [
            {
                "resource": "spaces.messagePins.create",
                "method": "POST",
                "path": _chat_path(f"{space}/messagePins"),
                "query": {},
                "body": {"messagePin": {"message": message}},
            }
        ],
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
        return _call_plan(
            "pins.unpin",
            input_value,
            [PIN_MESSAGES_SCOPE],
            [
                {
                    "resource": "spaces.messagePins.delete",
                    "method": "DELETE",
                    "path": _chat_path(message_pin),
                    "query": {},
                    "body": None,
                }
            ],
            extra={
                "pin": {
                    "action": "unpin",
                    "strategy": "direct",
                    "name": message_pin,
                }
            },
        )

    if space and message:
        return _call_plan(
            "pins.unpin",
            input_value,
            [PIN_MESSAGES_SCOPE],
            [
                _list_message_pins_request(space, _list_query(input_value)),
                {
                    "resource": "spaces.messagePins.delete",
                    "method": "DELETE",
                    "path": RESOLVED_MESSAGE_PIN_PLACEHOLDER,
                    "query": {},
                    "body": None,
                },
            ],
            warnings=[
                "The message pin name is not derivable from space and message alone; list message pins first and resolve the matching messagePin name before deleting."
            ],
            extra={
                "pin": {
                    "action": "unpin",
                    "strategy": "list-then-delete",
                    "space": space,
                    "message": message,
                    "resolvedMessagePinPlaceholder": RESOLVED_MESSAGE_PIN_PLACEHOLDER,
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
        [PIN_MESSAGES_SCOPE],
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
    message = _required_string(input_value, "message")
    query = _list_query(input_value)

    return _call_plan(
        "pins.ensurePinned",
        input_value,
        [PIN_MESSAGES_SCOPE],
        [
            _list_message_pins_request(space, query),
            {
                "resource": "spaces.messagePins.create",
                "method": "POST",
                "path": _chat_path(f"{space}/messagePins"),
                "query": {},
                "body": {"messagePin": {"message": message}},
            },
        ],
        extra={
            "ensure": {
                "strategy": "list-then-pin",
                "alreadyPinnedAction": "skip",
            },
            "pin": {
                "action": "ensurePinned",
                "space": space,
                "message": message,
                "pageSize": _as_number(query.get("pageSize")),
                "pageToken": _as_string(query.get("pageToken")),
            },
        },
    )
