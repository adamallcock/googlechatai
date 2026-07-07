---
title: Passive Ingestion
date: 2026-07-04
type: guide
status: implemented-slice
---

# Passive Ingestion

Passive ingestion lets a Chat app observe selected-space activity without
depending only on `@mentions`. The SDK models four modes:

- `direct_interaction`: normal Chat HTTP events delivered to the app endpoint.
- `workspace_events_push`: Workspace Events delivered through Pub/Sub push.
- `workspace_events_pull`: Workspace Events pulled from a Pub/Sub subscription.
- `polling`: read-only fallback using `spaces.messages.list`.

This slice implements dry-run planning for all four modes and polling-page
processing. It does not create live Workspace Events subscriptions or run a
production polling loop.

## Node

```ts
import {
  planChatIngestion,
  processPollingIngestionPage,
} from "googlechatai";

const plan = planChatIngestion({
  mode: "polling",
  authMode: "user",
  space: "spaces/AAA",
  startTime: "2026-07-04T00:00:00Z",
  pageSize: 100,
  showDeleted: true,
});

const batch = processPollingIngestionPage({
  space: "spaces/AAA",
  receivedAt: new Date().toISOString(),
  response,
  checkpoint,
});
```

## Python

```python
from googlechatai import plan_chat_ingestion, process_polling_ingestion_page

plan = plan_chat_ingestion({
    "mode": "polling",
    "authMode": "user",
    "space": "spaces/AAA",
    "startTime": "2026-07-04T00:00:00Z",
    "pageSize": 100,
    "showDeleted": True,
})

batch = process_polling_ingestion_page({
    "space": "spaces/AAA",
    "receivedAt": received_at,
    "response": response,
    "checkpoint": checkpoint,
})
```

## Planning

`planChatIngestion` / `plan_chat_ingestion` returns:

- `capability`: auth mode, required scopes, membership/admin requirements, and
  read/write posture.
- `requests`: dry-run Google API calls required by the mode.
- `setupChecks`: Workspace Events API, Pub/Sub topic, publisher IAM,
  subscription, and lifecycle checks for Workspace Events modes.
- `checkpoint`: cursor scope and current token/high-watermark metadata.
- `idempotency`: duplicate-key strategy for polling snapshots.
- `warnings`: mode-specific limitations.

Polling defaults to user auth and
`https://www.googleapis.com/auth/chat.messages.readonly`. App-auth polling is
represented as administrator-approval-required and public-message-only.

## Polling Output

`processPollingIngestionPage` / `process_polling_ingestion_page` accepts a
`spaces.messages.list` response and produces a `chat.ingestion_batch`:

- `events`: snapshot records with a normalized event summary, source message
  name, effective timestamp, duplicate key, and skipped-duplicate flag.
- `checkpoint`: `pageToken`, `nextPageToken`, high-watermark time, and seen
  duplicate keys.
- `nextRequest`: a new polling plan when Google returned another page token.
- `systemNotes`: AI-facing notes that explain polling lag and dedupe behavior.

Polling snapshots are not authoritative real-time events. The SDK labels them as
`created_snapshot`, `updated_snapshot`, or `deleted_snapshot` so application
code can route them safely without pretending polling is equivalent to
Workspace Events delivery.

## Production Boundary

Implemented:

- Node/Python planning for all four ingestion modes.
- Node/Python polling-page processing.
- Shared conformance for polling plan and page processing.

Planned:

- Durable scheduled poller loop.
- Public live polling smoke command.
- Workspace Events setup doctor integration in `chat:doctor`.
- Real Workspace Events subscription delivery after tenant policy permits the
  Chat Pub/Sub publisher principal.
