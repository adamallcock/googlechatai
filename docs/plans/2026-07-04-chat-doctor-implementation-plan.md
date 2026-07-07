---
title: Chat Doctor Implementation Plan
date: 2026-07-04
type: plan
status: implemented-slice
---

# Chat Doctor Implementation Plan

## Status

Implemented slice:

- Public `corepack pnpm chat:doctor -- --dry-run` command.
- Dry-run check plan for setup, endpoint, auth, smoke metadata, log, and
  interaction diagnostics.
- Guarded live command coordinator with redacted evidence.
- Tool tests for dry-run, live guard, failure remediation, summary rendering,
  and evidence writing.
- Public guide and docs index routing.

Planned follow-ups:

- Deeper Chrome-assisted setup checklist for console-only Marketplace fields.
- Browser/Chat UI screenshot collection, which belongs in F8 evidence tooling.
- Generated capability/error records, which belong in F2.

## Problem

Google Chat app failures are opaque. Developers see symptoms such as "unable to
process your request", missing card-click events, app-auth 403/404 responses, or
late interaction responses, but the evidence is split across Cloud project
state, Cloud Run health, app/user auth, smoke metadata, direct webhook behavior,
and Cloud Logging.

The repository already has strong private smoke tools:

- `tools/cloud/doctor.mjs`
- `tools/cloud/health-smoke.mjs`
- `tools/chat/app-auth-smoke.mjs`
- `tools/chat/user-auth-smoke.mjs`
- `tools/live-smoke/chat-log-smoke.mjs`
- `tools/live-smoke/chat-card-action-webhook-smoke.mjs`
- `tools/live-smoke/chat-inbound-smoke.mjs`

The missing product surface is one public, developer-facing doctor that
coordinates these checks and turns failure states into remediation.

## User Stories

- As a new Google Chat app developer, I can run one command to see which setup
  layer is broken.
- As an AI agent developer, I can dry-run the doctor without touching
  credentials or the network.
- As a maintainer, I can run a guarded live doctor and get redacted evidence
  suitable for local debugging or an admin handoff.
- As a future CLI author, I can reuse stable check result objects instead of
  parsing ad hoc smoke output.

## Non-Goals

- Do not replace the deeper private live smoke tools.
- Do not send Chat messages, DM users, invite users, or mutate non-smoke
  spaces.
- Do not use domain-wide delegation.
- Do not collect screenshots in this slice.
- Do not infer Marketplace console-only configuration beyond what the current
  APIs and local config can prove.

## Public Surface

Commands:

```bash
corepack pnpm chat:doctor -- --dry-run
corepack pnpm chat:doctor -- --format json
corepack pnpm chat:doctor interactions -- --dry-run
RUN_LIVE_CHAT_DOCTOR=1 corepack pnpm chat:doctor -- --since 10m --evidence fixtures/live/evidence/chat-doctor.local.json
```

Output model:

```json
{
  "ok": true,
  "mode": "dry-run",
  "scope": "all",
  "runId": "chat-doctor-...",
  "summary": ["..."],
  "checks": [
    {
      "id": "endpoint.health",
      "status": "planned",
      "severity": "info",
      "summary": "Plan /api/healthz reachability check.",
      "principal": "none",
      "readOnly": true,
      "live": false,
      "redacted": true,
      "evidence": {},
      "remediation": null
    }
  ],
  "privacy": {
    "rawTokensSaved": false,
    "rawMessageTextSaved": false,
    "rawWebhookUrlSaved": false,
    "rawPrivatePayloadsSaved": false
  }
}
```

## Check Groups

Setup and Cloud:

- `setup.cloudProjectApis`: wraps `cloud:doctor`.
- `setup.smokeMetadata`: checks the configured smoke metadata path.
- `endpoint.health`: wraps `cloud:health-smoke`.
- `endpoint.chatEvents`: wraps direct webhook interaction checks.
- `cloudRun.revision`: uses health-smoke revision evidence.

Auth:

- `auth.app`: wraps `chat:app-auth-smoke`.
- `auth.user`: wraps `chat:user-auth-smoke`.

Logs and interactions:

- `logs.recent`: wraps `live:chat-log-smoke`.
- `interactions.addOnEnvelope`: wraps card-action webhook smoke.
- `interactions.directEnvelope`: planned direct Chat fixture replay hook. This
  remains scaffolded in the first slice because existing live direct-event
  proof comes from Chat UI inbound smoke rather than a direct synthetic POST
  tool.

## Auth, Principal, And Safety Model

- Dry-run mode is pure planning and must not read credentials or call the
  network.
- Live mode requires `RUN_LIVE_CHAT_DOCTOR=1`.
- `cloud:doctor`, `cloud:health-smoke`, log reads, app-auth list, and user-auth
  list are read-only diagnostics.
- Card-action webhook smoke posts synthetic payloads directly to Cloud Run. It
  does not send Chat messages, DM users, or invite users.
- User auth remains installed-user/user-authorized. The doctor must never
  suggest domain-wide delegation as the default fix.

## Error Model

Each failed check should map to one of:

- `endpoint_unreachable`
- `no_request_received`
- `invalid_response_envelope`
- `late_response`
- `app_not_configured`
- `app_not_installed`
- `wrong_principal`
- `auth_required`
- `missing_scope`
- `missing_smoke_metadata`
- `cloud_project_incomplete`
- `logs_unavailable`
- `retryable_transient`
- `unknown`

Every failure must include developer-facing remediation.

## Implementation Slices

Slice 1, implemented here:

- Add `tools/chat/doctor.mjs`.
- Add `chat:doctor` package script.
- Add result model helpers, dry-run planning, guarded live command execution,
  redaction-aware evidence writer, summary renderer, and failure remediation.
- Add tool tests.
- Add public guide and docs index links.

Slice 2, later:

- Add richer direct Chat HTTP replay once F8 fixture recorder can provide
  redacted fixtures.
- Add Chrome-assisted console checklist for OAuth/Marketplace fields.
- Feed F2 capability/error explainers into doctor remediation.

## Test Plan

Local tests:

- Dry-run returns planned checks without invoking command runners or filesystem
  readers.
- Live mode refuses without `RUN_LIVE_CHAT_DOCTOR=1`.
- Interaction scope includes add-on and direct-envelope checks.
- Child command failures are classified into useful remediation.
- Evidence output writes redacted JSON only when requested.
- Summary output is concise and includes failures.

Validation:

```bash
node --test tools/chat/doctor.test.mjs
corepack pnpm test:tools
corepack pnpm docs:check
corepack pnpm validate
corepack pnpm discovery:check
git diff --check
```

## Live Smoke Plan

Safe live command:

```bash
RUN_LIVE_CHAT_DOCTOR=1 corepack pnpm chat:doctor -- --since 10m --format json --evidence fixtures/live/evidence/chat-doctor.local.json
```

Expected live behavior:

- No Chat messages are sent.
- No users are contacted.
- App/user auth checks are read-only.
- Direct webhook interaction checks may POST synthetic events only to the
  configured Cloud Run webhook.
- Evidence file is ignored and redacted.

If any Google endpoint or tenant policy blocks a check, record the failed check
and remediation rather than widening permissions.

## Completion Conditions

- `chat:doctor` is the documented public entrypoint for setup/interaction
  diagnosis.
- Dry-run is side-effect free and test-proven.
- Live mode is guarded and redacted.
- Failure output explains the probable broken layer and next action.
- The feature has focused tests, docs, and a commit.
