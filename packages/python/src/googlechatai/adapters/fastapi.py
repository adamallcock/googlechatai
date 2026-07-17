"""FastAPI adapter for Google Chat event POSTs."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from googlechatai.adapters.asgi import (
    DEFAULT_MAX_BODY_BYTES,
    DEFAULT_VERIFICATION_TIMEOUT_MS,
    RequestBodyTooLargeError,
    VerificationCapacityError,
    _positive_integer,
    verify_with_timeout,
)
from googlechatai.router import DeliveryCapacityError, GoogleChatAI


class FastAPIAdapter:
    """Mount a ``GoogleChatAI`` runtime on an existing FastAPI app."""

    def __init__(
        self,
        chat: GoogleChatAI,
        *,
        path: str = "/chat/events",
        source: str = "chat_http",
        verifier: Any | None = None,
        verification_timeout_ms: int = DEFAULT_VERIFICATION_TIMEOUT_MS,
        max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
    ) -> None:
        self.chat = chat
        self.path = path
        self.source = source
        self.verifier = verifier
        self.verification_timeout_ms = _positive_integer(
            verification_timeout_ms,
            name="verification_timeout_ms",
            default=DEFAULT_VERIFICATION_TIMEOUT_MS,
        )
        self.max_body_bytes = _positive_integer(
            max_body_bytes,
            name="max_body_bytes",
            default=DEFAULT_MAX_BODY_BYTES,
        )

    def mount(self, app: Any) -> Any:
        try:
            from fastapi import Request
            from fastapi.responses import JSONResponse
        except ImportError as exc:
            raise ImportError(
                "FastAPI support requires the optional dependency extra: "
                "pip install 'googlechatai[fastapi]'."
            ) from exc

        async def chat_events(request: Any) -> Any:
            declared_length = _declared_content_length(request.headers.get("content-length"))
            if declared_length is not None and declared_length > self.max_body_bytes:
                return JSONResponse({"error": "payload_too_large"}, status_code=413)
            if self.verifier is not None:
                try:
                    verification = await verify_with_timeout(
                        self.verifier,
                        request.headers.get("authorization"),
                        self.verification_timeout_ms,
                    )
                except VerificationCapacityError:
                    return JSONResponse(
                        {"error": "verification_capacity_exhausted"},
                        status_code=503,
                    )
                except Exception:
                    return JSONResponse(
                        {"error": "verification_unavailable"},
                        status_code=500,
                    )
                if not isinstance(verification, Mapping):
                    return JSONResponse(
                        {"error": "verification_unavailable"},
                        status_code=500,
                    )
                if not verification.get("ok"):
                    return JSONResponse(
                        {
                            "error": "unauthorized_request",
                            "status": verification.get("status"),
                        },
                        status_code=401,
                    )
            try:
                body = await _read_bounded_body(request, self.max_body_bytes)
                payload = json.loads(body.decode("utf-8"))
            except RequestBodyTooLargeError:
                return JSONResponse({"error": "payload_too_large"}, status_code=413)
            except (json.JSONDecodeError, TypeError, UnicodeDecodeError):
                return JSONResponse({"error": "invalid_json"}, status_code=400)
            if not isinstance(payload, Mapping):
                return JSONResponse({"error": "invalid_event_payload"}, status_code=400)
            try:
                response = await self.chat.dispatch_async(payload, source=self.source)
            except DeliveryCapacityError:
                return JSONResponse(
                    {"error": "delivery_capacity_exhausted"},
                    status_code=503,
                )
            return JSONResponse(response)

        chat_events.__annotations__ = {
            "request": Request,
            "return": JSONResponse,
        }
        app.post(self.path)(chat_events)
        return chat_events


def mount_fastapi(
    app: Any,
    chat: GoogleChatAI,
    *,
    path: str = "/chat/events",
    source: str = "chat_http",
    verifier: Any | None = None,
    verification_timeout_ms: int = DEFAULT_VERIFICATION_TIMEOUT_MS,
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
) -> Any:
    """Convenience helper for mounting a Chat runtime on FastAPI."""

    return FastAPIAdapter(
        chat,
        path=path,
        source=source,
        verifier=verifier,
        verification_timeout_ms=verification_timeout_ms,
        max_body_bytes=max_body_bytes,
    ).mount(app)


def _declared_content_length(value: Any) -> int | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return int(stripped) if stripped.isdigit() else None


async def _read_bounded_body(request: Any, max_body_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total_bytes = 0
    async for chunk in request.stream():
        if not isinstance(chunk, bytes):
            raise TypeError("FastAPI request body chunks must be bytes.")
        total_bytes += len(chunk)
        if total_bytes > max_body_bytes:
            raise RequestBodyTooLargeError(max_body_bytes)
        chunks.append(chunk)
    return b"".join(chunks)
