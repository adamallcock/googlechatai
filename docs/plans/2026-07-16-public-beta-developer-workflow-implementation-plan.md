---
title: Public Beta Developer Workflow Implementation Plan
date: 2026-07-16
type: plan
status: implemented
---

# Public Beta Developer Workflow Implementation Plan

## Objective

Turn the existing Node and Python SDKs into a coherent public-beta developer
product whose first workflow is:

```text
init -> local fixture -> inspect/replay -> doctor -> deploy -> guarded smoke
```

The beta promise is:

> Build, test, diagnose, and operate a verified Google Chat app in Node or
> Python without programming directly against raw Chat event and API payloads.

## Product Boundary

Build and release:

- the Chat-native Node and Python SDKs;
- one dependency-free CLI distributed with the Node package;
- Node and Python application scaffolds;
- offline event inspection and replay;
- dry-run intent planning;
- card validation;
- generic setup diagnostics;
- a dedicated-space guarded smoke workflow.

Do not add:

- a generated mirror of every Google Chat method;
- a generic Google Workspace CLI;
- a generic Workspace MCP server;
- new queues, stores, deployment platforms, or cloud orchestration unrelated
  to the beta workflow;
- claims that Google Cloud Console or administrator setup has become fully
  automatic.

## Implementation Tracks

### 1. Published CLI

- Add an executable entry point to the `googlechatai` npm package.
- Implement `init`, `doctor`, `inspect`, `replay`, `plan`, `card lint`, and
  `smoke`.
- Keep commands offline and side-effect-free by default.
- Require explicit environment and metadata guards before a live smoke write.

### 2. First-Success Scaffolds

- Generate dependency-light Node and Python projects.
- Include a minimal mention handler, local HTTP server, sanitized fixture,
  test, environment template, and exact setup/deployment boundary.
- Make generated projects runnable from clean temporary directories.

### 3. Product Documentation

- Replace the advanced streaming example as the first README workflow with a
  minimal mention/reply example.
- Document the CLI journey and manual Google configuration boundary.
- Mark the developer workflow as beta and avoid production-readiness claims.

### 4. Validation

- Add unit and integration coverage for every public command.
- Run the full Node, Python, tooling, conformance, type, coverage, build,
  package-content, documentation, secret, and release checks.
- Pack both language distributions and execute the generated Node and Python
  golden paths from disposable directories.

### 5. Publication

- Bump Node and Python to one matching prerelease version.
- Verify the version is absent from npm and PyPI.
- Verify package ownership/authentication and trusted-publisher prerequisites.
- Publish only through the repository's manual OIDC workflow or another
  already-authorized secure path; never bypass the protected release gate.
- Verify both registries and reinstall the immutable published artifacts.

### 6. External Beta

- Provide a five-developer protocol and scorecard covering local fixture,
  first live mention, thread routing, card action, context inspection, and
  diagnosis of an injected setup error.
- Do not substitute internal or synthetic tests for real external developer
  evidence.

## Completion Gates

The implementation is complete when:

1. `npx googlechatai init ...` produces working Node and Python projects.
2. Every public CLI command has success and malformed-input coverage.
3. Offline commands require no credentials or live Workspace.
4. The smoke command refuses non-dedicated spaces and live execution without
   explicit guards.
5. Clean-install generated projects pass their tests and fixture replay.
6. `corepack pnpm release:check` passes.
7. Package artifacts contain the CLI and templates without private/generated
   repository content.
8. Registry publication is either verified complete or documented as blocked
   by an exact external account/release-approval prerequisite.
9. The external beta protocol is ready; real participant outcomes remain
   explicitly unclaimed until collected.

## Execution Status

Completed on 2026-07-16:

- packaged CLI and all seven public workflows;
- Node and Python scaffolds;
- public first-success documentation;
- dry-run and live-guard tests;
- packed-artifact Node and Python golden paths;
- matching `0.1.0-beta.1` version metadata and prerelease registry policy;
- full `release:check`;
- protected GitHub `release` environment;
- five-developer protocol and scorecard.

Externally gated:

- review and merge of `codex/public-beta-developer-workflow` into remote
  `main`;
- npm and PyPI Trusted Publisher verification;
- immutable tag and protected workflow dispatch;
- five real external participant sessions.

The exact evidence and remaining release actions are recorded in
`docs/reports/2026-07-16-public-beta-release-readiness.md`.
