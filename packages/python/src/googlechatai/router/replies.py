"""Synchronous JSON response helpers for Google Chat HTTP events."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from googlechatai.messages import resolve_reply_target


@dataclass(frozen=True)
class ChatResponse:
    """A local HTTP response payload for Google Chat event callbacks.

    This object only represents the JSON body returned to the inbound Chat event
    request. It does not send messages through the Google Chat API.
    """

    payload: dict[str, Any]
    reply_target: dict[str, Any] | None = None


def json_response(
    *,
    text: str | None = None,
    cards: Sequence[Mapping[str, Any]] | None = None,
    action_response: Mapping[str, Any] | None = None,
    raw: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a synchronous Google Chat JSON response payload."""

    payload = dict(raw or {})

    if text is not None:
        payload["text"] = text

    if cards is not None:
        payload["cardsV2"] = [dict(card) for card in cards]

    if action_response is not None:
        payload["actionResponse"] = dict(action_response)

    return payload


class ReplyBuilder:
    """Build local reply placeholders without calling the live Chat API."""

    def __init__(
        self,
        *,
        event: Mapping[str, Any] | None = None,
        default_reply_routing: Mapping[str, Any] | None = None,
    ) -> None:
        self._event = event
        self._default_reply_routing = dict(default_reply_routing or {})

    def target(
        self,
        reply_routing: Mapping[str, Any] | None = None,
        **reply_routing_overrides: Any,
    ) -> dict[str, Any]:
        if self._event is None:
            raise TypeError("Expected an event before resolving a reply target.")
        merged = {
            **self._default_reply_routing,
            **dict(reply_routing or {}),
            **reply_routing_overrides,
        }
        payload: dict[str, Any] = {"event": self._event}
        if merged:
            payload["replyRouting"] = merged
        return resolve_reply_target(payload)

    def text(self, text: str, **kwargs: Any) -> ChatResponse:
        return ChatResponse(json_response(text=text, **kwargs))

    def placeholder(
        self,
        text: str = "Working on it",
        *,
        reply_routing: Mapping[str, Any] | None = None,
        target: Mapping[str, Any] | None = None,
        **kwargs: Any,
    ) -> ChatResponse:
        if target is not None:
            reply_target = dict(target)
        elif self._event is not None:
            reply_target = self.target(reply_routing)
        else:
            reply_target = None
        return ChatResponse(json_response(text=text, **kwargs), reply_target=reply_target)

    async def send(self, *_args: Any, **_kwargs: Any) -> None:
        raise NotImplementedError(
            "Live Google Chat sends are not implemented in this runtime yet. "
            "Return ctx.reply.text(...) or ctx.reply.placeholder(...) for a "
            "synchronous local Chat JSON response."
        )


def normalize_handler_response(value: Any) -> dict[str, Any]:
    """Normalize supported handler return values into a JSON response body."""

    if value is None:
        return {}

    if isinstance(value, ChatResponse):
        return dict(value.payload)

    if isinstance(value, str):
        return json_response(text=value)

    if isinstance(value, Mapping):
        return dict(value)

    raise TypeError(
        "Handler must return None, str, a mapping, or ChatResponse from "
        "ctx.reply.*."
    )
