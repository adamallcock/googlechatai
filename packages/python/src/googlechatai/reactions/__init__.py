"""Dry-run Google Chat reaction call planners."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


JsonObject = dict[str, Any]

CHAT_REACTIONS_SCOPE = "https://www.googleapis.com/auth/chat.messages.reactions"
CHAT_REACTIONS_READONLY_SCOPE = (
    "https://www.googleapis.com/auth/chat.messages.reactions.readonly"
)

DRY_RUN_NOTE = "Dry run only; no Google Chat API call was executed."
USER_AUTH_REQUIRED_REASON = (
    "Google Chat reactions require user authentication; use the submitting user's token for visible feedback."
)
FEEDBACK_USER_AUTH_WARNING = (
    "Feedback reactions should use the submitting user's credentials so Chat shows the human's reaction."
)

POSITIVE_FEEDBACK_RATINGS = {
    "up",
    "thumbs_up",
    "thumbsup",
    "helpful",
    "positive",
    "yes",
    "like",
}

NEGATIVE_FEEDBACK_RATINGS = {
    "down",
    "thumbs_down",
    "thumbsdown",
    "not_helpful",
    "nothelpful",
    "negative",
    "no",
    "dislike",
}


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _as_number(value: Any) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _as_bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _as_mapping(value: Any) -> Mapping[str, Any] | None:
    return value if isinstance(value, Mapping) else None


def _clean_record(value: Mapping[str, Any]) -> JsonObject:
    return {key: item for key, item in value.items() if item is not None}


def _required_string(input_value: Mapping[str, Any], key: str) -> str:
    value = _as_string(input_value.get(key))
    if not value:
        raise TypeError(f"Expected {key} to be a non-empty string.")
    return value


def _auth_mode(input_value: Mapping[str, Any]) -> str:
    return _as_string(input_value.get("authMode")) or "user"


def _chat_path(resource_name: str) -> str:
    return f"/v1/{resource_name}"


def _capability(
    input_value: Mapping[str, Any],
    required_scopes: list[str],
    ok: bool = True,
    reasons: list[str] | None = None,
) -> JsonObject:
    mode = _auth_mode(input_value)
    user_auth_ok = not required_scopes or mode == "user"

    return {
        "ok": ok and user_auth_ok,
        "authMode": mode,
        "requiredScopes": required_scopes,
        "reasons": (reasons or [])
        if user_auth_ok
        else [*(reasons or []), USER_AUTH_REQUIRED_REASON],
    }


def _safety() -> JsonObject:
    return {
        "liveAllowed": False,
        "directMessage": False,
        "notes": [DRY_RUN_NOTE],
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
    plan["warnings"] = warnings or []
    return plan


def _escape_filter_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _normalize_custom_emoji(raw: Mapping[str, Any]) -> JsonObject:
    return _clean_record(
        {
            "uid": _as_string(raw.get("uid")),
            "name": _as_string(raw.get("name")),
            "emojiName": _as_string(raw.get("emojiName")),
        }
    )


def _normalize_emoji(value: Any) -> tuple[JsonObject, JsonObject]:
    direct_unicode = _as_string(value)
    if direct_unicode:
        return (
            {"unicode": direct_unicode},
            {
                "type": "unicode",
                "unicode": direct_unicode,
                "customEmoji": None,
            },
        )

    raw = _as_mapping(value)
    unicode = _as_string(raw.get("unicode")) if raw else None
    if unicode:
        return (
            {"unicode": unicode},
            {
                "type": "unicode",
                "unicode": unicode,
                "customEmoji": None,
            },
        )

    custom_emoji_raw = _as_mapping(raw.get("customEmoji")) if raw else None
    custom_emoji = (
        _normalize_custom_emoji(custom_emoji_raw) if custom_emoji_raw else {}
    )
    if custom_emoji:
        return (
            {"customEmoji": custom_emoji},
            {
                "type": "custom",
                "unicode": None,
                "customEmoji": custom_emoji,
            },
        )

    raise TypeError(
        "Expected emoji to be a unicode string or an object with unicode/customEmoji."
    )


def _query_from(input_value: Mapping[str, Any]) -> JsonObject:
    query: JsonObject = {}
    page_size = _as_number(input_value.get("pageSize"))
    page_token = _as_string(input_value.get("pageToken"))
    filter_query = _as_string(input_value.get("filter"))

    if page_size is not None:
        query["pageSize"] = max(1, min(200, int(page_size)))
    if page_token:
        query["pageToken"] = page_token
    if filter_query:
        query["filter"] = filter_query

    return query


def build_reaction_filter_for_emoji(emoji: Any) -> str:
    body, _summary = _normalize_emoji(emoji)
    unicode = _as_string(body.get("unicode"))
    if unicode:
        return f'emoji.unicode = "{_escape_filter_string(unicode)}"'

    custom_emoji = _as_mapping(body.get("customEmoji")) or {}
    uid = _as_string(custom_emoji.get("uid"))
    if uid:
        return f'emoji.custom_emoji.uid = "{_escape_filter_string(uid)}"'

    raise TypeError("Expected customEmoji.uid when building a custom emoji reaction filter.")


def feedback_rating_to_emoji(rating: Any) -> JsonObject:
    raw = _as_string(rating)
    if not raw or not raw.strip():
        raise TypeError("Expected feedback rating to be a non-empty string.")
    raw = raw.strip()
    normalized = ""
    for index, char in enumerate(raw):
        previous = raw[index - 1] if index > 0 else ""
        if char.isupper() and previous and previous.islower():
            normalized += "_"
        normalized += "_" if char in {" ", "-"} else char
    normalized = normalized.lower()
    compact = normalized.replace("_", "")

    if normalized in POSITIVE_FEEDBACK_RATINGS or compact in POSITIVE_FEEDBACK_RATINGS:
        return {"unicode": "\U0001F44D"}
    if normalized in NEGATIVE_FEEDBACK_RATINGS or compact in NEGATIVE_FEEDBACK_RATINGS:
        return {"unicode": "\U0001F44E"}

    raise TypeError(f"Unsupported feedback rating: {raw}.")


def plan_add_reaction(input_value: Mapping[str, Any]) -> JsonObject:
    message = _required_string(input_value, "message")
    emoji_body, emoji_summary = _normalize_emoji(input_value.get("emoji"))

    return _call_plan(
        "reactions.add",
        input_value,
        [CHAT_REACTIONS_SCOPE],
        [
            {
                "resource": "spaces.messages.reactions.create",
                "method": "POST",
                "path": _chat_path(f"{message}/reactions"),
                "query": {},
                "body": {"emoji": emoji_body},
            }
        ],
        extra={
            "reaction": {
                "action": "add",
                "message": message,
                "emoji": emoji_summary,
                "filter": build_reaction_filter_for_emoji(emoji_body),
                "userVisible": True,
            }
        },
    )


def plan_feedback_reaction(input_value: Mapping[str, Any]) -> JsonObject:
    message = _required_string(input_value, "message")
    rating = _required_string(input_value, "rating")
    response_id = _as_string(input_value.get("responseId"))
    visible_reaction = (
        _as_bool(input_value.get("visibleReaction"))
        if _as_bool(input_value.get("visibleReaction")) is not None
        else _as_bool(input_value.get("enabled"))
    )
    if visible_reaction is None:
        visible_reaction = True

    if not visible_reaction:
        return _call_plan(
            "reactions.feedback",
            input_value,
            [],
            [],
            extra={
                "feedback": {
                    "rating": rating,
                    "responseId": response_id,
                    "visibleReaction": False,
                    "systemNotes": [
                        "System Note: Feedback was recorded without adding a visible Google Chat reaction."
                    ],
                }
            },
        )

    emoji_body, emoji_summary = _normalize_emoji(feedback_rating_to_emoji(rating))
    warnings = [] if _auth_mode(input_value) == "user" else [FEEDBACK_USER_AUTH_WARNING]

    return _call_plan(
        "reactions.feedback",
        input_value,
        [CHAT_REACTIONS_SCOPE],
        [
            {
                "resource": "spaces.messages.reactions.create",
                "method": "POST",
                "path": _chat_path(f"{message}/reactions"),
                "query": {},
                "body": {"emoji": emoji_body},
            }
        ],
        warnings=warnings,
        extra={
            "reaction": {
                "action": "add",
                "message": message,
                "emoji": emoji_summary,
                "filter": build_reaction_filter_for_emoji(emoji_body),
                "userVisible": True,
            },
            "feedback": {
                "rating": rating,
                "responseId": response_id,
                "visibleReaction": True,
                "systemNotes": [
                    f"System Note: Feedback rating {rating} will also add a visible {emoji_body.get('unicode') or 'emoji'} reaction from the submitting user."
                ],
            },
        },
    )


def plan_list_reactions(input_value: Mapping[str, Any]) -> JsonObject:
    message = _required_string(input_value, "message")
    query = _query_from(input_value)

    return _call_plan(
        "reactions.list",
        input_value,
        [CHAT_REACTIONS_READONLY_SCOPE],
        [
            {
                "resource": "spaces.messages.reactions.list",
                "method": "GET",
                "path": _chat_path(f"{message}/reactions"),
                "query": query,
                "body": None,
            }
        ],
        extra={
            "reaction": {
                "action": "list",
                "message": message,
                "filter": _as_string(query.get("filter")),
                "pageSize": _as_number(query.get("pageSize")),
                "pageToken": _as_string(query.get("pageToken")),
            }
        },
    )


def plan_delete_reaction(input_value: Mapping[str, Any]) -> JsonObject:
    reaction = _required_string(input_value, "reaction")

    return _call_plan(
        "reactions.delete",
        input_value,
        [CHAT_REACTIONS_SCOPE],
        [
            {
                "resource": "spaces.messages.reactions.delete",
                "method": "DELETE",
                "path": _chat_path(reaction),
                "query": {},
                "body": None,
            }
        ],
        extra={
            "reaction": {
                "action": "delete",
                "name": reaction,
            }
        },
    )
