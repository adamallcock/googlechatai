---
title: Release Hygiene
date: 2026-06-29
type: runbook
status: implemented
---

# Release Hygiene

The root workspace is private, but the Node.js and Python `googlechatai`
packages are public Apache-2.0 public-beta artifacts. Their current immutable
published version is `0.0.2` on npm and PyPI; `0.1.0-beta.1` is the checked-in
release candidate. Publication remains intentionally manual: registry
ownership, Trusted Publisher configuration, 2FA, and release-environment
approval are account-level controls documented in
[`docs/runbooks/2026-07-10-publication-handoff.md`](../../docs/runbooks/2026-07-10-publication-handoff.md).

## CI Gates

CI runs the same root validation commands used locally:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm discovery:check
pnpm ci:conformance
pnpm release:check
```

`pnpm ci:conformance` is a compatibility shim for CI jobs that call the older
script name; it runs `pnpm conformance` when the root script is available.

`pnpm release:check` runs `pnpm validate` first, then `pnpm release:hygiene`.
`pnpm validate` runs:

- `pnpm conformance`
- `pnpm parity:exports`
- `pnpm python:static`
- `pnpm python:typecheck`
- `pnpm test`
- `pnpm test:coverage`
- `pnpm build`

`pnpm release:hygiene` runs:

- `pnpm format:check`
- `pnpm docs:check`
- `pnpm build`
- `pnpm hygiene:generated`
- `pnpm hygiene:secrets`
- `pnpm cloud:source-upload-check -- --allow-missing-gcloud`
- `pnpm package:check`
- `pnpm publish:check`
- `pnpm dependency:freshness`

The validation build runs before package checks so Node package artifact checks
can inspect fresh `dist` files instead of relying on previous local state.
The CI source-upload job installs the Cloud CLI and runs the same checker
against `gcloud meta list-files-for-upload`, so private tenant ledgers and live
fixture evidence cannot silently enter a Cloud Build source upload.

## Secret And Generated File Guards

Never commit:

- `.env.local` or any `.env.*` file except `.env.example`
- service-account keys, private keys, OAuth tokens, access tokens, refresh tokens, or token caches
- `dist`, `build`, `node_modules`, Python bytecode, cache folders, live artifacts, or local worktrees

Use these checks before staging:

```bash
pnpm hygiene:generated
pnpm hygiene:secrets
git status --short --branch
```

`pnpm hygiene:generated` uses representative `git check-ignore -v` paths so missing ignore coverage fails visibly. `pnpm hygiene:secrets` scans tracked text files for high-confidence credential patterns without printing secret values.

## Dependency Freshness Workflow

Agents adding dependencies must use the latest modern version available at implementation time unless a compatibility reason is documented in the handoff.

For npm packages:

```bash
npm view <package> version dist-tags time.modified license repository --json
```

For PyPI packages:

```bash
python3 -m pip index versions <package>
python3 -m pip show <package>
```

For Docker base images:

```bash
docker buildx imagetools inspect node:22-slim
# If the local Docker install lacks buildx, the release checker falls back to:
docker manifest inspect node:22-slim
```

For optional transcription provider packages, evaluate both Node and Python packages before adding adapters:

```bash
npm view openai version dist-tags time.modified license repository --json
npm view @google/genai version dist-tags time.modified license repository --json
python3 -m pip index versions openai
python3 -m pip index versions google-genai
```

For optional attachment parser packages, evaluate both Node and Python packages before adding adapters or enabling package-backed smokes:

```bash
npm view pdf-parse version dist-tags time.modified license repository --json
npm view sharp version dist-tags time.modified license repository --json
npm view music-metadata version dist-tags time.modified license repository --json
python3 -m pip index versions pypdf
python3 -m pip index versions Pillow
python3 -m pip index versions mutagen
```

For the Python public-contract type checker:

```bash
npm view pyright version dist-tags time.modified license repository --json
```

As of 2026-06-29, these root dependency versions were already verified current and are pinned in the repo:

- `pnpm@11.9.0`
- `typescript@6.0.3`
- `vitest@4.1.9`
- `@vitest/coverage-v8@4.1.9` (verified 2026-07-06; pinned to the vitest peer version)
- `@types/node@26.0.1`
- `pyright@1.1.411`
- `hatchling>=1.30.1`
- PyPI build frontend `build==1.5.0`

`pnpm dependency:freshness` verifies the pinned baseline, Docker base-image review coverage, and the documented optional provider/parser package workflows. Set `RUN_LIVE_REGISTRY_CHECKS=1` when a networked registry check is appropriate for a release handoff.

## Package Content Gates

Node package checks require:

- `pnpm build` has emitted `packages/node/dist/index.js` and `packages/node/dist/index.d.ts`
- `npm pack --dry-run --json packages/node` includes only expected package content
- `packages/node/package.json` declares `publishConfig.access: public`

Python package checks require:

- `packages/python/pyproject.toml` remains parseable
- `hatchling>=1.30.1` remains the build backend
- `src/googlechatai/__init__.py` and `src/googlechatai/py.typed` are included in the package tree
- `python -m build` can create a wheel and sdist in a temporary output directory using `build==1.5.0`

Python artifact building is checked before merge. Python publication happens
only through the manual OIDC workflow and protected `release` environment; do
not publish from a developer workstation or CI job that lacks that environment.

## Public-Beta Publication Checklist

Before any npm or PyPI publication:

- Confirm `googlechatai` registry ownership and public package metadata on npm
  and PyPI with `pnpm publish:live-check`.
- Keep the Apache-2.0 license, `LICENSE`, `NOTICE`, README, examples, and
  package descriptions aligned with the public package name.
- Configure provenance/trusted publishing, two-factor authentication, and the
  protected GitHub `release` environment as specified in the publication
  handoff runbook.
- Confirm generated files and local credentials are still ignored before staging.
