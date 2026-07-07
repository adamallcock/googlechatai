---
title: Plan Execution
date: 2026-07-06
type: guide
status: implemented
---

# Plan Execution

Every planner in this SDK (`planSendToSpace`, `planReplyInThread`,
`planStreamMessage`, `planPinMessage`, `planSearchMessages`, and friends)
returns a dry-run `chat.call_plan` object: a description of the Google Chat
API calls that *would* run, never an actual network request. `executeChatPlan`
/ `execute_chat_plan` is the single generic executor that turns any of those
plans into real API calls, or replays them safely in dry-run mode for tests
and previews.

The executor does not know or care which planner produced the plan. It only
understands the shared `chat.call_plan` envelope (`kind`, `operation`,
`capability`, `requests[]`, `idempotency`, `safety`, `warnings`), so it works
identically for message sends, thread replies, streaming patches, pin/unpin
operations, and the docs-listed search/replaceCards planners.

## Node

```ts
import { executeChatPlan, planSendToSpace } from "googlechatai";

const plan = planSendToSpace({
  space: "spaces/AAA",
  text: "Hello",
  requestId: "req-fixed",
  clientMessageId: "client-fixed",
});

const dryRun = await executeChatPlan(plan, { auth });
console.log(dryRun.mode); // "dryRun" (the default; no network call was made)

const live = await executeChatPlan(plan, {
  mode: "live",
  auth,
  fetch,
});
console.log(live.steps[0].status); // "executed"
console.log(live.createdMessages); // [{ name: "spaces/AAA/messages/..." }]
```

## Python

```python
from googlechatai import execute_chat_plan, plan_send_to_space

plan = plan_send_to_space({
    "space": "spaces/AAA",
    "text": "Hello",
    "requestId": "req-fixed",
    "clientMessageId": "client-fixed",
})

dry_run = execute_chat_plan(plan, auth=get_access_token, send=send)
print(dry_run["mode"])  # "dryRun"

live = execute_chat_plan(plan, mode="live", auth=get_access_token, send=send)
print(live["steps"][0]["status"])  # "executed"
print(live["createdMessages"])
```

## Dry-Run Default, Explicit Live

`mode` defaults to `"dryRun"`. Nothing is sent to Google unless the caller
passes `mode: "live"` (Node) / `mode="live"` (Python) explicitly. Any other
value raises a `TypeError` ("Expected mode to be either dryRun or live.").
Dry-run mode still resolves every step's `path`/`url` and reports step
`status: "planned"`, so it is useful for previewing exactly which HTTP calls a
plan would make before wiring up real auth or transport.

## Safety Gates

Before any request is sent, `executeChatPlan` computes an optional `blocked`
result, in this order:

1. **Capability** — if `plan.capability.ok === false` (for example
   `planSendToUser`'s direct-message capability is `false` by policy), the
   plan is blocked with `reason: "capability"` unless the caller passes
   `overrideCapability: true`.
2. **Direct-message policy** — if `plan.safety.directMessage === true`, the
   plan is blocked with `reason: "direct_message_policy"` unless the caller
   passes `allowDirectMessages: true`.
3. **Missing auth** (live mode only) — if no token source resolves for the
   plan's `authMode`, the plan is blocked with `reason: "missing_auth"`.

In dry-run mode, a blocked plan still reports every step as `"planned"` (so
you can see what it would have done) and `execution.ok` is `false`. In live
mode, a blocked plan skips every step immediately (`status: "skipped"`,
`skippedReason: "blocked_${reason}"`) without any network call. Both
`overrideCapability` and `allowDirectMessages` must be set to actually execute
a direct-message plan live — this mirrors the "do not DM anyone" live boundary
in `AGENTS.md`, so opting in requires two explicit flags, not one.

## Auth By Plan `authMode`

Each plan carries its own `capability.authMode` (`"app"` or `"user"`).
`executeChatPlan` reads that value from the plan, not from the caller's
options, and picks the matching token source:

```ts
// Node: either a single source used for whichever authMode the plan needs...
await executeChatPlan(plan, { auth: { getAccessToken } });
// ...or an explicit map for plans that mix app/user auth.
await executeChatPlan(plan, { auth: { app: appSource, user: userSource } });
```

```python
# Python: a bare callable, an object exposing get_access_token, or a mapping
# with "app"/"user" keys.
execute_chat_plan(plan, auth=get_access_token, send=send)
execute_chat_plan(plan, auth={"app": app_source, "user": user_source}, send=send)
```

Node injects a real transport client by passing `fetch` (a
`(url, init) => Promise<Response>`-shaped function); Python injects it by
passing `send` (a callable that takes a request dict and returns
`{ok, status, headers, json}`). Both are optional — omit them in dry-run mode
since no network call happens.

## Retry And Refresh Via The Shared Transport Client

`executeChatPlan` does not reimplement retry or token-refresh logic. It builds
a `RetryingChatClient` from the shared transport module
(`packages/node/src/transport/index.ts`, `packages/python/src/googlechatai/transport`)
and sends every live request through it. That client already handles:

- 401 responses by calling `getAccessToken({ forceRefresh: true })` and
  retrying once.
- Retryable statuses (408/429/500/502/503/504) and network errors with
  backoff delays, honoring `Retry-After`.
- Replay-safety gating — `GET`/`DELETE`/`PATCH`/`PUT` requests, or any request
  carrying a `requestId`, are treated as idempotent and eligible for retry;
  other non-idempotent requests fail fast instead of being retried blind.

Pass `retryPolicy` (`maxAttempts`, `baseDelayMs`, `maxDelayMs`) to override the
defaults, and `sleepMs` (Node) / `sleep` (Python) to inject a fake delay
function in tests.

## RequestId Idempotency-Store Dedupe

Separately from the transport client's own retry-safety logic,
`executeChatPlan` can dedupe an entire step by its plan-level `requestId`. If
a step's `query.requestId` is present and an `idempotencyStore` is supplied,
the executor calls `idempotencyStore.claim({ key: "chat-plan-request:<id>" })`
before sending. A duplicate claim marks the step `status: "skipped"`,
`skippedReason: "duplicate_request_id"`, and appends a warning — the request
is never sent twice, even across separate `executeChatPlan` calls that share
the same store (for example, a retried Cloud Run request for an event that was
already processed).

## Placeholder Resolution

Some plans have multi-step requests where a later request's `path` references
a value that is only known after an earlier request's response comes back —
for example `planSendToUser`'s second request path is literally
`/v1/{resolvedDirectMessageSpace}/messages`, and `planUnpinMessage`'s
list-then-delete path is `/v1/{resolvedMessagePin}`.

`executeChatPlan` resolves `{name}` tokens in a step's path by checking, in
order: an already-resolved value (seeded from `placeholderValues` or cached
from an earlier step), then a resolver function. Two resolvers are built in
(`DEFAULT_PLACEHOLDER_RESOLVERS`):

- `resolvedDirectMessageSpace` — scans prior responses in reverse for the most
  recent object whose `name` starts with `spaces/`.
- `resolvedMessagePin` — reads the plan's target message name and scans prior
  responses in reverse for a matching `messagePins[]` entry's `name`.

Supply `placeholderResolvers` to add or override resolvers by name, or supply
`placeholderValues` as a flat seed map when you already know a value and don't
need a resolver function at all:

```ts
await executeChatPlan(unpinPlan, {
  mode: "live",
  auth,
  fetch,
  placeholderValues: { resolvedMessagePin: "spaces/AAA/messagePins/CCC" },
});
```

If a live-mode step's placeholder can't be resolved, the plan fails with an
unresolved-placeholder error and halts; in dry-run mode the step is marked
`skippedReason: "unresolved_placeholder"` instead, non-fatally.

## Placeholder-Patch Fallback

A plan built with `onPatchFailure: "createNewMessage"` (for example
`planCompletePlaceholderResponse`) carries a `plan.placeholder.fallback` block
describing a full create-message request to run if the primary `PATCH` fails.
When a `PATCH` step fails and that fallback is present, `executeChatPlan`
automatically sends the fallback request instead of halting the plan:

```ts
const plan = planCompletePlaceholderResponse({
  handle,
  text: "final answer",
  onPatchFailure: "createNewMessage",
  fallbackRequestId: "req-fallback",
  fallbackClientMessageId: "client-fallback",
});

const execution = await executeChatPlan(plan, { mode: "live", auth, fetch });
// If the PATCH returned 404 (placeholder message gone), execution.ok is
// still true, execution.steps[0].status is "failed", and
// execution.steps[0].fallback.status is "executed" with a fresh message in
// execution.createdMessages.
```

This is how a stream or async response handler recovers from a deleted or
inaccessible placeholder message without losing the final answer — instead of
throwing, it posts a new message and records the substitution on the step.

## Execution Report Shape

`executeChatPlan` / `execute_chat_plan` returns a `chat.plan_execution`
report:

- `operation` / `planKind` — copied from the plan's own `operation` and
  `kind`.
- `mode` — `"dryRun"` or `"live"`, echoing the effective mode.
- `ok` — `true` only if the plan was not blocked and no step failed
  unrecoverably.
- `authMode` — resolved from `plan.capability.authMode` (defaults to `"app"`).
- `blocked` — `{ reason, details }` or `null` (see Safety Gates above).
- `steps[]` — one entry per planned request, each with `index`, `resource`,
  `method`, `path`, `url`, `query`, `status`
  (`planned | executed | skipped | failed | not_reached`), `httpStatus`,
  `attempts`, `throttleAppliedMs`, `response`, `error`, `skippedReason`, and a
  nested `fallback` step when the patch fallback engaged.
- `resolvedPlaceholders` — every placeholder name resolved during the run.
- `createdMessages` — the raw response body of every successful
  `spaces.messages.create` step (including a successful fallback create).
- `warnings` — the plan's own warnings plus any runtime warnings (for example
  duplicate-request-id skip notices).

## Production Boundary

Implemented:

- Node/Python `executeChatPlan` / `execute_chat_plan` parity, generic over
  every planner's `chat.call_plan` shape.
- Dry-run default with explicit `mode: "live"` opt-in.
- Capability, direct-message, and missing-auth safety gates.
- Shared transport client reuse for retry/backoff/refresh.
- RequestId idempotency-store dedupe.
- Built-in and custom placeholder resolution, plus a `placeholderValues` seed.
- Placeholder-patch-to-new-message fallback.
- Shared conformance for dry-run execution shapes
  (`conformance/cases/execute.dry-run.json`).

The live-smoke boundary in `AGENTS.md` still applies: live-mode execution
against real Google Chat spaces must go through the guarded live-smoke harness
described in
[Live Chat Smoke Harness](../runbooks/2026-06-29-live-chat-smoke-harness.md),
never a default chatbot code path.
