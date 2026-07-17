---
title: Public Beta Publication Handoff
date: 2026-07-10
type: runbook
status: implemented
---

# Public Beta Publication Handoff

`googlechatai` is a public-beta, polyglot Apache-2.0 package. Version `0.0.2`
is currently public on npm and PyPI; `0.1.0-beta.1` is the checked-in release
candidate. The root workspace remains private; only `packages/node` and
`packages/python` are release artifacts. Versions are immutable: never
republish or replace an existing version on either registry.

The repository contains the release workflow at
`.github/workflows/publish.yml`. It is manual-only, accepts an exact `vX.Y.Z`
tag, validates the complete repository before publication, and uses GitHub OIDC
instead of a stored publish token. It builds and packs both language artifacts
before either registry is contacted, then publishes those prevalidated artifacts
from the protected `release` environment.

For prereleases, npm publishes under the `next` dist-tag rather than replacing
`latest`. PyPI normalizes the shared source version `0.1.0-beta.1` to
`0.1.0b1`; the registry verification command recognizes that canonical form.

## Repository-Controlled Checks

Run the local policy check before preparing a release:

```bash
corepack pnpm publish:check
corepack pnpm release:check
```

After a release, use the read-only public registry check. It requires no npm or
PyPI credentials and verifies that both registries expose the local immutable
version:

```bash
corepack pnpm publish:live-check
RUN_LIVE_REGISTRY_CHECKS=1 corepack pnpm dependency:freshness
```

`publish:check` verifies repository-controlled facts only: matched package
metadata, public npm access, license/notice files, the trusted-publish workflow,
and this runbook. It cannot prove registry ownership, account 2FA, or trusted
publisher configuration; those are intentionally account-level controls.

## One-Time Account Setup

Complete these settings before invoking the workflow. Do not put a publish token
in GitHub secrets, `.env.local`, scripts, or workflow files.

1. Create a protected GitHub environment named `release`; restrict who can
   approve deployments and who can create release tags.
2. In npm package settings for `googlechatai`, add a GitHub Actions Trusted
   Publisher with:
   - owner: `adamallcock`
   - repository: `googlechatai`
   - workflow: `publish.yml`
   - environment: `release`
   - allowed action: `npm publish`
3. In npm package settings, require 2FA and disallow traditional publish tokens
   after one successful OIDC release. Revoke any obsolete automation tokens.
4. In PyPI project settings for `googlechatai`, add a GitHub Trusted Publisher
   with the same owner, repository, workflow filename, and `release`
   environment.
5. Confirm that both registries show the expected repository URLs. npm trusted
   publishing will generate provenance for a public package from a public
   repository; PyPI will associate its publish attestation with the trusted
   workflow.

The platform configuration must exactly match `.github/workflows/publish.yml`.
The npm trusted-publisher setup supports only one publisher configuration per
package, so review any existing publisher before replacing it.

## Release Procedure

1. Bump `packages/node/package.json` and `packages/python/pyproject.toml` to
   the same new version. Update user-facing release notes and changelog material
   as appropriate.
2. Run the local checks above and inspect the package dry-run contents.
3. Merge the release commit, create an immutable matching tag such as
   `v0.1.0-beta.1`, and push the tag only after the repository is clean and
   reviewed.
4. In GitHub Actions, run **Publish public packages**, entering that exact tag.
   The `release` environment approval is the deliberate human release gate.
5. The workflow retries the read-only registry check after both publishes.
   Confirm the
   npm provenance indicator and PyPI trusted-publisher/attestation information
   in their public package pages.

If npm or PyPI already contains the target version, stop: bump the version
instead of attempting an overwrite.

## Partial-Release Recovery

The workflow blocks PyPI if npm fails, and it builds both artifacts before
either publish. A registry outage can still occur after npm accepts the
immutable tarball but before PyPI accepts its distributions. In that case,
stop the workflow, preserve the exact tag and artifact evidence, investigate
the failing registry configuration, and rerun the same tagged workflow. Before
each publish, the workflow compares npm integrity or PyPI SHA-256 digests; it
skips an already-published version only when the rebuilt artifact is an exact
match and fails closed on any mismatch. Reproducible builds use the tagged
commit timestamp. Do not replace, unpublish, or bump the version merely to
conceal a partial release. Verify both registries with
`corepack pnpm publish:live-check` before declaring the release complete.

## What This Does Not Do

This workflow publishes packages only. It does not deploy Cloud Run, change
Google Chat app configuration, send Chat messages, manage registry membership,
or modify account security settings.
