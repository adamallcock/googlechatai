"""Dependency-free ASGI adapter for local Google Chat event POSTs."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from googlechatai.router import GoogleChatAI
from googlechatai.verify import bearer_token_from_authorization


Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]


class ASGIAdapter:
    """Expose a ``GoogleChatAI`` runtime as a minimal ASGI app."""

    def __init__(
        self,
        chat: GoogleChatAI,
        *,
        path: str = "/chat/events",
        source: str = "chat_http",
        verifier: Any | None = None,
    ) -> None:
        self.chat = chat
        self.path = path
        self.source = source
        self.verifier = verifier

    async def __call__(
        self,
        scope: Mapping[str, Any],
        receive: Receive,
        send: Send,
    ) -> None:
        if scope.get("type") != "http":
            raise RuntimeError("ASGIAdapter only supports HTTP scopes.")

        if scope.get("path") != self.path:
            await self._send_json(send, 404, {"error": "not_found"})
            return

        if scope.get("method") != "POST":
            await self._send_json(send, 405, {"error": "method_not_allowed"})
            return

        if self.verifier is not None:
            authorization = self._header(scope, b"authorization")
            verification = self.verifier.verify(
                bearer_token_from_authorization(authorization)
            )
            if not verification.get("ok"):
                await self._send_json(
                    send,
                    401,
                    {
                        "error": "unauthorized_request",
                        "status": verification.get("status"),
                    },
                )
                return

        try:
            payload = json.loads((await self._read_body(receive)).decode("utf-8"))
        except json.JSONDecodeError:
            await self._send_json(send, 400, {"error": "invalid_json"})
            return

        response = await self.chat.dispatch_async(payload, source=self.source)
        await self._send_json(send, 200, response)

    def _header(self, scope: Mapping[str, Any], name: bytes) -> str | None:
        for raw_name, raw_value in scope.get("headers") or []:
            if bytes(raw_name).lower() == name:
                return bytes(raw_value).decode("latin-1")
        return None

    async def _read_body(self, receive: Receive) -> bytes:
        chunks: list[bytes] = []

        while True:
            message = await receive()
            if message.get("type") == "http.disconnect":
                break

            chunks.append(message.get("body", b""))
            if not message.get("more_body", False):
                break

        return b"".join(chunks)

    async def _send_json(self, send: Send, status: int, payload: Mapping[str, Any]) -> None:
        body = json.dumps(dict(payload), separators=(",", ":")).encode("utf-8")
        headers = [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode("ascii")),
        ]
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})
