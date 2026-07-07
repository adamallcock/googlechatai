---
title: Placeholder Responses
date: 2026-07-04
type: guide
status: draft
---

# Placeholder Responses

Implemented in Node and Python.

For AI agents, the recommended responsive Chat pattern is:

1. Create one short placeholder message such as `Thinking...`.
2. Store the returned placeholder response handle.
3. Edit that same Chat message with the final response.

This avoids permanent status cards for ordinary agent turns and avoids posting a
second final-answer message after a placeholder.

## Contract

The placeholder handle carries the metadata needed to patch the correct Chat
message later:

- `space`
- `messageName`
- `threadName` or `threadKey`
- `requestId` and `clientMessageId`
- `correlationId`
- `authMode`
- `createdAt`
- `editable`
- `allowedUpdateMasks`

Completion plans require an editable handle with a real `messageName`. Patch
failure fallback is explicit: the default is `throw`, and `createNewMessage`
only appears as a fallback request in the plan instead of being executed as part
of the normal request list.

## Placeholder Text Config

Implemented selection modes:

- `first`: always use the first configured placeholder.
- `roundRobin`: use `placeholderCursor % textCount` and return `nextCursor` so
  the caller can persist it for the next turn.
- `random`: choose a random placeholder; when `placeholderRandomSeed`,
  `randomSeed`, or `correlationId` is provided, Node and Python choose the same
  deterministic item.

Default pool:

```json
["Thinking...", "Checking the thread...", "Reviewing context..."]
```

Recommended admin JSON object:

```json
{
  "texts": [
    "Thinking...",
    "Checking the thread...",
    "Reviewing attachments..."
  ],
  "mode": "roundRobin",
  "cursor": 0
}
```

JSON arrays are also accepted:

```json
["Thinking...", "Checking context...", "Reviewing files..."]
```

CSV is accepted for simple admin exports:

```csv
Thinking...,Checking context...,Reviewing files...
```

YAML is intentionally not parsed by the core packages yet; if an admin UI
stores YAML, convert it to the JSON object shape before calling the SDK. This
keeps both packages dependency-free and avoids a partial YAML parser.

## Node

```ts
import {
  hydratePlaceholderResponseHandle,
  planCompletePlaceholderResponse,
  planPlaceholderResponse,
} from "googlechatai";

const placeholderPlan = planPlaceholderResponse({
  space: "spaces/AAA",
  thread: "spaces/AAA/threads/T1",
  placeholderConfigJson: JSON.stringify({
    texts: ["Thinking...", "Checking the thread...", "Reviewing attachments..."],
    mode: "roundRobin",
    cursor: 2,
  }),
  authMode: "app",
  requestId: "req-agent-turn-123",
  clientMessageId: "client-agent-turn-123",
  correlationId: "event-123",
});

// Execute placeholderPlan.requests[0] with the central Chat client.
const createdMessage = {
  name: "spaces/AAA/messages/placeholder",
  thread: { name: "spaces/AAA/threads/T1" },
  createTime: "2026-07-04T00:00:00Z",
};

const handle = hydratePlaceholderResponseHandle(
  placeholderPlan.placeholder.handle,
  createdMessage,
);

const completePlan = planCompletePlaceholderResponse({
  handle,
  text: "Final answer with sources.",
});

// Execute completePlan.requests[0] as spaces.messages.patch.
// Persist placeholderPlan.placeholder.textSelection.nextCursor when using
// roundRobin mode.
```

Buffered output can reuse the same placeholder message:

```ts
import { planBufferedPlaceholderCompletion } from "googlechatai";

const bufferedPlan = planBufferedPlaceholderCompletion({
  handle,
  chunks: ["First ", "second ", "final."],
  minPatchChars: 120,
  maxPatches: 5,
  throttleMs: 750,
});
```

## Python

```python
import json

from googlechatai import (
    hydrate_placeholder_response_handle,
    plan_complete_placeholder_response,
    plan_placeholder_response,
)

placeholder_plan = plan_placeholder_response(
    {
        "space": "spaces/AAA",
        "thread": "spaces/AAA/threads/T1",
        "placeholderConfigJson": json.dumps(
            {
                "texts": [
                    "Thinking...",
                    "Checking the thread...",
                    "Reviewing attachments...",
                ],
                "mode": "roundRobin",
                "cursor": 2,
            }
        ),
        "authMode": "app",
        "requestId": "req-agent-turn-123",
        "clientMessageId": "client-agent-turn-123",
        "correlationId": "event-123",
    }
)

created_message = {
    "name": "spaces/AAA/messages/placeholder",
    "thread": {"name": "spaces/AAA/threads/T1"},
    "createTime": "2026-07-04T00:00:00Z",
}

handle = hydrate_placeholder_response_handle(
    placeholder_plan["placeholder"]["handle"],
    created_message,
)

complete_plan = plan_complete_placeholder_response(
    {
        "handle": handle,
        "text": "Final answer with sources.",
    }
)
```

## Verification

Local coverage:

```bash
corepack pnpm test:node -- packages/node/test/messages.test.ts
PYTHONPATH=packages/python/src python3 -m unittest packages.python.tests.test_messages
corepack pnpm conformance
```

Guarded visual smoke coverage:

```bash
RUN_LIVE_CHAT_VISUAL_SMOKE=1 pnpm live:chat-visual-smoke -- \
  --use-placeholder-response
```

The visual smoke creates a placeholder in the smoke thread, hydrates the handle
from the live Chat response, patches the same message to the final response, and
records redacted evidence for cleanup.
