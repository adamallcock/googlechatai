---
title: Node Runtime Router Local Fixtures
date: 2026-06-29
type: guide
status: draft
---

# Node Runtime Router Local Fixtures

The Node runtime accepts local Google Chat fixture POSTs through a Fetch API
handler and an Express-compatible adapter. This W5 slice is intentionally
inbound-only: reply helpers can return synchronous JSON responses to Google Chat
events, but they do not call the live Google Chat API or send follow-up
messages.

## Run The Local Example

Build the package first because the example imports the compiled local package:

```bash
pnpm build
node examples/node-local-runtime/server.mjs
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
  "text": "Local runtime received: @Ada Lovelace deploy staging https://example.com (1 attachment metadata item(s))"
}
```

## Runtime Surface

```ts
import { GoogleChatAI, expressAdapter } from "googlechatai";

const chat = new GoogleChatAI({
  source: "chat_http",
  appUser: { name: "users/app" },
});

chat.use(async (event, ctx, next) => {
  await ctx.ai.timestamps();
  return next();
});

chat.onMention(async (event, ctx) => {
  const thread = await ctx.ai.threadHistory({ limit: 25 });
  return ctx.reply.text(`Loaded thread context for ${event.eventId}`);
});

chat.onUnknownEvent((event, ctx) =>
  ctx.reply.json({ text: `Unhandled ${event.rawKind ?? "unknown"}` }),
);

export const handler = expressAdapter(chat);
```

## Boundary Assumptions

- W2 owns deep event normalization. The router consumes `normalizeEvent(...)` and
  only adds a small adapter boundary for app-mention routing and dialog-submit
  routing while W2 is still sparse.
- W3/W8 own recursive quoted-message, message-context, and attachment parsing.
  Router AI helpers delegate through `contextLoaders` instead of walking nested
  quote or attachment structures directly.
- `ctx.reply.text(...)` and `ctx.reply.json(...)` return synchronous JSON bodies.
  `ctx.reply.stream(...)` and `ctx.reply.privateText(...)` return placeholders
  with `sent: false` and `liveSendAvailable: false`.
- Raw payload access is available as `ctx.rawPayload`; application handlers
  should prefer normalized `event` fields and AI-context helpers.
