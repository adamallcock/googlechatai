---
title: Conformance
date: 2026-06-29
type: reference
status: draft
---

# Conformance

Conformance cases define behavior that every language package must share.

Each runnable case points at:

- A raw input fixture.
- An expected normalized output.
- Optional mocked API responses.
- Optional expected API call plans.

The runnable bootstrap is dependency-free JSON. The product spec still leaves
room for YAML once a shared parser/tooling layer exists.

Run all active conformance cases from the repository root:

```bash
pnpm conformance
```

`pnpm conformance` builds the Node package, runs Node and Python against every
active action, event, message, message/thread-planning, context render,
attachment, card, Chat-link, ingestion, capability, and reaction case, and
compares each language output to the same expected JSON. Recursive `ai_context`
contract cases are schema and shape checks for the canonical context document
shape.

## Canonical JSON Rules

- Case IDs are stable dotted names, for example `events.message-created.plain`.
- Raw Google payload fixtures stay under `fixtures/`.
- Expected normalized output stays under `fixtures/expected/`.
- Case files under `conformance/cases/` are arrays so agents can append cases
  without inventing a new format.
- Active cases must be deterministic and must not make live Google calls.
- `context.contract` cases are schema/shape contracts for recursive
  `ai_context` documents. Runtime renderer cases should declare an executable
  `operation` such as `context.render`.
- Normalized JSON uses camelCase keys in both Node and Python so expected
  fixture files can be shared byte-for-byte after JSON parsing.
- Unknown or inaccessible data should be represented explicitly as `null`,
  empty arrays, or an explanatory status field; do not omit important ambiguity.

## Case Format

```json
{
  "id": "events.message-created.basic",
  "description": "Parse a Google Chat message event into the normalized event envelope.",
  "input": {
    "fixture": "fixtures/events/message-created/basic.json",
    "source": "fixture"
  },
  "expect": {
    "fixture": "fixtures/expected/events/message-created.basic.json"
  }
}
```

Case IDs beginning with `actions.` call action normalization. Case IDs beginning
with `events.` call event normalization. Case IDs beginning with `messages.`
either call the message AST parser or the message/thread planner specified by
the case operation. Case IDs beginning with `context.` are shared AI context
contract or render cases. Case IDs beginning with `cards.`, `attachments.`,
`chatLinks.`, `ingestion.`, `capabilities.`, and `reactions.` call the matching
high-level SDK helper operations.

- `fixture`: required raw input fixture path.
- `source`: optional event/action source override.
- `receivedAt`: optional deterministic receive time override for event cases.

Workspace Events and Pub/Sub checkpoint fixtures are also covered by dedicated
Node and Python tests because pull ingestion returns one parsed event per Pub/Sub
message plus checkpoint metadata.
