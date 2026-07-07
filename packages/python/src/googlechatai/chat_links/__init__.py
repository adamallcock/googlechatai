"""Google Chat link candidate extraction and dry-run retrieval planning."""

from __future__ import annotations

from collections.abc import Mapping
import hashlib
import json
import re
from typing import Any
from urllib.parse import unquote, urlparse


CHAT_MESSAGES_READONLY_SCOPE = "https://www.googleapis.com/auth/chat.messages.readonly"
CHAT_SPACES_READONLY_SCOPE = "https://www.googleapis.com/auth/chat.spaces.readonly"
CHAT_APP_MESSAGES_READONLY_SCOPE = "https://www.googleapis.com/auth/chat.app.messages.readonly"
CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot"
CHAT_MESSAGE_REVALIDATION_FIELDS = "name,lastUpdateTime,thread.name"
CHAT_MESSAGE_LIST_REVALIDATION_FIELDS = "messages(name,lastUpdateTime,thread.name),nextPageToken"

RawMapping = Mapping[str, Any]
JsonObject = dict[str, Any]

_CHAT_LINK_OPTION_ALIASES = {
    "auth_mode": "authMode",
    "allow_space_level_context": "allowSpaceLevelContext",
    "include_rich_links": "includeRichLinks",
    "include_matched_urls": "includeMatchedUrls",
    "include_plain_text_urls": "includePlainTextUrls",
    "max_chat_links": "maxChatLinks",
    "max_plain_text_urls": "maxPlainTextUrls",
    "max_traversal_depth": "maxTraversalDepth",
    "max_traversal_nodes": "maxTraversalNodes",
    "max_link_scan_items": "maxLinkScanItems",
    "max_plain_text_scan_chars": "maxPlainTextScanChars",
    "max_url_length": "maxUrlLength",
    "max_occurrences_per_candidate": "maxOccurrencesPerCandidate",
    "max_thread_messages": "maxThreadMessages",
    "max_space_messages": "maxSpaceMessages",
}

_CHAT_LINK_CACHE_ALIASES = {
    "entries_by_resource_name": "entriesByResourceName",
}

_CHAT_LINK_CACHE_ENTRY_ALIASES = {
    "last_update_time": "lastUpdateTime",
}


def _as_mapping(value: Any) -> RawMapping | None:
    return value if isinstance(value, Mapping) else None


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _as_number(value: Any) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _positive_integer(value: Any, fallback: int) -> int:
    number_value = _as_number(value)
    if isinstance(number_value, int) and number_value > 0:
        return number_value
    if isinstance(number_value, float) and number_value.is_integer() and number_value > 0:
        return int(number_value)
    return fallback


def _normalize_chat_link_options(options: Mapping[str, Any] | None) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for key, value in (options or {}).items():
        normalized_key = _CHAT_LINK_OPTION_ALIASES.get(str(key), str(key))
        normalized[normalized_key] = value
    return normalized


def _normalize_options(input_value: Any, options: Mapping[str, Any] | None) -> dict[str, Any]:
    raw = _as_mapping(input_value)
    embedded = _as_mapping(raw.get("options")) if raw else None
    return {
        **_normalize_chat_link_options(embedded),
        **_normalize_chat_link_options(options),
    }


def _create_traversal_state(options: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "maxChatLinks": _positive_integer(options.get("maxChatLinks"), 200),
        "maxPlainTextUrls": _positive_integer(options.get("maxPlainTextUrls"), 200),
        "maxTraversalDepth": _positive_integer(options.get("maxTraversalDepth"), 256),
        "maxTraversalNodes": _positive_integer(options.get("maxTraversalNodes"), 5000),
        "maxLinkScanItems": _positive_integer(options.get("maxLinkScanItems"), 5000),
        "maxPlainTextScanChars": _positive_integer(options.get("maxPlainTextScanChars"), 65536),
        "maxUrlLength": _positive_integer(options.get("maxUrlLength"), 2048),
        "maxOccurrencesPerCandidate": _positive_integer(options.get("maxOccurrencesPerCandidate"), 50),
        "candidateCount": 0,
        "plainTextUrlCount": 0,
        "plainTextCharsScanned": 0,
        "traversalNodeCount": 0,
        "linkScanItemCount": 0,
        "cappedCandidates": 0,
        "cappedPlainTextUrls": 0,
        "cappedPlainTextScanChars": 0,
        "cappedOversizedUrls": 0,
        "cappedOccurrences": 0,
        "cappedTraversalNodes": 0,
        "cappedLinkScanItems": 0,
        "nextAnonymousPathId": 1,
    }


def _normalized_space(space_id: str) -> str:
    return f"spaces/{space_id}"


def _normalized_thread(space_id: str, thread_id: str) -> str:
    return f"spaces/{space_id}/threads/{thread_id}"


def _valid_segment(value: str | None) -> bool:
    return (
        value is not None
        and len(value) > 0
        and bool(re.match(r"^[A-Za-z0-9_.~:-]+$", value))
        and value not in {".", ".."}
    )


def _numeric_segment(value: str | None) -> bool:
    return bool(value and re.match(r"^\d+$", value))


def _decode_url_segment(value: str | None) -> str | None:
    return unquote(value) if value is not None else None


def _resource_segments(value: str | None) -> list[str] | None:
    if not value:
        return None
    segments = value.split("/")
    return segments if all(_valid_segment(segment) for segment in segments) else None


def _space_from_resource(resource_name: str | None) -> str | None:
    segments = _resource_segments(resource_name)
    if segments and len(segments) >= 2 and segments[0] == "spaces":
        return f"spaces/{segments[1]}"
    return None


def _valid_space_resource(value: str | None) -> bool:
    segments = _resource_segments(value)
    return bool(segments and len(segments) == 2 and segments[0] == "spaces")


def _valid_thread_resource(value: str | None) -> bool:
    segments = _resource_segments(value)
    return bool(
        segments
        and len(segments) == 4
        and segments[0] == "spaces"
        and segments[2] == "threads"
    )


def _valid_message_resource(value: str | None) -> bool:
    segments = _resource_segments(value)
    return bool(
        segments
        and len(segments) == 4
        and segments[0] == "spaces"
        and segments[2] == "messages"
    )


def _parsed_unknown() -> dict[str, Any]:
    return {
        "parseStatus": "unknown",
        "confidence": "unknown",
        "scope": "unknown",
        "space": None,
        "thread": None,
        "message": None,
        "resourceName": None,
        "urlShape": "unknown_chat_url",
        "warnings": [
            "Chat URL shape is not recognized; retained for corpus collection but no API request will be planned."
        ],
    }


def _invalid_chat_space_link_data(warnings: list[str]) -> dict[str, Any]:
    return {
        "parseStatus": "invalid",
        "confidence": "unknown",
        "scope": "unknown",
        "space": None,
        "thread": None,
        "message": None,
        "resourceName": None,
        "urlShape": "invalid_chat_space_link_data",
        "warnings": warnings
        if warnings
        else [
            "chatSpaceLinkData did not contain a canonical space, thread, or message resource."
        ],
    }


def _parse_chat_space_link_data(raw: Mapping[str, Any]) -> dict[str, Any] | None:
    message = _as_string(raw.get("message"))
    thread = _as_string(raw.get("thread"))
    space = _as_string(raw.get("space"))
    warnings: list[str] = []
    normalized_message = None
    normalized_thread = None
    normalized_space = None
    observed_spaces: set[str] = set()

    if message:
        if not _valid_message_resource(message):
            warnings.append(
                "chatSpaceLinkData.message was not a canonical spaces/{space}/messages/{message} resource."
            )
        else:
            normalized_message = message
            normalized_space = _space_from_resource(message)
            if normalized_space:
                observed_spaces.add(normalized_space)

    if thread:
        if not _valid_thread_resource(thread):
            warnings.append(
                "chatSpaceLinkData.thread was not a canonical spaces/{space}/threads/{thread} resource."
            )
        else:
            normalized_thread = thread
            thread_space = _space_from_resource(thread)
            if thread_space:
                observed_spaces.add(thread_space)
            normalized_space = normalized_space or thread_space

    if space:
        if not _valid_space_resource(space):
            warnings.append(
                "chatSpaceLinkData.space was not a canonical spaces/{space} resource."
            )
        else:
            observed_spaces.add(space)
            normalized_space = space
    if len(observed_spaces) > 1 and "chatSpaceLinkData resource names point at different spaces." not in warnings:
        warnings.append("chatSpaceLinkData resource names point at different spaces.")

    if normalized_message:
        return {
            "parseStatus": "invalid" if warnings else "parsed",
            "confidence": "unknown" if warnings else "high",
            "scope": "unknown" if warnings else "message",
            "space": None if warnings else normalized_space,
            "thread": None if warnings else normalized_thread,
            "message": None if warnings else normalized_message,
            "resourceName": None if warnings else normalized_message,
            "urlShape": "invalid_chat_space_link_data" if warnings else "chat_space_link_data",
            "warnings": warnings,
        }
    if normalized_thread:
        return {
            "parseStatus": "invalid" if warnings else "parsed",
            "confidence": "unknown" if warnings else "high",
            "scope": "unknown" if warnings else "thread",
            "space": None if warnings else normalized_space,
            "thread": None if warnings else normalized_thread,
            "message": None,
            "resourceName": None if warnings else normalized_thread,
            "urlShape": "invalid_chat_space_link_data" if warnings else "chat_space_link_data",
            "warnings": warnings,
        }
    if normalized_space:
        return {
            "parseStatus": "invalid" if warnings else "parsed",
            "confidence": "unknown" if warnings else "high",
            "scope": "unknown" if warnings else "space",
            "space": None if warnings else normalized_space,
            "thread": None,
            "message": None,
            "resourceName": None if warnings else normalized_space,
            "urlShape": "invalid_chat_space_link_data" if warnings else "chat_space_link_data",
            "warnings": warnings,
        }

    return _invalid_chat_space_link_data(warnings)


def _clean_path_segments(pathname: str) -> list[str]:
    return [unquote(segment) for segment in pathname.split("/") if segment]


def _parse_mail_hash_space(parsed) -> dict[str, Any] | None:
    if parsed.hostname != "mail.google.com":
        return None
    path = _clean_path_segments(parsed.path)
    has_mail_prefix = len(path) >= 2 and path[0] == "mail" and path[1] == "u"
    has_chat_prefix = len(path) >= 2 and path[0] == "chat" and path[1] == "u"
    is_documented_mail = len(path) == 3 and has_mail_prefix and _numeric_segment(path[2])
    is_observed_chat = len(path) == 3 and has_chat_prefix and _numeric_segment(path[2])
    if not is_documented_mail and not is_observed_chat:
        return _parsed_unknown() if has_mail_prefix or has_chat_prefix else None
    hash_value = parsed.fragment
    hash_parts = [part for part in hash_value.split("/") if part]
    if (
        len(hash_parts) < 3
        or hash_parts[0] != "chat"
        or hash_parts[1] != "space"
    ):
        return _parsed_unknown()
    if len(hash_parts) != 3:
        return _parsed_unknown()
    space_segment = _decode_url_segment(re.split(r"[?#]", hash_parts[2], maxsplit=1)[0])
    if not _valid_segment(space_segment):
        return _parsed_unknown()
    space = _normalized_space(space_segment)
    return {
        "parseStatus": "parsed",
        "confidence": "high" if is_documented_mail else "medium",
        "scope": "space",
        "space": space,
        "thread": None,
        "message": None,
        "resourceName": space,
        "urlShape": "gmail_hash_space" if is_documented_mail else "gmail_chat_hash_space",
        "warnings": [],
    }


def _parse_chat_host_url(parsed) -> dict[str, Any] | None:
    if parsed.hostname != "chat.google.com":
        return None
    path = _clean_path_segments(parsed.path)
    if len(path) == 2 and path[0] == "room" and _valid_segment(path[1]):
        space = _normalized_space(path[1])
        return {
            "parseStatus": "parsed",
            "confidence": "medium",
            "scope": "space",
            "space": space,
            "thread": None,
            "message": None,
            "resourceName": space,
            "urlShape": "chat_room_space",
            "warnings": [],
        }
    if (
        len(path) == 3
        and path[0] == "room"
        and _valid_segment(path[1])
        and _valid_segment(path[2])
    ):
        space = _normalized_space(path[1])
        thread = _normalized_thread(path[1], path[2])
        return {
            "parseStatus": "parsed",
            "confidence": "low",
            "scope": "thread",
            "space": space,
            "thread": thread,
            "message": None,
            "resourceName": thread,
            "urlShape": "chat_room_thread",
            "warnings": [
                "Thread URL shape is empirical; verify with live corpus before treating as a stable Google contract."
            ],
        }
    if (
        len(path) == 5
        and path[0] == "u"
        and _numeric_segment(path[1])
        and path[2] == "app"
        and path[3] == "chat"
        and _valid_segment(path[4])
    ):
        space = _normalized_space(path[4])
        return {
            "parseStatus": "parsed",
            "confidence": "medium",
            "scope": "space",
            "space": space,
            "thread": None,
            "message": None,
            "resourceName": space,
            "urlShape": "chat_app_space",
            "warnings": [],
        }
    return _parsed_unknown()


def _parse_chat_url(url_value: str | None) -> dict[str, Any] | None:
    if not url_value:
        return None
    try:
        parsed = urlparse(url_value)
        if parsed.scheme != "https":
            return _parsed_unknown() if parsed.hostname in {"chat.google.com", "mail.google.com"} else None
        return _parse_mail_hash_space(parsed) or _parse_chat_host_url(parsed)
    except ValueError:
        return None


def _clean_original_url(value: str | None) -> str | None:
    return re.sub(r"[.,;:!?]+$", "", value) if value else None


def _message_name_from_value(value: Mapping[str, Any] | None) -> str | None:
    if not value:
        return None
    ref = _as_mapping(value.get("ref"))
    return (_as_string(ref.get("name")) if ref else None) or _as_string(value.get("name"))


def _sender_identity_from_value(value: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if not value:
        return None
    raw = _as_mapping(value.get("sender"))
    if not raw:
        return None

    resource_name = _as_string(raw.get("resourceName")) or _as_string(raw.get("name"))
    display_name = _as_string(raw.get("displayName"))
    email = _as_string(raw.get("email"))
    user_type = _as_string(raw.get("type"))
    has_human_readable = display_name is not None or email is not None

    if user_type == "ANONYMOUS":
        access_state = "anonymous"
    elif resource_name and has_human_readable:
        access_state = "available"
    elif resource_name:
        access_state = "resource_only"
    elif has_human_readable:
        access_state = "partial"
    else:
        access_state = "unknown"

    if resource_name:
        ambiguity_state = "unambiguous" if has_human_readable else "unresolved"
    elif has_human_readable:
        ambiguity_state = "ambiguous"
    else:
        ambiguity_state = "unresolved"

    return {
        "displayName": display_name,
        "email": email,
        "resourceName": resource_name,
        "type": user_type,
        "accessState": access_state,
        "ambiguityState": ambiguity_state,
    }


def _enrich_context_with_source(
    context: dict[str, Any],
    value: Mapping[str, Any] | None,
) -> dict[str, Any]:
    sender = _sender_identity_from_value(value)
    created_at = _as_string(value.get("createdAt")) or _as_string(value.get("createTime")) if value else None
    updated_at = _as_string(value.get("updatedAt")) or _as_string(value.get("lastUpdateTime")) if value else None
    deleted_at = _as_string(value.get("deletedAt")) or _as_string(value.get("deleteTime")) if value else None
    access_state = _as_string(value.get("accessState")) if value else None

    if not sender and not created_at and not updated_at and not deleted_at and not access_state:
        return context

    return {
        **context,
        "sender": sender,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "deletedAt": deleted_at,
        "accessState": access_state,
    }


def _root_context(value: Mapping[str, Any] | None) -> dict[str, Any]:
    message_name = _message_name_from_value(value)
    if message_name:
        return _enrich_context_with_source(
            {
                "messageName": message_name,
                "relationship": "self",
                "path": [f"self:{message_name}"],
            },
            value,
        )
    return _enrich_context_with_source(
        {"messageName": None, "relationship": "input", "path": ["input"]},
        value,
    )


def _child_context(
    parent: Mapping[str, Any],
    child: Mapping[str, Any] | None,
    relationship: str,
    traversal: dict[str, Any],
) -> dict[str, Any]:
    message_name = _message_name_from_value(child)
    if message_name:
        path_part = f"{relationship}:{message_name}"
    else:
        path_part = f"{relationship}:node-{traversal['nextAnonymousPathId']}"
        traversal["nextAnonymousPathId"] += 1
    return _enrich_context_with_source(
        {
            "messageName": message_name,
            "relationship": relationship,
            "path": [*list(parent.get("path") or []), path_part],
        },
        child,
    )


def _source_from_kind(kind: str | None, chat_space_link_data: Mapping[str, Any] | None) -> str | None:
    if chat_space_link_data is not None:
        return "chat_space_link_data"
    if kind == "richLink":
        return "rich_link_url"
    if kind == "matchedUrl":
        return "matched_url"
    if kind in {"plain_url", "plainUrl"}:
        return "plain_url"
    return None


def _entry_from_link(raw: Mapping[str, Any], context: Mapping[str, Any]) -> dict[str, Any] | None:
    metadata = _as_mapping(raw.get("richLinkMetadata"))
    chat_space_link_data = _as_mapping(raw.get("chatSpaceLinkData"))
    if chat_space_link_data is None and metadata:
        chat_space_link_data = _as_mapping(metadata.get("chatSpaceLinkData"))
    source = _source_from_kind(_as_string(raw.get("kind")), chat_space_link_data)
    original_url = _clean_original_url(
        _as_string(raw.get("url")) or (_as_string(metadata.get("uri")) if metadata else None)
    )
    if not source or (not original_url and chat_space_link_data is None):
        return None
    return {
        "source": source,
        "originalUrl": original_url,
        "title": _as_string(raw.get("title"))
        or (_as_string(metadata.get("title")) if metadata else None),
        "chatSpaceLinkData": chat_space_link_data,
        "context": dict(context),
    }


def _entry_from_raw_annotation(raw: Mapping[str, Any], context: Mapping[str, Any]) -> dict[str, Any] | None:
    if _as_string(raw.get("type")) != "RICH_LINK":
        return None
    metadata = _as_mapping(raw.get("richLinkMetadata")) or {}
    chat_space_link_data = _as_mapping(metadata.get("chatSpaceLinkData"))
    original_url = _clean_original_url(_as_string(metadata.get("uri")))
    if not original_url and chat_space_link_data is None:
        return None
    return {
        "source": "chat_space_link_data" if chat_space_link_data is not None else "rich_link_url",
        "originalUrl": original_url,
        "title": _as_string(metadata.get("title")),
        "chatSpaceLinkData": chat_space_link_data,
        "context": dict(context),
    }


def _candidate_from_entry(entry: Mapping[str, Any], candidate_id: str) -> dict[str, Any] | None:
    chat_space_link_data = _as_mapping(entry.get("chatSpaceLinkData"))
    parsed = (
        _parse_chat_space_link_data(chat_space_link_data)
        if chat_space_link_data is not None
        else _parse_chat_url(_as_string(entry.get("originalUrl")))
    )
    if not parsed:
        return None
    return {
        "kind": "chat_link",
        "candidateId": candidate_id,
        "source": entry["source"],
        "originalUrl": entry.get("originalUrl"),
        "title": entry.get("title"),
        "parseStatus": parsed["parseStatus"],
        "confidence": parsed["confidence"],
        "scope": parsed["scope"],
        "space": parsed["space"],
        "thread": parsed["thread"],
        "message": parsed["message"],
        "resourceName": parsed["resourceName"],
        "urlShape": parsed["urlShape"],
        "context": dict(_as_mapping(entry.get("context")) or {}),
        "warnings": parsed["warnings"],
    }


def _dedupe_key_for_candidate(candidate: Mapping[str, Any]) -> str:
    resource_name = _as_string(candidate.get("resourceName"))
    if resource_name:
        return resource_name
    return f"{candidate.get('urlShape')}|{candidate.get('originalUrl') or ''}"


def _same_context_path(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    return list(left.get("path") or []) == list(right.get("path") or [])


def _add_occurrence(
    candidate: dict[str, Any],
    context: Mapping[str, Any],
    traversal: dict[str, Any],
) -> None:
    candidate_context = _as_mapping(candidate.get("context")) or {}
    if _same_context_path(candidate_context, context):
        return
    if "occurrences" not in candidate:
        candidate["occurrences"] = [dict(candidate_context)]
    if not any(_same_context_path(_as_mapping(item) or {}, context) for item in candidate["occurrences"]):
        if len(candidate["occurrences"]) >= int(traversal["maxOccurrencesPerCandidate"]):
            traversal["cappedOccurrences"] += 1
            return
        candidate["occurrences"].append(dict(context))


def _add_entry(
    entry: Mapping[str, Any] | None,
    candidates: list[dict[str, Any]],
    seen: dict[str, dict[str, Any]],
    traversal: dict[str, Any],
) -> None:
    if not entry:
        return
    candidate = _candidate_from_entry(
        entry,
        "chat-link-pending",
    )
    if not candidate:
        return
    key = _dedupe_key_for_candidate(candidate)
    existing = seen.get(key)
    if existing:
        _add_occurrence(existing, _as_mapping(candidate.get("context")) or {}, traversal)
        return
    if traversal["candidateCount"] >= traversal["maxChatLinks"]:
        traversal["cappedCandidates"] += 1
        return
    traversal["candidateCount"] += 1
    candidate["candidateId"] = f"chat-link-{traversal['candidateCount']}"
    seen[key] = candidate
    candidates.append(candidate)


def _entry_allowed_by_options(entry: Mapping[str, Any], options: Mapping[str, Any]) -> bool:
    if entry.get("source") == "matched_url" and options.get("includeMatchedUrls") is False:
        return False
    if entry.get("source") == "plain_url" and options.get("includePlainTextUrls") is False:
        return False
    if entry.get("source") in {"rich_link_url", "chat_space_link_data"} and options.get("includeRichLinks") is False:
        return False
    return True


def _consume_scan_item(traversal: dict[str, Any], remaining_items: int) -> bool:
    if traversal["linkScanItemCount"] >= traversal["maxLinkScanItems"]:
        traversal["cappedLinkScanItems"] += remaining_items
        return False
    traversal["linkScanItemCount"] += 1
    return True


URL_RE = re.compile(r"https?://[^\s<>\"')]+")
URL_DELIMITER_RE = re.compile(r"[\s<>\"')]")


def _collect_plain_text_urls(
    text: str | None,
    context: Mapping[str, Any],
    candidates: list[dict[str, Any]],
    seen: dict[str, dict[str, Any]],
    traversal: dict[str, Any],
) -> None:
    if not text:
        return
    scan_length = min(len(text), int(traversal["maxPlainTextScanChars"]))
    scan_text = text[:scan_length]
    traversal["plainTextCharsScanned"] += len(scan_text)
    if len(text) > len(scan_text):
        traversal["cappedPlainTextScanChars"] += len(text) - len(scan_text)
    for match in URL_RE.finditer(scan_text):
        if traversal["plainTextUrlCount"] >= traversal["maxPlainTextUrls"]:
            traversal["cappedPlainTextUrls"] += 1
            return
        matched_url = match.group(0)
        match_ends_at_scan_boundary = match.end() == len(scan_text)
        next_original_char = text[len(scan_text)] if len(text) > len(scan_text) else ""
        if (
            len(matched_url) > traversal["maxUrlLength"]
            or (
                match_ends_at_scan_boundary
                and len(text) > len(scan_text)
                and not URL_DELIMITER_RE.match(next_original_char)
            )
        ):
            traversal["cappedOversizedUrls"] += 1
            continue
        traversal["plainTextUrlCount"] += 1
        _add_entry(
            {
                "source": "plain_url",
                "originalUrl": _clean_original_url(matched_url),
                "title": None,
                "chatSpaceLinkData": None,
                "context": dict(context),
            },
            candidates,
            seen,
            traversal,
        )


def _collect_from_message_like(
    value: Mapping[str, Any],
    context: Mapping[str, Any],
    candidates: list[dict[str, Any]],
    seen: dict[str, dict[str, Any]],
    options: Mapping[str, Any],
    traversal: dict[str, Any],
) -> None:
    links = _as_list(value.get("links"))
    for index, item in enumerate(links):
        if not _consume_scan_item(traversal, len(links) - index):
            return
        raw = _as_mapping(item)
        if not raw:
            continue
        entry = _entry_from_link(raw, context)
        if not entry:
            continue
        if not _entry_allowed_by_options(entry, options):
            continue
        _add_entry(entry, candidates, seen, traversal)

    annotations = _as_list(value.get("annotations"))
    for index, item in enumerate(annotations):
        if not _consume_scan_item(traversal, len(annotations) - index):
            return
        raw = _as_mapping(item)
        if not raw:
            continue
        entry = (
            _entry_from_raw_annotation(raw, context)
            if _as_string(raw.get("type")) == "RICH_LINK"
            else _entry_from_link(raw, context)
        )
        if not entry:
            continue
        if not _entry_allowed_by_options(entry, options):
            continue
        _add_entry(entry, candidates, seen, traversal)

    if options.get("includeMatchedUrls") is not False:
        matched_url = _as_mapping(value.get("matchedUrl"))
        url = _as_string(matched_url.get("url")) if matched_url else None
        if url:
            if not _consume_scan_item(traversal, 1):
                return
            _add_entry(
                {
                    "source": "matched_url",
                    "originalUrl": _clean_original_url(url),
                    "title": None,
                    "chatSpaceLinkData": None,
                    "context": dict(context),
                },
                candidates,
                seen,
                traversal,
            )

    if options.get("includePlainTextUrls") is not False:
        _collect_plain_text_urls(_as_string(value.get("text")), context, candidates, seen, traversal)


def _root_mapping_for_input(input_value: Any) -> RawMapping | dict[str, Any] | None:
    if isinstance(input_value, list):
        return {"links": input_value}
    return _as_mapping(input_value)


def _push_traversal_child(
    stack: list[dict[str, Any]],
    traversal: dict[str, Any],
    parent_context: Mapping[str, Any],
    child: Mapping[str, Any],
    relationship: str,
    depth: int,
) -> None:
    if depth > traversal["maxTraversalDepth"]:
        traversal["cappedTraversalNodes"] += 1
        return
    if traversal["traversalNodeCount"] + len(stack) >= traversal["maxTraversalNodes"]:
        traversal["cappedTraversalNodes"] += 1
        return
    stack.append(
        {
            "value": child,
            "context": _child_context(parent_context, child, relationship, traversal),
            "depth": depth,
        }
    )


def _push_traversal_children_in_input_order(
    stack: list[dict[str, Any]],
    traversal: dict[str, Any],
    parent_context: Mapping[str, Any],
    children: list[Any],
    depth: int,
    relationship_for_child: Any,
) -> None:
    if not children:
        return
    if depth > traversal["maxTraversalDepth"]:
        traversal["cappedTraversalNodes"] += len(children)
        return
    available_slots = traversal["maxTraversalNodes"] - traversal["traversalNodeCount"] - len(stack)
    if available_slots <= 0:
        traversal["cappedTraversalNodes"] += len(children)
        return
    allowed_count = min(len(children), available_slots)
    traversal["cappedTraversalNodes"] += len(children) - allowed_count
    index = allowed_count - 1
    while index >= 0:
        child_record = _as_mapping(children[index])
        if child_record:
            stack.append(
                {
                    "value": child_record,
                    "context": _child_context(
                        parent_context,
                        child_record,
                        relationship_for_child(child_record, index),
                        traversal,
                    ),
                    "depth": depth,
                }
            )
        index -= 1


def _is_normalized_message_ast_root(value: Mapping[str, Any]) -> bool:
    return _as_string(value.get("schemaVersion")) == "message-ast.v1"


def _collect_from_value(
    input_value: Any,
    candidates: list[dict[str, Any]],
    seen: dict[str, dict[str, Any]],
    options: Mapping[str, Any],
    traversal: dict[str, Any],
) -> None:
    root = _root_mapping_for_input(input_value)
    if not root:
        return
    visited: set[int] = set()
    stack = [{"value": root, "context": _root_context(root), "depth": 1}]

    while stack:
        item = stack.pop()
        value = item["value"]
        value_id = id(value)
        if value_id in visited:
            continue
        visited.add(value_id)

        if item["depth"] > traversal["maxTraversalDepth"]:
            traversal["cappedTraversalNodes"] += 1
            continue
        if traversal["traversalNodeCount"] >= traversal["maxTraversalNodes"]:
            traversal["cappedTraversalNodes"] += 1
            continue
        traversal["traversalNodeCount"] += 1

        _collect_from_message_like(
            value,
            item["context"],
            candidates,
            seen,
            options,
            traversal,
        )

        nested_message = _as_mapping(value.get("message"))
        if nested_message:
            _push_traversal_child(
                stack,
                traversal,
                item["context"],
                nested_message,
                "message",
                item["depth"] + 1,
            )

        _push_traversal_children_in_input_order(
            stack,
            traversal,
            item["context"],
            _as_list(value.get("messages")),
            item["depth"] + 1,
            lambda _child, index: f"message-{index}",
        )

        context_node = _as_mapping(value.get("contextNode"))
        if context_node:
            if _is_normalized_message_ast_root(value):
                _push_traversal_children_in_input_order(
                    stack,
                    traversal,
                    item["context"],
                    _as_list(context_node.get("children")),
                    item["depth"] + 1,
                    lambda child, _index: _as_string(child.get("relationship")) or "child",
                )
            else:
                _push_traversal_child(
                    stack,
                    traversal,
                    item["context"],
                    context_node,
                    "context",
                    item["depth"] + 1,
                )

        _push_traversal_children_in_input_order(
            stack,
            traversal,
            item["context"],
            _as_list(value.get("children")),
            item["depth"] + 1,
            lambda child, _index: _as_string(child.get("relationship")) or "child",
        )


def _collect_chat_link_candidates_with_traversal(
    input_data: Any,
    options: Mapping[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    traversal = _create_traversal_state(options)
    candidates: list[dict[str, Any]] = []
    if options.get("enabled") is False:
        return candidates, traversal
    seen: dict[str, dict[str, Any]] = {}
    _collect_from_value(input_data, candidates, seen, options, traversal)
    return candidates, traversal


def collect_chat_link_candidates(
    input_data: Any,
    **options: Any,
) -> list[dict[str, Any]]:
    effective_options = _normalize_options(input_data, options)
    candidates, _traversal = _collect_chat_link_candidates_with_traversal(
        input_data,
        effective_options,
    )
    return candidates


def build_chat_link_cache_key(input_data: Mapping[str, Any] | None = None, **kwargs: Any) -> dict[str, Any]:
    payload = {**(dict(input_data) if input_data else {}), **kwargs}
    resource_name = _as_string(payload.get("resourceName") or payload.get("resource_name"))
    if not resource_name:
        raise TypeError("Expected resourceName to be a non-empty string.")
    last_update_time = _as_string(payload.get("lastUpdateTime") or payload.get("last_update_time"))
    digest = hashlib.sha256(
        f"chat_link|{resource_name}|{last_update_time or ''}".encode("utf-8")
    ).hexdigest()[:32]
    return {
        "namespace": "chat_link",
        "key": f"chat-link:{digest}",
        "resourceName": resource_name,
        "lastUpdateTime": last_update_time,
    }


def _aliased_mapping_value(raw: Mapping[str, Any], key: str, aliases: Mapping[str, str]) -> Any:
    if key in raw:
        return raw.get(key)
    for alias, normalized in aliases.items():
        if normalized == key and alias in raw:
            return raw.get(alias)
    return None


def _cache_entry_for_resource(options: Mapping[str, Any], resource_name: str) -> RawMapping | None:
    cache = _as_mapping(options.get("cache"))
    if not cache:
        return None
    entries = _as_mapping(
        _aliased_mapping_value(cache, "entriesByResourceName", _CHAT_LINK_CACHE_ALIASES)
    )
    if not entries:
        return None
    return _as_mapping(entries.get(resource_name))


def _cache_entry_value(entry: Mapping[str, Any], key: str) -> Any:
    return _aliased_mapping_value(entry, key, _CHAT_LINK_CACHE_ENTRY_ALIASES)


def _cache_status_for(candidate: Mapping[str, Any], options: Mapping[str, Any]) -> dict[str, Any]:
    resource_name = _as_string(candidate.get("resourceName"))
    if not resource_name:
        return {
            "status": "unavailable",
            "strategy": "resource_last_update_time",
            "key": None,
            "resourceName": None,
            "lastUpdateTime": None,
            "revalidateWith": None,
        }
    entry = _cache_entry_for_resource(options, resource_name)
    revalidate_with = _revalidate_method(_as_string(candidate.get("scope")), options)
    if entry and _cache_entry_value(entry, "hit") is True and revalidate_with:
        last_update_time = _as_string(_cache_entry_value(entry, "lastUpdateTime"))
        return {
            "status": "hit",
            "strategy": "resource_last_update_time",
            "key": _as_string(_cache_entry_value(entry, "key"))
            or build_chat_link_cache_key(
                {
                    "resourceName": resource_name,
                    "lastUpdateTime": last_update_time,
                }
            )["key"],
            "resourceName": resource_name,
            "lastUpdateTime": last_update_time,
            "revalidateWith": revalidate_with,
        }
    return {
        "status": "metadata_required" if revalidate_with else "unavailable",
        "strategy": "resource_last_update_time",
        "key": None,
        "resourceName": resource_name,
        "lastUpdateTime": None,
        "revalidateWith": revalidate_with,
    }


def _revalidate_method(scope: str | None, options: Mapping[str, Any]) -> str | None:
    if scope == "message":
        return "spaces.messages.get"
    if scope == "thread":
        return "spaces.messages.list"
    if scope == "space" and options.get("allowSpaceLevelContext") is True:
        return "spaces.messages.list"
    return None


def _traversal_was_capped(traversal: Mapping[str, Any]) -> bool:
    return any(
        int(traversal.get(key) or 0) > 0
        for key in (
            "cappedCandidates",
            "cappedPlainTextUrls",
            "cappedPlainTextScanChars",
            "cappedOversizedUrls",
            "cappedOccurrences",
            "cappedTraversalNodes",
            "cappedLinkScanItems",
        )
    )


def _truncation_for_traversal(traversal: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "status": "truncated" if _traversal_was_capped(traversal) else "complete",
        "maxChatLinks": traversal["maxChatLinks"],
        "maxPlainTextUrls": traversal["maxPlainTextUrls"],
        "maxTraversalDepth": traversal["maxTraversalDepth"],
        "maxTraversalNodes": traversal["maxTraversalNodes"],
        "maxLinkScanItems": traversal["maxLinkScanItems"],
        "maxPlainTextScanChars": traversal["maxPlainTextScanChars"],
        "maxUrlLength": traversal["maxUrlLength"],
        "maxOccurrencesPerCandidate": traversal["maxOccurrencesPerCandidate"],
        "candidatesVisited": traversal["candidateCount"],
        "plainTextUrlsScanned": traversal["plainTextUrlCount"],
        "plainTextCharsScanned": traversal["plainTextCharsScanned"],
        "traversalNodesVisited": traversal["traversalNodeCount"],
        "linkScanItemsVisited": traversal["linkScanItemCount"],
        "cappedCandidates": traversal["cappedCandidates"],
        "cappedPlainTextUrls": traversal["cappedPlainTextUrls"],
        "cappedPlainTextScanChars": traversal["cappedPlainTextScanChars"],
        "cappedOversizedUrls": traversal["cappedOversizedUrls"],
        "cappedOccurrences": traversal["cappedOccurrences"],
        "cappedTraversalNodes": traversal["cappedTraversalNodes"],
        "cappedLinkScanItems": traversal["cappedLinkScanItems"],
    }


def _required_scopes_for_requests(auth_mode: str, requests: list[Mapping[str, Any]]) -> list[str]:
    has_message_read = any(
        request.get("resource") in {"spaces.messages.get", "spaces.messages.list"}
        for request in requests
    )
    has_space_read = any(request.get("resource") == "spaces.get" for request in requests)
    scopes: list[str] = []
    if auth_mode == "user":
        if has_message_read:
            scopes.append(CHAT_MESSAGES_READONLY_SCOPE)
        if has_space_read:
            scopes.append(CHAT_SPACES_READONLY_SCOPE)
        return scopes
    if has_message_read:
        scopes.append(CHAT_APP_MESSAGES_READONLY_SCOPE)
    if has_space_read:
        scopes.append(CHAT_BOT_SCOPE)
    return scopes


def _space_get_request(candidate: Mapping[str, Any]) -> dict[str, Any] | None:
    space = _as_string(candidate.get("space"))
    if not space:
        return None
    return {
        "candidateId": candidate["candidateId"],
        "resource": "spaces.get",
        "method": "GET",
        "path": f"/v1/{space}",
        "query": {},
        "body": None,
        "purpose": "read_space_breadcrumb",
    }


def _has_cache_hit(candidate: Mapping[str, Any], options: Mapping[str, Any]) -> bool:
    resource_name = _as_string(candidate.get("resourceName"))
    revalidate_with = _revalidate_method(_as_string(candidate.get("scope")), options)
    if not resource_name or not revalidate_with:
        return False
    entry = _cache_entry_for_resource(options, resource_name)
    return bool(entry and _cache_entry_value(entry, "hit") is True)


def _requests_for_candidate(candidate: Mapping[str, Any], options: Mapping[str, Any]) -> list[dict[str, Any]]:
    if candidate.get("parseStatus") != "parsed":
        return []
    requests: list[dict[str, Any]] = []
    scope = candidate.get("scope")
    space = _as_string(candidate.get("space"))
    thread = _as_string(candidate.get("thread"))
    message = _as_string(candidate.get("message"))
    cache_hit = _has_cache_hit(candidate, options)

    if scope == "message" and message:
        requests.append(
            {
                "candidateId": candidate["candidateId"],
                "resource": "spaces.messages.get",
                "method": "GET",
                "path": f"/v1/{message}",
                "query": {"fields": CHAT_MESSAGE_REVALIDATION_FIELDS} if cache_hit else {},
                "body": None,
                "purpose": "read_message_or_revalidate_cache",
            }
        )
        space_get = _space_get_request(candidate)
        if space_get:
            requests.append(space_get)
        return requests

    if scope == "thread" and space and thread:
        requests.append(
            {
                "candidateId": candidate["candidateId"],
                "resource": "spaces.messages.list",
                "method": "GET",
                "path": f"/v1/{space}/messages",
                "query": {
                    "pageSize": _positive_integer(options.get("maxThreadMessages"), 50),
                    "filter": f'thread.name = "{thread}"',
                    "orderBy": "createTime asc",
                    **(
                        {"fields": CHAT_MESSAGE_LIST_REVALIDATION_FIELDS}
                        if cache_hit
                        else {}
                    ),
                },
                "body": None,
                "purpose": "read_thread_context",
            }
        )
        space_get = _space_get_request(candidate)
        if space_get:
            requests.append(space_get)
        return requests

    if scope == "space" and space:
        space_get = _space_get_request(candidate)
        if space_get:
            requests.append(space_get)
        if options.get("allowSpaceLevelContext") is True:
            requests.append(
                {
                    "candidateId": candidate["candidateId"],
                    "resource": "spaces.messages.list",
                    "method": "GET",
                    "path": f"/v1/{space}/messages",
                    "query": {
                        "pageSize": _positive_integer(options.get("maxSpaceMessages"), 20),
                        "orderBy": "createTime desc",
                        **(
                            {"fields": CHAT_MESSAGE_LIST_REVALIDATION_FIELDS}
                            if cache_hit
                            else {}
                        ),
                    },
                    "body": None,
                    "purpose": "read_space_context",
                }
            )
        return requests

    return []


def _stable_stringify(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ",".join(_stable_stringify(item) for item in value) + "]"
    if isinstance(value, Mapping):
        return (
            "{"
            + ",".join(
                json.dumps(str(key), separators=(",", ":"))
                + ":"
                + _stable_stringify(value[key])
                for key in sorted(value.keys(), key=str)
            )
            + "}"
        )
    return json.dumps(value, separators=(",", ":"))


def _dedupe_requests(requests: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_key: dict[str, dict[str, Any]] = {}
    output: list[dict[str, Any]] = []
    for request in requests:
        key = _stable_stringify(
            {
                "resource": request.get("resource"),
                "method": request.get("method"),
                "path": request.get("path"),
                "query": request.get("query"),
                "body": request.get("body"),
                "purpose": request.get("purpose"),
            }
        )
        candidate_id = _as_string(request.get("candidateId"))
        existing = by_key.get(key)
        if existing:
            candidate_ids = [
                item
                for item in (_as_list(existing.get("candidateIds")))
                if isinstance(item, str)
            ]
            if candidate_id and candidate_id not in candidate_ids:
                existing["candidateIds"] = [*candidate_ids, candidate_id]
            continue
        if candidate_id:
            request["candidateIds"] = [candidate_id]
        by_key[key] = request
        output.append(request)
    return output


def _plan_status(
    candidates: list[dict[str, Any]],
    requests: list[dict[str, Any]],
    is_truncated: bool,
    capability_ok: bool,
) -> str:
    if not capability_ok:
        return "blocked"
    if not candidates:
        return "blocked"
    if (
        is_truncated
        or not requests
        or any(candidate.get("parseStatus") != "parsed" for candidate in candidates)
    ):
        return "partial"
    return "ready"


def _cache_hit_summary(cache_hits: int) -> str:
    suffix = "hit" if cache_hits == 1 else "hits"
    return f"{cache_hits} cache {suffix} can be reused after metadata revalidation."


def create_chat_link_retrieval_plan(
    input_data: Any,
    **options: Any,
) -> dict[str, Any]:
    effective_options = _normalize_options(input_data, options)
    disabled = effective_options.get("enabled") is False
    auth_mode_raw = _as_string(effective_options.get("authMode")) or "user"
    auth_mode = auth_mode_raw if auth_mode_raw in {"user", "app"} else None
    candidates, traversal = _collect_chat_link_candidates_with_traversal(
        input_data,
        effective_options,
    )
    candidates_with_cache = [
        {**candidate, "cache": _cache_status_for(candidate, effective_options)}
        for candidate in candidates
    ]
    requests = (
        _dedupe_requests(
            [
                request
                for candidate in candidates
                for request in _requests_for_candidate(candidate, effective_options)
            ]
        )
        if auth_mode
        else []
    )
    cache_hits = sum(1 for candidate in candidates_with_cache if candidate["cache"]["status"] == "hit")
    unknown = sum(1 for candidate in candidates if candidate["parseStatus"] != "parsed")
    parsed_count = len(candidates) - unknown
    truncation = _truncation_for_traversal(traversal)
    is_truncated = truncation["status"] == "truncated"
    required_scopes = _required_scopes_for_requests(auth_mode, requests) if auth_mode else []
    capability = (
        {
            "ok": True,
            "authMode": auth_mode,
            "requiredScopes": required_scopes,
            "requiresAdminApproval": auth_mode == "app"
            and CHAT_APP_MESSAGES_READONLY_SCOPE in required_scopes,
            "reasons": [],
        }
        if auth_mode
        else {
            "ok": False,
            "authMode": auth_mode_raw,
            "requiredScopes": [],
            "requiresAdminApproval": False,
            "reasons": ["invalid_auth_mode"],
        }
    )
    summary = (
        "Chat link retrieval planning is disabled by option."
        if disabled
        else (
            f"Planned {len(candidates)} Google Chat link candidate reads; {_cache_hit_summary(cache_hits)}"
            if cache_hits
            else f"Planned {len(candidates)} Google Chat link candidate reads in dry-run mode."
        )
    )
    truncation_note = (
        ["System Note: Chat link traversal was capped; some linked Chat context may be omitted."]
        if is_truncated
        else []
    )

    return {
        "kind": "chat.chat_link_retrieval_plan",
        "status": _plan_status(candidates, requests, is_truncated, bool(capability["ok"])),
        "dryRun": True,
        "summary": summary,
        "counts": {
            "candidates": len(candidates),
            "parsed": parsed_count,
            "unknown": unknown,
            "plannedRequests": len(requests),
            "cacheHits": cache_hits,
            "cappedCandidates": traversal["cappedCandidates"],
            "cappedPlainTextUrls": traversal["cappedPlainTextUrls"],
            "cappedPlainTextScanChars": traversal["cappedPlainTextScanChars"],
            "cappedOversizedUrls": traversal["cappedOversizedUrls"],
            "cappedOccurrences": traversal["cappedOccurrences"],
            "cappedTraversalNodes": traversal["cappedTraversalNodes"],
            "cappedLinkScanItems": traversal["cappedLinkScanItems"],
        },
        "truncation": truncation,
        "candidates": candidates_with_cache,
        "requests": requests,
        "capability": capability,
        "safety": {
            "liveAllowed": False,
            "notes": ["Dry run only; no Google Chat API call was executed."],
        },
        "systemNotes": [
            f"System Note: Planned {len(candidates)} linked Google Chat context reads in dry-run mode; no Google Chat API call was executed.",
            "System Note: Chat link cache keys use resource name plus lastUpdateTime when available so edited messages invalidate cached context.",
            *(
                ["System Note: Chat link retrieval planning is disabled by option."]
                if disabled
                else []
            ),
            *truncation_note,
        ],
        "warnings": [
            f"{candidate['candidateId']}: {warning}"
            for candidate in candidates
            for warning in candidate.get("warnings", [])
        ]
        + (
            ["Chat link traversal was capped; some linked Chat context may be omitted."]
            if is_truncated
            else []
        ),
    }


__all__ = [
    "CHAT_APP_MESSAGES_READONLY_SCOPE",
    "CHAT_BOT_SCOPE",
    "CHAT_MESSAGES_READONLY_SCOPE",
    "CHAT_SPACES_READONLY_SCOPE",
    "build_chat_link_cache_key",
    "collect_chat_link_candidates",
    "create_chat_link_retrieval_plan",
]
