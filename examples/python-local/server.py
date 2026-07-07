"""Dependency-free local server for posting Google Chat fixtures."""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from googlechatai import GoogleChatAI


def build_chat() -> GoogleChatAI:
    chat = GoogleChatAI()

    @chat.on_message
    async def handle_message(ctx):
        message = ctx.current_message or {}
        text = message.get("plainTextForModel") or "message"
        return ctx.reply.placeholder(f"Received local fixture: {text}")

    @chat.on_card_clicked
    def handle_card_clicked(ctx):
        _ = ctx
        return {"text": "Received local card click fixture."}

    @chat.on_dialog_submitted
    def handle_dialog_submitted(ctx):
        _ = ctx
        return {"text": "Received local dialog submission fixture."}

    @chat.on_unknown_event
    def handle_unknown(ctx):
        return {"text": f"Received unhandled fixture kind: {ctx.event['kind']}"}

    return chat


class ChatFixtureHandler(BaseHTTPRequestHandler):
    chat = build_chat()

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._send_json(200, {"ok": True})
            return
        self._send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/chat/events":
            self._send_json(404, {"error": "not_found"})
            return

        try:
            payload = self._read_json()
            response = self.chat.dispatch(payload, source="fixture")
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid_json"})
            return
        except Exception as exc:
            self._send_json(500, {"error": "handler_error", "message": str(exc)})
            return

        self._send_json(200, response)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length)
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise TypeError("Expected a JSON object.")
        return value

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), ChatFixtureHandler)
    print(f"Listening on http://{args.host}:{args.port}/chat/events")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down local fixture server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
