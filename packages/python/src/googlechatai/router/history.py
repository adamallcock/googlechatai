"""History extension points for AI context loading."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


class HistoryContextReader:
    """Expose thread and room history hooks without making live Chat calls."""

    async def thread_history(
        self,
        event: Mapping[str, Any],
        *,
        limit: int = 20,
        **_options: Any,
    ) -> dict[str, Any]:
        _ = event
        return {
            "status": "unavailable",
            "limit": limit,
            "messages": [],
            "systemNotes": [
                "System Note: Thread history is unavailable because no history reader is configured."
            ],
        }

    async def room_history(
        self,
        event: Mapping[str, Any],
        *,
        limit: int = 20,
        **_options: Any,
    ) -> dict[str, Any]:
        _ = event
        return {
            "status": "unavailable",
            "limit": limit,
            "messages": [],
            "systemNotes": [
                "System Note: Room history is unavailable because no history reader is configured."
            ],
        }
