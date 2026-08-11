---
title: Pins, Search, And Replace Cards
date: 2026-07-06
last_updated: 2026-08-10
type: guide
status: implemented
---

# Pins, Search, And Replace Cards

This guide covers three Google Chat API families with different maturity
levels. Message search now appears in the live discovery document as a Google
Workspace Developer Preview method. Message pins and `replaceCards` remain
docs-listed surfaces that require separate live verification. Every plan is a
dry run by default and preserves the relevant maturity warning.

## Node

```ts
import {
  planPinMessage,
  planUnpinMessage,
  planListMessagePins,
  planEnsureMessagePinned,
  buildSearchMessagesContext,
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
  filters: {
    text: "roadmap review",
    spaces: ["spaces/AAA"],
    senders: ["users/123"],
    unread: true,
    hasAttachments: true,
  },
  pageSize: 25,
  view: "SEARCH_MESSAGES_VIEW_FULL",
});

// After executing the plan, normalize the raw API response into bounded,
// provenance-rich context. Raw payloads are omitted and emails redacted.
const searchContext = buildSearchMessagesContext(rawSearchResponse, {
  maxResults: 25,
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
    build_search_messages_context,
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
    "filters": {
        "text": "roadmap review",
        "spaces": ["spaces/AAA"],
        "senders": ["users/123"],
        "unread": True,
        "hasAttachments": True,
    },
    "pageSize": 25,
    "view": "SEARCH_MESSAGES_VIEW_FULL",
})

search_context = build_search_messages_context(raw_search_response, max_results=25)

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

## Message Search

- **`planSearchMessages` / `plan_search_messages`** emits one user-authorized
  `POST spaces.messages.search` request at `/v1/spaces/-/messages:search`.
  `pageSize` is clamped between 1 and 100 (default 25); `pageToken`,
  `orderBy` (`create_time desc` or `relevance desc`), and BASIC/FULL `view`
  are optional.
- `filter` accepts Google's raw filter syntax. The old `query` name remains a
  compatibility alias and adds a warning.
- `filters` safely composes common intent fields: text, spaces, senders, time
  range, unread status, attachments, mentions, and links. The legacy `space`
  shortcut becomes a `space.name` filter because Google requires the request
  parent to be `spaces/-`.
- BASIC view requires `chat.messages.readonly`. FULL view also reports the
  read-state and space-settings scopes needed for `read` and
  `spaceMuteSetting` metadata. BASIC searches using `is_unread()` or
  `space.display_name` also report the additional read-state or space-read
  scope required by Google's filter contract.
- `normalizeSearchMessagesResponse` / `normalize_search_messages_response`
  preserves normalized messages plus read/mute metadata and provenance. Raw
  result objects are retained only with explicit opt-in.
- `buildSearchMessagesContext` / `build_search_messages_context` adds a local
  result bound, untrusted-content notes, default email redaction, and each
  message's `plainTextForModel` representation.

Message search remains experimental while Google labels it Developer Preview.
The plan warns about tenant enrollment, availability, and the privacy impact of
reading user-visible conversations.

## Replace Cards Planner

- **`planReplaceCards` / `plan_replace_cards`** — one request,
  `POST spaces.messages.replaceCards` at `/v1/{message}:replaceCards`, with
  `cardsV2` required to be a non-empty array. Carries the warning
  `spaces.messages.replaceCards is a docs-listed surface; verify live
  support before relying on it.`.

`replaceCards` requires the standard `chat.bot` scope. Message search is
user-auth only; explicitly selecting app auth returns `capability.ok: false`.

## Warning And Capability Boundaries

Warnings remain advisory and flow into execution reports. Capability checks
are structural: message search fails capability planning for app auth, while a
user-auth plan reports its exact scopes. Live execution still requires the
normal executor opt-in and credentials. Applications must add their own
consent, retention, DLP, and model-data policy before using search results.

## Production Boundary

Implemented:

- Node/Python planner parity for all four pin operations, message search, and
  replace-cards, each dry-run by default and directly executable through
  `executeChatPlan` / `execute_chat_plan` exactly like any other plan (see
  [Plan Execution](2026-07-06-plan-execution.md)).
- Shared conformance for every planner's dry-run shape
  (`conformance/cases/pins.call-plans.json`,
  `conformance/cases/messages.extras.json`).
- Developer Preview search normalization/context fixtures and the guarded,
  read-only dedicated-space smoke request.
- Maturity and privacy warnings attached to every applicable plan.

Blocked:

- Pins and `replaceCards` remain separately unverified. Message search passed a
  guarded, read-only dedicated-space smoke on 2026-08-10 with HTTP 200, user
  OAuth, BASIC view, and a next-page token. This confirms the current request
  and response shape but does not remove Google's Developer Preview stability
  boundary (see
  [Live Chat Smoke Harness](../runbooks/2026-06-29-live-chat-smoke-harness.md)).
