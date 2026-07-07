"""Message AST helpers for Google Chat Message payloads."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


RawMapping = Mapping[str, Any]


def _as_mapping(value: Any) -> RawMapping | None:
    return value if isinstance(value, Mapping) else None


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _as_bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _as_number(value: Any) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _normalize_identity(value: Any) -> dict[str, Any] | None:
    raw = _as_mapping(value)

    if not raw:
        return None

    resource_name = _as_string(raw.get("name"))
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


def _normalize_space(value: Any) -> dict[str, Any] | None:
    raw = _as_mapping(value)
    name = _as_string(raw.get("name")) if raw else None

    if not raw or not name:
        return None

    return {
        "name": name,
        "displayName": _as_string(raw.get("displayName")),
        "type": _as_string(raw.get("type")),
    }


def _normalize_thread(value: Any) -> dict[str, str] | None:
    raw = _as_mapping(value)
    name = _as_string(raw.get("name")) if raw else None
    return {"name": name} if name else None


def _identity_label(identity: dict[str, Any] | None) -> str:
    if identity is None:
        return "Unknown sender (unknown access)"

    label = (
        identity["displayName"]
        or identity["email"]
        or identity["resourceName"]
        or "Unknown sender"
    )
    if identity["email"] and identity["email"] != label:
        with_email = f"{label} <{identity['email']}>"
    else:
        with_email = label

    details = [part for part in [identity["type"], identity["resourceName"]] if part is not None]
    if not details:
        return f"{with_email} ({identity['accessState']})"

    return f"{with_email} ({', '.join(details)})"


def _valid_range(text: str, start_index: Any, length: Any) -> bool:
    return (
        isinstance(start_index, (int, float))
        and not isinstance(start_index, bool)
        and isinstance(length, (int, float))
        and not isinstance(length, bool)
        and start_index >= 0
        and length >= 0
        and start_index + length <= len(text)
    )


def _command_label(command: RawMapping | None) -> str | None:
    if not command:
        return None

    return _as_string(command.get("commandName")) or _as_string(command.get("commandId"))


def _normalize_slash_command(raw: RawMapping | None) -> dict[str, Any] | None:
    if not raw:
        return None

    return {
        "commandName": _as_string(raw.get("commandName")),
        "commandId": _as_string(raw.get("commandId")),
        "type": _as_string(raw.get("type")),
        "triggersDialog": _as_bool(raw.get("triggersDialog")),
        "bot": _normalize_identity(raw.get("bot")),
    }


def _normalize_custom_emoji(raw: RawMapping | None) -> dict[str, Any] | None:
    if not raw:
        return None

    return {
        "name": _as_string(raw.get("name")),
        "emojiName": _as_string(raw.get("emojiName")),
        "temporaryImageUri": _as_string(raw.get("temporaryImageUri")),
    }


def _normalize_chat_space_link_data(raw: RawMapping | None) -> dict[str, Any] | None:
    if not raw:
        return None

    data: dict[str, Any] = {}
    for key in ["space", "thread", "message", "spaceDisplayName"]:
        value = _as_string(raw.get(key))
        if value:
            data[key] = value
    return data or None


def _rich_link_title(metadata: RawMapping) -> str | None:
    drive_data = _as_mapping(metadata.get("driveLinkData")) or {}
    chat_space_data = _as_mapping(metadata.get("chatSpaceLinkData")) or {}
    return (
        _as_string(metadata.get("title"))
        or _as_string(drive_data.get("title"))
        or _as_string(chat_space_data.get("spaceDisplayName"))
    )


def _normalize_annotations(text: str, annotations: Any) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []

    for item in _as_list(annotations):
        raw = _as_mapping(item)
        raw_type = _as_string(raw.get("type")) if raw else None

        if not raw or not raw_type:
            continue

        start_index = _as_number(raw.get("startIndex"))
        length = _as_number(raw.get("length"))
        source_text = (
            text[int(start_index) : int(start_index + length)]
            if _valid_range(text, start_index, length)
            else ""
        )

        if raw_type == "USER_MENTION":
            metadata = _as_mapping(raw.get("userMention")) or {}
            user = _normalize_identity(metadata.get("user"))
            user_label = (
                (user or {}).get("displayName")
                or (user or {}).get("email")
                or (user or {}).get("resourceName")
                or source_text
            )
            normalized.append(
                {
                    "kind": "userMention",
                    "startIndex": start_index,
                    "length": length,
                    "text": source_text,
                    "renderText": f"@{user_label}",
                    "user": user,
                    "mentionType": _as_string(metadata.get("type")),
                }
            )
            continue

        if raw_type == "SLASH_COMMAND":
            slash_command = _normalize_slash_command(_as_mapping(raw.get("slashCommand")))
            normalized.append(
                {
                    "kind": "slashCommand",
                    "startIndex": start_index,
                    "length": length,
                    "text": source_text,
                    "renderText": _command_label(slash_command) or source_text,
                    "slashCommand": slash_command,
                }
            )
            continue

        if raw_type == "CUSTOM_EMOJI":
            metadata = _as_mapping(raw.get("customEmojiMetadata")) or {}
            custom_emoji = _normalize_custom_emoji(_as_mapping(metadata.get("customEmoji")))
            normalized.append(
                {
                    "kind": "customEmoji",
                    "startIndex": start_index,
                    "length": length,
                    "text": source_text,
                    "renderText": (custom_emoji or {}).get("emojiName") or source_text,
                    "emoji": custom_emoji,
                }
            )
            continue

        if raw_type == "RICH_LINK":
            metadata = _as_mapping(raw.get("richLinkMetadata")) or {}
            annotation = {
                "kind": "richLink",
                "startIndex": start_index,
                "length": length,
                "text": source_text,
                "renderText": source_text,
                "url": _as_string(metadata.get("uri")),
                "richLinkType": _as_string(metadata.get("richLinkType")),
                "mimeType": _as_string(metadata.get("mimeType")),
                "title": _rich_link_title(metadata),
            }
            chat_space_link_data = _normalize_chat_space_link_data(
                _as_mapping(metadata.get("chatSpaceLinkData"))
            )
            if chat_space_link_data:
                annotation["chatSpaceLinkData"] = chat_space_link_data
            normalized.append(annotation)
            continue

        normalized.append(
            {
                "kind": "unknown",
                "rawType": raw_type,
                "startIndex": start_index,
                "length": length,
                "text": source_text,
                "renderText": source_text,
            }
        )

    return normalized


def _sort_annotations(annotations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        annotations,
        key=lambda item: (
            item["startIndex"] if item["startIndex"] is not None else 9_007_199_254_740_991,
            item["length"] if item["length"] is not None else 0,
        ),
    )


def _build_segments(text: str, annotations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    cursor = 0

    for annotation_index, annotation in enumerate(_sort_annotations(annotations)):
        start_index = annotation["startIndex"]
        length = annotation["length"]

        if not _valid_range(text, start_index, length) or start_index < cursor:
            continue

        start_int = int(start_index)
        length_int = int(length)

        if start_int > cursor:
            segments.append(
                {
                    "kind": "text",
                    "startIndex": cursor,
                    "length": start_int - cursor,
                    "text": text[cursor:start_int],
                }
            )

        segments.append(
            {
                "kind": annotation["kind"],
                "startIndex": start_index,
                "length": length,
                "text": annotation.get("renderText") or annotation.get("text") or "",
                "sourceText": annotation.get("text") or "",
                "annotationIndex": annotation_index,
            }
        )
        cursor = start_int + length_int

    if cursor < len(text):
        segments.append(
            {
                "kind": "text",
                "startIndex": cursor,
                "length": len(text) - cursor,
                "text": text[cursor:],
            }
        )

    return segments


def _render_segments(text: str, segments: list[dict[str, Any]]) -> str:
    if not segments:
        return text

    return "".join(segment.get("text") or "" for segment in segments)


def _normalize_links(
    raw: RawMapping, text: str, annotations: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    links: list[dict[str, Any]] = []
    matched_url = _as_mapping(raw.get("matchedUrl"))
    matched_url_value = _as_string(matched_url.get("url")) if matched_url else None

    if matched_url_value:
        start_index = text.find(matched_url_value)
        links.append(
            {
                "kind": "matchedUrl",
                "url": matched_url_value,
                "startIndex": start_index if start_index >= 0 else None,
                "length": len(matched_url_value),
                "text": matched_url_value,
            }
        )

    for annotation in annotations:
        if annotation["kind"] != "richLink":
            continue

        link = {
            "kind": "richLink",
            "url": annotation.get("url"),
            "startIndex": annotation.get("startIndex"),
            "length": annotation.get("length"),
            "text": annotation.get("text"),
            "richLinkType": annotation.get("richLinkType"),
            "mimeType": annotation.get("mimeType"),
            "title": annotation.get("title"),
        }
        chat_space_link_data = _as_mapping(annotation.get("chatSpaceLinkData"))
        if chat_space_link_data:
            link["chatSpaceLinkData"] = dict(chat_space_link_data)
        links.append(link)

    return sorted(
        links,
        key=lambda item: item["startIndex"]
        if item["startIndex"] is not None
        else 9_007_199_254_740_991,
    )


def _normalize_attachments(value: Any) -> list[dict[str, Any]]:
    attachments: list[dict[str, Any]] = []

    for item in _as_list(value):
        raw = _as_mapping(item)
        name = _as_string(raw.get("name")) if raw else None

        if not raw or not name:
            continue

        attachment_data_ref = _as_mapping(raw.get("attachmentDataRef")) or {}
        drive_data_ref = _as_mapping(raw.get("driveDataRef")) or {}
        attachment = {
            "name": name,
            "contentName": _as_string(raw.get("contentName")),
            "contentType": _as_string(raw.get("contentType")),
            "source": _as_string(raw.get("source")),
            "mediaResourceName": _as_string(attachment_data_ref.get("resourceName")),
            "thumbnailUri": _as_string(raw.get("thumbnailUri")),
        }
        if drive_data_ref:
            attachment["driveDataRef"] = {
                **drive_data_ref,
                "driveFileId": _as_string(drive_data_ref.get("driveFileId")),
            }
        attachments.append(attachment)

    return attachments


def _normalize_attached_gifs(value: Any) -> list[dict[str, Any]]:
    gifs: list[dict[str, Any]] = []

    for item in _as_list(value):
        raw = _as_mapping(item)
        uri = _as_string(raw.get("uri")) if raw else None
        if uri:
            gifs.append({"uri": uri})

    return gifs


def _normalize_cards(value: Any) -> list[dict[str, Any]]:
    cards: list[dict[str, Any]] = []

    for item in _as_list(value):
        raw = _as_mapping(item)
        if not raw:
            continue

        card = _as_mapping(raw.get("card")) or {}
        header = _as_mapping(card.get("header")) or {}
        cards.append(
            {
                "cardId": _as_string(raw.get("cardId")),
                "title": _as_string(header.get("title")),
            }
        )

    return cards


def _normalize_emoji(value: Any) -> dict[str, Any]:
    raw = _as_mapping(value) or {}
    custom_emoji = _normalize_custom_emoji(_as_mapping(raw.get("customEmoji")))
    unicode_value = _as_string(raw.get("unicode"))
    label = (
        unicode_value
        or (custom_emoji or {}).get("emojiName")
        or (custom_emoji or {}).get("name")
        or "unknown emoji"
    )

    return {
        "type": "unicode" if unicode_value else "custom" if custom_emoji else None,
        "label": label,
        "unicode": unicode_value,
        "customEmoji": custom_emoji,
    }


def _normalize_reactions(value: Any) -> list[dict[str, Any]]:
    reactions: list[dict[str, Any]] = []

    for item in _as_list(value):
        raw = _as_mapping(item)
        if not raw:
            continue

        reactions.append(
            {
                "emoji": _normalize_emoji(raw.get("emoji")),
                "reactionCount": _as_number(raw.get("reactionCount")) or 0,
            }
        )

    return reactions


def _top_level_slash_command(
    raw: RawMapping, annotations: list[dict[str, Any]]
) -> dict[str, Any] | None:
    top_level = _as_mapping(raw.get("slashCommand"))
    annotation = next((item for item in annotations if item["kind"] == "slashCommand"), None)
    annotation_slash_command = _as_mapping((annotation or {}).get("slashCommand"))

    if not top_level and not annotation_slash_command:
        return None

    return {
        "commandName": _as_string((annotation_slash_command or {}).get("commandName")),
        "commandId": _as_string((top_level or {}).get("commandId"))
        or _as_string((annotation_slash_command or {}).get("commandId")),
        "type": _as_string((annotation_slash_command or {}).get("type")),
        "triggersDialog": _as_bool((annotation_slash_command or {}).get("triggersDialog")),
        "bot": (annotation_slash_command or {}).get("bot"),
    }


def _normalize_custom_emojis(annotations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    custom_emojis: list[dict[str, Any]] = []

    for annotation in annotations:
        if annotation["kind"] != "customEmoji":
            continue

        custom_emojis.append(
            {
                "startIndex": annotation.get("startIndex"),
                "length": annotation.get("length"),
                "text": annotation.get("text"),
                "renderText": annotation.get("renderText"),
                "emoji": annotation.get("emoji"),
            }
        )

    return custom_emojis


def _base_message_system_notes(
    *,
    name: str,
    relationship: str,
    sender: dict[str, Any] | None,
    created_at: str | None,
    updated_at: str | None,
    deleted_at: str | None,
    deleted: bool,
    deletion_type: str | None,
    thread_reply: bool,
    thread: dict[str, str] | None,
    private_message_viewer: dict[str, Any] | None,
    direct_message: bool,
) -> list[str]:
    prefix = "Quoted message" if relationship == "quoted_message" else "Message"
    created = created_at or "unknown time"
    first = f"System Note: {prefix} {name} from {_identity_label(sender)} created at {created}"

    if updated_at and updated_at != created_at:
        first += f" and updated at {updated_at}"

    first += "."
    notes = [first]

    if deleted:
        deleted_at_text = deleted_at or "an unknown time"
        reason = f" ({deletion_type})" if deletion_type else ""
        notes.append(f"System Note: Message was deleted at {deleted_at_text}{reason}.")

    if thread_reply and thread:
        notes.append(f"System Note: This message is a thread reply in {thread['name']}.")

    if private_message_viewer:
        notes.append(
            f"System Note: This message is private to {_identity_label(private_message_viewer)}."
        )

    if direct_message:
        notes.append("System Note: This message was sent in a direct message space.")

    return notes


def _metadata_system_notes(
    *,
    slash_command: dict[str, Any] | None,
    links: list[dict[str, Any]],
    custom_emojis: list[dict[str, Any]],
    reactions: list[dict[str, Any]],
) -> list[str]:
    notes: list[str] = []

    if slash_command:
        label = slash_command.get("commandName") or slash_command.get("commandId") or "unknown"
        command_id = slash_command.get("commandId")
        bot = slash_command.get("bot")
        id_text = f" ({command_id})" if command_id and command_id != label else ""
        bot_text = f" for {_identity_label(bot)}" if bot else ""
        notes.append(f"System Note: Slash command {label}{id_text} invoked{bot_text}.")

    for link in links:
        if link["kind"] == "matchedUrl":
            notes.append(f"System Note: Matched URL: {link.get('url') or 'unknown URL'}.")
            continue

        rich_type = link.get("richLinkType") or "rich link"
        title = link.get("title")
        url = link.get("url") or "unknown URL"
        mime_type = link.get("mimeType")
        title_text = f"{title} at " if title else ""
        mime_text = f" ({mime_type})" if mime_type else ""
        notes.append(f"System Note: Rich link {rich_type}: {title_text}{url}{mime_text}.")

    for custom_emoji in custom_emojis:
        emoji = _as_mapping(custom_emoji.get("emoji")) or {}
        label = custom_emoji.get("renderText") or emoji.get("emojiName") or "custom emoji"
        name = emoji.get("name")
        name_text = f" ({name})" if name else ""
        notes.append(f"System Note: Custom emoji {label}{name_text} appears in this message.")

    for reaction in reactions:
        emoji = _as_mapping(reaction.get("emoji")) or {}
        label = emoji.get("label") or "unknown emoji"
        count = reaction.get("reactionCount") or 0
        plural = "reaction" if count == 1 else "reactions"
        notes.append(f"System Note: {count} {plural} with {label}.")

    return notes


def _attachment_node(attachment: dict[str, Any]) -> dict[str, Any]:
    content_name = attachment.get("contentName")
    content_type = attachment.get("contentType")
    label = content_name or attachment.get("name") or "an attachment"
    type_text = f" ({content_type})" if content_type else ""
    system_notes = [f"System Note: The user attached {label}{type_text} with this message."]

    return {
        "kind": "attachment",
        "relationship": "attachment",
        "name": attachment.get("name"),
        "contentName": content_name,
        "contentType": content_type,
        "source": attachment.get("source"),
        "mediaResourceName": attachment.get("mediaResourceName"),
        "accessState": "metadata_only",
        "systemNotes": system_notes,
        "children": [],
        "plainTextForModel": "\n".join(system_notes),
    }


def _gif_node(gif: dict[str, Any]) -> dict[str, Any]:
    uri = gif.get("uri")
    system_notes = [f"System Note: The user attached a GIF: {uri or 'unknown URI'}."]

    return {
        "kind": "gif",
        "relationship": "attachment",
        "uri": uri,
        "accessState": "metadata_only",
        "systemNotes": system_notes,
        "children": [],
        "plainTextForModel": "\n".join(system_notes),
    }


def _card_node(card: dict[str, Any]) -> dict[str, Any]:
    card_id = card.get("cardId")
    title = card.get("title")
    id_text = f" {card_id}" if card_id else ""
    title_text = f": {title}" if title else ""
    system_notes = [f"System Note: Message includes card{id_text}{title_text}."]

    return {
        "kind": "card",
        "relationship": "card",
        "cardId": card_id,
        "title": title,
        "accessState": "metadata_only",
        "systemNotes": system_notes,
        "children": [],
        "plainTextForModel": "\n".join(system_notes),
    }


def _inaccessible_quote_node(metadata: RawMapping) -> dict[str, Any] | None:
    name = _as_string(metadata.get("name"))

    if not name:
        return None

    updated_at = _as_string(metadata.get("lastUpdateTime"))
    update_text = f"; last known update {updated_at}" if updated_at else ""
    system_notes = [
        f"System Note: Quoted message {name} was referenced but content is inaccessible{update_text}."
    ]

    return {
        "kind": "message",
        "relationship": "quoted_message",
        "ref": {"name": name},
        "sender": None,
        "createdAt": None,
        "updatedAt": updated_at,
        "deletedAt": None,
        "accessState": "inaccessible",
        "text": "",
        "systemNotes": system_notes,
        "children": [],
        "plainTextForModel": "\n".join(system_notes),
    }


def _render_context_node(
    system_notes: list[str], text: str, children: list[dict[str, Any]]
) -> str:
    lines = [
        *system_notes,
        *([text] if text else []),
        *(child["plainTextForModel"] for child in children),
    ]
    return "\n".join(line for line in lines if line)


def _build_context_children(
    raw: RawMapping,
    attachments: list[dict[str, Any]],
    attached_gifs: list[dict[str, Any]],
    cards: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    children: list[dict[str, Any]] = [
        *(_attachment_node(attachment) for attachment in attachments),
        *(_gif_node(gif) for gif in attached_gifs),
        *(_card_node(card) for card in cards),
    ]
    quote_metadata = _as_mapping(raw.get("quotedMessageMetadata"))

    if quote_metadata:
        quoted_message = _as_mapping(quote_metadata.get("message")) or _as_mapping(
            quote_metadata.get("quotedMessage")
        ) or _quoted_snapshot_message(quote_metadata)
        quote_node = (
            _build_message_ast(quoted_message, "quoted_message")["contextNode"]
            if quoted_message
            else _inaccessible_quote_node(quote_metadata)
        )
        if quote_node:
            children.append(quote_node)

    return children


def _quoted_snapshot_message(metadata: RawMapping) -> dict[str, Any] | None:
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
        "attachment": _as_list(snapshot.get("attachments")),
    }


def _deletion_type(raw: RawMapping) -> str | None:
    deletion_metadata = _as_mapping(raw.get("deletionMetadata"))
    return _as_string(deletion_metadata.get("deletionType")) if deletion_metadata else None


def _build_message_ast(raw: RawMapping, relationship: str) -> dict[str, Any]:
    name = _as_string(raw.get("name"))

    if not name:
        raise TypeError("Expected a Google Chat Message object with a name.")

    text = _as_string(raw.get("text")) or ""
    annotations = _normalize_annotations(text, raw.get("annotations"))
    segments = _build_segments(text, annotations)
    rendered_text = _render_segments(text, segments)
    links = _normalize_links(raw, text, annotations)
    slash_command = _top_level_slash_command(raw, annotations)
    custom_emojis = _normalize_custom_emojis(annotations)
    attachments = _normalize_attachments(
        [*_as_list(raw.get("attachment")), *_as_list(raw.get("attachments"))]
    )
    attached_gifs = _normalize_attached_gifs(raw.get("attachedGifs"))
    cards = _normalize_cards(raw.get("cardsV2"))
    reactions = _normalize_reactions(raw.get("emojiReactionSummaries"))
    space = _normalize_space(raw.get("space"))
    thread = _normalize_thread(raw.get("thread"))
    sender = _normalize_identity(raw.get("sender"))
    private_message_viewer = _normalize_identity(raw.get("privateMessageViewer"))
    created_at = _as_string(raw.get("createTime"))
    updated_at = _as_string(raw.get("lastUpdateTime"))
    deleted_at = _as_string(raw.get("deleteTime"))
    deleted = deleted_at is not None or "deletionMetadata" in raw
    thread_reply = _as_bool(raw.get("threadReply"))
    if thread_reply is None:
        thread_reply = thread is not None
    direct_message = (space or {}).get("type") == "DM"
    base_notes = _base_message_system_notes(
        name=name,
        relationship=relationship,
        sender=sender,
        created_at=created_at,
        updated_at=updated_at,
        deleted_at=deleted_at,
        deleted=deleted,
        deletion_type=_deletion_type(raw),
        thread_reply=thread_reply,
        thread=thread,
        private_message_viewer=private_message_viewer,
        direct_message=direct_message,
    )
    system_notes = [
        *base_notes,
        *_metadata_system_notes(
            slash_command=slash_command,
            links=links,
            custom_emojis=custom_emojis,
            reactions=reactions,
        ),
    ]
    children = _build_context_children(raw, attachments, attached_gifs, cards)
    node_text = "" if deleted else rendered_text
    context_node = {
        "kind": "message",
        "relationship": relationship,
        "ref": {"name": name},
        "sender": sender,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "deletedAt": deleted_at,
        "accessState": "deleted" if deleted else "available",
        "text": node_text,
        "systemNotes": system_notes,
        "children": children,
        "plainTextForModel": _render_context_node(system_notes, node_text, children),
    }

    return {
        "schemaVersion": "message-ast.v1",
        "ref": {"name": name},
        "space": space,
        "thread": thread,
        "sender": sender,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "deletedAt": deleted_at,
        "state": {
            "deleted": deleted,
            "private": private_message_viewer is not None,
            "threadReply": thread_reply,
            "directMessage": direct_message,
        },
        "privateMessageViewer": private_message_viewer,
        "text": text,
        "formattedText": _as_string(raw.get("formattedText")),
        "argumentText": _as_string(raw.get("argumentText")),
        "segments": segments,
        "annotations": annotations,
        "links": links,
        "slashCommand": slash_command,
        "customEmojis": custom_emojis,
        "attachments": attachments,
        "attachedGifs": attached_gifs,
        "cards": cards,
        "reactions": reactions,
        "systemNotes": system_notes,
        "contextNode": context_node,
        "plainTextForModel": context_node["plainTextForModel"],
    }


def normalize_message(input_message: Any) -> dict[str, Any]:
    """Normalize a Google Chat Message resource into the shared message AST."""

    raw = _as_mapping(input_message)

    if not raw:
        raise TypeError("Expected a Google Chat Message object.")

    return _build_message_ast(raw, "root")
