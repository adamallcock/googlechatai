---
title: Release and Pilot Certification Plan
date: 2026-07-10
type: plan
status: blocked
---

# Release and Pilot Certification Plan

## Objective

Turn the completed boundary-hardening work into an auditable public-beta and
single-tenant-pilot path. The repository must accurately describe its release
state, check package metadata and public registry state deliberately, provide a
durable Cloud Run reference deployment path, and make idempotency monitoring
operable without weakening the existing live Google Chat safety boundary.

## Scope

1. Reconcile publication documentation with the actual `googlechatai` package
   metadata, immutable-version policy, and public-beta posture.
2. Add local and opt-in live publish-readiness checks plus a GitHub Actions
   trusted-publishing workflow for npm and PyPI.
3. Make the package-routed Cloud Run reference use durable Firestore
   idempotency through Cloud Run metadata authentication in normal mode.
4. Add a guarded staging deployment/certification command that builds the
   reference through Cloud Build, verifies its Cloud Run health surface, and
   records only redacted evidence.
5. Add a guarded production idempotency-monitor apply path that creates or
   updates the scheduler and an enabled alert policy with an explicitly supplied
   notification channel.
6. Add public Python protocols/models plus a real static type-check gate.
7. Add a capability-lifecycle table that distinguishes local tests, dry-run
   planners, guarded live-smoke evidence, and production-supported paths.

## External Boundaries

- Do not publish packages, modify npm/PyPI ownership, enable/disable account
  two-factor authentication, or configure trusted publishers in registries from
  this repository. Those are account-level actions, but the workflow and
  runbook will name the exact required configuration.
- Do not update an existing Google Chat app callback URL or send a Chat message
  unless the dedicated-smoke-space runbook gates are satisfied. A staging Cloud
  Run deployment alone must not redirect an existing app.
- Cloud Scheduler, Cloud Run, Cloud Build, Cloud Monitoring, IAM, and alert
  policy mutations require their named opt-in environment guards. Safe
  preflight and dry-run commands remain available without those guards.
- Never record tokens, raw message text, private space IDs, private email
  addresses, or notification-channel details in tracked evidence.

## Acceptance Criteria

- One source of truth describes the public-beta release status, versions,
  provenance/trusted-publisher requirements, and immutable release policy.
- Local release hygiene checks package metadata and documentation; an opt-in
  live check verifies public npm/PyPI metadata without publishing.
- The Cloud Run reference rejects unverified requests, applies Firestore
  idempotency in normal mode, and exposes a safe health endpoint.
- Staging deployment and certification commands are deterministic, redacted,
  test-covered, and cannot mutate Cloud resources without explicit guards.
- Monitor scheduling and alert-policy setup require an explicit notification
  channel and can be run idempotently.
- Python public protocols/models and type checking are part of the declared
  validation gate.
- Documentation labels every relevant surface honestly; no unverified external
  state is represented as completed.

## Completion Evidence

All repository-controlled work in this plan is complete and was validated on
2026-07-10. The remaining work needs explicit account/operator input, so this
plan is blocked rather than claiming an unverified public or production state.

### Completed In The Repository

- The manual-only, prevalidated npm/PyPI OIDC publication workflow, package
  metadata checks, and public-beta release runbook are implemented. Read-only
  registry verification confirmed that the local immutable `0.0.2` version is
  present on both public registries.
- The package-routed Cloud Run reference has a normal-mode Firestore
  idempotency path, bounded byte ingress, request deadlines, metadata-token
  refresh coalescing, explicit concurrency/memory settings, Cloud Build source
  upload protection, and a redacted manual inbound-correlation contract.
- Staging certification binds health checks to the expected ready revision and
  100% traffic, refuses fixture-mode configuration, and never performs a Chat
  send. The optional inbound proof requires an operator-prepared run ID and a
  manual mention in the dedicated smoke space.
- The idempotency monitor supports exact nested collection paths, bounded
  diagnostics plus whole-collection expired-count aggregation, safe failure
  logging, capacity-derived or explicit thresholds, a dedicated Scheduler
  identity, a least-privilege job-invoker binding, and enabled alert coverage
  for both monitor warning/failure logs and Cloud Run Job errors.
- Python public types and Pyright checking are included in the release gate;
  lifecycle and runbook docs distinguish implemented local behavior from
  guarded external operations.

### Validation Evidence

- `corepack pnpm release:check` passed: 186 Node and 186 Python conformance
  runs, 334 tool tests, 357 Node tests, 312 Python tests, Pyright with zero
  errors, package-content checks, format/docs/generated-file/secret checks,
  and dependency freshness checks.
- `node tools/cloud/source-upload-check.mjs` passed against the actual
  `gcloud meta list-files-for-upload` result (682 files) with no protected
  private ledger or live-fixture paths included.
- The local Cloud Run reference suite includes a 20-way near-limit ingress
  pressure test, matching the reference deployment's configured concurrency.
- Guarded deploy, staging-certification, inbound-smoke, and monitor paths all
  have no-write dry-run coverage. A syntactically complete monitor dry run
  confirmed alert-first setup with a placeholder notification resource; it did
  not query or mutate a Cloud project.

### Required Operator Actions Before External Completion

1. Configure the intended staging audience, create the isolated Cloud Run
   deployment, record its expected revision, and only then manually point the
   dedicated staging Chat app at that endpoint.
2. Perform the guarded dedicated-space manual inbound mention and collect the
   redacted certification evidence; do not send general Chat messages.
3. Configure GitHub release-environment protection plus npm and PyPI trusted
   publishers/registry ownership for the public publishing identities.
4. Supply the real production notification channel and either explicit monitor
   thresholds or a reviewed event-rate/retention capacity budget before
   applying the Scheduler and alert policy.

No external deployment, callback change, Google Chat write, registry publish,
Scheduler setup, or alert-policy mutation was performed during this work.
