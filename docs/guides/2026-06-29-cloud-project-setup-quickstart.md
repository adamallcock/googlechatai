---
title: Cloud Project Setup Quickstart
date: 2026-06-29
type: guide
status: draft
---

# Cloud Project Setup Quickstart

This guide points contributors to the existing cloud scaffold and the safe
order for checking it. W12 does not require live Google calls.

## Status

- Scaffolded: project notes, local credential path, smoke-test scripts, and
  Cloud Run example are documented in
  [Google Cloud Project Setup](../runbooks/2026-06-29-google-cloud-project-setup.md).
- Implemented: `corepack pnpm cloud:doctor`,
  `corepack pnpm cloud:pubsub-smoke`, `corepack pnpm cloud:health-smoke`,
  `corepack pnpm workspace-events:pull-smoke`, and
  `corepack pnpm chat:app-auth-smoke` scripts exist.
- Implemented: `corepack pnpm chat:doctor -- --dry-run` is the public
  setup/endpoint/auth/interaction diagnostic entrypoint.
- Implemented: `corepack pnpm chat:user-auth-smoke` exists for per-user OAuth
  planning, consent, and dedicated smoke-space creation.
- Implemented: the Cloud Run `/api/healthz` endpoint returns service JSON and
  `/api/chat/events` is the configured webhook route.
- Implemented for the current private live test tenant: user-installed live
  smoke has OAuth, smoke-space metadata, app installation, and guarded message
  lifecycle evidence. New Google Workspace projects still need manual Chat app
  registration, OAuth client setup, and safe test-user consent.

## Safe Setup Order

1. Read the runbook:

   ```text
   docs/runbooks/2026-06-29-google-cloud-project-setup.md
   ```

2. Confirm `.env.local` exists locally before running cloud scripts. It must
   stay ignored by git.

3. Confirm the service-account key path in `.env.local` points outside the
   repository. Do not print, paste, or commit key contents.

4. Load local environment variables only in the shell that will run smoke tests:

   ```bash
   set -a
   source .env.local
   set +a
   ```

5. Start with non-Chat-send checks:

   ```bash
   corepack pnpm chat:doctor -- --dry-run
   corepack pnpm cloud:doctor
   corepack pnpm cloud:pubsub-smoke
   ```

6. Verify Cloud Run health before using the Chat endpoint:

   ```bash
   BASE_URL="$GOOGLE_CHAT_BASE_URL" corepack pnpm cloud:health-smoke
   ```

   Use `$BASE_URL/chat/events` for Chat configuration.

7. Use `corepack pnpm chat:app-auth-smoke` only as a bot/platform diagnostic.
   It is designed not to send messages, but it still uses live Google auth.

8. For a new workspace, use
   `corepack pnpm chat:user-auth-smoke -- --dry-run --create-test-space` to
   verify the planned per-user OAuth path before opening a consent browser flow.

## Safety Rules

- Do not DM anyone.
- Do not invite real users into test spaces.
- Do not send messages to existing user or team spaces.
- Live Chat tests must use named spaces beginning
  `Google Chat AI SDK Smoke`.
- Do not paste or print service-account JSON, OAuth tokens, private keys, or
  access tokens.
- Do not use domain-wide delegation for default chatbot smoke tests.

## Current Manual Gate

For a new workspace, Google Chat app registration/configuration, OAuth client
setup, and safe test-user consent are still manual Google Workspace steps.
`corepack pnpm chat:app-auth-smoke` can prove app-auth listing without sending
messages, but the dedicated smoke space should be created with per-user OAuth:

```bash
corepack pnpm chat:user-auth-smoke -- --authorize --create-test-space
corepack pnpm chat:user-auth-smoke -- \
  --create-test-space \
  --metadata-output fixtures/live/chat-smoke-space.local.json
```

After the space is created, add/install the Chat app into the smoke space before
running bot-message live smoke. The current private live test tenant setup and
live evidence are tracked in the private live project setup runbook and the
private live QA ledger (both kept outside the public repository).

## No-Live-Call Alternative

For docs, parser, fixture, and example work, run:

```bash
corepack pnpm test
corepack pnpm build
corepack pnpm discovery:check
```

Those commands validate the local scaffold without DMing anyone, creating
spaces, or sending live Chat messages.
