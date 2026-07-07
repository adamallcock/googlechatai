"""Identity context helpers for normalized Google Chat events."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


class IdentityContextReader:
    """Collect visible sender and actor identities for AI context."""

    async def sender_identities(self, event: Mapping[str, Any]) -> list[dict[str, Any]]:
        identities: list[dict[str, Any]] = []
        seen: set[str] = set()

        for value in (event.get("actor"), self._message_sender(event)):
            if not isinstance(value, Mapping):
                continue

            name = value.get("name")
            key = name if isinstance(name, str) else repr(sorted(value.items()))
            if key in seen:
                continue

            identities.append(dict(value))
            seen.add(key)

        return identities

    def _message_sender(self, event: Mapping[str, Any]) -> Any:
        message = event.get("message")
        if isinstance(message, Mapping):
            return message.get("sender")
        return None
