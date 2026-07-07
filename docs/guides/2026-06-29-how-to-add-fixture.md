---
title: How To Add A Fixture
date: 2026-06-29
type: guide
status: draft
---

# How To Add A Fixture

Every parser or orchestration behavior should be backed by a shared fixture so
Node and Python stay semantically aligned.

## Status

- Implemented: event fixtures, expected normalized outputs, and an active
  conformance runner for Node and Python event parsing.
- Scaffolded: contract-only AI context fixtures for downstream context-rendering
  workstreams.

## Fixture Checklist

1. Add a raw fixture under the smallest meaningful family:

   ```text
   fixtures/events/<event-family>/<case-name>.json
   ```

2. Add the expected normalized output:

   ```text
   fixtures/expected/events/<event-family>.<case-name>.json
   ```

3. Add or update a conformance case in:

   ```text
   conformance/cases/events.parse.json
   ```

4. Add Node test coverage in:

   ```text
   packages/node/test/
   ```

5. Add Python test coverage in:

   ```text
   packages/python/tests/
   ```

6. Run validation:

   ```bash
   pnpm conformance
   pnpm test
   pnpm build
   pnpm discovery:check
   ```

## Naming Rules

- Use stable, descriptive fixture IDs such as
  `events.message-created.basic`.
- Keep raw Google payloads raw. Normalize only in expected output files.
- Redact private content before committing fixtures.
- Prefer small fixtures that prove one behavior at a time.
- Preserve raw payload access requirements in expected output when applicable.

## Required Coverage For New Behavior

For event/message parsing, expected output should cover:

- Event identity and source.
- Actor, sender, space, thread, and message refs.
- Timestamps and update/delete markers.
- Relationship metadata such as thread reply, direct/private reply, quote,
  reaction, card action, or deletion.
- Human-readable identity fields when available.
- Inaccessibility or ambiguity notes when identity cannot be resolved.
- Attachment metadata and extraction/transcription status when attachments are
  present.
- AI-facing system notes for quotes, replies, reactions, card actions, and
  attachments when context rendering is touched.

For AI context fixtures, expected output must include explicit notes for:

- Time and ordering.
- Sender or actor identity.
- Recursive quoted-message nesting.
- Attachment metadata before extracted content.
- Extraction or transcription status.
- Direct reply and thread reply relationships.
- Reactions and card actions.
- Room/thread history bounds, truncation, and inaccessible history.

## Do Not Weaken Tests

If a fixture exposes a bug, fix the source behavior or narrow the expected
behavior with an explicit documented limitation. Do not delete assertions or
remove fixture fields just to make the suite pass.
