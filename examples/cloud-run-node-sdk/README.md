---
title: Package-Routed Cloud Run Reference
date: 2026-07-10
type: guide
status: implemented
---

# Package-Routed Cloud Run Reference

This is the canonical Node.js Cloud Run integration for the SDK. It routes
every `/chat/events` request through `GoogleChatAI.fetch()`, so the public
Google Chat JWT verifier, HTTP-method handling, event normalization, and
response rendering all use the package rather than a second webhook parser.

Normal mode requires both `GOOGLE_CHAT_AUDIENCE` and `GOOGLE_CLOUD_PROJECT`.
The server creates the SDK's
Google Chat verifier and rejects unverified requests before any handler runs.
It also enforces a 1 MiB decoded request-body cap by default. Set
`GOOGLE_CHAT_MAX_BODY_BYTES` only when the deployment's explicit payload policy
requires a different positive integer.

Normal Cloud Run mode also installs a `FirestoreIdempotencyStore` with a
metadata-server authenticated REST transport. The transport owns the short-lived
Cloud Run token; the SDK never persists or logs it. Set
`GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION` only to choose a non-default
collection path. The Cloud Run service account must have the required Firestore
access.

The only verification bypass is the deliberately named local-fixture mode:

```bash
corepack pnpm build
GOOGLE_CHAT_LOCAL_FIXTURES=1 PORT=8080 node examples/cloud-run-node-sdk/server.mjs
```

This mode is for local fixture tests only. Do not set
`GOOGLE_CHAT_LOCAL_FIXTURES=1` in Cloud Run or any internet-reachable service.
The exported `createServer({ chat })` test hook is also restricted to this
explicit fixture mode, so a custom runtime cannot bypass normal verifier
construction accidentally.

For a production-like local boundary, provide the intended Chat audience:

```bash
GOOGLE_CLOUD_PROJECT="your-project" \
GOOGLE_CHAT_AUDIENCE="https://your-service.example" PORT=8080 \
  node examples/cloud-run-node-sdk/server.mjs
```

The verifier will retrieve public Google JWKS when it receives a request; this
does not send a Google Chat message. Use the dedicated smoke-space runbook
before any live Chat action.

Build the container from the repository root. The multi-stage Dockerfile builds
the SDK inside the image, so no local `dist/` output is required:

```bash
docker build -f examples/cloud-run-node-sdk/Dockerfile -t googlechatai-cloud-run .
```

For a controlled Cloud Build/Cloud Run deployment and non-writing health
certification, use
[`docs/runbooks/2026-07-10-staging-certification.md`](../../docs/runbooks/2026-07-10-staging-certification.md).
The reference intentionally leaves application handlers small. Long-running AI
delivery still needs an application-owned durable queue and worker; do not use a
local file store as cross-instance coordination.
