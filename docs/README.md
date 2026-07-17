---
title: Docs Index
date: 2026-07-02
type: reference
status: draft
---

# Docs Index

Use this index to route future documentation work and avoid treating older dated
reports as current state.

## Canonical Entry Points

- `../README.md`: practical project overview, current implemented/planned/blocked
  status, setup, validation, and first links.
- `../AGENTS.md`: future-agent rules for validation, live Google boundaries,
  secrets, private live evidence, documentation routing, and publishing gates.
- `specs/2026-06-29-googlechatai-sdk-feature-inventory.md`: broad product
  target and capability inventory. This is not a shipped-feature claim.
- `guides/2026-06-29-architecture-overview.md`: contributor-oriented architecture
  map and current implementation boundaries.
- `guides/2026-07-16-public-cli-and-first-app.md`: package-installed Node and
  Python first-success workflow, offline inspect/replay/plan/card commands,
  generic doctor, manual Google boundary, and guarded dedicated-space smoke.
- `guides/2026-07-04-chat-doctor.md`: repository-maintainer setup-bundle,
  endpoint, auth, interaction, and log-correlation diagnostics.
- `guides/2026-07-04-capability-error-explainers.md`: public app-vs-user auth,
  scope, retry, idempotency, and error-remediation explainers.
- `guides/2026-07-04-card-lint-and-translation.md`: profile-aware Chat card
  linter and direct-Chat-to-Workspace-add-on response translator.
- `guides/2026-07-04-attachment-pipeline.md`: high-level media and attachment
  planner for normalize/policy/cache/download/Drive export/parser/transcription
  fallback and AI-context notes.
- `guides/2026-07-05-drive-link-retrieval.md`: dry-run Drive-link retrieval
  planning for Docs, Sheets, Slides, Drive blob URLs, rich links, cache
  summaries, and metadata-only fallbacks.
- `guides/2026-07-05-chat-link-retrieval.md`: dry-run Chat-link retrieval
  planning for structured `chatSpaceLinkData`, known Chat URL shapes,
  direct link arrays, feature flags, traversal caps, auth scopes, and cache
  metadata hints.
- `guides/2026-07-04-async-response-kit.md`: deadline-aware placeholder plus
  queue handoff planner for long-running AI responses.
- `guides/2026-07-04-passive-ingestion.md`: direct, Workspace Events push/pull,
  and polling fallback ingestion planning with polling snapshot processing.
- `guides/2026-07-04-evidence-tooling.md`: repository-maintainer redacted
  evidence collection, fixture recording, and Node/Python replay parity checks.
- `guides/2026-07-04-placeholder-responses.md`: agent placeholder-response
  create/hydrate/complete flow for editing the same Chat message.
- `guides/2026-07-05-reply-routing-policy.md`: configurable event reply
  routing for DMs, room top-level invocations, thread replies, and thread-key
  fallback behavior.
- `guides/2026-07-06-inbound-request-verification.md`: Chat app bearer-token
  and Pub/Sub push OIDC verification, JWKS caching, router/adapter wiring, and
  offline-fixture conformance.
- `guides/2026-07-06-plan-execution.md`: generic dry-run/live executor for any
  call plan, with safety gates, placeholder resolution, and idempotency dedupe.
- `guides/2026-07-06-live-streaming.md`: shared cross-language streaming
  scheduler and Node/Python drivers for cadence, truncate/split, cancel, and
  resume.
- `guides/2026-07-06-pins-search-replace-cards.md`: docs-listed message pin,
  search, and replace-cards planners pending live verification.
- `guides/2026-07-06-token-stores-and-queues.md`: Node/Python token store and
  async response queue adapters, including the shared file formats.
- `guides/2026-07-06-router-event-coverage.md`: router registrations for
  slash commands, space/reaction/membership/message events, plus
  dedupe/deadline/verifier options and dispatch precedence.
- `guides/2026-07-10-production-hardening.md`: verified framework boundaries,
  local-versus-durable state, Firestore idempotency reference stores,
  model-safe context, attachment scanner seams, Cloud Run reference, discovery
  contract fingerprints, coverage floors, additive public Python contracts,
  and the strict Pyright public-API gate.
- `guides/2026-07-10-capability-lifecycle.md`: separate local, dry-run,
  guarded-live, and production-supported capability labels with promotion rules.
- `plans/2026-07-10-release-pilot-certification.md`: current public-beta,
  Cloud Run reference, staging certification, and idempotency-monitor
  completion plan, including external approval boundaries.
- `plans/2026-07-16-public-beta-developer-workflow-implementation-plan.md`:
  current implementation plan for the packaged CLI, Node/Python scaffolds,
  first-success documentation, guarded smoke, clean-install validation, and
  publication gates.
- `research/2026-07-10-googlechatai-architecture-and-capability-assessment.md`:
  historical pre-hardening assessment of product intent, sufficiency, and
  remaining application responsibilities; its implementation-status section
  records the completed remediation.
- `research/2026-07-16-googlechatai-developer-experience-reassessment.md`:
  current product and viability decision after hands-on comparison with the
  official Google clients, Google Workspace CLI, and Vercel Chat SDK. It
  supersedes the narrower July 15 market recommendation.
- `reports/2026-07-16-public-beta-release-readiness.md`: implemented CLI and
  scaffold surface, full validation and installed-artifact evidence, current
  registry/GitHub state, and exact external publication blockers.
- `research/2026-07-05-google-chat-link-retrieval-research.md`: current research
  on Google Chat URL shapes, `chatSpaceLinkData`, API retrieval routes, and
  parse-confidence boundaries.
- `plans/2026-07-05-chat-link-retrieval-implementation-plan.md`: implemented
  Node/Python Chat-link metadata preservation, candidate extraction, parser
  registry, dry-run planner, test strategy, and planned live/context follow-up.
- `guides/2026-07-03-ai-card-components.md`: reusable AI assistant card
  components for feedback, sources, thinking, tool status, and streaming status.
- `guides/2026-07-03-feedback-reactions.md`: feedback-card action handling plus
  visible user-auth thumbs-up/down reaction planners.
- `runbooks/2026-06-29-live-chat-smoke-harness.md`: canonical live Chat smoke
  safety and command runbook.
- `runbooks/2026-07-10-publication-handoff.md`: public-beta npm/PyPI release
  policy, GitHub OIDC trusted publishing, provenance, registry verification,
  and the account-level approval boundaries.
- `runbooks/2026-07-16-five-developer-beta.md`: external five-person
  recruitment, task script, privacy boundary, redacted scorecard, and stable
  release decision gates; participant slots remain explicitly unclaimed until
  real sessions occur.
- `runbooks/2026-07-10-staging-certification.md`: isolated package-routed
  Cloud Run deployment, read-only health certification, and guarded staging
  callback smoke procedure.
- `runbooks/2026-07-10-idempotency-monitor-operations.md`: scheduler, alert,
  notification-channel, and safe escalation procedure for durable delivery.
- `guides/2026-07-02-production-auth-retry-idempotency.md`: current transport,
  retry, auth-refresh, and idempotency guidance.
- `../tools/release/2026-06-29-release-hygiene.md`: release, secret, generated
  file, package content, and dependency freshness gates.

## Private Local Operations

Tenant-specific live ledgers (live QA state, live project setup, live
regression passes, provider live smokes) are kept in `docs/private/`, which
is gitignored and never part of the public repository. Tracked documentation
must not link into `docs/private/`; summarize outcomes with status labels
instead of tenant identifiers.

## Historical Reports

Dated reports describe the state at the time they were written. If a historical
report conflicts with `README.md`, this index, or the private live QA
ledger, use the newer current-state docs and treat the older row as historical
evidence.

Notable historical snapshots:

- `reports/2026-06-30-end-to-end-verification.md`
- `plans/2026-06-29-parallel-agent-workstreams.md`

## Status Labels

- Implemented: code and tests exist in this repository.
- Scaffolded: files or scripts exist, but the behavior is incomplete.
- Planned: described in specs or workstreams, not shipped.
- Blocked: needs manual setup, external verification, product decision, or a
  dedicated guarded live harness.
