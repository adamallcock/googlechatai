# Repository Instructions

## Project Shape

This repository is a polyglot Google Chat SDK for AI chatbot and extension developers. It should provide native Node.js and Python packages backed by shared schemas, fixtures, and conformance tests.

## Engineering Standards

- Prefer high-level Chat intent primitives over raw API mirrors.
- Keep Node.js and Python behavior semantically aligned through shared fixtures and conformance tests.
- Preserve language-native ergonomics: TypeScript APIs should feel like TypeScript, Python APIs should feel like Python.
- Treat Google Chat discovery changes as an explicit compatibility event.
- Keep raw payload access available, but route application code through normalized event/message/action objects.
- Add fixture coverage for every new parser or orchestration behavior.
- Treat AI context rendering as a core SDK surface: include sender identity, timestamps, relationship metadata, quotes, replies, reactions, cards, and attachment notes in model-ready output.
- Model quoted messages and attachments recursively through shared context/message structures instead of bespoke one-depth fields.
- Resolve senders and actors into human-readable names/emails when auth allows, and explicitly represent inaccessible or ambiguous identity.
- Use latest modern package versions for new dependencies unless a compatibility reason is documented in the handoff.

## Validation

Run the smallest useful validation first:

```bash
corepack pnpm test
corepack pnpm build
corepack pnpm discovery:check
```

Python tests are run from the root through `corepack pnpm test:python`, with
`PYTHONPATH` pointing at `packages/python/src`.

For release or publication-adjacent changes, run:

```bash
corepack pnpm release:check
```

This includes format, docs links, build, generated-file ignore checks, secret
scan, package content checks, and dependency freshness policy checks.

## Live Google Boundary

- Do not DM anyone, invite users, or send messages into existing user or team
  spaces.
- Do not use domain-wide delegation as the default chatbot smoke path. Keep the
  default model user-installed and user-authorized unless the operator explicitly
  widens the trust model.
- Live Chat write tests must target only a dedicated smoke space named
  `Google Chat AI SDK Smoke ...`, with matching local smoke metadata and the Chat
  app installed in that smoke space.
- Use `corepack pnpm chat:app-auth-smoke` only as a bot/platform diagnostic.
  App-auth space creation is diagnostic-only and is not the product happy path.
- Read the live-smoke runbook before any live Chat action:
  `docs/runbooks/2026-06-29-live-chat-smoke-harness.md`.

## Secrets And Local Evidence

- Never commit or paste service-account JSON, OAuth client secrets, refresh
  tokens, access tokens, private keys, raw Chat payloads, raw message text,
  private attachment bytes, or screenshots containing private workspace content.
- `.env.local`, `.tokens/`, `fixtures/live/*.local.json`,
  `fixtures/live/evidence/`, and `artifacts/live/` are local-only ignored paths.
- Tenant-specific live ledgers live in `docs/private/` (gitignored,
  local-only). They must never be committed or referenced by tracked docs;
  tracked docs may only mention that private ledgers exist outside the
  repository.

## Documentation

- Root `README.md` stays practical and does not need YAML frontmatter.
- New long-form docs under `docs/` should use YAML frontmatter.
- Keep research under `docs/research/`, product specs under `docs/specs/`, and architecture decisions under `docs/architecture/`.
- Docs and examples should label surfaces as `Implemented`, `Scaffolded`,
  `Planned`, or `Blocked` when the current state could be confused.
- Do not reference an example as available unless its path exists; otherwise
  mark it planned and name the owning workstream when known.

Canonical routing:

- `README.md` is the compact current-state and first-workflow entrypoint.
- `docs/README.md` is the docs index and canonical/private routing map.
- `docs/specs/2026-06-29-googlechatai-sdk-feature-inventory.md` is the broad
  product target, not a shipped-feature claim.
- The current private live QA ledger lives in `docs/private/` (local-only,
  gitignored). If older dated tracked reports conflict with it, treat the
  older report section as historical unless it has been explicitly refreshed.

## Publishing Boundary

- The license (Apache-2.0, see `LICENSE`/`NOTICE`) and the public package name
  (`googlechatai` on npm and PyPI) are decided. Packages stay private until
  registry ownership, provenance/signing, and public-safe documentation are
  confirmed and a first release is intentionally cut.
- Before staging publication-adjacent work, run `corepack pnpm release:check`
  and inspect `git status --short --branch` for unrelated or private changes.
