---
title: Evidence Tooling
date: 2026-07-04
type: guide
status: implemented
---

# Evidence Tooling

`chat:evidence` is repository-maintainer tooling for turning local or guarded
live Chat debugging into redacted, replayable evidence. Package users can
inspect and replay already-sanitized fixtures with
`npx googlechatai@next inspect` and `npx googlechatai@next replay`; raw live
recording stays behind this stricter repository privacy boundary.

## Dry-Run Collection Plan

```bash
corepack pnpm chat:evidence collect -- --dry-run --since 10m
```

The dry-run command performs no network, file, or Chat side effects. It returns
a plan for the existing diagnostic commands that would be used in a guarded live
collection:

- `chat:doctor -- --setup-bundle`
- `live:chat-log-smoke`

Live collection is guarded separately:

```bash
RUN_LIVE_CHAT_EVIDENCE=1 corepack pnpm chat:evidence collect -- --since 2026-07-04T12:00:00Z
```

Live output stores only command status plus stdout/stderr length and hashes. It
does not persist raw command output.

## Record A Fixture

```bash
corepack pnpm chat:evidence record -- \
  --input raw-event.local.json \
  --output fixtures/live/evidence/event.recorded.json
```

Recorder output preserves replayable structure:

- event type, top-level keys, and message/action presence;
- attachment counts, MIME types, size fields, and source fields;
- form/action keys and action method;
- auth availability as a boolean;
- redacted text placeholders with length and hash signals.

Recorder output removes private material:

- authorization headers, access tokens, refresh tokens, private keys, OAuth
  codes, and other secret-looking fields;
- raw message text, formatted text, display names, titles, labels, and form
  values;
- sender/user emails;
- private URLs and filenames;
- raw attachment bytes and base64 payloads.

## Replay A Fixture

```bash
corepack pnpm chat:evidence replay -- \
  --fixture fixtures/live/evidence/event.recorded.json
```

Replay loads the redacted fixture, normalizes it with the built Node package and
the Python package, and reports:

- `nodePythonEqual`;
- fixture id and normalized kind/source summary;
- message text length/hash rather than raw text;
- normalized output hashes for mismatch triage.

This makes evidence files useful as regression fixtures without turning the repo
into a private data store.

## Privacy Contract

`chat:evidence` is intentionally conservative:

- raw tokens are not saved;
- raw private Chat payloads are not saved;
- raw message text and formatted text are not saved;
- sender emails are not saved;
- form values are not saved;
- attachment bytes are not saved.

For live debugging, keep evidence under ignored local paths such as
`fixtures/live/evidence/` or `artifacts/live/`. Public conformance fixtures
should be synthetic or derived from redacted evidence after a review pass.
