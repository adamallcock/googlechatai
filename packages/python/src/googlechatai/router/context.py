"""Handler context and AI-context extension points for router callbacks."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .attachments import AttachmentContextReader
from .history import HistoryContextReader
from .identity import IdentityContextReader
from .messages import MessageContextReader
from .replies import ReplyBuilder
from .time_context import TimestampContextReader


class ContextLoader:
    """Delegate AI context loading to focused reader modules."""

    def __init__(
        self,
        *,
        messages: MessageContextReader | None = None,
        attachments: AttachmentContextReader | None = None,
        history: HistoryContextReader | None = None,
        identity: IdentityContextReader | None = None,
        timestamps: TimestampContextReader | None = None,
    ) -> None:
        self.messages = messages or MessageContextReader()
        self.attachment_reader = attachments or AttachmentContextReader()
        self.history = history or HistoryContextReader()
        self.identity = identity or IdentityContextReader()
        self.timestamp_reader = timestamps or TimestampContextReader()

    def current_message(self, event: Mapping[str, Any]) -> dict[str, Any] | None:
        return self.messages.current_message(event)

    async def quoted_message_tree(self, event: Mapping[str, Any]) -> list[dict[str, Any]]:
        return await self.messages.quoted_message_tree(event)

    async def thread_history(
        self,
        event: Mapping[str, Any],
        **options: Any,
    ) -> dict[str, Any]:
        return await self.history.thread_history(event, **options)

    async def room_history(
        self,
        event: Mapping[str, Any],
        **options: Any,
    ) -> dict[str, Any]:
        return await self.history.room_history(event, **options)

    async def attachments(self, event: Mapping[str, Any]) -> list[dict[str, Any]]:
        return await self.attachment_reader.attachments(event)

    async def sender_identities(self, event: Mapping[str, Any]) -> list[dict[str, Any]]:
        return await self.identity.sender_identities(event)

    def timestamps(self, event: Mapping[str, Any]) -> dict[str, Any]:
        return self.timestamp_reader.timestamps(event)

    def relationship_system_notes(self, event: Mapping[str, Any]) -> list[str]:
        return [
            *self.messages.relationship_system_notes(event),
            *self.attachment_reader.system_notes(event),
        ]


class HandlerContext:
    """Context object passed to registered Google Chat handlers."""

    def __init__(
        self,
        *,
        chat: Any,
        event: dict[str, Any],
        raw_event: Mapping[str, Any],
        context_loader: Any,
        reply_routing: Mapping[str, Any] | None = None,
    ) -> None:
        self.chat = chat
        self.event = event
        self.raw_event = raw_event
        self._context_loader = context_loader
        self._reply_routing = dict(reply_routing or {})
        self.reply = ReplyBuilder(
            event=event,
            default_reply_routing=self._reply_routing,
        )

    @property
    def current_message(self) -> dict[str, Any] | None:
        return self._context_loader.current_message(self.event)

    async def quoted_message_tree(self) -> list[dict[str, Any]]:
        return await self._context_loader.quoted_message_tree(self.event)

    async def thread_history(self, **options: Any) -> dict[str, Any]:
        return await self._context_loader.thread_history(self.event, **options)

    async def room_history(self, **options: Any) -> dict[str, Any]:
        return await self._context_loader.room_history(self.event, **options)

    async def attachments(self) -> list[dict[str, Any]]:
        return await self._context_loader.attachments(self.event)

    async def sender_identities(self) -> list[dict[str, Any]]:
        return await self._context_loader.sender_identities(self.event)

    def timestamps(self) -> dict[str, Any]:
        return self._context_loader.timestamps(self.event)

    def relationship_system_notes(self) -> list[str]:
        notes = list(self._context_loader.relationship_system_notes(self.event))
        try:
            notes.extend(self.reply_target().get("systemNotes", []))
        except TypeError:
            pass
        return notes

    def reply_target(
        self,
        reply_routing: Mapping[str, Any] | None = None,
        **reply_routing_overrides: Any,
    ) -> dict[str, Any]:
        return self.reply.target(reply_routing, **reply_routing_overrides)

    async def ai_context(
        self,
        *,
        thread_limit: int = 20,
        room_limit: int = 20,
        **history_options: Any,
    ) -> dict[str, Any]:
        """Collect model-ready context extension points for this event."""

        current_message = self.current_message
        quoted_message_tree = await self.quoted_message_tree()
        thread_history = await self.thread_history(
            limit=thread_limit,
            **history_options,
        )
        room_history = await self.room_history(
            limit=room_limit,
            **history_options,
        )

        return {
            "currentMessage": current_message,
            "replyTarget": self.reply_target(),
            "quotedMessageTree": quoted_message_tree,
            "threadHistory": thread_history,
            "roomHistory": room_history,
            "attachments": await self.attachments(),
            "senderIdentities": await self.sender_identities(),
            "timestamps": self.timestamps(),
            "relationshipSystemNotes": self.relationship_system_notes(),
        }
