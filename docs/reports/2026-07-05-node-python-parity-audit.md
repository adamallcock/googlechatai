---
title: Node Python Parity Audit
date: 2026-07-05
type: report
status: complete
---

# Node Python Parity Audit

## Scope And Methodology

Audited the public SDK parity surface across:

- `packages/node/src` and `packages/python/src/googlechatai`
- `packages/node/test` and `packages/python/tests`
- `conformance/cases`, `fixtures`, `fixtures/expected`, and `spec`
- `README.md`, `docs/README.md`, relevant guides/plans/specs, and package scripts

This was read-only source inspection plus local non-live validation. I did not
read ignored live evidence, tokens, local smoke metadata, raw private Chat
payloads, or credentials.

## Executive Summary

Post-remediation update: the recommended high-priority and medium-priority
changes from this audit have been implemented in the same worktree. The release
gate now runs `pnpm validate` before release hygiene, `validate` includes shared
conformance plus export parity and Python static checks, Python transcription
provider helpers accept snake_case aliases, card/context/transcription evidence
fixtures are active conformance operations, and ingestion outputs are validated
against `spec/ingestion.schema.json`.

After remediation, `corepack pnpm conformance` passed with 145 Node runtime
runs, 145 Python runtime runs, 3 shared context contract checks, and 0 deferred
contract cases. `corepack pnpm release:check` also passed after running
conformance, export parity, Python static checks, tool tests, Node tests,
Python tests, build, docs, generated-file, package-content, and dependency
freshness checks.

At audit time, the core Node/Python parity story was strong for the surfaces
that were already inside shared conformance. The baseline
`corepack pnpm conformance` run passed with 126 Node runtime runs, 126 Python
runtime runs, 3 shared context contract checks, and 3 deferred context
contracts. Local test suites also passed: 186 Node tests and 143 Python tests.

No urgent runtime correctness bug was found in the covered shared fixtures. The
main risk is release/process and coverage boundary drift: several important
public helpers are mirrored by language-local tests but are not yet enforced by
shared conformance, and the current `release:check` script does not run
conformance or the test suites.

## Coverage Inventory

| Surface | Shared conformance | Node local tests | Python local tests | Notes |
| --- | ---: | ---: | ---: | --- |
| Actions | 6 active cases | yes | yes | Strong parity; shared expected fixtures. |
| Events | 35 active cases | yes | yes | Strong parity; includes Workspace/Event/Pub/Sub variants in normalized event path. |
| Message AST | 8 active parse cases | yes | yes | Strong parity for parser fixtures; nested context-node fixture covered locally too. |
| Message call plans | 15 active cases | yes | yes | Strong parity for send/reply/edit/delete/stream/placeholder/async plans. |
| Reply routing | 3 active cases | yes | yes | Good coverage for event-derived routing. |
| Context readers | 6 active runtime cases | yes | yes | Covers mocked thread/space read planning and rendered `chat.context`. |
| AI context contracts | 3 schema-only active + 3 deferred render contracts | partial | partial | Recursive `ai_context` contracts exist, but direct render cases are still deferred. |
| Attachments and Drive links | 8 active cases | yes | yes | Strong Drive-link parity; provider/transcription behavior remains local-test only. |
| Chat links | 30 active cases | yes | yes | Strongest new parity surface; includes snake_case alias fixtures. |
| Cards | 4 active lint/translate cases | yes | yes | Builders, summaries, action-state helpers, and feedback accessories are fixture-tested locally but not shared conformance operations. |
| Capabilities/errors | 4 active cases | yes | yes | Good shared parity. |
| Reactions | 5 active cases | yes | yes | Good shared parity for user-auth plans and feedback mapping. |
| Ingestion | 2 active cases | yes | yes | Runtime parity exists; output schema validation is not yet present. |
| Transport, cache, identity, routers, adapters, Workspace Events stores | none | yes | yes | Mostly mirrored local tests; some differences are intentionally language-native. |

## Findings

### High: Release Gate Does Not Enforce Node/Python Parity

`package.json:58` defines `release:check` as worktree/docs/build/generated/package/dependency checks. It does not include `pnpm conformance`, `pnpm test:node`, or `pnpm test:python`, even though `package.json:63` defines `validate` as conformance plus tests plus build, and the product spec says release gates should block if conformance differs (`docs/specs/2026-06-29-googlechatai-sdk-feature-inventory.md:1824-1831`).

Why it matters: a release-adjacent run can pass while Node/Python behavior has
drifted. This is the highest blast-radius gap because it turns a real parity
suite into an optional manual step.

Recommended fix: either make `release:check` call `pnpm validate` before the
release hygiene checks, or split the names clearly into `validate`,
`release:hygiene`, and `publish:check` where `publish:check` includes
conformance and both language test suites.

### Medium: Python Transcription Provider Factories Use JS-Style Keyword Names

The Python provider factories expose `apiKey` and `maxBytes` as Python keyword
arguments (`packages/python/src/googlechatai/attachments/__init__.py:2131-2160`).
The guide also documents those camelCase kwargs (`docs/guides/2026-06-29-voice-note-transcription-setup.md:128-135`).

This preserves the shared JSON/provider shape, but it is not language-native
Python API design. A direct smoke confirmed `create_openai_transcription_provider(api_key="x")`
raises `TypeError: unexpected keyword argument 'api_key'`.

Recommended fix: keep `apiKey`/`maxBytes` for backward compatibility, add
`api_key`/`max_bytes` aliases, reject conflicting duplicate values with a clear
error, and update tests/docs to prefer snake_case in Python examples.

### Medium: Card Builders Are Not Shared-Conformance Operations

`conformance/cases/cards.lint.json:1-164` covers only `lintCardPayload` and
`translateCardPayload`. The high-value card builders and helpers are tested in
both languages against shared fixtures (`packages/node/test/cards.test.ts:62-240`,
`packages/python/tests/test_cards.py:54-230`), but those tests are parallel
copies rather than one shared conformance oracle.

Why it matters: AI response cards, source cards, thinking/tool/streaming status
cards, feedback accessories, action-state encoding, and card summaries are
public SDK surfaces. They can drift if one language test is updated without a
matching shared case.

Recommended fix: add conformance operations such as `cards.buildCardMessage`,
`cards.buildFeedbackAccessoryMessage`, `cards.buildSourcesCard`,
`cards.buildStatusCard`, `cards.summarizeCards`, `cards.summarizeCardAction`,
and `cards.actionState`.

### Medium: AI Context Render Contracts Are Still Deferred

The recursive `ai_context` contract files exist, but `conformance/cases/context.render.json:1-38`
marks the direct render cases as `status: "contract"`, and
`conformance/cases/context.contract.json:3-30` explicitly says
`schema_only_until_context_builders`. Active `messages.context` cases do exercise
`buildConversationContext`, but they produce the current `chat.context` runtime
shape rather than executing those deferred `ai_context` render contracts.

Why it matters: repository instructions treat AI context rendering as a core SDK
surface. Deferred contracts are useful, but they do not yet prevent Node/Python
drift in the recursive AI-context shape.

Recommended fix: choose the canonical runtime target for the `ai_context`
schema, then make the three `context.render` cases executable in both languages.
Keep `messages.context` for Chat reader outputs, but add a separate runtime
assertion for recursive `ai_context` rendering.

### Low: Ingestion Has Runtime Parity But No Schema Validation

The conformance runner dispatches ingestion to both languages
(`tools/conformance/run.mjs:215-225` and `tools/conformance/run.mjs:624-625`),
and both cases passed. However, the shared schema directory has no
`ingestion.schema.json`, and the schema validation block covers cards,
attachments, and Chat links only (`tools/conformance/run.mjs:1024-1064`).

Recommended fix: add an ingestion schema for `chat.ingestion_plan` and polling
page output, and validate the expected fixture shape in the conformance runner.

### Low: Conformance Documentation Is Stale

`conformance/README.md:28-30` says conformance runs active action, event,
message, and message/thread-planning cases. The runner and case directory now
also cover reactions, capabilities, cards, attachments, Chat links, ingestion,
and context contracts. Root `README.md:30-31` has the same undercount.

Recommended fix: update the conformance docs and root README to match the
current suite. This is not a behavior bug, but stale docs make future agents
underestimate the parity coverage that already exists.

### Low: Python Typing Is Advertised But Not Gated

The Python package declares `Typing :: Typed` and ships `py.typed`
(`packages/python/pyproject.toml:14-22`), while Node is strict TypeScript
(`tsconfig.base.json:7-15`). The root Python test script is unittest-only
(`package.json:61`), and there is no visible pyright/mypy/ruff gate.

Recommended fix: add a lightweight Python static gate once public Python API
shape stabilizes. This does not block current parity, but it would catch
signature and typed-package regressions earlier.

## Intentional Differences

- Naming is intentionally language-native for most public functions:
  `normalizeEvent` in Node maps to `normalize_event` in Python, while shared
  JSON output remains camelCase for byte-for-byte fixture parity.
- Runtime adapters are intentionally ecosystem-specific: Node exports an
  Express-style adapter, while Python exposes ASGI and optional FastAPI adapters
  from `googlechatai.adapters.*`.
- Python exposes runtime helper classes such as `ChatResponse`, `ReplyBuilder`,
  and retry/idempotency records as importable classes. Node exposes many of the
  equivalent shapes as TypeScript types rather than runtime values.
- Direct live Chat writes, DMs, and app-auth space creation remain deliberately
  gated or diagnostic-only; dry-run call plans are the package-level parity
  contract.

## Recommended Remediation Sequence

1. Harden release gating first. Make the release/publish-adjacent command run
   conformance and both language suites, or document a separate mandatory
   publish gate that does.
2. Fix the Python transcription keyword ergonomics with backward-compatible
   snake_case aliases and explicit conflict errors.
3. Promote card builders, card summaries, and card action-state helpers into
   shared conformance operations.
4. Activate the deferred `context.render` cases once the canonical runtime
   `ai_context` builder target is chosen.
5. Add schema validation for ingestion outputs.
6. Add a tiny export/API parity inventory test that maps Node public value
   exports to Python root exports, with an allowlist for intentional runtime-vs-
   type and adapter differences.
7. Add a Python static gate after alias cleanup so the typed package claim has a
   real local check.

## Suggested Test And Conformance Additions

- `conformance/cases/cards.build.json`: custom, sections, approval, progress,
  error, dialog, navigation, stateful action, feedback accessory, sources,
  thinking, tool status, and streaming status builders.
- `conformance/cases/cards.context.json`: card summaries, action summaries,
  action notes, state encode/decode/read/route behavior.
- `conformance/cases/attachments.transcription.json`: disabled provider,
  missing credentials, oversize audio, OpenAI request shape, Gemini request
  shape, completed result, and redacted evidence summaries using fake clients.
- `conformance/cases/context.render.json`: convert the current deferred cases
  into executable Node/Python operations.
- `spec/ingestion.schema.json`: validate polling plan and polling page outputs.
- `tools/parity/export-map.*`: compare expected Node/Python root exports and
  known option aliases.

## Verification Run

Commands run from the repository root (a local worktree checkout):

- `corepack pnpm conformance` passed: 126 Node runtime runs, 126 Python runtime
  runs, 3 shared context contract cases, 3 deferred contract cases.
- `corepack pnpm test:node` passed: 16 test files, 186 tests.
- `corepack pnpm test:python` passed: 143 unittest tests.
- Targeted Python API probe confirmed `api_key` is not accepted by
  `create_openai_transcription_provider`.
