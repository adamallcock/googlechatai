---
title: Node Python Parity Remediation Plan
date: 2026-07-05
type: plan
status: implemented
---

# Node Python Parity Remediation Plan

## Goal

Implement the remediation items from
`docs/reports/2026-07-05-node-python-parity-audit.md` while preserving
Node/Python semantic parity, language-native Python ergonomics, and the live
Google safety boundary.

## Work Items

1. Release gating
   - Add a test that fails when `release:check` does not include shared
     conformance and both language test suites.
   - Update package scripts and release docs so publication-adjacent checks
     enforce parity.

2. Python transcription provider kwargs
   - Add Python tests for `api_key` / `max_bytes` aliases and conflict errors.
   - Keep `apiKey` / `maxBytes` backward compatible.
   - Prefer snake_case in Python docs.

3. Card conformance
   - Add shared conformance cases for card builders, summaries, action notes,
     and card action-state round trips.
   - Extend the runner to execute those operations in Node and Python.

4. Context render contracts
   - Turn the existing `context.render` contracts into executable cases against
     shared rendered context-item fixtures.
   - Keep `messages.context` as the runtime Chat-reader context surface.

5. Transcription evidence conformance
   - Add shared conformance for redacted transcription evidence hashing and
     provider/model/status shape.

6. Ingestion schema validation
   - Add `spec/ingestion.schema.json`.
   - Validate ingestion conformance expected outputs against that schema.

7. Export/API parity inventory
   - Add a small repo-local parity checker with an intentional-difference
     allowlist.
   - Run it in tests and release checks.

8. Python static gate
   - Add a lightweight Python compile/type-surface gate that does not introduce
     heavyweight runtime dependencies.
   - Run it from package scripts and release checks.

## Verification

- Focused red/green checks for each new test/conformance path: passed.
- `corepack pnpm conformance`: passed, 145 Node runtime runs, 145 Python
  runtime runs, 3 shared context contract cases, 0 deferred cases.
- `corepack pnpm test:node`: passed, 186 tests.
- `corepack pnpm test:python`: passed, 145 tests.
- `corepack pnpm test:tools`: passed, 227 tests.
- `corepack pnpm build`: passed.
- `corepack pnpm docs:check`: passed.
- `corepack pnpm discovery:check`: passed, revision `20260628`, 50 methods.
- `corepack pnpm format:check`: passed.
- `corepack pnpm release:check`: passed.
- `git diff --check`: passed.
