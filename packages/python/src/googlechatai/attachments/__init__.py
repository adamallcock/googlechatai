"""Attachment normalization, planning, parsing, and transcription helpers."""

from __future__ import annotations

import base64
import re
import os
from collections.abc import Callable, Mapping
import hashlib
import json
from urllib import request as urllib_request
from urllib.parse import parse_qs, unquote, urlparse
from typing import Any


CHAT_MEDIA_UPLOAD_MAX_BYTES = 209_715_200
DEFAULT_ATTACHMENT_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024
DEFAULT_DRIVE_EXPORT_MAX_BYTES = 10 * 1024 * 1024
DEFAULT_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024
DEFAULT_DRIVE_LINK_MAX_TRAVERSAL_DEPTH = 256
DEFAULT_DRIVE_LINK_MAX_TRAVERSAL_NODES = 5000
DEFAULT_DRIVE_LINK_MAX_LINK_SCAN_ITEMS = 5000
DEFAULT_DRIVE_LINK_MAX_LINKS = 200
DEFAULT_DRIVE_LINK_MAX_PLAIN_TEXT_URLS = 200
DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
DEFAULT_OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-transcribe"
DEFAULT_GEMINI_TRANSCRIPTION_MODEL = "gemini-3.5-flash"
GEMINI_INTERACTIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions"
GEMINI_TRANSCRIPTION_PROMPT = (
    "Generate a transcript of the speech. Return only the transcript text."
)

_DEFAULT_BLOCKED_CONTENT_TYPES = {
    "application/x-msdownload",
    "application/x-dosexec",
    "application/x-executable",
    "application/vnd.microsoft.portable-executable",
}

_DEFAULT_BLOCKED_EXTENSIONS = {
    ".bat",
    ".cmd",
    ".com",
    ".dll",
    ".dmg",
    ".exe",
    ".pkg",
    ".ps1",
    ".scr",
    ".sh",
}

RawMapping = Mapping[str, Any]
Parser = Callable[[dict[str, Any], Any], dict[str, Any]]


def _data_bytes(value: Any) -> bytes | None:
    if isinstance(value, bytes | bytearray | memoryview):
        return bytes(value)
    if isinstance(value, str):
        return value.encode("utf-8")
    return None


def _as_mapping(value: Any) -> RawMapping | None:
    return value if isinstance(value, Mapping) else None


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _as_bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _size_bytes(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float) and value >= 0:
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            parsed = float(value)
        except ValueError:
            return None
        if parsed >= 0:
            return int(parsed)
    return None


def _first_size_bytes(*values: Any) -> int | None:
    for value in values:
        parsed = _size_bytes(value)
        if parsed is not None:
            return parsed
    return None


def _integer_option(value: Any, fallback: int) -> int:
    parsed = _size_bytes(value)
    return parsed if parsed is not None else fallback


def _extension_for(filename: str) -> str:
    dot_index = filename.rfind(".")
    if dot_index <= 0:
        return ""
    return filename[dot_index:].lower()


def _truncate_filename(filename: str, max_length: int = 128) -> str:
    if len(filename) <= max_length:
        return filename
    extension = _extension_for(filename)
    basename_max = max(1, max_length - len(extension))
    return f"{filename[:basename_max]}{extension}"


def sanitize_filename(filename: str | None, fallback: str = "attachment") -> str:
    raw = filename.strip() if isinstance(filename, str) and filename.strip() else fallback
    segments = [segment for segment in re.split(r"[\\/]+", raw) if segment]
    basename = segments[-1] if segments else fallback
    safe = re.sub(r"[\x00-\x1f\x7f]", "", basename)
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", safe)
    safe = re.sub(r"^\.+", "", safe)
    if safe in {"", ".", ".."}:
        safe = fallback
    return _truncate_filename(safe)


def classify_media_kind(content_type: str | None) -> str:
    normalized = content_type.lower() if content_type else ""

    if normalized.startswith("text/"):
        return "text"
    if normalized == "application/json" or normalized.endswith("+json"):
        return "json"
    if normalized == "application/pdf":
        return "pdf"
    if normalized.startswith("image/"):
        return "image"
    if normalized.startswith("audio/"):
        return "audio"
    if normalized.startswith("video/"):
        return "video"
    if normalized in {"application/zip", "application/x-tar", "application/gzip"}:
        return "archive"
    return "unknown"


def _policy_limits(options: Mapping[str, Any] | None = None) -> dict[str, Any]:
    options = options or {}
    return {
        "maxDownloadBytes": options.get(
            "maxDownloadBytes", DEFAULT_ATTACHMENT_DOWNLOAD_MAX_BYTES
        ),
        "maxUploadBytes": options.get("maxUploadBytes", CHAT_MEDIA_UPLOAD_MAX_BYTES),
        "blockedContentTypes": {
            str(item).lower()
            for item in options.get(
                "blockedContentTypes", _DEFAULT_BLOCKED_CONTENT_TYPES
            )
        },
        "blockedExtensions": {
            str(item).lower()
            for item in options.get("blockedExtensions", _DEFAULT_BLOCKED_EXTENSIONS)
        },
    }


def evaluate_attachment_policy(
    input_attachment: Mapping[str, Any],
    options: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    limits = _policy_limits(options)
    reasons: list[str] = []
    content_type = _as_string(input_attachment.get("contentType"))
    safe_filename = str(input_attachment.get("safeFilename") or "")
    content_size_bytes = input_attachment.get("contentSizeBytes")
    extension = _extension_for(safe_filename)

    if content_type and content_type.lower() in limits["blockedContentTypes"]:
        reasons.append("content_type_blocked")
    if extension and extension in limits["blockedExtensions"]:
        reasons.append("extension_blocked")
    if (
        isinstance(content_size_bytes, int)
        and content_size_bytes > limits["maxDownloadBytes"]
    ):
        reasons.append("size_exceeds_download_limit")

    return {
        "status": "blocked" if reasons else "allowed",
        "reasons": reasons,
        "maxDownloadBytes": limits["maxDownloadBytes"],
        "maxUploadBytes": limits["maxUploadBytes"],
    }


def _default_context(context: Mapping[str, Any] | None = None) -> dict[str, Any]:
    context = context or {}
    return {
        "messageName": context.get("messageName"),
        "relationship": context.get("relationship") or "message",
        "path": list(context.get("path") or []),
    }


def _processing_for(media_kind: str, policy_status: str) -> dict[str, Any]:
    if policy_status == "blocked":
        extraction = {
            "status": "blocked",
            "parser": None,
            "text": None,
            "reason": "Attachment is blocked by policy.",
        }
    else:
        extraction = {
            "status": "skipped",
            "parser": None,
            "text": None,
            "reason": "No parser has run.",
        }

    if media_kind == "audio" and policy_status == "allowed":
        transcription = {
            "status": "disabled",
            "provider": None,
            "text": None,
            "reason": "Audio transcription is disabled by default.",
        }
    elif policy_status == "blocked":
        transcription = {
            "status": "skipped",
            "provider": None,
            "text": None,
            "reason": "Attachment is blocked by policy.",
        }
    else:
        transcription = {
            "status": "skipped",
            "provider": None,
            "text": None,
            "reason": "Attachment is not audio.",
        }

    return {"extraction": extraction, "transcription": transcription}


def normalize_attachment(
    value: Any,
    *,
    context: Mapping[str, Any] | None = None,
    policy: Mapping[str, Any] | None = None,
) -> dict[str, Any] | None:
    raw = _as_mapping(value)
    name = _as_string(raw.get("name")) if raw else None

    if not raw or not name:
        return None

    content_name = _as_string(raw.get("contentName"))
    safe_filename = sanitize_filename(content_name, "attachment")
    content_type = _as_string(raw.get("contentType"))
    content_size_bytes = _first_size_bytes(
        raw.get("contentSizeBytes"),
        raw.get("contentSize"),
        raw.get("sizeBytes"),
    )
    attachment_data_ref_raw = _as_mapping(raw.get("attachmentDataRef"))
    attachment_data_ref = (
        {
            "resourceName": _as_string(attachment_data_ref_raw.get("resourceName")),
            "attachmentUploadToken": _as_string(
                attachment_data_ref_raw.get("attachmentUploadToken")
            ),
        }
        if attachment_data_ref_raw
        else None
    )
    drive_data_ref_raw = _as_mapping(raw.get("driveDataRef"))
    drive_data_ref = (
        {
            **drive_data_ref_raw,
            "driveFileId": _as_string(drive_data_ref_raw.get("driveFileId")),
        }
        if drive_data_ref_raw
        else None
    )
    media_resource_name = _as_string(raw.get("mediaResourceName")) or (
        attachment_data_ref["resourceName"] if attachment_data_ref else None
    )
    media_kind = classify_media_kind(content_type)
    policy_result = evaluate_attachment_policy(
        {
            "contentType": content_type,
            "contentSizeBytes": content_size_bytes,
            "safeFilename": safe_filename,
        },
        policy,
    )

    return {
        "name": name,
        "contentName": content_name,
        "safeFilename": safe_filename,
        "contentType": content_type,
        "mediaKind": media_kind,
        "source": _as_string(raw.get("source")),
        "contentSizeBytes": content_size_bytes,
        "mediaResourceName": media_resource_name,
        "attachmentDataRef": attachment_data_ref,
        "driveDataRef": drive_data_ref,
        "thumbnailUri": _as_string(raw.get("thumbnailUri")),
        "downloadUri": _as_string(raw.get("downloadUri")),
        "context": _default_context(context),
        "policy": policy_result,
        "processing": _processing_for(media_kind, policy_result["status"]),
    }


def normalize_attachments(
    value: Any,
    *,
    context: Mapping[str, Any] | None = None,
    policy: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for item in _as_list(value):
        attachment = normalize_attachment(item, context=context, policy=policy)
        if attachment is not None:
            normalized.append(attachment)
    return normalized


def normalize_attachments_from_message(
    message: Any,
    *,
    context: Mapping[str, Any] | None = None,
    policy: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    raw = _as_mapping(message)
    if not raw:
        return []
    attachments = raw.get("attachment") if "attachment" in raw else raw.get("attachments")
    return normalize_attachments(attachments, context=context, policy=policy)


def _message_name_for(message: RawMapping | None) -> str | None:
    ref = _as_mapping(message.get("ref")) if message else None
    return (
        _as_string(message.get("name"))
        if message
        else None
    ) or (_as_string(ref.get("name")) if ref else None)


def _visit_context_node(
    node: Any,
    inherited_path: list[str],
    output: list[dict[str, Any]],
    *,
    policy: Mapping[str, Any] | None = None,
) -> None:
    raw = _as_mapping(node)
    if not raw:
        return

    message = _as_mapping(raw.get("message")) or raw
    relationship = _as_string(raw.get("relationship")) or "message"
    message_name = _message_name_for(message)
    path = (
        [*inherited_path, f"{relationship}:{message_name}"]
        if message_name
        else inherited_path
    )

    output.extend(
        normalize_attachments_from_message(
            message,
            context={
                "messageName": message_name,
                "relationship": relationship,
                "path": path,
            },
            policy=policy,
        )
    )

    for child in _as_list(raw.get("children")):
        _visit_context_node(child, path, output, policy=policy)
    for child in _as_list(raw.get("quotedMessages")):
        _visit_context_node(
            {"relationship": "quoted_message", "message": child},
            path,
            output,
            policy=policy,
        )
    for child in _as_list(raw.get("threadHistory")):
        _visit_context_node(
            {"relationship": "thread_history", "message": child},
            path,
            output,
            policy=policy,
        )

    quoted_message = raw.get("quotedMessage") or message.get("quotedMessage")
    if quoted_message is not None:
        _visit_context_node(
            {"relationship": "quoted_message", "message": quoted_message},
            path,
            output,
            policy=policy,
        )


def collect_attachments_from_context(
    input_context: Any,
    *,
    policy: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    _visit_context_node(input_context, [], output, policy=policy)
    return output


def _live_media_gate(
    *,
    enable_live_media: bool | None = None,
    w7_complete: bool | None = None,
    env: Mapping[str, str | None] | None = None,
) -> dict[str, Any]:
    import os

    selected_env = env or os.environ
    w7_ready = (
        w7_complete
        if w7_complete is not None
        else selected_env.get("GOOGLE_CHAT_AI_W7_MEDIA_READY") == "1"
    )
    media_enabled = (
        enable_live_media
        if enable_live_media is not None
        else selected_env.get("GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA") == "1"
    )
    reasons: list[str] = []

    if not w7_ready:
        reasons.append("w7_not_complete")
    if not media_enabled:
        reasons.append("env_flag_missing")

    return {"allowed": not reasons, "reasons": reasons}


def _join_path(directory: str | None, filename: str) -> str:
    directory = directory or "."
    base = directory[:-1] if directory.endswith("/") else directory
    return f"{base}/{filename}"


def _live_drive_gate(
    *,
    enable_live_drive: bool | None = None,
    env: Mapping[str, str | None] | None = None,
) -> dict[str, Any]:
    env = os.environ if env is None else env
    drive_enabled = (
        enable_live_drive
        if enable_live_drive is not None
        else env.get("GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE") == "1"
    )
    reasons: list[str] = []

    if not drive_enabled:
        reasons.append("env_flag_missing")

    return {"allowed": not reasons, "reasons": reasons}


def _is_google_workspace_mime_type(content_type: str | None) -> bool:
    return bool(content_type and content_type.startswith("application/vnd.google-apps."))


def _drive_export_extension(export_mime_type: str | None) -> str:
    return {
        "text/plain": ".txt",
        "text/csv": ".csv",
        "application/pdf": ".pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    }.get(export_mime_type or "", "")


def _filename_with_export_extension(filename: str, export_mime_type: str | None) -> str:
    extension = _drive_export_extension(export_mime_type)
    if not extension or filename.lower().endswith(extension):
        return filename
    existing_extension = _extension_for(filename)
    basename = filename[: -len(existing_extension)] if existing_extension else filename
    return f"{basename}{extension}"


def default_drive_export_mime_type(content_type: str | None) -> str | None:
    if content_type == "application/vnd.google-apps.document":
        return "text/plain"
    if content_type == "application/vnd.google-apps.spreadsheet":
        return "text/csv"
    if content_type == "application/vnd.google-apps.presentation":
        return "text/plain"
    if content_type == "application/vnd.google-apps.drawing":
        return "image/png"
    if _is_google_workspace_mime_type(content_type):
        return "application/pdf"
    return None


def create_download_plan(
    attachment: Mapping[str, Any],
    *,
    target_directory: str = ".",
    enable_live_media: bool | None = None,
    w7_complete: bool | None = None,
    env: Mapping[str, str | None] | None = None,
) -> dict[str, Any]:
    policy = _as_mapping(attachment.get("policy")) or {}
    policy_reasons = list(policy.get("reasons") or []) if policy.get("status") == "blocked" else []
    blocked_reasons = [*policy_reasons]

    drive_data_ref = _as_mapping(attachment.get("driveDataRef")) or {}
    is_drive_backed = attachment.get("source") == "DRIVE_FILE" or bool(drive_data_ref)
    if not attachment.get("mediaResourceName"):
        blocked_reasons.append(
            "drive_api_required"
            if is_drive_backed
            else "media_resource_missing"
        )

    status = "blocked" if blocked_reasons else "dry_run"
    gate = _live_media_gate(
        enable_live_media=enable_live_media,
        w7_complete=w7_complete,
        env=env,
    )
    plan = {
        "kind": "download",
        "status": status,
        "dryRun": True,
        "canExecuteLive": gate["allowed"] and status != "blocked",
        "liveGate": gate,
        "attachmentName": attachment.get("name"),
        "mediaResourceName": attachment.get("mediaResourceName"),
        "method": "GET",
        "url": (
            f"https://chat.googleapis.com/v1/media/{attachment['mediaResourceName']}?alt=media"
            if attachment.get("mediaResourceName")
            else None
        ),
        "destinationPath": _join_path(
            target_directory, str(attachment.get("safeFilename") or "attachment")
        ),
        "policy": {
            "status": policy.get("status"),
            "reasons": list(policy.get("reasons") or []),
        },
        "auth": {
            "required": True,
            "modes": ["app", "user"],
            "scopes": [
                "https://www.googleapis.com/auth/chat.bot",
                "https://www.googleapis.com/auth/chat.messages",
                "https://www.googleapis.com/auth/chat.messages.readonly",
            ],
        },
        "alternateContentApi": (
            {
                "kind": "drive",
                "required": True,
                "driveFileIdAvailable": bool(_as_string(drive_data_ref.get("driveFileId"))),
                "method": "GET",
                "reason": "Drive-backed Google Chat attachments must be read with the Google Drive API.",
                "auth": {
                    "required": True,
                    "modes": ["user"],
                    "scopes": ["https://www.googleapis.com/auth/drive.readonly"],
                },
            }
            if is_drive_backed
            else None
        ),
    }

    if blocked_reasons:
        plan["blockedReasons"] = blocked_reasons

    return plan


def create_drive_export_plan(
    attachment: Mapping[str, Any],
    *,
    target_directory: str = ".",
    export_mime_type: str | None = None,
    enable_live_drive: bool | None = None,
    env: Mapping[str, str | None] | None = None,
) -> dict[str, Any]:
    target_directory = target_directory or "."
    policy = _as_mapping(attachment.get("policy")) or {}
    policy_reasons = list(policy.get("reasons") or []) if policy.get("status") == "blocked" else []
    blocked_reasons = [*policy_reasons]
    drive_data_ref = _as_mapping(attachment.get("driveDataRef")) or {}
    is_drive_backed = attachment.get("source") == "DRIVE_FILE" or bool(drive_data_ref)
    drive_file_id = _as_string(drive_data_ref.get("driveFileId"))
    source_content_type = _as_string(attachment.get("contentType"))
    is_workspace_file = _is_google_workspace_mime_type(source_content_type)
    resolved_export_mime_type = export_mime_type or default_drive_export_mime_type(
        source_content_type
    )
    content_api = "drive.files.export" if is_workspace_file else "drive.files.get_media"

    if not is_drive_backed:
        blocked_reasons.append("not_drive_backed")
    if not drive_file_id:
        blocked_reasons.append("drive_file_id_missing")
    if is_workspace_file and not resolved_export_mime_type:
        blocked_reasons.append("drive_export_mime_type_missing")

    gate = _live_drive_gate(enable_live_drive=enable_live_drive, env=env)
    status = "blocked" if blocked_reasons else "dry_run"
    output_filename = _filename_with_export_extension(
        str(attachment.get("safeFilename") or "attachment"),
        resolved_export_mime_type if is_workspace_file else source_content_type,
    )
    if drive_file_id and content_api == "drive.files.export":
        from urllib.parse import quote

        url = (
            "https://www.googleapis.com/drive/v3/files/"
            f"{quote(drive_file_id, safe='')}/export?mimeType="
            f"{quote(resolved_export_mime_type or '', safe='')}"
        )
    elif drive_file_id:
        from urllib.parse import quote

        url = f"https://www.googleapis.com/drive/v3/files/{quote(drive_file_id, safe='')}?alt=media"
    else:
        url = None

    plan = {
        "kind": "drive_export",
        "status": status,
        "dryRun": True,
        "canExecuteLive": gate["allowed"] and status != "blocked",
        "liveGate": gate,
        "attachmentName": attachment.get("name"),
        "contentApi": content_api,
        "method": "GET",
        "url": url,
        "driveFileIdAvailable": bool(drive_file_id),
        "sourceContentType": source_content_type,
        "exportMimeType": resolved_export_mime_type if is_workspace_file else None,
        "destinationPath": _join_path(target_directory, output_filename),
        "maxExportBytes": DEFAULT_DRIVE_EXPORT_MAX_BYTES,
        "policy": {
            "status": policy.get("status"),
            "reasons": list(policy.get("reasons") or []),
        },
        "auth": {
            "required": True,
            "mode": "user",
            "scopes": [DRIVE_READONLY_SCOPE],
        },
    }

    if blocked_reasons:
        plan["blockedReasons"] = blocked_reasons

    return plan


def _default_drive_link_context(
    context: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    context = context or {}
    return {
        "messageName": context.get("messageName"),
        "relationship": context.get("relationship") or "message",
        "path": list(context.get("path") or []),
    }


def _message_name_for_drive_links(message: RawMapping | None) -> str | None:
    ref = _as_mapping(message.get("ref")) if message else None
    return (
        _as_string(message.get("name"))
        if message
        else None
    ) or (_as_string(ref.get("name")) if ref else None)


def _append_drive_link_path(
    context: Mapping[str, Any],
    relationship: str,
    message_name: str | None,
    traversal: dict[str, Any],
) -> dict[str, Any]:
    path = list(context.get("path") or [])
    if message_name:
        path.append(f"{relationship}:{message_name}")
    else:
        path.append(f"{relationship}:node-{traversal['nextAnonymousPathId']}")
        traversal["nextAnonymousPathId"] += 1
    return {
        "messageName": message_name,
        "relationship": relationship,
        "path": path,
    }


def _rich_link_title_from_metadata(metadata: Mapping[str, Any]) -> str | None:
    drive_data = _as_mapping(metadata.get("driveLinkData")) or {}
    chat_space_data = _as_mapping(metadata.get("chatSpaceLinkData")) or {}
    return (
        _as_string(metadata.get("title"))
        or _as_string(drive_data.get("title"))
        or _as_string(chat_space_data.get("spaceDisplayName"))
    )


def _add_drive_link_entry(
    entries: list[dict[str, Any]],
    seen: set[str],
    entry: dict[str, Any],
    traversal: dict[str, Any],
) -> None:
    if traversal["entryCount"] >= traversal["maxDriveLinks"]:
        traversal["cappedDriveLinks"] += 1
        return

    context = _as_mapping(entry.get("context")) or {}
    key = f"{'>'.join(str(item) for item in context.get('path') or [])}:{entry['url']}"
    if key in seen:
        return
    seen.add(key)
    traversal["entryCount"] += 1
    entries.append(entry)


def _drive_link_output_capacity_reached(traversal: Mapping[str, Any]) -> bool:
    return int(traversal.get("entryCount") or 0) >= int(
        traversal.get("maxDriveLinks") or 0
    )


def _consume_drive_link_traversal_node(traversal: dict[str, Any]) -> bool:
    if traversal["traversalNodeCount"] >= traversal["maxTraversalNodes"]:
        traversal["cappedTraversalNodes"] += 1
        return False
    traversal["traversalNodeCount"] += 1
    return True


def _consume_drive_link_scan_item(
    traversal: dict[str, Any], remaining_items: int
) -> bool:
    if traversal["linkScanItemCount"] >= traversal["maxLinkScanItems"]:
        traversal["cappedLinkScanItems"] += remaining_items
        return False
    traversal["linkScanItemCount"] += 1
    return True


def _drive_link_branch_traversal_closed(traversal: Mapping[str, Any]) -> bool:
    return _drive_link_output_capacity_reached(traversal) or int(
        traversal.get("traversalNodeCount") or 0
    ) >= int(traversal.get("maxTraversalNodes") or 0)


def _abandon_drive_link_branches(
    traversal: dict[str, Any], remaining_branches: int
) -> None:
    if remaining_branches > 0:
        traversal["cappedTraversalNodes"] += remaining_branches


def _link_source_for(kind: str | None) -> str | None:
    if kind == "richLink":
        return "rich_link"
    if kind == "matchedUrl":
        return "matched_url"
    if kind in {"plain_url", "plainUrl"}:
        return "plain_url"
    return None


def _collect_drive_link_entries_from_links(
    value: Any,
    context: Mapping[str, Any],
    entries: list[dict[str, Any]],
    seen: set[str],
    options: Mapping[str, Any],
    traversal: dict[str, Any],
) -> None:
    items = _as_list(value)
    for index, item in enumerate(items):
        if not _consume_drive_link_scan_item(traversal, len(items) - index):
            return
        raw = _as_mapping(item)
        if not raw:
            continue
        source = _link_source_for(_as_string(raw.get("kind")))
        if not source:
            continue
        if source == "matched_url" and options.get("includeMatchedUrls") is False:
            continue
        if source == "plain_url" and options.get("includePlainTextUrls") is False:
            continue
        url = _as_string(raw.get("url"))
        if not url:
            continue
        _add_drive_link_entry(
            entries,
            seen,
            {
                "source": source,
                "url": url,
                "title": _as_string(raw.get("title")),
                "richLinkType": _as_string(raw.get("richLinkType")),
                "mimeType": _as_string(raw.get("mimeType")),
                "context": dict(context),
            },
            traversal,
        )


def _collect_raw_drive_link_annotations(
    value: Any,
    context: Mapping[str, Any],
    entries: list[dict[str, Any]],
    seen: set[str],
    traversal: dict[str, Any],
) -> None:
    items = _as_list(value)
    for index, item in enumerate(items):
        if not _consume_drive_link_scan_item(traversal, len(items) - index):
            return
        raw = _as_mapping(item)
        raw_type = _as_string(raw.get("type")) if raw else None
        if not raw or raw_type != "RICH_LINK":
            continue
        metadata = _as_mapping(raw.get("richLinkMetadata")) or {}
        url = _as_string(metadata.get("uri"))
        if not url:
            continue
        _add_drive_link_entry(
            entries,
            seen,
            {
                "source": "rich_link",
                "url": url,
                "title": _rich_link_title_from_metadata(metadata),
                "richLinkType": _as_string(metadata.get("richLinkType")),
                "mimeType": _as_string(metadata.get("mimeType")),
                "context": dict(context),
            },
            traversal,
        )


def _collect_matched_url(
    value: Any,
    context: Mapping[str, Any],
    entries: list[dict[str, Any]],
    seen: set[str],
    options: Mapping[str, Any],
    traversal: dict[str, Any],
) -> None:
    if options.get("includeMatchedUrls") is False:
        return
    matched_url = _as_mapping(value)
    url = _as_string(matched_url.get("url")) if matched_url else None
    if not url:
        return
    _add_drive_link_entry(
        entries,
        seen,
        {
            "source": "matched_url",
            "url": url,
            "title": None,
            "richLinkType": None,
            "mimeType": None,
            "context": dict(context),
        },
        traversal,
    )


def _strip_trailing_url_punctuation(url: str) -> str:
    return re.sub(r"[),.;\]]+$", "", url)


def _collect_plain_text_drive_urls(
    text: str | None,
    context: Mapping[str, Any],
    entries: list[dict[str, Any]],
    seen: set[str],
    options: Mapping[str, Any],
    traversal: dict[str, Any],
) -> None:
    if options.get("includePlainTextUrls") is False or not text:
        return
    for match in re.finditer(r"https?://[^\s<>\"']+", text):
        if traversal["plainTextUrlCount"] >= traversal["maxPlainTextUrls"]:
            traversal["cappedPlainTextUrls"] += 1
            return
        traversal["plainTextUrlCount"] += 1
        url = _strip_trailing_url_punctuation(match.group(0))
        _add_drive_link_entry(
            entries,
            seen,
            {
                "source": "plain_url",
                "url": url,
                "title": None,
                "richLinkType": None,
                "mimeType": None,
                "context": dict(context),
            },
            traversal,
        )


def _collect_drive_link_entries_from_node(
    input_data: Any,
    context: Mapping[str, Any],
    entries: list[dict[str, Any]],
    seen: set[str],
    options: Mapping[str, Any],
    traversal: dict[str, Any],
    depth: int = 0,
) -> None:
    if depth >= traversal["maxDepth"]:
        traversal["truncatedBranches"] += 1
        return

    if isinstance(input_data, list):
        _collect_drive_link_entries_from_links(
            input_data, context, entries, seen, options, traversal
        )
        return

    raw = _as_mapping(input_data)
    if not raw:
        return
    raw_id = id(raw)
    active_nodes = traversal["activeNodes"]
    if raw_id in active_nodes:
        traversal["truncatedBranches"] += 1
        return
    if not _consume_drive_link_traversal_node(traversal):
        return

    active_nodes.add(raw_id)
    try:
        _collect_drive_link_entries_from_mapping(
            raw, context, entries, seen, options, traversal, depth
        )
    finally:
        active_nodes.discard(raw_id)


def _collect_drive_link_entries_from_mapping(
    raw: Mapping[str, Any],
    context: Mapping[str, Any],
    entries: list[dict[str, Any]],
    seen: set[str],
    options: Mapping[str, Any],
    traversal: dict[str, Any],
    depth: int,
) -> None:

    wrapper_only_links = (
        "links" in raw
        and "relationship" not in raw
        and "ref" not in raw
        and "name" not in raw
        and "text" not in raw
        and "annotations" not in raw
        and "matchedUrl" not in raw
    )
    if "context" in raw or wrapper_only_links:
        if "links" in raw:
            _collect_drive_link_entries_from_links(
                raw.get("links"), context, entries, seen, options, traversal
            )
        if raw.get("message") is not None:
            if _drive_link_branch_traversal_closed(traversal):
                _abandon_drive_link_branches(traversal, 1)
            else:
                _collect_drive_link_entries_from_node(
                    raw.get("message"),
                    context,
                    entries,
                    seen,
                    options,
                    traversal,
                    depth + 1,
                )
        if raw.get("context") is not None:
            if _drive_link_branch_traversal_closed(traversal):
                _abandon_drive_link_branches(traversal, 1)
            else:
                _collect_drive_link_entries_from_node(
                    raw.get("context"),
                    context,
                    entries,
                    seen,
                    options,
                    traversal,
                    depth + 1,
                )
        return

    relationship = _as_string(raw.get("relationship")) or str(context.get("relationship"))
    message = _as_mapping(raw.get("message")) or raw
    message_name = _message_name_for_drive_links(message)
    message_context = _append_drive_link_path(
        context, relationship, message_name, traversal
    )

    if message is not raw and "links" in raw:
        _collect_drive_link_entries_from_links(
            raw.get("links"), message_context, entries, seen, options, traversal
        )
    _collect_drive_link_entries_from_links(
        message.get("links"), message_context, entries, seen, options, traversal
    )
    _collect_raw_drive_link_annotations(
        message.get("annotations"), message_context, entries, seen, traversal
    )
    _collect_matched_url(
        message.get("matchedUrl"), message_context, entries, seen, options, traversal
    )
    _collect_plain_text_drive_urls(
        _as_string(message.get("text"))
        or _as_string(message.get("formattedText"))
        or _as_string(message.get("argumentText")),
        message_context,
        entries,
        seen,
        options,
        traversal,
    )

    child_sources = [raw] if message is raw else [raw, message]
    for source in child_sources:
        children = _as_list(source.get("children"))
        for index, child in enumerate(children):
            if _drive_link_branch_traversal_closed(traversal):
                _abandon_drive_link_branches(traversal, len(children) - index)
                break
            _collect_drive_link_entries_from_node(
                child, message_context, entries, seen, options, traversal, depth + 1
            )
        quoted_messages = _as_list(source.get("quotedMessages"))
        for index, child in enumerate(quoted_messages):
            if _drive_link_branch_traversal_closed(traversal):
                _abandon_drive_link_branches(
                    traversal, len(quoted_messages) - index
                )
                break
            _collect_drive_link_entries_from_node(
                {"relationship": "quoted_message", "message": child},
                message_context,
                entries,
                seen,
                options,
                traversal,
                depth + 1,
            )
        thread_history = _as_list(source.get("threadHistory"))
        for index, child in enumerate(thread_history):
            if _drive_link_branch_traversal_closed(traversal):
                _abandon_drive_link_branches(traversal, len(thread_history) - index)
                break
            _collect_drive_link_entries_from_node(
                {"relationship": "thread_history", "message": child},
                message_context,
                entries,
                seen,
                options,
                traversal,
                depth + 1,
            )

        quoted_message = source.get("quotedMessage")
        if quoted_message is not None:
            if _drive_link_branch_traversal_closed(traversal):
                _abandon_drive_link_branches(traversal, 1)
            else:
                _collect_drive_link_entries_from_node(
                    {"relationship": "quoted_message", "message": quoted_message},
                    message_context,
                    entries,
                    seen,
                    options,
                    traversal,
                    depth + 1,
                )

        context_node = _as_mapping(source.get("contextNode"))
        if context_node:
            context_children = _as_list(context_node.get("children"))
            for index, child in enumerate(context_children):
                if _drive_link_branch_traversal_closed(traversal):
                    _abandon_drive_link_branches(
                        traversal, len(context_children) - index
                    )
                    break
                _collect_drive_link_entries_from_node(
                    child, message_context, entries, seen, options, traversal, depth + 1
                )


def _drive_file_kind_for_mime_type(mime_type: str | None) -> str | None:
    return {
        "application/vnd.google-apps.document": "document",
        "application/vnd.google-apps.spreadsheet": "spreadsheet",
        "application/vnd.google-apps.presentation": "presentation",
        "application/vnd.google-apps.drawing": "drawing",
        "application/vnd.google-apps.folder": "folder",
    }.get(mime_type or "")


def _mime_type_for_drive_file_kind(kind: str | None) -> str | None:
    return {
        "document": "application/vnd.google-apps.document",
        "spreadsheet": "application/vnd.google-apps.spreadsheet",
        "presentation": "application/vnd.google-apps.presentation",
        "drawing": "application/vnd.google-apps.drawing",
        "folder": "application/vnd.google-apps.folder",
    }.get(kind or "")


def _decode_path_segment(value: str | None) -> str | None:
    return unquote(value) if value else None


def _docs_kind_for_path_kind(kind: str | None) -> str:
    return {
        "document": "document",
        "spreadsheets": "spreadsheet",
        "presentation": "presentation",
        "drawings": "drawing",
    }.get(kind or "", "unknown")


def _parse_drive_url(url: str) -> dict[str, Any]:
    try:
        parsed = urlparse(url)
        host = parsed.hostname.lower() if parsed.hostname else ""
    except ValueError:
        return {
            "isDriveUrl": False,
            "driveFileId": None,
            "driveFileKind": "unknown",
            "mimeType": None,
            "blockedReasons": ["invalid_url"],
        }
    if not parsed.scheme or not parsed.netloc:
        return {
            "isDriveUrl": False,
            "driveFileId": None,
            "driveFileKind": "unknown",
            "mimeType": None,
            "blockedReasons": ["invalid_url"],
        }

    path = [segment for segment in parsed.path.split("/") if segment]

    if host == "docs.google.com":
        drive_file_kind = _docs_kind_for_path_kind(path[0] if path else None)
        id_index = path.index("d") + 1 if "d" in path else -1
        published_url_without_drive_id = id_index > 0 and id_index < len(path) and path[id_index] == "e"
        drive_file_id = (
            _decode_path_segment(path[id_index]) if id_index > 0 and id_index < len(path) else None
        )
        if published_url_without_drive_id:
            drive_file_id = None
        blocked_reasons = (
            ["published_docs_url_unsupported"]
            if published_url_without_drive_id
            else ["unsupported_docs_file_kind"]
            if drive_file_id and drive_file_kind == "unknown"
            else []
            if drive_file_id
            else ["drive_file_id_missing"]
        )
        return {
            "isDriveUrl": True,
            "driveFileId": drive_file_id,
            "driveFileKind": drive_file_kind,
            "mimeType": _mime_type_for_drive_file_kind(drive_file_kind),
            "blockedReasons": blocked_reasons,
        }

    if host != "drive.google.com":
        return {
            "isDriveUrl": False,
            "driveFileId": None,
            "driveFileKind": "unknown",
            "mimeType": None,
            "blockedReasons": [],
        }

    if "file" in path:
        file_index = path.index("file")
        if file_index + 1 < len(path) and path[file_index + 1] == "d":
            drive_file_id = (
                _decode_path_segment(path[file_index + 2])
                if file_index + 2 < len(path)
                else None
            )
            return {
                "isDriveUrl": True,
                "driveFileId": drive_file_id,
                "driveFileKind": "blob",
                "mimeType": None,
                "blockedReasons": [] if drive_file_id else ["drive_file_id_missing"],
            }

    if "folders" in path:
        folder_index = path.index("folders")
        drive_file_id = (
            _decode_path_segment(path[folder_index + 1])
            if folder_index + 1 < len(path)
            else None
        )
        return {
            "isDriveUrl": True,
            "driveFileId": drive_file_id,
            "driveFileKind": "folder",
            "mimeType": None,
            "blockedReasons": ["drive_folder_not_file"],
        }

    query = parse_qs(parsed.query)
    query_file_id = query.get("id", [None])[0]
    return {
        "isDriveUrl": True,
        "driveFileId": query_file_id,
        "driveFileKind": "blob",
        "mimeType": None,
        "blockedReasons": [] if query_file_id else ["drive_file_id_missing"],
    }


def _drive_candidate_from_entry(entry: Mapping[str, Any], index: int) -> dict[str, Any]:
    parsed = _parse_drive_url(str(entry.get("url")))
    if not parsed["isDriveUrl"]:
        return {
            "source": entry.get("source"),
            "url": entry.get("url"),
            "reason": "not_google_drive_url",
            "context": entry.get("context"),
        }

    mime_type = entry.get("mimeType") or parsed.get("mimeType")
    mime_kind = _drive_file_kind_for_mime_type(_as_string(mime_type))
    drive_file_kind = mime_kind or parsed["driveFileKind"]
    blocked_reasons = list(dict.fromkeys(parsed["blockedReasons"]))

    if not parsed.get("driveFileId") and "drive_file_id_missing" not in blocked_reasons:
        blocked_reasons.append("drive_file_id_missing")
    if drive_file_kind == "folder" and "drive_folder_not_file" not in blocked_reasons:
        blocked_reasons.append("drive_folder_not_file")

    drive_file_id = parsed.get("driveFileId")
    return {
        "kind": "drive_link",
        "candidateId": f"drive-link:{index}:{drive_file_id or 'missing'}",
        "source": entry.get("source"),
        "url": entry.get("url"),
        "title": entry.get("title"),
        "richLinkType": entry.get("richLinkType"),
        "mimeType": mime_type,
        "driveFileId": drive_file_id,
        "driveFileKind": drive_file_kind,
        "retrievable": not blocked_reasons,
        "blockedReasons": blocked_reasons,
        "context": entry.get("context"),
    }


def _collect_drive_links_with_ignored(
    input_data: Any,
    options: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    options = _normalize_drive_link_options(options)
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    traversal = _create_drive_link_traversal(options)
    _collect_drive_link_entries_from_node(
        input_data,
        _default_drive_link_context(),
        entries,
        seen,
        options,
        traversal,
    )

    candidates: list[dict[str, Any]] = []
    ignored_links: list[dict[str, Any]] = []
    for entry in entries:
        result = _drive_candidate_from_entry(entry, len(candidates))
        if result.get("kind") == "drive_link":
            candidates.append(result)
        else:
            ignored_links.append(result)
    return {
        "candidates": candidates,
        "ignoredLinks": ignored_links,
        "traversal": traversal,
    }


_DRIVE_LINK_OPTION_ALIASES = {
    "target_directory": "targetDirectory",
    "export_mime_type": "exportMimeType",
    "enable_live_drive": "enableLiveDrive",
    "include_plain_text_urls": "includePlainTextUrls",
    "include_matched_urls": "includeMatchedUrls",
    "max_drive_links": "maxDriveLinks",
    "max_plain_text_urls": "maxPlainTextUrls",
    "max_traversal_depth": "maxTraversalDepth",
    "max_traversal_nodes": "maxTraversalNodes",
    "max_link_scan_items": "maxLinkScanItems",
}

_DRIVE_LINK_CACHE_ALIASES = {
    "entries_by_candidate_id": "entriesByCandidateId",
    "entries_by_file_id": "entriesByFileId",
    "entries_by_url": "entriesByUrl",
}


def _normalize_drive_link_cache(cache: Any) -> Any:
    raw = _as_mapping(cache)
    if not raw:
        return cache
    return {
        _DRIVE_LINK_CACHE_ALIASES.get(str(key), str(key)): value
        for key, value in raw.items()
    }


def _normalize_drive_link_options(options: Mapping[str, Any] | None) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for key, value in (options or {}).items():
        normalized_key = _DRIVE_LINK_OPTION_ALIASES.get(str(key), str(key))
        normalized[normalized_key] = (
            _normalize_drive_link_cache(value)
            if normalized_key == "cache"
            else value
        )
    return normalized


def _create_drive_link_traversal(options: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "nextAnonymousPathId": 1,
        "activeNodes": set(),
        "maxDepth": _integer_option(
            options.get("maxTraversalDepth"), DEFAULT_DRIVE_LINK_MAX_TRAVERSAL_DEPTH
        ),
        "maxTraversalNodes": _integer_option(
            options.get("maxTraversalNodes"), DEFAULT_DRIVE_LINK_MAX_TRAVERSAL_NODES
        ),
        "maxLinkScanItems": _integer_option(
            options.get("maxLinkScanItems"), DEFAULT_DRIVE_LINK_MAX_LINK_SCAN_ITEMS
        ),
        "maxDriveLinks": _integer_option(
            options.get("maxDriveLinks"), DEFAULT_DRIVE_LINK_MAX_LINKS
        ),
        "maxPlainTextUrls": _integer_option(
            options.get("maxPlainTextUrls"), DEFAULT_DRIVE_LINK_MAX_PLAIN_TEXT_URLS
        ),
        "entryCount": 0,
        "traversalNodeCount": 0,
        "linkScanItemCount": 0,
        "plainTextUrlCount": 0,
        "truncatedBranches": 0,
        "cappedTraversalNodes": 0,
        "cappedLinkScanItems": 0,
        "cappedDriveLinks": 0,
        "cappedPlainTextUrls": 0,
    }


def collect_drive_link_candidates(
    input_data: Any,
    **options: Any,
) -> list[dict[str, Any]]:
    return _collect_drive_links_with_ignored(input_data, options)["candidates"]


def _cache_plan_for_drive_link(
    candidate: Mapping[str, Any],
    options: Mapping[str, Any],
) -> dict[str, Any]:
    cache = _as_mapping(options.get("cache")) or {}
    entries_by_candidate = _as_mapping(cache.get("entriesByCandidateId")) or {}
    entries_by_file = _as_mapping(cache.get("entriesByFileId")) or {}
    entries_by_url = _as_mapping(cache.get("entriesByUrl")) or {}
    entry = (
        _as_mapping(entries_by_candidate.get(candidate.get("candidateId")))
        or _as_mapping(entries_by_file.get(candidate.get("driveFileId")))
        or _as_mapping(entries_by_url.get(candidate.get("url")))
    )

    if not entry:
        return {
            "status": "miss",
            "key": None,
            "negative": False,
            "reason": None,
            "metadata": {},
        }

    negative = _as_bool(entry.get("negative")) or False
    return {
        "status": "negative_hit" if negative else "hit",
        "key": _as_string(entry.get("key")),
        "negative": negative,
        "reason": _as_string(entry.get("reason")),
        "metadata": dict(_as_mapping(entry.get("metadata")) or {}),
    }


def _attachment_for_drive_link(
    candidate: Mapping[str, Any],
    options: Mapping[str, Any],
) -> dict[str, Any] | None:
    if (
        not candidate.get("driveFileId")
        or candidate.get("driveFileKind") == "folder"
        or candidate.get("blockedReasons")
    ):
        return None

    return normalize_attachment(
        {
            "name": f"driveLinks/{candidate['driveFileId']}",
            "contentName": candidate.get("title") or candidate.get("driveFileId"),
            "contentType": candidate.get("mimeType")
            or _mime_type_for_drive_file_kind(_as_string(candidate.get("driveFileKind"))),
            "source": "DRIVE_FILE",
            "driveDataRef": {
                "driveFileId": candidate.get("driveFileId"),
            },
        },
        context={
            "messageName": (_as_mapping(candidate.get("context")) or {}).get("messageName"),
            "relationship": "drive_link",
            "path": (_as_mapping(candidate.get("context")) or {}).get("path") or [],
        },
        policy=_as_mapping(options.get("policy")),
    )


def _fallback_for_drive_link(
    candidate: Mapping[str, Any],
    cache: Mapping[str, Any],
    drive_export_plan: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if cache.get("status") == "negative_hit":
        return {
            "status": "blocked",
            "action": "cached_unavailable",
            "reason": _as_string(cache.get("reason"))
            or "A previous Drive link retrieval attempt recorded this content as unavailable.",
        }

    blocked_reasons = list(candidate.get("blockedReasons") or [])
    if "published_docs_url_unsupported" in blocked_reasons:
        return {
            "status": "blocked",
            "action": "metadata_only",
            "reason": "Published Docs URLs do not expose a Drive file ID that can be exported by this planner.",
        }

    if "unsupported_docs_file_kind" in blocked_reasons:
        return {
            "status": "blocked",
            "action": "metadata_only",
            "reason": "Drive link points to an unsupported Google Docs editor file kind.",
        }

    if "drive_folder_not_file" in blocked_reasons:
        return {
            "status": "blocked",
            "action": "metadata_only",
            "reason": "Drive folders are not file content and cannot be exported by this planner.",
        }

    if not candidate.get("driveFileId"):
        return {
            "status": "blocked",
            "action": "metadata_only",
            "reason": "Drive link does not expose a file ID that can be exported.",
        }

    if drive_export_plan and drive_export_plan.get("status") != "blocked":
        return {
            "status": "ready",
            "action": "drive_export",
            "reason": "Drive link can be exported with Google Drive user auth.",
        }

    return {
        "status": "blocked",
        "action": "metadata_only",
        "reason": "Drive link content is not currently exportable; render metadata only.",
    }


def _drive_link_display(candidate: Mapping[str, Any]) -> str:
    return str(candidate.get("title") or candidate.get("url"))


def _system_note_for_drive_link(
    candidate: Mapping[str, Any],
    fallback: Mapping[str, Any],
    drive_export_plan: Mapping[str, Any] | None,
) -> str:
    if fallback.get("status") == "ready":
        display = (
            f"{_drive_link_display(candidate)} at {candidate.get('url')}"
            if candidate.get("title")
            else str(candidate.get("url"))
        )
        return (
            f"System Note: Drive link {display} "
            f"is planned with {drive_export_plan.get('contentApi') if drive_export_plan else 'Google Drive'} "
            "using Google Drive user auth."
        )
    return (
        f"System Note: Drive link {candidate.get('url')} cannot be retrieved: "
        f"{fallback.get('reason')}"
    )


def _traversal_limit_summary(traversal: Mapping[str, Any]) -> dict[str, Any] | None:
    truncated = (
        int(traversal.get("truncatedBranches") or 0) > 0
        or int(traversal.get("cappedTraversalNodes") or 0) > 0
        or int(traversal.get("cappedLinkScanItems") or 0) > 0
        or int(traversal.get("cappedDriveLinks") or 0) > 0
        or int(traversal.get("cappedPlainTextUrls") or 0) > 0
    )
    if not truncated:
        return None
    return {
        "status": "truncated",
        "maxTraversalDepth": traversal.get("maxDepth"),
        "maxTraversalNodes": traversal.get("maxTraversalNodes"),
        "maxLinkScanItems": traversal.get("maxLinkScanItems"),
        "maxDriveLinks": traversal.get("maxDriveLinks"),
        "maxPlainTextUrls": traversal.get("maxPlainTextUrls"),
        "truncatedBranches": traversal.get("truncatedBranches"),
        "cappedTraversalNodes": traversal.get("cappedTraversalNodes"),
        "cappedLinkScanItems": traversal.get("cappedLinkScanItems"),
        "cappedDriveLinks": traversal.get("cappedDriveLinks"),
        "cappedPlainTextUrls": traversal.get("cappedPlainTextUrls"),
    }


def _traversal_limit_system_note(summary: Mapping[str, Any]) -> str:
    return (
        "System Note: Drive link traversal was capped; skipped "
        f"{summary.get('truncatedBranches')} deep or cyclic branch(es), "
        f"{summary.get('cappedTraversalNodes')} traversal node(s), "
        f"{summary.get('cappedLinkScanItems')} link scan item(s), "
        f"{summary.get('cappedDriveLinks')} link candidate(s), and "
        f"{summary.get('cappedPlainTextUrls')} plain-text URL(s)."
    )


def create_drive_link_retrieval_plan(
    input_data: Any,
    **options_override: Any,
) -> dict[str, Any]:
    raw = _as_mapping(input_data)
    input_options = _as_mapping(raw.get("options")) if raw else None
    options = {
        **_normalize_drive_link_options(input_options),
        **_normalize_drive_link_options(options_override),
    }
    source_input = (
        {
            "message": raw.get("message"),
            "context": raw.get("context"),
            "links": raw.get("links"),
        }
        if raw and any(key in raw for key in ("message", "context", "links"))
        else input_data
    )
    collected = _collect_drive_links_with_ignored(source_input, options)
    candidates = collected["candidates"]
    ignored_links = collected["ignoredLinks"]
    traversal = collected["traversal"]

    links: list[dict[str, Any]] = []
    counts = {
        "candidates": len(candidates),
        "driveExports": 0,
        "blocked": 0,
        "cacheHits": 0,
        "fallbacks": 0,
        "ignored": len(ignored_links),
    }
    for candidate in candidates:
        cache = _cache_plan_for_drive_link(candidate, options)
        attachment = (
            None
            if cache.get("status") == "negative_hit"
            else _attachment_for_drive_link(candidate, options)
        )
        drive_export_plan = (
            create_drive_export_plan(
                attachment,
                target_directory=options.get("targetDirectory", "."),
                export_mime_type=options.get("exportMimeType"),
                enable_live_drive=options.get("enableLiveDrive"),
                env=options.get("env"),
            )
            if attachment
            else None
        )
        fallback = _fallback_for_drive_link(candidate, cache, drive_export_plan)
        if (
            fallback.get("status") == "ready"
            and drive_export_plan
            and drive_export_plan.get("status") != "blocked"
        ):
            counts["driveExports"] += 1
        if fallback.get("status") == "blocked":
            counts["blocked"] += 1
        if cache.get("status") in {"hit", "negative_hit"}:
            counts["cacheHits"] += 1
        if fallback.get("status") != "ready":
            counts["fallbacks"] += 1
        links.append(
            {
                "candidate": candidate,
                "cache": cache,
                "driveExportPlan": drive_export_plan,
                "fallback": fallback,
                "systemNote": _system_note_for_drive_link(
                    candidate, fallback, drive_export_plan
                ),
            }
        )

    traversal_summary = _traversal_limit_summary(traversal)
    status = "ready"
    if traversal_summary or counts["fallbacks"] > 0:
        status = "partial"
    if (
        not traversal_summary
        and counts["candidates"] > 0
        and counts["blocked"] == counts["candidates"]
    ):
        status = "blocked"
    plural = "" if counts["fallbacks"] == 1 else "s"
    return {
        "kind": "chat.drive_link_retrieval_plan",
        "status": status,
        "summary": f"{counts['candidates']} Drive link candidates, {counts['driveExports']} ready exports, {counts['fallbacks']} fallback or blocked path{plural}.",
        "counts": counts,
        "links": links,
        "ignoredLinks": ignored_links,
        **({"traversal": traversal_summary} if traversal_summary else {}),
        "systemNotes": [
            *[item["systemNote"] for item in links],
            *(
                [_traversal_limit_system_note(traversal_summary)]
                if traversal_summary
                else []
            ),
        ],
    }


def create_upload_plan(
    input_upload: Mapping[str, Any],
    *,
    enable_live_media: bool | None = None,
    w7_complete: bool | None = None,
    env: Mapping[str, str | None] | None = None,
    policy: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    safe_filename = sanitize_filename(_as_string(input_upload.get("filename")))
    limits = _policy_limits(policy)
    size_bytes = input_upload.get("sizeBytes")
    content_type = _as_string(input_upload.get("contentType"))
    policy_result = evaluate_attachment_policy(
        {
            "contentType": content_type,
            "contentSizeBytes": size_bytes,
            "safeFilename": safe_filename,
        },
        policy,
    )
    reasons = list(policy_result["reasons"])

    if isinstance(size_bytes, int) and size_bytes > limits["maxUploadBytes"]:
        reasons.append("size_exceeds_upload_limit")

    status = "blocked" if reasons else "dry_run"
    gate = _live_media_gate(
        enable_live_media=enable_live_media,
        w7_complete=w7_complete,
        env=env,
    )
    plan = {
        "kind": "upload",
        "status": status,
        "dryRun": True,
        "canExecuteLive": gate["allowed"] and status != "blocked",
        "liveGate": gate,
        "parent": input_upload.get("parent"),
        "safeFilename": safe_filename,
        "contentType": content_type,
        "sizeBytes": size_bytes,
        "method": "POST",
        "url": f"https://chat.googleapis.com/upload/v1/{input_upload.get('parent')}/attachments:upload?uploadType=multipart",
        "uploadProtocol": "simple",
        "maxBytes": limits["maxUploadBytes"],
        "policy": {
            "status": "blocked" if reasons else "allowed",
            "reasons": reasons,
        },
        "auth": {
            "required": True,
            "mode": "user",
            "scopes": [
                "https://www.googleapis.com/auth/chat.messages.create",
                "https://www.googleapis.com/auth/chat.messages",
                "https://www.googleapis.com/auth/chat.import",
            ],
        },
    }

    if reasons:
        plan["blockedReasons"] = reasons

    return plan


def _parser_kind_for(attachment: Mapping[str, Any]) -> str | None:
    media_kind = attachment.get("mediaKind")
    return media_kind if media_kind in {"text", "json", "pdf", "image", "audio"} else None


def _with_extraction(
    attachment: Mapping[str, Any], result: Mapping[str, Any]
) -> dict[str, Any]:
    processing = {
        **dict(attachment["processing"]),
        "extraction": {
            "status": result.get("status"),
            "parser": result.get("parser"),
            "text": result.get("text"),
            "reason": result.get("reason"),
        },
    }
    return {**dict(attachment), "processing": processing}


def parse_attachment_content(
    attachment: Mapping[str, Any],
    data: Any,
    *,
    parsers: Mapping[str, Parser] | None = None,
) -> dict[str, Any]:
    if (_as_mapping(attachment.get("policy")) or {}).get("status") == "blocked":
        return dict(attachment)

    parser_kind = _parser_kind_for(attachment)
    parser = parsers.get(parser_kind) if parsers and parser_kind else None

    if not parser:
        return _with_extraction(
            attachment,
            {
                "status": "skipped",
                "parser": None,
                "text": None,
                "reason": (
                    f"No {parser_kind} parser registered."
                    if parser_kind
                    else "No parser registered for this attachment type."
                ),
            },
        )

    return _with_extraction(attachment, parser(dict(attachment), data))


def _filename_phrase(attachment: Mapping[str, Any]) -> str:
    content_name = attachment.get("contentName")
    safe_filename = attachment.get("safeFilename")
    if content_name and content_name != safe_filename:
        return f"{content_name} as {safe_filename}"
    return str(safe_filename)


def render_attachment_context_parts(
    attachment: Mapping[str, Any]
) -> list[dict[str, Any]]:
    size = (
        "size unknown"
        if attachment.get("contentSizeBytes") is None
        else f"{attachment.get('contentSizeBytes')} bytes"
    )
    content_type = attachment.get("contentType") or "unknown content type"
    source = attachment.get("source") or "unknown source"
    context = _as_mapping(attachment.get("context")) or {}
    relationship = context.get("relationship")
    processing = _as_mapping(attachment.get("processing")) or {}
    extraction = _as_mapping(processing.get("extraction")) or {}
    transcription = _as_mapping(processing.get("transcription")) or {}
    parts = [
        {
            "type": "system_note",
            "text": (
                f"System Note: The user attached {_filename_phrase(attachment)} "
                f"({content_type}, {size}) from {source} in {relationship}. "
                f"Extraction status: {extraction.get('status')}. "
                f"Transcription status: {transcription.get('status')}."
            ),
        }
    ]

    if extraction.get("text") is not None:
        parts.append(
            {
                "type": "attachment_content",
                "status": extraction.get("status"),
                "text": extraction.get("text"),
                "note": extraction.get("reason"),
            }
        )
        return parts

    if transcription.get("text") is not None:
        parts.append(
            {
                "type": "attachment_content",
                "status": transcription.get("status"),
                "text": transcription.get("text"),
                "note": transcription.get("reason"),
            }
        )
        return parts

    selected = transcription if transcription.get("status") != "skipped" else extraction
    parts.append(
        {
            "type": "attachment_content",
            "status": selected.get("status"),
            "text": None,
            "note": selected.get("reason"),
        }
    )
    return parts


def _create_provider(
    provider: str,
    missing_message: str,
    default_model: str,
    *,
    api_key: str | None = None,
    client: Callable[..., dict[str, Any]] | None = None,
    http_request: Callable[..., dict[str, Any]] | None = None,
    endpoint: str | None = None,
    max_bytes: int = DEFAULT_TRANSCRIPTION_MAX_BYTES,
    model: str | None = None,
) -> dict[str, Any]:
    if not api_key and not client:
        raise ValueError(missing_message)

    selected_model = model or default_model

    def transcribe(*, attachment: dict[str, Any], data: Any) -> dict[str, Any]:
        if client is None:
            if provider == "openai":
                return _openai_transcription_request(
                    attachment=attachment,
                    data=data,
                    model=selected_model,
                    api_key=api_key,
                    endpoint=endpoint,
                    http_request=http_request,
                )
            if provider == "gemini":
                return _gemini_transcription_request(
                    attachment=attachment,
                    data=data,
                    model=selected_model,
                    api_key=api_key,
                    endpoint=endpoint,
                    http_request=http_request,
                )
            return {
                "status": "blocked",
                "text": None,
                "reason": f"{provider} transcription client is not installed in the base package.",
            }
        return client(
            attachment=attachment,
            data=data,
            model=selected_model,
            apiKey=api_key,
        )

    return {
        "provider": provider,
        "model": selected_model,
        "maxBytes": max_bytes,
        "transcribe": transcribe,
    }


def _resolve_keyword_alias(
    primary_name: str,
    primary_value: Any,
    alias_name: str,
    alias_value: Any,
    fallback: Any = None,
) -> Any:
    if primary_value is not None and alias_value is not None and primary_value != alias_value:
        raise ValueError(f"{primary_name} and {alias_name} disagree; pass only one value.")

    if alias_value is not None:
        return alias_value
    if primary_value is not None:
        return primary_value
    return fallback


def _openai_transcription_request(
    *,
    attachment: dict[str, Any],
    data: Any,
    model: str,
    api_key: str | None,
    endpoint: str | None,
    http_request: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if not api_key:
        return {
            "status": "blocked",
            "text": None,
            "reason": "OpenAI transcription requires an explicit apiKey.",
        }
    data_bytes = _data_bytes(data)
    if data_bytes is None:
        return {
            "status": "blocked",
            "text": None,
            "reason": "OpenAI transcription requires audio bytes.",
        }
    url = endpoint or "https://api.openai.com/v1/audio/transcriptions"
    headers = {"authorization": f"Bearer {api_key}"}
    fields = {"model": model}
    if http_request is not None:
        response = http_request(
            url=url,
            headers=headers,
            fields=fields,
            files={
                "file": {
                    "filename": attachment.get("safeFilename") or "audio.wav",
                    "contentType": attachment.get("contentType")
                    or "application/octet-stream",
                    "bytes": data_bytes,
                }
            },
        )
    else:
        boundary = "googlechatai-sdk-boundary"
        body = _multipart_body(
            boundary=boundary,
            fields=fields,
            filename=str(attachment.get("safeFilename") or "audio.wav"),
            content_type=str(attachment.get("contentType") or "application/octet-stream"),
            data=data_bytes,
        )
        req = urllib_request.Request(
            url,
            data=body,
            method="POST",
            headers={
                **headers,
                "content-type": f"multipart/form-data; boundary={boundary}",
            },
        )
        with urllib_request.urlopen(req, timeout=60) as raw_response:
            response = {
                "ok": 200 <= raw_response.status < 300,
                "status": raw_response.status,
                "json": json.loads(raw_response.read().decode("utf-8")),
            }
    if not response.get("ok"):
        return {
            "status": "failed",
            "text": None,
            "reason": f"OpenAI transcription failed with HTTP {response.get('status')}.",
        }
    response_json = response.get("json") or {}
    return {"status": "complete", "text": response_json.get("text"), "reason": None}


def _gemini_transcription_request(
    *,
    attachment: dict[str, Any],
    data: Any,
    model: str,
    api_key: str | None,
    endpoint: str | None,
    http_request: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if not api_key:
        return {
            "status": "blocked",
            "text": None,
            "reason": "Gemini transcription requires an explicit apiKey.",
        }
    data_bytes = _data_bytes(data)
    if data_bytes is None:
        return {
            "status": "blocked",
            "text": None,
            "reason": "Gemini transcription requires audio bytes.",
        }
    url = endpoint or GEMINI_INTERACTIONS_ENDPOINT
    headers = {"x-goog-api-key": api_key, "content-type": "application/json"}
    body = {
        "model": model,
        "input": [
            {"type": "text", "text": GEMINI_TRANSCRIPTION_PROMPT},
            {
                "type": "audio",
                "data": base64.b64encode(data_bytes).decode("utf-8"),
                "mime_type": attachment.get("contentType") or "application/octet-stream",
            },
        ],
    }
    if http_request is not None:
        response = http_request(url=url, headers=headers, json=body)
    else:
        req = urllib_request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers=headers,
        )
        with urllib_request.urlopen(req, timeout=60) as raw_response:
            response = {
                "ok": 200 <= raw_response.status < 300,
                "status": raw_response.status,
                "json": json.loads(raw_response.read().decode("utf-8")),
            }
    response_json = response.get("json") or {}
    if not response.get("ok"):
        error = _as_mapping(response_json.get("error")) or {}
        return {
            "status": "failed",
            "text": None,
            "reason": error.get("message")
            or f"Gemini transcription failed with HTTP {response.get('status')}.",
        }
    text = (
        response_json.get("output_text")
        or response_json.get("outputText")
        or response_json.get("text")
    )
    if not isinstance(text, str):
        for step in _as_list(response_json.get("steps")):
            step_mapping = _as_mapping(step) or {}
            for part in _as_list(step_mapping.get("content")):
                part_mapping = _as_mapping(part) or {}
                part_text = part_mapping.get("text")
                if isinstance(part_text, str):
                    text = part_text
                    break
            if isinstance(text, str):
                break
    if not isinstance(text, str):
        return {
            "status": "failed",
            "text": None,
            "reason": "Gemini transcription response did not include output_text.",
        }
    return {"status": "complete", "text": text, "reason": None}


def _multipart_body(
    *,
    boundary: str,
    fields: Mapping[str, str],
    filename: str,
    content_type: str,
    data: bytes,
) -> bytes:
    parts: list[bytes] = []
    for key, value in fields.items():
        parts.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{key}"\r\n\r\n'
                f"{value}\r\n"
            ).encode("utf-8")
        )
    parts.append(
        (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="file"; '
            f'filename="{filename}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode("utf-8")
    )
    parts.append(data)
    parts.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts)


def create_openai_transcription_provider(
    *,
    apiKey: str | None = None,
    api_key: str | None = None,
    client: Callable[..., dict[str, Any]] | None = None,
    http_request: Callable[..., dict[str, Any]] | None = None,
    endpoint: str | None = None,
    maxBytes: int | None = None,
    max_bytes: int | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    resolved_api_key = _resolve_keyword_alias(
        "apiKey",
        apiKey,
        "api_key",
        api_key,
    )
    resolved_max_bytes = _resolve_keyword_alias(
        "maxBytes",
        maxBytes,
        "max_bytes",
        max_bytes,
        DEFAULT_TRANSCRIPTION_MAX_BYTES,
    )
    return _create_provider(
        "openai",
        "OpenAI transcription requires an explicit apiKey or client.",
        DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
        api_key=resolved_api_key,
        client=client,
        http_request=http_request,
        endpoint=endpoint,
        max_bytes=resolved_max_bytes,
        model=model,
    )


def create_gemini_transcription_provider(
    *,
    apiKey: str | None = None,
    api_key: str | None = None,
    client: Callable[..., dict[str, Any]] | None = None,
    http_request: Callable[..., dict[str, Any]] | None = None,
    endpoint: str | None = None,
    maxBytes: int | None = None,
    max_bytes: int | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    resolved_api_key = _resolve_keyword_alias(
        "apiKey",
        apiKey,
        "api_key",
        api_key,
    )
    resolved_max_bytes = _resolve_keyword_alias(
        "maxBytes",
        maxBytes,
        "max_bytes",
        max_bytes,
        DEFAULT_TRANSCRIPTION_MAX_BYTES,
    )
    return _create_provider(
        "gemini",
        "Gemini transcription requires an explicit apiKey or client.",
        DEFAULT_GEMINI_TRANSCRIPTION_MODEL,
        api_key=resolved_api_key,
        client=client,
        http_request=http_request,
        endpoint=endpoint,
        max_bytes=resolved_max_bytes,
        model=model,
    )


def transcribe_audio(
    attachment: Mapping[str, Any],
    data: Any,
    *,
    enabled: bool = False,
    provider: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    if attachment.get("mediaKind") != "audio":
        return dict(attachment)

    if not enabled:
        return dict(attachment)

    if provider is None:
        return {
            **dict(attachment),
            "processing": {
                **dict(attachment["processing"]),
                "transcription": {
                    "status": "blocked",
                    "provider": None,
                    "text": None,
                    "reason": "A transcription provider must be selected explicitly.",
                },
            },
        }

    data_bytes = _data_bytes(data)
    max_bytes = provider.get("maxBytes") or DEFAULT_TRANSCRIPTION_MAX_BYTES
    byte_length = len(data_bytes) if data_bytes is not None else attachment.get("contentSizeBytes")
    if isinstance(byte_length, int) and byte_length > max_bytes:
        return {
            **dict(attachment),
            "processing": {
                **dict(attachment["processing"]),
                "transcription": {
                    "status": "blocked",
                    "provider": provider.get("provider"),
                    "text": None,
                    "reason": f"Audio is {byte_length} bytes, exceeding the configured transcription limit of {max_bytes} bytes.",
                },
            },
        }

    result = provider["transcribe"](attachment=dict(attachment), data=data)
    return {
        **dict(attachment),
        "processing": {
            **dict(attachment["processing"]),
            "transcription": {
                "status": result.get("status"),
                "provider": provider.get("provider"),
                "text": result.get("text"),
                "reason": result.get("reason"),
            },
        },
    }


def _sha256_hex(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def summarize_transcription_evidence(
    *,
    attachment: Mapping[str, Any],
    data: Any,
    result: Mapping[str, Any],
    include_transcript_text: bool = False,
) -> dict[str, Any]:
    data_bytes = _data_bytes(data) or b""
    text = str(result.get("text") or "")
    provider = result.get("provider")
    return {
        "provider": provider,
        "model": (
            DEFAULT_OPENAI_TRANSCRIPTION_MODEL
            if provider == "openai"
            else DEFAULT_GEMINI_TRANSCRIPTION_MODEL
            if provider == "gemini"
            else provider
        ),
        "status": result.get("status"),
        "audioSha256": _sha256_hex(data_bytes),
        "audioSizeBytes": len(data_bytes),
        "transcriptLength": len(text),
        "transcriptSha256": _sha256_hex(text) if text else None,
        "transcriptText": text if include_transcript_text else None,
        "redacted": not include_transcript_text,
    }


def _collect_pipeline_attachments(
    input_data: Mapping[str, Any],
    options: Mapping[str, Any],
) -> list[dict[str, Any]]:
    attachments: list[dict[str, Any]] = []
    policy = _as_mapping(options.get("policy"))

    if "attachments" in input_data:
        attachments.extend(normalize_attachments(input_data.get("attachments"), policy=policy))
    if "message" in input_data:
        attachments.extend(
            normalize_attachments_from_message(input_data.get("message"), policy=policy)
        )
    if "context" in input_data:
        attachments.extend(
            collect_attachments_from_context(input_data.get("context"), policy=policy)
        )

    return attachments


def _attachment_is_drive_backed(attachment: Mapping[str, Any]) -> bool:
    return attachment.get("source") == "DRIVE_FILE" or bool(
        _as_mapping(attachment.get("driveDataRef"))
    )


def _cache_plan_for_attachment(
    attachment: Mapping[str, Any],
    options: Mapping[str, Any],
) -> dict[str, Any]:
    lookup_key = str(attachment.get("name"))
    cache = _as_mapping(options.get("cache"))
    if cache is None:
        return {
            "status": "disabled",
            "lookupKey": lookup_key,
            "key": None,
            "negative": False,
            "metadata": {},
        }

    entries = _as_mapping(cache.get("entriesByAttachmentName")) or {}
    entry = _as_mapping(entries.get(lookup_key))
    if not entry or entry.get("hit") is not True:
        return {
            "status": "miss",
            "lookupKey": lookup_key,
            "key": None,
            "negative": False,
            "metadata": {},
        }

    negative = entry.get("negative") is True
    result = {
        "status": "negative_hit" if negative else "hit",
        "lookupKey": lookup_key,
        "key": entry.get("key"),
        "negative": negative,
        "metadata": dict(_as_mapping(entry.get("metadata")) or {}),
    }
    if entry.get("reason"):
        result["reason"] = entry.get("reason")
    if entry.get("createdAt"):
        result["createdAt"] = entry.get("createdAt")
    if entry.get("expiresAt"):
        result["expiresAt"] = entry.get("expiresAt")
    return result


def _parser_name_for(media_kind: str, options: Mapping[str, Any]) -> str | None:
    parsers = _as_mapping(options.get("parsers")) or {}
    descriptor = parsers.get(media_kind)
    if isinstance(descriptor, str) and descriptor.strip():
        return descriptor
    if isinstance(descriptor, Mapping):
        name = descriptor.get("name")
        return name if isinstance(name, str) and name.strip() else None
    if descriptor is True:
        return media_kind
    return None


def _plan_parser_for_attachment(
    attachment: Mapping[str, Any],
    options: Mapping[str, Any],
) -> dict[str, Any]:
    policy = _as_mapping(attachment.get("policy")) or {}
    media_kind = str(attachment.get("mediaKind") or "unknown")
    if policy.get("status") == "blocked":
        return {
            "status": "blocked",
            "mediaKind": media_kind,
            "parser": None,
            "reason": "Attachment is blocked by policy.",
        }

    parser_kind = _parser_kind_for(attachment)
    parser = _parser_name_for(parser_kind, options) if parser_kind else None
    if parser:
        return {
            "status": "ready",
            "mediaKind": media_kind,
            "parser": parser,
            "reason": None,
        }

    return {
        "status": "skipped",
        "mediaKind": media_kind,
        "parser": None,
        "reason": (
            f"No {parser_kind} parser registered."
            if parser_kind
            else "No parser registered for this attachment type."
        ),
    }


def _plan_transcription_for_attachment(
    attachment: Mapping[str, Any],
    options: Mapping[str, Any],
) -> dict[str, Any]:
    policy = _as_mapping(attachment.get("policy")) or {}
    if policy.get("status") == "blocked":
        return {
            "status": "skipped",
            "provider": None,
            "model": None,
            "reason": "Attachment is blocked by policy.",
        }

    if attachment.get("mediaKind") != "audio":
        return {
            "status": "skipped",
            "provider": None,
            "model": None,
            "reason": "Attachment is not audio.",
        }

    transcription = _as_mapping(options.get("transcription")) or {}
    if transcription.get("enabled") is not True:
        return {
            "status": "disabled",
            "provider": None,
            "model": None,
            "reason": "Audio transcription is disabled by default.",
        }

    provider = _as_string(transcription.get("provider"))
    model = _as_string(transcription.get("model"))
    if not provider:
        return {
            "status": "blocked",
            "provider": None,
            "model": model,
            "reason": "A transcription provider must be selected explicitly.",
        }

    max_bytes = transcription.get("maxBytes") or DEFAULT_TRANSCRIPTION_MAX_BYTES
    content_size = attachment.get("contentSizeBytes")
    if isinstance(content_size, int) and content_size > max_bytes:
        return {
            "status": "blocked",
            "provider": provider,
            "model": model,
            "reason": f"Audio is {content_size} bytes, exceeding the configured transcription limit of {max_bytes} bytes.",
        }

    return {
        "status": "ready",
        "provider": provider,
        "model": model,
        "reason": None,
    }


def _fallback_for_attachment(
    *,
    attachment: Mapping[str, Any],
    download_plan: Mapping[str, Any],
    drive_export_plan: Mapping[str, Any] | None,
    parse_plan: Mapping[str, Any],
    transcription_plan: Mapping[str, Any],
) -> dict[str, Any]:
    policy = _as_mapping(attachment.get("policy")) or {}
    if policy.get("status") == "blocked":
        return {
            "status": "blocked",
            "action": "metadata_only",
            "reason": "Attachment bytes are blocked by policy; render metadata only.",
        }

    if _attachment_is_drive_backed(attachment):
        return {
            "status": "fallback",
            "action": "drive_export_required",
            "reason": "Drive-backed attachments require Google Drive user auth; use the Drive export plan or render metadata only.",
        }

    if (
        attachment.get("mediaKind") == "audio"
        and transcription_plan.get("status") != "ready"
    ):
        return {
            "status": "partial",
            "action": "transcription_disabled",
            "reason": "Audio bytes can be downloaded, but transcription is disabled or unavailable.",
        }

    if parse_plan.get("status") == "skipped" and attachment.get("mediaKind") != "unknown":
        return {
            "status": "partial",
            "action": "parser_missing",
            "reason": "Attachment bytes can be downloaded, but no parser is registered.",
        }

    if download_plan.get("status") != "blocked":
        return {
            "status": "ready",
            "action": "download_chat_media",
            "reason": "Chat-hosted media can be downloaded with Chat media.download.",
        }

    if drive_export_plan and drive_export_plan.get("status") != "blocked":
        return {
            "status": "fallback",
            "action": "drive_export_required",
            "reason": "Use the Drive export plan because Chat media.download is unavailable for this attachment.",
        }

    return {
        "status": "blocked",
        "action": "metadata_only",
        "reason": "Attachment bytes are inaccessible; render metadata only.",
    }


def _send_strategy_for_upload(
    upload: Mapping[str, Any],
    upload_plan: Mapping[str, Any],
) -> dict[str, Any]:
    safe_filename = str(upload_plan.get("safeFilename") or "attachment")

    if upload_plan.get("status") == "blocked":
        return {
            "sendStrategy": {
                "kind": "drive_link_card_fallback",
                "requiresSeparateMessage": False,
                "reason": "Upload is blocked by attachment policy.",
            },
            "fallback": {
                "status": "blocked",
                "action": "drive_link_card_fallback",
                "reason": "Upload is blocked; use a Drive link/card fallback or text-only summary.",
            },
            "systemNote": f"System Note: Upload {safe_filename} is blocked by policy; use a Drive link/card fallback or text-only summary.",
        }

    send_options = _as_mapping(upload.get("sendOptions")) or {}
    if send_options.get("hasAccessoryWidgets") is True:
        return {
            "sendStrategy": {
                "kind": "separate_attachment_message",
                "requiresSeparateMessage": True,
                "reason": "Google Chat attachment messages cannot include accessory widgets.",
            },
            "fallback": {
                "status": "fallback",
                "action": "separate_attachment_message",
                "reason": "Send accessory widgets and the attachment as separate messages.",
            },
            "systemNote": f"System Note: Upload {safe_filename} requires a separate attachment message because Google Chat attachment messages cannot include accessory widgets.",
        }

    return {
        "sendStrategy": {
            "kind": "attachment_message",
            "requiresSeparateMessage": False,
            "reason": "Upload can be attached to the Chat message.",
        },
        "fallback": {
            "status": "ready",
            "action": "upload_attachment_message",
            "reason": "Upload can be attached to the Chat message.",
        },
        "systemNote": f"System Note: Upload {safe_filename} can be attached to the Chat message after media.upload succeeds.",
    }


def _plan_pipeline_upload(
    upload: Mapping[str, Any],
    options: Mapping[str, Any],
) -> dict[str, Any]:
    upload_plan = create_upload_plan(
        upload,
        enable_live_media=options.get("enableLiveMedia"),
        w7_complete=options.get("w7Complete"),
        env=_as_mapping(options.get("env")),
        policy=_as_mapping(options.get("policy")),
    )
    strategy = _send_strategy_for_upload(upload, upload_plan)
    return {
        "item": {
            "uploadPlan": upload_plan,
            "sendStrategy": strategy["sendStrategy"],
            "fallback": strategy["fallback"],
        },
        "systemNote": strategy["systemNote"],
    }


def plan_attachment_pipeline(input_data: Mapping[str, Any]) -> dict[str, Any]:
    """Plan attachment upload/download/parse/cache/AI-context work without live I/O."""

    options = _as_mapping(input_data.get("options")) or {}
    attachments = _collect_pipeline_attachments(input_data, options)
    planned_attachments: list[dict[str, Any]] = []

    for attachment in attachments:
        download_plan = create_download_plan(
            attachment,
            target_directory=str(options.get("targetDirectory") or "."),
            enable_live_media=options.get("enableLiveMedia"),
            w7_complete=options.get("w7Complete"),
            env=_as_mapping(options.get("env")),
        )
        drive_export_plan = (
            create_drive_export_plan(
                attachment,
                target_directory=str(
                    options.get("driveExportDirectory")
                    or options.get("targetDirectory")
                    or "."
                ),
                enable_live_drive=options.get("enableLiveDrive"),
                env=_as_mapping(options.get("env")),
            )
            if _attachment_is_drive_backed(attachment)
            else None
        )
        parse_plan = _plan_parser_for_attachment(attachment, options)
        transcription_plan = _plan_transcription_for_attachment(attachment, options)
        fallback = _fallback_for_attachment(
            attachment=attachment,
            download_plan=download_plan,
            drive_export_plan=drive_export_plan,
            parse_plan=parse_plan,
            transcription_plan=transcription_plan,
        )
        planned_attachments.append(
            {
                "attachment": attachment,
                "cache": _cache_plan_for_attachment(attachment, options),
                "downloadPlan": download_plan,
                "driveExportPlan": drive_export_plan,
                "parsePlan": parse_plan,
                "transcriptionPlan": transcription_plan,
                "fallback": fallback,
                "contextParts": render_attachment_context_parts(attachment),
            }
        )

    planned_uploads = [
        _plan_pipeline_upload(upload, options)
        for upload in _as_list(input_data.get("uploads"))
        if isinstance(upload, Mapping)
    ]
    upload_items = [item["item"] for item in planned_uploads]
    system_notes = [
        part.get("text")
        for item in planned_attachments
        for part in item["contextParts"]
        if part.get("type") == "system_note" and isinstance(part.get("text"), str)
    ] + [item["systemNote"] for item in planned_uploads]

    counts = {
        "attachments": len(planned_attachments),
        "uploads": len(upload_items),
        "downloads": sum(
            1 for item in planned_attachments if item["downloadPlan"].get("status") != "blocked"
        ),
        "driveExports": sum(
            1
            for item in planned_attachments
            if item["driveExportPlan"]
            and item["driveExportPlan"].get("status") != "blocked"
        ),
        "blocked": sum(
            1 for item in planned_attachments if item["fallback"].get("status") == "blocked"
        )
        + sum(1 for item in upload_items if item["fallback"].get("status") == "blocked"),
        "cacheHits": sum(
            1
            for item in planned_attachments
            if item["cache"].get("status") in {"hit", "negative_hit"}
        ),
        "parserReady": sum(
            1 for item in planned_attachments if item["parsePlan"].get("status") == "ready"
        ),
        "transcriptionReady": sum(
            1
            for item in planned_attachments
            if item["transcriptionPlan"].get("status") == "ready"
        ),
        "fallbacks": sum(
            1 for item in planned_attachments if item["fallback"].get("status") != "ready"
        )
        + sum(1 for item in upload_items if item["fallback"].get("status") != "ready"),
    }
    total_items = counts["attachments"] + counts["uploads"]
    status = (
        "blocked"
        if total_items > 0 and counts["blocked"] == total_items
        else "partial"
        if counts["fallbacks"] > 0
        else "ready"
    )
    ready_operations = counts["downloads"] + counts["driveExports"]

    return {
        "kind": "chat.attachment_pipeline_plan",
        "status": status,
        "summary": f"{counts['attachments']} attachments, {counts['uploads']} uploads, {ready_operations} ready operations, {counts['fallbacks']} fallback or blocked paths.",
        "counts": counts,
        "attachments": planned_attachments,
        "uploads": upload_items,
        "systemNotes": system_notes,
    }


__all__ = [
    "CHAT_MEDIA_UPLOAD_MAX_BYTES",
    "DEFAULT_ATTACHMENT_DOWNLOAD_MAX_BYTES",
    "DEFAULT_DRIVE_EXPORT_MAX_BYTES",
    "DEFAULT_TRANSCRIPTION_MAX_BYTES",
    "DRIVE_READONLY_SCOPE",
    "classify_media_kind",
    "collect_attachments_from_context",
    "collect_drive_link_candidates",
    "create_drive_export_plan",
    "create_drive_link_retrieval_plan",
    "create_download_plan",
    "create_gemini_transcription_provider",
    "create_openai_transcription_provider",
    "create_upload_plan",
    "default_drive_export_mime_type",
    "evaluate_attachment_policy",
    "normalize_attachment",
    "normalize_attachments",
    "normalize_attachments_from_message",
    "plan_attachment_pipeline",
    "parse_attachment_content",
    "render_attachment_context_parts",
    "sanitize_filename",
    "summarize_transcription_evidence",
    "transcribe_audio",
]
