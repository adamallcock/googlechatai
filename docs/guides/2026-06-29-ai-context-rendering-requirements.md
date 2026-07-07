---
title: AI Context Rendering Requirements
date: 2026-06-29
type: guide
status: draft
---

# AI Context Rendering Requirements

AI context rendering is a core SDK surface. The SDK must not pass raw or
context-free Chat text to a model when metadata is available.

## Status

- Implemented: current Node and Python event/message normalization expose
  timestamps, sender refs, thread refs, attachment metadata fields,
  `plainTextForModel`, recursive quote/context fixtures, thread/space context
  readers, card action notes, reaction metadata, attachment metadata notes, and
  disabled-by-default voice-note transcription status. Optional Directory cache
  enrichment can now humanize top-level and recursively quoted context senders
  at model handoff.
- Verified live in the current private live test tenant: user-auth room/thread
  history reads, deleted-message handling, attachment metadata, uploaded media
  download, Drive-backed attachment export, reaction notes, quote hydration, and
  redacted evidence.
- Planned: live Directory authorization, production context storage,
  tokenizer-backed trimming, richer parser packages, and production voice-note
  transcription execution.
- Blocked or gated: live Directory enrichment, real transcription providers,
  and parser/provider live tests require explicit scopes, auth, privacy review,
  and guarded live-smoke coverage.

## Non-Negotiable AI Context Rule

All AI-bound message and context content must include, when available:

- Time context.
- Human-readable sender or actor identity.
- Relationship metadata.
- Attachment and quote system notes.
- Extraction, transcription, truncation, and inaccessibility notes.
- Room/thread history bounds and ordering.

If a field is unavailable, ambiguous, inaccessible, skipped, or truncated, the
AI-bound context must say so explicitly instead of silently omitting it.

## Context Item Requirements

Each AI context item should carry:

- Stable source reference: message, space, thread, attachment, reaction, card,
  or event resource name when available.
- Time: create time, update time, delete time, event receive time, timezone
  when known, and ordering within the rendered context window.
- Sender or actor identity: display name, email when auth allows, user resource
  name, app/bot/human type, and an explicit inaccessible or ambiguous state.
- Relationship metadata: direct message, private/direct reply, thread reply,
  quote, nested quote, forwarded/quoted reference, edit, deletion, reaction,
  card action, or attachment-derived content.
- Source notes: whether the item came from the triggering event, thread
  history, room history, attachment extraction, transcription, or a card action.
- Access notes: whether data was missing because of auth, retention, API
  limits, message deletion, unsupported payload shape, or parser limitations.

## Required System Notes

System notes should be plain text and placed before the user-visible content
they explain.

Attachment metadata:

```text
System Note: Ada Lovelace attached image_123.png (image/png, 2.1 MB) to this thread reply at 2026-06-29T14:05:00Z. Extraction status: skipped because image OCR is not enabled.
```

Quote relationship:

```text
System Note: Grace Hopper quoted an earlier message from Ada Lovelace created at 2026-06-28T19:11:00Z. The quoted message is rendered below as nested context.
```

Thread reply:

```text
System Note: This message is a thread reply in spaces/AAA/threads/BBB, not a new room-level message.
```

Reaction:

```text
System Note: Linus added the reaction thumbs_up to Ada's message at 2026-06-29T15:02:00Z.
```

Card action:

```text
System Note: Ada clicked card action approve_deploy on message spaces/AAA/messages/CCC at 2026-06-29T15:10:00Z. Form inputs are summarized below.
```

Truncation:

```text
System Note: Thread history was limited to 50 messages after 2026-06-28T00:00:00Z. Earlier messages may exist but were not loaded.
```

Inaccessibility:

```text
System Note: The SDK could not resolve the sender email with the current auth scopes. Display name and user resource are shown when available.
```

## Recursive Quotes And Attachments

Quoted messages and attachments must be modeled recursively through the same
context/message structures used for top-level messages. Do not create
one-depth-only fields such as `quotedMessageText` that cannot represent nested
quotes, quoted attachments, or attachment-derived content inside quotes.

Recursive rendering must include:

- The quoted sender identity.
- The quoted message timestamp.
- The relationship note that explains who quoted what.
- The quoted message text or content summary.
- Any quoted cards, reactions, replies, and attachments.
- Depth or size limits with explicit truncation notes.

## Thread And Room History

Thread and room readers must be able to describe:

- Date filters used.
- Message limits used.
- Pagination state and ordering.
- Whether the loaded set is complete, partial, truncated, or inaccessible.
- Whether the triggering message is a direct reply, thread reply, quoted
  message, edit, deletion, card action, or reaction.

Context builders should default to conservative limits and include clear notes
when history is not loaded.

## Attachment And Transcription Status

Every attachment rendered for AI must include metadata before extracted content:

- Original filename or content name.
- MIME/content type.
- Size when known.
- Chat attachment resource name and media resource name when available.
- Source such as uploaded file, Drive reference, URL preview, or unknown.
- Extraction status: disabled, skipped, complete, partial, failed, blocked by
  auth, blocked by size, blocked by unsupported type, or inaccessible.
- Transcription status for audio/voice notes: disabled by default, not
  configured, complete, partial, failed, or blocked.

## Current Implementation Boundary

Current local fixtures prove deterministic AI context notes for messages,
quotes, thread replies, attachments, card actions, reactions, truncation, and
inaccessibility. Private live smoke evidence now proves user-auth history reads,
deleted-message signaling, uploaded-media metadata and download, Drive-backed
attachment export, reaction notes, and quote hydration. Live identity
enrichment, real provider transcription, richer parser packages, production
context storage, and model-token-aware context trimming remain planned or gated
until dedicated fixtures, tests, and guarded live smokes prove them.
