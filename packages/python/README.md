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

Status: `0.1.0-beta.1` public-beta release candidate (published Python
metadata normalizes this to `0.1.0b1`). APIs may change before the stable
`0.1.0` release.

## Create a first app

The matching Node distribution carries the dependency-free CLI and generates
Python projects:

```bash
npx googlechatai@next init my-python-chat-app --language python --install
cd my-python-chat-app
.venv/bin/python -m unittest
npx googlechatai@next replay fixtures/mention.json \
  --language python \
  --python .venv/bin/python \
  --handler app.py \
  --expect-text "You said"
npx googlechatai@next doctor
```

The generated app includes a minimal mention handler, verified and
body-bounded callback server, sanitized fixture, test, environment template,
and guarded smoke metadata example. Offline tests need no Google credentials.

The CLI also provides event inspection, dry-run Chat request planning, card
linting, and configuration diagnosis. It is offline or read-only by default;
the only write-capable path is an explicitly guarded `smoke --live` run in a
dedicated test space.

Google Cloud project creation, Chat app registration, deployment, OAuth/admin
approval, and installation remain operator steps.

googlechatai is an independent project and is not affiliated with or
endorsed by Google LLC. Google Chat is a trademark of Google LLC.

Licensed under the Apache License 2.0. See LICENSE and NOTICE.
