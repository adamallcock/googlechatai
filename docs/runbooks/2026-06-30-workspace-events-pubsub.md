---
title: Workspace Events Pub/Sub Ingestion
date: 2026-06-30
type: runbook
status: draft
---

# Workspace Events Pub/Sub Ingestion

This runbook covers W11 ingestion and the gate for real Google Workspace Events subscriptions. The current implementation supports synthetic Pub/Sub messages and parser fixtures only. Do not create a broad real Workspace Events subscription until the privacy and retention gates below are complete.

## Implemented Local Path

Node and Python both parse:

- Pub/Sub push payloads with `message.data`, `message.attributes`, `messageId`, `publishTime`, and `subscription`.
- Pub/Sub pull payloads from `gcloud pubsub subscriptions pull --format=json`.
- Google Workspace Chat resource events encoded as CloudEvents in Pub/Sub attributes.
- Workspace event metadata, including CloudEvent ID/type/source/subject/time, raw Chat resource name, resource availability, actor availability, and resource data availability.
- Pub/Sub checkpoint metadata, including `ackId`, `messageId`, `publishTime`, `orderingKey`, `deliveryAttempt`, `subscription`, and a stable cursor.

Run the synthetic pull smoke:

```bash
pnpm workspace-events:pull-smoke
```

Defaults:

- `GOOGLE_CLOUD_PROJECT=example-chat-project`
- `WORKSPACE_EVENTS_PUBSUB_TOPIC=example-chat-project-smoke-tests`
- `WORKSPACE_EVENTS_PUBSUB_SUBSCRIPTION=example-chat-project-smoke-tests-dev-pull`

The smoke publishes a synthetic Workspace Events Chat message CloudEvent to Pub/Sub, pulls it from the dev subscription, normalizes it through the SDK, and prints a compact JSON result. It does not call the Google Chat API and does not send Chat messages.

## W2 Adapter Assumptions

W2 currently normalizes direct Google Chat HTTP event payloads. W11 therefore uses a minimal adapter:

- Workspace Events CloudEvent metadata is preserved on `event.workspaceEvent`.
- Pub/Sub metadata and checkpoint data are preserved on `event.pubSub`.
- Included Chat message resources are converted into the existing direct Chat event shape before calling W2 normalization.
- Name-only or access-limited resources still produce a shared envelope, with `resourceDataAvailability` and `actorAvailability` set explicitly instead of pretending payload data is present.
- Workspace event IDs, when present, become the normalized `eventId` and idempotency seed so Pub/Sub redelivery does not create a different logical event.

## Real Subscription Gates

Before creating or renewing a real Workspace Events subscription:

- Scope gate: choose one explicit target resource, preferably one named test Chat space such as `//chat.googleapis.com/spaces/SPACE_ID`. Do not use `//chat.googleapis.com/spaces/-` until this has a privacy review.
- Event gate: enumerate only required event types, such as `google.workspace.chat.message.v1.created`. Do not subscribe to all supported Chat event families by default.
- Payload gate: set `payloadOptions.includeResource` to `false` unless the use case requires message/resource payloads. If it is `true`, document the minimum fields needed and retention.
- Retention gate: document Pub/Sub message retention, local checkpoint retention, logs, and who can access raw payloads. Raw payloads can include user-authored message content.
- Auth gate: verify the exact OAuth/app-auth scopes for the chosen Chat event types and save the decision in a repo runbook or decision record.
- Delivery gate: keep the first real subscription pull-based until parser, checkpoint, and retention behavior is validated. Move to push delivery only after endpoint auth and replay behavior are documented.
- Audit gate: record subscription name, target resource, event types, payload options, Pub/Sub topic/subscription, creator principal, creation time, and renewal schedule.

## Create A Real Subscription When Allowed

Official flow summary, checked against Google docs on 2026-06-30:

1. Enable the APIs:

   ```bash
   gcloud services enable pubsub.googleapis.com workspaceevents.googleapis.com
   ```

2. Create a Pub/Sub topic and pull subscription:

   ```bash
   gcloud pubsub topics create WORKSPACE_EVENTS_TOPIC_ID
   gcloud pubsub subscriptions create WORKSPACE_EVENTS_SUBSCRIPTION_ID \
     --topic=projects/PROJECT_ID/topics/WORKSPACE_EVENTS_TOPIC_ID
   ```

3. Grant `roles/pubsub.publisher` on the topic to the Google Workspace publisher principal. For Chat, Google documents two cases: Workspace add-ons that extend Chat use the service account from the Chat API configuration page; Chat API interaction events use `chat-api-push@system.gserviceaccount.com`.

   ```bash
   gcloud pubsub topics add-iam-policy-binding \
     projects/PROJECT_ID/topics/WORKSPACE_EVENTS_TOPIC_ID \
     --member='serviceAccount:GOOGLE_WORKSPACE_APPLICATION' \
     --role='roles/pubsub.publisher'
   ```

4. Create the Workspace Events subscription with a minimal target, event set, and payload option:

   ```json
   {
     "targetResource": "//chat.googleapis.com/spaces/SPACE_ID",
     "eventTypes": ["google.workspace.chat.message.v1.created"],
     "notificationEndpoint": {
       "pubsubTopic": "projects/PROJECT_ID/topics/WORKSPACE_EVENTS_TOPIC_ID"
     },
     "payloadOptions": {
       "includeResource": false
     }
   }
   ```

   Use the Workspace Events API `subscriptions.create` method with the approved user/app authentication mode and scopes. The SDK W11 parser handles both included-resource payloads and access-limited/name-only states.

5. Pull a small sample and normalize it locally:

   ```bash
   gcloud pubsub subscriptions pull \
     projects/PROJECT_ID/subscriptions/WORKSPACE_EVENTS_SUBSCRIPTION_ID \
     --format=json \
     --limit=5
   ```

   Do not `--auto-ack` real messages until the runbook for local persistence and replay has been accepted.

## Guarded Subscription Smoke

Implemented on 2026-07-02:

```bash
RUN_LIVE_WORKSPACE_EVENTS_SUBSCRIPTION_SMOKE=1 \
corepack pnpm live:chat-workspace-events-subscription-smoke -- --dry-run
```

The dry run is side-effect free. It verifies the exact local configuration that
would be used for a narrow Chat subscription:

- target resource: `//chat.googleapis.com/${GOOGLE_CHAT_TEST_SPACE}`;
- event type default: `google.workspace.chat.message.v1.created`;
- payload default: `payloadOptions.includeResource=false`;
- user auth scope default: `chat.messages.readonly`;
- publisher principal default:
  `serviceAccount:chat-api-push@system.gserviceaccount.com`;
- temporary Pub/Sub topic/subscription names derived from the run id.

Validate-only creates temporary Pub/Sub plumbing, calls Workspace Events
`subscriptions.create` with `validateOnly=true`, then deletes the temporary
topic/subscription:

```bash
RUN_LIVE_WORKSPACE_EVENTS_SUBSCRIPTION_SMOKE=1 \
GOOGLE_CHAT_WORKSPACE_EVENTS_SUBSCRIPTION_RUN_ID=workspace-events-validate-YYYYMMDDTHHMMZ \
corepack pnpm live:chat-workspace-events-subscription-smoke -- \
  --validate-only \
  --allow-blocked
```

Full live mode requires an additional explicit write gate because it creates a
real Workspace Events subscription, posts one app-owned trigger message to the
dedicated smoke space, pulls the matching Pub/Sub event, and deletes the trigger
message, Workspace Events subscription, Pub/Sub subscription, and Pub/Sub topic:

```bash
RUN_LIVE_WORKSPACE_EVENTS_SUBSCRIPTION_SMOKE=1 \
GOOGLE_CHAT_AI_ENABLE_LIVE_WORKSPACE_EVENTS_SUBSCRIPTION=1 \
GOOGLE_CHAT_WORKSPACE_EVENTS_SUBSCRIPTION_RUN_ID=workspace-events-live-YYYYMMDDTHHMMZ \
corepack pnpm live:chat-workspace-events-subscription-smoke -- --allow-blocked
```

Current private live test tenant evidence from 2026-07-02:

- Run `workspace-events-validate-20260702T1710Z` created a temporary Pub/Sub
  topic and pull subscription, then attempted to grant the documented Chat
  publisher principal.
- The project org policy blocked that IAM binding with
  `constraints/iam.allowedPolicyMemberDomains`, because
  `chat-api-push@system.gserviceaccount.com` is outside the permitted customer.
- The harness classified this as blocked evidence under `--allow-blocked` and
  deleted the temporary Pub/Sub subscription and topic.
- Cloud Run log sweep
  `log-smoke-workspace-events-validate-20260702T1710Z` for
  `2026-07-02T17:08:40Z` through `2026-07-02T17:10:20Z` found zero Cloud Run
  errors, zero Chat event logs, and zero `/api/chat/events` HTTP posts during
  the validate-only Pub/Sub/Workspace Events window.
- Follow-up `gcloud pubsub topics list` and `gcloud pubsub subscriptions list`
  checks for `example-chat-project-we-workspace-events-validate` returned no temporary
  topics or subscriptions.
- Evidence path:
  `fixtures/live/evidence/chat-workspace-events-subscription-smoke-workspace-events-validate-20260702T1710Z.json`.
- Log evidence path:
  `fixtures/live/evidence/chat-log-smoke-log-smoke-workspace-events-validate-20260702T1710Z.json`.
- No raw Chat message text, access tokens, sender emails, or Pub/Sub ack IDs
  were saved.

To unblock the full subscription smoke, the Workspace/org-policy administrator
must allow the documented Google Chat publisher principal on the temporary topic
or provide the Chat app-specific publisher service account from the Chat API
configuration page if the Workspace add-on path is being used.

## Renew A Real Subscription When Allowed

Google recommends tracking subscription expiration and renewing as needed instead of relying only on expiration reminder events. To renew to the maximum expiration time, patch `ttl` to zero with `updateMask=ttl` using the same approved auth path used to create the subscription:

```json
{
  "ttl": "0s"
}
```

Record each renewal in the audit trail with the subscription name, operation ID, previous expiration time, new expiration time, event types, payload options, and reviewer.

## Sources

- Google Workspace Events overview: https://developers.google.com/workspace/events
- Google Workspace Events for Chat: https://developers.google.com/workspace/events/guides/events-chat
- Create a Google Workspace subscription: https://developers.google.com/workspace/events/guides/create-subscription
- Update or renew a Google Workspace subscription: https://developers.google.com/workspace/events/guides/update-subscription
- Pub/Sub pull subscriptions: https://cloud.google.com/pubsub/docs/pull
- Pub/Sub push subscriptions: https://cloud.google.com/pubsub/docs/push
