---
title: Production Idempotency Monitor Operations
date: 2026-07-10
type: runbook
status: implemented
---

# Production Idempotency Monitor Operations

Deploy the Firestore idempotency monitor before accepting production traffic.
The production command deploys or updates the monitor Cloud Run Job, upserts its
Cloud Scheduler trigger, executes one initial redacted check by default, and
creates or updates an enabled LogMatch alert policy.

The monitor never saves raw Firestore document names, event keys, message text,
tokens, or notification-channel values in its evidence.

The monitor checks an exact Firestore collection path (including nested paths),
uses a bounded server-side aggregation for expired documents, and keeps its
diagnostic sample at 100 documents or fewer. Normal rolling idempotency volume
is not itself a retention incident: the operator must provide either an
explicit document-threshold pair or a pilot ingress-rate/retention budget.

## Required External Choice

Choose an approved Cloud Monitoring notification channel and identify the team
or on-call owner before applying this runbook. Export the complete resource name
only in the operator environment:

```text
projects/PROJECT_ID/notificationChannels/CHANNEL_ID
```

Use a team-owned email, PagerDuty, webhook, or equivalent. Do not hardcode a
personal destination in tracked configuration.

The default setup creates a dedicated Scheduler identity named
`chat-ai-sdk-monitor-scheduler@PROJECT_ID.iam.gserviceaccount.com` and grants
it `roles/run.invoker` on this monitor job only. The applying principal needs
permission to create that service account and set job IAM. If that authority is
not available, pre-provision a narrow Scheduler identity and pass
`--scheduler-service-account=<email>` instead.

## Safe Preflight

Without a channel, the dry run deliberately reports an incomplete plan:

```bash
corepack pnpm cloud:idempotency-monitor-production -- --dry-run
```

With a real channel exported only in the operator environment, review the plan:

```bash
set -a
source .env.local
set +a

GOOGLE_CHAT_IDEMPOTENCY_MONITOR_NOTIFICATION_CHANNEL="projects/.../notificationChannels/..." \
GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EXPECTED_EVENTS_PER_MINUTE=20 \
GOOGLE_CHAT_IDEMPOTENCY_MONITOR_RETENTION_MINUTES=10 \
corepack pnpm cloud:idempotency-monitor-production -- --dry-run
```

## Apply

Live apply requires an explicit guard. It is idempotent for the managed
scheduler and alert policy: existing managed resources are updated rather than
duplicated.

```bash
set -a
source .env.local
set +a

RUN_LIVE_IDEMPOTENCY_MONITOR_PRODUCTION=1 \
GOOGLE_CHAT_IDEMPOTENCY_MONITOR_NOTIFICATION_CHANNEL="projects/.../notificationChannels/..." \
GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EXPECTED_EVENTS_PER_MINUTE=20 \
GOOGLE_CHAT_IDEMPOTENCY_MONITOR_RETENTION_MINUTES=10 \
corepack pnpm cloud:idempotency-monitor-production
```

The default schedule is every 30 minutes in UTC. Use `--schedule` only after
choosing an alert budget and retention policy. `expected-events-per-minute ×
retention-minutes` defines the normal rolling cardinality; the command derives
warning/failure thresholds with 1.5×/2× headroom. Alternatively, pass both
`--warn-docs` and `--fail-docs` when a reviewed tenant policy needs explicit
thresholds. Use `--skip-initial-run` only if the job must deploy before
Firestore access is ready; run it manually afterward.

## Response

The alert is created and confirmed enabled before the Scheduler is upserted. It
matches both redacted monitor warnings/failures and `ERROR` logs from the Cloud
Run Job, so a metadata-token or Firestore IAM failure remains visible even when
the monitor cannot write its normal summary. When the alert fires, inspect the
redacted monitor evidence and Cloud Logging summary, confirm Firestore TTL and
IAM state, and reject or pause delivery work if durable deduplication is
unavailable. Record the resolution only in the private tenant ledger.
