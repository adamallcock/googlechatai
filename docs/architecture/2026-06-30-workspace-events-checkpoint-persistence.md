---
title: Workspace Events Checkpoint Persistence
date: 2026-06-30
type: decision-record
status: draft
---

# Workspace Events Checkpoint Persistence

## Decision

Keep checkpoint persistence behind a small SDK-owned store interface and treat Pub/Sub checkpoint data as an opaque cursor plus audit metadata. The default SDK surface should support:

- In-memory checkpoints for tests and local examples.
- A local JSON file adapter for developer smoke runs.
- Production adapters supplied by the application for SQLite, Postgres, Redis, Cloud SQL, Firestore, or another durable store.

Do not couple the core parser to one database. Pub/Sub delivery, Workspace event identity, and application replay policy should remain independent from storage selection.

## Checkpoint Shape

Every Pub/Sub-normalized event carries:

- `type`: currently `pubsub`.
- `cursor`: stable subscription/message cursor.
- `ackId`: present for pull delivery and absent for push delivery.
- `messageId`: Pub/Sub message ID.
- `subscription`: Pub/Sub subscription resource or configured subscription ID.
- `publishTime`: Pub/Sub publish timestamp.
- `deliveryAttempt`: delivery attempt when provided.
- `orderingKey`: Pub/Sub ordering key when provided.

The cursor is not a secret, but raw Pub/Sub messages can contain private Chat content. Store checkpoint metadata separately from raw payload archives unless a retention policy explicitly allows raw payload retention.

## Persistence Contract

Language packages should expose the same semantic contract:

```text
load(scope) -> checkpoint | null
save(scope, checkpoint) -> void
```

`scope` should usually be the Pub/Sub subscription resource name. Applications that shard by tenant, app, or Workspace customer can include that boundary in the scope.

## Ack Policy

For synthetic smoke runs, auto-ack is acceptable because messages are disposable.

For real Workspace Events subscriptions:

- Persist the normalized event or application work item before acking.
- Persist the checkpoint before or atomically with ack success when practical.
- If ack fails, allow Pub/Sub redelivery and rely on `eventId` / `idempotencyKey`.
- Treat repeated delivery of the same Workspace event ID as expected behavior, not as a parser error.

## Storage Guidance

Recommended defaults by environment:

- Unit tests: in-memory store.
- Local smoke: JSON file store.
- Small single-process service: SQLite with one row per scope.
- Multi-instance service: Postgres, Cloud SQL, Redis, Firestore, or another transactional/shared store.
- Compliance-sensitive service: store only cursor metadata by default; keep raw payload capture opt-in, encrypted, access-controlled, and time-limited.

## Open Follow-Ups

- Add replay tests that prove duplicate Pub/Sub messages are idempotent by Workspace event ID.
- Add production adapter examples once the first runtime router lands.
