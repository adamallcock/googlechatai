---
title: Live Chat Smoke Harness
date: 2026-06-29
type: runbook
status: draft
---

# Live Chat Smoke Harness

This runbook covers the W7 live Google Chat smoke harness. The harness tests
bot-owned message create/edit/delete only after a safe test user has created a
dedicated smoke space and installed the Chat app into that space. The default
product path is user-installed and user-authorized; do not use domain-wide
delegation to make ordinary chatbot tests pass.

## Safety Contract

- Do not DM anyone.
- Do not invite users.
- Do not target existing team spaces.
- Use only a named space whose display name starts `Google Chat AI SDK Smoke`.
- Create or choose the smoke space with per-user OAuth, then add/install the
  Chat app into that smoke space.
- Keep `GOOGLE_CHAT_TEST_SPACE` in `spaces/...` resource-name form.
- Keep the real smoke-space metadata in `fixtures/live/chat-smoke-space.local.json`; this file is gitignored.
- Keep evidence under `fixtures/live/evidence/`; this directory is gitignored.

The runner refuses to run unless `RUN_LIVE_CHAT_SMOKE=1` is set. It also refuses non-`spaces/` targets and validates both local metadata and live `spaces.get` data before sending a message.

## Required Gates

W0 must be complete before a live write smoke:

```bash
set -a
source .env.local
set +a

pnpm chat:app-auth-smoke
pnpm chat:user-auth-smoke -- --dry-run --create-test-space
```

The configured Chat app must pass read-only app-auth smoke without sending
messages, and the installing test user must be able to authorize the user-auth
smoke helper. `.env.local` must include:

```bash
GOOGLE_CHAT_TEST_SPACE=spaces/...
GOOGLE_CHAT_SMOKE_METADATA=fixtures/live/chat-smoke-space.local.json
GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS=/absolute/path/to/oauth-client.json
GOOGLE_CHAT_USER_TOKEN_STORE=.tokens/google-chat-user-oauth-token.json
```

Do not set a `customer` field for user-auth `spaces.create`; Google Chat rejects
customer ids when authenticating with user credentials.

The `--create-test-space` user-auth path requests both `chat.spaces.readonly`
and `chat.spaces.create` so the same ignored local refresh token can create a
smoke space and then run read/list diagnostics. If a token predates this scope
bundle, re-run the authorize command.

## Smoke-Space Metadata

Copy the example and replace placeholders:

```bash
cp fixtures/live/chat-smoke-space.example.json fixtures/live/chat-smoke-space.local.json
```

After Chat app configuration and OAuth client setup are complete, create the
dedicated smoke space with user auth:

```bash
set -a
source .env.local
set +a

pnpm chat:user-auth-smoke -- --authorize --create-test-space

pnpm chat:user-auth-smoke -- \
  --create-test-space \
  --metadata-output fixtures/live/chat-smoke-space.local.json
```

If this succeeds, copy the returned `response.name` into `.env.local` as
`GOOGLE_CHAT_TEST_SPACE`, open the returned Chat URL, and add/install the
Google Chat AI SDK app into the smoke space.

The local file must keep:

```json
{
  "space": "spaces/...",
  "displayName": "Google Chat AI SDK Smoke ...",
  "spaceType": "SPACE",
  "safety": {
    "dedicatedSmokeSpace": true,
    "noDirectMessages": true,
    "noRealUsersInvited": true
  }
}
```

The runner requires the metadata `space` to match `GOOGLE_CHAT_TEST_SPACE`.

## Dry Run

Dry-run mode still requires the explicit guard and smoke-space metadata. It prints planned API calls without OAuth tokens or message bodies:

```bash
RUN_LIVE_CHAT_SMOKE=1 \
GOOGLE_CHAT_TEST_SPACE=spaces/EXAMPLE_SMOKE_SPACE \
GOOGLE_CHAT_SMOKE_METADATA=fixtures/live/chat-smoke-space.example.json \
GOOGLE_CHAT_SMOKE_RUN_ID=dry-run \
pnpm live:chat-smoke -- --dry-run
```

## Live Run

After W0 passes and the metadata points at the real dedicated smoke space:

```bash
set -a
source .env.local
set +a

RUN_LIVE_CHAT_SMOKE=1 pnpm live:chat-smoke
```

The runner performs:

- `spaces.list`
- `spaces.get` for the configured smoke space
- `spaces.messages.create`, `spaces.messages.patch`, and `spaces.messages.delete` in the configured smoke space
- with `--include-thread-replies`, one app-created smoke thread root, one
  reply, one reply patch, and reverse cleanup
- with `--thread-reply-count=<n>`, up to five replies in that app-created
  smoke thread; this flag implies `--include-thread-replies`
- with `--pause-before-cleanup-ms=<ms>`, a bounded post-write pause before
  cleanup, capped at 120 seconds for Chat UI inspection

It does not call membership APIs and does not invite users.
It does not create or delete spaces unless `--include-space-lifecycle` is
passed explicitly for a legacy app-auth diagnostic run.

## Visual QA Run

Use the visual smoke harness when you need to inspect what Google Chat actually
renders for app-auth text, Cards V2, thread replies, and edit-based streaming:

```bash
set -a
source .env.local
set +a

RUN_LIVE_CHAT_VISUAL_SMOKE=1 pnpm live:chat-visual-smoke
```

Add the AI component helpers to the same live visual pass when changing
feedback, sources, thinking, tool-status, or streaming-status cards:

```bash
RUN_LIVE_CHAT_VISUAL_SMOKE=1 pnpm live:chat-visual-smoke -- \
  --include-ai-card-components
```

Add the placeholder-response flow when changing agent response delivery,
streaming, reply metadata, or edit behavior:

```bash
RUN_LIVE_CHAT_VISUAL_SMOKE=1 pnpm live:chat-visual-smoke -- \
  --use-placeholder-response
```

To test admin-configured placeholder text, pass a JSON or CSV file. Start from
the tracked example and keep tenant/admin edits in the ignored local copy:

```bash
cp fixtures/live/placeholder-responses.example.json \
  fixtures/live/placeholder-responses.local.json
```

JSON object mode can include `texts`, `mode`, and `cursor`:

```bash
RUN_LIVE_CHAT_VISUAL_SMOKE=1 pnpm live:chat-visual-smoke -- \
  --use-placeholder-response \
  --placeholder-config fixtures/live/placeholder-responses.local.json
```

The runner performs:

- `spaces.get` for the configured smoke space
- `spaces.messages.create` for a plain text message
- `spaces.messages.create` for a Cards V2 message with header, icon, image, and
  open-link button
- with `--include-ai-card-components`, five extra Cards V2 messages generated
  by the SDK builders: feedback, sources, thinking, tool status, and streaming
  status
- `spaces.messages.create` for an app-created thread parent
- `spaces.messages.create` for a reply under that thread
- with `--use-placeholder-response`, `spaces.messages.create` for a short
  placeholder in that thread, then `spaces.messages.patch` for the final answer
  on the same message
- `spaces.messages.create` and three `spaces.messages.patch` calls for an
  edit-based streaming simulation

The visual runner intentionally leaves its messages in the smoke space so a
human or browser QA tool can inspect them in Chat. After inspection, clean up
from the evidence file:

```bash
RUN_LIVE_CHAT_VISUAL_SMOKE=1 \
pnpm live:chat-visual-smoke -- \
  --cleanup-from-evidence fixtures/live/evidence/<visual-evidence>.json
```

Cleanup mode validates the configured smoke space and deletes only message
resource names recorded in that evidence file under the configured
`GOOGLE_CHAT_TEST_SPACE`.

## Card Action And Dialog QA Run

Use the card-action smoke harness when you need to inspect Google Chat button
clicks, add-on action routing, `UpdateMessageAction`, dialog open, and dialog
submit behavior:

```bash
set -a
source .env.local
set +a

RUN_LIVE_CHAT_CARD_ACTION_SMOKE=1 pnpm live:chat-card-action-smoke
```

To add hidden encoded state to the card buttons, use:

```bash
RUN_LIVE_CHAT_CARD_ACTION_SMOKE=1 \
pnpm live:chat-card-action-smoke -- \
  --include-state
```

The runner performs:

- `spaces.get` for the configured smoke space
- `spaces.messages.create` for one Cards V2 message with `Mark received`,
  `Open dialog`, and `Open navigation` buttons

The runner intentionally leaves the card in the smoke space so a human or
browser QA tool can click through the actions. Expected manual checks:

- Click `Mark received`; the card should update in place to an updated state.
  With `--include-state`, the updated card should acknowledge decoded state.
- Click `Open dialog`; a `Google Chat AI SDK Dialog Smoke` dialog should open.
- Click `Open navigation`; a `Google Chat AI SDK Navigation Smoke` pushed card
  should open with an `Update top card` button.
- Click `Update top card`; the pushed card should update in place to
  `Google Chat AI SDK Navigation Update Smoke`.
- Enter a non-sensitive smoke note and click `Submit dialog`; the dialog should
  close and the app should send a visible confirmation message.

After inspection, clean up from the evidence file:

```bash
RUN_LIVE_CHAT_CARD_ACTION_SMOKE=1 \
pnpm live:chat-card-action-smoke -- \
  --cleanup-from-evidence fixtures/live/evidence/<card-action-evidence>.json
```

Cleanup mode validates the configured smoke space and deletes only message
resource names recorded in that evidence file under the configured
`GOOGLE_CHAT_TEST_SPACE`. Messages created by interaction responses, such as a
dialog-submit confirmation, are not currently recorded in the evidence file;
clean those up later with an explicit user-auth read/delete helper rather than
broad bot-auth history reads.

For a direct deployed-webhook state smoke that sends no Chat messages and DMs no
users, use:

```bash
RUN_LIVE_CHAT_CARD_ACTION_WEBHOOK_SMOKE=1 \
pnpm live:chat-card-action-webhook-smoke -- \
  --variant=stateful_mark_received

RUN_LIVE_CHAT_LOG_SMOKE=1 \
pnpm live:chat-log-smoke -- \
  --since=<start> \
  --until=<end> \
  --expect-events=1 \
  --expect-http-posts=1 \
  --expect-event-type=CARD_CLICKED \
  --expect-action-method=googlechatai_sdk_card_mark_received \
  --expect-card-action-state
```

The evidence stores only status, hashes, lengths, parameter keys, and decoded
state shape. It must not store raw action state, raw payloads, form values,
webhook URLs, tokens, or Chat text.

For a direct deployed-webhook card-navigation smoke that sends no Chat messages
and DMs no users, use `card_navigation_next` for a `pushCard` response or
`card_navigation_update` for an `updateCard` response:

```bash
RUN_LIVE_CHAT_CARD_ACTION_WEBHOOK_SMOKE=1 \
pnpm live:chat-card-action-webhook-smoke -- \
  --variant=card_navigation_next

RUN_LIVE_CHAT_LOG_SMOKE=1 \
pnpm live:chat-log-smoke -- \
  --since=<start> \
  --until=<end> \
  --expect-events=1 \
  --expect-http-posts=1 \
  --expect-event-type=CARD_CLICKED \
  --expect-action-method=googlechatai_sdk_card_navigation_next
```

For the `updateCard` variant, switch the variant and action assertion:

```bash
RUN_LIVE_CHAT_CARD_ACTION_WEBHOOK_SMOKE=1 \
pnpm live:chat-card-action-webhook-smoke -- \
  --variant=card_navigation_update

RUN_LIVE_CHAT_LOG_SMOKE=1 \
pnpm live:chat-log-smoke -- \
  --since=<start> \
  --until=<end> \
  --expect-events=1 \
  --expect-http-posts=1 \
  --expect-event-type=CARD_CLICKED \
  --expect-action-method=googlechatai_sdk_card_navigation_update
```

The direct webhook evidence stores only status, response shape, hashes, and
assertion booleans. It must not store raw payloads, form values, webhook URLs,
tokens, or Chat text.

For a real Chat UI card-navigation click, create a stateful card, click
`Open navigation` in Chrome or another approved browser surface, then assert the
real UI event type:

```bash
RUN_LIVE_CHAT_CARD_ACTION_SMOKE=1 \
pnpm live:chat-card-action-smoke -- \
  --include-state

RUN_LIVE_CHAT_LOG_SMOKE=1 \
pnpm live:chat-log-smoke -- \
  --since=<start> \
  --until=<end> \
  --expect-events=1 \
  --expect-http-posts=1 \
  --expect-event-type=button_clicked \
  --expect-action-method=googlechatai_sdk_card_navigation_next \
  --expect-card-action-state
```

Synthetic direct webhook fixtures use `CARD_CLICKED`; real Chat UI button
deliveries can arrive as `button_clicked`. Use action method, state, HTTP status,
and duplicate counts as the stable cross-shape assertions.

## Context And History Read QA Run

Use the context-read smoke harness when you need to verify real
`spaces.messages.list` behavior and SDK AI-context rendering for the dedicated
smoke room. This path is read-only and uses per-user OAuth. Do not use
domain-wide delegation for ordinary chatbot tests.

Authorize the local ignored user token for message reads:

```bash
set -a
source .env.local
set +a

pnpm chat:user-auth-smoke -- --authorize --read-messages
```

Then run the read-only smoke:

```bash
RUN_LIVE_CHAT_CONTEXT_READ_SMOKE=1 \
pnpm live:chat-context-read-smoke -- \
  --limit=6 \
  --page-size=3 \
  --expect-text='<synthetic run id or expected phrase>'
```

To exercise model-context budgeting, add the budget flags. The SDK uses a
deterministic chars-per-token estimator, subtracts reserved output tokens,
omits messages that do not fit the available budget, marks the context as
partial/truncated, and emits an AI-facing system note that says how many
messages were omitted:

```bash
RUN_LIVE_CHAT_CONTEXT_READ_SMOKE=1 \
pnpm live:chat-context-read-smoke -- \
  --limit=8 \
  --page-size=4 \
  --order=desc \
  --max-context-tokens=220 \
  --reserve-output-tokens=40 \
  --chars-per-token=4 \
  --expect-budget-truncation
```

The runner performs:

- `spaces.messages.list` with `createTime` filters, `orderBy`, pagination, and
  `showDeleted`.
- A second `spaces.messages.list` call with a `thread.name` filter when a
  thread is available in the first page set.
- SDK context rendering through the built Node helpers.
- Optional model-token budget trimming when `--max-context-tokens` is supplied.

Evidence is written to
`fixtures/live/evidence/chat-context-read-smoke-<runId>.json`. It records API
status, pagination, deleted-message counts, attachment/card metadata counts,
sender identity availability, timestamps, system-note categories, model-token
budget summaries when enabled, and hashed expected-text assertions. It does not
save raw message text, raw form values, access tokens, sender emails, attachment
bytes, or file bodies.

The expected Chat UI result for this smoke is no visible new message. Use
Chrome or a manual browser check to confirm the smoke room did not receive a new
bot reply, then check Cloud Logging for no `/api/chat/events` deliveries and no
Cloud Run errors during the read window.

## User Read-State And Notification QA Run

Use the user-state smoke harness when you need to verify installed-user access
to Chat read-state and space notification settings. This path is read-only,
uses per-user OAuth, and should only target the dedicated smoke room. Do not use
domain-wide delegation for this path.

Authorize the local ignored user token for the required scopes:

```bash
set -a
source .env.local
set +a

pnpm chat:user-auth-smoke -- \
  --authorize \
  --read-state \
  --read-space-settings
```

When refreshing a long-lived local smoke token, prefer requesting the full smoke
scope bundle in one consent pass so later message, reaction, membership, Drive,
and custom-emoji smokes keep working from the same token store:

```bash
pnpm chat:user-auth-smoke -- \
  --authorize \
  --create-test-space \
  --read-messages \
  --write-messages \
  --read-reactions \
  --write-reactions \
  --read-memberships \
  --read-custom-emojis \
  --read-state \
  --write-state \
  --read-space-settings \
  --read-drive \
  --write-drive
```

Then run the read-only state smoke:

```bash
RUN_LIVE_CHAT_USER_STATE_SMOKE=1 \
pnpm live:chat-user-state-smoke -- --allow-blocked
```

To exercise thread read-state too, pass a thread resource that belongs to the
same smoke space:

```bash
RUN_LIVE_CHAT_USER_STATE_SMOKE=1 \
pnpm live:chat-user-state-smoke -- \
  --allow-blocked \
  --thread=spaces/<space>/threads/<thread>
```

The runner performs:

- `users.spaces.getSpaceReadState`.
- `users.spaces.spaceNotificationSetting.get`, which Google currently documents
  as a Developer Preview surface.
- `users.spaces.threads.getThreadReadState` when `--thread` is supplied.

Evidence is written to
`fixtures/live/evidence/chat-user-state-smoke-<runId>.json`. It records API
status, auth principal, scopes, retry/token-refresh metadata, response key
names, read-time availability, notification/mute enum values, and resource-name
hashes. It does not save raw space names, thread names, message names, message
text, token material, user emails, or notification resource names.

The expected Chat UI result for this smoke is no visible new message. Pair it
with `live:chat-log-smoke -- --expect-events=0 --expect-http-posts=0` for the
same timestamp window to confirm no webhook delivery or Cloud Run error
occurred.

To exercise the user-side notification mutation path, use the same dedicated
smoke space and add the separate write gate:

```bash
RUN_LIVE_CHAT_USER_STATE_SMOKE=1 \
GOOGLE_CHAT_AI_ENABLE_LIVE_USER_SETTINGS_WRITE=1 \
pnpm live:chat-user-state-smoke -- \
  --allow-blocked \
  --exercise-notification-patch
```

This performs `users.spaces.spaceNotificationSetting.get`, patches
`notificationSetting` to a different supported enum value, patches it back to
the original enum value, then reads it again to verify restoration. It does not
change `muteSetting`. The write is intentionally limited to the configured
dedicated smoke space and remains unavailable without
`GOOGLE_CHAT_AI_ENABLE_LIVE_USER_SETTINGS_WRITE=1`.

The evidence records only enum values, response key names, retry/token-refresh
metadata, and resource-name hashes. The expected Chat UI result is still no new
message; pair the run with `live:chat-log-smoke -- --expect-events=0
--expect-http-posts=0`.

To exercise `users.spaces.updateSpaceReadState`, grant the broader read-state
scope with `--write-state`, then use the separate read-state write gate:

```bash
RUN_LIVE_CHAT_USER_STATE_SMOKE=1 \
GOOGLE_CHAT_AI_ENABLE_LIVE_USER_READ_STATE_WRITE=1 \
pnpm live:chat-user-state-smoke -- \
  --allow-blocked \
  --exercise-space-read-state-update
```

This is intentionally an idempotent smoke: it reads the current space
`lastReadTime`, sends a `PATCH updateMask=lastReadTime` with that same value,
then reads again and verifies the final timestamp hash matches the original.
Evidence saves timestamp hashes and availability flags, not raw read-state
timestamps. The expected Chat UI result is no new message and no deliberate
unread-state change.

## User Sections And Navigation QA Run

Use the sections smoke harness when you need to verify installed-user access to
the Google Chat sidebar/navigation organization APIs. The default path is
read-only, uses per-user OAuth, and filters section items to the dedicated smoke
room so it does not enumerate unrelated private spaces. Optional mutation checks
must use the separate sections write scope and explicit write gate. Do not use
domain-wide delegation for this path.

Authorize the local ignored user token for the required scope:

```bash
set -a
source .env.local
set +a

pnpm chat:user-auth-smoke -- --authorize --read-sections
```

When refreshing the long-lived local smoke token, add `--read-sections` to the
full smoke scope bundle described above.

Then run the read-only sections smoke:

```bash
RUN_LIVE_CHAT_SECTIONS_SMOKE=1 \
pnpm live:chat-sections-smoke -- \
  --allow-blocked \
  --expect-smoke-space-item
```

The runner performs:

- `users.sections.list` for `users/me`.
- `users.sections.items.list` through the wildcard section parent, filtered to
  `space = <GOOGLE_CHAT_TEST_SPACE>`.

Both read operations follow `nextPageToken` up to `--max-pages` (default 10,
maximum 20). To force a pagination proof in the private live test tenant's
smoke account, use a small page size:

```bash
RUN_LIVE_CHAT_SECTIONS_SMOKE=1 \
pnpm live:chat-sections-smoke -- \
  --allow-blocked \
  --page-size=2 \
  --max-pages=3 \
  --expect-smoke-space-item
```

To exercise reversible sidebar mutations, re-consent the installed user token
for the write scope and set the separate mutation gate:

```bash
set -a
source .env.local
set +a

pnpm chat:user-auth-smoke -- --authorize \
  --create-test-space \
  --read-messages \
  --write-messages \
  --read-reactions \
  --write-reactions \
  --read-memberships \
  --read-custom-emojis \
  --read-state \
  --write-state \
  --read-space-settings \
  --read-sections \
  --write-sections \
  --read-drive \
  --write-drive

RUN_LIVE_CHAT_SECTIONS_SMOKE=1 \
GOOGLE_CHAT_AI_ENABLE_LIVE_SECTIONS_WRITE=1 \
pnpm live:chat-sections-smoke -- \
  --allow-blocked \
  --exercise-section-mutations \
  --expect-smoke-space-item
```

The mutation path performs:

- `users.sections.create` for a temporary `CUSTOM_SECTION`.
- `users.sections.patch` to rename that temporary section.
- `users.sections.position` to move it to the end of the sidebar.
- `users.sections.items.move` to move only the dedicated smoke-space item into
  the temporary section.
- `users.sections.items.move` again to restore the smoke-space item to its
  original section.
- `users.sections.delete` to remove the temporary section.

Success requires the temporary section to be deleted and the smoke-space item to
list back under the original section hash. Evidence records only hashes, enums,
operation metadata, response keys, and retry/token-refresh metadata; it does not
save raw section names, temporary display names, section item names, or unrelated
space names.

Evidence is written to
`fixtures/live/evidence/chat-sections-smoke-<runId>.json`. It records API
status, auth principal, scopes, retry/token-refresh metadata, section type
counts, default/custom section signals, filtered item counts, smoke-space item
matches, and hashes for section/item/space resource names. It does not save raw
section names, custom section display names, unrelated space names, message
text, token material, or user emails.

The expected Chat UI result for this smoke is no visible new message. For the
mutation path, the smoke room should return to the normal Spaces section and no
temporary custom section should remain visible. Pair it with
`live:chat-log-smoke -- --expect-events=0 --expect-http-posts=0` for the same
timestamp window to confirm no webhook delivery or Cloud Run error occurred.

## Uploaded Media Upload And Download QA Run

Use the uploaded-media smoke harness when the Chat media-download proof should
not depend on old manual UI attachments. This guarded path creates one tiny
synthetic text attachment with user auth, attaches it to one user-auth message
in the dedicated smoke space, confirms the fresh message is discoverable, then
downloads the same attachment with `media.download` and checks the byte hash.

This follows Google's current Chat media flow: call `media.upload` for the
space, then pass the returned attachment data to `spaces.messages.create`.

Authorize the local ignored user token for message reads and user-auth message
creates:

```bash
set -a
source .env.local
set +a

pnpm chat:user-auth-smoke -- \
  --authorize \
  --read-messages \
  --write-messages
```

Dry-run mode prints the planned upload, message create, discovery, and download
calls without uploading or sending a message:

```bash
RUN_LIVE_CHAT_UPLOADED_MEDIA_SMOKE=1 \
pnpm live:chat-uploaded-media-smoke -- --dry-run
```

After confirming `GOOGLE_CHAT_TEST_SPACE` and
`GOOGLE_CHAT_SMOKE_METADATA` point at the dedicated smoke space, run the live
proof with all write/download gates:

```bash
GOOGLE_CHAT_AI_W7_MEDIA_READY=1 \
GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA=1 \
GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA_UPLOAD=1 \
RUN_LIVE_CHAT_UPLOADED_MEDIA_SMOKE=1 \
pnpm live:chat-uploaded-media-smoke
```

The runner performs:

- SDK upload-plan policy checks against the generated synthetic file.
- `media.upload` to `upload/v1/{space}/attachments:upload`.
- `spaces.messages.create` with one attachment in the dedicated smoke space.
- `spaces.messages.list` over the run window to prove the fresh attachment is
  discoverable without relying on historical filenames.
- `media.download`, parser-hook extraction, attachment context rendering, and
  upload/download SHA-256 parity checks.

Evidence is written to
`fixtures/live/evidence/chat-uploaded-media-smoke-<runId>.json`. It records
operation status, token refresh/replay metadata, byte counts, SHA-256 digests,
context-part hashes, attachment metadata availability, and safety assertions.
It does not save raw message text, raw attachment bytes, raw extracted text,
raw filenames, upload tokens, access tokens, sender emails, or file bodies.

The expected Chat UI result is one visible synthetic user-auth smoke message
with one tiny text attachment in the dedicated smoke space. It does not DM
anyone, invite users, touch existing team/user spaces, or clean up older smoke
messages.

## Attachment Media Download QA Run

Use the media-download smoke harness when you need to verify real Chat uploaded
media bytes and SDK attachment parsing. This path is read-only from Chat's
perspective, but it does download file bytes locally, so live bytes require
three explicit gates:

```bash
RUN_LIVE_CHAT_MEDIA_DOWNLOAD_SMOKE=1
GOOGLE_CHAT_AI_W7_MEDIA_READY=1
GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA=1
```

Dry-run mode plans discovery and download without downloading bytes:

```bash
set -a
source .env.local
set +a

RUN_LIVE_CHAT_MEDIA_DOWNLOAD_SMOKE=1 \
pnpm live:chat-media-download-smoke -- \
  --dry-run \
  --limit=8 \
  --page-size=4
```

After confirming the target attachment is synthetic/safe, run the live download
with a content type, optional filename filter, and optional expected byte hash:

```bash
GOOGLE_CHAT_AI_W7_MEDIA_READY=1 \
GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA=1 \
RUN_LIVE_CHAT_MEDIA_DOWNLOAD_SMOKE=1 \
pnpm live:chat-media-download-smoke -- \
  --limit=8 \
  --page-size=4 \
  --content-type=text/plain \
  --filename-contains='<synthetic filename>' \
  --expect-sha256='<expected byte digest>'
```

The runner performs:

- `spaces.messages.list` with `createTime` filters, pagination, and
  `showDeleted` to discover a matching attachment.
- SDK attachment normalization and download-plan policy checks.
- `media.download` through `/v1/media/{attachmentDataRef.resourceName}?alt=media`.
- SDK parser-hook extraction for text/JSON attachments.
- SDK attachment context rendering.

Evidence is written to
`fixtures/live/evidence/chat-media-download-smoke-<runId>.json`. It records
HTTP status, byte count, byte SHA-256, parser status, context-part hashes,
policy/gate status, and attachment metadata availability. It does not save raw
message text, raw attachment bytes, raw extracted text, access tokens, sender
emails, or file bodies.

The expected Chat UI result for this smoke is no visible new message. Use
Chrome or a manual browser check to confirm the smoke room did not receive a new
bot reply, then check Cloud Logging for no `/api/chat/events` deliveries and no
Cloud Run errors during the download window.

## Redacted Inbound Event Logs

The Cloud Run development webhook emits one structured stdout log for each Chat
event it receives:

```json
{
  "event": "chat_event_received",
  "eventType": "message",
  "messageName": "spaces/.../messages/...",
  "eventDebugSummary": {}
}
```

`eventDebugSummary` is designed for live parser QA. It records event kind,
event time, space/thread/message resource names, sender availability, email
domain, text length/hash, annotation counts, attachment metadata, quote depth,
and card/action/form keys when present. It does not log raw message bodies,
raw form values, attachment bytes, OAuth tokens, private keys, or file contents
by default.

Query stdout logs after manual browser smokes:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="chat-ai-sdk-dev-webhook" AND logName="projects/'"$GOOGLE_CLOUD_PROJECT"'/logs/run.googleapis.com%2Fstdout" AND jsonPayload.event="chat_event_received" AND timestamp>="YYYY-MM-DDTHH:MM:SSZ"' \
  --project "$GOOGLE_CLOUD_PROJECT" \
  --limit=20 \
  --format=json
```

For mention tests, type `@`, choose `GoogleChatAISDK` from the autocomplete,
then send a run id. Raw `@GoogleChatAISDK` text does not create a mention object
and does not trigger the app.

## Cloud Logging Assertion QA Run

Use the log-smoke helper after manual Chat UI actions when you need repeatable
Cloud Run and event-shape assertions instead of ad hoc `gcloud logging read`
commands:

```bash
set -a
source .env.local
set +a

RUN_LIVE_CHAT_LOG_SMOKE=1 \
pnpm live:chat-log-smoke -- \
  --since='<timestamp before manual Chat action>' \
  --expect-events=1 \
  --expect-http-posts=1 \
  --expect-event-type=message \
  --expect-mention-count=1 \
  --expect-attachment-count=0
```

The runner performs three Cloud Logging reads for the configured Cloud Run
service:

- Cloud Run entries with `severity>=ERROR`.
- Structured stdout logs where `jsonPayload.event` is
  `chat_event_received`.
- HTTP request logs whose URL contains `/api/chat/events`.

Evidence is written to
`fixtures/live/evidence/chat-log-smoke-<runId>.json`. It records counts,
assertions, HTTP status, revision, event type, action method, annotation and
attachment counts, hashes for message names/text summaries, and redaction
flags. It does not save raw log entries, raw message text, raw form values,
OAuth tokens, sender emails, or attachment bytes.

For manual mention tests, capture the timestamp immediately before clicking
Send in Chat. The latest verified live command was:

```bash
GOOGLE_CHAT_LOG_SMOKE_RUN_ID=log-smoke-log-inbound-20260701T203334Z \
RUN_LIVE_CHAT_LOG_SMOKE=1 \
pnpm live:chat-log-smoke -- \
  --since=2026-07-01T20:37:58Z \
  --expect-events=1 \
  --expect-http-posts=1 \
  --expect-event-type=message \
  --expect-mention-count=1 \
  --expect-attachment-count=0
```

Observed result: one HTTP 200 POST to `/api/chat/events`, one
`chat_event_received` stdout log, zero Cloud Run errors, event type `message`,
mention count 1, attachment count 0, and redacted evidence only.

## Inbound Mention Wrapper QA Run

Use the inbound wrapper when you need a repeatable manual mention smoke with a
run id, polling, and the standard Cloud Logging assertions:

```bash
set -a
source .env.local
set +a

RUN_LIVE_CHAT_INBOUND_SMOKE=1 \
pnpm live:chat-inbound-smoke -- \
  --run-id='<manual run id>' \
  --since='<timestamp before manual Chat action>' \
  --wait-seconds=30 \
  --poll-interval-ms=3000
```

The helper does not send Chat messages. It records the manual instruction, then
polls the same redacted log-smoke checks until it observes exactly one
`chat_event_received` event and one successful `/api/chat/events` POST, or
until the timeout expires.

For the standard mention path, the default expectations are:

- Event type `message`.
- One user mention annotation.
- Zero attachments.
- One HTTP POST.
- Zero Cloud Run errors.

For manual attachment, Drive-picker, quote/reply, or card-action variants, the
wrapper can also forward these richer log-smoke assertions:

- `--expect-attachment-count=<n>`
- `--expect-attachment-data-ref-count=<n>`
- `--expect-drive-attachment-count=<n>`
- `--expect-quoted-message`
- `--expect-quote-depth=<n>`
- `--expect-event-identity`
- `--expect-action-method=<methodName>`

Dry-run those variants first; the helper prints the manual Chat instruction and
the exact Cloud Logging plan without sending a message.

The latest verified live command was:

```bash
RUN_LIVE_CHAT_INBOUND_SMOKE=1 \
pnpm live:chat-inbound-smoke -- \
  --run-id=inbound-wrapper-20260701T204535Z \
  --since=2026-07-01T20:45:47Z \
  --wait-seconds=30 \
  --poll-interval-ms=3000
```

Observed result: one successful polling attempt, one HTTP 200 POST, one
`chat_event_received` stdout log on revision
`chat-ai-sdk-dev-webhook-00006-p49`, zero Cloud Run errors, event type
`message`, mention count 1, attachment count 0, and redacted wrapper evidence
only.

## SpaceEvents And Reaction QA Run

Use the SpaceEvents harness for read-only event-history probes that are not
ordinary Chat app interaction webhooks, such as message reactions:

```bash
set -a
source .env.local
set +a

corepack pnpm chat:user-auth-smoke -- \
  --authorize \
  --read-messages \
  --read-reactions \
  --read-memberships

RUN_LIVE_CHAT_SPACE_EVENTS_SMOKE=1 \
corepack pnpm live:chat-space-events-smoke -- \
  --dry-run \
  --event-type=google.workspace.chat.reaction.v1.created
```

The harness requires the same dedicated smoke-space metadata as the other live
tools. It plans `spaces.spaceEvents.list` with user auth, records required
scopes, paginates, and writes redacted evidence that omits raw message text,
sender emails, access tokens, and raw resource names.

Current private live test tenant result on 2026-07-01: after the user token was upgraded
with reaction and membership read scopes, `spaces.spaceEvents.list` reached
Google but returned HTTP 500 `INTERNAL` for both the default message/reaction
filter and a minimal `google.workspace.chat.message.v1.created` filter.
Blocked run `space-events-blocked-20260701T2120Z` saved redacted failure
evidence at
`fixtures/live/evidence/chat-space-events-smoke-space-events-blocked-20260701T2120Z.json`.
Treat SpaceEvents as blocked in this project until a retry/backoff probe or a
Workspace Events subscription proves the surface.

Reaction handling itself is still verified through the Chat UI plus
`spaces.messages.list`: add a quick reaction to a smoke-room message, capture a
screenshot, then run:

```bash
RUN_LIVE_CHAT_CONTEXT_READ_SMOKE=1 \
GOOGLE_CHAT_CONTEXT_READ_SMOKE_RUN_ID=context-reaction-<timestamp> \
corepack pnpm live:chat-context-read-smoke -- \
  --start-time='<timestamp before reaction target message>' \
  --end-time='<timestamp after reaction>' \
  --expect-text='<nearby synthetic run id>'

RUN_LIVE_CHAT_LOG_SMOKE=1 \
corepack pnpm live:chat-log-smoke -- \
  --since='<timestamp before reaction>' \
  --expect-events=0 \
  --expect-http-posts=0
```

Latest verified reaction run: Chrome added a thumbs-up reaction to the app
reply for `audio-attach-20260701T2100Z`; screenshot
`fixtures/live/evidence/chat-ui-reaction-reaction-ui-20260701T2119Z.png`
showed reaction count `1`. Context run `context-reaction-20260701T2119Z`
returned HTTP 200 for both space and thread reads and reported
`hasReactionNote: true` on the reacted app message. Cloud Run had zero errors
and zero `/api/chat/events` posts during the reaction window.

## Evidence

Live evidence is written to `fixtures/live/evidence/chat-smoke-<runId>.json` unless `--evidence <path>` is supplied. Evidence records operation names, timestamps, status, resource names, display names, and cleanup outcomes. It intentionally does not save message request text, edited text, OAuth tokens, service-account JSON, private keys, or access tokens.

## Cleanup

Normal runs clean up in `finally`:

- Any message created by the runner is deleted with `spaces.messages.delete`.
- Any transient lifecycle space created by the runner is deleted with `spaces.delete`.

If a process is interrupted, inspect the evidence JSON for a successful create operation that lacks a matching delete operation. Then run one cleanup command per leftover resource:

```bash
set -a
source .env.local
set +a

RUN_LIVE_CHAT_SMOKE=1 \
pnpm live:chat-smoke -- --cleanup-resource 'spaces/.../messages/...'
```

For a leftover transient lifecycle space:

```bash
RUN_LIVE_CHAT_SMOKE=1 \
pnpm live:chat-smoke -- --cleanup-resource 'spaces/...'
```

Cleanup mode first validates the configured smoke space. For space deletion, it also fetches the cleanup target and refuses to delete unless the display name starts `Google Chat AI SDK Smoke W7 Lifecycle`.

## Current Live Status

If this worktree lacks `.env.local`, a real `GOOGLE_CHAT_TEST_SPACE`, or `fixtures/live/chat-smoke-space.local.json`, run only the dry-run command and record that W0/live credentials are not present in this worktree.

As of 2026-07-01 in the private live test tenant's Cloud project
`example-chat-project`:

- App-auth list passed and saw the dedicated smoke space.
- User-auth list passed without domain-wide delegation.
- `RUN_LIVE_CHAT_SMOKE=1 pnpm live:chat-smoke` passed in
  `spaces/EXAMPLE_SMOKE_SPACE`, creating, patching, and deleting one app-owned message.
- `RUN_LIVE_CHAT_VISUAL_SMOKE=1 pnpm live:chat-visual-smoke` passed in
  `spaces/EXAMPLE_SMOKE_SPACE`, and the resulting text, Cards V2, thread, and edited
  stream messages were visually inspected in Chat before cleanup.
- Revision `chat-ai-sdk-dev-webhook-00004-hvc` emitted redacted
  `eventDebugSummary` logs for real mention and attachment events. The
  attachment smoke verified metadata for synthetic
  `chat-attachment-smoke-20260701T193936674Z.txt` without logging file
  contents.
- Revision `chat-ai-sdk-dev-webhook-00006-p49` handled the live card-action
  smoke: one `Mark received` update, one dialog open, and one dialog submit all
  returned HTTP 200 and logged action names/form keys without raw form values.
- `RUN_LIVE_CHAT_CONTEXT_READ_SMOKE=1 pnpm live:chat-context-read-smoke`
  passed in `spaces/EXAMPLE_SMOKE_SPACE` with run
  `context-read-20260701T201516761Z-df7307`. It used user auth with
  `chat.messages.readonly`, read six recent messages over two pages, exercised a
  thread filter, confirmed deleted-message and attachment metadata, saved only
  redacted evidence, and produced no Cloud Run errors or `/api/chat/events`
  deliveries during the read-only window.
- `GOOGLE_CHAT_AI_W7_MEDIA_READY=1 GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA=1 RUN_LIVE_CHAT_MEDIA_DOWNLOAD_SMOKE=1 pnpm live:chat-media-download-smoke`
  passed in `spaces/EXAMPLE_SMOKE_SPACE` with run
  `media-download-20260701T202551141Z-7aec80`. It discovered the prior
  synthetic text attachment, downloaded 86 bytes through `media.download`,
  matched SHA-256
  `756861171203b171a9a3c7c0e5d7653068d0fb455a78d8c06bcb4002425dba70`, parsed
  the file through the SDK text parser hook, rendered attachment context parts,
  saved only hashes/status, and produced no Cloud Run errors or
  `/api/chat/events` deliveries during the read-only media window.
- `GOOGLE_CHAT_LOG_SMOKE_RUN_ID=log-smoke-log-inbound-20260701T203334Z RUN_LIVE_CHAT_LOG_SMOKE=1 pnpm live:chat-log-smoke`
  passed for a fresh manual mention sent at `2026-07-01T20:37:58Z`. It found
  exactly one `/api/chat/events` HTTP POST with status 200, exactly one
  `chat_event_received` stdout log on revision
  `chat-ai-sdk-dev-webhook-00006-p49`, zero Cloud Run errors, event type
  `message`, mention count 1, attachment count 0, and saved only redacted log
  evidence.
- `RUN_LIVE_CHAT_INBOUND_SMOKE=1 pnpm live:chat-inbound-smoke` passed with run
  `inbound-wrapper-20260701T204535Z` after a fresh manual mention. It wrapped
  the same log-smoke checks, passed on the first polling attempt, and saved
  redacted wrapper evidence plus the manual-action instruction.
- A synthetic PNG attachment smoke passed with run
  `image-attach-20260701T2050Z`. Chat UI showed the generated image thumbnail,
  one app reply, and a real app mention. The inbound wrapper verified one
  `image/png` attachment, one media resource, one HTTP 200 webhook POST, one
  `chat_event_received` stdout log, mention count 1, and zero Cloud Run
  errors.
- `GOOGLE_CHAT_AI_W7_MEDIA_READY=1 GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA=1 RUN_LIVE_CHAT_MEDIA_DOWNLOAD_SMOKE=1 pnpm live:chat-media-download-smoke`
  then downloaded that image with run
  `media-download-20260701T205210445Z-741741`. It matched the original
  7,507-byte SHA-256
  `89f559f8dbfedd5b442947dd1837bbfb681c6c08e6a2b33ea790a3fcc3e210c3`,
  classified the attachment as `image`, rendered metadata context parts, and
  correctly marked extraction `skipped` because no image parser is registered.
- A follow-up `live:chat-log-smoke` read-only sweep from
  `2026-07-01T20:52:10Z` found zero Cloud Run errors and zero Chat webhook
  events during the image media-download window.
- A synthetic PDF attachment smoke passed with run
  `pdf-attach-20260701T2055Z`. Chat UI showed the generated PDF preview card,
  filename, one app reply, and a real app mention. The inbound wrapper verified
  one `application/pdf` attachment, one media resource, one HTTP 200 webhook
  POST, one `chat_event_received` stdout log, mention count 1, and zero Cloud
  Run errors.
- `GOOGLE_CHAT_AI_W7_MEDIA_READY=1 GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA=1 RUN_LIVE_CHAT_MEDIA_DOWNLOAD_SMOKE=1 pnpm live:chat-media-download-smoke`
  then downloaded that PDF with run
  `media-download-20260701T205656684Z-6ff4b9`. It matched the original
  670-byte SHA-256
  `03c8d413022c9fff359c374560f2d71853f7402ef07ca4e3d57e51ad0692a63e`,
  classified the attachment as `pdf`, rendered metadata context parts, and
  correctly marked extraction `skipped` because no PDF parser is registered.
- A follow-up `live:chat-log-smoke` read-only sweep from
  `2026-07-01T20:56:56Z` found zero Cloud Run errors and zero Chat webhook
  events during the PDF media-download window.
- A synthetic WAV attachment smoke passed with run
  `audio-attach-20260701T2100Z`. Chat UI showed the generated audio/file card,
  filename, one app reply, and a real app mention. The inbound wrapper verified
  one `audio/wav` attachment, one media resource, one HTTP 200 webhook POST,
  one `chat_event_received` stdout log, mention count 1, and zero Cloud Run
  errors.
- `GOOGLE_CHAT_AI_W7_MEDIA_READY=1 GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA=1 RUN_LIVE_CHAT_MEDIA_DOWNLOAD_SMOKE=1 pnpm live:chat-media-download-smoke`
  then downloaded that WAV with run
  `media-download-20260701T210125889Z-99862a`. It matched the original
  4,044-byte SHA-256
  `f9bbe28bc5af66266961c931e2cd7ae4b6c3f863428ef2b1ade242690c42d327`,
  classified the attachment as `audio`, rendered metadata context parts, and
  correctly reported transcription `disabled` by default.
- A follow-up `live:chat-log-smoke` read-only sweep from
  `2026-07-01T21:01:25Z` found zero Cloud Run errors and zero Chat webhook
  events during the audio media-download window.
- `corepack pnpm chat:user-auth-smoke -- --authorize --read-messages --read-reactions --read-memberships`
  upgraded the local user token for reaction and membership read scopes while
  preserving `domainWideDelegation: false`.
- `RUN_LIVE_CHAT_SPACE_EVENTS_SMOKE=1 pnpm live:chat-space-events-smoke`
  was added and dry-run verified, but live `spaces.spaceEvents.list` returned
  Google HTTP 500 `INTERNAL` for both default message/reaction filters and a
  minimal message-created filter. Blocked run
  `space-events-blocked-20260701T2120Z` saved redacted failure evidence.
- A real Chat UI thumbs-up reaction was added to the app reply for
  `audio-attach-20260701T2100Z`. `RUN_LIVE_CHAT_CONTEXT_READ_SMOKE=1 pnpm live:chat-context-read-smoke`
  with run `context-reaction-20260701T2119Z` confirmed `hasReactionNote: true`
  in both space and thread context. A follow-up `live:chat-log-smoke` sweep
  from `2026-07-01T21:16:00Z` found zero Cloud Run errors and zero Chat webhook
  events during the reaction/context-read window.
- A real Chat UI quote was created from the `audio-attach-20260701T2100Z`
  message. Screenshot evidence is
  `fixtures/live/evidence/chat-ui-quote-audio-20260701T2127Z.png`.
  `RUN_LIVE_CHAT_LOG_SMOKE=1 pnpm live:chat-log-smoke` with run
  `log-smoke-quote-attach-20260701T212630Z-v2` confirmed one webhook POST, one
  normalized message event, `hasQuotedMessage: true`, `quoteDepth: 1`, mention
  count 1, and zero Cloud Run errors.
- `RUN_LIVE_CHAT_CONTEXT_READ_SMOKE=1 pnpm live:chat-context-read-smoke` with
  run `context-quote-attach-20260701T212630Z-v4` confirmed one quoted message
  and one hydrated quoted attachment with `audio/wav` content type. The live
  raw Chat API returned `quotedMessageMetadata.quotedMessageSnapshot` with text
  only for this reply quote, so the SDK now hydrates quoted attachment metadata
  from the fetched history window when the original message resource is
  available and its timestamp is compatible.
- The current live QA ledger is kept outside the public repository.

Historical W7 implementation check from the original scaffold project:

The following bullets are retained as historical evidence only. They are
superseded for current private operations by the private live QA ledger and
the current private live project setup runbook (both kept outside the public
repository).

- Sourcing `.env.local` from the repository root,
  `pnpm chat:app-auth-smoke` passed with app auth and listed zero spaces.
- `pnpm chat:app-auth-smoke -- --create-test-space --metadata-output fixtures/live/chat-smoke-space.local.json`
  reached Google Chat but returned `403 PERMISSION_DENIED` because Workspace
  admin app-auth authorization for `chat.app.spaces.create` is not granted.
- That app-auth create-space path is no longer the preferred smoke-space
  creation path. Use per-user OAuth with `pnpm chat:user-auth-smoke`.
- `fixtures/live/chat-smoke-space.local.json` was not written because no space was created.
- Live `RUN_LIVE_CHAT_SMOKE=1 pnpm live:chat-smoke` was not run because there
  is still no real `GOOGLE_CHAT_TEST_SPACE`, smoke-space metadata, or confirmed
  app installation in the smoke space.
