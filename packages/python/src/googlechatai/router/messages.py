"""Message-context readers used by the router handler context."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


class MessageContextReader:
    """Read current and related message context from normalized envelopes.

    Recursive quote parsing belongs here, not in the router dispatch path. The
    current W6 slice exposes the extension point and returns an empty quoted
    tree until the message AST workstream provides richer structures.
    """

    def current_message(self, event: Mapping[str, Any]) -> dict[str, Any] | None:
        message = event.get("message")
        return dict(message) if isinstance(message, Mapping) else None

    async def quoted_message_tree(self, event: Mapping[str, Any]) -> list[dict[str, Any]]:
        _ = event
        return []

    def relationship_system_notes(self, event: Mapping[str, Any]) -> list[str]:
        kind = event.get("kind")
        notes: list[str] = []

        if isinstance(kind, str):
            notes.append(f"System Note: Received Google Chat event {kind}.")

        message = event.get("message")
        if isinstance(message, Mapping) and message.get("isThreadReply"):
            notes.append("System Note: The current message is a thread reply.")

        return notes
