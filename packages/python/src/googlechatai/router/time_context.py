"""Timestamp context helpers for normalized Google Chat events."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


class TimestampContextReader:
    """Collect event and message timestamps for AI context."""

    def timestamps(self, event: Mapping[str, Any]) -> dict[str, Any]:
        message = event.get("message")
        message_timestamps: dict[str, Any] = {}

        if isinstance(message, Mapping):
            message_timestamps = {
                "createdAt": message.get("createdAt"),
                "updatedAt": message.get("updatedAt"),
                "deletedAt": message.get("deletedAt"),
            }

        return {
            "receivedAt": event.get("receivedAt"),
            "message": message_timestamps,
        }
