---
title: Python Runtime Router Local Fixtures
date: 2026-06-29
type: guide
status: draft
---

# Python Runtime Router Local Fixtures

The Python runtime accepts local Google Chat fixture POSTs through a
dependency-free ASGI adapter, an optional FastAPI adapter, and a small stdlib
HTTP example. This W6 slice is intentionally inbound-only: reply helpers return
synchronous JSON responses to Google Chat events, but they do not call the live
Google Chat API or send follow-up messages.

## Run The Stdlib Local Example

From the repository root:

```bash
PYTHONPATH=packages/python/src \
  python3 examples/python-local/server.py --host 127.0.0.1 --port 8787
```

Then post a fixture from another shell:

```bash
curl -sS \
  -X POST http://127.0.0.1:8787/chat/events \
  -H 'content-type: application/json' \
  --data-binary @fixtures/events/message-created/basic.json
```

Expected response:

```json
{
  "text": "Received local fixture: @Ada Lovelace deploy staging https://example.com"
}
```

## FastAPI Adapter

Install the optional framework extra when running the FastAPI example from a
built package:

```bash
python3 -m pip install -e 'packages/python[fastapi]'
```

For local source-tree development, run:

```bash
PYTHONPATH=packages/python/src \
  uvicorn app:app --app-dir examples/python-fastapi --host 127.0.0.1 --port 8787
```

The FastAPI app exposes `POST /chat/events` and `GET /healthz`.

## Runtime Surface

```python
from fastapi import FastAPI

from googlechatai import GoogleChatAI
from googlechatai.adapters.fastapi import FastAPIAdapter

app = FastAPI()
chat = GoogleChatAI()


@chat.on_message
async def handle_message(ctx):
    ai_context = await ctx.ai_context(thread_limit=25)
    return ctx.reply.placeholder(
        f"Loaded context for {ai_context['currentMessage']['ref']['name']}"
    )


@chat.on_card_clicked
def handle_card_clicked(ctx):
    return ctx.reply.text("Card click received.")


@chat.on_dialog_submitted
def handle_dialog_submitted(ctx):
    return {"text": "Dialog submitted."}


@chat.on_unknown_event
def handle_unknown(ctx):
    return {"text": f"Unhandled {ctx.event['rawKind'] or 'unknown'} event."}


FastAPIAdapter(chat, path="/chat/events", source="fixture").mount(app)
```

## Boundary Assumptions

- W2 owns deep event normalization. The router consumes `normalize_event(...)`
  and only adds a small adapter boundary for dialog-submit routing while W2 is
  still sparse.
- W3/W8 own recursive quoted-message, message-context, and attachment parsing.
  Router context helpers delegate through message, attachment, identity,
  timestamp, and history readers instead of walking nested quote or attachment
  structures directly.
- `ctx.reply.text(...)`, `ctx.reply.placeholder(...)`, and `json_response(...)`
  return synchronous JSON bodies. `ctx.reply.send(...)` raises
  `NotImplementedError` until live sends are implemented by a later workstream.
- Raw payload access is available as `ctx.raw_event`; application handlers
  should prefer normalized `ctx.event` fields and AI-context helpers.
