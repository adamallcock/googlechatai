---
title: Public Beta Release Readiness
date: 2026-07-16
type: report
status: blocked
---

# Public Beta Release Readiness

## Decision

The developer product is implemented and locally release-ready as
`0.1.0-beta.1`. Do not publish or tag it until the reviewed release branch is
merged to `main` and the remaining account-level controls are verified.

Publication is blocked by source-control integration and registry account
configuration, not by package behavior:

- the complete release candidate must be reviewed and merged from
  `codex/public-beta-developer-workflow` into remote `main`;
- `.github/workflows/publish.yml` is not present on remote `main`;
- npm and PyPI Trusted Publisher configuration could not be verified;
- the protected GitHub `release` environment now exists with one required
  reviewer, but release-tag protection is not configured;
- no real external developer has completed the five-person beta protocol.

Continue the public beta after those release controls are completed. Do not
promote to stable `0.1.0` until the external decision gates pass.

## Implemented Product Surface

- Packaged, dependency-free npm CLI:
  `init`, `doctor`, `inspect`, `replay`, `plan`, `card lint`, and `smoke`.
- Node and Python starter projects with verified callback servers, bounded
  request bodies, local fixtures/tests, card fixtures, environment templates,
  and dedicated-space smoke metadata.
- Offline event normalization, reply routing, model-safe context inspection,
  cross-language handler replay, exact request planning, and card linting.
- Generic setup doctor that validates configuration and credential shape
  without printing secret values.
- A dry-run-by-default smoke command that refuses live traffic without a
  dedicated space, safety attestations, user authorization, and an explicit
  live guard.
- A prerelease-aware OIDC workflow: npm uses `next`; PyPI's
  `0.1.0-beta.1` source version is verified under its normalized `0.1.0b1`
  registry version. Partial-release reruns skip only registry artifacts whose
  integrity or SHA-256 digests exactly match reproducible tagged builds.
- A five-developer external beta protocol with recruitment criteria, tasks,
  privacy boundary, scorecard, and stable-release gates.

## Verification Evidence

| Command or check | Result |
|---|---|
| `corepack pnpm public-beta:golden-path` | Packed npm tarball and Python wheel/sdist; installed them into clean temporary environments; generated Node and Python apps; passed unit test, replay, inspect, card lint, doctor, dry-run smoke, server health, and unverified-callback rejection in both languages |
| `corepack pnpm release:check` | Passed |
| Shared conformance | 186 Node runs and 186 Python runs; 3 shared context contracts; 0 deferred |
| Tool tests | 354 passed |
| Node tests | 357 passed across 24 files |
| Python tests | 312 passed |
| Pyright | 0 errors, 0 warnings |
| Node coverage | 86.98% statements, 73.39% branches, 93.94% functions, 87.10% lines |
| Package content | npm tarball includes built SDK, public CLI, and templates; Python wheel/sdist include expected package files |
| Hygiene | docs links, formatting, generated-file ignores, secret scan, and Cloud source-upload boundary passed |
| Live registry read | npm latest `0.0.2`; PyPI latest `0.0.2`; both candidate versions absent |
| GitHub release environment | Created `release` with one required reviewer |
| Live Google Chat traffic | Not run; no message, DM, invitation, or tenant mutation occurred |

The packed-artifact golden path caught and fixed a macOS realpath/symlink bug
that unit-level CLI imports did not expose.

## Current API Cross-Check

The guarded smoke request was checked against current official Google
documentation:

- [`spaces.messages.create`](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/create)
  accepts user-auth text messages and `client-...` custom message ids.
- [`spaces.messages.list`](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/list)
  uses `ASC` or `DESC` for `orderBy` and supports `createTime` plus
  `thread.name` filters.
- [Message formatting](https://developers.google.com/workspace/chat/format-messages)
  uses `<users/{user}>` for mentions.
- [Chat authorization](https://developers.google.com/workspace/chat/authenticate-authorize)
  documents `chat.spaces.readonly` and `chat.messages` for the user-authorized
  get/create/list/delete smoke sequence.

That review changed the implementation from the invalid
`orderBy=createTime desc` form to `orderBy=DESC`, added the thread filter, and
added the missing read-only space scope.

## Registry And Release State

Read-only checks on 2026-07-16 established:

- npm `latest`: `0.0.2`;
- npm `0.1.0-beta.1`: available;
- PyPI `latest`: `0.0.2`;
- PyPI `0.1.0b1`: available;
- repository visibility: public;
- remote `main` workflows: CI and discovery drift only;
- local npm CLI authentication: unavailable, which does not block OIDC but
  prevents a local `npm trust list` audit;
- npm Trusted Publisher: unverified;
- PyPI Trusted Publisher: unverified.

The npm and PyPI account settings must both trust owner `adamallcock`,
repository `googlechatai`, workflow filename `publish.yml`, and environment
`release`. npm must allow `npm publish`. Current platform guidance:

- [npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers/)
- [PyPI Trusted Publishers](https://docs.pypi.org/trusted-publishers/adding-a-publisher/)

## Required Release Actions

1. Review and merge `codex/public-beta-developer-workflow`, including
   `.github/workflows/publish.yml`, package sources, tests, docs, and version
   metadata, into remote `main`.
2. Configure or verify npm and PyPI Trusted Publishers with the exact claims
   above. Do not add long-lived publish tokens.
3. Add a reviewed release-tag rule if repository policy should restrict
   creation of `v*` tags; no ruleset exists today.
4. Re-run `corepack pnpm release:check` and
   `corepack pnpm public-beta:golden-path` on the clean merged commit.
5. Create immutable tag `v0.1.0-beta.1`, dispatch **Publish public packages**,
   and approve the protected `release` environment.
6. Verify npm `next` and PyPI `0.1.0b1`, reinstall both registry artifacts in
   clean environments, and rerun the golden path against those artifacts.
7. Recruit and run P1-P5 using
   `docs/runbooks/2026-07-16-five-developer-beta.md`; record only redacted
   outcomes.

If either registry already contains the candidate when Step 5 begins, bump
both source manifests and the tag rather than attempting to overwrite it.
