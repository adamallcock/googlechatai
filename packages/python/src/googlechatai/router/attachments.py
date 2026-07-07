"""Attachment-context readers used by the router handler context."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


class AttachmentContextReader:
    """Read attachment metadata without downloading or parsing live media."""

    async def attachments(self, event: Mapping[str, Any]) -> list[dict[str, Any]]:
        message = event.get("message")
        if not isinstance(message, Mapping):
            return []

        attachments = message.get("attachments")
        if not isinstance(attachments, list):
            return []

        return [dict(item) for item in attachments if isinstance(item, Mapping)]

    def system_notes(self, event: Mapping[str, Any]) -> list[str]:
        message = event.get("message")
        if not isinstance(message, Mapping):
            return []

        attachments = message.get("attachments")
        if not isinstance(attachments, list):
            return []

        notes: list[str] = []
        for item in attachments:
            if not isinstance(item, Mapping):
                continue

            name = item.get("contentName") or item.get("name") or "an attachment"
            content_type = item.get("contentType") or "unknown content type"
            notes.append(
                f"System Note: The user attached {name} ({content_type}) with this message."
            )

        return notes
