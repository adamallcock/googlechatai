---
title: Production Hardening Boundaries
date: 2026-07-10
type: guide
status: implemented
---

# Production Hardening Boundaries

This guide describes the production-facing hardening added after the July 10
architecture assessment. It does not widen the live Google Chat safety
boundary: all examples and tests remain local or use injected transports.

## Verified Inbound Paths

Node's `expressAdapter(chat, { maxBodyBytes })` now builds a Fetch `Request`
and calls `chat.fetch()`. A configured verifier therefore runs before SDK JSON
parsing or handler dispatch. The adapter defaults to a 1 MiB decoded-body
limit, rejects an oversized declared `Content-Length` before consuming its
stream, and returns a safe `413 payload_too_large` response when exceeded.

When mounting it after Express body parsing, the upstream middleware remains
the ingress-memory boundary: configure the same or tighter limit, for example
`app.use(express.json({ limit: "1mb" }))`, before the adapter. The adapter
also checks `req.body`, but it cannot undo memory already allocated by an
earlier parser. Mount it before body parsing only when it is responsible for
reading the raw stream.

Python's ASGI and FastAPI adapters offload synchronous verifier work from the
event loop, apply a configurable five-second deadline to both synchronous and
asynchronous verifier implementations, and return `500
verification_unavailable` if a verifier cannot run or times out. Both adapters
stream and cap request bodies at 1 MiB by default, reject oversized declared
lengths early, and return `413 payload_too_large`; malformed UTF-8/JSON is a
safe `400 invalid_json` response.

Deadline-enabled Python dispatch uses cooperative task waiting. Synchronous
handlers run in a shared, bounded executor, and synchronous `dispatch()` calls
reuse one late-work supervisor loop. A timed-out handler can finish and be
logged without blocking unrelated ASGI work or creating one thread per
delivery. If bounded blocking-work capacity is exhausted, the runtime fails the
delivery so the HTTP boundary returns a retryable `503` rather than accepting
it without duplicate protection.

`handlePayload()` / `dispatch()` remain useful for fixture replay and
application-owned boundaries. Internet-facing Node applications should use
`chat.fetch()` or `expressAdapter`; Python applications should use ASGI or
FastAPI adapters with a verifier.

## Local File State Versus Durable State

`FileIdempotencyStore`, `FileTokenStore`, `FileAsyncResponseQueue`, file
identity/checkpoint stores, cancellation registries, and artifact metadata now
use a per-path same-runtime lock plus random temporary files and atomic
replacement. Concurrent callers in one process no longer lose updates or
collide on temporary names.

They are still local-development/single-host helpers. They do not coordinate
separate processes, containers, or Cloud Run instances. Use a durable store
for any multi-instance deployment.

Both packages expose a structural idempotency contract rather than requiring a
built-in class:

- Node: `IdempotencyStore.claim({ key, ttlMs, nowMs, metadata })`.
- Python: `IdempotencyStore.claim(key, ttl_ms=..., now_ms=..., metadata=...)`.

Python preserves a generic synchronous store's caller thread by default,
including `dispatch_async`, so thread-affine application stores (for example a
SQLite/session store) remain valid. A synchronous network-backed store can opt
into bounded worker execution with `dedupe={"store": store,
"offload_sync": True}`; `FirestoreIdempotencyStore` declares that requirement
automatically. Deadline-enabled paths also offload synchronous stores so their
deadline remains meaningful.

`FirestoreIdempotencyStore` is a dependency-free Firestore REST reference in
both runtimes. It conditionally creates the first document, reads on conflict,
uses the observed Firestore `updateTime` for duplicate-count updates, and only
deletes an expired document with the matching precondition. Canonical
`FAILED_PRECONDITION` responses and HTTP 409 races retry with bounded
exponential jitter; repeated conflicts surface a retryable store error. Its
transport is injected and must add authentication; the SDK never owns,
persists, or logs credentials.

The package-routed Cloud Run reference disables optional duplicate-delivery
counter updates on its hot ingress path: a duplicate still performs the
durable decision, but it does not contend on a counter-write CAS merely for
statistics. Applications that need per-duplicate counts can keep the SDK
default enabled and should size Firestore accordingly.

## Model-Safe Context and Attachments

Use `projectModelContext` (Node) or `project_model_context` (Python) after
building canonical conversation context. The projection:

- emits one trusted SDK-owned system-policy fragment plus per-fragment trust
  and provenance labels;
- labels Chat messages, quotes, attachments, top-level notes, and per-message
  card/action/reaction/relationship notes as untrusted;
- omits operational page cursors and attachment resource URLs/tokens;
- redacts sender and text email addresses by default;
- applies per-fragment (20,000), total untrusted-text (100,000), fragment
  count (256), and quote-depth (8) caps by default, with projection metadata
  that states whether context was omitted or truncated.

Existing canonical context retains operational metadata for application logic;
the model-safe projection is the intended external-model handoff. It is not a
tenant DLP system or a prompt-injection detector.

`parseAttachmentContent` / `parse_attachment_content` also accept an
application-owned safety scanner and parser input/output limits. A scanner can
block content before parsing, `maxParseBytes` / `max_parse_bytes` bounds
byte-like input, and `maxExtractedChars` / `max_extracted_chars` truncates
retained extracted text. The SDK deliberately does not bundle malware, DLP,
or model-provider policy engines.

## Cloud Run Reference

[`examples/cloud-run-node-sdk/`](../../examples/cloud-run-node-sdk/) is the
package-routed Cloud Run reference. It requires `GOOGLE_CHAT_AUDIENCE` in
normal mode, routes `/chat/events` through `GoogleChatAI.fetch()`, limits
request bodies before dispatch, and configures a metadata-authenticated
`FirestoreIdempotencyStore` from `GOOGLE_CLOUD_PROJECT`. The local-fixture
bypass is explicit and never permitted in normal mode. The staging deploy and
read-only certification commands are documented in
[`2026-07-10-staging-certification.md`](../runbooks/2026-07-10-staging-certification.md).

Metadata-token refreshes use a shared in-flight request, and both metadata and
Firestore REST calls have bounded abortable deadlines. The deploy command sets
an explicit 20-request concurrency and 512 MiB memory baseline (both
overridable) rather than leaving the 1 MiB ingress-boundary capacity implicit.

The older [`examples/cloud-run-node/`](../../examples/cloud-run-node/) remains
a smoke scaffold and is not the canonical production path.

## Discovery and Coverage Gates

`corepack pnpm discovery:check` compares the live Google Chat discovery
document with the curated snapshot by method name and SHA-256 fingerprints of
HTTP method, path, reachable request/response schema contracts, parameters,
scopes, and media upload contract. An incomplete baseline signature set fails
closed. A revision-only change remains informational because Google can roll
revisions without behavior changes.

`corepack pnpm test:coverage` now enforces Node aggregate floors:

| Metric | Minimum |
| --- | ---: |
| Statements | 85% |
| Branches | 70% |
| Functions | 90% |
| Lines | 85% |

Run `corepack pnpm release:check` before release-adjacent work. It includes
formatting, docs links, builds, generated-file hygiene, secret scanning,
package-content checks, and dependency freshness.

## Python Public Types and Type Checking

`googlechatai.public_types` provides additive `TypedDict` models for event
envelopes and the real model-safe projection shape. Its idempotency claim and
store symbols re-export the actual transport dataclass and protocol used by the
router, rather than a mapping-shaped approximation. The SDK's canonical runtime
remains dictionary-oriented where applicable so shared fixtures retain their
Node/Python contract.

`corepack pnpm python:typecheck` runs Pyright in strict mode against the public
type module and checked consumer examples. This is an enforceable public API
contract gate; `python:static` continues to compile the full dependency-free
runtime while typing coverage is expanded incrementally.

## Remaining Application Responsibilities

- Choose tenant-specific authentication, authorization, data retention, and
  scanner/DLP policy.
- Supply a durable queue/state backend and monitor its availability.
- Use a dedicated smoke space and the live-smoke runbook for any Chat write.
- Verify new or changed Google API methods with discovery, fixtures, and a
  guarded live test before representing them as generally shipped behavior.
