---
title: Attachment Pipeline Implementation Plan
date: 2026-07-04
type: plan
status: implemented-slice
---

# Attachment Pipeline Implementation Plan

## Status

Implemented before this slice:

- Node/Python attachment normalization, safe filenames, media-kind
  classification, policy checks, upload/download/Drive-export dry-run planners,
  parser hooks, optional transcription providers, redacted transcription
  evidence, local artifact caches, and AI-facing attachment notes.
- Live audit evidence for metadata extraction, Chat-hosted downloads, Drive
  exports, parser-disabled behavior, and redacted cache helpers.

Implemented slice:

- A single high-level Node/Python attachment pipeline planner that composes the
  lower-level primitives.
- Shared conformance fixtures for Chat-hosted, Drive-hosted, blocked,
  parser-missing, cache-hit, transcription-disabled, and upload-fallback
  behavior.
- Public exports and docs for the planner.

Planned follow-ups:

- Optional CLI `chat:attachments-plan` for developer-facing terminal output.
- Guarded live execution harness that performs one upload/download/export in
  the dedicated smoke space only.
- Real parser package adapters and package-backed smokes.
- Cache store integration that can read from `ArtifactCache` instances rather
  than caller-supplied summaries.

## Problem

Google Chat media handling is not one operation. Developers must normalize the
attachment shape, decide whether the bytes live in Chat or Drive, check
file-size and file-type policy, pick app or user auth, choose a download or
Drive export method, decide whether parser/transcription support exists, avoid
accessory-widget conflicts, cache repeated work, and render useful context to
the AI even when bytes are blocked. The repo already has most of these pieces,
but developers still need to stitch them together manually.

The product surface should answer: "given this message, context tree, or files I
want to send, what exactly should my bot do, what can it do live, what auth is
required, what fallback should it use, and what should the AI be told?"

## Verified Source Rules

Official Google docs checked on 2026-07-04:

- Uploading a media attachment is a two-step flow: call `media.upload` with the
  target `spaces/*` parent, then create a message with the returned attachment
  in the message `attachment` list:
  <https://developers.google.com/workspace/chat/upload-media-attachments>
- Uploads require a user-auth Chat messages scope such as
  `https://www.googleapis.com/auth/chat.messages.create`, are limited to 200 MB,
  can be blocked by file type, and messages with attachments must omit
  accessory widgets:
  <https://developers.google.com/workspace/chat/upload-media-attachments>
- Chat `media.download` downloads uploaded media, not Google Drive files. It
  uses `GET https://chat.googleapis.com/v1/media/{resourceName}` and supports
  Chat app or user scopes such as `chat.bot`, `chat.messages`, and
  `chat.messages.readonly`:
  <https://developers.google.com/workspace/chat/api/reference/rest/v1/media/download>
- Drive-backed attachments require Drive APIs, such as `files.export` for
  Google Workspace files or `files.get`/media download for binary Drive files:
  <https://developers.google.com/workspace/chat/api/reference/rest/v1/media/download>

## Current Repo Baseline

Implemented:

- [packages/node/src/attachments/index.ts](../../packages/node/src/attachments/index.ts)
  and
  [packages/python/src/googlechatai/attachments/__init__.py](../../packages/python/src/googlechatai/attachments/__init__.py)
  normalize attachments, evaluate policy, plan dry-run upload/download/export
  operations, parse content with registered parsers, transcribe audio with
  explicit providers, and render AI context parts.
- [packages/node/src/cache/index.ts](../../packages/node/src/cache/index.ts)
  and
  [packages/python/src/googlechatai/cache/__init__.py](../../packages/python/src/googlechatai/cache/__init__.py)
  provide content-addressed artifact cache keys, in-memory/file cache storage,
  and negative cache entries.
- [fixtures/attachments/context-tree.json](../../fixtures/attachments/context-tree.json)
  covers nested message, quote, and thread-history attachments.
- The private live feature completion audit (kept outside the public
  repository) records live metadata, download, Drive export, voice-note, and
  cache claim boundaries.

Missing:

- No public `AttachmentPipeline` or equivalent planner that composes
  normalization, policy, auth, download/export/upload, parser/transcription,
  cache, fallback, and AI-context notes.
- No shared conformance operation for attachment pipeline behavior.
- No single result object that can be shown to an AI agent, CLI, or developer UI.

## Public API

Node:

```ts
const plan = planAttachmentPipeline({
  message,
  context,
  uploads: [
    {
      parent: "spaces/AAA",
      filename: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 12000
    }
  ],
  options: {
    targetDirectory: "/tmp/chat-ai-sdk",
    driveExportDirectory: "/tmp/chat-ai-sdk/drive",
    cache: { entries: { "attachment:...": { hit: true } } },
    parsers: { pdf: "pdf-parse" },
    transcription: { enabled: false }
  }
})
```

Python:

```python
plan = plan_attachment_pipeline({
    "message": message,
    "context": context,
    "uploads": [
        {
            "parent": "spaces/AAA",
            "filename": "report.pdf",
            "contentType": "application/pdf",
            "sizeBytes": 12000,
        }
    ],
    "options": {
        "targetDirectory": "/tmp/chat-ai-sdk",
        "driveExportDirectory": "/tmp/chat-ai-sdk/drive",
        "cache": {"entries": {"attachment:...": {"hit": True}}},
        "parsers": {"pdf": "pdf-parse"},
        "transcription": {"enabled": False},
    },
})
```

First-slice result shape:

```json
{
  "kind": "chat.attachment_pipeline_plan",
  "status": "partial",
  "summary": "4 attachments, 1 upload, 2 ready, 3 blocked or fallback",
  "counts": {
    "attachments": 4,
    "uploads": 1,
    "downloads": 2,
    "driveExports": 1,
    "blocked": 2,
    "cacheHits": 1,
    "parserReady": 1,
    "transcriptionReady": 0,
    "fallbacks": 2
  },
  "attachments": [
    {
      "attachment": {},
      "cache": {},
      "downloadPlan": {},
      "driveExportPlan": null,
      "parsePlan": {},
      "transcriptionPlan": {},
      "fallback": {},
      "contextParts": []
    }
  ],
  "uploads": [
    {
      "uploadPlan": {},
      "sendStrategy": {},
      "fallback": {}
    }
  ],
  "systemNotes": []
}
```

## Data Model

Attachment item:

- `attachment`: normalized attachment.
- `cache`: deterministic cache status:
  - `disabled`: no cache keys/options supplied.
  - `hit`: caller supplied a cache hit for the stable key.
  - `miss`: caller supplied entries but no match exists.
  - `negative_hit`: caller supplied a negative cache entry, so live bytes should
    not be retried until expiry.
- `downloadPlan`: Chat media download plan for uploaded content, or blocked
  with `drive_api_required` for Drive content.
- `driveExportPlan`: Drive export/blob-download plan when `driveDataRef` exists
  or source is `DRIVE_FILE`.
- `parsePlan`: parser availability and parser name without reading bytes.
- `transcriptionPlan`: disabled by default; ready only for audio with explicit
  provider metadata and byte limits.
- `fallback`: what the application should do when bytes are blocked,
  inaccessible, too large, Drive-only, parser-missing, or transcription-disabled.
- `contextParts`: AI-facing system note and content-status note rendered before
  any extracted or transcribed content.

Upload item:

- `uploadPlan`: existing media upload dry-run plan.
- `sendStrategy`: `attachment_message`, `separate_attachment_message`, or
  `drive_link_card_fallback`.
- `fallback`: explains accessory-widget conflicts, user-auth requirements, and
  blocked file policy.

## Auth And Principal Model

- Upload media: user auth, `chat.messages.create` or compatible Chat messages
  scope. App auth is not the default happy path.
- Download uploaded Chat media: app or user auth with one of `chat.bot`,
  `chat.messages`, or `chat.messages.readonly`.
- Read/export Drive-backed content: user auth with Drive readonly. Denied Drive
  access must become `fallback.status="metadata_only"` rather than an exception.
- Parser/transcription providers are optional and disabled by default. Provider
  auth is explicit and belongs beside the pipeline, not inside ambient Chat auth.
- Cache reads must be optional. Cache failures must degrade to `miss` or
  `unavailable` without blocking metadata/context rendering.

## Fallback Rules

First slice fallbacks:

- `download_chat_media`: uploaded Chat media with a media resource name and
  policy allowed.
- `drive_export_required`: Drive-backed attachment where Chat media download is
  not available.
- `metadata_only`: bytes are inaccessible, unsupported, blocked by policy, or
  missing a resource id.
- `parser_missing`: bytes may be downloadable, but no parser is registered for
  the media kind.
- `transcription_disabled`: audio is present but transcription is disabled or no
  provider was explicitly selected.
- `separate_attachment_message`: requested upload is compatible with media
  upload, but the caller also wants accessory widgets.
- `drive_link_card_fallback`: requested upload is blocked or unsupported, so the
  caller should share a Drive link/card or text summary.

## Implementation Slices

Slice 1, implemented in this feature:

- Add shared Node/Python planner:
  - `planAttachmentPipeline(input)`
  - `plan_attachment_pipeline(input_data)`
- Add conformance operation `attachments.planPipeline`.
- Add shared fixture coverage for context-tree inputs, cache entries, parser
  registry metadata, transcription options, blocked content, Drive content, and
  upload/accessory conflicts.
- Export the planner from root package entrypoints.
- Add docs guide and README/docs index links.
- Update the live completion audit to label F4 as verified local/conformance.

Follow-ups are tracked in the status section above.

## Test Plan

Test-first local coverage:

- Node unit test: context-tree pipeline returns download, Drive export,
  parser/transcription, cache, fallback, and AI-context notes.
- Python unit test: same fixture produces identical result.
- Node/Python conformance: shared expected fixture for
  `attachments.planPipeline`.
- Upload fallback test: accessory-widget conflict produces
  `separate_attachment_message`; blocked upload produces
  `drive_link_card_fallback`.
- Cache test: supplied cache hit/negative hit changes status without requiring
  raw bytes.

Validation before commit:

```bash
corepack pnpm --filter googlechatai test -- attachments
PYTHONPATH=packages/python/src python3 -m unittest packages.python.tests.test_attachments
corepack pnpm conformance
corepack pnpm validate
corepack pnpm discovery:check
corepack pnpm release:check
git diff --check
```

## Live-Test Boundary

This first slice is planning-only and must not download, upload, export,
transcribe, or send Chat messages. It can record live status as "already
verified by lower-level live harnesses" because the lower-level media/download
surfaces already have live evidence in the audit report. A future guarded live
slice can execute the plan in the smoke space only.

## Risks

- Overpromising live execution: keep first slice named and documented as a
  planner, not an executor.
- Cache key instability: for first slice, cache status should accept
  caller-provided resource keys and use stable deterministic local keys only
  when bytes/hash metadata are supplied.
- Parser package churn: planner should report parser availability by name, not
  import optional parser packages.
- Drive auth confusion: explicitly call out user-auth Drive readonly and
  metadata-only fallback.

## Completion Criteria

- Node and Python expose planner APIs with matching semantics.
- Shared conformance fixture passes in both runtimes.
- Existing low-level attachment helpers keep passing.
- Docs show how to read the planner output and where live execution remains
  gated.
- Audit report marks F4 as verified local/conformance, with live execution
  follow-up clearly labeled.
