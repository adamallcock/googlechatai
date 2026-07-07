---
title: Google Cloud Project Setup
date: 2026-06-29
type: runbook
status: draft
---

# Google Cloud Project Setup

## Project

- Project ID: `example-chat-project`
- Display name: `GoogleChatSDK`
- Project number: `123456789012`
- Default region for SDK test services: `us-central1`
- Console dashboard: https://console.cloud.google.com/home/dashboard?project=example-chat-project&organizationId=0

## Local Credentials

The downloaded service-account key was moved out of Downloads and locked down:

```text
~/.config/googlechatai-sdk/credentials/example-chat-project-service-account.json
```

Permissions are `0600`. Do not commit this file or paste its contents into logs.

The repo-local `.env.local` file points at this key and is ignored by git.

## Enabled APIs

The following APIs are enabled:

- Google Chat API: `chat.googleapis.com`
- Google Workspace Events API: `workspaceevents.googleapis.com`
- Pub/Sub: `pubsub.googleapis.com`
- Cloud Run: `run.googleapis.com`
- Artifact Registry: `artifactregistry.googleapis.com`
- Cloud Build: `cloudbuild.googleapis.com`
- IAM: `iam.googleapis.com`
- IAM Credentials: `iamcredentials.googleapis.com`
- Secret Manager: `secretmanager.googleapis.com`
- Cloud Resource Manager: `cloudresourcemanager.googleapis.com`
- Drive API: `drive.googleapis.com`
- People API: `people.googleapis.com`
- Admin SDK API: `admin.googleapis.com`
- Google Workspace Marketplace SDK: `appsmarket-component.googleapis.com`
- Google Workspace Marketplace API: `appsmarket.googleapis.com`
- Google Workspace Add-ons API: `gsuiteaddons.googleapis.com`
- Cloud Logging: `logging.googleapis.com`
- Cloud Monitoring: `monitoring.googleapis.com`

## Created Cloud Resources

Runtime identity:

```text
example-chat-project-runtime@example-chat-project.iam.gserviceaccount.com
```

Pub/Sub:

```text
projects/example-chat-project/topics/example-chat-project-workspace-events
projects/example-chat-project/subscriptions/example-chat-project-workspace-events-dev-pull
projects/example-chat-project/topics/example-chat-project-smoke-tests
projects/example-chat-project/subscriptions/example-chat-project-smoke-tests-dev-pull
```

Artifact Registry:

```text
us-central1-docker.pkg.dev/example-chat-project/example-chat-project
us-central1-docker.pkg.dev/example-chat-project/cloud-run-source-deploy
```

Cloud Run:

```text
https://example-chat-project-dev-webhook-123456789012.us-central1.run.app
https://example-chat-project-dev-webhook-123456789012.us-central1.run.app/api
https://example-chat-project-dev-webhook-123456789012.us-central1.run.app/api/avatar.png
https://example-chat-project-dev-webhook-123456789012.us-central1.run.app/api/chat/events
```

Current verification status:

- Cloud Run service status: Ready.
- Ingress: all.
- Invoker IAM: `allUsers`.
- Container startup log: successful.
- Deployed revision checked on 2026-06-30: `example-chat-project-dev-webhook-00003-hmc`.
- `BASE_URL=https://example-chat-project-dev-webhook-123456789012.us-central1.run.app/api`.
- `curl -sS "$BASE_URL/healthz"` returns JSON with `ok: true`.
- Dev avatar URL for Cloud Console: `https://example-chat-project-dev-webhook-123456789012.us-central1.run.app/api/avatar.png`.
- Chat webhook URL for Cloud Console: `https://example-chat-project-dev-webhook-123456789012.us-central1.run.app/api/chat/events`.
- Google Chat app configuration was reachable in Cloud Console on 2026-06-30.
- `pnpm chat:app-auth-smoke` returns `ok: true` and lists spaces with app auth without sending messages.
- `pnpm chat:app-auth-smoke -- --create-test-space` returns a Google Chat API
  error after supplying `customer=customers/my_customer`; no test space was
  created and `.env.local` was not updated. This app-auth create-space path is
  now diagnostic-only, not the default chatbot install model.
- `gcloud projects describe example-chat-project` shows no organization parent, and `gcloud organizations list` returns `[]` for the active personal Google account.
- The Chat API Configuration page shows the consumer-account warning `Users with personal Google accounts can only create apps for personal use. Settings such as "Join spaces and group conversations" are disabled automatically.` The `Join spaces and group conversations` control is disabled in this project/account state.
- The root Cloud Run `run.app` path `/healthz` still returns Google's outer HTML `404` before reaching the container. Use the `/api` base path above for smoke checks and Chat configuration.

Local gcloud config:

```text
llm-googlechat
```

## Smoke Tests

Run from the repository root:

```bash
set -a
source .env.local
set +a

pnpm cloud:doctor
pnpm cloud:pubsub-smoke
pnpm cloud:health-smoke
curl -sS "$BASE_URL/healthz"
pnpm chat:app-auth-smoke
```

`pnpm chat:app-auth-smoke` uses service-account app auth and does not send messages. It lists at most one Chat space. On 2026-06-30 it returned `ok: true` with zero spaces visible to the app.

After the Chat app is configured and an OAuth client is available, create a
named test room with per-user OAuth only, not a DM:

```bash
pnpm chat:user-auth-smoke -- --authorize --create-test-space
pnpm chat:user-auth-smoke -- \
  --create-test-space \
  --metadata-output fixtures/live/chat-smoke-space.local.json
```

On successful creation, copy the returned `response.name` into `.env.local` as
`GOOGLE_CHAT_TEST_SPACE`, open the returned Chat URL, and add/install the Chat
app into that smoke space. The W7 live smoke harness then validates the
dedicated smoke space before sending any test messages.

For the guarded live send/edit/delete smoke harness, use
[Live Chat Smoke Harness](2026-06-29-live-chat-smoke-harness.md). The harness
requires `RUN_LIVE_CHAT_SMOKE=1`, a `spaces/...` test space, and local
smoke-space metadata before it will perform any write.

## Chat App Configuration

Google Chat app registration/configuration is managed through the Google Chat API configuration page in Cloud Console. Use this safe first-test handler setup when the project is opened from a Google Workspace account where Chat app space functionality is available:

- App name: `Google Chat AI SDK Dev`
- Avatar URL: `https://example-chat-project-dev-webhook-123456789012.us-central1.run.app/api/avatar.png`
- Description: short dev-only description, for example `SDK dev smoke webhook`.
- Interactive features: enabled.
- Functionality: select `Join spaces and group conversations`.
- Connection setting: HTTP endpoint URL.
- HTTP endpoint URL: `https://example-chat-project-dev-webhook-123456789012.us-central1.run.app/api/chat/events`.
- Visibility: restricted to safe test users only, ideally just the owner account until W7 live smoke guardrails exist. Google documents this field as up to five individuals or one or more Google Groups that can view and install the Chat app.
- Logging: enable error logging if the Console offers it.
- Do not initiate or validate direct messages; direct-message testing is out of scope until the SDK has explicit DM guardrails.
- Use named test spaces for all smoke tests.

Configuration page:

https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=example-chat-project

Observed Cloud Console state on 2026-06-30:

- Active Console account: a personal Google account rather than a Workspace account.
- Project ID: `example-chat-project`; no organization parent is visible to `gcloud`.
- App status: live.
- Current saved app name observed in Console: `Google Chat AI SDK`.
- Current saved HTTP endpoint URL observed in Console: `https://example-chat-project-dev-webhook-123456789012.us-central1.run.app/api/chat/events`.
- `Build this Chat app as a Workspace add-on` was checked and disabled.
- Console service account email: `service-123456789012@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`.
- `Join spaces and group conversations` was unchecked and disabled because the app is being configured from a personal Google account context.
- Visibility was restricted to the active personal Google account and disabled.

Before this configuration was saved, `pnpm chat:app-auth-smoke` returned:

```text
Google Chat app not found. To create a Chat app, you must turn on the Chat API and configure the app in the Google Cloud console.
```

Automatability evidence checked on 2026-06-30:

- The live Google Chat discovery document revision `20260623` exposes 50 resource methods and no app-configuration methods.
- `gcloud workspace-add-ons` manages Workspace Add-on deployments, not the Chat API app Configuration page.
- Google's setup docs route Chat app configuration through the Google Cloud Console Configuration page.
- Read-only probes against plausible public Chat app configuration endpoints such as `https://chat.googleapis.com/v1/bots`, `https://chat.googleapis.com/v1/projects/example-chat-project/bots`, and `https://chat.googleapis.com/v1/projects/123456789012/apps` returned endpoint-level `404` responses, not a usable configuration resource or permission challenge.

## Workspace Marketplace, User Install, And OAuth Gate

The default SDK path is a user-installed Chat app with per-user OAuth. Do not
use domain-wide delegation for ordinary chatbot testing. Creating spaces with
the app-auth scope `https://www.googleapis.com/auth/chat.app.spaces.create` is a
diagnostic/enterprise lane and requires more than enabling the Chat API:

- Google Chat API configuration prerequisites now state that Workspace apps require a Google Workspace Business or Enterprise account, while personal Google accounts can only build Chat apps for personal use.
- The Marketplace SDK requires configuring OAuth consent, app visibility, installation settings, and scopes in the Google Cloud Console.
- Private Marketplace visibility is only available when the app is built with a Google Workspace account. Apps built from a consumer `@gmail.com` account can only publish publicly.
- Chat app authorization for `chat.app.*` scopes requires one-time Google Workspace administrator approval. Google labels these Chat app authorization privileges as developer preview.
- The Admin console must allow users to install Chat apps at the top organizational unit before app installation/authorization can succeed.

Historical app-auth blocker:

```text
pnpm chat:app-auth-smoke -- --create-test-space
status: 500
message: Internal error encountered.
customer: customers/my_customer
displayName: Google Chat AI SDK Smoke 2026-06-30
```

No DM was sent, no real user was invited, no existing user/team space was touched, and no test space was created.

Retest on 2026-07-01 in the private live test tenant's Workspace project produced
`403 PERMISSION_DENIED` because Workspace admin app-auth authorization for
`chat.app.spaces.create` was not granted. No smoke metadata file was written.

To unblock the user-installed path:

1. Open or create the Cloud project from a Google Workspace admin/developer account, ideally under that Workspace organization's resource hierarchy rather than `organizationId=0`.
2. In the Chat API Configuration page, set app name `Google Chat AI SDK Dev`, endpoint `https://example-chat-project-dev-webhook-123456789012.us-central1.run.app/api/chat/events`, and enable `Join spaces and group conversations`.
3. Configure an OAuth client for local user-auth smoke testing and store the
   downloaded client JSON outside the repo.
4. In the Workspace Marketplace SDK App Configuration page, use Private
   visibility, safe installation settings, and the Chat app integration.
5. In the Workspace Admin console, allow Chat app installation for the safe test
   user or group if the organization requires this approval.
6. Rerun `pnpm chat:user-auth-smoke -- --authorize --create-test-space`, then
   `pnpm chat:user-auth-smoke -- --create-test-space --metadata-output fixtures/live/chat-smoke-space.local.json`.
7. Open the returned Chat URL and add/install the Chat app into the smoke space
   before running bot-message live smoke.

Primary setup references:

- https://developers.google.com/workspace/chat/configure-chat-api
- https://developers.google.com/workspace/chat/authenticate-authorize-chat-user
- https://developers.google.com/workspace/chat/authenticate-authorize-chat-app
- https://developers.google.com/workspace/marketplace/enable-configure-sdk
- https://developers.google.com/workspace/marketplace/how-to-publish
- https://knowledge.workspace.google.com/admin/chat/allow-users-to-install-chat-apps
- https://knowledge.workspace.google.com/admin/chat/set-up-app-authorization-for-chat
- https://developers.google.com/workspace/chat/receive-respond-interactions
- https://developers.google.com/workspace/chat/quickstart/gcf-app

## Safety Rules

- Do not DM anyone during testing.
- Use named test spaces with clear names beginning `Google Chat AI SDK Smoke`.
- Do not invite real users into SDK test rooms until send/visibility guardrails are implemented.
- Keep service-account keys outside the repo.
- Prefer Cloud Run runtime identity over storing keys in deployed services.
