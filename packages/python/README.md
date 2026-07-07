# googlechatai

googlechatai is a polyglot Google Chat AI SDK for building serious Google
Chat apps, AI assistants, and workflow extensions without living at the raw
REST-object layer. This is the Python package (standard library only, Python
3.10+); a matching Node.js package is published as `googlechatai` on npm,
kept behaviorally aligned through shared fixtures and cross-language
conformance tests.

Highlights:

- Deep normalization of Chat events, messages, actions, cards, and
  attachments into stable, model-ready structures.
- A webhook router with slash command, mention, reaction, membership, and
  dialog handlers, plus dedupe, deadline, and inbound request verification
  (Chat app bearer tokens and Pub/Sub push OIDC, verified with a
  stdlib-only RS256 implementation).
- Dry-run call plans for sends, replies, threads, reactions, and pins, and
  an executor that turns plans into real API calls with retries,
  idempotency, and explicit live-mode safety gates.
- Live streaming of model output through message edits via
  `stream_chat_reply` / `astream_chat_reply`, driven by a deterministic
  scheduler with patch cadence, size-limit truncate/split, cancellation,
  and resume.
- AI-first helpers: conversation context builders, attachment pipelines,
  placeholder responses, async response handoff, token stores, and queue
  adapters. Optional FastAPI/ASGI adapters install with
  `pip install "googlechatai[fastapi]"`.

Status: early development (0.0.x). APIs may change between minor versions
while the SDK stabilizes.

googlechatai is an independent project and is not affiliated with or
endorsed by Google LLC. Google Chat is a trademark of Google LLC.

Licensed under the Apache License 2.0. See LICENSE and NOTICE.
