# googlechatai

[![npm](https://img.shields.io/npm/v/googlechatai)](https://www.npmjs.com/package/googlechatai)
[![PyPI](https://img.shields.io/pypi/v/googlechatai)](https://pypi.org/project/googlechatai/)
[![CI](https://github.com/adamallcock/googlechatai/actions/workflows/ci.yml/badge.svg)](https://github.com/adamallcock/googlechatai/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

googlechatai is a polyglot Google Chat AI SDK for building serious Chat apps,
AI assistants, and workflow extensions without living at the raw REST-object
layer. It ships as native, dependency-light packages for Node.js and Python,
kept behaviorally identical through shared fixtures and a cross-language
conformance suite.

```bash
npm install googlechatai@next       # Node.js 22+
pip install --pre googlechatai      # Python 3.10+ (stdlib only)
```

Status: `0.1.0-beta.1` public-beta release candidate (PyPI normalizes the
version to `0.1.0b1`). The local, dry-run, and verification surfaces are
extensively tested; live-API wrappers are exercised against a private test
tenant. APIs may change before the stable `0.1.0` release.

## Why

The Google Chat API is broad but shaped around REST resources, not around how
chat-app and AI-assistant developers think. googlechatai gives you
intent-level primitives instead:

- **Normalize everything inbound.** Events, messages, annotations, slash
  commands, cards, dialogs, attachments, reactions, and memberships become
  one stable envelope with model-ready text (`plainTextForModel`), explicit
  identity/availability states, and recursive quoted-message context.
- **Verify before you trust.** First-class verification of Google's bearer
  tokens on Chat webhooks and OIDC tokens on Pub/Sub push — including a
  stdlib-only RS256 implementation in Python — so a forged POST never
  reaches your handlers.
- **Plan, then execute.** Every write is available as a dry-run call plan
  (exact HTTP requests, capability and safety analysis, idempotency ids)
  and a plan executor turns it into real API calls with retries, token
  refresh, request dedupe, and explicit live-mode opt-in.
- **Stream like a chat product.** Model output streams into Chat by editing
  one message in place, driven by a deterministic scheduler that handles
  patch cadence, message-size truncate/split, cancellation (including
  cross-process stop buttons), failure degradation, and resume.
- **Stay aligned across languages.** The Node and Python packages implement
  the same contracts, pinned by shared conformance cases that run both runtimes
  against identical fixtures on every change.

## First success in five minutes

Generate and exercise a Node app without credentials or a Google Workspace:

```bash
npx googlechatai@next init my-chat-app --language node --install
cd my-chat-app
npm test
npm run fixture
npm run inspect
npm run card
npm run doctor
```

Or generate the matching Python app:

```bash
npx googlechatai@next init my-python-chat-app --language python --install
cd my-python-chat-app
.venv/bin/python -m unittest
npx googlechatai@next card lint fixtures/card.json
npx googlechatai@next replay fixtures/mention.json \
  --language python \
  --python .venv/bin/python \
  --handler app.py \
  --expect-text "You said"
```

The generated handler is intentionally small:

```js
import { GoogleChatAI } from "googlechatai";

export const chat = new GoogleChatAI();

chat.onMention((event, ctx) =>
  ctx.reply.text(`You said: ${event.message?.argumentText ?? "hello"}`),
);
```

Scaffolds include a verified callback server, one sanitized fixture, a test,
an environment template, and a dedicated-space smoke metadata example. Local
tests do not use credentials or send Chat traffic.

Google Cloud project creation, Chat API app registration, OAuth/admin approval,
deployment, and installation remain explicit operator steps. Run `doctor`
before deployment; run `smoke` in dry-run mode before deliberately enabling its
guarded live write.

## CLI workflow

| Command | Purpose | Default side effect |
|---|---|---|
| `init` | Generate a Node or Python starter | Local files only |
| `inspect` | Normalize an event and expose reply/context decisions | None |
| `replay` | Execute a sanitized fixture through a handler | None |
| `plan` | Show exact requests, auth, and safety for a Chat intent | None |
| `card lint` | Validate a Chat card or action response | None |
| `doctor` | Diagnose local config, endpoint, auth shape, and smoke metadata | Read-only; endpoint probe is opt-in |
| `smoke` | Prove mention delivery and thread routing in a dedicated space | Dry-run unless `--live` plus guards |

Run `npx googlechatai@next <command> --help` for exact options. For advanced
placeholder/edit streaming, continue with the
[Live Streaming guide](docs/guides/2026-07-06-live-streaming.md). Every SDK
write is also available as a dry-run plan before execution.

## Feature Overview

| Area | What you get |
|---|---|
| Event handling | One normalized envelope for HTTP, Pub/Sub, and Workspace Events payloads; router registrations for messages, mentions, slash commands (by name), cards, dialogs, reactions, memberships, space add/remove, widget updates, and link previews; dedupe and deadline options |
| Request verification | Chat app bearer JWTs and Pub/Sub push OIDC tokens, JWKS caching, offline test fixtures |
| Messages | Send/reply/thread/edit/delete planners with typed inputs, reply-target routing policies, placeholder responses, async response handoff, message search and replace-cards (docs-listed) |
| Streaming | `streamChatReply` / `stream_chat_reply` / `astream_chat_reply` with shared scheduler semantics, final-card attachment, cancellation registries, resumable state |
| Cards and dialogs | Typed builders (approval, progress, error, sources, thinking, tool status, feedback), card lint/translation, action-state round-tripping, dialog helpers |
| Attachments | Metadata normalization, download/upload plans, policy gates, parser hooks, Drive export plans, optional OpenAI/Gemini voice transcription providers |
| Context for AI | Thread/space readers, recursive quoted-message context, identity resolution with explicit unavailability, plus a model-safe projection with provenance/trust labels, cursor exclusion, and default email redaction |
| Reactions and pins | Reaction planners with feedback mapping, message pin planners (docs-listed) |
| Transport | Retry/backoff with Retry-After, 401 refresh-and-replay, structural idempotency stores including injected Firestore reference stores, token stores (file, Secret Manager), queue adapters (Cloud Tasks, Pub/Sub, file) |
| Capabilities | `explainChatCapability`, permission plans, and error explainers for 401/403/404/429/5xx remediation |

## Current State

Implemented and conformance-tested: everything in the feature overview above.
Both packages pass shared cross-language conformance cases, unit and coverage
suites, export and router-method parity checks, and a strict release gate.

Implemented: a package-routed Cloud Run reference with verified Fetch routing
and bounded bodies; the older Cloud Run webhook remains a smoke scaffold.

Implemented but externally gated: Cloud Run staging deploy/certification and
Firestore idempotency monitor Job/Scheduler/alert tooling. Applying either
requires the named Cloud IAM, capacity-budget, notification-channel, and
dedicated-smoke-space guards; no tenant deployment is implied by the checked-in
tooling.

Planned: custom emoji management, admin/import operations, retention-policy
automation beyond the guarded idempotency monitor, richer live parser/provider
harnesses.

Gated: docs-listed Google surfaces (message pins, message search,
replaceCards) ship as planners with explicit warnings until verified live;
live smokes require a dedicated test space and explicit env guards; a
`spaces.spaceEvents.list` 500-level issue observed in our private live tenant
is tracked for re-verification.

Status labels used throughout the docs: Implemented, Scaffolded, Planned,
Blocked.

## Development

```bash
corepack pnpm install          # Node 22+, pnpm 11+, Python 3.10+
corepack pnpm test             # tools + Node + Python test suites
corepack pnpm conformance      # cross-language conformance runner
corepack pnpm validate         # conformance + parity + static + tests + build
corepack pnpm release:check    # full release gate
corepack pnpm cli --help       # packaged public CLI from the local build
```

None of these send live Google Chat traffic. The packaged smoke uses
`RUN_LIVE_GOOGLECHATAI_SMOKE=1`; repository-maintainer smokes use
`RUN_LIVE_CHAT_SMOKE=1`. Both require a dedicated smoke space and user
authorization — see
[Live Smoke Safety](docs/guides/2026-06-29-live-smoke-safety.md) and the
[Live Chat Smoke Harness](docs/runbooks/2026-06-29-live-chat-smoke-harness.md).
Tenant-specific live QA ledgers are maintained privately outside this
repository.

## Documentation

Start here:

- [Docs Index](docs/README.md)
- [Public CLI And First App](docs/guides/2026-07-16-public-cli-and-first-app.md)
- [Architecture Overview](docs/guides/2026-06-29-architecture-overview.md)
- [Local Fixture Tests Quickstart](docs/guides/2026-06-29-local-fixture-tests-quickstart.md)

Feature guides:

- [Live Streaming](docs/guides/2026-07-06-live-streaming.md)
- [Inbound Request Verification](docs/guides/2026-07-06-inbound-request-verification.md)
- [Plan Execution](docs/guides/2026-07-06-plan-execution.md)
- [Router Event Coverage](docs/guides/2026-07-06-router-event-coverage.md)
- [Placeholder Responses](docs/guides/2026-07-04-placeholder-responses.md)
- [Async Response Kit](docs/guides/2026-07-04-async-response-kit.md)
- [Attachment Pipeline](docs/guides/2026-07-04-attachment-pipeline.md)
- [Drive Link Retrieval](docs/guides/2026-07-05-drive-link-retrieval.md)
- [Chat Link Retrieval](docs/guides/2026-07-05-chat-link-retrieval.md)
- [Passive Ingestion](docs/guides/2026-07-04-passive-ingestion.md)
- [Token Stores And Queues](docs/guides/2026-07-06-token-stores-and-queues.md)
- [Pins, Search, And Replace Cards](docs/guides/2026-07-06-pins-search-replace-cards.md)
- [Capability And Error Explainers](docs/guides/2026-07-04-capability-error-explainers.md)
- [Card Lint And Translation](docs/guides/2026-07-04-card-lint-and-translation.md)
- [Chat Doctor](docs/guides/2026-07-04-chat-doctor.md)
- [Evidence Tooling](docs/guides/2026-07-04-evidence-tooling.md)
- [Google Cloud Project Setup Quickstart](docs/guides/2026-06-29-cloud-project-setup-quickstart.md)

Product background:

- [Feature Inventory](docs/specs/2026-06-29-googlechatai-sdk-feature-inventory.md)
  (the broad product target — not a shipped-feature claim)

## Examples

- `examples/node-local-runtime/` — local webhook runtime accepting fixture
  POSTs ([walkthrough](docs/examples/2026-06-29-node-fixture-normalizer.md)).
- `examples/python-local/` — dependency-free Python runtime
  ([walkthrough](docs/examples/2026-06-29-python-fixture-normalizer.md)).
- `examples/python-fastapi/` — the optional FastAPI adapter.
- `examples/cloud-run-node-sdk/` — package-routed, verified, bounded-body
  Cloud Run reference ([guide](docs/guides/2026-07-10-production-hardening.md)).
- `examples/cloud-run-node/` — smoke-only Cloud Run webhook scaffold.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow,
[AGENTS.md](AGENTS.md) for repository rules that both humans and AI agents
follow (validation order, live-API boundaries, secrets policy), and
[SECURITY.md](SECURITY.md) for vulnerability reporting.

Two rules define this codebase more than any others:

1. Every new parser or orchestration behavior adds fixture coverage, and
   cross-language behavior is enforced by the shared conformance suite — the
   release gate fails if Node and Python drift.
2. AI context rendering is a core SDK surface: model-bound content must carry
   time, human-readable sender identity, relationship metadata, and explicit
   notes when something is truncated or inaccessible.

## Package Layout

```text
packages/node/       TypeScript package (googlechatai on npm)
packages/python/     Python package (googlechatai on PyPI)
spec/                Shared normalized schemas
fixtures/            Raw and expected event/message fixtures
conformance/         Cross-language behavior cases
discovery/           Curated Google Chat discovery metadata
tools/               Repository tooling (conformance, release gates, CLI)
docs/                Guides, specs, research, and architecture notes
examples/            Runnable local runtimes, Cloud Run reference, and smoke scaffold
```

## Trademark Note

googlechatai is an independent project and is not affiliated with or endorsed
by Google LLC. Google Chat is a trademark of Google LLC.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
Downstream distributions must retain the LICENSE and NOTICE attribution
notices per Apache-2.0 section 4.
