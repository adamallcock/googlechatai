---
title: Google Chat AI SDK Feature Inventory
date: 2026-06-29
type: spec
status: draft
---

# Google Chat AI SDK Feature Inventory

## Executive Summary

Google Chat already exposes a broad API surface, but it is not shaped around the way AI chatbot, assistant, workflow, or extension developers think. A useful package should not only mirror REST methods. It should provide intent-level primitives such as "send this to Ada", "reply in the current thread", "download and parse every attachment", "stream this model response by editing the same message", "turn this object into an interactive card", and "resolve everyone mentioned in this conversation".

This spec defines a comprehensive feature inventory for that package. The goal is to cover every meaningful Google Chat action a developer might want to take, including areas that are native Chat API calls, areas that require wrapping multiple APIs, and areas that Google Chat does not natively support but that a developer-friendly SDK can synthesize with queues, storage, card state, retries, and background workers.

The official Google Chat discovery document checked on 2026-06-29 reported revision `20260623` and exposed 50 methods across `customEmojis`, `media`, `spaces`, and `users`. The public REST docs also list additional message features such as `spaces.messages.replaceCards`, `spaces.messages.search`, and `spaces.messagePins.*` that should be tracked as docs-listed or preview surfaces until verified in generated clients and live API calls.

## Product Thesis

The package should be an AI-first Google Chat application framework, not a thin Google API wrapper.

It should:

- Model user intent first: send, reply, stream, attach, read, resolve, invite, pin, react, search, summarize, approve, and follow up.
- Normalize every inbound object: messages, annotations, users, spaces, threads, cards, dialogs, actions, attachments, links, GIFs, reactions, and membership events.
- Hide avoidable Google Chat ceremony: resource names, thread keys, message IDs, update masks, OAuth mode differences, pagination, idempotency, retries, and card JSON shape.
- Make auth boundaries explicit: app auth, user auth, admin auth, import mode, and preview-only capabilities should be reflected in capability checks.
- Serve AI workflows directly: model context loading, edit-based streaming, tool progress cards, attachment understanding, human approval flows, loop prevention, and safe-send policies.
- Preserve raw escape hatches: every high-level wrapper should expose the underlying resource names and low-level client for edge cases.

## Additional Cross-Cutting Requirements

These requirements apply across event parsing, message parsing, context loading, attachment handling, and AI rendering:

- Quoted messages must be readable as nested context, including quoted message sender identity, timestamp, text/content, cards, attachments, and further nested quotes where available.
- Nested quotes and nested attachments must use a generic recursive/context-graph model, not bespoke one-off fields that only work for a single quote depth.
- Message senders, actors, and participants must be translated into human-readable form wherever auth allows: display name, email, user resource, app/bot/human type, and explicit unavailable/ambiguous states.
- Thread and room readers must be first-class primitives with date filters, message limits, pagination, ordering, and explicit partial/truncated/inaccessible history signaling.
- All messages passed to an AI must include time context: create time, update time when relevant, timezone when known, and relationship state such as thread reply, direct reply, quote, edit, deletion, card action, or reaction.
- Attachments passed to an AI must include a plain-text metadata note before extracted content, for example: `System Note: The user attached image_123.png (image/png, 2.1 MB) with this message.`
- Quotes, replies, direct replies, card actions, reactions, and other user actions must also produce plain-text system notes that explain what happened and who did it.
- Voice notes and other audio attachments must support optional transcription modules for OpenAI and Gemini, with explicit provider auth, provider selection, disabled-by-default behavior, and modern package evaluation before custom media code.
- Package dependencies should use the latest modern versions available at implementation time unless a compatibility reason is documented.

## Source Baseline

Primary sources used for this inventory:

- Google Chat REST API reference: https://developers.google.com/workspace/chat/api/reference/rest
- Google Chat discovery document: https://chat.googleapis.com/$discovery/rest?version=v1
- Message resource: https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages
- Cards v2 resource: https://developers.google.com/workspace/chat/api/reference/rest/v1/cards
- Upload media attachments: https://developers.google.com/workspace/chat/upload-media-attachments
- Update messages: https://developers.google.com/workspace/chat/update-messages
- Create messages and threads: https://developers.google.com/workspace/chat/create-messages
- Authentication and scopes: https://developers.google.com/workspace/chat/authenticate-authorize
- Chat events overview: https://developers.google.com/workspace/chat/events-overview
- Google Workspace Events for Chat: https://developers.google.com/workspace/events/guides/events-chat
- Client libraries: https://developers.google.com/workspace/chat/libraries
- Message pins REST docs: https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messagePins
- Replace cards REST docs: https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/replaceCards
- Message search REST docs: https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/search
- Google Workspace CLI repo: https://github.com/googleworkspace/cli
- Google Workspace CLI npm package: https://www.npmjs.com/package/@googleworkspace/cli
- Google Workspace CLI Chat skill: https://github.com/googleworkspace/cli/blob/main/skills/gws-chat/SKILL.md
- Google Workspace CLI Chat send helper: https://github.com/googleworkspace/cli/blob/main/skills/gws-chat-send/SKILL.md

## Google Workspace CLI Comparison

The current Google Workspace CLI, `gws`, is an important reference point but not a substitute for this package. It is a broad Workspace command plane. Our package should be a deep Google Chat application SDK.

Current `gws` facts checked on 2026-06-29:

- npm package `@googleworkspace/cli` reports version `0.22.5`, modified `2026-03-31`.
- The GitHub repo is active and not archived; GitHub metadata checked on 2026-06-29 showed the default branch pushed on `2026-06-28`.
- The README says the project is not an officially supported Google product.
- The README positions `gws` as one CLI for Workspace, built dynamically from Google's Discovery Service.
- It provides structured JSON output, schema introspection, dry-run, pagination, auth setup, service-account support, and agent skills.
- Its Chat skill exposes generated Chat API resources and one helper, `gws chat +send`.
- The `gws-chat-send` helper sends plain text to a space and explicitly says to use the raw API for cards or threaded replies.

Comparison:

| Area | Google Workspace CLI today | Our package target |
|---|---|---|
| Primary shape | CLI over all Workspace APIs | Runtime SDK/framework for Google Chat apps and AI bots |
| API coverage | Dynamic Discovery-driven raw methods | Full raw Chat coverage plus high-level Chat intent primitives |
| Chat helper depth | `+send --space --text` only | Send to user/space/group/thread, cards, attachments, replies, private messages, streaming |
| Threading | Raw API required for threaded replies | Thread-safe reply defaults from event, message, URL, or thread ref |
| Cards | Raw API required | Typed builders, parsers, dialogs, forms, validation, prebuilt AI cards |
| Inbound app events | Not a bot runtime | HTTP/Pub/Sub/Workspace Events router, verification, normalization, replay |
| Message parsing | Raw JSON output | Normalized message AST with text, annotations, attachments, cards, reactions, quotes, links |
| User resolution | Raw API calls | Email/mention/resource/member resolution, profile enrichment, ambiguity handling |
| Attachments | Raw metadata/download/upload commands | Download, upload, parse, summarize, transcribe, OCR, Drive export, safety gates |
| Streaming AI responses | Not provided | Create placeholder, patch edits, throttle, recover, finalize |
| Polyglot libraries | CLI binary installed through npm/Homebrew/etc. | Native Node.js and Python packages with shared conformance |
| Agent support | Agent skills for using CLI commands | SDK primitives for building agents inside Chat |
| Best use | Operator/agent can call Workspace APIs from shell | Developers can build durable Chat apps without learning every Chat edge case |

What we should borrow from `gws`:

- Discovery drift awareness.
- Schema introspection.
- Structured JSON everywhere.
- Dry-run for writes.
- Clear auth setup and scope explanation.
- Agent-friendly docs and recipes.
- A CLI that can inspect, replay, and smoke-test behavior.

What we should intentionally improve:

- Do not stop at generated methods. Generated methods are the substrate.
- Make Chat events, messages, threads, cards, and attachments first-class domain objects.
- Provide reusable runtime adapters rather than only shell commands.
- Provide Node and Python APIs that feel native in each language.
- Provide semantic conformance tests so both languages behave the same.
- Build around AI response loops: context, streaming edits, approvals, attachment understanding, and safety policies.

## Package Shape

The SDK should have three layers.

### Layer 1: Raw And Typed Google Chat Client

- Generated or hand-curated TypeScript types for Chat resources.
- Low-level REST/gRPC client wrappers.
- Strongly typed request and response objects.
- Pagination helpers.
- Retry and backoff.
- Scope-aware errors.
- API discovery/version reporting.
- Passthrough access for methods not yet wrapped.

### Layer 2: Intent Primitives

- `send.toUser(...)`
- `send.toSpace(...)`
- `send.toGroup(...)`
- `reply.toEvent(...)`
- `reply.inThread(...)`
- `messages.stream(...)`
- `attachments.downloadAll(...)`
- `attachments.parseAll(...)`
- `cards.build(...)`
- `dialogs.open(...)`
- `spaces.ensureDm(...)`
- `users.resolve(...)`
- `members.add(...)`
- `reactions.add(...)`
- `pins.ensurePinned(...)`
- `context.fromEvent(...)`

These should compose several Google APIs and make default choices that match user expectations.

### Layer 3: AI Application Framework

- Event router.
- State store adapter.
- Background job queue.
- Conversation context builder.
- Model streaming bridge.
- Tool progress cards.
- Approval and confirmation UI.
- Attachment understanding pipeline.
- Safe-send policies.
- Local emulator and fixture replay.
- Observability and audit trail.

## Proposed Developer API Sketch

```ts
import { GoogleChatAI } from "@ours/googlechatai";

const chat = new GoogleChatAI({
  auth: {
    app: serviceAccountAuth,
    user: oauthBroker,
  },
  store,
});

chat.onMessage(async (event) => {
  const ctx = await chat.context
    .fromEvent(event)
    .includeThread({ limit: 50 })
    .includeAttachments({ parse: true })
    .resolveUsers();

  await chat.reply(event).stream(model.stream(ctx));
});

await chat.send.toUser("ada@example.com", {
  text: "The report is ready.",
  card: chat.cards.approval({
    title: "Send summary to the team?",
    approveAction: "send_summary",
  }),
});

await chat.attachments.fromEvent(event).downloadAll("/tmp/chat-files");
await chat.spaces.ensureGroup(["ada@example.com", "grace@example.com"]);
```

Python should be equally first-class, not a generated afterthought:

```python
from googlechatai import GoogleChatAI

chat = GoogleChatAI(
    auth={
        "app": service_account_auth,
        "user": oauth_broker,
    },
    store=store,
)

@chat.on_message
async def handle_message(event):
    ctx = (
        await chat.context
        .from_event(event)
        .include_thread(limit=50)
        .include_attachments(parse=True)
        .resolve_users()
    )

    await chat.reply(event).stream(model.stream(ctx))

await chat.send.to_user(
    "ada@example.com",
    text="The report is ready.",
    card=chat.cards.approval(
        title="Send summary to the team?",
        approve_action="send_summary",
    ),
)
```

## Capability Model

Every high-level feature should expose a capability check before execution:

```ts
const capability = await chat.can("messages.stream", {
  target: event.message,
  auth: "app",
});

if (!capability.ok) {
  console.log(capability.reason);
  console.log(capability.requiredScopes);
}
```

Capability checks should cover:

- Required auth mode: app, user, admin, import.
- Required OAuth scopes.
- Space type: DM, group chat, named space, imported space.
- Threading support.
- Whether the app created the message.
- Whether the user is a member or manager.
- Whether the action is preview-only.
- Whether attachments, cards, private messages, or user-auth cards are allowed.
- Whether an operation is outside the default user-installed chatbot path and
  must be treated as an explicit enterprise/admin extension.

## Deep Event And Message Abstraction Design

This is the core product promise: developers should not need to understand every variant of Google Chat event payload, message object, annotation, card action, and Workspace Events wrapper before building a useful bot.

### Normalized Event Envelope

All inbound payloads should be converted into one canonical envelope before user code sees them.

```ts
export interface ChatEventEnvelope {
  eventId: string;
  receivedAt: string;
  source: "chat_http" | "workspace_events" | "pubsub" | "fixture";
  kind: ChatEventKind;
  rawKind: string | null;
  actor: ChatUserRef | null;
  space: ChatSpaceRef | null;
  thread: ChatThreadRef | null;
  message: NormalizedMessage | null;
  action: NormalizedAction | null;
  dialog: NormalizedDialogEvent | null;
  linkPreview: NormalizedLinkPreview | null;
  membership: NormalizedMembershipEvent | null;
  reaction: NormalizedReactionEvent | null;
  locale: string | null;
  timeZone: string | null;
  authContext: AuthContext;
  capabilities: CapabilitySnapshot;
  idempotencyKey: string;
  raw: unknown;
}
```

Python should expose the same canonical JSON shape, with idiomatic wrappers:

```python
from dataclasses import dataclass
from typing import Any, Literal

@dataclass(frozen=True)
class ChatEventEnvelope:
    event_id: str
    received_at: str
    source: Literal["chat_http", "workspace_events", "pubsub", "fixture"]
    kind: str
    raw_kind: str | None
    actor: "ChatUserRef | None"
    space: "ChatSpaceRef | None"
    thread: "ChatThreadRef | None"
    message: "NormalizedMessage | None"
    action: "NormalizedAction | None"
    capabilities: "CapabilitySnapshot"
    idempotency_key: str
    raw: Any
```

The canonical envelope should preserve raw payloads but make normal handler code operate only on stable SDK objects.

### Event Kind Taxonomy

The SDK should normalize direct Chat app events, deprecated event wrappers, card/dialog actions, Pub/Sub deliveries, and Workspace Events into this taxonomy:

- `message.created`
- `message.updated`
- `message.deleted`
- `message.mentioned_app`
- `message.direct`
- `message.thread_reply`
- `message.slash_command`
- `message.app_command`
- `message.link_preview_requested`
- `message.unknown_command`
- `space.added`
- `space.removed`
- `space.updated`
- `space.deleted`
- `membership.created`
- `membership.updated`
- `membership.deleted`
- `reaction.created`
- `reaction.deleted`
- `card.clicked`
- `dialog.opened`
- `dialog.submitted`
- `dialog.cancelled`
- `widget.updated`
- `event.batch`
- `event.unknown`

Each normalized event kind should define:

- Which raw payload families can produce it.
- Whether `message`, `action`, `space`, `thread`, and `actor` are guaranteed.
- Which auth modes can respond synchronously.
- Which async follow-up methods are available.
- Which common edge cases exist.

### Message AST

The inbound `Message` object should be parsed into a stable AST rather than leaving developers to inspect many optional fields.

```ts
export interface NormalizedMessage {
  ref: ChatMessageRef;
  space: ChatSpaceRef;
  thread: ChatThreadRef | null;
  sender: ChatUserRef | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  isDeleted: boolean;
  isThreadReply: boolean;
  isPrivate: boolean;
  privateViewer: ChatUserRef | null;
  text: string;
  formattedText: string | null;
  argumentText: string | null;
  plainTextForModel: string;
  segments: MessageSegment[];
  mentions: UserMention[];
  links: LinkMention[];
  customEmojis: CustomEmojiMention[];
  slashCommand: SlashCommandCall | null;
  appCommand: AppCommandCall | null;
  attachments: NormalizedAttachment[];
  attachedGifs: NormalizedGif[];
  cards: NormalizedCard[];
  accessoryWidgets: NormalizedAccessoryWidget[];
  reactions: ReactionSummary[];
  quotedMessage: QuotedMessageRef | null;
  deletion: DeletionMetadata | null;
  raw: unknown;
}
```

Segment types:

- Plain text segment.
- User mention segment.
- Custom emoji segment.
- URL segment.
- Rich link segment.
- Slash command segment.
- Unknown annotation segment.

Message parser outputs:

- `message.text`: best-effort user-visible plain text.
- `message.commandText`: normalized command or argument text after bot mention/slash command.
- `message.modelText`: model-ready text with mentions and links rendered explicitly.
- `message.entities`: all mentions, links, emoji, attachments, cards, commands, and quotes in occurrence order.
- `message.attachments`: normalized file objects ready for metadata fetch/download/parse.
- `message.cards`: normalized cards plus extracted actions/form state.
- `message.replyTarget`: the safest thread/message target for a response.

### Action And Form AST

Card actions, dialog submissions, widget updates, and slash/app commands should produce one action object:

```ts
export interface NormalizedAction {
  actionId: string;
  actionType:
    | "slash_command"
    | "app_command"
    | "card_click"
    | "dialog_submit"
    | "dialog_cancel"
    | "widget_update"
    | "link_preview";
  methodName: string | null;
  parameters: Record<string, string>;
  formInputs: Record<string, FormInputValue>;
  selectedUsers: ChatUserRef[];
  selectedSpaces: ChatSpaceRef[];
  validationErrors: ValidationError[];
  raw: unknown;
}
```

The parser should support:

- Scalar string inputs.
- Multi-value selection inputs.
- Date inputs.
- Time inputs.
- Date-time inputs.
- Switch/checkbox values.
- User pickers.
- Space pickers.
- Dynamic data-source selections.
- Hidden action parameters.
- Repeated widgets with stable paths.
- Unknown input preservation.

### Parser Pipeline

Implementation pipeline:

1. Receive bytes and headers.
2. Verify source and signature/token.
3. Decode JSON.
4. Detect payload family: direct Chat HTTP event, Pub/Sub wrapper, Workspace Events event, or fixture.
5. Extract raw event kind and stable event ID.
6. Materialize resource refs for space, thread, message, user, membership, reaction, and attachment resources.
7. Parse message into the AST.
8. Parse annotations into ordered segments.
9. Parse attachments into normalized media refs.
10. Parse cards, dialogs, widgets, and form inputs.
11. Classify intent: direct message, mention, slash command, app command, card action, link preview, passive event, membership change, reaction change.
12. Attach capability snapshot.
13. Compute idempotency key.
14. Route to handlers.
15. Persist a compact event record for replay if configured.

### Edge Cases The SDK Must Hide

- Message events without text.
- Card-click events whose useful data lives in action parameters and common form inputs.
- Slash commands where the command text is split between `slashCommand`, `text`, `formattedText`, and `argumentText`.
- Bot mention events where the app mention should be stripped from user intent text.
- Direct messages where the space is a DM and no thread behavior is expected.
- Named spaces where reply threading is expected.
- Spaces that do not support threaded replies.
- Workspace Events batch wrappers.
- Deleted messages with partial metadata.
- Edited messages where previous content is unavailable.
- Private messages visible only to one user and the app.
- Attachments where metadata is present but bytes require a separate media download.
- Drive-backed attachments where Drive export permissions differ from Chat permissions.
- Card messages where fallback text is missing.
- Link preview events that should update a user-visible card rather than send a normal reply.
- Reaction events that should be treated as workflow input, not chat text.
- Membership events for apps, groups, humans, external users, and deleted users.
- Users whose email or display name is unavailable.
- Resource names that include client-assigned message IDs.
- Retried events that must not double-send.

### Event Handler Contract

Handlers should receive high-level helpers bound to the event:

```ts
chat.on("message.mentioned_app", async (event, ctx) => {
  const prompt = event.message.commandText;
  const files = await ctx.attachments.downloadAndParseAll();
  await ctx.reply.stream(model.stream({ prompt, files }));
});
```

The `ctx` object should provide:

- `ctx.reply(...)`.
- `ctx.reply.stream(...)`.
- `ctx.privateReply(user, ...)`.
- `ctx.thread.load(...)`.
- `ctx.space.get(...)`.
- `ctx.users.resolve(...)`.
- `ctx.attachments.list/download/parse`.
- `ctx.cards.respond(...)`.
- `ctx.dialog.open(...)`.
- `ctx.actions.ack(...)`.
- `ctx.defer(...)`.
- `ctx.audit.log(...)`.

This keeps the raw Google event shape out of application handlers almost entirely.

## Complete Feature Inventory

### 1. Inbound Event Handling And Routing

The SDK should normalize every way an app can receive Chat activity.

Core event ingestion:

- Accept Google Chat HTTP app events.
- Accept Google Workspace Add-on style Chat events where relevant.
- Accept Pub/Sub push events.
- Accept Pub/Sub pull events.
- Accept Workspace Events API payloads for Chat resources.
- Accept historical fixture JSON for tests and replay.
- Verify Google-signed request tokens and JWTs.
- Verify Pub/Sub push JWTs.
- Deduplicate retried events by event ID, message ID, thread ID, and delivery timestamp.
- Acknowledge quickly and offload slow AI work to background jobs.
- Preserve raw payloads for debugging when configured.

Event router primitives:

- `onMessage`
- `onMention`
- `onDirectMessage`
- `onThreadReply`
- `onAddedToSpace`
- `onRemovedFromSpace`
- `onSlashCommand`
- `onAppCommand`
- `onCardClicked`
- `onDialogOpened`
- `onDialogSubmitted`
- `onDialogCancelled`
- `onWidgetUpdated`
- `onLinkPreview`
- `onReactionCreated`
- `onReactionDeleted`
- `onMembershipCreated`
- `onMembershipUpdated`
- `onMembershipDeleted`
- `onMessageUpdated`
- `onMessageDeleted`
- `onSpaceUpdated`
- `onSpaceDeleted`
- `onSpaceEvent`
- `onUnknownEvent`

Inbound event normalization:

- Normalize `DeprecatedEvent.type`.
- Normalize `DeprecatedEvent.message`, `space`, `thread`, `threadKey`, `user`, `common`, `action`, `dialogEventType`, `appCommandMetadata`, and `eventTime`.
- Convert old and new event naming into stable SDK event names.
- Convert resource names into typed handles: `SpaceRef`, `ThreadRef`, `MessageRef`, `UserRef`, `MembershipRef`.
- Detect bot self-messages and prevent loops.
- Detect whether the app was mentioned.
- Detect whether the message was in a DM.
- Detect whether the message was a thread reply.
- Extract command text after bot mention or slash command into `argumentText`.
- Extract form inputs into a typed object.
- Extract clicked button metadata and hidden parameters.
- Extract link preview targets.
- Extract locale, timezone, host app, and user context from common event data.

Developer ergonomics:

- Route by regex, slash command, app command, mention, space, user, thread, card action, or custom predicate.
- Middleware chain for auth, authorization, logging, AI context, and error handling.
- Async handler timeouts with user-visible fallback messages.
- Handler idempotency keys.
- Fixture generator from live payloads.
- Local emulator for sending mock Chat events into handlers.
- Event inspector CLI that prints parsed message text, attachments, cards, actions, and auth capability.

### 2. Message Composition And Delivery

Developers should never need to remember Chat resource names for common sends.

Send primitives:

- Send text to a space.
- Send text to a user by email, user resource name, mention, or People/Admin Directory ID.
- Send text to the current event's space.
- Send text to a group chat by participant list.
- Send to an existing DM, or create/setup the DM if missing.
- Send to an existing group chat, or create/setup the group chat if missing.
- Send to a named space by display name, URL, resource name, or alias.
- Send a top-level message.
- Start a new thread.
- Reply to an existing thread by event, thread name, thread key, message name, message URL, or client message ID.
- Reply to the current message's thread when appropriate.
- Quote a message.
- Send a private message visible only to one user and the Chat app.
- Send message with text and cards.
- Send message with cards only.
- Send message with accessory widgets.
- Send message with attachments.
- Send import-mode historical messages where permitted.

Message content helpers:

- Plain text.
- Formatted text.
- Safe mention builder for users.
- Safe link builder.
- Custom emoji markup helper.
- Code block helper.
- Table-to-text helper for small tabular output.
- Object-to-card helper.
- Object-to-file helper for large JSON, CSV, log, or code outputs.
- Fallback text generator for card messages.
- Message byte-size estimator for Chat's message-size limits.
- Message splitting when text is too long.

Idempotency and naming:

- Generate `requestId` for create calls.
- Generate valid custom `messageId` values that begin with `client-`.
- Let developers provide stable client message IDs.
- Recover messages by client ID.
- Support `allowMissing` upserts where safe.
- Track message names returned by Chat.

Notification and visibility:

- Expose `createMessageNotificationOptions.notificationType` where supported.
- Treat `silent` as output-only, not a send option.
- Expose `privateMessageViewer` with guardrails: app auth, create-time only, and no attachments.
- Make user-auth versus app-auth sender attribution clear.
- Warn before sending to external spaces.
- Warn before sending to large spaces.
- Require confirmation policies for broad or external sends.

### 3. Replying, Threads, And Conversation Sessions

Threading is central for AI assistants.

Thread primitives:

- `reply(event, content)` uses the correct space and thread.
- `replyInThread(messageOrThread, content)`.
- `startThread(space, content, options)`.
- `ensureThread(space, threadKey, starterContent)`.
- `getThread(messageOrThreadRef)`.
- `listThreadMessages(threadRef, options)`.
- `loadThreadContext(event, options)`.
- `getThreadReadState(threadRef)`.
- `parseThreadUrl(url)`.
- `parseMessageUrl(url)`.

Thread identity:

- Normalize `thread.name`.
- Normalize `threadKey` and deprecated `threadKey` parameter.
- Normalize `messageReplyOption`.
- Support named-space-only reply option behavior.
- Detect non-threaded spaces and fall back to top-level replies.
- Track SDK session ID by space, thread, user, and app.

AI session helpers:

- Use one thread as one AI conversation by default.
- Optionally scope session to user plus thread.
- Optionally scope session to direct message space.
- Load prior messages with max count, max tokens, and time window.
- Exclude bot messages or include bot messages as assistant turns.
- Include edits, reactions, quotes, attachments, and cards in context.
- Collapse long threads into summaries.
- Store rolling memory per thread.

### 4. Message Reading, Search, And Context Loading

The SDK should make Chat history usable as model context while respecting auth limits.

Read primitives:

- Get message by resource name.
- Get message by client-assigned message ID.
- List messages in a space.
- List messages in a thread.
- Search messages where the REST/docs surface supports it.
- Get messages around a specific message.
- Get latest N messages.
- Get messages since timestamp.
- Get messages by sender.
- Get messages mentioning user or app.
- Get messages with attachments.
- Get messages with cards.
- Get messages with links.
- Get messages with reactions.
- Get deleted-message metadata.

Message parser:

- Extract `text`.
- Extract `formattedText`.
- Extract `argumentText`.
- Extract `annotations`.
- Extract user mentions.
- Extract slash command metadata.
- Extract matched URLs.
- Extract rich link metadata.
- Extract custom emoji metadata.
- Extract cards v1 and cards v2.
- Extract accessory widgets.
- Extract attachments.
- Extract Drive refs.
- Extract attached GIFs.
- Extract reaction summaries.
- Extract quoted message metadata.
- Extract private-message viewer.
- Extract sender, create time, update time, delete time, and thread fields.

AI context builder:

- Convert Chat messages into model-ready chat turns.
- Resolve sender display names and stable IDs.
- Preserve message URLs for citation.
- Summarize or include attachment contents.
- Include card state and form submissions.
- Include reactions as lightweight feedback.
- Include quoted messages inline.
- Trim context by token budget.
- Redact sensitive content by policy.
- Mark unsupported or inaccessible messages explicitly.

### 5. Message Editing, Deletion, And Streaming

Google Chat does not have token streaming, but an SDK can synthesize it through create plus patch.

Edit primitives:

- Patch message text.
- Patch attachments.
- Patch cards.
- Patch cards v2.
- Patch accessory widgets.
- Remove quoted message metadata.
- Update messages with generated update masks.
- Replace cards using docs-listed `spaces.messages.replaceCards` where available.
- Upsert with `allowMissing` for client-assigned IDs.
- Delete a message.
- Soft-delete locally by editing content before deletion where policy requires.

Streaming primitives:

- `stream.reply(event, asyncIterable)`.
- `stream.toThread(threadRef, asyncIterable)`.
- `stream.toUser(userRef, asyncIterable)`.
- Create placeholder message.
- Patch text chunks at a configured cadence.
- Patch progress card while tools run.
- Switch from progress card to final text/card.
- Split or compact output before hitting message-size limits.
- Handle rate limits and edit quotas.
- Recover if a patch fails.
- Resume streaming after worker restart using stored stream state.
- Cancel in-flight stream from card button or reaction.
- Finalize with metadata, citations, attachments, or action buttons.

Streaming policies:

- Throttle by time and byte delta.
- Avoid patching on every token.
- Stop editing after final response.
- Preserve original prompt quote where useful.
- Use fallback plain text if cards fail.
- Prefer edits over new messages for AI token output to avoid chat spam.

Deletion guardrails:

- Make it explicit that apps can only update/delete messages they are allowed to modify.
- Refuse to delete another user's message unless auth and API support are verified.
- Log deletion requests with actor and target.
- Offer dry-run deletion plans.

### 6. Attachments, Media, And File Understanding

Attachment handling should be first-class. This is one of the largest gaps in existing packages.

Attachment primitives:

- List attachments on an inbound message.
- Get attachment metadata by attachment resource name.
- Download attachment data through the media API.
- Upload attachment up to Chat's current media limit, verified from discovery as 200 MB on 2026-06-29.
- Create a message with uploaded attachment references.
- Patch message attachments where supported.
- Save attachments to a local path, cloud bucket, memory buffer, or stream.
- Generate temporary signed URLs from downloaded content when needed.
- Preserve content name, content type, source, thumbnail URI, Drive data ref, and attachment data ref.

Attachment parsing:

- MIME-type detection.
- Extension detection.
- File signature detection.
- Size checks before download.
- Image OCR.
- Image captioning.
- Audio transcription.
- Video keyframe extraction.
- PDF text extraction.
- Google Docs/Sheets/Slides export via Drive APIs where Drive refs are present and auth allows.
- CSV/TSV parsing.
- JSON/YAML/XML parsing.
- Plain text and code parsing.
- Archive inspection with strict size and recursion limits.
- Unknown file fallback: store, label, and ask user for permission or clarification.

Output attachment helpers:

- Send generated text as `.txt`, `.md`, `.json`, `.csv`, or `.log`.
- Send generated document/report as PDF.
- Send generated image.
- Send generated audio.
- Send generated chart image plus accessible text.
- Attach a structured object as JSON.
- Attach a table as CSV.
- Attach a code bundle as zip where policy allows.

Security controls:

- File size caps lower than Chat's max by default.
- MIME allowlist and denylist.
- Blocked file type detection.
- Malware scanning hook.
- SSRF protection for external URLs.
- PII redaction pipeline.
- Data retention policy for downloaded attachments.
- Optional encryption at rest.
- Explicit handling for external/shared Drive links.

### 7. Cards, Dialogs, Forms, And Rich Objects

Cards are too complex to leave as raw JSON.

Card builder coverage:

- Card v2 wrapper.
- `CardWithId`.
- Card header.
- Sections.
- Collapsible sections.
- Fixed footer.
- Text paragraph.
- Decorated text.
- Images.
- Image components.
- Image crop styles.
- Buttons.
- Button lists.
- Text buttons.
- Image buttons.
- Chips.
- Chip lists.
- Overflow menus.
- Dividers.
- Columns.
- Grids.
- Carousels.
- Material icons.
- Open links.
- Form actions.
- Card actions.
- Common widget actions.
- Visibility conditions.
- Validation.
- Switch controls.
- Selection inputs.
- Text inputs.
- Date picker.
- Time picker.
- Date-time picker.
- Suggestions.
- Platform data sources.
- Update visibility actions.
- Accessory widgets.

Dialog and form primitives:

- Open dialog from card action.
- Update dialog.
- Close dialog.
- Handle dialog submit.
- Handle dialog cancel.
- Parse form inputs into typed objects.
- Validate form inputs server-side.
- Return field-level errors where Chat supports them.
- Preserve hidden action parameters.
- Preserve state across multi-step forms.
- Populate dynamic select options.
- Handle autocomplete or widget update events.

Rich object helpers:

- `cards.approval(...)`.
- `cards.confirmation(...)`.
- `cards.progress(...)`.
- `cards.error(...)`.
- `cards.summary(...)`.
- `cards.table(...)`.
- `cards.fileReview(...)`.
- `cards.toolResult(...)`.
- `cards.multiChoice(...)`.
- `cards.poll(...)`.
- `cards.feedback(...)`.
- `cards.continueCancel(...)`.
- `cards.userPicker(...)`.
- `cards.dateTimeRequest(...)`.
- `cards.linkPreview(...)`.

Card parsing:

- Read incoming cards.
- Extract card IDs.
- Extract header, sections, widgets, buttons, links, and form controls.
- Extract action method names or invoked functions.
- Extract hidden parameters.
- Convert card submissions into typed actions.
- Convert card contents into plain-text summaries for AI context.

Card safety and quality:

- Generate fallback text for every card message.
- Validate card JSON before send.
- Enforce mobile-friendly layouts.
- Enforce maximum widget/card sizes.
- Offer snapshot tests for card JSON.
- Offer local card preview where possible.
- Mark unsupported widgets by surface.

### 8. Link Previews, Rich Links, And URL Handling

Developers need one place to manage link behavior.

Link features:

- Detect matched URLs in inbound messages.
- Parse rich link metadata.
- Build Chat link preview cards.
- Update link preview cards after background fetch.
- Unfurl internal app resources.
- Suppress unsafe external fetches.
- Fetch URL metadata with SSRF protection.
- Attach previews to AI citations.
- Convert Chat message, thread, and space URLs into resource refs.
- Generate direct URLs to messages and spaces from resource refs where supported.

### 9. Reactions, Feedback, And Custom Emoji

Reactions should be usable as UI and feedback, not only raw API resources.

Reaction primitives:

- Add reaction.
- Delete reaction.
- List reactions on a message.
- Check whether a user reacted with an emoji.
- Wait for a reaction with timeout.
- Use reactions as approval, cancellation, or feedback signals.
- Include reaction summaries in model context.
- Map standard emoji aliases to Chat emoji resources.

Custom emoji primitives:

- List custom emojis.
- Get custom emoji.
- Create custom emoji.
- Delete custom emoji.
- Resolve `:name:` to emoji resource.
- Extract custom emoji annotations from messages.
- Cache custom emoji lookup.

AI feedback workflows:

- Treat thumbs-up/thumbs-down reactions as response quality feedback.
- Trigger "continue", "stop", "retry", or "summarize" from configured reactions.
- Route negative reactions to review queue.

### 10. Pins, Highlights, And Space Memory

Message pinning appears in the public REST docs and should be included behind a verified capability flag.

Pin primitives:

- Pin a message.
- Unpin a message.
- List pinned messages.
- Ensure a message is pinned.
- Ensure only one summary message is pinned.
- Pin the latest thread summary.
- Pin a decision or artifact link.
- Read pinned messages into AI context.

Implementation note:

- Track `spaces.messagePins.create`, `spaces.messagePins.delete`, and `spaces.messagePins.list` as docs-listed surfaces. Verify generated-client support and live API behavior before marking them stable.

### 11. Spaces, DMs, Group Chats, And Rooms

Space handling should be based on what the developer wants, not on remembering Chat topology.

Space primitives:

- Get space.
- List spaces visible to app or user.
- Search spaces.
- Create named space.
- Setup space with initial members.
- Setup direct message.
- Setup group chat.
- Find direct message.
- Find group chat.
- Delete space.
- Update space metadata.
- Complete import mode for a space.
- Parse space URL.
- Generate space URL where possible.
- Get space events.
- List space events.

Convenience methods:

- `spaces.ensureDm(user)`.
- `spaces.ensureGroup(users)`.
- `spaces.ensureNamedSpace(name, options)`.
- `spaces.findByDisplayName(name)`.
- `spaces.findByUrl(url)`.
- `spaces.findForThread(threadUrl)`.
- `spaces.archiveOrDelete(spaceRef, policy)`.

Space fields and settings:

- Display name.
- Space type.
- Threading state.
- Space history state.
- Space details.
- Access settings.
- Permission settings.
- Predefined permission settings.
- External user allowed.
- Membership count.
- Admin-installed app flag.
- Single-user bot DM flag.
- Import mode and import expiration.
- Last active time.

AI-specific space behavior:

- Detect external spaces and use stricter send policy.
- Detect large spaces and ask for confirmation.
- Detect DMs and use more conversational defaults.
- Detect named spaces and prefer thread replies.
- Cache space metadata.
- Reconcile missing access by explaining required install or scope.

### 12. Memberships, Users, And Identity Resolution

Identity resolution is a core package feature, not an afterthought.

Membership primitives:

- List members.
- Get member.
- Add user.
- Add group where supported.
- Add app where supported.
- Remove member.
- Update member role.
- Leave space where supported.
- Check whether user is a member.
- Check whether user is a manager.
- Invite missing users before sending where policy allows.
- Handle suspended, deleted, external, or inaccessible users.

User resolution:

- Resolve by Chat user resource name.
- Resolve by email.
- Resolve by mention annotation.
- Resolve by display name with ambiguity handling.
- Resolve by membership name.
- Resolve by People API ID where integrated.
- Resolve by Admin Directory ID where integrated.
- Resolve current event user.
- Resolve all mentioned users.
- Resolve all active thread participants.
- Distinguish human, app, bot, anonymous, and deleted users.

User profile enrichment:

- Display name.
- Email where available.
- Avatar URL where available.
- Locale.
- Timezone from event context.
- Organization metadata through Admin Directory when configured.
- External user status.
- Membership role per space.

Caching:

- Cache user profiles by stable resource name.
- Cache email to resource mapping.
- Cache membership lists with invalidation from membership events.
- Preserve ambiguity when a name maps to multiple users.

### 13. Availability, Read State, Notifications, And Sections

The discovery document exposes user-side Chat state APIs that most bot libraries ignore.

Availability primitives:

- Get availability.
- Mark as active.
- Mark as away.
- Mark as do not disturb.
- Update availability.
- Explain user-auth and scope requirements.
- Avoid changing availability unless explicitly requested by a user workflow.

Read-state primitives:

- Get space read state.
- Update space read state.
- Get thread read state.
- Mark space read.
- Mark thread read where supported by available APIs.
- Build unread summary from read state plus message list.

Notification-setting primitives:

- Get space notification setting.
- Patch space notification setting.
- Mute/unmute a space where supported.
- Set notification policy for an AI project space.

Section/navigation primitives:

- Create user section.
- List user sections.
- Patch user section.
- Delete user section.
- Reposition user section.
- List section items.
- Move a space into a section.
- Organize AI-created or AI-monitored spaces into a section.

Guardrail:

- Treat these as user-account operations, not bot operations. Require explicit user consent and clear UI.

### 14. Workspace Events And Passive Monitoring

Passive monitoring is different from direct interaction handling.

Space event primitives:

- List space events.
- Get space event.
- Filter for message events.
- Filter for membership events.
- Filter for reaction events.
- Filter for space update events.
- Handle batch event variants.
- Store checkpoints.
- Reconcile missed events.
- Replay from checkpoint.

Workspace Events integration:

- Create subscriptions where the separate Workspace Events API allows it.
- Renew subscriptions.
- List subscriptions.
- Delete subscriptions.
- Validate Pub/Sub delivery.
- Map Workspace Events resource names back to Chat resources.
- Explain when direct Chat app events are enough and when Workspace Events is required.

Monitoring workflows:

- Monitor all messages in spaces the app can access.
- Monitor reactions as lightweight workflow triggers.
- Monitor membership changes.
- Monitor deleted or edited messages where events expose them.
- Maintain local searchable mirror when permitted.
- Respect retention and privacy policy.

### 15. Admin, Import, And Compliance Features

Some Chat workflows are admin or migration workflows, not normal chatbot workflows.

Admin features:

- Use admin access for space search where available.
- Use admin access for space get/list/update/delete where available.
- Use admin access for membership get/list/create/update/delete where available.
- Explain admin scopes, and keep domain-wide delegation out of the default
  chatbot path.
- Dry-run admin actions before execution.
- Audit every admin action.

Import features:

- Create import-mode spaces.
- Import historical messages.
- Import historical memberships.
- Import historical reactions.
- Patch import-mode messages.
- Complete import.
- Track import expiration.
- Validate imported timeline ordering.
- Map source system users to Chat users.
- Preserve source message IDs in client message IDs or metadata store.

Compliance-adjacent features:

- Export local audit records of sends, edits, deletes, downloads, and admin actions.
- Integrate with Admin SDK Reports or Vault only as separate optional integrations, not as assumed Chat REST features.
- Redact or hash sensitive text in logs.
- Provide tenant-level scope inventory.

### 16. AI-First Workflow Features

These are the features that make the package clearly better than a raw Chat client.

Context and memory:

- Build model context from event, thread, space, participants, attachments, cards, and reactions.
- Summarize long threads.
- Store per-thread memory.
- Store per-space project memory.
- Load relevant prior messages through search.
- Preserve message citations.
- Redact or omit private/sensitive data by policy.

Streaming:

- Stream model responses by editing one message.
- Show tool progress as card updates.
- Replace progress card with final answer.
- Attach generated files after stream finishes.
- Cancel or pause via card button or reaction.

Tool use:

- Render tool calls as progress rows.
- Ask for approval before sensitive tool calls.
- Let users approve/deny in Chat cards.
- Resume workflow after approval.
- Send private approval prompts to a specific user.
- Record action actor and timestamp.

Attachment intelligence:

- Auto-summarize uploaded PDFs.
- OCR images.
- Transcribe audio.
- Extract spreadsheet previews.
- Summarize Drive documents where authorized.
- Ask clarification when attachment cannot be read.

Human-in-the-loop:

- Approval cards.
- Multi-select decision cards.
- Escalation to a user or group.
- "Ask a teammate" workflow.
- "Send draft" versus "send final" workflow.
- Private preview to requester before posting broadly.

Safety:

- Bot self-message loop prevention.
- Cross-space send confirmation.
- External-space warning.
- Broad-recipient warning.
- Dry-run mode for all sends.
- Policy hooks before sending, editing, deleting, or downloading attachments.
- Model-output moderation hook.
- Tool-output redaction hook.

### 17. Developer Experience, Testing, And Tooling

The package should be easy to adopt and easy to debug.

Auth developer experience:

- App/service-account auth helper.
- User OAuth broker.
- Optional enterprise/admin auth helper kept separate from ordinary chatbot
  installs.
- Scope planner.
- Consent URL generator.
- Token store adapters.
- Local keychain/secret manager integration examples.
- Capability explanation errors.

Framework adapters:

- Express.
- Fastify.
- Hono.
- Cloudflare Workers.
- Vercel functions.
- Next.js route handlers.
- Google Cloud Run.
- Firebase Functions.
- Generic Fetch API.

State and queue adapters:

- In-memory for tests.
- SQLite.
- Postgres.
- Redis.
- Durable Objects.
- Cloud Tasks.
- Pub/Sub.
- SQS-compatible queue.

CLI:

- `gchat-ai auth doctor`.
- `gchat-ai scopes explain`.
- `gchat-ai spaces list`.
- `gchat-ai spaces find`.
- `gchat-ai messages send`.
- `gchat-ai messages get`.
- `gchat-ai messages stream-test`.
- `gchat-ai attachments download`.
- `gchat-ai attachments upload`.
- `gchat-ai cards validate`.
- `gchat-ai events replay`.
- `gchat-ai events inspect`.
- `gchat-ai fixtures record`.

Testing:

- Typed fixture library for real Chat events.
- Snapshot tests for cards.
- Mock Chat API client.
- Local event server.
- Deterministic retry tests.
- Attachment test fixtures.
- Auth capability tests.
- Contract tests against discovery schema.
- Optional live smoke tests gated by env vars.

Observability:

- Structured logs with space/thread/message refs.
- OpenTelemetry spans.
- Delivery and patch latency.
- Retry counts.
- Rate-limit events.
- Token and model cost metadata.
- Attachment download/upload metrics.
- Message URL in logs where safe.
- Audit table for sends, edits, deletes, downloads, admin actions, and approvals.

### 18. Security, Privacy, And Governance

The SDK should make the safe path the default.

Security controls:

- Verify inbound Chat requests.
- Verify Pub/Sub push requests.
- Encrypt OAuth tokens at rest.
- Never log raw access tokens.
- Scope minimization recommendations.
- Capability checks before privileged calls.
- SSRF-safe URL fetching.
- Attachment size and type limits.
- Malware scanning hook.
- Retention controls for downloaded media.
- Data residency hooks for storage adapters.

Privacy controls:

- Redact PII from logs.
- Configurable message retention.
- Configurable attachment retention.
- Separate raw event storage from parsed metadata.
- Private-message guardrails.
- External-space warnings.
- User-visible audit messages for sensitive actions where appropriate.

Governance:

- Per-tenant policy hooks.
- Per-space policy hooks.
- Per-user allow/deny lists.
- Approval requirements for external sends.
- Approval requirements for admin actions.
- Full dry-run mode.
- Explainable errors for missing scopes or blocked policy.

## API Coverage Crosswalk

This table maps the live discovery surface checked on 2026-06-29 to package modules.

| Official method | SDK module | High-level features |
|---|---|---|
| `customEmojis.create` | `customEmoji` | Create custom emoji, alias mapping, emoji resources |
| `customEmojis.delete` | `customEmoji` | Delete custom emoji, cleanup aliases |
| `customEmojis.get` | `customEmoji` | Resolve custom emoji, parse annotations |
| `customEmojis.list` | `customEmoji` | Emoji cache, formatted text helpers |
| `media.download` | `attachments` | Download files, parse media, AI attachment understanding |
| `media.upload` | `attachments` | Upload generated files, attach outputs |
| `spaces.completeImport` | `adminImport` | Complete migration/import |
| `spaces.create` | `spaces` | Create named/import spaces |
| `spaces.delete` | `spaces` | Delete/archive space with guardrails |
| `spaces.findDirectMessage` | `spaces` | `ensureDm`, send to user |
| `spaces.findGroupChats` | `spaces` | `ensureGroup`, group chat lookup |
| `spaces.get` | `spaces` | Space metadata, capability checks |
| `spaces.list` | `spaces` | Space discovery, app/user visible spaces |
| `spaces.patch` | `spaces` | Update space settings and metadata |
| `spaces.search` | `spaces` | Admin/user space search |
| `spaces.setup` | `spaces` | Setup DM/group/named space with members |
| `spaces.members.create` | `members` | Add/invite user, group, app |
| `spaces.members.delete` | `members` | Remove member, leave workflows |
| `spaces.members.get` | `members` | Membership and role lookup |
| `spaces.members.list` | `members` | Participant resolution, membership cache |
| `spaces.members.patch` | `members` | Role updates |
| `spaces.messages.attachments.get` | `attachments` | Attachment metadata |
| `spaces.messages.create` | `messages` | Send, reply, cards, attachments, private messages |
| `spaces.messages.delete` | `messages` | Delete message with guardrails |
| `spaces.messages.get` | `messages` | Read message, context loading |
| `spaces.messages.list` | `messages` | History, thread context, monitoring |
| `spaces.messages.patch` | `messages` | Edit, stream by patch, update cards/attachments |
| `spaces.messages.reactions.create` | `reactions` | React, feedback workflows |
| `spaces.messages.reactions.delete` | `reactions` | Remove reaction, cancel feedback |
| `spaces.messages.reactions.list` | `reactions` | Reaction summaries and triggers |
| `spaces.messages.update` | `messages` | Full update compatibility, prefer patch where possible |
| `spaces.spaceEvents.get` | `events` | Retrieve space event |
| `spaces.spaceEvents.list` | `events` | Passive monitoring, checkpoints |
| `users.availability.get` | `users` | Availability-aware workflows (renamed from `getAvailability` in discovery revision `20260705`) |
| `users.availability.markAsActive` | `users` | User availability operations |
| `users.availability.markAsAway` | `users` | User availability operations |
| `users.availability.markAsDoNotDisturb` | `users` | User availability operations |
| `users.availability.patch` | `users` | User availability operations (renamed from `updateAvailability` in discovery revision `20260705`) |
| `users.sections.create` | `navigation` | Create user Chat sections |
| `users.sections.delete` | `navigation` | Delete user Chat sections |
| `users.sections.items.list` | `navigation` | List spaces in user sections |
| `users.sections.items.move` | `navigation` | Move spaces between sections |
| `users.sections.list` | `navigation` | Read user Chat sidebar organization |
| `users.sections.patch` | `navigation` | Rename/update sections |
| `users.sections.position` | `navigation` | Reorder sections |
| `users.spaces.getSpaceReadState` | `readState` | Unread context, mark/read workflows |
| `users.spaces.spaceNotificationSetting.get` | `notifications` | Read notification settings |
| `users.spaces.spaceNotificationSetting.patch` | `notifications` | Mute/unmute/notification policy |
| `users.spaces.threads.getThreadReadState` | `readState` | Thread unread state |
| `users.spaces.updateSpaceReadState` | `readState` | Mark space read |

Docs-listed surfaces to verify and wrap:

| Docs-listed method | SDK module | Status |
|---|---|---|
| `spaces.messages.replaceCards` | `cards` | Public REST docs list it; verify live support and generated client support |
| `spaces.messages.search` | `messages.search` | Public REST docs list it; verify live support, scopes, and result shape |
| `spaces.messagePins.create` | `pins` | Public REST docs list it; verify live support and scopes |
| `spaces.messagePins.delete` | `pins` | Public REST docs list it; verify live support and scopes |
| `spaces.messagePins.list` | `pins` | Public REST docs list it; verify live support and scopes |

## Auth And Scope Matrix

The SDK should model auth as a first-class input, not as a hidden client detail.

| Auth mode | Typical use | Examples |
|---|---|---|
| App auth | Bot-created messages, cards, accessory widgets, many app interactions | Reply as app, update app-created message, private message to one viewer |
| User auth | Act as a user, upload attachments, create/setup spaces, user read state/settings | Upload file, create group chat, mark read, change section |
| Admin auth | Admin search or management where supported | Search org spaces, manage memberships with admin access |
| Import auth | Migration/import mode spaces | Import messages, members, reactions, complete import |

Every high-level method should define:

- Required minimum auth mode.
- Preferred auth mode.
- Required scopes.
- Optional broader scopes.
- Whether a narrower fallback exists.
- Whether user consent is required.
- Whether admin access can be used.
- Whether the action is preview-only.

## Native, Wrapped, And Synthesized Features

| Feature | Category | Notes |
|---|---|---|
| Send text/card message | Native wrapped | `spaces.messages.create` |
| Reply in current thread | Native wrapped | Requires correct thread fields and reply options |
| Send to user by email | Wrapped | Resolve user, find/setup DM, send message |
| Download inbound file | Native wrapped | Attachment metadata plus `media.download` |
| Parse image/audio/PDF | Synthesized | Requires external/local parsers or AI models |
| Upload output file | Native wrapped | `media.upload`, user auth currently required by discovery |
| Stream model response | Synthesized | Create placeholder, patch text/cards repeatedly |
| Show typing indicator | Synthesized | Use progress/edit pattern; no native typing API assumed |
| Schedule send | Synthesized | Queue job then send later |
| Private ephemeral response | Partial native | `privateMessageViewer` for create-time private message; not true Slack-style ephemeral |
| Read cards from inbound message | Wrapped | Parse message `cards`, `cardsV2`, actions, and form inputs |
| Update cards | Native/docs-listed wrapped | Patch `cards_v2` or use `replaceCards` when verified |
| Pin summary | Docs-listed wrapped | Use message pins once verified |
| Read all org messages | Limited | Requires available scopes/admin/event setup; do not overpromise |
| Edit another user's message | Not supported by default | Only expose if auth/API explicitly permits |
| Delivery receipts | Not native | Approximate with errors, read state, and app logs only |

## Polyglot Node.js And Python Architecture

The package should support Node.js and Python out of the box without making either language feel like a second-class generated binding.

The core engineering principle should be semantic parity, not single-source fantasy. The shared source of truth should be contracts, fixtures, schemas, and conformance tests. The Node and Python implementations should be native, idiomatic, and allowed to use the best local libraries in each ecosystem.

### Repository Layout

```text
/
  docs/
    architecture/
    guides/
    references/
  discovery/
    google-chat-v1-20260623.json
    snapshots/
  spec/
    chat-intents.schema.json
    events.schema.json
    messages.schema.json
    cards.schema.json
    attachments.schema.json
    actions.schema.json
    errors.schema.json
    capabilities.schema.json
  fixtures/
    events/
      message-created/
      slash-command/
      card-click/
      dialog-submit/
      attachment-message/
      workspace-event-batch/
    messages/
    cards/
    attachments/
    api-responses/
    expected/
  conformance/
    cases/
      events.parse.yaml
      messages.send.yaml
      messages.stream.yaml
      attachments.parse.yaml
      cards.actions.yaml
      spaces.ensure-dm.yaml
    runner/
  packages/
    node/
      src/
      test/
      package.json
      tsconfig.json
    python/
      src/googlechatai/
      tests/
      pyproject.toml
  tools/
    codegen/
    discovery-diff/
    fixture-recorder/
    release/
  examples/
    node-express/
    node-cloudflare-worker/
    node-vercel/
    python-fastapi/
    python-flask/
    python-cloud-run/
```

### Shared Contract Strategy

Shared assets:

- Versioned Google Chat discovery snapshots.
- SDK-owned JSON Schemas for normalized events, messages, actions, cards, attachments, errors, and capabilities.
- YAML conformance cases that define inputs, expected normalized outputs, expected API call plans, and expected errors.
- Golden card JSON fixtures.
- Golden streaming patch sequences.
- Golden attachment parser outputs.
- Scope/capability matrices.
- Public behavior docs generated from the conformance suite.

Language-specific assets:

- Native HTTP/auth integration.
- Native runtime adapters.
- Native type surfaces.
- Native testing tools.
- Native package metadata.
- Native examples.

Avoid:

- Python calling a Node child process as the normal runtime path.
- jsii-style constraints unless we later decide class-level API generation is worth the tradeoff.
- A generated API surface that is technically identical but unpleasant in both languages.
- Divergent hidden behavior in edge cases.

### Conformance Case Format

Every meaningful behavior should be represented as a fixture-driven contract.

```yaml
id: events.slash-command.basic
description: Parse a direct slash command into a normalized action and command text.
input:
  fixture: fixtures/events/slash-command/basic.json
expect:
  event:
    kind: message.slash_command
    source: chat_http
    message:
      commandText: "deploy staging"
      isPrivate: false
    action:
      actionType: slash_command
  capabilities:
    canReply: true
    canStream: true
```

API orchestration cases should assert a planned call sequence:

```yaml
id: send.to-user.creates-dm-then-sends
description: Send to a user by email when no DM exists yet.
input:
  method: send.toUser
  args:
    user: ada@example.com
    text: "Report ready"
  mocks:
    spaces.findDirectMessage:
      error: NOT_FOUND
    spaces.setup:
      responseFixture: fixtures/api-responses/spaces/setup-dm.json
expect:
  calls:
    - method: users.resolve
      args:
        email: ada@example.com
    - method: spaces.findDirectMessage
    - method: spaces.setup
    - method: spaces.messages.create
      body:
        text: "Report ready"
```

Both Node and Python must pass the same conformance files before release.

### Node.js Package

Package name candidates:

- `@googlechatai/core`
- `googlechatai`
- `googlechatai`

Technical choices:

- TypeScript-first.
- ESM-first package with CJS compatibility only if demand justifies it.
- Node 22+ baseline (Node 20 reached end-of-life in April 2026 and the pnpm 11 toolchain requires 22+).
- Fetch-compatible transport abstraction.
- Official Google auth/client libraries underneath where practical.
- Zod, TypeBox, or generated JSON Schema validators for runtime validation.
- Vitest for unit/conformance tests.
- tsup or tsdown for builds.
- Typed public API with `strict` TypeScript.
- Runtime adapters for Express, Fastify, Hono, Next.js route handlers, Vercel functions, Cloudflare Workers, and Cloud Run.

Node modules:

- `auth`.
- `events`.
- `messages`.
- `threads`.
- `attachments`.
- `cards`.
- `dialogs`.
- `spaces`.
- `members`.
- `users`.
- `reactions`.
- `pins`.
- `readState`.
- `notifications`.
- `workspaceEvents`.
- `ai`.
- `testing`.
- `cli`.

### Python Package

Package name candidates:

- `googlechatai`
- `google-chat-sdk`
- `gchat-ai`

Technical choices:

- Python 3.10+ minimum, with a strong preference for 3.11+ in examples.
- Pydantic v2 models or dataclass wrappers backed by JSON Schema validation.
- `google-auth` and the official Google Chat client where practical.
- `httpx` transport abstraction for async workflows.
- Sync facade over async core only if it can be kept simple.
- FastAPI, Flask, Starlette, Django, and Cloud Run examples.
- pytest for unit/conformance tests.
- Ruff for linting and formatting.
- mypy or pyright for type checks.
- Hatchling or uv-based build/publish flow.

Python modules:

- `googlechatai.auth`.
- `googlechatai.events`.
- `googlechatai.messages`.
- `googlechatai.threads`.
- `googlechatai.attachments`.
- `googlechatai.cards`.
- `googlechatai.dialogs`.
- `googlechatai.spaces`.
- `googlechatai.members`.
- `googlechatai.users`.
- `googlechatai.reactions`.
- `googlechatai.pins`.
- `googlechatai.read_state`.
- `googlechatai.notifications`.
- `googlechatai.workspace_events`.
- `googlechatai.ai`.
- `googlechatai.testing`.

### Shared Engineering Practices

Build and tooling:

- One monorepo.
- One canonical fixture suite.
- One discovery snapshot update command.
- One conformance runner invoked for both languages.
- One docs site generated from shared spec plus language examples.
- Shared markdown linting.
- Shared JSON Schema validation.
- Shared security policy.
- Shared examples smoke tests.

Recommended root commands:

```bash
just setup
just lint
just test
just conformance
just conformance-node
just conformance-python
just discovery-update
just discovery-diff
just docs
just pack
```

CI gates:

- Node lint/type/test.
- Python lint/type/test.
- Shared schema validation.
- Discovery snapshot drift check.
- Conformance suite in both languages.
- Golden card snapshots.
- Example app smoke tests.
- Package build checks.
- Dependency audit.
- Documentation link check.

Release gates:

- No release if conformance differs between Node and Python.
- No release if generated schemas are stale.
- No release if discovery drift introduces unclassified Chat methods or fields.
- No release if public API docs are missing for new primitives.
- No release if examples fail to start.
- No release if package contents omit required fixtures/schemas.

### Semantic Versioning

Version the SDK contract, not just package internals.

- Patch: bug fix that preserves normalized outputs and high-level call plans.
- Minor: new feature, new method, new parsed field, or new supported event kind.
- Major: breaking normalized schema change, renamed method, changed default send/thread behavior, changed error type, or removed capability.

When Google adds new fields:

- Preserve unknown fields in `raw`.
- Add typed support in a minor release.
- Add conformance fixtures.
- Add capability rules if the field changes behavior.

When Google removes or changes behavior:

- Add discovery drift warning.
- Add runtime compatibility handling.
- Mark deprecated SDK behavior.
- Release a patch or minor if compatibility can be preserved.
- Release a major only if the high-level contract must change.

### Generated Code Versus Hand-Written Code

Use generation for:

- Raw API method metadata.
- Discovery-derived resource types.
- JSON Schema models.
- Documentation tables.
- Scope/capability matrix scaffolding.
- Conformance test wrappers.

Hand-write:

- Event classification.
- Message AST logic.
- Card builders.
- Attachment parsers.
- Send/reply/thread orchestration.
- Streaming edit controller.
- Capability explanations.
- Runtime adapters.
- User-facing errors.

This split gives us resilience to Google API drift without surrendering the developer experience to generated REST method shapes.

## Initial Build Roadmap

### P0: Foundation For AI Chatbots

- Auth broker with app and user auth.
- Event verification and router.
- Normalized event envelope.
- Message AST parser.
- Action/form parser.
- Message refs, space refs, thread refs, user refs.
- Send/reply/thread primitives.
- Edit-based streaming.
- Attachment list/download/upload.
- Basic attachment parsers for text, image metadata, PDF text, and audio handoff.
- Cards v2 builder for common AI cards.
- Form/action parser.
- User and membership resolver.
- Capability checks and scope errors.
- Local fixtures, replay, and mock client.
- Node package with Express/Fastify/Hono examples.
- Python package with FastAPI/Flask examples.
- Shared conformance fixtures for event parsing, send/reply, stream, attachments, and cards.

### P1: Full Chat Surface

- Search and context loading.
- Reactions and custom emoji.
- Space creation/setup/find helpers.
- Membership management.
- Read state, notification settings, sections.
- Workspace Events integration and checkpointing.
- Card parsing and richer card widgets.
- Message pins after live verification.
- CLI for auth, events, messages, attachments, cards.
- Discovery drift checker.
- Cross-language docs with side-by-side Node and Python examples.

### P2: Enterprise And Power Features

- Admin access wrappers.
- Import/migration mode helpers.
- Compliance audit logs.
- Data retention policies.
- Advanced Drive/Docs/Sheets/Slides attachment extraction.
- Tenant policy engine.
- Rich local emulator and card previewer.
- Additional language bindings only after Node and Python conformance is mature.

## Open Verification Tasks

- Live-smoke `spaces.messages.replaceCards`.
- Live-smoke `spaces.messages.search`.
- Live-smoke message pins create/list/delete.
- Confirm which card widgets are accepted in Chat messages versus add-ons/dialogs.
- Confirm exact app-auth/user-auth boundaries for patching attachments and cards in practice.
- Confirm whether generated official clients expose the docs-listed methods.
- Confirm current quota behavior for frequent message patches used for streaming.
- Confirm behavior of `privateMessageViewer` with cards, accessory widgets, and thread replies.
- Confirm attachment upload behavior for app auth if Google changes the current user-auth requirement.
- Confirm Workspace Events subscription lifecycle APIs and Chat event type coverage.
- Smoke the current `gws chat` command surface and keep its Chat helper limitations in the competitive matrix.
- Build the first five canonical event fixtures from real Chat payloads: plain message, bot mention, slash command, card click, and attachment message.
- Build the first three orchestration conformance cases: reply in thread, send to user by email, and stream response by edits.
- Verify official Node and Python client-library support for every Chat method in the discovery crosswalk.
- Decide whether JSON Schema alone is sufficient for shared contracts or whether TypeSpec adds enough value to justify another source format.
- Decide exact package names before publishing any public artifacts.

## Build/Buy/Wrap Decision

The package should wrap official Google client libraries and learn from `gws`, but it should not become either a raw generated CLI or a one-language SDK with thin bindings. The product value is in the higher-level Chat semantics:

- Better event parsing.
- Better resource identity handling.
- Better threading defaults.
- Better attachment and media workflows.
- Better card builders and parsers.
- Better edit-based streaming.
- Better user and membership resolution.
- Better capability errors.
- Better AI-specific context, approval, and safety workflows.

The strongest initial implementation path is:

- A shared contract layer: discovery snapshots, JSON Schemas, fixtures, and conformance tests.
- A native Node.js package: TypeScript, runtime adapters, and strict types.
- A native Python package: Pydantic/dataclass models, async-friendly transport, and FastAPI/Flask examples.
- A small CLI for development and testing: auth doctor, event inspect/replay, card validate, attachment download/upload, and live smoke tests.
- Optional integrations for storage, queues, Drive/Directory enrichment, and AI attachment parsing.

This should be positioned as the Chat-specific application framework that a developer would use after discovering that generic tools like `gws` expose the raw API but do not abstract away Chat events, threads, cards, attachments, streaming edits, or user/message understanding.
