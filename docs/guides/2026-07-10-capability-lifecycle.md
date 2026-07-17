---
title: Capability Lifecycle
date: 2026-07-10
type: reference
status: implemented
---

# Capability Lifecycle

Use these labels separately. A green unit test does not imply that a Google API
surface is safe for every tenant or ready for a multi-tenant production service.

| Surface | Locally tested | Dry-run planner | Guarded live-smoke evidence | Production-supported status |
| --- | --- | --- | --- | --- |
| Event normalization, router dispatch, cards, replies, and streaming plans | Yes | Yes where the API plan exists | Core paths are dedicated-space smoke candidates | Suitable when the host supplies auth, durable state, and policy |
| Node Express / Python ASGI-FastAPI inbound verification | Yes, including bounds and saturation | N/A | Requires a dedicated app endpoint smoke | Single-tenant pilot candidate through the package-routed reference |
| Firestore idempotency | Injected-transport contracts in Node and Python | N/A | Monitor/job tooling is guarded | Supported when the host supplies authenticated transport and verifies IAM/TTL |
| Package-routed Cloud Run reference | HTTP boundary, Docker layout, and Cloud Build plan | Yes | Requires the staging certification runbook | Pilot candidate only after deploy, health check, and dedicated-space smoke |
| Long-running AI delivery / worker queue | Queue adapters and planners | Yes | Depends on host setup | Application-owned; no end-to-end worker reference is supplied |
| Model-safe context and attachment policy seams | Shared Node/Python conformance | N/A | Requires application data review | SDK foundation only; tenant DLP, retention, and injection policy remain host responsibilities |
| Workspace Events subscriptions and `spaces.spaceEvents.list` | Synthetic parser and setup harness | Yes | Blocked by tenant policy or upstream behavior in the current environment | Not production supported until an approved tenant verifies it |
| Pins and message search | Planner/fixture coverage | Yes | Current tenant probes remain unavailable | Do not expose as stable primitives until discovery and live support align |

## Promotion Rules

Promote a surface only when all applicable evidence exists:

1. Shared fixture/conformance coverage for Node and Python behavior.
2. A bounded dry-run plan for operations that can write or access tenant data.
3. A guarded dedicated-space smoke for the exact Google API/app configuration.
4. A documented runtime recipe with authentication, durable state, monitoring,
   privacy/retention policy, and an operational alert owner.

The staging certification and monitor runbooks bridge the first three labels to
a narrowly defined single-tenant pilot claim. They do not turn the SDK into a
generic multi-tenant compliance platform.
