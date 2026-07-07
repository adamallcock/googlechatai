---
title: Async Response Kit
date: 2026-07-04
type: guide
status: implemented-slice
---

# Async Response Kit

The async response kit helps AI agents answer quickly in Google Chat while the
real work continues in a queue. The recommended default is:

1. Guard duplicate event delivery before side effects.
2. Create a placeholder response such as `Thinking...`.
3. Hydrate the returned `ReplyHandle` when Chat returns the created message.
4. Enqueue a final-response task that carries the handle, principal, event, and
   idempotency metadata.
5. Edit the placeholder with the final answer or an error message.

This slice implements the planner and local queue primitives. Production queue
adapters are intentionally represented as plan metadata until a deployment store
is chosen.

## Node

```ts
import {
  InMemoryAsyncResponseQueue,
  planAsyncResponse,
} from "googlechatai";

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
    target: "projects/p/locations/us-central1/queues/chat-ai",
  },
});

const queue = new InMemoryAsyncResponseQueue();
queue.enqueue(plan.queue.task);
```

## Python

```python
from googlechatai import InMemoryAsyncResponseQueue, plan_async_response

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

## Planner Behavior

`planAsyncResponse` / `plan_async_response` returns:

- `deadline`: elapsed, remaining, expected work, and defer reason.
- `idempotency`: replay-safe key and duplicate strategy.
- `placeholderPlan`: a normal placeholder response plan when enabled.
- `replyHandle`: hydrated when `createdMessage` is supplied, otherwise marked
  for hydration by the caller.
- `queue.task`: a private-payload-safe task envelope with `payloadRef`,
  principal/auth mode, target space, event id, idempotency key, and final
  delivery metadata.
- `completion`: whether the worker should edit an existing placeholder or create
  a new message.
- `systemNotes`: AI-facing context describing the async response relationship.

When `respondWithPlaceholder` is false and the work fits the sync budget, the
planner returns `strategy: "sync_response"`. When the work is too slow and no
placeholder is requested, it returns `strategy: "queue_only"` and the final
worker should create a message instead of editing one.

## Production Boundary

Implemented:

- Node/Python planner parity.
- Node/Python in-memory queue adapters for local tests and examples.
- Shared conformance for placeholder-plus-queue handoff.

Planned:

- Cloud Tasks adapter for Node.
- BullMQ adapter for Node.
- Celery/RQ-style Python worker examples.
- Middleware that performs placeholder creation, handle hydration, queue
  enqueue, and HTTP response shaping automatically.
- Guarded live smoke for delayed queue-backed final edits.
