---
title: Reply Routing Policy
date: 2026-07-05
type: guide
status: draft
---

# Reply Routing Policy

## Current State

Implemented in Node.js and Python dry-run planners:

- `resolveReplyTarget` / `resolve_reply_target`
- `planReplyToEvent` / `plan_reply_to_event`

The goal is to hide Google Chat's thread-routing edge cases behind one
developer-facing policy object. Application code can answer an event without
manually deciding whether to create a top-level message, reply to an existing
thread, or use a stable `threadKey` fallback.

## Should A Plain Room Message Trigger The App?

Usually no. For an interactive Chat app HTTP endpoint, Google Chat sends
`MESSAGE` interaction events when the user invokes the app, such as by
@mentioning it or using a command. A plain top-level message in a room that
doesn't mention the app is not the same as a DM to the app.

To observe every room message without a mention, use one of the ingestion
surfaces instead:

- Workspace Events push or pull.
- Polling/search ingestion with user authorization.
- A product-specific listener that has been explicitly configured and consented.

## Default Mimic Policy

`replyRouting.strategy` defaults to `mimic`.

| Incoming context | Default route | Reason |
| --- | --- | --- |
| DM top-level message | Top-level message in the DM | `dm_top_level` |
| Room thread reply | Same thread | `room_thread_reply` |
| Room top-level invocation | Thread target | `room_top_level_thread` |
| Room top-level invocation without a thread name | Stable `thread.threadKey` fallback | `room_top_level_thread_key` |

The room top-level default is intentionally thread-first. For AI answers in
shared rooms, this keeps follow-up context attached to the user's question
instead of adding more top-level room noise.

## Configuration

Use `replyRouting` or `replyPolicy` on the planner input:

```ts
planReplyToEvent({
  event,
  text: "Answer in the right place.",
  replyRouting: {
    strategy: "mimic",
    dm: "topLevel",
    roomTopLevel: "thread",
    roomThreadReply: "thread",
    missingThread: "threadKey",
    messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
  },
});
```

Supported fields:

| Field | Values | Default | Meaning |
| --- | --- | --- | --- |
| `strategy` | `mimic`, `thread`, `topLevel` | `mimic` | Overall routing mode. |
| `dm` | `topLevel`, `thread` | `topLevel` | Route for DMs when using `mimic`. |
| `roomTopLevel` | `thread`, `topLevel` | `thread` | Route for top-level room invocations when using `mimic`. |
| `roomThreadReply` | `thread`, `topLevel` | `thread` | Route for threaded room invocations when using `mimic`. |
| `missingThread` | `threadKey`, `topLevel`, `fail` | `threadKey` | What to do when policy selected a thread but the event has no thread name. |
| `messageReplyOption` | Google Chat `MessageReplyOption` enum string | `REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD` | Query value for async `spaces.messages.create` calls that include a thread target. |

Explicit `thread` or `threadKey` fields on the planner input win over the
policy. Supplying both is an error.

## Returned Metadata

`resolveReplyTarget` returns a `chat.reply_target` object with:

- `conversation`: `dm` or `space`.
- `route`: `thread` or `topLevel`.
- `space`.
- `threadName` or `threadKey`, when applicable.
- `messageReplyOption`, when applicable.
- `reason`: machine-readable explanation of the policy branch.
- `warnings`: especially for stable `threadKey` fallback behavior.
- `systemNotes`: model-readable note explaining where the SDK will reply.

`planReplyToEvent` includes the same object under `replyTarget` and uses it to
construct the `spaces.messages.create` dry-run request.

## Propagation Contract

The same `chat.reply_target` object is intentionally carried through every
long-running response surface:

- `planPlaceholderResponse` / `plan_placeholder_response` can accept an event
  plus `replyRouting`, derive the correct space/thread target, create the
  placeholder in that target, and store `replyTarget` on the placeholder handle.
- `planAsyncResponse` / `plan_async_response` derives the target once and passes
  it through the placeholder plan, queue task, reply handle, final-delivery
  strategy, and AI-facing `systemNotes`.
- Queue-only async work with an event target uses
  `messages.replyToEvent` as the final delivery operation instead of falling
  back to a generic space message.
- Node router helpers expose `ctx.reply.target()`, `ctx.reply.placeholder()`,
  and `ctx.ai.replyTarget()`. Python exposes the same contract through
  `ctx.reply.target()`, `ctx.reply.placeholder(...).reply_target`,
  `ctx.reply_target()`, and `ctx.ai_context()["replyTarget"]`.

This means a developer can configure where the app should reply at the router
or planner boundary and does not need to manually pipe `space`, `thread`,
`threadKey`, or `messageReplyOption` through placeholder/edit/queue plumbing.

## Google Chat Caveats

For synchronous interaction responses, Chat itself controls thread placement:
when the interaction happens in a thread, the response is created in that same
thread; otherwise it is created as a new thread. The `messageReplyOption` query
parameter is ignored for that synchronous interaction response path.

For async replies through `spaces.messages.create`, thread placement is controlled
by the `thread` field and `messageReplyOption`. The SDK planner models that path
because it is the one long-running AI handlers use after a placeholder response,
queue handoff, or delayed completion.

References:

- <https://developers.google.com/workspace/chat/receive-respond-interactions>
- <https://developers.google.com/workspace/chat/create-messages>
- <https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/create>
