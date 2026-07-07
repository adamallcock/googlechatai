---
title: Live Smoke Safety
date: 2026-06-29
type: guide
status: draft
---

# Live Smoke Safety

This guide defines the boundary for live Google Chat smoke tests. W12 does not
require live Google calls.

## Status

- Implemented: local cloud and chat smoke scripts exist.
- Implemented: the Cloud Run webhook example under `examples/cloud-run-node`
  exposes `/api/healthz`, `/api/avatar.png`, and `/api/chat/events`.
- Implemented: `corepack pnpm chat:app-auth-smoke` can list app-visible spaces
  without sending messages.
- Implemented: `corepack pnpm chat:user-auth-smoke` plans per-user OAuth live
  checks and can create a dedicated smoke space after a test user authorizes the
  requested Chat scopes.
- Verified in the current private live test tenant: user OAuth, a dedicated
  smoke space, Chat app installation, guarded bot-owned message lifecycle,
  media download, reactions, Drive export, context reads, and cleanup evidence.
  New workspaces still need manual OAuth and app-registration setup.

## Hard Safety Rules

- Do not DM anyone.
- Do not invite real users into test spaces.
- Do not send messages to existing user or team spaces.
- Do not use a production or team space as a smoke-test target.
- Do not paste or print service-account JSON, OAuth tokens, private keys, or
  access tokens.
- Do not use domain-wide delegation for the default chatbot smoke path.

## Allowed Live Surfaces

For agents explicitly working on W0 or W7:

- `corepack pnpm cloud:doctor`
- `corepack pnpm cloud:pubsub-smoke`
- `corepack pnpm chat:app-auth-smoke` when `.env.local` is present and the
  runbook has been read
- `corepack pnpm chat:user-auth-smoke -- --dry-run --create-test-space`
- `corepack pnpm chat:user-auth-smoke -- --authorize --create-test-space` only
  when the OAuth client path points outside the repo and the installing account
  is the safe test user.
- One user-created named test space only when required, with a name beginning:

  ```text
  Google Chat AI SDK Smoke
  ```

- Guarded live smoke commands documented in
  `docs/runbooks/2026-06-29-live-chat-smoke-harness.md`, after the target smoke
  space and metadata have been verified.

For W12 and docs-only work, prefer local-only validation:

```bash
corepack pnpm test
corepack pnpm build
corepack pnpm discovery:check
```

## Before Any Live Chat Action

Confirm all of the following:

- The current workstream owns the live-test path.
- `.env.local` exists locally and is ignored by git.
- Credentials point outside the repository.
- The Cloud Run `/healthz` endpoint returns service JSON.
- The Chat app is visibility-restricted to the test account or explicit safe
  test users.
- The test user has installed or can install the Chat app.
- User OAuth token storage is under ignored `.tokens/` or another ignored,
  local-only secret store.
- The target space is named `Google Chat AI SDK Smoke ...`.
- The Chat app is installed in the target smoke space before bot-message tests.
- The action does not DM a user or invite a real user.
- The command will not send content into an existing team space.

## Current Expected Blockers

The current runbooks record these live blockers and gates:

- App-auth smoke-space creation is not the product happy path and can fail with
  Workspace admin authorization errors.
- Direct `spaces.spaceEvents.list` remains blocked in the private live test
  tenant's Cloud project after repeated Google API `500 INTERNAL` responses.
- Optional real transcription providers, richer parser packages, identity
  enrichment, and production external idempotency stores need separate guarded
  harnesses or product decisions.
- For new workspaces, per-user OAuth setup is still manual: create an OAuth
  client, store it outside the repo, authorize the safe test user, create a
  smoke space with `corepack pnpm chat:user-auth-smoke -- --create-test-space`,
  then add the Chat app to that space.

## Handoff Requirements For Live Work

Any live-test handoff must include:

- Exact commands run.
- Exact pass/fail outcomes.
- Whether any resources were created or changed.
- The names of any smoke spaces created.
- Confirmation that no DMs were sent.
- Confirmation that no real users were invited.
- Confirmation that no messages were sent to existing user or team spaces.
- A link to the current private live QA ledger (kept outside the public
  repository) when the work updates live state.
