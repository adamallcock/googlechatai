---
title: W9 Message And Thread Semantics
date: 2026-06-29
type: architecture
status: draft
---

# W9 Message And Thread Semantics

W9 adds dry-run-only intent primitives for outbound Google Chat messaging and
conversation context readers. The implementation intentionally produces call
plans and deterministic AI-ready context objects; it does not execute Google
Chat API calls.

## Dry-Run Safety

All message operations return a `chat.call_plan` with `dryRun: true` and
`safety.liveAllowed: false`.

Direct-message operations are stricter:

- `messages.sendToUser` plans `spaces.findDirectMessage` plus
  `spaces.messages.create`, but its capability result is `ok: false`.
- `messages.findOrSetupDm` plans `spaces.findDirectMessage` plus
  `spaces.setup`, but its capability result is `ok: false`.
- No W9 primitive performs a live DM operation. Live direct-message support is
  explicitly out of scope for this workstream.

## Idempotency

Message creates include:

- `requestId` in the query string.
- `messageId` in the message body as the client message ID.

When callers do not provide IDs, the SDK generates lowercase slug IDs with
`req-` and `client-` prefixes. Tests use caller-supplied IDs for deterministic
golden output.

## Update Masks

Patch operations derive update masks from changed fields in this order:

1. `text`
2. `cardsV2`
3. `accessoryWidgets`

Additional fields, if later supported, are appended alphabetically after the
known Google Chat message-edit fields.

## Streaming

Streaming is represented as one `spaces.messages.create` followed by one or
more `spaces.messages.patch` requests with `updateMask: text`.

The throttle policy is deterministic:

- Non-final patch plans include `throttle.minDelayMs` equal to the configured
  `throttleMs`.
- The final patch includes `throttle.minDelayMs: 0` and `throttle.final: true`.
- W9 does not sleep or execute the plan; runtime adapters can consume this
  policy later.

## Reader Filters And Pagination

Thread and space readers plan `spaces.messages.list`.

Date range inputs are exclusive and map to:

- `createTime > "startTime"`
- `createTime < "endTime"`

Thread reads add:

- `thread.name = "spaces/.../threads/..."`

Ordering maps to `orderBy: createTime asc` or `createTime desc`. `pageSize` and
`pageToken` are passed through when provided. `limit` is applied while rendering
mocked pages into AI context.

## Partial, Truncated, And Inaccessible State

Rendered context marks:

- `partial: true` when more pages remain, the limit truncates results, or an
  API error prevented complete history access.
- `truncated: true` when the requested limit or next page cursor means the
  context is intentionally incomplete.
- `inaccessible: true` when a mocked API response contains an error.

AI-facing `systemNotes` explain the cursor, truncation, or access limitation in
plain text.

## AI Context Rendering

Every rendered message includes:

- Sender identity with display name, email when available, resource name, type,
  and access status.
- `createdAt`, `updatedAt`, and `deletedAt`.
- Relationship metadata for thread roots, thread replies, space messages, and
  quoted context.
- `plainTextForModel`.
- Plain-text system notes for sender/time, replies, quotes, attachments, cards,
  card actions, edits, deletions, and reactions.

Quoted messages are recursively included through `quotedMessages` using the
same message context shape as top-level messages. `maxQuoteDepth` limits nested
expansion, and a visited-message set emits a cycle note instead of recurring
forever.

## Current Assumptions

- W1's full conformance runner was not present at the scaffold baseline, so W9
  added provisional shared JSON cases under `conformance/cases/messages*.json`
  and wires `pnpm conformance` to the existing Node/Python tests that consume
  them.
- W3's final message AST was not present. W9 accepts Google Chat-like message
  objects plus provisional fixture fields such as `replyTo`, `quotedMessages`,
  `actionAnnotations`, and `emojiReactionSummaries`.
- W7 live smoke was not present. No live send, edit, delete, setup, or DM action
  was performed.
- No new runtime dependencies were added. The only package-manager change is
  explicit approval for the already locked `esbuild@0.27.7` build script needed
  by Vitest under pnpm 11.
