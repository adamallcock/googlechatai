---
title: Passive Ingestion Implementation Plan
date: 2026-07-04
type: plan
status: implemented-slice
---

# Passive Ingestion Implementation Plan

## Status

Implemented before this slice:

- Direct Chat HTTP event normalization.
- Workspace Events CloudEvent and Pub/Sub push/pull parsing.
- Workspace Events checkpoint stores.
- Thread and space context read planners using `spaces.messages.list`.
- Guarded live Workspace Events subscription smoke, currently blocked in the
  private live test tenant by org policy.
- Guarded live message-list context reads in the smoke space.

Implemented in this F6 slice:

- A unified Node/Python ingestion planner for direct interactions, Workspace
  Events Pub/Sub push, Workspace Events Pub/Sub pull, and polling fallback.
- A Node/Python polling-page processor that turns `spaces.messages.list`
  snapshots into event-like ingestion records with sender/time/message/context
  metadata, cursors, and duplicate keys.
- Shared conformance for polling fallback planning and polling-page processing.

Planned follow-ups:

- Production poller loop with a durable store adapter and scheduler.
- Workspace Events setup doctor promotion into the public `chat:doctor` command.
- Live read-only polling smoke packaged as a public command.
- Real Workspace Events subscription delivery once tenant policy allows the Chat
  Pub/Sub publisher principal.

## Problem

Google Chat direct interaction webhooks only cover interactions such as
mentions, slash commands, card clicks, and dialogs. Developers also need a safe
way to observe selected spaces passively. The best available path is Workspace
Events, but it requires Pub/Sub setup, target resources, scopes, optional
resource payloads, lifecycle management, and tenant IAM policy. A polling
fallback using `spaces.messages.list` is less real-time but is often the only
tenant-safe way to catch up or monitor a smoke space without widening trust.

The SDK should make these modes feel like one product surface:

1. Choose an ingestion mode.
2. Explain principal/scopes/membership/admin requirements.
3. Produce dry-run setup or request plans.
4. Normalize delivered or polled items into a consistent event handoff.
5. Carry checkpoint, cursor, duplicate, and retry metadata centrally.

## Verified Source Rules

Official Google docs checked on 2026-07-04:

- Chat Workspace Events can target a specific space, all spaces for a user, or
  a user resource. Space subscriptions support user auth and app auth with
  administrator approval, while all-spaces-for-user only supports user auth:
  <https://developers.google.com/workspace/events/guides/events-chat>
- Chat Workspace Events include message created/updated/deleted,
  reaction created/deleted, membership created/updated/deleted, and space
  updated/deleted events. Batch event types can also be delivered:
  <https://developers.google.com/workspace/events/guides/events-chat>
- Creating a Workspace Events subscription requires Pub/Sub setup,
  `targetResource`, `eventTypes`, `notificationEndpoint`, and optional
  `payloadOptions.includeResource` for Chat resource data:
  <https://developers.google.com/workspace/events/guides/create-subscription>
- For Chat interaction-event apps, Pub/Sub topic publisher access uses
  `serviceAccount:chat-api-push@system.gserviceaccount.com`:
  <https://developers.google.com/workspace/events/guides/create-subscription>
- `spaces.messages.list` lists messages for a member caller, supports
  app-auth public-message reads with admin approval and user-auth message read
  scopes, and supports `pageSize`, `pageToken`, `filter`, `orderBy`, and
  `showDeleted`:
  <https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/list>
- `spaces.messages.list` filters by `createTime` and one `thread.name`, uses
  RFC 3339 timestamps, supports `ASC`/`DESC` ordering, defaults to
  `createTime ASC`, and returns `nextPageToken` for pagination:
  <https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/list>

## Public API

Node:

```ts
const plan = planChatIngestion({
  mode: "polling",
  space: "spaces/AAA",
  startTime: "2026-07-04T00:00:00Z",
  pageSize: 100,
  showDeleted: true,
});

const batch = processPollingIngestionPage({
  space: "spaces/AAA",
  receivedAt: "2026-07-04T00:01:00Z",
  response,
});
```

Python:

```python
plan = plan_chat_ingestion({
    "mode": "polling",
    "space": "spaces/AAA",
    "startTime": "2026-07-04T00:00:00Z",
    "pageSize": 100,
    "showDeleted": True,
})

batch = process_polling_ingestion_page({
    "space": "spaces/AAA",
    "receivedAt": "2026-07-04T00:01:00Z",
    "response": response,
})
```

## Auth And Principal Model

- Direct interaction mode does not itself call Google APIs; it normalizes what
  Chat delivers to the app endpoint.
- Workspace Events push/pull mode requires Workspace Events and Pub/Sub setup.
  User-auth is the default product path; app-auth is represented with explicit
  administrator approval notes.
- Polling fallback defaults to user auth with
  `https://www.googleapis.com/auth/chat.messages.readonly`.
- App-auth polling is represented as admin-approval-required and public-message
  only using `https://www.googleapis.com/auth/chat.app.messages.readonly`.
- All modes carry membership requirements and live-safety notes.

## Error And Checkpoint Model

- Workspace Events push/pull mode must surface IAM publisher, Pub/Sub, target
  resource, lifecycle, and include-resource availability checks.
- Polling mode uses page token plus high-watermark checkpoint metadata. It also
  creates stable duplicate keys from message name and the effective snapshot
  timestamp.
- Polling snapshots are not real-time events. They are represented as
  `created_snapshot`, `updated_snapshot`, or `deleted_snapshot` records with
  normalized event summaries so application code can share downstream routing.

## Test Plan

- Node/Python focused tests cover all four modes.
- Node/Python focused tests cover polling-page cursors, duplicate skipping, and
  deleted-message snapshots.
- Shared conformance covers polling plan and polling-page processing.
- Existing Workspace Events parser tests remain unchanged.

## Live-Test Boundary

This slice performs no live Google calls. Existing live evidence already proves:

- user-auth `spaces.messages.list` reads in the smoke space;
- synthetic Workspace Events Pub/Sub parsing and checkpointing;
- real Workspace Events subscription setup blocked by tenant org policy.

A future live polling smoke should be read-only, use the dedicated smoke space,
write only redacted evidence, and leave Chat messages untouched.

## Completion Criteria

- Node/Python ingestion APIs are exported from package roots.
- Shared conformance passes.
- F6 docs and audit rows clearly label the slice as local/conformance verified.
- Existing Workspace Events and context tests remain green.
