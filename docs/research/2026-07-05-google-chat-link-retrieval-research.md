---
title: Google Chat Link Retrieval Research
date: 2026-07-05
type: research
status: research-complete
---

# Google Chat Link Retrieval Research

## Summary

Google Chat link retrieval should be built around canonical Chat API resource
names, not around browser URLs as the source of truth. Google documents stable
resource names for spaces, threads, and messages, and Chat rich-link metadata
can expose those names directly through `chatSpaceLinkData`.

Browser URL formats are messier. Some space URLs are documented, several current
Chat UI shapes are visible in local smoke evidence, and older thread URL forms
are only community or empirical evidence. The implementation should therefore
use a parser registry with confidence levels and preserve unknown URL shapes for
later corpus expansion instead of guessing thread or message IDs from every path
segment.

Recommended first shipped slice:

- Preserve `richLinkMetadata.chatSpaceLinkData` in normalized links.
- Add Node/Python Chat-link candidate extraction and dry-run retrieval planning.
- Support documented and locally observed space URL shapes.
- Support empirical thread URL shapes at lower confidence.
- Return agent breadcrumbs for space, thread, message, sender, time, API plan,
  access status, and parse confidence.
- Keep live retrieval behind an explicit user-auth feature flag.

## Primary Sources

- [REST Resource: spaces.messages](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages)
- [Method: spaces.messages.get](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/get)
- [Method: spaces.messages.list](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/list)
- [REST Resource: spaces](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces)
- [Method: spaces.get](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces/get)
- [Google Chat Help: Link to a specific message](https://support.google.com/chat/answer/13783975?co=GENIE.Platform%3DDesktop&hl=en)
- [Workspace Updates: Easily link to a specific message in Google Chat](https://workspaceupdates.googleblog.com/2023/09/easily-link-to-specific-message-in-google-chat.html)
- [Google Chat API release notes](https://developers.google.com/workspace/chat/release-notes)

Non-primary empirical source:

- [Web Applications Stack Exchange: older thread-link discussion](https://webapps.stackexchange.com/questions/117392/get-link-to-specific-conversation-thread-and-or-message-in-a-chat-room-in-google)

Local repo evidence:

- The private live project setup runbook (kept outside the public repository)
  contains a dedicated smoke-room URL in the `chat.google.com/room/{spaceId}`
  family.
- The private live QA ledger (kept outside the public repository) contains
  current Chat UI inspections using
  `chat.google.com/u/{accountIndex}/app/chat/{spaceId}`.
- `tools/chat/user-auth-smoke.mjs` currently constructs
  `mail.google.com/chat/u/0/#chat/space/{spaceId}` for a smoke-space link.

## Canonical Chat Resources

The durable API identifiers are:

| Scope | Canonical resource | Retrieval route |
| --- | --- | --- |
| Space | `spaces/{space}` | `spaces.get`, optionally `spaces.messages.list` |
| Thread | `spaces/{space}/threads/{thread}` | `spaces.messages.list` with `thread.name` filter |
| Message | `spaces/{space}/messages/{message}` | `spaces.messages.get`, optionally thread context after read |

The `Message` resource documents `name` as `spaces/{space}/messages/{message}`.
It also exposes `sender`, `createTime`, `lastUpdateTime`, `thread`, `space`,
`matchedUrl`, `quotedMessageMetadata`, and `emojiReactionSummaries`, which are
the core breadcrumb fields for agent context.

`ChatSpaceLinkData` is the cleanest link surface. Google documents it as rich
link metadata for Chat space links with three direct fields:

- `space`: `spaces/{space}`
- `thread`: `spaces/{space}/threads/{thread}`
- `message`: `spaces/{space}/messages/{message}`

The Google Chat API release notes say `chatSpaceLinkData` was added to
`RichLinkMetaData` and made generally available on 2024-09-11. That makes it a
newer and more reliable path than browser URL parsing when an inbound Chat
message contains a Chat smart chip or rich link.

## Message-Link Product Behavior

Google's Help Center says users can copy a link to a specific message from Chat
or Gmail, and only people already in the conversation can access and share those
links. The Help Center also says message links are not available for spaces
grouped by topic.

The Workspace Updates announcement says message linking applies to messages in
spaces, group messages, and direct messages. It also says clicking the link
takes a colleague to the original message as long as they have access.

Implementation implication: the SDK should not assume that a parseable URL means
content is retrievable. It means "candidate link found." Retrieval still depends
on the authenticated principal's membership, history state, message retention,
and the API method's auth scopes.

## Retrieval APIs

### `spaces.messages.get`

Use for exact message links when the canonical message name is known. The REST
path is:

```text
GET https://chat.googleapis.com/v1/{name=spaces/*/messages/*}
```

The method supports user authentication with
`https://www.googleapis.com/auth/chat.messages.readonly` or
`https://www.googleapis.com/auth/chat.messages`. It also supports app
authentication for messages the app can access, plus newer app-message readonly
scope with admin approval. For this SDK, user auth should be the default for
human spaces, DMs, and group conversations.

### `spaces.messages.list`

Use for top-level space context and thread context. The REST path is:

```text
GET https://chat.googleapis.com/v1/{parent=spaces/*}/messages
```

The method supports pagination, `pageSize`, `pageToken`, `orderBy`, `showDeleted`,
and filters by `createTime` and `thread.name`. The thread filter expects
`thread.name` in the canonical `spaces/{space}/threads/{thread}` form.

### `spaces.get`

Use for breadcrumbs about the destination conversation. `Space` exposes
`name`, `displayName`, `spaceType`, `spaceThreadingState`, `spaceUri`,
`lastActiveTime`, `historyState`, and membership counts where available.

`SpaceType` distinguishes:

- `SPACE`
- `GROUP_CHAT`
- `DIRECT_MESSAGE`

Implementation implication: DM and group-chat URLs should not need a different
high-level SDK model. They should resolve to `spaces/{space}` first, then
`spaces.get` can tell the agent whether that space is a named space, group chat,
or DM.

## URL Shape Inventory

| URL or metadata shape | Confidence | Parsed scope | Notes |
| --- | --- | --- | --- |
| `richLinkMetadata.chatSpaceLinkData.space` | High | Space | Structured API metadata. Prefer this over URL parsing. |
| `richLinkMetadata.chatSpaceLinkData.thread` | High | Thread | Direct canonical thread resource. |
| `richLinkMetadata.chatSpaceLinkData.message` | High | Message | Direct canonical message resource. |
| `https://mail.google.com/mail/u/{n}/#chat/space/{spaceId}` | High | Space | Official `spaces` docs use this as the example for extracting a space ID from a URL. |
| `https://mail.google.com/chat/u/{n}/#chat/space/{spaceId}` | Medium | Space | Locally generated by `tools/chat/user-auth-smoke.mjs`; not found as an official example. |
| `https://chat.google.com/room/{spaceId}` | Medium | Space | Present in local live-smoke setup docs. Treat as observed product URL. |
| `https://chat.google.com/room/{spaceId}?cls=...` | Medium | Space | Query string should be ignored for canonical resource extraction. |
| `https://chat.google.com/u/{accountIndex}/app/chat/{spaceId}` | Medium | Space | Present in local live Chat UI evidence. Account index is not part of the Chat API resource. |
| `https://chat.google.com/room/{spaceId}/{threadId}` | Low | Thread | Older community/empirical evidence. Support only with low-confidence parse metadata. |
| Repeated-space-id app URLs | Unknown | Unknown until captured | The suspected newer format may repeat the room/space ID and then include a thread or message segment. Do not infer blindly without a local corpus. |
| DM/group message links | Known product behavior, URL shape underdocumented | Space/thread/message after parse | Product docs say message links work in DMs and group messages. The parser should identify resources, then `spaces.get` should classify the conversation. |

## Existing SDK Surfaces To Reuse

Current code already has the core retrieval and rendering pieces:

- Node/Python message AST normalization extracts `RICH_LINK` annotations and
  `matchedUrl`.
- Node/Python thread context planners already build `spaces.messages.list`
  calls with `thread.name` filters.
- Node/Python context rendering already emits sender, timestamp, thread,
  quote, attachment, reaction, deletion, and truncation notes.
- Drive-link retrieval recently established the right pattern for a durable
  link feature: candidate extraction, dry-run planning, caps, source toggles,
  shared fixtures, Node/Python parity, and explicit future live execution.

Implementation note: normalized `richLink` objects now preserve
`chatSpaceLinkData.space`, `chatSpaceLinkData.thread`, and
`chatSpaceLinkData.message` so the planner can use canonical resources before
falling back to browser URL parsing.

## Recommended Feature Model

### Candidate

Each detected Chat link candidate should include:

- `kind: "chat_link"`
- `candidateId`
- `source`: `chat_space_link_data`, `rich_link_url`, `matched_url`, or `plain_url`
- `originalUrl`
- `parseStatus`: `parsed`, `unknown`, or `invalid`
- `confidence`: `high`, `medium`, `low`, or `unknown`
- `scope`: `space`, `thread`, `message`, or `unknown`
- `space`, `thread`, and `message` canonical names when known
- `urlShape`: a stable parser ID such as `gmail_hash_space`,
  `chat_room_space`, `chat_app_space`, or `chat_room_thread`
- `context`: message name, relationship path, and source annotation index
- `warnings`

### Retrieval Plan

Each plan should be dry-run by default and include request plans, not private
content:

- Space candidate:
  - `spaces.get`
  - optional bounded `spaces.messages.list` for recent context
- Thread candidate:
  - `spaces.get`
  - `spaces.messages.list` with `thread.name = "..."`
- Message candidate:
  - `spaces.messages.get`
  - optional `spaces.get`
  - optional bounded thread-context read after the message response reveals
    `message.thread.name`
- Unknown candidate:
  - no API call
  - return parse warnings and original URL for telemetry/corpus collection

### Agent Breadcrumbs

The agent-facing context should be explicit and provenance-rich:

```json
{
  "kind": "chat.link_context",
  "sourceUrl": "https://chat.google.com/...",
  "source": "chat_space_link_data",
  "confidence": "high",
  "scope": "message",
  "space": {
    "name": "spaces/AAA",
    "displayName": "Launch review",
    "spaceType": "SPACE",
    "spaceUri": "https://chat.google.com/..."
  },
  "thread": {
    "name": "spaces/AAA/threads/thread-1"
  },
  "message": {
    "name": "spaces/AAA/messages/msg-1",
    "sender": {
      "displayName": "Ada Lovelace",
      "email": "ada@example.com",
      "type": "HUMAN"
    },
    "createdAt": "2026-07-05T15:00:00Z",
    "updatedAt": null,
    "deletedAt": null
  },
  "access": {
    "status": "available",
    "authMode": "user",
    "requiredScopes": [
      "https://www.googleapis.com/auth/chat.messages.readonly"
    ]
  },
  "systemNotes": [
    "System Note: This linked Chat message was retrieved with user auth.",
    "System Note: The original URL parsed as chat_app_space with medium confidence."
  ]
}
```

The rendering should make access failures first-class:

- no access to the space
- message deleted
- history off or retention-expired
- unsupported grouped-by-topic message link
- URL shape recognized but insufficient for API retrieval
- link count or message count capped

## Feature Flags And Privacy Boundary

Recommended options:

- `enableChatLinkContext`: master switch for planning/rendering linked Chat
  context.
- `allowLiveChatLinkRetrieval`: separate execution gate; default `false`.
- `authMode`: default `user`.
- `includeRichLinks`, `includeMatchedUrls`, `includePlainTextUrls`.
- `maxChatLinks`, `maxThreadMessages`, `maxSpaceMessages`,
  `maxTraversalDepth`, `maxTraversalNodes`, `maxLinkScanItems`.
- `allowSpaceLevelContext`: optional because top-level space links can reveal
  broad recent context.
- `allowDmContext`: optional extra guard for DMs.

The default should be safe for SDK users:

- parsing and dry-run planning can be enabled without network calls;
- live retrieval requires explicit opt-in and user auth;
- no domain-wide delegation by default;
- no Chat writes;
- no raw private content saved to public fixtures or docs;
- live smokes only target the dedicated smoke space.

## Open Questions For Live Corpus Capture

These need a guarded smoke pass before implementing high-confidence parsing for
every product URL:

- What exact URL does "Copy link" produce in current standalone Chat for:
  - named space top-level message,
  - named space thread root,
  - named space thread reply,
  - group conversation message,
  - direct message,
  - Gmail-hosted Chat?
- When such a link is pasted back into Chat, does the inbound event include
  `richLinkMetadata.chatSpaceLinkData.message`, or only a URL?
- Does the repeated-space-id URL format encode a thread, a message, or a UI
  route state unrelated to the API resource?
- Does `spaces.messages.get` return human-human DM messages with installed-user
  auth in this tenant, or do DMs need a separate product limitation note?
- How do old grouped-by-topic spaces behave now that the Help Center says
  message-link copy is unavailable there?

## Recommendation

Implement this in two phases:

1. Ship the structured metadata + parser + dry-run planner slice with exhaustive
   fixtures and conformance tests. This gives agents reliable breadcrumbs and
   safe API plans without live reads.
2. Add a guarded live executor after capturing a real URL corpus from the
   dedicated smoke space and one controlled DM/group conversation, with private
   evidence stored only under ignored local evidence paths.

This keeps the core SDK abstraction stable even if Google changes the browser
URL grammar, because the public API is based on canonical Chat resources and
parse confidence rather than unversioned UI routes.
