---
title: Evidence Tooling Implementation Plan
date: 2026-07-04
type: plan
status: implemented-slice
---

# Evidence Tooling Implementation Plan

## Status

Implemented before this slice:

- Guarded live smoke tools write redacted evidence under ignored paths.
- `chat:doctor` writes redacted setup/interaction evidence.
- `live:chat-log-smoke` summarizes Cloud Logging without raw payloads.
- Shared conformance replays public fixtures through Node and Python.

Implemented in this F8 slice:

- `chat:evidence collect --dry-run` planning surface.
- Recorder helpers that redact raw Chat payloads while preserving replayable
  structure, hashes, lengths, counts, resource shapes, event type, action
  method, and auth availability.
- Replay helper that runs a recorded fixture through Node and Python event
  normalization and reports parity.
- Tool tests proving token/text/email/form redaction and replay parity.

Planned follow-ups:

- Guarded live `chat:evidence collect` that orchestrates doctor/log smokes and
  bundles evidence from existing ignored paths.
- CI matrix generator for direct event, add-on envelope, card click, dialog,
  upload, async placeholder, duplicate delivery, retry, and rate-limit fixtures.
- Browser/Chat UI screenshot ingestion with local-only screenshot redaction
  policy.

## Problem

The repo already has strong private evidence discipline, but it is spread across
many smoke tools and local reports. Developers need a product surface that can
collect, redact, replay, and explain evidence without leaking tokens, raw
message text, sender emails, attachment bytes, form values, or private payloads.

## Public Tooling

```bash
corepack pnpm chat:evidence collect -- --dry-run --since 10m
corepack pnpm chat:evidence replay -- --fixture fixtures/live/evidence/example.recorded.json
```

## Redaction Contract

Recorder output must preserve:

- top-level event shape and event type;
- resource names as hashes or stable placeholders;
- text/form/url/email values as redacted placeholders plus length/hash metadata;
- attachment/file counts, MIME types, size fields, source flags, and byte-hash
  summaries without raw bytes;
- auth/token availability as booleans, not secret values;
- enough structure for Node/Python normalizers to parse the fixture.

Recorder output must remove:

- access tokens, refresh tokens, private keys, authorization headers, OAuth
  codes, raw message text, sender emails, form values, URLs with private
  parameters, attachment bytes, and binary/base64 payloads.

## Replay Contract

Replay loads a recorded fixture, normalizes the redacted payload in Node and
Python, and reports:

- `nodePythonEqual`;
- event ids/kinds/sources;
- normalized output hashes;
- any mismatch without raw payload material.

## Completion Criteria

- `chat:evidence collect --dry-run` performs no file/network side effects.
- Redaction tests prove sensitive strings are absent.
- Replay tests prove Node/Python parity on a recorded redacted fixture.
- Docs, validate, discovery, release, and whitespace checks pass before commit.
