"""FastAPI example for local Google Chat fixture POSTs.

Run from the repository root after installing the optional FastAPI extra:

    PYTHONPATH=packages/python/src uvicorn app:app --app-dir examples/python-fastapi --host 127.0.0.1 --port 8787
"""

from __future__ import annotations

from fastapi import FastAPI

from googlechatai import GoogleChatAI
from googlechatai.adapters.fastapi import FastAPIAdapter


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


app = FastAPI(title="Google Chat AI SDK local fixture example")
FastAPIAdapter(chat, path="/chat/events", source="fixture").mount(app)


@app.get("/healthz")
def healthz():
    return {"ok": True}
