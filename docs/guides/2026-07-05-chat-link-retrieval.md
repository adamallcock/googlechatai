---
title: Chat Link Retrieval
date: 2026-07-05
type: guide
status: implemented-slice-audit-remediated
---

# Chat Link Retrieval

Chat link retrieval planning promotes Google Chat links from rich-link metadata,
matched URLs, and plain pasted URLs into a dry-run Chat API read plan. It is
safe by default: it does not read credentials, call Google APIs, fetch private
messages, or send Chat messages.

Implemented surfaces:

- Node: `collectChatLinkCandidates(input)`, `createChatLinkRetrievalPlan(input)`,
  and `buildChatLinkCacheKey(input)`
- Python: `collect_chat_link_candidates(input_data)`,
  `create_chat_link_retrieval_plan(input_data)`, and
  `build_chat_link_cache_key(input_data)`
- Shared conformance operation: `chatLinks.plan`
- Current shared parity coverage: 30 `chatLinks.plan` fixtures run against both
  Node and Python.

## What It Plans

The planner accepts a normalized message, raw Chat-like message, context tree,
or direct list of link objects. It returns:

- Chat-link candidates from `chatSpaceLinkData`, rich-link URLs, `matchedUrl`,
  and plain text URLs;
- parse confidence and URL-shape IDs;
- canonical `spaces/{space}`, `spaces/{space}/threads/{thread}`, and
  `spaces/{space}/messages/{message}` resource names when known;
- source-message breadcrumbs including message ID, sender identity when
  available, create/update/delete timestamps, relationship, and traversal path;
- dry-run `spaces.get`, `spaces.messages.get`, and `spaces.messages.list`
  requests;
- cache status and cache-key metadata based on resource name plus
  `lastUpdateTime`;
- deduplicated repeated resource reads with `occurrences` breadcrumbs for every
  observed mention;
- traversal and scan budget status in `counts` and `truncation`;
- safety notes, required scopes, warnings, and model-facing system notes.

`chatSpaceLinkData` is preferred over URL parsing. When Google provides
structured rich-link metadata, the SDK uses those canonical resource names
instead of guessing from browser route segments.

## Node Example

```ts
import {
  collectChatLinkCandidates,
  createChatLinkRetrievalPlan
} from "googlechatai";

const candidates = collectChatLinkCandidates(normalizedMessage);
const plan = createChatLinkRetrievalPlan({
  message: normalizedMessage,
  options: {
    enabled: true,
    authMode: "user",
    allowSpaceLevelContext: true,
    maxThreadMessages: 50,
    maxSpaceMessages: 20,
  }
});

console.log(candidates.length);
console.log(plan.requests);
console.log(plan.systemNotes.join("\n"));
```

## Python Example

```python
from googlechatai import (
    collect_chat_link_candidates,
    create_chat_link_retrieval_plan,
)

candidates = collect_chat_link_candidates(normalized_message)
plan = create_chat_link_retrieval_plan({
    "message": normalized_message,
    "options": {
        "authMode": "user",
        "enabled": True,
        "allowSpaceLevelContext": True,
        "maxThreadMessages": 50,
        "maxSpaceMessages": 20,
    },
})

print(len(candidates))
print(plan["requests"])
print("\n".join(plan["systemNotes"]))
```

Python also accepts native snake_case keyword options, for example
`auth_mode`, `allow_space_level_context`, `max_thread_messages`, and
`cache={"entries_by_resource_name": ...}`.

## URL Shapes

Only HTTPS Google Chat and Gmail Chat URLs are converted into canonical
resources. HTTP links on Chat hosts are retained as unknown candidates with no
planned reads.

High-confidence sources:

- `richLinkMetadata.chatSpaceLinkData.space`
- `richLinkMetadata.chatSpaceLinkData.thread`
- `richLinkMetadata.chatSpaceLinkData.message`
- `https://mail.google.com/mail/u/{n}/#chat/space/{spaceId}`

Medium-confidence observed product routes:

- `https://mail.google.com/chat/u/{n}/#chat/space/{spaceId}`
- `https://chat.google.com/room/{spaceId}`
- `https://chat.google.com/u/{accountIndex}/app/chat/{spaceId}`

Low-confidence empirical route:

- `https://chat.google.com/room/{spaceId}/{threadId}`

Unknown Chat URLs are retained as candidates with `parseStatus: "unknown"` so
operators can capture new URL shapes without making unsafe API calls.
Known Gmail Chat paths with unknown hashes, such as DM hashes, are retained this
way instead of being silently dropped.
Encoded separators or extra hash path parts, such as `%2F` in a space segment or
`#chat/space/{spaceId}/{extra}`, are treated as unknown rather than converted
into canonical Chat resources.

## Cache Metadata

Use `buildChatLinkCacheKey` / `build_chat_link_cache_key` with the canonical
resource name and the retrieved message or context `lastUpdateTime`:

```ts
buildChatLinkCacheKey({
  resourceName: "spaces/AAA/messages/msg-1",
  lastUpdateTime: "2026-07-05T15:10:00Z"
});
```

The key changes when `lastUpdateTime` changes, so edited Chat messages invalidate
cached linked context. When a caller supplies a cache hit in
`options.cache.entriesByResourceName`, the dry-run plan still includes the
metadata read needed to revalidate freshness. Cache-hit message and message-list
requests include partial-response `fields` selectors for `name`,
`lastUpdateTime`, and `thread.name` instead of planning a full cold-read shape.

## Feature Flag And Caps

Set `options.enabled` to `false` to turn the feature off for an automatic
enrichment path:

```ts
createChatLinkRetrievalPlan({
  links,
  options: { enabled: false }
});
```

When disabled, the planner returns no candidates, no requests, and a blocked
dry-run status. When enabled, the traversal remains bounded by
`maxChatLinks`, `maxPlainTextUrls`, `maxTraversalDepth`, `maxTraversalNodes`,
`maxLinkScanItems`, `maxPlainTextScanChars`, `maxUrlLength`, and
`maxOccurrencesPerCandidate`. If any budget is hit, `status` becomes
`partial`, `truncation.status` becomes `truncated`, and a system note warns that
some linked Chat context may be omitted. When the traversal node budget is
exhausted, wide sibling lists stop before reading the next sibling and record
the remaining skipped siblings in bulk.

## Auth Modes

`authMode: "user"` is the default and derives only the scopes required by the
planned requests. `authMode: "app"` is explicit and derives
`https://www.googleapis.com/auth/chat.app.messages.readonly` for message reads
and `https://www.googleapis.com/auth/chat.bot` for `spaces.get` breadcrumbs.
App-auth message reads are marked with `requiresAdminApproval: true`. Invalid
auth modes block the plan and produce no requests.

## Boundaries

- Planning performs no live network calls and does not read credentials.
- User auth is the default for linked human Chat context.
- App auth is supported only as an explicit planner mode.
- Direct top-level link arrays are accepted, but only Google Chat/Gmail Chat
  URLs produce candidates.
- `allowSpaceLevelContext` controls whether top-level space links plan a
  bounded recent-message read; `spaces.get` breadcrumbs are still planned.
- The current slice does not execute retrieval or render full linked context.
- Do not use domain-wide delegation by default.
- Do not save raw private message text in public fixtures, docs, or logs.

## Validation

Current local validation:

```bash
corepack pnpm --filter googlechatai test -- test/chat-links.test.ts
PYTHONPATH=packages/python/src python3 -m unittest packages.python.tests.test_chat_links
corepack pnpm conformance
corepack pnpm build
corepack pnpm release:check
corepack pnpm discovery:check
git diff --check
```
