---
title: Chat Doctor
date: 2026-07-04
type: guide
status: implemented
---

# Chat Doctor

`chat:doctor` is the repository-maintainer diagnostic entrypoint for private
tenant setup, deployed endpoints, auth, interaction, and log-correlation
checks. Package users should start with the generic, dependency-free
`npx googlechatai@next doctor` workflow documented in
[Public CLI And First App](2026-07-16-public-cli-and-first-app.md).

Start with a side-effect-free plan:

```bash
corepack pnpm chat:doctor -- --dry-run
```

Dry-run mode does not read credentials, call Google APIs, post to Cloud Run, or
read local smoke metadata. It reports the checks a live doctor run would
perform.

## Live Read-Only Diagnosis

Live mode is guarded:

```bash
RUN_LIVE_CHAT_DOCTOR=1 corepack pnpm chat:doctor -- --format summary --since 10m
```

Live mode delegates to the existing smoke tools:

- `cloud:doctor` for enabled APIs and core resources.
- `cloud:health-smoke` for `/api/healthz` and Cloud Run revision evidence.
- `chat:app-auth-smoke` for app-auth visibility.
- `chat:user-auth-smoke` for installed-user auth visibility.
- `live:chat-log-smoke` for recent Cloud Logging correlation.
- `live:chat-card-action-webhook-smoke` for synthetic interaction replay.

The card-action webhook replay posts synthetic payloads directly to the Cloud
Run webhook. It does not send Chat messages, DM users, or invite users.

## Interaction Checks

To focus on Chat event handling and card-click response envelopes:

```bash
corepack pnpm chat:doctor interactions -- --dry-run
RUN_LIVE_CHAT_DOCTOR=1 corepack pnpm chat:doctor interactions -- --format json
```

The current interaction slice validates the deployed `/api/chat/events`
endpoint and Workspace add-on-shaped card action envelopes. Direct Chat HTTP
fixture replay is scaffolded for the future evidence recorder/replayer work.

## Setup Bundle

To focus on installation, OAuth, Marketplace, Cloud Run, and smoke-space
readiness:

```bash
corepack pnpm chat:doctor setup -- --dry-run
RUN_LIVE_CHAT_DOCTOR=1 corepack pnpm chat:doctor setup -- --format summary
```

`setup` scope automatically includes a redacted `setupBundle` in JSON evidence
and a setup-bundle status line in summary output. You can also attach the bundle
to a full doctor run:

```bash
corepack pnpm chat:doctor -- --setup-bundle --dry-run
```

The bundle is designed to be safe to share with a Workspace admin. It includes:

- Cloud project, enabled-API, billing, service-account, Cloud Run health, and
  revision check references.
- Expected endpoint routes: `/api/healthz`, `/api/avatar.png`, and
  `/api/chat/events`.
- OAuth client and user token-store path summaries without raw file contents or
  token values.
- Marketplace/internal listing, Chat API app configuration, app authorization,
  and admin-approval checklist items.
- Smoke metadata, app-auth visibility, user-auth visibility, and app membership
  check references.
- Blocking, planned, passing, and skipped diagnostic ids with admin actions.

The bundle preserves the installed-user trust model and explicitly marks
domain-wide delegation as disabled.

## Evidence

Write redacted JSON evidence to an ignored local path:

```bash
RUN_LIVE_CHAT_DOCTOR=1 corepack pnpm chat:doctor -- \
  --since 10m \
  --evidence fixtures/live/evidence/chat-doctor.local.json
```

Doctor evidence is designed for local debugging and admin handoff. It records
check ids, statuses, redacted child command summaries, remediation, and privacy
flags. It does not save raw tokens, raw message text, raw webhook URLs, raw
private payloads, or sender emails.

## Reading Failures

Common failure codes:

- `endpoint_unreachable`: verify the Cloud Run URL, public invoker setting,
  service revision, and `/api/healthz` route.
- `no_request_received`: verify the Chat app interaction endpoint URL and
  check Cloud Run request logs.
- `invalid_response_envelope`: verify whether the incoming payload expects a
  direct Chat message response or a Workspace add-on action response.
- `late_response`: keep synchronous interaction responses under Chat's deadline
  or use placeholder/edit-based async response helpers.
- `app_not_configured`: configure the Google Chat app for the same Cloud
  project.
- `app_not_installed`: install the app into the dedicated smoke space.
- `auth_required`: authorize the installing user with the required user scopes.

The default product path is installed-user and user-authorized. Do not switch to
domain-wide delegation as a generic fix.
