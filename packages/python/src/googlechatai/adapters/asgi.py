"""Dependency-free ASGI adapter for local Google Chat event POSTs."""

from __future__ import annotations

import asyncio
import inspect
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from googlechatai.router import DeliveryCapacityError, GoogleChatAI
from googlechatai.verify import bearer_token_from_authorization


Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]
DEFAULT_VERIFICATION_TIMEOUT_MS = 5_000
DEFAULT_MAX_BODY_BYTES = 1_048_576
_VERIFIER_WORKERS = 8
_VERIFIER_WORK_CAPACITY = 16
_verifier_executor = ThreadPoolExecutor(
    max_workers=_VERIFIER_WORKERS,
    thread_name_prefix="googlechatai-verifier",
)
_verifier_work_slots = threading.BoundedSemaphore(_VERIFIER_WORK_CAPACITY)


class RequestBodyTooLargeError(ValueError):
    def __init__(self, max_body_bytes: int) -> None:
        super().__init__(
            f"Google Chat event payload exceeds the {max_body_bytes} byte limit."
        )
        self.max_body_bytes = max_body_bytes


class VerificationCapacityError(RuntimeError):
    """A verifier call could not enter the bounded blocking-work pool."""


async def _run_bounded_verifier(function: Callable[..., Any], *args: Any) -> Any:
    if not _verifier_work_slots.acquire(blocking=False):
        raise VerificationCapacityError(
            "Google Chat verifier capacity is exhausted."
        )

    def invoke() -> Any:
        try:
            return function(*args)
        finally:
            _verifier_work_slots.release()

    loop = asyncio.get_running_loop()
    try:
        future = loop.run_in_executor(_verifier_executor, invoke)
    except BaseException:
        _verifier_work_slots.release()
        raise
    # Preserve queued work after an HTTP deadline expires so its admission
    # slot is released by `invoke()` rather than leaked by cancellation.
    return await asyncio.shield(future)


def _positive_integer(value: Any, *, name: str, default: int) -> int:
    if value is None:
        return default
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise TypeError(f"{name} must be a positive integer.")
    return value


def _declared_content_length(headers: Any) -> int | None:
    for raw_name, raw_value in headers or []:
        if bytes(raw_name).lower() != b"content-length":
            continue
        try:
            value = bytes(raw_value).decode("ascii").strip()
        except UnicodeDecodeError:
            return None
        return int(value) if value.isdigit() else None
    return None


async def verify_with_timeout(
    verifier: Any,
    authorization: str | None,
    verification_timeout_ms: int,
) -> Mapping[str, Any]:
    """Run sync or async verifier implementations within one full deadline."""

    async def invoke() -> Any:
        # Invoking through a worker keeps the built-in synchronous JWKS
        # verifier off the ASGI loop. Async verifier methods merely construct
        # their awaitable in the worker and then run it on this event loop.
        result = await _run_bounded_verifier(
            verifier.verify,
            bearer_token_from_authorization(authorization),
        )
        if inspect.isawaitable(result):
            return await result
        return result

    result = await asyncio.wait_for(
        invoke(),
        timeout=verification_timeout_ms / 1000,
    )
    if not isinstance(result, Mapping):
        raise TypeError("Google Chat verifier must return a mapping result.")
    return result


class ASGIAdapter:
    """Expose a ``GoogleChatAI`` runtime as a minimal ASGI app."""

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

        declared_length = _declared_content_length(scope.get("headers"))
        if declared_length is not None and declared_length > self.max_body_bytes:
            await self._send_json(send, 413, {"error": "payload_too_large"})
            return

        if self.verifier is not None:
            try:
                verification = await self._verify(scope)
            except VerificationCapacityError:
                await self._send_json(
                    send,
                    503,
                    {"error": "verification_capacity_exhausted"},
                )
                return
            except Exception:
                await self._send_json(send, 500, {"error": "verification_unavailable"})
                return
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
        except RequestBodyTooLargeError:
            await self._send_json(send, 413, {"error": "payload_too_large"})
            return
        except (json.JSONDecodeError, TypeError, UnicodeDecodeError):
            await self._send_json(send, 400, {"error": "invalid_json"})
            return

        if not isinstance(payload, Mapping):
            await self._send_json(send, 400, {"error": "invalid_event_payload"})
            return

        try:
            response = await self.chat.dispatch_async(payload, source=self.source)
        except DeliveryCapacityError:
            await self._send_json(send, 503, {"error": "delivery_capacity_exhausted"})
            return
        await self._send_json(send, 200, response)

    async def _verify(self, scope: Mapping[str, Any]) -> Mapping[str, Any]:
        authorization = self._header(scope, b"authorization")
        return await verify_with_timeout(
            self.verifier,
            authorization,
            self.verification_timeout_ms,
        )

    def _header(self, scope: Mapping[str, Any], name: bytes) -> str | None:
        for raw_name, raw_value in scope.get("headers") or []:
            if bytes(raw_name).lower() == name:
                return bytes(raw_value).decode("latin-1")
        return None

    async def _read_body(self, receive: Receive) -> bytes:
        chunks: list[bytes] = []
        total_bytes = 0

        while True:
            message = await receive()
            if message.get("type") == "http.disconnect":
                break

            body = message.get("body", b"")
            if not isinstance(body, bytes):
                raise TypeError("ASGI request body chunks must be bytes.")
            total_bytes += len(body)
            if total_bytes > self.max_body_bytes:
                raise RequestBodyTooLargeError(self.max_body_bytes)
            chunks.append(body)
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
