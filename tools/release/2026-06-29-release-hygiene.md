---
title: Release Hygiene
date: 2026-06-29
type: runbook
status: draft
---

# Release Hygiene

This repo is not ready for package publication until package names, registry ownership, and license terms are intentionally selected. The gates below keep CI useful while parallel workstreams continue.

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
- `pnpm test`
- `pnpm build`

`pnpm release:hygiene` runs:

- `pnpm format:check`
- `pnpm docs:check`
- `pnpm build`
- `pnpm hygiene:generated`
- `pnpm hygiene:secrets`
- `pnpm package:check`
- `pnpm dependency:freshness`

The validation build runs before package checks so Node package artifact checks
can inspect fresh `dist` files instead of relying on previous local state.

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

As of 2026-06-29, these root dependency versions were already verified current and are pinned in the repo:

- `pnpm@11.9.0`
- `typescript@6.0.3`
- `vitest@4.1.9`
- `@vitest/coverage-v8@4.1.9` (verified 2026-07-06; pinned to the vitest peer version)
- `@types/node@26.0.1`
- `hatchling>=1.30.1`
- PyPI build frontend `build==1.5.0`

`pnpm dependency:freshness` verifies the pinned baseline, Docker base-image review coverage, and the documented optional provider/parser package workflows. Set `RUN_LIVE_REGISTRY_CHECKS=1` when a networked registry check is appropriate for a release handoff.

## Package Content Gates

Node package checks require:

- `pnpm build` has emitted `packages/node/dist/index.js` and `packages/node/dist/index.d.ts`
- `npm pack --dry-run --json packages/node` includes only expected package content
- the package remains `private: true` until naming, ownership, and license are decided

Python package checks require:

- `packages/python/pyproject.toml` remains parseable
- `hatchling>=1.30.1` remains the build backend
- `src/googlechatai/__init__.py` and `src/googlechatai/py.typed` are included in the package tree
- `python -m build` can create a wheel and sdist in a temporary output directory using `build==1.5.0`

Python artifact building is checked before merge. Python artifact publication remains blocked until package naming and license decisions are complete. Do not publish to PyPI from CI.

## Package Naming And License Checklist

Before any npm or PyPI publication:

- Confirm the npm scope and package name are available, owned by the project, and not implying official Google ownership unless that is intentional.
- Confirm the PyPI name is available, owned by the project, and aligned with the npm naming story.
- Select a repository license and add the license file plus package metadata.
- Confirm README, examples, and package descriptions reflect the selected names.
- Decide provenance, signing, two-factor authentication, and trusted publishing requirements for npm and PyPI.
- Confirm generated files and local credentials are still ignored before staging.
