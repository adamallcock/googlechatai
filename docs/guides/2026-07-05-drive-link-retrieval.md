---
title: Drive Link Retrieval
date: 2026-07-05
type: guide
status: implemented
---

# Drive Link Retrieval

Drive link retrieval planning promotes Google Docs, Sheets, Slides, and Drive
file URLs from message link metadata into a user-auth Drive export/download
plan. It is intentionally dry-run only: it does not read credentials, call the
network, export files, download bytes, parse file contents, or send Chat
messages.

Implemented surfaces:

- Node: `collectDriveLinkCandidates(input)` and
  `createDriveLinkRetrievalPlan(input)`
- Python: `collect_drive_link_candidates(input_data)` and
  `create_drive_link_retrieval_plan(input_data)`
- Shared conformance operation: `attachments.planDriveLinks`

## What It Plans

The planner accepts a normalized message, raw Chat-like message, conversation
context tree, or direct list of link objects. It returns:

- Drive-link candidates from Chat `richLink` annotations, `matchedUrl` links,
  and plain text URLs;
- ignored non-Drive URLs with context;
- inferred file IDs and file kinds for Docs, Sheets, Slides, Drive blob files,
  and Drive folders;
- Drive `files.export` plans for Workspace files;
- Drive `files.get?alt=media` plans for blob files;
- folder and missing-file-id fallbacks;
- cache-hit or negative-cache summaries supplied by the caller;
- optional traversal/cap summaries when the input graph or URL list is clipped;
- AI-facing system notes.

Drive links inside quoted-message and thread-history context are preserved with
their relationship path, including links discovered from a normalized
message's `contextNode` children.

## Node Example

```ts
import {
  collectDriveLinkCandidates,
  createDriveLinkRetrievalPlan
} from "googlechatai";

const candidates = collectDriveLinkCandidates(normalizedMessage);
const plan = createDriveLinkRetrievalPlan({
  message: normalizedMessage,
  options: {
    targetDirectory: "/tmp/chat-ai-sdk/drive-links",
    maxDriveLinks: 200,
    maxPlainTextUrls: 200,
    maxTraversalDepth: 256,
    maxTraversalNodes: 5000,
    maxLinkScanItems: 5000,
    cache: {
      entriesByFileId: {
        doc123: { hit: true, key: "drive-link:doc123" }
      }
    }
  }
});

console.log(candidates.length);
console.log(plan.systemNotes.join("\n"));
```

## Python Example

```python
from googlechatai import (
    collect_drive_link_candidates,
    create_drive_link_retrieval_plan,
)

candidates = collect_drive_link_candidates(normalized_message)
plan = create_drive_link_retrieval_plan({
    "message": normalized_message,
    "options": {
        "target_directory": "/tmp/chat-ai-sdk/drive-links",
        "max_drive_links": 200,
        "max_plain_text_urls": 200,
        "max_traversal_depth": 256,
        "max_traversal_nodes": 5000,
        "max_link_scan_items": 5000,
        "cache": {
            "entries_by_file_id": {
                "doc123": {"hit": True, "key": "drive-link:doc123"},
            },
        },
    },
})

print(len(candidates))
print("\n".join(plan["systemNotes"]))
```

## Boundaries

This guide covers linked Drive content, not Chat attachments:

- Chat attachments use `planAttachmentPipeline`.
- Pasted Drive URLs and Chat rich links use
  `createDriveLinkRetrievalPlan`.
- Both paths use Drive user auth with
  `https://www.googleapis.com/auth/drive.readonly` for Drive content.

Rich-link metadata is not content retrieval. Google Chat may provide title,
MIME type, and URL annotations, but the SDK still treats file content access as
a separate user-auth Drive operation.

Extraction defaults to including normalized `matchedUrl` links, explicit
`plain_url` link entries, and Drive URLs scanned from message text. Set
`includeMatchedUrls: false` or `includePlainTextUrls: false`
(`include_matched_urls` and `include_plain_text_urls` as Python kwargs) when a
caller needs to suppress one source without disabling the other.

Default traversal and collection caps keep hostile or accidentally enormous
context graphs bounded:

- `maxDriveLinks` / `max_drive_links`: maximum Drive-link entries promoted into
  candidates, default `200`.
- `maxPlainTextUrls` / `max_plain_text_urls`: maximum URLs scanned from message
  text, default `200`.
- `maxTraversalDepth` / `max_traversal_depth`: maximum recursive context depth,
  default `256`.
- `maxTraversalNodes` / `max_traversal_nodes`: maximum message/context nodes
  visited, default `5000`.
- `maxLinkScanItems` / `max_link_scan_items`: maximum explicit link or raw
  annotation items scanned, default `5000`.

When one of those limits is reached, the plan includes a `traversal` object with
`status: "truncated"`, the effective caps, and counts for skipped deep/cyclic
branches, capped traversal nodes, capped link scan items, capped link
candidates, and capped plain-text URLs. The planner also adds a final system
note explaining that traversal was capped, so model-facing context does not
silently omit linked material.

Published Docs URLs in the `/d/e/.../pub` shape are treated as metadata-only:
they do not expose a Drive file ID that can be exported with Drive
`files.export`.

## Fallbacks

- `drive_export`: file content can be read with a Drive export/blob-download
  plan when the caller later executes a guarded Drive request.
- `metadata_only`: the link is a folder, lacks a file ID, or is otherwise not
  exportable by this planner.
- `cached_unavailable`: the caller supplied a negative cache result from an
  earlier failed or denied retrieval.

## Validation

Current local validation:

```bash
corepack pnpm --filter googlechatai test -- test/attachments.test.ts
PYTHONPATH=packages/python/src python3 -m unittest packages.python.tests.test_attachments
corepack pnpm conformance
```
