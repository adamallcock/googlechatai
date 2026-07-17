---
title: Public CLI And First App
date: 2026-07-16
type: guide
status: implemented
---

# Public CLI And First App

The `googlechatai` npm package includes a dependency-free CLI for the complete
public-beta workflow:

```text
init -> fixture -> inspect/replay -> doctor -> deploy -> guarded smoke
```

Only the final guarded smoke can write to Google Chat. All other commands are
offline, local-file-only, or explicitly read-only.

## Generate A Node App

```bash
npx googlechatai@next init my-chat-app --language node --install
cd my-chat-app
npm test
npm run fixture
npm run inspect
npm run card
npm run doctor
```

`init` creates:

- `src/app.mjs`, with minimal mention and message handlers;
- `src/server.mjs`, with bearer-token verification and a one-megabyte default
  request-body limit;
- a sanitized mention fixture and local test;
- `.env.example` and an ignore-safe local configuration boundary;
- `smoke-space.example.json`, whose safety attestations are required by the
  smoke command.

## Generate A Python App

The same CLI generates the stdlib-only Python package workflow:

```bash
npx googlechatai@next init my-python-chat-app --language python --install
cd my-python-chat-app
.venv/bin/python -m unittest
npx googlechatai@next inspect fixtures/mention.json
npx googlechatai@next card lint fixtures/card.json
npx googlechatai@next replay fixtures/mention.json \
  --language python \
  --python .venv/bin/python \
  --handler app.py \
  --expect-text "You said"
```

The Python callback server verifies Google's bearer token before reading the
event body and rejects oversized, malformed, or non-object JSON payloads.

## Understand An Event

```bash
npx googlechatai@next inspect fixtures/mention.json
npx googlechatai@next inspect fixtures/mention.json --format json
```

Inspection reports normalized event kind, actor state, message/space/thread
resources, reply routing, canonical conversation context, and the model-safe
projection. Raw input is omitted unless `--include-raw` is deliberately used.
Do not use that option when output may be shared.

## Replay A Handler

Node:

```bash
npx googlechatai@next replay fixtures/mention.json \
  --handler src/app.mjs \
  --expect-text "You said"
```

Python:

```bash
npx googlechatai@next replay fixtures/mention.json \
  --language python \
  --python .venv/bin/python \
  --handler app.py \
  --expect-text "You said"
```

An unmet `--expect-text` assertion exits nonzero, so the command can be used in
local scripts and CI.

## Inspect A Chat API Intent

For a direct reply-to-event plan:

```bash
npx googlechatai@next plan reply-to-event \
  --event fixtures/mention.json \
  --text "Working on it" \
  --format json
```

For other intents, put the corresponding SDK planner input in a JSON object:

```bash
npx googlechatai@next plan send-to-space --input send.json
npx googlechatai@next plan start-thread --input thread.json
npx googlechatai@next plan edit-message --input edit.json
npx googlechatai@next plan permission messages.list --principal user
```

`plan` never executes its output. It shows exact HTTP requests, the required
principal and scopes, warnings, and whether live execution is supported.

## Lint Cards

```bash
npx googlechatai@next card lint card.json
```

Invalid cards exit nonzero and include stable finding codes and JSON paths.

## Diagnose Configuration

```bash
npx googlechatai@next doctor
npx googlechatai@next doctor --strict
npx googlechatai@next doctor --probe
```

Doctor checks the project shape, Node runtime, numeric callback audience, app
user resource, service-account credential shape, endpoint URL, explicit Chat
registration attestation, dedicated smoke metadata, and optional
principal/capability compatibility. It does not print credential contents or
tokens. Network probing is opt-in with `--probe`.

## Manual Google Boundary

The CLI does not silently create or reconfigure tenant resources. Before a live
callback, an operator must:

1. create or select the Google Cloud project;
2. enable and configure the Google Chat API app;
3. deploy the generated callback on HTTPS;
4. set the exact `/chat/events` endpoint in Chat configuration;
5. complete any OAuth consent, administrator approval, and app installation;
6. create a dedicated smoke space named with the
   `Google Chat AI SDK Smoke` prefix and invite no real users.

Set `GOOGLE_CHAT_ENDPOINT_CONFIGURED=1` only after visually checking the exact
callback URL in Google Cloud.

## Guarded Live Smoke

Copy `smoke-space.example.json` to the ignored `smoke-space.local.json`, replace
the placeholders, and first inspect the no-write plan:

```bash
npx googlechatai@next smoke --metadata smoke-space.local.json
```

A live run additionally requires all of:

- `--live`;
- `RUN_LIVE_GOOGLECHATAI_SMOKE=1`;
- a short-lived `GOOGLE_CHAT_USER_ACCESS_TOKEN` authorized for
  `chat.spaces.readonly` and `chat.messages`;
- the app's `users/...` resource;
- metadata whose live space, name, type, safety attestations, and allowed
  operations match the dedicated smoke contract.

The live run creates one user-authorized mention, polls for an app reply in the
same triggering thread, and deletes the prompt. It does not DM anyone, invite
users, print the token or message text, or save raw payloads. Keep the OAuth
token out of repository files, `.env.local`, shell history, and captured logs.

For repository-maintainer diagnostics, evidence collection, and private-tenant
operations, use the separate repo commands documented in
[Chat Doctor](2026-07-04-chat-doctor.md) and
[Evidence Tooling](2026-07-04-evidence-tooling.md).
