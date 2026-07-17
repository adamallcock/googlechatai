---
title: Production Hardening Implementation Plan
date: 2026-07-10
type: plan
status: superseded-by-release-pilot-remediation
---

# Production Hardening Implementation Plan

## Objective

Implement the actionable recommendations from the July 10 architecture and
capability assessment without adding third-party dependencies or sending live
Google Chat traffic. The result must make the public runtime boundaries safer,
make local file state reliable for concurrent local callers, retain Node/Python
semantic parity, and establish a package-routed production reference path.

## Scope

1. Route the Node Express adapter through the verified Fetch entrypoint, enforce
   HTTP method and bounded request body behavior, and add regression tests.
2. Make every local file-backed mutable state helper serialize same-process
   operations, use collision-resistant temporary files, and clearly retain a
   development/single-host boundary.
3. Replace Python deadline blocking with cooperative asyncio task handling and
   avoid synchronous JWKS I/O on ASGI/FastAPI event loops.
4. Introduce an explicit model-safe context projection, remove opaque page
   tokens from model-facing text, and add opt-in attachment scanning/parser
   resource limits.
5. Align Node/Python durable idempotency contracts and add a dependency-free,
   injected-transport Firestore reference store in both packages.
6. Add a package-routed Cloud Run reference example with verification, bounded
   body processing, and an explicit local-development escape hatch.
7. Strengthen discovery drift detection beyond method names, add coverage
   thresholds, add public Python structural types, and repair stale docs.

## Non-Goals

- No live Chat writes, DMs, OAuth consent, Firestore creation, or Cloud Run
  deployment.
- No bundled malware engine, external LLM provider, or new package dependency.
  The SDK will expose safe policy/scanner seams and a model-safe projection;
  applications own provider selection and tenant policy decisions.
- No attempt to implement every Google Chat resource. The discovery work
  validates the substrate so future intent primitives can be added safely.

## Design Decisions

- File stores will be made safe for concurrent callers within one runtime by a
  shared per-path mutex and collision-resistant temp names. They remain
  documented as local/single-host stores; cross-process/multi-instance use must
  use a durable atomic backend.
- The Firestore store will use an atomic document create for the first claim and
  an injected authenticated transport. It is testable without credentials and
  exposes no token values in records or logs.
- Model-safe output will be a new additive API rather than a breaking rewrite
  of existing canonical context. It will retain operational cursor metadata in
  the source context while excluding it from model text and clearly label
  untrusted message/attachment/tool data.
- The new Cloud Run reference will demonstrate verified inbound handling using
  the package. The existing hand-written smoke scaffold remains a smoke tool
  until it can be retired deliberately.

## Work Sequence

1. Establish shared local-file coordination helpers and tests.
2. Repair runtime/adapters and add regression tests for verifier, body limits,
   deadline fairness, and nonblocking verifier invocation.
3. Implement model-safe context and attachment safety hooks with shared
   conformance cases.
4. Implement structural durable-store support and Firestore reference stores in
   both languages with fake-transport tests.
5. Add the package-routed Cloud Run reference and local end-to-end tests.
6. Extend discovery signature drift detection, set coverage thresholds, update
   docs, and run release validation.
7. Perform critical-change, test, and independent verification audits; remediate
   all defects found.

## Acceptance Criteria

- A rejecting verifier cannot reach a handler through `expressAdapter`.
- Oversized/malformed/method-invalid framework requests produce safe responses.
- Concurrent local file store calls retain all writes or return a defined error;
  no temp-name collision or silent queue loss occurs.
- Python deadline-enabled dispatch does not block unrelated event-loop work.
- Model-ready context contains no raw page cursor/token and exposes provenance
  and trust level for model data.
- Node and Python accept the same structural idempotency-store contract and
  pass shared conformance for the new public behavior.
- The new Cloud Run reference imports and exercises `googlechatai` rather than
  duplicating its router/verification logic.
- Discovery drift detects method signature changes, not only added/removed
  names.
- `corepack pnpm release:check` passes, followed by critical-change and
  independent verification review.

## Completion Evidence

Completed on 2026-07-10 without sending live Google Chat traffic.

- `corepack pnpm release:check` passed, including parity, static checks, the
  complete Node/Python suites, package-content checks, documentation checks,
  formatting, generated-file hygiene, and secret scanning.
- `corepack pnpm discovery:check` passed against Google Chat discovery revision
  `20260707`: all 50 baseline method contracts matched the live document.
- `corepack pnpm test:coverage` passed with Node coverage of 86.97% statements,
  73.38% branches, 93.94% functions, and 87.09% lines; `git diff --check` also
  passed.
- This historical implementation pass was followed by a deeper release/pilot
  audit that found additional deployment, monitor, and publication-path gaps.
  Their remediation and current verification evidence live in
  [`2026-07-10-release-pilot-certification.md`](2026-07-10-release-pilot-certification.md);
  do not treat this older plan as a claim that no P0/P1 findings remain.
- The local Docker daemon was unavailable, so the Cloud Run image layout is
  statically exercised by `tools/cloud/sdk-reference-server.test.mjs`; its
  package-routed import and `CMD` are covered by that test.
