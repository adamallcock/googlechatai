"""FastAPI adapter for Google Chat event POSTs."""

from __future__ import annotations

from typing import Any

from googlechatai.router import GoogleChatAI
from googlechatai.verify import bearer_token_from_authorization


class FastAPIAdapter:
    """Mount a ``GoogleChatAI`` runtime on an existing FastAPI app."""

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
            if self.verifier is not None:
                verification = self.verifier.verify(
                    bearer_token_from_authorization(
                        request.headers.get("authorization")
                    )
                )
                if not verification.get("ok"):
                    return JSONResponse(
                        {
                            "error": "unauthorized_request",
                            "status": verification.get("status"),
                        },
                        status_code=401,
                    )
            payload = await request.json()
            response = await self.chat.dispatch_async(payload, source=self.source)
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
) -> Any:
    """Convenience helper for mounting a Chat runtime on FastAPI."""

    return FastAPIAdapter(
        chat, path=path, source=source, verifier=verifier
    ).mount(app)
