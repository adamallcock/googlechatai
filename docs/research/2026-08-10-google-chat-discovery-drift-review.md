---
title: Google Chat Discovery Drift Review
date: 2026-08-10
type: research
status: implemented
---

# Google Chat Discovery Drift Review

## Decision

Accept discovery revision `20260804` only with the implementation and
classification work below. The drift is persistent and compatible with the
repository's product boundary: implement Chat-native message search semantics,
preserve the new message syntax signal, and record unrelated raw API changes
without broadening the SDK into a generic discovery mirror.

## Evidence

- Live source: [Google Chat v1 discovery document](https://chat.googleapis.com/$discovery/rest?version=v1), fetched 2026-08-10.
- Prior generated source: [official google-api-go-client revision from 2026-07-09](https://github.com/googleapis/google-api-go-client/blob/510a0c19483ea5631b7b0a453f9d6df1b9ef596a/chat/v1/chat-api.json).
- Current generated source: [official google-api-go-client revision from 2026-08-02](https://github.com/googleapis/google-api-go-client/blob/8140ddf12e1a5c4a54748a94b6655818fcc480ed/chat/v1/chat-api.json).
- Method contract: [Google Chat `spaces.messages.search`](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/search).

The official July 9 generated document reproduces all 50 baseline method names
and canonical signatures. Comparing it with the live August 10 document
isolates one added method and four coherent change groups; the 13 changed
hashes are not 13 independent breaks.

## Reviewed Changes

| Change group | Affected methods | Exact contract change | Repository decision |
| --- | --- | --- | --- |
| Message search | `spaces.messages.search` | Added user-auth `POST /v1/{parent}/messages:search` with `SearchMessagesRequest`/`SearchMessagesResponse` | Implement as experimental Developer Preview with safe semantic filters, bounded normalization, model-context provenance, default email redaction, and guarded dedicated-space smoke coverage. |
| Message markup syntax | `messages.create/get/list/patch/update`; transitively `spaceEvents.get/list` | `Message.markupSyntax` added; `messages.get/list` accept a `markupSyntax` query enum | Preserve `markupSyntax` in the normalized Message AST and allow context readers to request Chat or Markdown syntax. |
| Space search result envelope | `spaces.search` | `SearchSpacesResponse.results[]` of `SearchSpaceResult` added in place of the older top-level response shape | Classify only. The SDK has no `spaces.search` wrapper and should not add a raw mirror solely because discovery changed. |
| Organization-wide event scopes | `spaceEvents.get/list` | Added `chat.app.all.memberships.readonly`, `chat.app.all.messages.readonly`, and `chat.app.all.spaces.readonly`; nested Message responses also inherit `markupSyntax` | Accept as additive. Existing event normalization receives the Message AST update; organization-wide subscription policy remains separately gated. |
| Availability scopes | `users.availability.get/patch/markAs*` | Removed the unrelated `chat.users.readstate` scope; availability-specific scopes remain | Accept and document. No public availability planner currently reports the removed scope; read-state tooling targets separate read-state methods and remains valid. |

## Compatibility And Privacy Boundary

- Existing `query` and `space` search-planner inputs remain compatibility
  aliases. New code should use `filter` or the high-level `filters` object.
- Search always uses the documented `spaces/-` parent. Space restriction is
  expressed through `space.name` filters.
- BASIC results require `chat.messages.readonly`; FULL metadata additionally
  reports the read-state and space-settings scopes required for `read` and
  `spaceMuteSetting`. BASIC filters using `is_unread()` or
  `space.display_name` report their extra read-state or space-read scope.
- The normalizer exposes raw result objects only through explicit opt-in.
  Model-context construction never includes raw results, bounds result count,
  labels content untrusted, and redacts email addresses by default.
- Developer Preview remains an external stability and tenant-availability
  limitation. A green local suite or discovery check is not a production
  availability claim.

## Acceptance Gates

1. Node and Python focused tests plus shared conformance pass.
2. Guarded live-smoke request remains read-only, user-authorized, restricted by
   `space.name` to the dedicated smoke space, and privacy-redacted in evidence.
3. The curated snapshot contains 51 methods and complete canonical signatures.
4. `discovery:check`, full validation, documentation links, and release hygiene
   pass before release-adjacent staging.

The guarded message-search smoke passed on 2026-08-10: Google returned HTTP
200 on the first attempt for a BASIC search restricted to the dedicated smoke
space. The run used user OAuth with `chat.messages.readonly`, returned three
results plus a next-page token, performed no writes, and persisted only
redacted local evidence.
