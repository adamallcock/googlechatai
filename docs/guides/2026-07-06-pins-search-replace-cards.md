---
title: Pins, Search, And Replace Cards
date: 2026-07-06
type: guide
status: implemented
---

# Pins, Search, And Replace Cards

Three planner families target Google Chat API surfaces that appear in
Google's documentation but that this SDK has not yet exercised against a live
Chat API call: pinning/unpinning messages, searching messages in a space, and
replacing a message's cards. Every plan these planners return carries an
explicit "docs-listed" warning so callers know to verify live behavior before
depending on it in production.

## Node

```ts
import {
  planPinMessage,
  planUnpinMessage,
  planListMessagePins,
  planEnsureMessagePinned,
  planSearchMessages,
  planReplaceCards,
} from "googlechatai";

const pinPlan = planPinMessage({
  space: "spaces/AAA",
  message: "spaces/AAA/messages/BBB",
  authMode: "app",
});
console.log(pinPlan.warnings);
// ["spaces.messagePins.* is a docs-listed surface; verify live support before relying on it."]

const searchPlan = planSearchMessages({
  space: "spaces/AAA",
  query: "from:ada@example.com attachment:drive",
});

const replaceCardsPlan = planReplaceCards({
  message: "spaces/AAA/messages/BBB",
  cardsV2: [{ cardId: "summary", card: { sections: [] } }],
});
```

## Python

```python
from googlechatai import (
    plan_pin_message,
    plan_unpin_message,
    plan_list_message_pins,
    plan_ensure_message_pinned,
    plan_search_messages,
    plan_replace_cards,
)

pin_plan = plan_pin_message({
    "space": "spaces/AAA",
    "message": "spaces/AAA/messages/BBB",
    "authMode": "app",
})
print(pin_plan["warnings"])

search_plan = plan_search_messages({
    "space": "spaces/AAA",
    "query": "from:ada@example.com attachment:drive",
})

replace_cards_plan = plan_replace_cards({
    "message": "spaces/AAA/messages/BBB",
    "cardsV2": [{"cardId": "summary", "card": {"sections": []}}],
})
```

## Pin Planners

Four planners target the `spaces.messagePins` sub-resource:

- **`planPinMessage` / `plan_pin_message`** — one request,
  `POST spaces.messagePins.create` at `/v1/{space}/messagePins`.
- **`planUnpinMessage` / `plan_unpin_message`** — two shapes depending on
  input: pass `messagePin` (the full pin resource name) for a single
  `DELETE spaces.messagePins.delete`; pass `space` and `message` instead for a
  two-step list-then-delete plan (`GET spaces.messagePins.list` then
  `DELETE` against the placeholder path `/v1/{resolvedMessagePin}`, since the
  pin's own resource name isn't derivable from the message name alone).
- **`planListMessagePins` / `plan_list_message_pins`** — one request,
  `GET spaces.messagePins.list`, page size clamped between 1 and 1000
  (default 100).
- **`planEnsureMessagePinned` / `plan_ensure_message_pinned`** — a
  list-then-pin plan that skips pinning if the message is already pinned.

Every pin plan requires the
`https://www.googleapis.com/auth/chat.messages` scope and carries the warning
`spaces.messagePins.* is a docs-listed surface; verify live support before
relying on it.`.

## Search And Replace Cards Planners

- **`planSearchMessages` / `plan_search_messages`** — one request,
  `GET spaces.messages.search` at `/v1/{space}/messages:search`, with
  `query` required, `pageSize` clamped between 1 and 1000 (default 25), and
  optional `pageToken`/`orderBy`. Carries the warning
  `spaces.messages.search is a docs-listed surface; verify live support
  before relying on it.`.
- **`planReplaceCards` / `plan_replace_cards`** — one request,
  `POST spaces.messages.replaceCards` at `/v1/{message}:replaceCards`, with
  `cardsV2` required to be a non-empty array. Carries the warning
  `spaces.messages.replaceCards is a docs-listed surface; verify live
  support before relying on it.`.

Both planners require the standard
`https://www.googleapis.com/auth/chat.bot` scope, unlike the pin planners'
dedicated pin scope.

## The "Docs-Listed" Warning Is Advisory, Not A Gate

The warning lives purely in the plan's `warnings` array — there is no
separate `docsListed` boolean or execution-blocking field anywhere in the
code. `executeChatPlan` / `execute_chat_plan` never inspects warning text; it
threads `plan.warnings` straight through into the execution report's own
`warnings` array. Concretely, this means pin/search/replaceCards plans are
**not** blocked from live execution: they carry `capability.ok: true` and
`safety.directMessage: false` like any other plan, so passing `mode: "live"`
with valid auth would send the real HTTP request. The warning exists to tell
you, the caller, to verify Google's actual behavior for these particular
methods before relying on them in production — it is not a safety net that
stops you from trying.

## Production Boundary

Implemented:

- Node/Python planner parity for all four pin operations, message search, and
  replace-cards, each dry-run by default and directly executable through
  `executeChatPlan` / `execute_chat_plan` exactly like any other plan (see
  [Plan Execution](2026-07-06-plan-execution.md)).
- Shared conformance for every planner's dry-run shape
  (`conformance/cases/pins.call-plans.json`,
  `conformance/cases/messages.extras.json`).
- The docs-listed warning attached to every plan these six planners produce.

Blocked:

- Live verification against the real Google Chat API for
  `spaces.messagePins.*`, `spaces.messages.search`, and
  `spaces.messages.replaceCards` has not been performed. Treat these planners
  as implemented-and-conformance-tested, not production-proven, until a
  guarded live smoke run (see
  [Live Chat Smoke Harness](../runbooks/2026-06-29-live-chat-smoke-harness.md))
  confirms Google's actual request/response shapes match what these planners
  assume.
