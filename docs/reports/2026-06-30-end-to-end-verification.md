---
title: End To End Verification
date: 2026-06-30
type: report
status: superseded
---

# End To End Verification

## Scope

This report verifies the current repository against the original Google Chat AI
SDK plan:

- Workstreams W0 through W13 in
  `docs/plans/2026-06-29-parallel-agent-workstreams.md`.
- Cross-cutting AI context, identity, auth-principal, retry, and live-safety
  requirements in `AGENTS.md`, `docs/specs/2026-06-29-googlechatai-sdk-feature-inventory.md`,
  and `docs/architecture/2026-06-30-auth-principal-resilience.md`.
- Implemented Node and Python package surfaces, shared schemas, fixtures,
  conformance cases, local examples, release tooling, and guarded live-safe
  smokes.

This is an acceptance and gap report, not a claim that every feature in the
feature inventory has already been built. Rows are marked:

- `Verified`: current evidence proves the implemented scope works.
- `Partial`: the repo implements and verifies a useful subset, but the original
  inventory includes broader work.
- `Blocked`: the code path exists, but live verification needs an external
  Google Workspace or Chat app state change.
- `Planned`: the feature inventory calls for it, but this repository does not
  yet implement it.

Update on 2026-07-01: the default live-test direction has shifted to
user-installed Chat apps with per-user OAuth. App-auth create-space failures
below remain useful historical evidence, but they are no longer the main
product unblock path. Create the dedicated smoke room with
`pnpm chat:user-auth-smoke`, add/install the Chat app into that room, then run
bot-owned message smoke without the legacy app-space lifecycle check.

Live update later on 2026-07-01: the private live test tenant's Cloud project
`example-chat-project` is no longer blocked for the dedicated smoke-room
path. Current live evidence for Cloud readiness, app/user auth, inbound mention
delivery, visual Cards V2, threads, edit-based streaming, cleanup, and Cloud
Run logs is tracked in the private live QA ledger (kept outside the public
repository).

Status note: the verification tables below are retained as the 2026-06-30
acceptance snapshot. When a row below conflicts with `README.md`, `docs/README.md`,
or the private live QA ledger (kept outside the public repository), treat the
newer current-state docs as canonical and this report row as historical
evidence.

Update on 2026-07-03: this report is now explicitly superseded by the private
live QA ledger (kept outside the public repository) for the current private
live test tenant's real project status. Since the 2026-06-30 snapshot, the
dedicated smoke room and app
installation were completed, the live write harnesses have exercised
message create/edit/delete, Cards V2, dialogs, thread replies, multi-reply
threads, edit-streaming up to 20 patches, reactions, memberships, custom emoji
reads, attachment metadata/downloads, Drive export/download variants, parser
package smokes, Firestore idempotency, Cloud Run idempotency monitoring, and
Cloud Logging sweeps. The remaining high-value live gaps are explicit external
gates: Workspace Events publisher principal org policy, direct SpaceEvents API
HTTP 500 responses, docs-listed message search/pins returning HTTP 404 in this
tenant, optional live transcription provider auth, persistent scheduler and
notification-channel approval, and package naming/license decisions.

## Safety Boundary

The verification pass must not DM anyone, invite real users, send messages to
existing user/team spaces, print credentials, or commit local secrets. Live Chat
writes are allowed only through the W7 harness in a dedicated space whose name
starts with `Google Chat AI SDK Smoke` and whose local metadata passes the
smoke-space guard.

## Command Evidence Ledger

| Area | Command | Expected safety | Status | Evidence |
|---|---|---:|---|---|
| Install | `pnpm install --frozen-lockfile` | Local only | Verified | Passed, already up to date. Global `pnpm` reported `11.7.0`, while `corepack pnpm --version` resolved the repo-declared `pnpm@11.9.0`. |
| Conformance | `pnpm conformance` | Local only | Verified | Included in `pnpm validate`: 59 Node runtime runs, 59 Python runtime runs, 3 shared context contract cases, and 3 deferred contract cases passed. |
| Unit tests | `pnpm test` | Local only | Verified | Included in `pnpm validate`: tool tests 12/12, Node test files 9/9 with 71 tests, Python 44 tests. |
| Build | `pnpm build` | Local only | Verified | Included in `pnpm validate`; TypeScript build exited 0. |
| Validation bundle | `pnpm validate` | Local only | Verified | Passed after conformance, tests, and build. |
| Docs | `pnpm docs:check` | Local only | Verified | Passed: Markdown links ok. |
| Discovery | `pnpm discovery:check` | Live read of curated snapshot only | Verified | Passed: revision `20260623`, 50 methods. |
| Release hygiene | `pnpm release:check` | Local plus registry freshness policy check | Verified | Passed format, docs, build, generated-ignore, secret scan, package content, and dependency freshness policy checks. |
| Package contents | `pnpm package:check` | Local package builds | Verified | Passed npm pack dry-run scope, Python metadata parse, wheel/sdist build, and expected package files; publication remains blocked until naming/license decisions. |
| Secret hygiene | `pnpm hygiene:secrets` | Local scan | Verified | Passed for 292 tracked and untracked non-ignored files. |
| Cloud doctor | `pnpm cloud:doctor` | Live read-only Cloud resource checks | Verified | Passed with the then-expected API set enabled and expected Cloud/Pub/Sub resources present. The newer private live QA ledger tracks the expanded Firestore API requirement. |
| Pub/Sub smoke | `pnpm cloud:pubsub-smoke` | Synthetic Pub/Sub message only | Verified | Passed against `chat-ai-sdk-smoke-tests` and `chat-ai-sdk-smoke-tests-dev-pull`. |
| Workspace Events pull smoke | `pnpm workspace-events:pull-smoke` | Synthetic Pub/Sub event only | Verified | Passed; normalized synthetic Workspace Event as `message.created` with Pub/Sub checkpoint metadata. |
| Cloud Run health | `BASE_URL=... pnpm cloud:health-smoke` | Live HTTP GET only | Verified | Passed with HTTP 200 and payload `ok: true`, `basePath: "/api"`. |
| Chat app auth list | `pnpm chat:app-auth-smoke` | Live Chat list, no messages | Historical verified; current status superseded | The 2026-06-30 run passed with HTTP 200 and 0 app-visible spaces. Current private live test tenant evidence now lists one app-visible smoke space and is tracked in the private live QA ledger (kept outside the public repository). |
| Chat app auth create-space | `pnpm chat:app-auth-smoke -- --create-test-space --metadata-output ...` | May create one smoke-named space only | Blocked | Retested on 2026-07-01. Google Chat API returned HTTP 500 `INTERNAL` for `Google Chat AI SDK Smoke 2026-07-01`; no metadata file written and no space created. |
| User-auth smoke plan | `pnpm chat:user-auth-smoke -- --dry-run --create-test-space` | No writes | Verified after 2026-07-01 update | Passed locally; planned principal is `user`, scope is `chat.spaces.create`, and `domainWideDelegation` is `false`. |
| Live Chat dry run | `RUN_LIVE_CHAT_SMOKE=1 pnpm live:chat-smoke -- --dry-run` | No writes | Verified | Passed against checked-in example metadata; default plan is list/get/message create/patch/delete with redacted message bodies and no app-auth space lifecycle unless explicitly requested. |
| Live Chat write smoke | `RUN_LIVE_CHAT_SMOKE=1 pnpm live:chat-smoke` | Dedicated smoke space only | Historical blocked; verified live later | The 2026-06-30 run was blocked before the dedicated smoke space existed. Current private live test tenant evidence now verifies bot-owned message create/edit/delete, thread replies, existing-thread replies, multi-reply threads, cleanup, visual inspection, and Cloud Logging sweeps in the dedicated smoke space. |
| Node local runtime | fixture POST to `examples/node-local-runtime` | Local only | Verified | Health returned ok; message attachment fixture returned AI-ready text with sender/time/attachment note; card click fixture returned `UPDATE_MESSAGE`. |
| Python local runtime | fixture POST to `examples/python-local` | Local only | Verified | Health returned ok; message fixture returned AI-ready text with sender/time/thread/attachment notes; card click fixture returned text response. |
| Cloud Run local server | local GET/POST against `examples/cloud-run-node` | Local only | Verified | Root and `/api` health returned ok, `/api/avatar.png` returned `200 image/png`, and `/api/chat/events` accepted a fixture. |
| Public helper smoke | direct Node/Python imports from package roots | Local only | Verified | Node and Python both built cards, summarized card actions, normalized attachments, created dry-run download plans, and generated send/stream plans from shared fixtures. |
| Optional FastAPI example | throwaway venv with `packages/python[fastapi]` and `uvicorn app:app --app-dir examples/python-fastapi` | Local only | Verified | Health, message fixture POST, and card-click fixture POST passed. |
| Git state | `git status`, branches, stashes, worktrees | Local only | Verified | Pre-commit status contained only the intended verification report, documentation refresh, Python export/test fix, and local server shutdown fix. |

## Workstream Verification Matrix

| Workstream | Current status | Verification requirement | Evidence |
|---|---|---|---|
| W0 Cloud and Chat App Readiness | Historical snapshot; current live status superseded | Cloud doctor, Pub/Sub smoke, app-auth list, Cloud Run `/api/healthz`, user-auth OAuth setup, no DMs/users. | This row captured the 2026-06-30 state. Current private live test tenant readiness is tracked in the private live QA ledger (kept outside the public repository). |
| W1 Shared Contracts and Conformance Runner | Verified | Shared schemas exist, fixture runner executes Node and Python, context contracts cover recursive quotes, thread truncation, and attachment notes. | `pnpm conformance` passed with 59 Node/Python runtime cases plus context contracts. |
| W2 Event Normalization | Verified | Direct Chat HTTP, Pub/Sub, Workspace Events, card/dialog/widget, slash/app command, membership/reaction/update/delete, unknown and invalid payload handling. | Covered by event conformance cases and Node/Python tests. |
| W3 Message AST and Annotation Parser | Verified | Message fixtures cover annotations, links, commands, attachments, quotes, deleted/private/thread/GIF cases, deterministic AI text with identity/time. | Covered by message conformance cases, Node/Python tests, and local runtime fixture POSTs. |
| W4 Action, Form, and Dialog AST | Verified | Shared action fixtures cover card click, dialog submit, widget update, slash/app commands, hidden params, unknown fields, validation errors. | Covered by action conformance cases and Node/Python tests. |
| W5 Node Runtime Router | Verified locally | Node runtime dispatches local fixture POSTs and exposes reply/context helpers without live sends. | Node example accepted message and card fixtures on loopback; no live sends. |
| W6 Python Runtime Router | Verified locally | Python runtime dispatches local fixture POSTs and exposes reply/context helpers without live sends. | Dependency-free Python example accepted message and card fixtures. Optional FastAPI example passed in a throwaway venv. |
| W7 Live Chat Smoke Harness | Verified live in current private live QA ledger | Guard refusal, target-space validation, dry run, and live message lifecycle in a dedicated user-created smoke space when unblocked. | The 2026-06-30 row was blocked. Current evidence now proves live message create/edit/delete, cleanup, thread replies, existing-thread replies, multi-reply threads, Chat UI inspection, and log sweeps. |
| W8 Attachments and Media | Verified locally and live for gated surfaces | Node/Python fixture parity for metadata, filename safety, download/upload plans, parser hooks, transcription disabled by default, AI notes. | Current private live test tenant evidence verifies text/image/PDF/audio metadata, Chat media download, quoted audio attachment hydration, Drive-backed Google Docs metadata, Drive blob/Docs/Sheets/Slides export/download routing, exact parser package smokes, and disabled-by-default transcription. Live provider transcription remains explicitly gated. |
| W9 Send, Reply, Thread, and Stream | Verified live for app-owned write surfaces | Dry-run call plans and mocked thread/space context cover send/reply/edit/delete/stream plus date filters, pagination, truncation, quotes. | Current private live test tenant evidence verifies bot-owned create/edit/delete, app-created and human-rooted thread replies, multi-reply threads, context reads, and edit-streaming up to 20 patches. |
| W10 Cards, Dialogs, and Rich Objects | Verified locally and live | Node/Python card builders, dialogs, validation, inbound summaries, and AI action notes match fixtures. | Current private live test tenant evidence verifies Cards V2 visual rendering, rich widget visual smoke, live button update, dialog open/submit, direct webhook variants, SDK response builders, and cleanup. |
| W11 Workspace Events and Pub/Sub | Verified synthetic; real subscription harness blocked by org policy | Pub/Sub wrappers and Workspace Events fixtures normalize; synthetic pull smoke proves checkpoint parsing. | Synthetic Pub/Sub and pull smoke pass. Current real-subscription smoke creates temporary Pub/Sub resources and cleans them up, but the private live test tenant's org policy rejects `chat-api-push@system.gserviceaccount.com`. Direct `spaces.spaceEvents.list` also remains blocked by Google HTTP 500 in this tenant. |
| W12 Docs, Examples, and DevEx | Partial / Updated | README/docs distinguish implemented/scaffolded/planned/blocked; referenced examples exist or are marked planned. | Stale docs were found and patched. `pnpm docs:check` passed through `pnpm release:check`. |
| W13 CI, Release, and Repository Hygiene | Verified locally | CI/release scripts cover tests, build, conformance, discovery, docs, package content, secret/generated ignore checks, dependency freshness. | `pnpm release:check`, `pnpm package:check`, `pnpm hygiene:secrets`, and discovery check passed. |

## Feature Inventory Coverage

| Inventory section | Current status | Notes |
|---|---|---|
| 1. Inbound event handling and routing | Partial | Local HTTP/Pub/Sub/Workspace Events normalization and Node/Python routers are implemented. Inbound Google request/JWT verification, background queues, and full router taxonomy remain planned. |
| 2. Message composition and delivery | Partial / live app-owned verified | Dry-run send-to-space/user/DM/reply/start-thread plans are implemented. Current private live test tenant evidence verifies app-owned create/edit/delete, thread replies, and cleanup in the dedicated smoke space. User DM sends remain intentionally untested. |
| 3. Replying, threads, and conversation sessions | Partial | Reply/thread dry-run plans and mocked context readers exist. Session memory, summaries, and production persistence remain planned. |
| 4. Message reading, search, and context loading | Partial / live history verified | Mocked thread/space context loading with filters, pagination, truncation, quotes, attachments, and AI notes exists. Current private live test tenant evidence verifies live `spaces.messages.list` history reads with date filters, pagination, `showDeleted`, thread filters, reactions, Drive/source attachment notes, quoted-message hydration, and redacted context output. Docs-listed search remains unavailable with HTTP 404 in this tenant. |
| 5. Message editing, deletion, and streaming | Partial / live app-owned verified | Dry-run edit/delete/stream create-plus-patch plans exist. Current private live test tenant evidence verifies live edit/delete and edit-streaming up to 20 patches with cleanup and Cloud Logging sweeps. |
| 6. Attachments, media, and file understanding | Partial / live gated surfaces verified | Metadata, safe filenames, policies, dry-run media plans, parser hooks, context notes, and optional transcription providers exist. Current private live test tenant evidence verifies Chat attachment metadata/downloads, Drive export/download variants, quoted attachment hydration, exact parser package smokes, and disabled-by-default transcription. OCR/malware scanning and live provider transcription remain planned or explicitly gated. |
| 7. Cards, dialogs, forms, and rich objects | Partial / live core surfaces verified | Common builders, dialogs, validation, summaries, and action notes exist. Current private live test tenant evidence verifies Cards V2 visual rendering, richer widget inventory, button update, dialog open/submit, direct webhook variants, and SDK response builders. Carousel/card-navigation/dialog-state helpers remain planned. |
| 8. Link previews, rich links, and URL handling | Partial / drift probes added | Matched URL/rich link parsing exists in message fixtures. Current private live test tenant evidence adds read-only probes for docs-listed message search/pin surfaces, but both return HTTP 404 in this tenant. Stable SDK primitives should wait for discovery/live support. |
| 9. Reactions, feedback, and custom emoji | Partial / live read-write subsets verified | Reaction events/summaries and custom emoji annotations are parsed. Current private live test tenant evidence verifies reaction context, reaction create/list/filter/delete, membership reads, `customEmojis.list` and `customEmojis.get` for visible `:test:`, and a human-authored custom emoji message rendered into AI-facing context notes. Custom emoji create/delete management remains out of scope unless an admin-management feature is explicitly approved. |
| 10. Pins, highlights, and space memory | Planned | No pin or space-memory implementation yet. |
| 11. Spaces, DMs, group chats, and rooms | Partial / smoke room verified | App-auth list works and DM/setup operations have dry-run plans. The historical app-auth space-creation HTTP 500 is no longer the main unblock path because the dedicated user-created smoke room is verified and installed. Broader space lifecycle and DM sends remain intentionally untested. |
| 12. Memberships, users, and identity resolution | Partial / live membership reads verified | Membership events and human-readable sender/actor fields are normalized where payload data exists. Current private live test tenant evidence verifies membership list/app lookup and explicit availability/fallback handling when Chat omits display names/emails. People/Admin enrichment and caches remain planned. |
| 13. Availability, read state, notifications, and sections | Planned | No user-side state APIs implemented. |
| 14. Workspace Events and passive monitoring | Partial / real harness blocked by org policy | Workspace Events/Pub/Sub parsing, checkpoint stores, synthetic pull smoke, and a guarded real-subscription harness exist. In the private live test tenant, the real subscription path is blocked by org policy rejecting the documented Google Chat publisher principal, and direct SpaceEvents reads return Google HTTP 500. |
| 15. Admin, import, and compliance features | Planned | Admin/import/compliance actions are inventory items only. |
| 16. AI-first workflow features | Partial / live context and streaming verified | AI-ready message/context notes, attachment notes, card-action notes, approval/progress/error cards, and dry-run streaming exist. Current private live test tenant evidence verifies live AI-facing context notes for sender/time/attachments/quotes/reactions and edit-streaming up to 20 patches. Model integration, queues, memory, and production approvals remain planned. |
| 17. Developer experience, testing, and tooling | Partial / broad smoke tooling verified | Fixtures, conformance, local examples, release checks, and smoke tools exist. Current private live test tenant evidence adds guarded live tools for health, logs, inbound, visual, card action, context, attachments, media download, Drive export, reactions, memberships, custom emojis, parser packages, idempotency, Cloud Monitoring alert policy shape, and Cloud Run idempotency monitor job. A user-facing CLI and production state/queue adapters remain planned. |
| 18. Security, privacy, and governance | Partial / live privacy guardrails verified | Secret scan, generated-file ignore checks, dry-run safety, smoke-space guards, attachment policy defaults, auth-principal design docs, central retry/token refresh, Firestore idempotency, idempotency monitoring, and Cloud Logging privacy controls exist. Inbound request verification, encrypted production token backend, persistent scheduler/notification channels, and broader policy engines remain planned or gated. |

## Findings And Fixes

- Fixed stale status documentation in `README.md`, local fixture quickstart,
  Cloud quickstart, architecture overview, live-smoke safety, Node/Python
  example docs, and AI-context requirements.
- Fixed Python package root exports for attachment helpers so Python matches
  the Node root-level public helper surface.
- Added a Python regression test proving root-level attachment helper exports.
- Improved the dependency-free Python local example so Ctrl-C shuts down
  without a traceback.
- Fixed the optional FastAPI adapter route registration so lazy framework
  imports still expose concrete `Request` and `JSONResponse` annotations to
  FastAPI; verified with a throwaway-venv Uvicorn smoke and a dependency-free
  regression test.
- Direct helper smoke initially failed because the smoke used the wrong stream
  input field; rerunning with the actual `initialText` contract passed.
- Direct helper smoke initially exposed missing Python root attachment exports;
  this is now fixed and covered by test.

## Historical Blockers

- The 2026-06-30 live W7 write smoke was blocked because the current default
  path required user OAuth setup, a user-created dedicated smoke space, local
  smoke metadata, and the Chat app installed in that smoke space. This blocker
  is superseded: the private live QA ledger now verifies the smoke room, app install,
  and live write/read/cleanup surfaces.
- Package publication remains blocked until license and public package names
  are selected.

## Current External Gates

- The real Workspace Events subscription smoke is blocked by the private live
  test tenant's org policy rejecting the documented Google Chat publisher
  principal.
- Direct `spaces.spaceEvents.list` is blocked by repeated Google HTTP 500
  responses in this project.
- Docs-listed `spaces.messages.search` and `spaces.messagePins.list` return
  HTTP 404 in this tenant and should remain drift probes.
- Live OpenAI/Gemini transcription requires explicit provider credentials,
  model choice, and live-media/transcription env gates.
- Persistent Cloud Scheduler and notification channels for production
  idempotency monitoring require explicit approval.

## Operational Notes

- Global `pnpm` reports `11.7.0`, while `package.json` declares `pnpm@11.9.0`.
  `corepack pnpm --version` resolves `11.9.0`; release handoff should invoke
  pnpm through Corepack or otherwise use the declared package manager version.

## Final State

Final local validation is green through the repo-declared pnpm version:

- `corepack pnpm validate`
- `corepack pnpm release:check`
- `corepack pnpm discovery:check`
- `git diff --check`

The remaining blockers are external/product decisions or Google-side live
Chat state: Workspace Events org policy, SpaceEvents HTTP 500s, unavailable
message search/pin endpoints in this tenant, transcription provider approval,
persistent scheduler/notification approval, and package naming/license
selection.
