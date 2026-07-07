---
title: Capability And Error Explainers Implementation Plan
date: 2026-07-04
type: plan
status: implemented-slice
---

# Capability And Error Explainers Implementation Plan

## Status

Implemented slice:

- Current auth/principal/retry baseline inspected.
- First public API and conformance slice defined.
- Shared capability/error schema update.
- Node/Python `explainChatCapability`, `planChatPermission`, and
  `explainGoogleChatError` APIs.
- Conformance cases for common intents and Google API error responses.
- At least three existing diagnostic tool paths using the shared error
  explainer for remediation text.

Planned follow-ups:

- Add a generated table in docs from the curated intent records.
- Extend records as Google adds or changes Chat methods.
- Feed the same explainers into future card lint, media pipeline, Workspace
  Events setup doctor, and evidence bundle tooling.

## Problem

Google Chat developers repeatedly hit the same class of failures: a method
requires app auth instead of user auth, a user token is missing a scope, the app
is not installed in a space, an endpoint returns a transient 5xx, or the API
surface is unavailable in the current tenant. Today the SDK exposes capability
snippets inside individual planners, but there is no single public API that can
answer:

- Who does this action run as?
- Which scopes are required?
- Is admin approval or app installation required?
- Is the operation replay-safe?
- Is a failure retryable, auth-related, permission-related, or a Google-side
  transient?
- What should a developer do next?

## Current Repo Baseline

Relevant implemented pieces:

- [Auth Principal And Resilient Transport](../architecture/2026-06-30-auth-principal-resilience.md)
  defines the desired principal model, fallback posture, retry safety, and
  central transport boundary.
- [Production Auth, Retry, And Idempotency Adapters](../guides/2026-07-02-production-auth-retry-idempotency.md)
  documents central retry, user-token refresh, idempotency, optional Directory
  enrichment, and the installed-user default.
- [spec/capabilities.schema.json](../../spec/capabilities.schema.json)
  exists but is a small capability snapshot schema.
- [spec/errors.schema.json](../../spec/errors.schema.json)
  exists but does not yet define rich Chat remediation categories.
- [packages/node/src/messages/index.ts](../../packages/node/src/messages/index.ts)
  and [packages/python/src/googlechatai/messages/__init__.py](../../packages/python/src/googlechatai/messages/__init__.py)
  emit local `capability` objects for message call plans.
- [packages/node/src/reactions/index.ts](../../packages/node/src/reactions/index.ts)
  and [packages/python/src/googlechatai/reactions/__init__.py](../../packages/python/src/googlechatai/reactions/__init__.py)
  already model user-auth-only reaction capability failures.
- [tools/chat/doctor.mjs](../../tools/chat/doctor.mjs)
  now has a local failure classifier for endpoint, log, app-auth, user-auth,
  and interaction failures. F2 should replace or share this remediation logic.

## User Stories

- As a Node developer, I can call `explainChatCapability("messages.reply")`
  before attempting a live Chat write.
- As a Python developer, I can call `plan_chat_permission("reactions.add",
  {"principal": "app"})` and get an explicit user-auth requirement instead of a
  surprising 403.
- As a tool author, I can feed a Google HTTP error into
  `explainGoogleChatError` and display a clear remediation without duplicating
  status-code heuristics.
- As an AI agent, I can see whether a failure means "ask the user to authorize",
  "install the app in the space", "retry later", or "this endpoint is not
  available here".

## Public API

Node:

```ts
explainChatCapability(intentOrMethod, options?)
planChatPermission(intentOrMethod, options?)
explainGoogleChatError(error, context?)
```

Python:

```python
explain_chat_capability(intent_or_method, options=None)
plan_chat_permission(intent_or_method, options=None)
explain_google_chat_error(error, context=None)
```

Canonical capability result:

```json
{
  "kind": "chat.capability_explanation",
  "intent": "messages.reply",
  "googleMethod": "spaces.messages.create",
  "ok": true,
  "status": "available",
  "principal": "app",
  "supportedPrincipals": ["app"],
  "requiredScopes": ["https://www.googleapis.com/auth/chat.bot"],
  "adminApproval": "not_required",
  "membership": "app_must_be_member",
  "readWriteRisk": "write",
  "idempotency": "request_id_or_client_message_id_recommended",
  "retryPolicy": "retry_replay_safe_only",
  "liveSafe": false,
  "knownLimitations": [],
  "reasons": [],
  "remediation": []
}
```

Canonical error result:

```json
{
  "kind": "chat.error_explanation",
  "code": "insufficient_scopes",
  "category": "permission",
  "httpStatus": 403,
  "retryable": false,
  "principal": "user",
  "intent": "messages.read_context",
  "summary": "The user token is missing a required Chat scope.",
  "remediation": [
    "Re-run user OAuth consent with chat.messages.readonly.",
    "Keep this on the installed-user path; do not switch to domain-wide delegation by default."
  ],
  "debug": {
    "redacted": true
  }
}
```

## Intent Records For First Slice

Cover these high-value intents first:

- `messages.send`
- `messages.reply`
- `messages.edit_app_created`
- `messages.delete_app_created`
- `messages.read_context`
- `messages.stream_edit`
- `attachments.upload`
- `attachments.download`
- `reactions.add`
- `reactions.list`
- `reactions.delete`
- `memberships.list`
- `custom_emojis.list`
- `users.read_state`
- `users.notification_settings`
- `users.sections`
- `workspace_events.subscribe`
- `card_interactions.respond`

Records should include supported principal, scopes, membership requirement,
write risk, idempotency/retry posture, and known live blockers where this repo
has evidence.

## Error Taxonomy

First slice should classify:

- `400`: validation or invalid response envelope.
- `401`: expired token or auth required.
- `403`: insufficient scopes, app not installed, admin approval required,
  tenant policy block, or unsupported principal.
- `404`: app not configured, resource not found, unavailable preview endpoint,
  or wrong project/space.
- `409`: conflict/idempotency already claimed.
- `429`: rate limit, retryable with `Retry-After`.
- `500`, `502`, `503`, `504`: retryable Google transient unless known
  blocked endpoint evidence says otherwise.
- Network timeout/fetch failure: retryable when operation is replay-safe.

## Auth And Safety Model

- Default to installed-user/user-authorized flows for user-agency operations.
- App-auth writes remain app-owned and should not silently become user-auth
  writes.
- User-only operations must return `auth_required` or `unsupported_principal`
  when called with app auth.
- Admin or domain-wide delegation should appear only as explicit optional
  enterprise/admin lanes, never as the default remediation.
- Error explanations must preserve useful debug shape without raw tokens,
  emails, message text, request bodies, or webhook URLs.

## Conformance Plan

Add a new conformance case file:

```text
conformance/cases/capabilities.explain.json
```

Each case should contain:

- `id`
- `operation`: `explainCapability`, `planPermission`, or `explainError`
- `input`
- `expect.fixture`

Expected fixtures should live under:

```text
fixtures/expected/capabilities/
```

The conformance runner should execute Node and Python for every case.

## Tool Integration Slice

After the shared APIs pass conformance, update at least three diagnostic paths
to consume the explainer:

- `tools/chat/doctor.mjs` app-auth 403/404 classification.
- `tools/chat/doctor.mjs` user-auth missing token/scope classification.
- `tools/chat/doctor.mjs` endpoint/log/interaction failure classification.

If F2 grows beyond the current slice, the same API can later feed
`chat:card-lint`, media pipeline failures, Workspace Events setup doctor, and
evidence bundle remediation.

## Test Plan

Focused tests:

```bash
corepack pnpm conformance
corepack pnpm --filter googlechatai test -- capabilities
PYTHONPATH=packages/python/src python3 -m unittest packages.python.tests.test_capabilities
node --test tools/chat/doctor.test.mjs
```

Required gates before F2 commit:

```bash
corepack pnpm validate
corepack pnpm discovery:check
corepack pnpm release:check
git diff --check
```

## Live Test Boundary

No new live writes are required for F2. The capability/error API is local and
fixture-driven. Optional live confidence can reuse the F1 guarded doctor run;
no DMs, invites, or non-smoke mutations are permitted.

## Completion Conditions

- Node/Python public APIs exist and are exported.
- Shared conformance proves parity for capability and error outputs.
- At least three diagnostic tool failure paths use the shared explainer.
- Docs explain app-vs-user auth decisions and the installed-user default.
- All required validation gates pass.
- F2 has a logical commit.
