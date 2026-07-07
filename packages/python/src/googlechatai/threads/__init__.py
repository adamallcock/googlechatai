"""Thread and space context planning/rendering helpers."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any

from ..identity import render_identity_system_note, resolve_human_identity


JsonObject = dict[str, Any]
APP_SCOPE = "https://www.googleapis.com/auth/chat.bot"
USER_READ_SCOPE = "https://www.googleapis.com/auth/chat.messages.readonly"
DRY_RUN_NOTE = "Dry run only; no Google Chat API call was executed."
DEFAULT_CHARS_PER_TOKEN = 4
IDENTITY_ENRICHMENT_SKIPPED_NOTE = (
    "System Note: Identity enrichment was skipped because the identity cache was unavailable."
)


def _as_mapping(value: Any) -> Mapping[str, Any] | None:
    return value if isinstance(value, Mapping) else None


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _as_number(value: Any) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _required_string(input_value: Mapping[str, Any], key: str) -> str:
    value = _as_string(input_value.get(key))
    if not value:
        raise TypeError(f"Expected {key} to be a non-empty string.")
    return value


def _auth_mode(input_value: Mapping[str, Any]) -> str:
    return _as_string(input_value.get("authMode")) or "app"


def _required_read_scopes(mode: str) -> list[str]:
    return [USER_READ_SCOPE] if mode == "user" else [APP_SCOPE]


def _optional_number(input_value: Mapping[str, Any], key: str, fallback: int) -> int | float:
    return _as_number(input_value.get(key)) or fallback


def _optional_string(input_value: Mapping[str, Any], key: str) -> str | None:
    return _as_string(input_value.get(key))


def _optional_positive_integer(input_value: Mapping[str, Any], key: str) -> int | None:
    value = _as_number(input_value.get(key))
    return int(value) if value is not None and value > 0 else None


def _optional_non_negative_integer(input_value: Mapping[str, Any], key: str) -> int | None:
    value = _as_number(input_value.get(key))
    return int(value) if value is not None and value >= 0 else None


def _model_token_budget_strategy(input_value: Mapping[str, Any]) -> str:
    strategy = _optional_string(input_value, "contextBudgetStrategy")
    return strategy if strategy == "preserve_order" else "preserve_order"


def _model_token_budget_config(input_value: Mapping[str, Any]) -> JsonObject | None:
    max_tokens = _optional_positive_integer(input_value, "maxContextTokens")
    if max_tokens is None:
        return None

    reserve_output_tokens = _optional_non_negative_integer(
        input_value,
        "reserveOutputTokens",
    ) or 0
    chars_per_token = _as_number(input_value.get("charsPerToken"))
    estimator_chars_per_token = (
        chars_per_token
        if chars_per_token is not None and chars_per_token > 0
        else DEFAULT_CHARS_PER_TOKEN
    )

    return {
        "maxTokens": max_tokens,
        "reserveOutputTokens": reserve_output_tokens,
        "availableTokens": max(0, max_tokens - reserve_output_tokens),
        "strategy": _model_token_budget_strategy(input_value),
        "estimator": {
            "strategy": "chars_per_token",
            "charsPerToken": estimator_chars_per_token,
        },
    }


def _reader_config(input_value: Mapping[str, Any], scope: str) -> JsonObject:
    limit = _optional_number(input_value, "limit", 50)
    reader: JsonObject = {
        "scope": scope,
        "space": _required_string(input_value, "space"),
        "thread": _required_string(input_value, "thread") if scope == "thread" else None,
        "limit": limit,
        "pageSize": _optional_number(input_value, "pageSize", min(int(limit), 100)),
        "order": _optional_string(input_value, "order") or "asc",
        "pageToken": _optional_string(input_value, "pageToken"),
        "startTime": _optional_string(input_value, "startTime"),
        "endTime": _optional_string(input_value, "endTime"),
        "maxQuoteDepth": _optional_number(input_value, "maxQuoteDepth", 1),
    }
    budget = _model_token_budget_config(input_value)
    if budget:
        reader["modelTokenBudget"] = budget
    return reader


def _build_filter(reader: Mapping[str, Any]) -> str | None:
    clauses = []
    start_time = _as_string(reader.get("startTime"))
    end_time = _as_string(reader.get("endTime"))
    thread = _as_string(reader.get("thread"))

    if start_time:
        clauses.append(f'createTime > "{start_time}"')
    if end_time:
        clauses.append(f'createTime < "{end_time}"')
    if thread:
        clauses.append(f'thread.name = "{thread}"')

    return " AND ".join(clauses) if clauses else None


def _plan_reader(input_value: Mapping[str, Any], scope: str) -> JsonObject:
    reader = _reader_config(input_value, scope)
    mode = _auth_mode(input_value)
    query: JsonObject = {
        "pageSize": reader["pageSize"],
    }
    page_token = _as_string(reader.get("pageToken"))
    filter_value = _build_filter(reader)

    if page_token:
        query["pageToken"] = page_token
    if filter_value:
        query["filter"] = filter_value
    query["orderBy"] = f"createTime {reader['order']}"

    return {
        "kind": "chat.call_plan",
        "operation": "threads.readContext"
        if scope == "thread"
        else "threads.readSpaceContext",
        "dryRun": True,
        "capability": {
            "ok": True,
            "authMode": mode,
            "requiredScopes": _required_read_scopes(mode),
            "reasons": [],
        },
        "requests": [
            {
                "resource": "spaces.messages.list",
                "method": "GET",
                "path": f"/v1/{reader['space']}/messages",
                "query": query,
                "body": None,
            }
        ],
        "reader": reader,
        "safety": {
            "liveAllowed": False,
            "directMessage": False,
            "notes": [DRY_RUN_NOTE],
        },
        "warnings": [],
    }


def plan_read_thread_context(input_value: Mapping[str, Any]) -> JsonObject:
    return _plan_reader(input_value, "thread")


def plan_read_space_context(input_value: Mapping[str, Any]) -> JsonObject:
    return _plan_reader(input_value, "space")


def _normalize_identity(value: Any) -> JsonObject:
    raw = _as_mapping(value)
    if not raw:
        return {
            "name": None,
            "displayName": "Unknown sender",
            "email": None,
            "type": "UNKNOWN",
            "access": "inaccessible",
        }

    return {
        "name": _as_string(raw.get("name")),
        "displayName": _as_string(raw.get("displayName"))
        or _as_string(raw.get("name"))
        or "Unknown sender",
        "email": _as_string(raw.get("email")),
        "type": _as_string(raw.get("type")) or "UNKNOWN",
        "access": "available",
    }


def _identity_label(identity: Mapping[str, Any]) -> str:
    display_name = _as_string(identity.get("displayName")) or "Unknown sender"
    email = _as_string(identity.get("email"))
    return f"{display_name} ({email})" if email else display_name


def _thread_name(raw: Mapping[str, Any]) -> str | None:
    thread = _as_mapping(raw.get("thread"))
    return _as_string(thread.get("name")) if thread else None


def _message_name(raw: Mapping[str, Any]) -> str:
    return _as_string(raw.get("name")) or "{unknownMessage}"


def _last_resource_segment(value: str | None) -> str | None:
    if not value:
        return None
    return value.split("/")[-1] or None


def _space_from_thread_name(value: str | None) -> str | None:
    if not value:
        return None
    parts = value.split("/")
    if len(parts) == 4 and parts[0] == "spaces" and parts[2] == "threads":
        return f"{parts[0]}/{parts[1]}"
    return None


def _infer_thread_reply_parent(
    raw: Mapping[str, Any],
    thread: str | None,
    thread_root_names: set[str] | None = None,
) -> str | None:
    message_id = _last_resource_segment(_message_name(raw))
    thread_id = _last_resource_segment(thread)
    space = _space_from_thread_name(thread)
    if not message_id or not thread_id or not space:
        return None

    message_thread_id, separator, reply_id = message_id.partition(".")
    if (
        message_thread_id != thread_id
        or not separator
        or not reply_id
        or reply_id == message_thread_id
    ):
        return None

    if thread_root_names and len(thread_root_names) == 1:
        return next(iter(thread_root_names))

    return f"{space}/messages/{thread_id}.{thread_id}"


def _infer_thread_root_names(
    messages: Sequence[Mapping[str, Any]],
    reader_thread: str | None,
    truncated: bool,
) -> set[str]:
    roots: set[str] = set()
    thread_id = _last_resource_segment(reader_thread)
    if not reader_thread or not thread_id:
        return roots

    for message in messages:
        message_id = _last_resource_segment(_message_name(message))
        if not message_id:
            continue
        message_thread_id, separator, message_id_suffix = message_id.partition(".")
        if separator and message_thread_id == thread_id and message_id_suffix == thread_id:
            roots.add(_message_name(message))

    if roots or truncated:
        return roots

    candidates = []
    for message in messages:
        message_id = _last_resource_segment(_message_name(message))
        if not message_id:
            continue
        message_thread_id, separator, message_id_suffix = message_id.partition(".")
        if (
            not _as_string(message.get("replyTo"))
            and separator
            and message_thread_id == thread_id
            and message_id_suffix
        ):
            candidates.append(message)

    if candidates:
        fallback_root = sorted(
            candidates,
            key=lambda item: _as_string(item.get("createTime")) or "",
        )[0]
        roots.add(_message_name(fallback_root))

    return roots


def _normalize_attachment(value: Any) -> JsonObject | None:
    raw = _as_mapping(value)
    name = _as_string(raw.get("name")) if raw else None

    if not raw or not name:
        return None

    attachment_data_ref = _as_mapping(raw.get("attachmentDataRef")) or {}
    drive_data_ref = _as_mapping(raw.get("driveDataRef")) or {}
    attachment: JsonObject = {
        "name": name,
        "contentName": _as_string(raw.get("contentName")),
        "contentType": _as_string(raw.get("contentType")),
        "source": _as_string(raw.get("source")),
        "mediaResourceName": _as_string(attachment_data_ref.get("resourceName")),
    }
    if drive_data_ref:
        attachment["driveDataRef"] = {
            **drive_data_ref,
            "driveFileId": _as_string(drive_data_ref.get("driveFileId")),
        }
    size_bytes = _as_number(raw.get("sizeBytes"))
    if size_bytes is not None:
        attachment["sizeBytes"] = size_bytes
    return attachment


def _normalize_attachments(raw: Mapping[str, Any]) -> list[JsonObject]:
    attachments = []
    for item in [*_as_list(raw.get("attachment")), *_as_list(raw.get("attachments"))]:
        attachment = _normalize_attachment(item)
        if attachment is not None:
            attachments.append(attachment)
    return attachments


def _effective_message_time(raw: Mapping[str, Any]) -> str | None:
    return _as_string(raw.get("lastUpdateTime")) or _as_string(raw.get("createTime"))


def _parse_timestamp_ms(value: str) -> float | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def _timestamps_compatible(left: str | None, right: str | None) -> bool:
    if not left or not right:
        return True
    if left == right:
        return True

    left_ms = _parse_timestamp_ms(left)
    right_ms = _parse_timestamp_ms(right)
    if left_ms is None or right_ms is None:
        return False
    return abs(left_ms - right_ms) <= 1000


def _lookup_quoted_message(
    metadata: Mapping[str, Any],
    quote_lookup: Mapping[str, Mapping[str, Any]],
) -> Mapping[str, Any] | None:
    name = _as_string(metadata.get("name"))
    if not name:
        return None

    found = quote_lookup.get(name)
    if not found:
        return None

    quoted_time = _as_string(metadata.get("lastUpdateTime"))
    if not _timestamps_compatible(quoted_time, _effective_message_time(found)):
        return None

    return found


def _quoted_snapshot_message(
    metadata: Mapping[str, Any],
    quote_lookup: Mapping[str, Mapping[str, Any]],
) -> JsonObject | None:
    direct = _as_mapping(metadata.get("message")) or _as_mapping(
        metadata.get("quotedMessage")
    )
    if direct:
        return {
            **direct,
            "name": _as_string(direct.get("name")) or _as_string(metadata.get("name")),
        }

    looked_up = _lookup_quoted_message(metadata, quote_lookup)
    if looked_up:
        return dict(looked_up)

    snapshot = _as_mapping(metadata.get("quotedMessageSnapshot"))
    if not snapshot:
        return None

    sender_name = _as_string(snapshot.get("sender"))
    last_update_time = _as_string(metadata.get("lastUpdateTime"))
    return {
        "name": _as_string(metadata.get("name")),
        "createTime": last_update_time,
        "sender": {
            "name": sender_name,
            "displayName": sender_name,
            "type": "UNKNOWN",
        }
        if sender_name
        else None,
        "text": _as_string(snapshot.get("text")),
        "formattedText": _as_string(snapshot.get("formattedText")),
        "annotations": _as_list(snapshot.get("annotations")),
        "attachments": _as_list(snapshot.get("attachments")),
        "quoteType": _as_string(metadata.get("quoteType")),
    }


def _quoted_message_records(
    raw: Mapping[str, Any],
    quote_lookup: Mapping[str, Mapping[str, Any]],
) -> list[JsonObject]:
    records = [
        item
        for item in (_as_mapping(value) for value in _as_list(raw.get("quotedMessages")))
        if item is not None
    ]
    metadata = _as_mapping(raw.get("quotedMessageMetadata"))
    metadata_message = _quoted_snapshot_message(metadata, quote_lookup) if metadata else None

    if not metadata_message:
        return records

    metadata_name = _as_string(metadata_message.get("name"))
    if metadata_name and any(_as_string(item.get("name")) == metadata_name for item in records):
        return records

    return [*records, metadata_message]


def _build_relationship(
    raw: Mapping[str, Any],
    scope: str,
    reader_thread: str | None,
    thread_root_names: set[str] | None = None,
) -> JsonObject:
    if scope == "quote":
        return {
            "kind": "quote",
            "thread": _thread_name(raw),
            "parentMessage": None,
        }

    thread = _thread_name(raw) or reader_thread
    if thread_root_names and _message_name(raw) in thread_root_names:
        return {
            "kind": "thread_root",
            "thread": thread,
            "parentMessage": None,
        }
    parent_message = _as_string(raw.get("replyTo")) or (
        _infer_thread_reply_parent(raw, thread, thread_root_names)
        if scope == "thread"
        else None
    )

    if parent_message:
        return {
            "kind": "thread_reply",
            "thread": thread,
            "parentMessage": parent_message,
        }

    if scope == "thread":
        return {
            "kind": "thread_root",
            "thread": thread,
            "parentMessage": None,
        }

    return {
        "kind": "space_message",
        "thread": thread,
        "parentMessage": None,
    }


def _attachment_note(attachment: Mapping[str, Any]) -> str:
    name = (
        _as_string(attachment.get("contentName"))
        or _as_string(attachment.get("name"))
        or "attachment"
    )
    content_type = _as_string(attachment.get("contentType")) or "unknown content type"
    size = _as_number(attachment.get("sizeBytes"))
    size_text = "unknown size" if size is None else f"{size} bytes"
    return (
        f"System Note: The user attached {name} ({content_type}, {size_text}) "
        "with this message."
    )


def _reaction_notes(raw: Mapping[str, Any]) -> list[str]:
    notes = []
    for item in _as_list(raw.get("emojiReactionSummaries")):
        reaction = _as_mapping(item)
        if not reaction:
            continue
        emoji = _as_mapping(reaction.get("emoji")) or {}
        custom_emoji = _as_mapping(emoji.get("customEmoji")) or {}
        label = (
            _as_string(emoji.get("unicode"))
            or _as_string(custom_emoji.get("name"))
            or "unknown emoji"
        )
        count = _as_number(reaction.get("reactionCount")) or _as_number(reaction.get("count")) or 0
        notes.append(f"System Note: Reaction {label} appears {count} times on this message.")
    return notes


def _custom_emoji_notes(raw: Mapping[str, Any]) -> list[str]:
    notes = []
    for item in _as_list(raw.get("annotations")):
        annotation = _as_mapping(item)
        metadata = _as_mapping(annotation.get("customEmojiMetadata")) if annotation else None
        custom_emoji = _as_mapping(metadata.get("customEmoji")) if metadata else None
        if not annotation or (not metadata and annotation.get("type") != "CUSTOM_EMOJI"):
            continue

        label = (
            _as_string(custom_emoji.get("emojiName")) if custom_emoji else None
        ) or (_as_string(custom_emoji.get("name")) if custom_emoji else None) or "custom emoji"
        name = _as_string(custom_emoji.get("name")) if custom_emoji else None
        name_text = f" ({name})" if name and name != label else ""
        notes.append(
            f"System Note: Custom emoji {label}{name_text} appears in this message."
        )
    return notes


def _action_notes(raw: Mapping[str, Any]) -> list[str]:
    notes = []
    for item in _as_list(raw.get("actionAnnotations")):
        action = _as_mapping(item)
        if not action:
            continue
        actor = _normalize_identity(action.get("actor"))
        method_name = _as_string(action.get("methodName")) or "unknown_action"
        action_time = _as_string(action.get("actionTime")) or "an unknown time"
        notes.append(
            "System Note: "
            f"{_as_string(actor.get('displayName')) or 'Unknown sender'} "
            f"clicked card action {method_name} at {action_time}."
        )
    return notes


def _cycle_node(name: str) -> JsonObject:
    return {
        "ref": {"name": name},
        "sender": _normalize_identity(None),
        "createdAt": None,
        "updatedAt": None,
        "deletedAt": None,
        "relationship": {
            "kind": "quote",
            "thread": None,
            "parentMessage": None,
        },
        "text": "",
        "plainTextForModel": "",
        "attachments": [],
        "quotedMessages": [],
        "systemNotes": [
            f"System Note: Quoted message {name} was skipped because it would create a cycle."
        ],
    }


def _depth_node(name: str, max_depth: int | float) -> JsonObject:
    return {
        "ref": {"name": name},
        "sender": _normalize_identity(None),
        "createdAt": None,
        "updatedAt": None,
        "deletedAt": None,
        "relationship": {
            "kind": "quote",
            "thread": None,
            "parentMessage": None,
        },
        "text": "",
        "plainTextForModel": "",
        "attachments": [],
        "quotedMessages": [],
        "systemNotes": [
            f"System Note: Quoted message {name} was skipped because max quote depth {max_depth} was reached."
        ],
    }


def _normalize_context_message(
    raw: Mapping[str, Any],
    *,
    scope: str,
    reader_thread: str | None,
    max_quote_depth: int | float,
    depth: int,
    visited: set[str],
    quote_lookup: Mapping[str, Mapping[str, Any]],
    thread_root_names: set[str] | None = None,
) -> JsonObject:
    name = _message_name(raw)

    if scope == "quote" and name in visited:
        return _cycle_node(name)
    if scope == "quote" and depth > max_quote_depth:
        return _depth_node(name, max_quote_depth)

    next_visited = set(visited)
    next_visited.add(name)

    sender = _normalize_identity(raw.get("sender"))
    created_at = _as_string(raw.get("createTime"))
    updated_at = _as_string(raw.get("lastUpdateTime"))
    attachments = _normalize_attachments(raw)
    relationship = _build_relationship(raw, scope, reader_thread, thread_root_names)
    text = _as_string(raw.get("text")) or ""
    quoted_messages = [
        _normalize_context_message(
            item,
            scope="quote",
            reader_thread=reader_thread,
            max_quote_depth=max_quote_depth,
            depth=depth + 1,
            visited=next_visited,
            quote_lookup=quote_lookup,
            thread_root_names=thread_root_names,
        )
        for item in _quoted_message_records(raw, quote_lookup)
    ]
    system_notes = [
        f"System Note: {_identity_label(sender)} sent this message at {created_at or 'an unknown time'}."
    ]

    if scope == "quote":
        system_notes.append("System Note: This message was included as quoted context.")
    elif relationship["kind"] == "thread_root":
        system_notes.append(
            f"System Note: This message is the root message in thread {relationship['thread']}."
        )
    elif relationship["kind"] == "thread_reply":
        system_notes.append(
            "System Note: This message is a reply in thread "
            f"{relationship['thread']} to {relationship['parentMessage']}."
        )

    if scope != "quote":
        for quoted in quoted_messages:
            quoted_ref = _as_mapping(quoted.get("ref")) or {}
            quoted_name = _as_string(quoted_ref.get("name"))
            if quoted_name:
                system_notes.append(
                    "System Note: "
                    f"{_as_string(sender.get('displayName')) or 'Unknown sender'} "
                    f"quoted {quoted_name} in this message."
                )

    for attachment in attachments:
        system_notes.append(_attachment_note(attachment))

    card_count = len(_as_list(raw.get("cardsV2"))) + len(_as_list(raw.get("cards")))
    if card_count > 0:
        system_notes.append(
            f"System Note: This message includes {card_count} card object."
        )

    system_notes.extend(_custom_emoji_notes(raw))
    system_notes.extend(_action_notes(raw))

    if updated_at:
        system_notes.append(f"System Note: This message was edited at {updated_at}.")

    if "deletionMetadata" in raw or "deleteTime" in raw:
        system_notes.append(
            "System Note: This message was deleted and content is unavailable."
        )

    system_notes.extend(_reaction_notes(raw))

    return {
        "ref": {"name": name},
        "sender": sender,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "deletedAt": _as_string(raw.get("deleteTime")),
        "relationship": relationship,
        "text": text,
        "plainTextForModel": text,
        "attachments": attachments,
        "quotedMessages": quoted_messages,
        "systemNotes": system_notes,
    }


def _text_parts_for_budget(message: Mapping[str, Any]) -> list[str]:
    system_notes = [
        note
        for note in (_as_string(item) for item in _as_list(message.get("systemNotes")))
        if note is not None
    ]
    text = _as_string(message.get("plainTextForModel")) or _as_string(message.get("text"))
    quote_text = [
        part
        for quote in (_as_mapping(item) for item in _as_list(message.get("quotedMessages")))
        if quote is not None
        for part in _text_parts_for_budget(quote)
    ]
    return [
        *system_notes,
        *([text] if text and text.strip() else []),
        *quote_text,
    ]


def _estimate_tokens_for_message(message: Mapping[str, Any], chars_per_token: int | float) -> int:
    text = "\n".join(_text_parts_for_budget(message))
    if not text:
        return 0
    return max(1, math.ceil(len(text) / chars_per_token))


def _apply_model_token_budget(
    input_value: Mapping[str, Any],
    messages: list[JsonObject],
    system_notes: list[str],
) -> tuple[list[JsonObject], list[str], JsonObject | None]:
    config = _model_token_budget_config(input_value)
    if not config:
        return messages, system_notes, None

    estimator = _as_mapping(config.get("estimator")) or {}
    chars_per_token = _as_number(estimator.get("charsPerToken")) or DEFAULT_CHARS_PER_TOKEN
    available_tokens = _as_number(config.get("availableTokens")) or 0
    token_counts = [
        _estimate_tokens_for_message(message, chars_per_token)
        for message in messages
    ]
    estimated_tokens_before = sum(token_counts)
    included: list[JsonObject] = []
    estimated_tokens_after = 0

    for message, tokens in zip(messages, token_counts, strict=True):
        if estimated_tokens_after + tokens <= available_tokens:
            included.append(message)
            estimated_tokens_after += tokens

    dropped_messages = len(messages) - len(included)
    next_system_notes = list(system_notes)
    if dropped_messages:
        next_system_notes.append(
            "System Note: "
            f"{dropped_messages} message(s) were omitted to fit the model "
            f"context budget of {available_tokens} estimated tokens."
        )

    return (
        included,
        next_system_notes,
        {
            **config,
            "estimatedTokensBefore": estimated_tokens_before,
            "estimatedTokensAfter": estimated_tokens_after,
            "includedMessages": len(included),
            "droppedMessages": dropped_messages,
            "truncated": dropped_messages > 0,
        },
    )


def _response_error(response: Mapping[str, Any]) -> Mapping[str, Any] | None:
    return _as_mapping(response.get("error"))


def build_conversation_context(
    input_value: Mapping[str, Any],
    responses: Sequence[Any],
) -> JsonObject:
    scope = "thread" if _as_string(input_value.get("thread")) else "space"
    space = _required_string(input_value, "space")
    thread = _optional_string(input_value, "thread")
    limit = _optional_number(input_value, "limit", 50)
    order = _optional_string(input_value, "order") or "asc"
    max_quote_depth = _optional_number(input_value, "maxQuoteDepth", 1)
    response_objects = [_as_mapping(item) or {} for item in responses]
    error = next(
        (response_error for response in response_objects if (response_error := _response_error(response))),
        None,
    )

    if error:
        status = _as_string(error.get("status")) or "UNKNOWN"
        message = _as_string(error.get("message")) or "No error detail was returned."
        return {
            "kind": "chat.context",
            "scope": scope,
            "space": space,
            "thread": thread,
            "order": order,
            "requestedLimit": limit,
            "returnedMessages": 0,
            "pageCursors": {"next": None},
            "partial": True,
            "truncated": False,
            "inaccessible": True,
            "systemNotes": [
                f"System Note: {'Thread' if scope == 'thread' else 'Space'} history is inaccessible: {status} {message}"
            ],
            "messages": [],
        }

    all_messages = [
        _as_mapping(item) or {}
        for response in response_objects
        for item in _as_list(response.get("messages"))
    ]
    quote_lookup = {
        name: message
        for message in all_messages
        if (name := _as_string(message.get("name")))
    }
    sorted_messages = sorted(
        all_messages,
        key=lambda message: _as_string(message.get("createTime")) or "",
        reverse=order == "desc",
    )
    limited_messages = sorted_messages[: int(limit)]
    last_response = response_objects[-1] if response_objects else {}
    next_cursor = _as_string(last_response.get("nextPageToken"))
    truncated = len(sorted_messages) > limit or next_cursor is not None
    system_notes = []

    if next_cursor:
        system_notes.append(
            f"System Note: More {'thread' if scope == 'thread' else 'space'} history is available after cursor {next_cursor}."
        )
    if truncated:
        system_notes.append(
            f"System Note: {'Thread' if scope == 'thread' else 'Space'} history was truncated at the requested limit of {limit} messages."
        )
    thread_root_names = (
        _infer_thread_root_names(limited_messages, thread, truncated)
        if scope == "thread"
        else set()
    )
    normalized_messages = [
        _normalize_context_message(
            message,
            scope=scope,
            reader_thread=thread,
            max_quote_depth=max_quote_depth,
            depth=0,
            visited=set(),
            quote_lookup=quote_lookup,
            thread_root_names=thread_root_names,
        )
        for message in limited_messages
    ]
    budget_messages, budget_system_notes, model_token_budget = _apply_model_token_budget(
        input_value,
        normalized_messages,
        system_notes,
    )
    budget_truncated = bool(model_token_budget and model_token_budget.get("truncated") is True)

    context: JsonObject = {
        "kind": "chat.context",
        "scope": scope,
        "space": space,
        "thread": thread,
        "order": order,
        "requestedLimit": limit,
        "returnedMessages": len(budget_messages),
        "pageCursors": {"next": next_cursor},
        "partial": truncated or budget_truncated,
        "truncated": truncated or budget_truncated,
        "inaccessible": False,
        "systemNotes": budget_system_notes,
        "messages": budget_messages,
    }
    if model_token_budget:
        context["modelTokenBudget"] = model_token_budget
    return context


def _context_item(kind: str, text: str) -> JsonObject:
    return {"kind": kind, "text": text}


def _simple_sender_label(sender: Mapping[str, Any] | None) -> str:
    if not sender:
        return "Unknown sender"
    return (
        _as_string(sender.get("displayName"))
        or _as_string(sender.get("resourceName"))
        or "Unknown sender"
    )


def _limited_profile_note(sender: Mapping[str, Any] | None) -> str:
    if sender and sender.get("access") == "profile_limited":
        return " Email is unavailable because profile access is limited."
    return ""


def _attachment_status_note(attachment: Mapping[str, Any]) -> str:
    extraction = _as_mapping(attachment.get("extraction"))
    transcription = _as_mapping(attachment.get("transcription"))

    if transcription and transcription.get("status") == "disabled":
        if transcription.get("provider") is None:
            return "Transcription is disabled and no provider was selected."
        return "Transcription is disabled."
    if extraction and extraction.get("status") == "not_requested":
        return "Extraction was not requested."
    if extraction and extraction.get("status") == "skipped":
        reason = _as_string(extraction.get("reason"))
        return (
            f"Extraction was skipped because {reason}."
            if reason
            else "Extraction was skipped."
        )
    if extraction and extraction.get("status") == "partial":
        return "Extraction was partial."
    if extraction and extraction.get("status") == "complete":
        return "Extraction was complete."
    return "Extraction status is unknown."


def _render_attachment_note(
    attachment: Mapping[str, Any],
    owner_label: str,
) -> JsonObject:
    file_name = _as_string(attachment.get("fileName")) or "unnamed attachment"
    content_type = _as_string(attachment.get("contentType")) or "unknown content type"
    size_bytes = _as_number(attachment.get("sizeBytes"))
    size_part = f"{int(size_bytes)} bytes" if size_bytes is not None else "unknown size"
    return _context_item(
        "system_note",
        (
            f"System Note: {owner_label} attached {file_name} "
            f"({content_type}, {size_part}). {_attachment_status_note(attachment)}"
        ),
    )


def _render_node_graph_context(input_value: Mapping[str, Any]) -> JsonObject:
    nodes = [
        node
        for node in (_as_mapping(item) for item in _as_list(input_value.get("nodes")))
        if node is not None
    ]
    node_by_id = {
        node_id: node
        for node in nodes
        if (node_id := _as_string(node.get("id"))) is not None
    }
    items: list[JsonObject] = []

    def visit(
        node: Mapping[str, Any],
        owner_label: str | None,
        quote_depth: int,
    ) -> None:
        node_type = _as_string(node.get("type"))
        if node_type == "message":
            sender = _as_mapping(node.get("sender"))
            label = _simple_sender_label(sender)
            created_at = _as_string(node.get("createdAt")) or "unknown time"
            relationship = _as_string(node.get("relationship"))

            if relationship == "quote":
                prefix = (
                    "The quoted message also quotes"
                    if quote_depth > 0
                    else "The message quotes"
                )
                items.append(
                    _context_item(
                        "system_note",
                        (
                            f"System Note: {prefix} {label} from {created_at}."
                            f"{_limited_profile_note(sender)}"
                        ),
                    )
                )
            else:
                action = (
                    "replied in a thread"
                    if relationship == "thread_reply"
                    else "sent a message"
                )
                items.append(
                    _context_item(
                        "system_note",
                        f"System Note: {label} {action} at {created_at}.",
                    )
                )

            text = _as_string(node.get("text"))
            if text:
                items.append(_context_item("message_text", text))

            for child_id in (
                _as_string(item) for item in _as_list(node.get("children"))
            ):
                if child_id is None:
                    continue
                child = node_by_id.get(child_id)
                if child is not None:
                    visit(
                        child,
                        label,
                        quote_depth + 1 if relationship == "quote" else quote_depth,
                    )
            return

        if node_type == "attachment":
            items.append(_render_attachment_note(node, owner_label or "Unknown sender"))

    root_node = node_by_id.get(_as_string(input_value.get("rootNodeId")) or "")
    if root_node is not None:
        visit(root_node, None, 0)
    return {"contextItems": items}


def _render_attachment_system_note_context(input_value: Mapping[str, Any]) -> JsonObject:
    message = _as_mapping(input_value.get("message")) or {}
    sender_label = _as_string(message.get("senderDisplayName")) or "Unknown sender"
    created_at = _as_string(message.get("createdAt")) or "unknown time"
    text = _as_string(message.get("text")) or ""
    items = [_context_item("message_text", f"{created_at} {sender_label}: {text}")]

    for attachment in (
        _as_mapping(item) for item in _as_list(input_value.get("attachments"))
    ):
        if attachment is None:
            continue
        items.append(_render_attachment_note(attachment, sender_label))
        extraction = _as_mapping(attachment.get("extraction"))
        extracted_text = _as_string(extraction.get("text")) if extraction else None
        if extracted_text:
            items.append(_context_item("attachment_text", extracted_text))
    return {"contextItems": items}


def _render_thread_reader_context(input_value: Mapping[str, Any]) -> JsonObject:
    space = _as_mapping(input_value.get("space")) or {}
    thread = _as_mapping(input_value.get("thread")) or {}
    read_options = _as_mapping(input_value.get("readOptions")) or {}
    result_state = _as_mapping(input_value.get("resultState")) or {}
    items = [
        _context_item(
            "system_note",
            (
                f"System Note: Thread {_as_string(thread.get('name')) or 'unknown thread'} "
                f"in {_as_string(space.get('displayName')) or _as_string(space.get('name')) or 'unknown space'} "
                f"was read from {_as_string(read_options.get('startTime')) or 'unknown start'} "
                f"to {_as_string(read_options.get('endTime')) or 'unknown end'} "
                f"with limit {read_options.get('limit', 'unknown')}, "
                f"order {_as_string(read_options.get('order')) or 'unknown'}, "
                f"page token {_as_string(read_options.get('pageToken')) or 'none'}."
            ),
        )
    ]

    for message in (
        _as_mapping(item) for item in _as_list(input_value.get("messages"))
    ):
        if message is None:
            continue
        items.append(
            _context_item(
                "message_text",
                (
                    f"{_as_string(message.get('createdAt')) or 'unknown time'} "
                    f"{_as_string(message.get('senderDisplayName')) or 'Unknown sender'}: "
                    f"{_as_string(message.get('text')) or ''}"
                ),
            )
        )

    if result_state.get("partial") is True or result_state.get("truncated") is True:
        if result_state.get("partial") is True and result_state.get("truncated") is True:
            prefix = "Thread history is partial and truncated."
        elif result_state.get("truncated") is True:
            prefix = "Thread history is truncated."
        else:
            prefix = "Thread history is partial."
        next_page_token = _as_string(result_state.get("nextPageToken"))
        items.append(
            _context_item(
                "system_note",
                (
                    f"System Note: {prefix} More messages are available with page token {next_page_token}."
                    if next_page_token
                    else f"System Note: {prefix}"
                ),
            )
        )
    return {"contextItems": items}


def render_ai_context(input_value: Mapping[str, Any]) -> JsonObject:
    if _as_string(input_value.get("rootNodeId")) and isinstance(
        input_value.get("nodes"),
        list,
    ):
        return _render_node_graph_context(input_value)
    if _as_mapping(input_value.get("message")) and isinstance(
        input_value.get("attachments"),
        list,
    ):
        return _render_attachment_system_note_context(input_value)
    if (
        _as_mapping(input_value.get("space"))
        and _as_mapping(input_value.get("thread"))
        and isinstance(input_value.get("messages"), list)
    ):
        return _render_thread_reader_context(input_value)
    raise TypeError("Unsupported AI context render input shape.")


def _identity_ref_from_sender(sender: Mapping[str, Any]) -> JsonObject:
    return {
        "name": _as_string(sender.get("name")),
        "email": _as_string(sender.get("email")),
        "displayName": _as_string(sender.get("displayName")),
    }


def _sender_from_human_identity(
    identity: Mapping[str, Any],
    fallback: Mapping[str, Any],
) -> JsonObject:
    access = _as_mapping(identity.get("access")) or {}
    access_status = _as_string(access.get("status"))
    return {
        "name": _as_string(identity.get("name")) or _as_string(fallback.get("name")),
        "displayName": _as_string(identity.get("displayName"))
        or _as_string(identity.get("email"))
        or _as_string(fallback.get("displayName"))
        or "Unknown sender",
        "email": _as_string(identity.get("email")),
        "type": _as_string(fallback.get("type"))
        or ("HUMAN" if access_status == "available" else "UNKNOWN"),
        "access": "available" if access_status == "available" else "inaccessible",
        "directoryStatus": _as_string(identity.get("directoryStatus")),
        "source": _as_string(identity.get("source")),
        "stale": identity.get("stale") is True,
        "lastDirectorySyncAt": _as_string(identity.get("lastDirectorySyncAt")),
    }


def _should_append_identity_note(identity: Mapping[str, Any]) -> bool:
    access = _as_mapping(identity.get("access")) or {}
    return (
        identity.get("source") == "directory_cache"
        or identity.get("stale") is True
        or access.get("status") == "access_limited"
    )


def _enrich_context_message_identity(
    message: Mapping[str, Any],
    identity_cache: Any,
) -> JsonObject:
    sender = _as_mapping(message.get("sender")) or _normalize_identity(None)
    identity = resolve_human_identity(
        _identity_ref_from_sender(sender),
        cache=identity_cache,
    )
    system_notes = [
        note
        for note in (_as_string(item) for item in _as_list(message.get("systemNotes")))
        if note is not None
    ]
    identity_note = render_identity_system_note(identity, role="sender")
    quoted_messages = [
        _enrich_context_message_identity(quoted, identity_cache)
        for quoted in (
            _as_mapping(item) for item in _as_list(message.get("quotedMessages"))
        )
        if quoted is not None
    ]

    return {
        **message,
        "sender": _sender_from_human_identity(identity, sender),
        "quotedMessages": quoted_messages,
        "systemNotes": (
            [*system_notes, identity_note]
            if _should_append_identity_note(identity)
            and identity_note not in system_notes
            else system_notes
        ),
    }


def build_conversation_context_with_identity(
    input_value: Mapping[str, Any],
    responses: Sequence[Any],
    *,
    identity_cache: Any | None = None,
) -> JsonObject:
    context = build_conversation_context(input_value, responses)
    if identity_cache is None or context.get("inaccessible") is True:
        return context

    try:
        return {
            **context,
            "messages": [
                _enrich_context_message_identity(message, identity_cache)
                for message in (
                    _as_mapping(item) for item in _as_list(context.get("messages"))
                )
                if message is not None
            ],
        }
    except Exception:
        system_notes = [
            note
            for note in (_as_string(item) for item in _as_list(context.get("systemNotes")))
            if note is not None
        ]
        if IDENTITY_ENRICHMENT_SKIPPED_NOTE not in system_notes:
            system_notes.append(IDENTITY_ENRICHMENT_SKIPPED_NOTE)
        return {**context, "systemNotes": system_notes}


__all__ = [
    "build_conversation_context",
    "build_conversation_context_with_identity",
    "plan_read_space_context",
    "plan_read_thread_context",
    "render_ai_context",
]
