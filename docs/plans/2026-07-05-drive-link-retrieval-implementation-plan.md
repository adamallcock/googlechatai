---
title: Drive Link Retrieval Implementation Plan
date: 2026-07-05
type: plan
status: implemented-slice
---

# Drive Link Retrieval Implementation Plan

## Status

Implemented before this slice:

- Message AST normalization extracts `matchedUrl` and Google Chat
  `RICH_LINK` annotations, including Drive-file rich links.
- Attachment helpers plan Drive-backed attachment exports and blob downloads
  through Google Drive user auth.
- Live private evidence proves synthetic Drive blob, Docs, Sheets, and Slides
  export/download paths behind explicit guards.

Implemented in this slice:

- Node/Python Drive-link candidate extraction from normalized messages,
  message context, and raw link arrays.
- Node/Python retrieval planning for Drive, Docs, Sheets, Slides, and regular
  Drive blob URLs.
- Shared conformance coverage for rich-link promotion, plain URL parsing,
  non-Drive ignore behavior, missing file IDs, link-cache summaries, URL edge
  cases, source toggles, snake_case option aliases, and traversal/link caps.
- Traversal/cap reporting for deep or cyclic context trees, capped Drive-link
  entries, capped plain-text URL scans, wide context traversal, and wide
  explicit link/annotation scans.
- Public guide and docs index routing.

Planned follow-ups:

- Guarded live execution harness that fetches approved linked Drive content
  only in the dedicated smoke space.
- Optional developer CLI for rendering a human-readable link retrieval plan.
- Cache store integration using `ArtifactCache` instead of caller-supplied
  link-cache summaries.

## Problem

Google Chat frequently turns pasted Google Docs, Sheets, Slides, and Drive URLs
into rich-link annotations. The SDK already renders those annotations as AI
system notes, but it does not give developers a reusable path for deciding
whether linked content can be retrieved, which API should read it, which auth is
required, and what the fallback should be when the link is not retrievable.

The existing attachment pipeline handles actual Chat attachments. Mentioned
Drive links need an adjacent planner because they are not attachments, often
lack Chat `driveDataRef`, and may come from plain pasted URLs rather than
Chat-provided rich-link metadata.

## User Stories

- As an AI chatbot developer, I can pass a normalized message or conversation
  context into the SDK and get a Drive-link retrieval plan before deciding
  whether to fetch file content.
- As an agent runtime, I can distinguish Docs, Sheets, Slides, Drive blob
  files, non-Drive URLs, unsupported Drive URL shapes, and permission-blocked
  links without performing live I/O.
- As a privacy-conscious operator, I can keep linked-file bytes behind explicit
  Drive user-auth execution gates while still rendering useful AI system notes.

## Public API

Node:

- `collectDriveLinkCandidates(input, options?)`
- `createDriveLinkRetrievalPlan(input, options?)`

Python:

- `collect_drive_link_candidates(input_data, **options)`
- `create_drive_link_retrieval_plan(input_data, **options)`

The planner accepts:

- a normalized message or raw Chat message;
- a conversation/context tree containing message nodes;
- a direct array of link-like objects;
- options for target directory, export MIME type, live-drive gate, cache
  summaries, `matchedUrl` entries, and plain URL entries or scanned text URLs.
- bounded traversal and collection limits through `maxDriveLinks`,
  `maxPlainTextUrls`, and `maxTraversalDepth` in Node, or
  `max_drive_links`, `max_plain_text_urls`, and `max_traversal_depth` in Python.
  Wide shallow inputs are additionally bounded by `maxTraversalNodes` /
  `max_traversal_nodes` and `maxLinkScanItems` / `max_link_scan_items`.

## Data Model

Each candidate includes:

- `kind: "drive_link"`
- stable `candidateId`
- `source` (`rich_link`, `matched_url`, or `plain_url`)
- URL, title, MIME type, rich-link type, file ID, and inferred Drive file kind
- context path and message name when available
- policy/status metadata describing whether the file ID is retrievable

Each retrieval plan includes:

- `kind: "chat.drive_link_retrieval_plan"`
- counts and summary
- per-link `driveExportPlan` shaped like attachment Drive export plans
- cache status
- fallback action and remediation
- optional traversal cap summary when linked material is clipped
- AI-facing system notes

## Auth And Execution Boundary

- Planning performs no live network calls and does not read credentials.
- Linked content retrieval requires user auth with
  `https://www.googleapis.com/auth/drive.readonly`.
- App auth is not a supported default for linked Google Drive file content.
- Live execution remains a future guarded smoke path. It must target only the
  dedicated smoke space and approved synthetic/safe files.

## Non-Goals

- Do not fetch linked bytes in this slice.
- Do not request broader Google Workspace scopes.
- Do not use domain-wide delegation.
- Do not parse arbitrary web URLs.
- Do not store raw linked-file content or private linked URLs in public docs.

## Test Plan

- Node unit tests for candidate extraction and retrieval planning.
- Python unit tests mirroring Node behavior.
- Shared conformance cases for Node/Python parity, including URL edge cases,
  source toggles, snake_case aliases, traversal/link caps, and wide-input
  traversal budgets.
- Focused validation:

  ```bash
  corepack pnpm --filter googlechatai test -- attachments
  PYTHONPATH=packages/python/src python3 -m unittest packages.python.tests.test_attachments
  corepack pnpm conformance
  ```

## Completion Criteria

- Plan doc exists and describes the implemented slice.
- Node/Python APIs are exported from package roots.
- Shared fixtures/conformance cover the public SDK behavior.
- Docs explain the distinction between rich-link metadata, Drive-link planning,
  attachment planning, and future guarded live retrieval.
- Focused tests and conformance pass locally.
