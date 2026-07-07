---
title: Repository Architecture
date: 2026-06-29
type: decision-record
status: draft
---

# Repository Architecture

## Decision

Use a polyglot monorepo with native Node.js and Python packages backed by shared contracts, fixtures, and conformance tests.

## Rationale

The core product risk is semantic drift between languages. A generated one-language binding would move quickly at first but would make one ecosystem feel secondary. Instead, the repository separates shared behavior contracts from language-native implementation.

## Structure

- `spec/` contains SDK-owned normalized schemas.
- `fixtures/` contains raw Google Chat payloads and expected normalized outputs.
- `conformance/` contains language-agnostic behavior cases.
- `packages/node/` contains the TypeScript package.
- `packages/python/` contains the Python package.
- `discovery/` contains curated Google Chat discovery metadata.
- `tools/` contains maintenance scripts.
- `docs/` contains research, specs, and architecture notes.

## Validation Policy

Every parser or orchestration feature should land with:

- A raw fixture when possible.
- An expected normalized output.
- A conformance case.
- Node tests.
- Python tests.

No release should ship if Node and Python disagree on a conformance case.
