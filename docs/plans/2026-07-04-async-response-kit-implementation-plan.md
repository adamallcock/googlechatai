---
title: Async Response Kit Implementation Plan
date: 2026-07-04
type: plan
status: implemented-slice
---

# Async Response Kit Implementation Plan

## Status

Implemented before this slice:

- Node/Python placeholder response planners:
  `planPlaceholderResponse` / `plan_placeholder_response`,
  `hydratePlaceholderResponseHandle` / `hydrate_placeholder_response_handle`,
  `planCompletePlaceholderResponse` / `plan_complete_placeholder_response`, and
  buffered placeholder completion.
- Configurable placeholder text pools with `first`, `roundRobin`, and `random`
  selection modes.
- Central retry/auth/idempotency transport helpers.
- Guarded live visual smoke for placeholder create-then-edit in the smoke space.

Implemented in this F5 slice:

- A high-level async response planner that decides whether to answer
  synchronously or defer via placeholder plus queue.
- A queue-safe async response task envelope carrying reply-handle, principal,
  event, idempotency, payload-reference, and final-delivery metadata.
- A local in-memory queue adapter in Node and Python.
- Shared conformance for the default placeholder-plus-queue path.

## Problem

Google Chat apps must respond to interaction events within 30 seconds, or move
work out of the synchronous response path and call the Chat API later. AI agents
regularly exceed that window when reading context, calling tools, downloading
attachments, or waiting for model output. The SDK already knows how to create a
placeholder and edit it, but developers still need a safe handoff envelope for
queue workers and a consistent deadline decision.

The desired product behavior is:

1. Receive the Chat event.
2. If `respondWithPlaceholder` is enabled, immediately create a short
   placeholder message.
3. Hydrate the reply handle from the created Chat message.
4. Enqueue a task that tells the worker exactly which message to edit.
5. Worker edits the placeholder with final text or an error message.

## Verified Source Rules

Official Google docs checked on 2026-07-04:

- Google Chat interaction events can be answered synchronously only if the app
  responds within 30 seconds and posts in the same space; otherwise the app can
  respond asynchronously by calling the Chat API:
  <https://developers.google.com/workspace/chat/receive-respond-interactions>
- Google Workspace add-on Chat actions have the same 30-second response
  boundary; after that, the app must use authentication and call the Chat API:
  <https://developers.google.com/workspace/add-ons/chat/build>

## Public API

Node:

```ts
const plan = planAsyncResponse({
  space: "spaces/AAA",
  thread: "spaces/AAA/threads/T1",
  eventId: "event-123",
  correlationId: "event-123",
  expectedWorkMs: 45_000,
  respondWithPlaceholder: true,
  payloadRef: "gs://chat-ai-sdk/tasks/event-123.json",
  queue: {
    adapter: "cloudTasks",
    target: "projects/p/locations/us-central1/queues/chat-ai"
  }
});

const queue = new InMemoryAsyncResponseQueue();
queue.enqueue(plan.queue.task);
```

Python:

```python
plan = plan_async_response({
    "space": "spaces/AAA",
    "thread": "spaces/AAA/threads/T1",
    "eventId": "event-123",
    "correlationId": "event-123",
    "expectedWorkMs": 45_000,
    "respondWithPlaceholder": True,
    "payloadRef": "gs://chat-ai-sdk/tasks/event-123.json",
    "queue": {
        "adapter": "celery",
        "target": "chat_ai.finalize_response",
    },
})

queue = InMemoryAsyncResponseQueue()
queue.enqueue(plan["queue"]["task"])
```

## Result Shape

```json
{
  "kind": "chat.async_response_plan",
  "status": "defer",
  "strategy": "placeholder_then_queue",
  "deadline": {
    "syncDeadlineMs": 30000,
    "safetyMarginMs": 5000,
    "elapsedMs": 3000,
    "remainingMs": 27000,
    "expectedWorkMs": 45000,
    "shouldDefer": true
  },
  "placeholderPlan": {},
  "replyHandle": {},
  "queue": {
    "adapter": "cloudTasks",
    "target": "projects/p/locations/us-central1/queues/chat-ai",
    "task": {}
  },
  "completion": {
    "successOperation": "messages.placeholder.complete",
    "errorOperation": "messages.placeholder.complete"
  },
  "systemNotes": []
}
```

## Auth And Principal Model

- Placeholder create and final edit use the same principal unless the caller
  explicitly supplies `authMode`.
- Queue tasks must carry `authMode`, `space`, `threadName`/`threadKey`,
  `messageName` when hydrated, `requestId`, `clientMessageId`,
  `correlationId`, and `idempotencyKey`.
- Duplicate delivery must be guarded before creating a placeholder. This planner
  returns the idempotency key and duplicate strategy; durable stores remain in
  the transport module.
- The queue task must carry references to payloads, not raw private event bodies
  or model prompts.

## First Slice Scope

Implemented in this feature:

- `planAsyncResponse` / `plan_async_response`.
- `InMemoryAsyncResponseQueue` / `InMemoryAsyncResponseQueue`.
- Shared conformance case for placeholder plus queue with a hydrated handle.
- Focused Node/Python tests for:
  - default placeholder plus queue;
  - deadline-driven queue-only path;
  - short synchronous path when placeholder is disabled;
  - local in-memory queue enqueue/dequeue behavior.
- Docs and audit updates.

Planned follow-ups:

- Cloud Tasks adapter implementation for Node.
- BullMQ adapter implementation for Node.
- Celery/RQ implementation examples for Python.
- Middleware integration that executes placeholder creation, hydrates the
  handle, enqueues the task, and returns the proper HTTP response automatically.
- Live smoke for queue-backed final edit after a real background delay.

## Completion Criteria

- Node/Python APIs are exported from package roots.
- Shared conformance passes in both runtimes.
- Existing placeholder and buffered-stream behavior remains unchanged.
- Docs clearly separate planner/local queue behavior from production queue
  implementations.
- Live completion audit marks the slice local/conformance verified, not live
  queue verified.
