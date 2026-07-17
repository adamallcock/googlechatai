# googlechatai

googlechatai is a polyglot Google Chat AI SDK for building serious Google
Chat apps, AI assistants, and workflow extensions without living at the raw
REST-object layer. This is the Node.js package; a matching Python package is
published as `googlechatai` on PyPI, kept behaviorally aligned through shared
fixtures and cross-language conformance tests.

Highlights:

- Deep normalization of Chat events, messages, actions, cards, and
  attachments into stable, model-ready structures.
- A webhook router with slash command, mention, reaction, membership, and
  dialog handlers, plus dedupe, deadline, and inbound request verification
  (Chat app bearer tokens and Pub/Sub push OIDC).
- Dry-run call plans for sends, replies, threads, reactions, and pins, and an
  executor that turns plans into real API calls with retries, idempotency,
  and explicit live-mode safety gates.
- Live streaming of model output through message edits, driven by a
  deterministic scheduler with patch cadence, size-limit truncate/split,
  cancellation, and resume.
- AI-first helpers: conversation context builders, attachment pipelines,
  placeholder responses, async response handoff, token stores, and queue
  adapters.

Status: `0.1.0-beta.1` public-beta release candidate. APIs may change before
the stable `0.1.0` release.

## Create a first app

The package includes the dependency-free `googlechatai` CLI:

```bash
npx googlechatai@next init my-chat-app --language node --install
cd my-chat-app
npm test
npm run fixture
npm run inspect
npm run doctor
```

The generated app includes a minimal mention handler, verified and
body-bounded callback server, sanitized fixture, test, environment template,
and guarded smoke metadata example. Offline tests need no Google credentials.

The CLI also exposes:

```text
inspect      normalize an event and explain reply/context decisions
replay       execute a fixture through a Node or Python handler
plan         print an exact dry-run Google Chat request plan
card lint    validate cards and action responses
doctor       diagnose local setup without printing secrets
smoke        verify mention/thread behavior in a dedicated space
```

All commands are offline or read-only by default. `smoke --live` is the only
write-capable command and refuses to run without explicit environment and
dedicated-space metadata guards.

Google Cloud project creation, Chat app registration, deployment, OAuth/admin
approval, and installation remain operator steps.

googlechatai is an independent project and is not affiliated with or endorsed
by Google LLC. Google Chat is a trademark of Google LLC.

Licensed under the Apache License 2.0. See LICENSE and NOTICE.
