# Contributing to googlechatai

Thanks for your interest in improving googlechatai. This document covers the
practical workflow; [AGENTS.md](AGENTS.md) holds the repository rules that
both human contributors and AI coding agents follow — read it first, it is
short and binding.

## Development Setup

Prerequisites: Node.js 20+, pnpm 11+ (via corepack), Python 3.10+.

```bash
corepack pnpm install
corepack pnpm test        # tools + Node + Python suites
corepack pnpm validate    # + conformance, parity, static checks, build
```

The Python package is standard-library only and must stay that way; optional
integrations (like FastAPI) go behind extras. New Node dependencies need a
freshness-evidence line in `tools/release/2026-06-29-release-hygiene.md`.

## The Two Load-Bearing Rules

1. **Cross-language parity is enforced, not aspirational.** The Node and
   Python packages implement the same behavior, pinned by the shared
   conformance suite (`conformance/cases/*.json` + `corepack pnpm
   conformance`) and by export/router-method parity checks. A change to one
   language without the other fails the gate. New behavior lands as: shared
   fixtures → both implementations → conformance case.
2. **Every parser or orchestration behavior gets fixture coverage.** See
   [How To Add A Fixture](docs/guides/2026-06-29-how-to-add-fixture.md).
   Deterministic planners produce JSON-stable output — if your change alters
   plan output, regenerate the expected fixtures deliberately and explain why
   in the PR.

## Making Changes

- Match the existing style of the file you edit (narrowing helpers,
  `TypeError` messages in the established format, snake_case Python surface
  with camelCase shared JSON output).
- TypeScript must pass `npx tsc --noEmit` — vitest alone does not type-check.
- AI context rendering is a core surface: model-bound content must carry
  time, human-readable sender identity, relationship metadata, and explicit
  truncation/inaccessibility notes
  ([requirements](docs/guides/2026-06-29-ai-context-rendering-requirements.md)).
- Docs under `docs/` use YAML frontmatter and status labels (Implemented /
  Scaffolded / Planned / Blocked). Do not reference files that do not exist;
  `corepack pnpm docs:check` enforces link integrity.

## Live Google Chat Boundary

Nothing in the default test/validate flow touches the live Google Chat API.
Live smokes are explicitly guarded (`RUN_LIVE_CHAT_SMOKE=1`, a dedicated
smoke space, per-user OAuth) and must never DM real users or write into
existing team spaces. Do not commit credentials, tokens, raw Chat payloads,
or private workspace content — the secret scanner is a guardrail, not a
guarantee. Tenant-specific live evidence stays in gitignored local paths.

## Submitting

1. Run `corepack pnpm validate` (and `corepack pnpm release:check` for
   release-adjacent changes).
2. Open a pull request with a clear description of behavior changes and any
   regenerated fixtures.
3. CI runs the full gate across Node 20/22/24 × Python 3.10/3.12/3.14.

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), per section 5 of the license (inbound =
outbound).

## Releases

Registry versions are immutable — every release bumps `packages/node` and
`packages/python` versions together. The release gate
(`corepack pnpm release:check`) must pass before publishing.
