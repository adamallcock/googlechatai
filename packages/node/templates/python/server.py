from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from googlechatai.verify import create_google_chat_token_verifier

from app import build_chat


AUDIENCE = os.environ.get("GOOGLE_CHAT_PROJECT_NUMBER", "").strip()
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", "1048576"))
if not AUDIENCE:
    raise RuntimeError(
        "GOOGLE_CHAT_PROJECT_NUMBER is required before the live callback server "
        "starts. Run `npx googlechatai doctor`."
    )

CHAT = build_chat()
VERIFIER = create_google_chat_token_verifier(audience=AUDIENCE)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/healthz":
            self.send_json(200, {"ok": True, "service": "__PROJECT_NAME__"})
            return
        self.send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/chat/events":
            self.send_json(404, {"error": "not_found"})
            return

        authorization = self.headers.get("authorization", "")
        token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else None
        verification = VERIFIER.verify(token)
        if verification.get("ok") is not True:
            self.send_json(401, {"error": "unauthorized_request"})
            return

        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self.send_json(400, {"error": "invalid_content_length"})
            return
        if length < 0:
            self.send_json(400, {"error": "invalid_content_length"})
            return
        if MAX_BODY_BYTES <= 0 or length > MAX_BODY_BYTES:
            self.send_json(413, {"error": "request_body_too_large"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {"error": "invalid_json"})
            return
        if not isinstance(payload, dict):
            self.send_json(400, {"error": "invalid_event"})
            return
        self.send_json(200, CHAT.dispatch(payload, source="chat_http"))

    def log_message(self, format: str, *args: object) -> None:
        return

    def send_json(self, status: int, value: dict[str, object]) -> None:
        body = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8787"))
    print(f"Listening on http://{host}:{port}/chat/events")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
