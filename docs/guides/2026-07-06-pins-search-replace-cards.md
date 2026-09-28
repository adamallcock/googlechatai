---
title: Pins, Search, And Replace Cards
date: 2026-07-06
last_updated: 2026-09-28
type: guide
status: implemented
---

# Pins, Search, And Replace Cards

This guide covers three Google Chat API families with different maturity
levels. Message search now appears in the live discovery document as a Google
Workspace Developer Preview method. Message pins are also a Google Workspace
Developer Preview surface in live discovery; `replaceCards` remains
docs-listed and requires separate live verification. Every plan is a dry run
by default and preserves the relevant maturity warning.

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
  authMode: "user",
});
console.log(pinPlan.warnings);
// ["Message pins are a Google Workspace Developer Preview, user-authorized surface."]

const searchPlan = planSearchMessages({
  filters: {
    text: "roadmap review",
    spaces: ["spaces/AAA"],
    senders: ["users/123"],
    unread: true,
    spaceTypes: ["SPACE", "GROUP_CHAT"],
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
    "authMode": "user",
})
print(pin_plan["warnings"])

search_plan = plan_search_messages({
    "filters": {
        "text": "roadmap review",
        "spaces": ["spaces/AAA"],
        "senders": ["users/123"],
        "unread": True,
        "spaceTypes": ["SPACE", "GROUP_CHAT"],
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
  `POST spaces.messagePins.create` at `/v1/{space}/messagePins`, with the
  flat `MessagePin` body `{ message: "spaces/{space}/messages/{message}" }`.
- **`planUnpinMessage` / `plan_unpin_message`** — one `DELETE
  spaces.messagePins.delete` request. Pass `messagePin` (the full pin resource
  name), or pass `space` and `message`; the latter derives
  `spaces/{space}/messagePins/{message}` because Google specifies that the pin
  resource ID matches the message resource ID.
- **`planListMessagePins` / `plan_list_message_pins`** — one request,
  `GET spaces.messagePins.list`, page size clamped between 1 and 100
  (default 100).
- **`planEnsureMessagePinned` / `plan_ensure_message_pinned`** — a
  full first-page list (`pageSize: 100`) followed by a conditional pin. The
  generic executor skips the `POST` if the message is already present; it fails
  closed rather than pinning if the list response has a `nextPageToken`.
  Consequently this planner rejects a `pageToken` or a page size other than
  100.

All pin planners require installed-user authentication. Create, delete, and
ensure use `https://www.googleapis.com/auth/chat.spaces.pins`; list uses the
narrower `https://www.googleapis.com/auth/chat.spaces.pins.readonly` scope.
Selecting app authentication leaves the dry-run request visible but sets
`capability.ok: false`; the SDK does not silently substitute a user token.
Each plan carries the warning `Message pins are a Google Workspace Developer
Preview, user-authorized surface.`.

## Message Search

- **`planSearchMessages` / `plan_search_messages`** emits one user-authorized
  `POST spaces.messages.search` request at `/v1/spaces/-/messages:search`.
  `pageSize` is clamped between 1 and 100 (default 25); `pageToken`,
  `orderBy` (`create_time desc` or `relevance desc`), and BASIC/FULL `view`
  are optional.
- `filter` accepts Google's raw filter syntax. The old `query` name remains a
  compatibility alias and adds a warning.
- `filters` safely composes common intent fields: text, spaces, space types,
  senders, time range, unread status, attachments, mentions, and links. Space
  types accept `DIRECT_MESSAGE`, `GROUP_CHAT`, and `SPACE`, with OR between
  multiple values. The legacy `space`
  shortcut becomes a `space.name` filter because Google requires the request
  parent to be `spaces/-`.
- BASIC view requires `chat.messages.readonly`. FULL view also reports the
  read-state and space-settings scopes needed for `read` and
  `spaceMuteSetting` metadata. BASIC searches using `is_unread()` or
  `space.display_name` or `space.space_type` also report the additional
  read-state or space-read scope required by Google's filter contract.
- `normalizeSearchMessagesResponse` / `normalize_search_messages_response`
  preserves normalized messages plus read/mute metadata and provenance. Raw
  result objects are retained only with explicit opt-in. Normalized identities
  preserve Chat-provided avatar URLs as optional structured metadata.
- `buildSearchMessagesContext` / `build_search_messages_context` adds a local
  result bound, untrusted-content notes, default email redaction, and each
  message's `plainTextForModel` representation. Avatar URLs are omitted from
  this model context even when email redaction is disabled.

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
are structural: message search and message pins fail capability planning for
app auth, while a user-auth plan reports its exact scopes. Live execution still
requires the normal executor opt-in and credentials. Applications must add
their own consent, retention, DLP, and model-data policy before using search
results.

## Production Boundary

Implemented:

- Node/Python planner parity for all four pin operations, message search, and
  replace-cards, each dry-run by default and directly executable through
  `executeChatPlan` / `execute_chat_plan` exactly like any other plan (see
  [Plan Execution](2026-07-06-plan-execution.md)).
- Pin execution tests for the safe branches: existing pin skips the create,
  absent pin creates it, and a paginated list fails before writing.
- Shared conformance for every planner's dry-run shape
  (`conformance/cases/pins.call-plans.json`,
  `conformance/cases/messages.extras.json`).
- Developer Preview search normalization/context fixtures and the guarded,
  read-only dedicated-space smoke request.
- Maturity and privacy warnings attached to every applicable plan.

Blocked:

- No message-pin write was sent from this repository for this upgrade. Pin
  create/delete remain Developer Preview and require an operator-approved,
  dedicated smoke-space run before any live-write claim. Message search passed
  a guarded, read-only dedicated-space smoke on 2026-08-10 with HTTP 200, user
  OAuth, BASIC view, and a next-page token. This confirms the current request
  and response shape but does not remove Google's Developer Preview stability
  boundary (see
  [Live Chat Smoke Harness](../runbooks/2026-06-29-live-chat-smoke-harness.md)).
