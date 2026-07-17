---
title: Architecture Overview
date: 2026-06-29
type: guide
status: draft
---

# Architecture Overview

This overview distills the feature inventory into a contributor map. The full
source spec is
[Google Chat AI SDK Feature Inventory](../specs/2026-06-29-googlechatai-sdk-feature-inventory.md).

## Status Labels

- Implemented: code and tests exist in this repository.
- Scaffolded: files, scripts, docs, or examples exist, but the behavior is not
  complete.
- Planned: the feature is described in specs or workstreams but not shipped.
- Blocked: the feature needs a manual setup step, external verification, or
  another workstream before it can be completed.

## Current Implemented Slice

The repository currently implements a broad local and dry-run foundation:

- Shared schemas in `spec/`.
- Shared fixtures and expected outputs for actions, events, messages, cards,
  attachments, context, and Workspace Events.
- Node and Python normalizers/parsers for events, messages, actions, cards,
  attachments, and Workspace Events.
- Node and Python card response builders for add-on card action envelopes:
  update message, create message, and open dialog via `pushCard`.
- Node and Python runtime routers and local fixture POST examples.
- Dry-run send/reply/thread/stream planners and mocked context readers.
- Shared Node and Python transport helpers for retry, user-auth refresh, replay
  safety, structural idempotency contracts, local stores, and injected
  Firestore compare-and-set reference stores.
- A package-routed Cloud Run reference that uses verified Fetch routing and a
  bounded request body, alongside the older smoke-only scaffold.
- Model-safe context projection with trust/provenance labels, pagination-token
  exclusion, default email redaction, and attachment scanner/resource seams.
- Guarded live-safe Cloud, Pub/Sub, Workspace Events, and Chat smoke tooling.
- A discovery metadata check for the curated Google Chat v1 method snapshot and
  stable request-contract fingerprints.
- Live evidence from the private live test tenant's smoke workspace, including
  app/user auth, message lifecycle, Cards V2, threads, media downloads, Drive
  export, reactions, context reads, and cleanup.

## Three-Layer Target Architecture

Layer 1: raw and typed Google Chat client.

- Status: partially implemented, with discovery metadata and shared transport
  retry/idempotency helpers scaffolded.
- Purpose: expose typed request/response objects, pagination, retries,
  scope-aware errors, discovery version reporting, and passthrough access.
- Current repo evidence: `discovery/google-chat-v1-20260705.methods.json` and
  `tools/discovery/check-methods.mjs`.
- Auth and retry boundary: see
  [Auth Principal And Resilient Transport](../architecture/2026-06-30-auth-principal-resilience.md).

Layer 2: intent primitives.

- Status: partially implemented as dry-run planners, local helpers, and guarded
  live smoke clients for the currently verified subset.
- Purpose: provide developer-shaped operations such as send to user, reply in
  thread, stream via message edits, download attachments, build cards, open
  dialogs, resolve users, add reactions, and pin messages.
- Current repo evidence: message/thread planners, attachment planners,
  card/dialog helpers, shared fixtures, and conformance cases. Live execution
  still requires the guarded smoke harness.

Layer 3: AI application framework.

- Status: partially implemented for local routing and fixture replay.
- Purpose: provide routers, context builders, state/queue adapters, model
  streaming bridges, tool progress cards, approval flows, attachment
  understanding, safe-send policies, fixture replay, and observability.
- Current repo evidence: `GoogleChatAI` runtime routers, local examples,
  normalized event/message/action/card/attachment/context fixtures, and AI
  context requirements docs.

## Shared Contracts

The repo should use shared contracts to prevent Node and Python drift:

- JSON Schemas in `spec/`.
- Raw fixtures in `fixtures/`.
- Expected normalized outputs in `fixtures/expected/`.
- Conformance cases in `conformance/cases/`.
- Language tests that prove both packages return the same canonical JSON.

Every new parser, context renderer, send primitive, attachment handler, card
handler, or orchestration behavior should add or update fixture coverage.

## Current Scaffolded Areas

- `conformance/`: a full Node/Python runner executes active context-render and
  model-safe context cases alongside the other shared contracts.
- `examples/cloud-run-node/`: smoke-only Cloud Run webhook scaffold with
  `/api/healthz`, `/api/avatar.png`, and `/api/chat/events`.
- `examples/cloud-run-node-sdk/`: canonical package-routed Cloud Run reference
  with a verified `/chat/events` boundary and local-fixture escape hatch.
- `tools/cloud/` and `tools/chat/`: live smoke scripts exist and should only be
  run inside the safety boundary.
- `docs/runbooks/`: cloud setup notes exist, with manual gates documented.

## Planned Workstream Map

- W0: cloud and Chat app readiness.
- W1: shared contracts and conformance runner.
- W2: event normalization.
- W3: message AST.
- W4: action and form AST.
- W5: Node runtime router and Node runnable examples.
- W6: Python runtime router and Python runnable examples.
- W7: live Chat smoke harness.
- W8: attachments, media, and optional transcription.
- W9: send, reply, thread, and stream.
- W10: cards and dialogs.
- W11: Workspace Events and Pub/Sub.
- W12: docs, examples, and developer experience.
- W13: CI, release, and repository hygiene.

## Blocked Or Unverified Areas

- Google Chat app configuration is still manual for new workspaces.
- Production token storage, tenant authorization, and selection/configuration
  of a multi-instance durable idempotency store remain application decisions;
  the injected Firestore reference store is available as a starting point.
- App-auth space creation is diagnostic-only and should not become the default
  chatbot install model.
- Direct `spaces.spaceEvents.list` is currently blocked by Google API `500`
  responses in the private live test tenant.
- Docs-listed methods such as replace cards, search, and message pins still
  need generated-client and live verification before being called shipped SDK
  features.
- Voice-note transcription has disabled-by-default helper coverage and optional
  provider hooks, but real provider package calls need explicit model/API
  approval and separate live harnesses.

## Contribution Rule Of Thumb

If a feature touches behavior visible to developers, add the shared fixture
first or in the same change. If a feature requires live Google auth, keep the
local fixture path useful so contributors can validate most behavior without
DMs, real spaces, or external calls.
