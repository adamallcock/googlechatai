---
title: Router Event Coverage
date: 2026-07-06
type: guide
status: implemented
---

# Router Event Coverage

The Node and Python routers (`GoogleChatAI`) now register handlers for the
full set of Google Chat event kinds the SDK normalizes, plus three
cross-cutting options — duplicate-delivery dedupe, a response deadline with
late-result logging, and (Node only) inbound request verification.

## Node

```ts
import { GoogleChatAI, InMemoryIdempotencyStore } from "googlechatai";

const chat = new GoogleChatAI({
  appUser: { name: "users/app" },
  dedupe: { store: new InMemoryIdempotencyStore() },
  deadline: {
    budgetMs: 8000,
    onDeadline: async (_event, ctx) => ctx.reply.text("Still working on it..."),
  },
});

chat.onSlashCommand("/deploy", async (event, ctx) =>
  ctx.reply.text(`deployed: ${event.message?.argumentText}`),
);
chat.onSlashCommand(async (_event, ctx) => ctx.reply.text("Unknown command."));
chat.onMention(async (_event, ctx) => ctx.reply.text("You called?"));
chat.onAddedToSpace(async (_event, ctx) => ctx.reply.text("Thanks for adding me."));
chat.onReactionCreated(async (_event, ctx) => ctx.reply.json({}));
chat.onMessageUpdated(async (_event, ctx) => ctx.reply.json({}));
chat.on("dialog.cancelled", async (_event, ctx) => ctx.reply.json({}));
```

## Python

```python
from googlechatai import GoogleChatAI, InMemoryIdempotencyStore
from googlechatai.router.runtime import json_response

chat = GoogleChatAI(
    app_user={"name": "users/app"},
    dedupe=InMemoryIdempotencyStore(),  # or {"store": ..., "ttl_ms": ...}
    deadline={"budget_ms": 8000},
)

@chat.on_slash_command("/deploy")
def handle_deploy(ctx):
    return f"deployed: {ctx.event['message']['argumentText']}"

@chat.on_slash_command
def handle_unknown_command(ctx):
    return "Unknown command."

@chat.on_mention
def handle_mention(ctx):
    return "You called?"

@chat.on_added_to_space
def handle_added(ctx):
    return "Thanks for adding me."

@chat.on_reaction_created
def handle_reaction(ctx):
    return json_response(text="")

@chat.on_message_updated
def handle_message_updated(ctx):
    return json_response(text="")

@chat.on("dialog.cancelled")
def handle_dialog_cancelled(ctx):
    return json_response(text="")
```

## New Registrations

- **`onSlashCommand` / `on_slash_command`** — matches by command name (with
  or without a leading slash, case-insensitively), or registers a bare
  fallback when called with only a handler. The incoming command name is read
  from the normalized `message.slashCommand.commandName` field, falling back
  to the first whitespace-separated token of the message text if that
  annotation is missing.
- **`onAddedToSpace` / `on_added_to_space`** and
  **`onRemovedFromSpace` / `on_removed_from_space`** — fire for
  `space.added` / `space.removed`.
- **Reactions** — `onReactionCreated` / `on_reaction_created` and
  `onReactionDeleted` / `on_reaction_deleted`.
- **Memberships** — `onMembershipCreated` / `on_membership_created`,
  `onMembershipUpdated` / `on_membership_updated`,
  `onMembershipDeleted` / `on_membership_deleted`.
- **Message updated/deleted** — `onMessageUpdated` / `on_message_updated` and
  `onMessageDeleted` / `on_message_deleted`, each falling back to
  `onMessage` / `on_message` if no dedicated handler is registered.
- **`onDialogCancelled` / `on_dialog_cancelled`** — fires for
  `dialog.cancelled`.
- **`onWidgetUpdated` / `on_widget_updated`** — fires for `widget.updated`.
- **`onLinkPreview` / `on_link_preview`** — fires for
  `message.link_preview_requested`. There is no fixture-driven test exercising
  this handler in either language's test suite yet; treat live coverage here
  as unverified until a fixture is added.
- **Generic `on(kind, handler)` / `on(kind, handler=None)`** — registers a
  handler for any of the SDK's known `ChatEventKind` strings (message, space,
  membership, reaction, card, dialog, and widget kinds, plus the
  `event.batch` / `event.unknown` catch-alls). An unrecognized `kind` fails
  fast at registration time: Node throws a `TypeError`
  (`` Unknown Google Chat event kind: <kind> ``); Python raises a `ValueError`
  (`` Unknown Google Chat event kind: '<kind>' ``).

## Python `on_mention` And `app_user` Parity

Both languages detect a bot mention the same way: the constructor's
`appUser` / `app_user` option (`{ name: "users/app" }`) is compared against
every `userMention`-kind annotation on the normalized message. When it
matches, the event's `kind` is rewritten to `message.mentioned_app` before
dispatch — so `onMention` / `on_mention` is chosen (or its `onMessage` /
`on_message` fallback) based on the *rewritten* kind, not the raw
`message.created` kind. Registering a mention handler is exclusive: if any
`onMention` / `on_mention` handler exists, `onMessage` / `on_message` is never
consulted for that event, even if the mention handler is registered after
`onMessage`.

## Dedupe: Idempotency Store, Duplicate 200 Short-Circuit

```ts
new GoogleChatAI({ dedupe: { store, ttlMs: 600_000 } });
```

```python
GoogleChatAI(dedupe={"store": store, "ttl_ms": 600_000})
# or the shorthand:
GoogleChatAI(dedupe=store)
```

Node requires the `{ store, ttlMs? }` shape. Python accepts that same mapping
shape (with snake_case `ttl_ms`) or a bare `IdempotencyStore` instance
directly. When `dedupe` is configured and the incoming event carries a
non-blank `idempotencyKey`, the router claims that key against the store
before running any handler. A duplicate claim short-circuits with a plain 200
response body `{ "status": "duplicate_event_ignored" }` and skips the entire
middleware/handler chain — Google Chat's retried delivery gets a normal
success response without your handler running twice. Events without an
idempotency key always pass through, dedupe configured or not.

## Deadline: Budget, Fallback, Late-Result Logging

```ts
new GoogleChatAI({
  deadline: {
    budgetMs: 8000,
    onDeadline: async (_event, ctx) => ctx.reply.text("Still working on it..."),
  },
});
```

```python
GoogleChatAI(deadline={"budget_ms": 8000, "on_deadline": handle_deadline})
```

`budgetMs` / `budget_ms` races the middleware-and-handler chain against a
timer. If the handler finishes first, its real result is returned untouched.
If the timer wins, the router logs `chat.event.deadline_exceeded` (warn) and
immediately returns either the custom `onDeadline` / `on_deadline` handler's
result or the default fallback text `"Still working on it..."` — the
in-flight handler chain is **not** cancelled; it keeps running in the
background. When it eventually settles, the router logs `chat.event.late_result`
(info) on success or `chat.event.late_failure` (error) on failure. This is
what "late-result logging" means: visibility into work that finished after
the caller already got a response, not a way to recover that work into the
original response.

The two languages race the chain differently:

- **Node** uses `Promise.race` — the loser promise chain keeps running on
  later turns of the same event loop; no extra thread is involved.
- **Python** spawns a worker thread (`threading.Thread` running its own
  `asyncio.run(...)`), joined with `budget_ms / 1000` seconds. If it's still
  alive after the join, a second daemon thread blocks on its completion
  purely to log the late outcome. This is a deliberate choice to mirror
  Node's race semantics without adding threading overhead to the no-deadline
  path (the code that dispatches directly, with no thread, when `deadline`
  isn't configured).

## Node `verifier` Option

```ts
new GoogleChatAI({
  verifier: createChatRequestVerifier({ audience: "<project number>" }),
});
```

This option is Node-only — Python's `GoogleChatAI` constructor has no
`verifier` parameter; in Python, verification is wired at the transport
adapter instead (`ASGIAdapter(chat, verifier=...)` /
`mount_fastapi(app, chat, verifier=...)`), covered in
[Inbound Request Verification](2026-07-06-inbound-request-verification.md).
In Node, the verifier only runs inside `GoogleChatAI.fetch(request)` — a
caller that dispatches a pre-parsed payload directly bypasses it. See that
guide for the full 401/500 wiring.

## Dispatch Precedence

Both routers document the same intended precedence: a specific registration
(named slash command, or a dedicated `on*` method) wins first, then any
generic `on(kind)` registration for that exact kind, then the message-family
fallback (`onMessage` / `on_message`, for message-shaped kinds only), then
`onUnknownEvent` / `on_unknown_event`. For every scenario the test suites
cover, this holds in both languages — a card click goes to `onCardClicked`
before any generic handler, a slash command matches its named handler before
falling to a bare one, and `space.added`/`reaction.created`/membership kinds
never fall back to `onMessage` (only message-shaped kinds do).

There is one structural difference worth knowing if you register multiple
handlers for the same event kind expecting one to defer to the next:

- **Node** builds an ordered list of every matching handler across all
  precedence tiers and invokes them one at a time until one returns a value
  other than `undefined`. A matched handler can deliberately defer to the
  next one in line by returning `undefined`.
- **Python** resolves a single handler up front — the first precedence tier
  that has *any* registration wins outright, and only that one handler runs.
  A Python handler that returns `None` does not cause the router to try a
  lower-precedence handler; it simply produces an empty response.

In every case the shipped test suites exercise, the higher-precedence slot is
either present (and meant to run) or entirely absent (so the fallback fires
because there was nothing to defer from), so this difference does not change
outcomes for the documented usage patterns above. It matters only if you
register more than one handler for the same kind and rely on an early one
returning `undefined`/`None` to fall through to a later one — that pattern is
Node-only behavior today.

Both routers sit behind `use(middleware)` (Node) and the equivalent
middleware chain concept — middleware wraps the whole dedupe/deadline/dispatch
sequence, not just the final handler call.

## Production Boundary

Implemented:

- Node/Python registration parity across every event kind: slash commands
  (named + bare), space added/removed, reactions, memberships, message
  updated/deleted, dialog cancelled, widget updated, generic `on(kind)`.
- Python `on_mention` / `app_user` parity with Node's `onMention` / `appUser`.
- `dedupe` option with idempotency-store-backed duplicate short-circuiting in
  both languages.
- `deadline` option with budget racing, custom fallback handler, and
  late-result/late-failure logging in both languages.
- Node `verifier` constructor option for inbound request verification.

Known gaps to track:

- No fixture-driven test exercises `onLinkPreview` / `on_link_preview` yet.
- No test in either language currently exercises a registered-and-invoked
  higher-precedence handler that returns `undefined`/`None` specifically to
  confirm whether Python falls through to a lower-precedence handler the way
  Node does — the precedence note above reflects the current source
  behavior, not an assumption, but this scenario itself is untested.
