---
title: Live Streaming
date: 2026-07-06
type: guide
status: implemented
---

# Live Streaming

Live streaming turns a model's token/chunk stream into a series of edits on a
single Google Chat message — the same "typing" feel users get from chat
products backed by an LLM, without hand-rolling cadence, message-size, or
cancellation logic per project. The design splits cleanly into two layers:

1. A **pure, deterministic scheduler**
   (`createStreamSchedulerState` / `advanceStreamScheduler` /
   `replayStreamScheduler`) that decides, given accumulated text and a
   sequence of events, exactly when to patch, when to finalize, when to split
   into a continuation message, and when to degrade. It has no I/O and is
   pinned byte-for-byte across Node and Python by
   `conformance/cases/stream.scheduler.json`.
2. Language **drivers** (`streamChatReply` in Node; `stream_chat_reply` /
   `astream_chat_reply` in Python) that consume a real model stream, feed
   events into the scheduler, and apply the resulting actions as HTTP calls
   through an injected `apply` function.

## Node Example

```ts
import {
  planPlaceholderResponse,
  hydratePlaceholderResponseHandle,
  executeChatPlan,
  streamChatReply,
  createChatRequestApplier,
} from "googlechatai";

// 1. Create a placeholder message the model can "type into".
const plan = planPlaceholderResponse({
  space: "spaces/AAA",
  placeholderText: "Thinking...",
});
const execution = await executeChatPlan(plan, { mode: "live", auth, fetch });

// 2. Hydrate the handle with the real created message.
const handle = hydratePlaceholderResponseHandle(
  plan.placeholder.handle,
  execution.createdMessages[0],
);

// 3. Stream the model's output onto that same message.
const apply = createChatRequestApplier({ auth, fetch });
const report = await streamChatReply(handle, modelStream, {
  apply,
  minPatchChars: 40,
  minIntervalMs: 750,
  typingIndicator: " ▌",
  finalCards: [{ cardId: "sources", card: {} }],
});

console.log(report.ok, report.finalText, report.patches);
```

A minimal, self-contained shape (matching the real test suite) for wiring a
placeholder handle directly, without the full plan/execute round trip:

```ts
const report = await streamChatReply(
  {
    kind: "chat.placeholder_response_handle",
    space: "spaces/AAA",
    messageName: "spaces/AAA/messages/FROMHANDLE",
    editable: true,
  },
  modelChunks,
  { apply, clock: () => Date.now() },
);
```

## Python Example

```python
from googlechatai import (
    plan_placeholder_response,
    hydrate_placeholder_response_handle,
    execute_chat_plan,
    astream_chat_reply,
    create_chat_request_applier,
)

plan = plan_placeholder_response({
    "space": "spaces/AAA",
    "placeholderText": "Thinking...",
})
execution = execute_chat_plan(plan, mode="live", auth=get_access_token, send=send)
handle = hydrate_placeholder_response_handle(
    plan["placeholder"]["handle"], execution["createdMessages"][0]
)

apply = create_chat_request_applier(get_access_token=get_access_token, send=send)

async def model_stream():
    async for chunk in model.stream(prompt):
        yield chunk.delta

report = await astream_chat_reply(
    handle,
    model_stream(),
    apply=apply,
    min_patch_chars=40,
    min_interval_ms=750,
    typing_indicator=" ▌",
    final_cards=[{"cardId": "sources", "card": {}}],
)

print(report["ok"], report["finalText"], report["patches"])
```

`stream_chat_reply` is the synchronous counterpart for a plain iterable and a
synchronous `apply` — `astream_chat_reply` additionally accepts a **sync**
iterable and/or a **sync** `apply` too (it checks for `__aiter__` and for an
awaitable return value at each call site), so it is the more permissive of
the two and a reasonable default even for a synchronous model client.

## The Scheduler

`createStreamSchedulerState(config)` builds a `chat.stream_scheduler_state`
object; `advanceStreamScheduler(state, event)` folds one event onto it and
returns `{ state, actions }`; `replayStreamScheduler({ config, events })`
folds a whole list of events at once and is what the shared conformance
cases exercise. Events are one of `chunk`, `flush`, `finish`, `cancel`,
`error`, or `patch_result`; actions are one of `patch`, `finalize`, or
`start_continuation`.

### Cadence Gates

Two gates decide whether a `chunk` event produces a `patch` action:

- **`minPatchChars`** (default `120`) — gates on characters accumulated since
  the last patch, not total message length. A chunk that brings the pending
  count under this threshold produces no action yet; the text is still
  captured, just not sent.
- **`minIntervalMs`** (default `1000`) — gates on wall-clock time since the
  last applied patch. This gate is **not** bypassed by `flush`; only the char
  gate is.

A `flush` event force-emits a patch bypassing `minPatchChars` (but still
respecting `minIntervalMs` and the patch budget) — useful for flushing
whatever is pending right before you know the stream is about to pause.

### Patch Budget With A Reserved Final Slot

`maxPatches` (default `20`) caps the number of **non-final** patches. Once
`patchesUsed` reaches `maxPatches - 1`, no further intermediate patches are
emitted — the last slot is always reserved for the eventual `finalize`
action, which is a separate code path that never consults the budget. This
guarantees the complete final answer is always delivered even if a very long
stream exhausts its patch budget of visual updates along the way; the only
cost is that the last stretch of text arrives in one jump instead of several
smaller edits.

### Message-Size Guard

`maxMessageChars` (default `4000`) bounds how much text can go in a single
Chat message. On overflow, one of two things happens:

- **`overflow: "truncate"`** (the default) — the stream keeps patching the
  same message; once finalized, content beyond capacity is cut and
  `truncationNote` (default `"\n\n[Output truncated: Google Chat message size
  limit reached.]"`) is appended. The cut for truncation is a hard slice, not
  whitespace-aware.
- **`overflow: "split"`** — when accumulated content would exceed the limit,
  the scheduler finalizes the *current* message with everything that fits,
  starts a brand-new Chat message (a `start_continuation` action, prefixed
  with `continuationPrefix`, default `"(continued)\n"`) in the same space and
  thread, and keeps streaming into the new message. The cut point is
  whitespace-aware: it scans backward from the capacity boundary for the
  nearest space/newline/tab so words aren't split mid-token, falling back to
  a hard cut only if no whitespace exists in the window. Each new segment
  gets a fresh patch budget and interval timer.

If the stream target has no `space` (so there's nowhere to create a
continuation message), `overflow: "split"` is silently downgraded to
`"truncate"` before streaming starts.

### Typing Indicator, Prefix, Suffix

Every rendered patch is assembled as
`prefix + content + note + suffix + typingIndicator`, in that exact order.
`typingIndicator` is appended only to non-final (`patch`) renders — the
`finalize` render never carries it. `prefix` applies to segment 0;
`continuationPrefix` applies to every split segment after it.

### Degradation After Consecutive Patch Failures

Every applied `patch`/`finalize` action reports its outcome back into the
scheduler as a `patch_result` event automatically — you never construct this
event yourself. Reaching `maxConsecutivePatchFailures` (default `3`)
consecutive failures on non-final patches sets a sticky
`degradedToFinalOnly` flag: no further intermediate patches are attempted for
the rest of that run, though the stream keeps consuming chunks silently in
the background. The complete text still arrives in one shot at the final
`finalize` call — degradation trades interim visual feedback for a guaranteed
final delivery, it does not abort the stream.

## The Node Driver: `streamChatReply`

```ts
streamChatReply(
  target: PlaceholderResponseHandle | { messageName, space?, threadName?, threadKey? },
  stream: AsyncIterable<unknown> | Iterable<unknown>,
  options: StreamChatReplyOptions, // extends StreamSchedulerConfig
): Promise<ChatStreamReport>
```

`target` accepts either a plain object with `messageName` (and optionally
`space`/`threadName`/`threadKey` for split-mode continuations), or a
placeholder response handle directly — including one straight out of
`hydratePlaceholderResponseHandle`. An un-hydrated handle (`editable: false`
or a null `messageName`) is rejected with a clear error pointing at
`hydratePlaceholderResponseHandle`.

`options.apply` is required — a function
`(request) => Promise<{ ok, status, json, error? }>` that turns a scheduler
action into a real `PATCH`/`POST` call. `createChatRequestApplier({ auth,
fetch?, authMode?, baseUrl?, retryPolicy? })` builds one wired to the shared
transport client (retry, refresh, and backoff all reused, same as
`executeChatPlan`).

### Cancellation

Two independent cancellation inputs are checked between chunks (never
mid-chunk):

- `signal: AbortSignal` — standard abort controller.
- `shouldCancel: () => boolean | Promise<boolean>` — a polling function, most
  often backed by a `StreamCancellationRegistry`.

Either one triggers a clean cancel: the loop stops pulling further chunks,
and the scheduler finalizes with `cancelNote` (default `"\n\n[Stopped at user
request.]"`) appended to whatever was accumulated. `report.cancelled` is
`true` and `report.ok` is still `true` (a user-requested stop is not a
failure).

### Cross-Process Cancel Via `StreamCancellationRegistry`

```ts
import {
  InMemoryStreamCancellationRegistry,
  FileStreamCancellationRegistry,
} from "googlechatai";

const registry = new InMemoryStreamCancellationRegistry();
// ...
const report = await streamChatReply(target, modelStream, {
  apply,
  shouldCancel: () => registry.isCancelled("stream-1"),
});
// Elsewhere — e.g. a card action handler — trigger the stop:
registry.cancel("stream-1", "user pressed stop");
```

`InMemoryStreamCancellationRegistry` only works within one process.
`FileStreamCancellationRegistry` persists cancellation to a small JSON file
(`{ "version": 1, "cancelled": { "<streamId>": "<reason>" } }`), written
atomically (temp file + rename) with `0600` permissions, so a card-action
handler running in a completely separate process or request can cancel a
stream by writing to the same file path that the streaming process polls:

```ts
// Streaming process:
const registry = new FileStreamCancellationRegistry({ filePath: "/tmp/chat-cancels.json" });
// Card-action handler process, same filePath:
await registry.cancel("stream-1", "card button");
```

The file format is identical between Node and Python, so a Python handler can
cancel a Node-driven stream and vice versa.

### Final Cards

`finalCards` attaches `cardsV2` to the finalize patch, changing its
`updateMask` from `"text"` to `"text,cardsV2"`. Note that in split-overflow
mode, every segment's finalize action is a `final: true` action in its own
right — `finalCards` attaches to each one encountered, not only the very last
segment across the whole run. If you only want cards on the true final
message, hold off on setting `finalCards` until you know the stream won't
split further, or post the cards as a separate `replaceCards` call once
streaming completes.

### Resume Via `onState` Snapshots

```ts
const states: unknown[] = [];
const firstReport = await streamChatReply(target, interruptedStream, {
  apply,
  onState: (state) => states.push(JSON.parse(JSON.stringify(state))),
});
// firstReport.ok is false (the stream threw partway through)

const resumeFrom = states.find((state) => (state as { finished: boolean }).finished !== true);
const resumedReport = await streamChatReply(target, restOfStream, {
  apply,
  resumeState: resumeFrom,
});
// resumedReport.finalText contains both the pre- and post-interruption text
```

`onState` fires after every event is folded, so you can persist the latest
non-final snapshot (for example after a worker crash or restart). Passing
that snapshot back as `resumeState` continues the same logical stream: the
resumed scheduler already has the earlier accumulated content and picks up
exactly where it left off, rather than starting over. The scheduler
configuration embedded in the resumed snapshot (cadence, budget, notes) is
what applies going forward — cadence/budget options passed to the *resuming*
call are not reapplied.

### Stream Report Shape

`ChatStreamReport` / the Python driver's report dict includes:

- `ok` — `true` unless the run had a hard failure (a failed final patch, or a
  broken continuation create).
- `messageName` — the original target message name.
- `finalText` — the exact text of the last successfully applied final
  action.
- `patches` — total count of successfully applied patch/finalize actions.
- `continuations` — created continuation message names, in order.
- `truncated`, `cancelled`, `errored`, `degradedToFinalOnly` — terminal-state
  flags.
- `failure` — `{ name, message }` or `null`.
- `warnings` — scheduler warning codes accumulated during the run.
- `state` — the final scheduler state, suitable for `resumeState` on a later
  call if the run was interrupted.

## Python: `stream_chat_reply` And `astream_chat_reply`

```python
from googlechatai import stream_chat_reply, astream_chat_reply

# Synchronous driver — plain iterable, synchronous apply.
report = stream_chat_reply(
    target,
    ["hello ", "streamed ", "world"],
    apply=apply,
    min_patch_chars=5,
    min_interval_ms=0,
)

# Async driver — accepts a sync OR async iterable, and a sync OR async apply.
async def model_stream():
    async for chunk in model.stream(prompt):
        yield chunk

report = await astream_chat_reply(
    target,
    model_stream(),
    apply=apply,
    min_patch_chars=5,
    min_interval_ms=0,
)
```

Scheduler config options are passed as snake_case keyword arguments
(`min_patch_chars`, `min_interval_ms`, `max_patches`, `max_message_chars`,
`overflow`, `prefix`, `suffix`, `typing_indicator`, `truncation_note`,
`continuation_prefix`, `cancel_note`, `error_note`, `empty_final_text`,
`max_consecutive_patch_failures`) and mapped internally to the same camelCase
scheduler config the Node driver and the conformance fixtures use.
`create_chat_request_applier(get_access_token=..., send=..., auth_mode=...,
base_url=..., retry_policy=...)` is the Python equivalent of
`createChatRequestApplier`, reusing the shared transport client the same way.

## Production Boundary

Implemented:

- Node/Python scheduler parity (`createStreamSchedulerState`,
  `advanceStreamScheduler`, `replayStreamScheduler`), pinned by
  `conformance/cases/stream.scheduler.json` across cadence, patch budget,
  truncate overflow, split overflow, cancel, error, degradation, flush plus
  final-text override, and empty-stream finalization.
- Node `streamChatReply` driver with `AbortSignal` and `shouldCancel`
  cancellation, `createChatRequestApplier` transport wiring, final-card
  attachment, and `onState`/`resumeState` resume support.
- Python `stream_chat_reply` (sync) and `astream_chat_reply` (async, accepting
  mixed sync/async iterables and appliers) drivers with the same feature set.
- `InMemoryStreamCancellationRegistry` and `FileStreamCancellationRegistry` in
  both languages, with a shared cross-language JSON file format for
  cross-process cancellation.
- The plan → execute → hydrate → stream composition pattern, built from
  `planPlaceholderResponse`, `executeChatPlan`, and
  `hydratePlaceholderResponseHandle`.

The live-smoke boundary in `AGENTS.md` still applies: driving `streamChatReply`
against a real Google Chat message requires the guarded live-smoke harness
described in
[Live Chat Smoke Harness](../runbooks/2026-06-29-live-chat-smoke-harness.md),
never a default chatbot code path.
