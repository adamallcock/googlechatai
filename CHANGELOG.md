# Changelog

All notable changes to googlechatai are documented here. The project follows
semantic versioning from 0.1.0 onward. Prerelease APIs may still change before
the stable 0.1.0 release.

## 0.1.0-beta.1 — 2026-07-16

- Ship a dependency-free `googlechatai` CLI with project scaffolding,
  configuration diagnostics, sanitized event inspection, cross-language
  fixture replay, dry-run request planning, card linting, and a guarded
  dedicated-space smoke command.
- Add minimal Node.js and Python starter apps with verified inbound requests,
  bounded request bodies, sanitized local fixtures, tests, environment
  templates, and explicit Google Chat registration steps.
- Add model-safe context projections with provenance/trust labels and
  default email redaction, plus public-type and cross-language parity checks.
- Harden production routing, retries, idempotency, queues, token stores,
  streaming state, and optional Firestore-backed reference stores.
- Add a package-routed Cloud Run reference, staging certification and
  idempotency-monitor tooling, all guarded from accidental tenant writes.
- Publish prerelease-aware OIDC workflow policy: npm prereleases use the
  `next` tag, PyPI's normalized prerelease version is verified correctly, and
  exact immutable artifact hashes make partial-release recovery idempotent.

## 0.0.2 — 2026-07-07

- Fix Python 3.10 compatibility: the actions and events modules imported
  the 3.11-only `datetime.UTC` alias, which made `import googlechatai`
  fail on Python 3.10 (0.0.1 is unusable there — upgrade).
- Adopt Google Chat discovery revision 20260705: `users.availability.get`
  and `users.availability.patch` replace `getAvailability` and
  `updateAvailability` in the curated snapshot; the live drift checker now
  treats revision-only changes as informational.
- npm package metadata: repository/homepage/bugs links and a
  `./package.json` export for bundler tooling.

## 0.0.1 — 2026-07-07

First public release, published to npm and PyPI as `googlechatai`.

- Normalized event envelope for Chat HTTP, Pub/Sub, and Workspace Events
  payloads, with message AST parsing, action/form normalization, and
  recursive quoted-message context.
- Webhook router (Node and Python) with handlers for messages, mentions,
  slash commands (named or bare), cards, dialogs, reactions, memberships,
  space add/remove, message update/delete, widget updates, and link
  previews; duplicate-delivery dedupe, response-deadline budgets, and (Node)
  inbound request verification hooks.
- Inbound request verification for Chat app bearer tokens and Pub/Sub push
  OIDC tokens with JWKS caching; stdlib-only RS256 verification in Python.
- Dry-run call planners for sends, replies, threads, edits, deletes,
  placeholders, async handoff, reactions, message pins, message search, and
  replaceCards, plus a plan executor with live-mode safety gates, retries,
  token refresh, request dedupe, and two-step placeholder resolution.
- Live streaming of model output through message edits via a deterministic
  cross-language scheduler: patch cadence, reserved final patch, message-size
  truncate/split, cancellation registries, failure degradation, resume.
- Card and dialog builders (approval, progress, error, sources, thinking,
  tool status, feedback), card lint/translation, and action-state helpers.
- Attachment pipeline planning (policy, download, Drive export, parsers,
  optional OpenAI/Gemini transcription providers) and artifact caching.
- Conversation context builders with identity resolution and AI system
  notes; capability and error explainers.
- Transport helpers: retry/backoff, 401 refresh-and-replay, idempotency
  stores, token stores (in-memory, file, Secret Manager), and queue adapters
  (file FIFO, Cloud Tasks, Pub/Sub).
- Cross-language conformance suite (180+ shared cases), export and
  router-method parity gates, and a weekly discovery-drift workflow.
