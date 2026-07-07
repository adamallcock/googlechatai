---
title: Production Hardening, Caching, And Transcription Implementation Plan
date: 2026-07-03
type: plan
status: implemented
---

# Production Hardening, Caching, And Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make auth refresh, retries, duplicate-delivery suppression, directory identity enrichment, attachment/content caching, and OpenAI audio transcription available as reusable SDK surfaces instead of local feature-code chores.

**Architecture:** Keep the base packages dependency-free and polyglot-aligned. Add small Node/Python modules for retrying Chat clients, idempotency guards, directory identity cache/sync helpers, content-addressed cache helpers, and a gated OpenAI `gpt-4o-transcribe` adapter with redacted evidence.

**Tech Stack:** TypeScript, Python stdlib, shared fixtures/tests, Google Chat/Admin/Drive/OpenAI HTTP APIs through caller-provided auth.

---

### Task 1: Retrying Chat Clients And Duplicate Event Guard

**Files:**
- Modify: `packages/node/src/transport/index.ts`
- Modify: `packages/python/src/googlechatai/transport/__init__.py`
- Modify: `packages/node/test/transport.test.ts`
- Modify: `packages/python/tests/test_transport.py`

- [x] Write failing tests for a high-level Chat client that calls `requestJsonWithRetry` for app/user principals.
- [x] Write failing tests for a duplicate-delivery guard that claims `event.idempotencyKey`, returns `{}` for duplicates, and preserves claim metadata.
- [x] Implement the minimal Node and Python client/guard APIs.
- [x] Run focused transport tests until green.

### Task 2: Directory Identity Enrichment

**Files:**
- Create: `packages/node/src/identity/index.ts`
- Create: `packages/python/src/googlechatai/identity/__init__.py`
- Create: `packages/node/test/identity.test.ts`
- Create: `packages/python/tests/test_identity.py`
- Modify: `packages/node/src/index.ts`
- Modify: `packages/python/src/googlechatai/__init__.py`

- [x] Write failing tests for an Admin SDK Directory `users.list` sync plan using `admin.directory.user.readonly`, `viewType=domain_public`, and user-auth mode.
- [x] Write failing tests that cache users by Google user id, primary email, aliases, and never delete missing users; missing users become stale.
- [x] Write failing tests that unresolved/inaccessible identities return explicit AI-facing notes instead of throwing.
- [x] Implement dependency-free in-memory/file identity caches and sync/resolve helpers.
- [x] Run focused identity tests until green.

### Task 3: Attachment, Document, And Transcript Caching

**Files:**
- Create: `packages/node/src/cache/index.ts`
- Create: `packages/python/src/googlechatai/cache/__init__.py`
- Create: `packages/node/test/cache.test.ts`
- Create: `packages/python/tests/test_cache.py`
- Modify: `packages/node/src/index.ts`
- Modify: `packages/python/src/googlechatai/__init__.py`

- [x] Write failing tests for content-addressed cache keys over bytes/source/parser/provider options.
- [x] Write failing tests for file-backed metadata plus blob storage that returns hits without re-fetching bytes.
- [x] Write failing tests for negative cache entries for inaccessible attachments/users.
- [x] Implement compact dependency-free cache helpers suitable for local development and future SQLite adapters.
- [x] Run focused cache tests until green.

### Task 4: OpenAI Batch Transcription Adapter

**Files:**
- Modify: `packages/node/src/attachments/index.ts`
- Modify: `packages/python/src/googlechatai/attachments/__init__.py`
- Modify: `packages/node/test/attachments.test.ts`
- Modify: `packages/python/tests/test_attachments.py`
- Modify: `docs/guides/2026-06-29-voice-note-transcription-setup.md`

- [x] Write failing tests that the default OpenAI model is `gpt-4o-transcribe`.
- [x] Write failing tests for size limits, explicit enablement, redacted evidence, and default HTTP client behavior through injected fetch/request callbacks.
- [x] Implement the gated OpenAI transcription client without adding a core runtime dependency.
- [x] Run focused attachment tests until green.

### Task 5: Live-Smoke And Docs Closeout

**Files:**
- Modify: `docs/guides/2026-07-02-production-auth-retry-idempotency.md`
- Modify: the private live feature completion audit (kept outside the public repository)
- Modify: the private live QA ledger (kept outside the public repository)

- [x] Document that Pub/Sub is optional Workspace Events ingestion, not required for ordinary direct Chat webhooks.
- [x] Document why `spaces.spaceEvents.list`, `spaces.messages.search`, and `spaces.messagePins.list` remain drift probes when live returns 500/404.
- [x] Document Cloud Monitoring-only alert posture for now.
- [x] Record the exact local/offline tests and the gated live commands for reply-chain context, parser packages, transcription, and UI idempotency mention.
- [x] Run conformance, unit tests, build, discovery check, and release check before commit.

### Task 6: Identity-Enriched Conversation Context

**Files:**
- Modify: `packages/node/src/threads/index.ts`
- Modify: `packages/python/src/googlechatai/threads/__init__.py`
- Modify: `packages/node/test/messages.test.ts`
- Modify: `packages/python/tests/test_messages.py`
- Modify: `packages/node/src/index.ts`
- Modify: `packages/python/src/googlechatai/__init__.py`

- [x] Write failing Node and Python tests for context sender enrichment through the shared directory cache.
- [x] Cover recursive quoted-message enrichment, including stale directory records that remain usable for historical context.
- [x] Cover cache-unavailable fallback so Chat context handling continues when enrichment storage fails.
- [x] Add opt-in context wrappers so existing synchronous conformance fixtures remain unchanged.
- [x] Run focused message/context tests until green.
