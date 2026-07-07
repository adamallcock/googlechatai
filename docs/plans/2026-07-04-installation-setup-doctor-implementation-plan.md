---
title: Installation Setup Doctor Implementation Plan
date: 2026-07-04
type: plan
status: implemented-slice
---

# Installation Setup Doctor Implementation Plan

## Status

Implemented before this slice:

- `chat:doctor` setup/interactions scopes with dry-run and guarded live modes.
- `cloud:bootstrap`, `cloud:doctor`, and `cloud:health-smoke`.
- App-auth, user-auth, smoke metadata, endpoint, and log-correlation checks.
- Private setup runbooks for the current private live test tenant.

Implemented in this F7 slice:

- A structured setup bundle report attached to `chat:doctor setup` and optional
  `chat:doctor -- --setup-bundle` runs.
- Redacted project, Cloud Run, OAuth, Marketplace, Chat app, smoke-space, and
  admin-action summaries.
- Tool tests proving setup-bundle dry-run has no file/network side effects and
  live failures become an admin-shareable blocked checklist.

Planned follow-ups:

- Browser-assisted operator checklist for console-only Marketplace/OAuth fields.
- Direct Chat app resource inspection if Google exposes stable read APIs for the
  configured app.
- Public setup wizard once package names and release posture are decided.

## Problem

Google Chat app installation remains fragile because developers must align
Cloud project setup, OAuth consent/branding, Marketplace/internal visibility,
Chat API app configuration, Cloud Run endpoint routes, service accounts, user
OAuth tokens, app-auth visibility, smoke-space membership, and local metadata.
Many of these failures look identical in Chat: the app simply cannot respond or
cannot be found.

F1 added a public doctor. F7 turns the setup subset into a reusable
operator/admin packet: a redacted report that says what is configured, what is
missing, what requires admin action, and which checks prove each claim.

## Public Tooling

```bash
corepack pnpm chat:doctor -- setup --dry-run
corepack pnpm chat:doctor -- setup --format summary
corepack pnpm chat:doctor -- --setup-bundle --dry-run
```

`setup` scope includes the bundle by default. `--setup-bundle` can attach it to
the full doctor report.

## Bundle Contents

- Cloud project id, Cloud Run service, expected API check, billing/API note, and
  service-account-project-match note.
- Cloud Run endpoint route expectations: `/api/healthz`, `/api/avatar.png`, and
  `/api/chat/events`.
- OAuth client file/token-store expectations and user-installed trust model.
- Marketplace/internal app setup checklist and admin-approval note.
- Chat app smoke metadata, app-auth visibility, user-auth visibility, and
  smoke-space membership check references.
- Blocking/planned/passing check lists from the current doctor run.
- Admin-shareable action list.
- Privacy flags proving no tokens, raw URLs, sender emails, or private payloads
  are saved.

## Auth And Principal Model

- The default install path remains user-installed and user-authorized.
- Domain-wide delegation is explicitly marked false.
- App-auth checks prove the bot/app principal can see the smoke space where
  supported.
- User-auth checks prove the installing user can read/use the app surfaces.
- Admin actions are represented as approval/checklist items, not automatic
  permission widening.

## Live-Test Boundary

This slice adds no new live Google calls. It packages existing `chat:doctor`
setup check results. Live setup doctor runs remain guarded by
`RUN_LIVE_CHAT_DOCTOR=1`.

## Completion Criteria

- `chat:doctor setup --dry-run` includes a setup bundle and performs no file or
  command side effects.
- Failed setup checks appear in the bundle's blocking admin checklist.
- Evidence output remains redacted.
- Tool tests, docs checks, validate, discovery check, release check, and
  whitespace checks pass before commit.
