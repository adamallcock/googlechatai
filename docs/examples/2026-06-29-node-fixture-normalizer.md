---
title: Node Fixture Normalizer Example
date: 2026-06-29
type: note
status: draft
---

# Node Fixture Normalizer Example

This is the currently implemented Node example surface: parse a local Google
Chat event fixture into the shared normalized event envelope.

## Status

- Implemented: `googlechatai` exports `normalizeEvent` and additional
  local/dry-run helpers for actions, messages, attachments, cards, runtime
  routing, thread context, and Workspace Events.
- Implemented: Node tests read shared fixtures and expected outputs.
- Implemented: `examples/node-local-runtime` accepts local fixture POSTs.
- Planned: inbound Google request verification and live send/reply execution
  beyond the guarded smoke harness.

## Test The Existing Example

```bash
pnpm test:node
```

The test file is:

```text
packages/node/test/events.test.ts
```

## Use The Built Package Against A Fixture

Build first:

```bash
pnpm build
```

Then run a local fixture parse without any live Google calls:

```bash
node --input-type=module <<'JS'
import fs from "node:fs";
import { normalizeEvent } from "./packages/node/dist/index.js";

const raw = JSON.parse(
  fs.readFileSync("fixtures/events/message-created/basic.json", "utf8"),
);

console.log(JSON.stringify(normalizeEvent(raw, { source: "fixture" }), null, 2));
JS
```

## API Shape Available Today

```ts
import { normalizeEvent } from "googlechatai";

const event = normalizeEvent(rawGoogleChatEvent, {
  source: "fixture",
});

console.log(event.kind);
console.log(event.message?.plainTextForModel);
```

## Current Limitations

Do not present the following as shipped Node SDK behavior yet:

- Google Chat request verification.
- Live send, reply, thread, or streaming execution outside W7.
- Live attachment download, upload, extraction, or transcription execution.
- Production auth token refresh/retry transport.
