---
title: Package-Routed Cloud Run Staging Certification
date: 2026-07-10
type: runbook
status: implemented
---

# Package-Routed Cloud Run Staging Certification

This runbook certifies the package-routed Node Cloud Run reference as a
single-tenant pilot path. It does not change a Google Chat app endpoint and it
does not send a Chat message. The final guarded smoke step verifies a manual
mention that an operator sends in the dedicated smoke space.

The reference uses Google Chat JWT verification, a 1 MiB request cap, and a
Cloud Run metadata-authenticated `FirestoreIdempotencyStore`. It is intended
for short synchronous responses. Long-running AI work still needs an
application-owned durable queue and worker.

## Prerequisites

- A dedicated staging Cloud Run service, separate from dev and production.
- Artifact Registry, Cloud Build, Cloud Run, and Firestore in the target
  project.
- A Cloud Run service account with Firestore access and no downloaded key.
- A Google Chat JWT audience for the intended staging callback. Do not reuse a
  dev audience.
- A green local release gate:

  ```bash
  corepack pnpm release:check
  ```

## Safe Preflight

These commands make no Google Cloud or Google Chat mutations:

```bash
corepack pnpm cloud:deploy-sdk-reference -- --dry-run
corepack pnpm cloud:staging-certify -- --dry-run
corepack pnpm cloud:source-upload-check
```

The deploy plan is expected to report `audienceConfigured: false` until a
staging audience is supplied. Treat that as a stop condition.

## Deploy and Certify

Cloud Build builds the multi-stage image from
[`examples/cloud-run-node-sdk/Dockerfile`](../../examples/cloud-run-node-sdk/Dockerfile),
so a local Docker daemon is not required.

```bash
set -a
source .env.local
set +a

RUN_LIVE_SDK_REFERENCE_DEPLOY=1 \
GOOGLE_CHAT_SDK_REFERENCE_SERVICE=googlechatai-sdk-staging \
GOOGLE_CHAT_SDK_REFERENCE_AUDIENCE="https://staging.example.invalid" \
corepack pnpm cloud:deploy-sdk-reference

# Copy latestReadyRevisionName from the redacted deploy result.
GOOGLE_CHAT_SDK_REFERENCE_EXPECTED_REVISION="googlechatai-sdk-staging-00001-example" \
GOOGLE_CHAT_SDK_REFERENCE_SERVICE=googlechatai-sdk-staging \
corepack pnpm cloud:staging-certify
```

Deployment writes only redacted local evidence under ignored
`fixtures/live/evidence/`. It never updates a Google Chat app endpoint. The
certification command only reads the Cloud Run revision and calls `GET
/healthz`; it confirms the exact deployed revision, 100% latest-revision
traffic, normal JWT verification, Firestore idempotency, and the absence of the
local-fixture bypass. It always calls the `status.url` returned by that Cloud
Run service and rejects redirects.

## Guarded End-to-End Chat Smoke

Only after a human has configured the dedicated staging Chat app endpoint and
checked the callback URL, run a two-phase manual inbound smoke. Read
[`2026-06-29-live-chat-smoke-harness.md`](2026-06-29-live-chat-smoke-harness.md)
first.

```bash
set -a
source .env.local
set +a

# Record these before sending the manual message.
RUN_ID="staging-smoke-$(date -u +%Y%m%dT%H%M%SZ)"
SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# In the dedicated smoke space, type @, select GoogleChatAISDK from autocomplete,
# and send exactly one message containing: googlechatai-smoke:${RUN_ID}

RUN_LIVE_CHAT_SMOKE=1 \
RUN_LIVE_CHAT_INBOUND_SMOKE=1 \
RUN_LIVE_SDK_REFERENCE_CHAT_SMOKE=1 \
RUN_LIVE_SDK_REFERENCE_INBOUND_SMOKE=1 \
GOOGLE_CHAT_SDK_REFERENCE_CHAT_ENDPOINT_CONFIGURED=1 \
GOOGLE_CHAT_SDK_REFERENCE_SERVICE=googlechatai-sdk-staging \
GOOGLE_CHAT_SDK_REFERENCE_EXPECTED_REVISION="googlechatai-sdk-staging-00001-example" \
corepack pnpm cloud:staging-certify -- \
  --chat-smoke \
  --run-id="$RUN_ID" \
  --chat-smoke-since="$SINCE"
```

The command delegates to `cloud:sdk-reference-inbound-smoke`. That verifier
never sends a message: it checks one `/chat/events` POST, one structured
`cloud_run_reference.inbound_smoke_handled` log with the SHA-256 hash of the
unique marker, and no Cloud Run errors. The hash binds the observed handler to
this manual mention without saving the message text or event ID. Do not set the
endpoint-attestation variable merely to bypass this check.

## Pilot Certification

Call this path **single-tenant pilot supported** only after the release gate,
Cloud Build/Run deploy, read-only certification, and dedicated-space smoke all
pass. A durable queue/worker decision is still required for any interaction
that cannot complete inside the synchronous Google Chat callback deadline.
