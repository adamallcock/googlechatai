---
title: Workspace Events Privacy And Retention
date: 2026-06-30
type: decision-record
status: draft
---

# Workspace Events Privacy And Retention

## Decision

Do not create broad real Google Workspace Events subscriptions for Chat until a user-approved privacy and retention policy exists for the specific target resource, event types, payload inclusion, and raw payload storage.

Synthetic Pub/Sub messages remain allowed for parser and smoke validation.

## Minimum Gates

Before creating or renewing a real subscription, record:

- Target resource: exact Chat space, membership, or message resource. Avoid wildcard resources until reviewed.
- Event types: exact Workspace Events event type strings.
- Payload option: whether `payloadOptions.includeResource` is enabled.
- Raw payload retention: whether raw Pub/Sub or Workspace payloads are stored, where, for how long, and who can access them.
- Normalized metadata retention: checkpoint and event metadata retention period.
- Logging policy: which fields are safe to log and which must be redacted.
- Auth mode and scopes: exact principal and OAuth scopes.
- Pub/Sub resources: topic, subscription, retention settings, and publisher IAM binding.
- Reviewer: person who approved the scope and retention choice.

## Default Policy

Until a stronger policy is approved:

- Subscribe only to named test spaces.
- Subscribe only to the narrow event types required by the smoke or feature.
- Set `payloadOptions.includeResource` to `false` for real subscriptions unless included resource payloads are explicitly approved.
- Store checkpoint metadata only.
- Do not store raw message content from real events.
- Do not log message text, attachment names, user emails, access tokens, authorization headers, or raw payload bodies.
- Keep local smoke messages synthetic and clearly marked with a `synthetic=true` Pub/Sub attribute.

## Subscription Lifecycle

Creation and renewal must produce an audit note containing:

- Subscription resource name.
- Pub/Sub topic and subscription.
- Target resource.
- Event types.
- Payload options.
- Creation or renewal timestamp.
- Expiration timestamp when available.
- Reviewer and reason.

Renewal should re-check the same privacy gates instead of mechanically extending an old subscription.

## Allowed Now

- Fixture-based tests.
- Synthetic Pub/Sub publish/pull smoke tests.
- Parser work that preserves raw payload access locally without uploading it externally.
- Documentation and dry-run subscription planning.

## Not Allowed Yet

- Broad Workspace subscriptions such as all Chat spaces.
- Real event subscriptions with included message resources before retention approval.
- Push endpoints that accept real Workspace Events before endpoint auth, replay, and logging policy are documented.
- Sending Chat messages as part of Workspace Events ingestion validation.
