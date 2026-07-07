---
title: Local Fixture Tests Quickstart
date: 2026-06-29
type: guide
status: draft
---

# Local Fixture Tests Quickstart

This guide is for contributors and agents who want to verify the current SDK
without making any live Google calls.

## Status

- Implemented: shared fixtures for actions, events, messages, cards,
  attachments, context, and Workspace Events.
- Implemented: Node.js and Python tests over the shared fixtures.
- Implemented: cross-language conformance runner in `tools/conformance/run.mjs`.
- Implemented: local Node and Python runtime examples that accept fixture POSTs.

## Prerequisites

- Node.js 20 or newer.
- pnpm 11.9.0 or compatible.
- Python 3.10 or newer.

Install workspace dependencies from the repository root:

```bash
pnpm install --frozen-lockfile
```

## Run The Smallest Useful Checks

Run both language test suites:

```bash
pnpm test
```

Run only the Node fixture test:

```bash
pnpm test:node
```

Run only the Python fixture test:

```bash
pnpm test:python
```

Build the Node package:

```bash
pnpm build
```

Check the curated Google Chat discovery metadata:

```bash
pnpm discovery:check
```

Check Markdown relative links:

```bash
pnpm docs:check
```

## Fixture Files

Representative raw event fixture:

```text
fixtures/events/message-created/basic.json
```

Expected normalized output:

```text
fixtures/expected/events/message-created.basic.json
```

Conformance case descriptors:

```text
conformance/cases/*.json
```

Node test:

```text
packages/node/test/events.test.ts
```

Python test:

```text
packages/python/tests/test_events.py
```

## What The Current Fixtures Prove

The current fixtures verify that Node and Python agree on these normalized
surfaces:

- Event identity, source, transport, kind, raw kind, and idempotency keys.
- Actor, space, thread, sender, membership, reaction, action, and message refs.
- Message AST fields, annotations, links, commands, attachments, quotes,
  deleted/private/thread metadata, GIFs, cards, and model-ready text.
- Action/form parsing for card clicks, dialogs, widget updates, slash commands,
  and app commands.
- Attachment metadata normalization, dry-run media plans, parser hooks, and
  disabled-by-default transcription behavior.
- Card/dialog builders, validation, inbound summaries, and AI-facing card
  action notes.
- Thread/space context planning with date filters, limits, pagination,
  ordering, truncation, inaccessible-history notes, quotes, and attachments.
- Workspace Events and Pub/Sub wrapper parsing.

## What It Does Not Prove Yet

Local fixtures do not prove Google-side live sends, live media downloads or
uploads, real Workspace Events subscriptions, inbound request verification,
production token refresh/retry behavior, reactions as workflow input, pins,
admin/import operations, or user-account read-state/notification operations.
Add shared fixtures and expected outputs before claiming any new local behavior,
and use the guarded W7 live harness before claiming live Chat writes.
