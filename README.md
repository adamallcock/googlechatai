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
npm install googlechatai        # Node.js 22+
pip install googlechatai        # Python 3.10+ (stdlib only)
```

Status: early development (0.0.x). The local, dry-run, and verification
surfaces are extensively tested; live-API wrappers are exercised against a
private test tenant. APIs may change between minor versions while the SDK
stabilizes.

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
  the same contracts, pinned by 180+ shared conformance cases that run both
  runtimes against identical fixtures on every change.

## Quickstart: a verified webhook that streams replies

Node.js:

```ts
import {
  GoogleChatAI,
  createChatRequestVerifier,
  createChatRequestApplier,
  executeChatPlan,
  hydratePlaceholderResponseHandle,
  planPlaceholderResponse,
  streamChatReply,
} from "googlechatai";

const auth = { getAccessToken: async () => ({ accessToken: await appToken() }) };

const chat = new GoogleChatAI({
  appUser: { name: "users/YOUR_APP_USER_ID" },
  verifier: createChatRequestVerifier({ audience: "YOUR_PROJECT_NUMBER" }),
});

chat.onMention(async (event, ctx) => {
  // Acknowledge instantly, then stream the model's answer by editing
  // one placeholder message.
  const plan = planPlaceholderResponse({ event });
  const created = await executeChatPlan(plan, { mode: "live", auth });
  const handle = hydratePlaceholderResponseHandle(
    plan.placeholder.handle,
    created.createdMessages[0],
  );

  void streamChatReply(handle, model.stream(event.message.argumentText), {
    apply: createChatRequestApplier({ auth }),
  });

  return ctx.json({}); // empty 200 — the placeholder already answered
});

export default { fetch: (request: Request) => chat.fetch(request) };
```

Python:

```python
from googlechatai import (
    GoogleChatAI,
    create_chat_request_applier,
    create_google_chat_token_verifier,
    stream_chat_reply,
)
from googlechatai.adapters.asgi import ASGIAdapter

chat = GoogleChatAI(app_user={"name": "users/YOUR_APP_USER_ID"})

@chat.on_mention
def handle(context):
    return {"text": f"You said: {context.event['message']['argumentText']}"}

app = ASGIAdapter(
    chat,
    verifier=create_google_chat_token_verifier(audience="YOUR_PROJECT_NUMBER"),
)
```

Every write in the SDK is inspectable before it happens — call any
`plan*` function without an executor and you get the exact requests,
required scopes, and safety notes as JSON.

## Feature Overview

| Area | What you get |
|---|---|
| Event handling | One normalized envelope for HTTP, Pub/Sub, and Workspace Events payloads; router registrations for messages, mentions, slash commands (by name), cards, dialogs, reactions, memberships, space add/remove, widget updates, and link previews; dedupe and deadline options |
| Request verification | Chat app bearer JWTs and Pub/Sub push OIDC tokens, JWKS caching, offline test fixtures |
| Messages | Send/reply/thread/edit/delete planners with typed inputs, reply-target routing policies, placeholder responses, async response handoff, message search and replace-cards (docs-listed) |
| Streaming | `streamChatReply` / `stream_chat_reply` / `astream_chat_reply` with shared scheduler semantics, final-card attachment, cancellation registries, resumable state |
| Cards and dialogs | Typed builders (approval, progress, error, sources, thinking, tool status, feedback), card lint/translation, action-state round-tripping, dialog helpers |
| Attachments | Metadata normalization, download/upload plans, policy gates, parser hooks, Drive export plans, optional OpenAI/Gemini voice transcription providers |
| Context for AI | Thread/space readers, recursive quoted-message context, identity resolution with explicit unavailability, system notes for attachments/quotes/actions |
| Reactions and pins | Reaction planners with feedback mapping, message pin planners (docs-listed) |
| Transport | Retry/backoff with Retry-After, 401 refresh-and-replay, idempotency stores, token stores (file, Secret Manager), queue adapters (Cloud Tasks, Pub/Sub, file) |
| Capabilities | `explainChatCapability`, permission plans, and error explainers for 401/403/404/429/5xx remediation |

## Current State

Implemented and conformance-tested: everything in the feature overview above.
Both packages pass 180+ shared conformance cases, 890+ unit tests, export and
router-method parity checks, and a strict release gate on every change.

Scaffolded: Cloud Run webhook example, recursive `ai_context` schema
contracts, cloud project runbooks.

Planned: custom emoji management, admin/import operations, scheduled
idempotency/retention runners, richer live parser/provider harnesses.

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
corepack pnpm cli --help       # repo CLI: doctor, card-lint, evidence, drift
```

None of these send live Google Chat traffic. Live smokes are explicitly
guarded (`RUN_LIVE_CHAT_SMOKE=1`, a dedicated smoke space, per-user OAuth)
and target only a dedicated test space — see
[Live Smoke Safety](docs/guides/2026-06-29-live-smoke-safety.md) and the
[Live Chat Smoke Harness](docs/runbooks/2026-06-29-live-chat-smoke-harness.md).
Tenant-specific live QA ledgers are maintained privately outside this
repository.

## Documentation

Start here:

- [Docs Index](docs/README.md)
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
- `examples/cloud-run-node/` — a scaffolded Cloud Run webhook.

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
examples/            Runnable local runtimes and a Cloud Run scaffold
```

## Trademark Note

googlechatai is an independent project and is not affiliated with or endorsed
by Google LLC. Google Chat is a trademark of Google LLC.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
Downstream distributions must retain the LICENSE and NOTICE attribution
notices per Apache-2.0 section 4.
