---
title: Chat Link Retrieval Implementation Plan
date: 2026-07-05
type: plan
status: implemented-slice-audit-remediated
---

# Chat Link Retrieval Implementation Plan

## Goal

Give agents safe, feature-flagged context for Google Chat URLs that point to a
space, DM, group conversation, thread, or message. The SDK should identify the
linked Chat resource, plan or perform bounded reads when explicitly enabled, and
return breadcrumbs about where the link points, who posted the message, when it
was posted, which IDs were used, and how the context was obtained.

## Design Principles

- Prefer canonical API resources over browser URLs.
- Prefer `chatSpaceLinkData` over URL parsing whenever Google provides it.
- Keep URL parsing extensible through a registry of named parsers and confidence
  levels.
- Make dry-run planning useful even when live retrieval is disabled.
- Keep user auth as the default for human spaces, DMs, and group conversations.
- Preserve Node/Python semantic parity with shared fixtures.
- Treat private or inaccessible content as an expected state, not an exception
  that disappears from agent context.

## Public API

Node:

- `collectChatLinkCandidates(input, options?)`
- `createChatLinkRetrievalPlan(input, options?)`
- Future guarded executor: `resolveChatLinkContext(input, executor, options?)`

Python:

- `collect_chat_link_candidates(input_data, **options)`
- `create_chat_link_retrieval_plan(input_data, **options)`
- Future guarded executor: `resolve_chat_link_context(input_data, executor, **options)`

Shared conformance operation:

- `chatLinks.plan`

## Data Model

`ChatLinkCandidate`:

- `kind`
- `candidateId`
- `source`
- `originalUrl`
- `parseStatus`
- `confidence`
- `scope`
- `space`
- `thread`
- `message`
- `resourceName`
- `urlShape`
- `context`
- `occurrences` when repeated resource mentions are deduplicated
- `warnings`

`ChatLinkRetrievalPlan`:

- `kind: "chat.chat_link_retrieval_plan"`
- `dryRun`
- `summary`
- `candidates`
- `requests`
- `capability`
- `safety`
- `systemNotes`
- `counts`
- `truncation`
- `warnings`

`ChatLinkContext`:

- `kind: "chat.link_context"`
- `source`
- `resources`
- `spaceBreadcrumb`
- `threadBreadcrumb`
- `messageBreadcrumb`
- `retrievedMessages`
- `access`
- `partial`
- `truncated`
- `systemNotes`

## Implementation Slices

### Slice 1: Preserve Structured Chat Link Metadata

Status: implemented for Node and Python.

- Extend Node/Python message AST rich-link normalization to preserve
  `chatSpaceLinkData`.
- Extend Drive-link code carefully if shared link metadata helpers are reused,
  without changing Drive-link behavior.
- Add fixtures for raw `RICH_LINK` annotations with `chatSpaceLinkData.space`,
  `.thread`, and `.message`.

### Slice 2: Candidate Extraction

Status: implemented for Node and Python.

- Add `packages/node/src/chat-links/index.ts`.
- Add `packages/python/src/googlechatai/chat_links/__init__.py`.
- Support normalized message input, raw Chat message input, context trees, and
  direct link arrays.
- Reuse the traversal/cap pattern from Drive-link retrieval:
  `maxChatLinks`, `maxPlainTextUrls`, `maxTraversalDepth`,
  `maxTraversalNodes`, `maxLinkScanItems`, `maxPlainTextScanChars`,
  `maxUrlLength`, and `maxOccurrencesPerCandidate`.
- Include source toggles for rich links, matched URLs, and plain URLs.
- Include a top-level `enabled: false` feature flag that returns no candidates
  and plans no reads.
- Deduplicate repeated resources by canonical resource plus URL shape while
  preserving all observed occurrence breadcrumbs.
- Preserve source message breadcrumbs with sender identity and create/update
  timestamps when those fields are available.

### Slice 3: URL Parser Registry

Status: implemented for the first supported parser set.

Start with these parser IDs:

- `gmail_hash_space`: `mail.google.com/mail/u/{n}/#chat/space/{spaceId}`
- `gmail_chat_hash_space`: `mail.google.com/chat/u/{n}/#chat/space/{spaceId}`
- `chat_room_space`: `chat.google.com/room/{spaceId}`
- `chat_room_thread`: `chat.google.com/room/{spaceId}/{threadId}`
- `chat_app_space`: `chat.google.com/u/{accountIndex}/app/chat/{spaceId}`
- `unknown_chat_url`: any Chat/Gmail URL that looks related but cannot safely
  produce canonical resources.

Parser output must include `confidence`, `scope`, `urlShape`, and warnings.
Query strings and fragments should never become resource IDs.
Gmail Chat URLs under known Chat paths with unrecognized hashes are retained as
`unknown_chat_url` candidates rather than silently dropped.
Encoded path separators and extra hash path parts are treated as unknown so
malformed browser routes never become canonical Chat resource IDs.

### Slice 4: Dry-Run Retrieval Planner

Status: implemented for `spaces.get`, `spaces.messages.get`, and
`spaces.messages.list` request plans, with cache metadata hints.

Plan API calls without credentials or network access:

- Space:
  - `spaces.get`
  - optional bounded `spaces.messages.list`
- Thread:
  - `spaces.get`
  - `spaces.messages.list` with `thread.name`
- Message:
  - `spaces.messages.get`
  - optional `spaces.get`
  - optional thread context follow-up only after an executor has a message
    response with `thread.name`

Default auth mode is `user`. Required scopes are derived from the planned
requests:

- user message reads: `https://www.googleapis.com/auth/chat.messages.readonly`
- user space breadcrumbs: `https://www.googleapis.com/auth/chat.spaces.readonly`
- app message reads: `https://www.googleapis.com/auth/chat.app.messages.readonly`
- app space breadcrumbs: `https://www.googleapis.com/auth/chat.bot`

Invalid `authMode` values block the plan and produce no requests. App-auth
message reads are marked as requiring admin approval.

Plans expose traversal caps in `counts` and `truncation`, and partial status is
used when traversal, candidate, plain-text URL, plain-text scan, oversized URL,
occurrence, or scan-item budgets are hit.
Cache-hit message and message-list revalidation requests use partial-response
`fields` selectors so fresh cached context does not plan the same full
payload shape as a cold read. Duplicate identical request plans are collapsed
with all contributing `candidateIds` retained.

### Slice 5: Context Rendering Integration

Status: planned follow-up.

- Add a model-ready linked Chat context renderer.
- Match the style of quoted-message and thread context system notes.
- Include breadcrumbs even when retrieval is blocked or partial.
- Explicitly label parse confidence and auth/access status.

### Slice 6: Guarded Live Executor

Status: planned follow-up.

Only after dry-run conformance passes:

- Add a local-only live smoke harness.
- Read the live-smoke runbook first.
- Target only the dedicated smoke space for writes/corpus generation.
- Use installed-user auth and read-only scopes for retrieval.
- Add an optional controlled DM/group read smoke only if the operator opts in.
- Save redacted evidence under ignored local evidence paths.

## Test Plan

Local deterministic tests:

- Node unit tests for structured metadata extraction.
- Python unit tests mirroring Node behavior.
- URL parser tests for every known shape, query string, fragment, malformed URL,
  encoded segment, account index, repeated path segment, and unknown Chat URL.
- Planner tests for space, thread, message, partial, unknown, non-HTTPS, and
  cap behavior.
- Planner tests for direct top-level link arrays, feature-flag disable,
  cross-space structured metadata rejection, resource-level dedupe, invalid
  auth modes, app-auth scopes, and fractional limit rejection.
- Python-native snake_case option and cache aliases are covered to preserve
  Python package ergonomics.
- Lazy cache lookup, duplicate request collapse, source toggles, and
  occurrence-cap behavior are covered in local unit tests and shared
  conformance fixtures.
- Renderer tests for successful, partial, inaccessible, deleted, and truncated
  contexts. Planned for the context-rendering slice.
- No-access rendering remains a planned context-rendering/executor follow-up;
  the current planner slice represents unknown or invalid links without
  performing live access checks.
- 30 shared `chatLinks.plan` conformance fixtures for Node/Python parity,
  covering URL parsing, structured metadata, cache behavior, traversal caps,
  scan bounds, source toggles, invalid retention, and dedupe semantics.

Focused commands:

```bash
corepack pnpm --filter googlechatai test -- test/chat-links.test.ts
PYTHONPATH=packages/python/src python3 -m unittest packages.python.tests.test_chat_links
corepack pnpm conformance
corepack pnpm build
corepack pnpm discovery:check
```

Release-adjacent completion:

```bash
corepack pnpm release:check
```

Audit:

- Run `$critical-change-audit` after the implementation, deterministic tests,
  docs, and any guarded live smoke evidence are complete.
- Complete all audit remediations before calling the feature done.

## Non-Goals

- Do not scrape Google Chat UI.
- Do not infer private DM participants from URL text.
- Do not use domain-wide delegation by default.
- Do not perform Chat writes as part of link retrieval.
- Do not save raw private message text in public fixtures, docs, or logs.
- Do not claim support for repeated-space-id URL shapes until a live corpus
  proves what the segments mean.

## Completion Criteria

- Node/Python APIs are exported from package roots.
- `chatSpaceLinkData` is preserved in normalized rich links.
- Shared fixtures cover structured metadata and URL fallback parsing.
- Dry-run plans expose exact API requests, scopes, safety notes, caps, and
  breadcrumbs.
- Parser matrix, direct arrays, truncation, app/user auth, feature flag, and
  resource-dedupe behavior are covered in Node/Python tests and conformance.
- Model-ready context rendering includes sender, timestamp, resource IDs,
  source URL, parse confidence, and access status. Planned follow-up.
- Public docs explain feature flags, privacy boundaries, and known URL-shape
  confidence.
- Focused tests, 30-case Chat-link conformance, build, discovery check, and
  release check pass.
- Critical-change audit is run and all accepted remediations are complete.
