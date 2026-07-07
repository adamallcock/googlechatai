---
title: Attachment Pipeline
date: 2026-07-04
type: guide
status: implemented
---

# Attachment Pipeline

The attachment pipeline planner gives developers one metadata-safe place to ask
"what should I do with these Google Chat files?" It does not download bytes,
upload files, export Drive content, call parser packages, call transcription
providers, or send Chat messages. It composes the lower-level helpers into a
single plan that can be shown to an AI agent, CLI, worker, or operator.

Implemented surfaces:

- Node: `planAttachmentPipeline(input)`
- Python: `plan_attachment_pipeline(input_data)`
- Shared conformance operation: `attachments.planPipeline`

## What It Plans

For inbound attachments, the planner returns:

- normalized attachment metadata, safe filename, source, size, and policy state;
- cache status from caller-supplied cache summaries;
- Chat `media.download` dry-run plan for uploaded Chat media;
- Drive export/blob-download dry-run plan for Drive-backed attachments;
- parser availability by media kind;
- transcription availability for audio, disabled by default;
- fallback action for blocked, Drive-only, parser-missing, or audio-disabled
  cases;
- AI-facing system notes and content-status parts.

For outbound files, the planner returns:

- Chat `media.upload` dry-run plan;
- user-auth scope requirements;
- `separate_attachment_message` when accessory widgets would conflict with an
  attachment message;
- `drive_link_card_fallback` when upload policy blocks the file.

## Node Example

```ts
import { planAttachmentPipeline } from "googlechatai";

const plan = planAttachmentPipeline({
  context,
  uploads: [
    {
      parent: "spaces/AAA",
      filename: "answer.txt",
      contentType: "text/plain",
      sizeBytes: 42,
      sendOptions: { hasAccessoryWidgets: true }
    }
  ],
  options: {
    targetDirectory: "/tmp/chat-ai-sdk",
    driveExportDirectory: "/tmp/chat-ai-sdk/drive",
    cache: {
      entriesByAttachmentName: {
        "spaces/AAA/messages/root/attachments/pdf-1": {
          hit: true,
          key: "attachment:pdf-hit",
          metadata: { contentSha256: "..." }
        }
      }
    },
    parsers: { pdf: "pdf-parse" },
    transcription: { enabled: false }
  }
});

console.log(plan.status);
console.log(plan.attachments[0]?.fallback.action);
console.log(plan.systemNotes.join("\n"));
```

## Python Example

```python
from googlechatai import plan_attachment_pipeline

plan = plan_attachment_pipeline({
    "context": context,
    "uploads": [
        {
            "parent": "spaces/AAA",
            "filename": "answer.txt",
            "contentType": "text/plain",
            "sizeBytes": 42,
            "sendOptions": {"hasAccessoryWidgets": True},
        }
    ],
    "options": {
        "targetDirectory": "/tmp/chat-ai-sdk",
        "driveExportDirectory": "/tmp/chat-ai-sdk/drive",
        "parsers": {"pdf": "pdf-parse"},
        "transcription": {"enabled": False},
    },
})

print(plan["status"])
print(plan["systemNotes"])
```

## Result Shape

```json
{
  "kind": "chat.attachment_pipeline_plan",
  "status": "partial",
  "summary": "4 attachments, 2 uploads, 3 ready operations, 5 fallback or blocked paths.",
  "counts": {
    "attachments": 4,
    "uploads": 2,
    "downloads": 2,
    "driveExports": 1,
    "blocked": 2,
    "cacheHits": 1,
    "parserReady": 1,
    "transcriptionReady": 0,
    "fallbacks": 5
  },
  "attachments": [],
  "uploads": [],
  "systemNotes": []
}
```

`status` means:

- `ready`: all planned paths have a direct ready strategy.
- `partial`: at least one item needs a fallback or metadata-only handling.
- `blocked`: every item is blocked.

## Fallback Actions

- `download_chat_media`: Chat-hosted uploaded media can use `media.download`.
- `drive_export_required`: Drive-backed content needs user-auth Drive access and
  a Drive export/blob-download plan.
- `metadata_only`: bytes are blocked or inaccessible; render metadata to the AI.
- `parser_missing`: bytes may be available, but no parser is registered.
- `transcription_disabled`: audio is present, but transcription is disabled or
  unavailable.
- `separate_attachment_message`: attachment upload can proceed, but accessory
  widgets must be sent separately.
- `drive_link_card_fallback`: direct upload is blocked, so use a Drive link/card
  or text summary.

## Auth Boundary

- Upload media: user auth with a Chat messages create-compatible scope.
- Download uploaded Chat media: app or user auth with Chat bot/messages scopes.
- Drive-backed content: user auth with Drive readonly.
- Transcription providers: explicit separate provider auth, never ambient Chat
  auth.

Denied auth, blocked policy, parser absence, and cache misses are represented in
the plan. They should not prevent AI-facing metadata and system notes from being
rendered.

## Validation

Current local validation:

```bash
corepack pnpm --filter googlechatai test -- attachments
PYTHONPATH=packages/python/src python3 -m unittest packages.python.tests.test_attachments
corepack pnpm conformance
```

The first implemented slice is local/conformance verified. Live execution
remains gated by the lower-level live smoke harnesses and should target only the
dedicated smoke space.
