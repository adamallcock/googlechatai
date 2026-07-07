---
title: Google Chat Painpoints And Feature Opportunities
date: 2026-07-04
type: research
status: draft
---

# Google Chat Painpoints And Feature Opportunities

This note is a fresh public-signal pass over Google Chat developer painpoints
and the SDK features that could turn them into product advantages. It should be
read alongside:

- `docs/specs/2026-06-29-googlechatai-sdk-feature-inventory.md`
- `docs/reports/2026-07-03-live-feature-completion-audit.md`
- `docs/research/2026-06-29-google-chat-chatbot-package-research.md`

## Sources Reviewed

- Official Google Chat interaction docs: synchronous responses must return
  within 30 seconds, otherwise apps should respond asynchronously.
  <https://developers.google.com/workspace/chat/receive-respond-interactions>
- Official auth docs: Chat apps can use user or app authentication; methods
  require specific auth types and scopes.
  <https://developers.google.com/workspace/chat/authenticate-authorize>
- Official message docs: app auth and user auth attribute messages differently;
  rich cards/widgets are app-auth friendly, while user auth is much narrower.
  <https://developers.google.com/workspace/chat/create-messages>
- Official media upload docs: upload/attach flow has file-size/type limits and
  attachment messages cannot include accessory widgets.
  <https://developers.google.com/workspace/chat/upload-media-attachments>
- Official Cards V2 docs: card schemas have strict widget limits and some fields
  differ between Chat apps, add-ons, and other Workspace surfaces.
  <https://developers.google.com/workspace/chat/api/reference/rest/v1/cards>
- Stack Overflow and community reports about card clicks not reaching apps,
  service-account attachment failures, 30-second response failures, Card v1/v2
  confusion, app-not-configured 404s, and app membership 403s.
- Google Developer Forum and GitHub issues around Workspace Events/Pub/Sub
  setup for passive space ingestion.

## Painpoint Clusters

### 1. Interaction Events Are Easy To Misconfigure

Public symptoms:

- Buttons render, but clicks do not POST to the app and Chat displays an unable
  to process message.
- New Chat apps receive Workspace add-on-shaped payloads while developers expect
  direct Chat event payloads.
- Responses fail when they are late or have the wrong envelope shape.

Feature opportunity:

- `chat doctor interactions`: validate the deployed Chat app configuration,
  endpoint reachability, response deadline, expected envelope shape, and card
  action function form.
- A local replay harness that can generate direct Chat, add-on, Pub/Sub, and
  Workspace Events payloads from one fixture.
- A response-shape explainer that says "this payload must return
  `hostAppDataAction.chatDataAction...`" versus "this direct event can return a
  normal Chat message."

Current repo fit:

- We already normalize multiple envelopes and have direct webhook smokes.
- Next step is a user-facing interaction doctor with actionable diagnostics and
  links to the exact failing configuration field.

### 2. Auth Principal And Scope Rules Are A Product Surface

Public symptoms:

- API keys do not work where developers expect them to.
- Service accounts can send some messages but fail on methods that require user
  auth or app-specific admin approval.
- Cross-project/tenant app membership causes "app is not a member of this
  space" failures.
- Developers do not know whether an action is "as the user" or "as the app."

Feature opportunity:

- A generated capability matrix for every Chat API method: supported principal,
  scopes, admin approval, user consent, required membership, write risk, and
  replay safety.
- Runtime `PermissionPlan` objects returned before a call is attempted.
- `explainGoogleChatError(error)` with remediation for 401, 403, 404, 429, 5xx,
  missing app config, missing membership, and unsupported auth mode.
- Install/membership probes that can answer: "Can this app act in this space?"
  and "Can this user act here?"

Current repo fit:

- We already have central app/user auth clients and retry behavior.
- Next step is a first-class public capability/error explanation API rather than
  private smoke-tool knowledge.

### 3. Media And Attachments Are Full Of Hidden Rules

Public symptoms:

- Uploads fail with 403 under service-account/app auth for some flows.
- Media upload and attach has token/resource-name sequencing that developers
  find hard to implement.
- Official limits include file size, blocked file types, and the rule that
  messages with attachments cannot include accessory widgets.
- Downloading Chat-hosted versus Drive-hosted attachments requires different
  API paths.

Feature opportunity:

- `AttachmentPipeline`: normalize, policy-check, upload, attach, download,
  parse, cache, and render model notes.
- Automatic fallback suggestions: direct upload, Drive link/card fallback, or
  "send text plus separate attachment message" when accessory widgets conflict.
- Exact principal gating: upload/send/download plans declare app/user auth
  requirements before execution.
- Media error taxonomy with retry/bug-report hints.

Current repo fit:

- We have strong metadata/download/cache/parser foundations.
- Next step is a higher-level upload/send media pipeline with graceful fallback
  message composition.

### 4. Cards V2, Dialogs, And Add-On Surfaces Drift

Public symptoms:

- Developers paste a reference example into Card Builder or Dialogflow and get
  unknown-field errors.
- Cards v1/v2 naming and JSON shape confusion persists.
- Some card fields are only available for Workspace add-ons, not Chat apps, or
  vice versa.
- Large cards silently drop sections when widget limits are exceeded.

Feature opportunity:

- `chat card lint`: validate against a Chat-specific profile, not a generic
  Workspace card schema.
- Schema transforms for `cardsV2`, `cards_v2`, add-on envelopes, webhook
  responses, Dialogflow custom payloads, and direct REST messages.
- Visual preview fixtures and golden screenshots for common cards.
- Automatic simplification for mobile, long cards, and widget-count boundaries.

Current repo fit:

- We have card builders, summaries, and visual smokes.
- Next step is a standalone card linter/translator CLI with surface profiles.

### 5. Long-Running AI Responses Need A Default Pattern

Public symptoms:

- AI apps exceed the 30-second interaction deadline.
- Developers mix sync responses, Pub/Sub acking, and async `messages.create`
  without understanding which framework accepts which response.
- Users see "not responding" even when an answer appears later.

Feature opportunity:

- Default `respondWithPlaceholder`: immediately create/update "Thinking..." and
  then edit the same message with final output.
- Queue adapters for Cloud Tasks, Pub/Sub, Celery, BullMQ, and local dev.
- A per-event `ReplyHandle` that carries space/thread/message/update-mask
  metadata across async boundaries.
- Deadline-aware router middleware: if a handler is likely to exceed 30 seconds,
  it automatically chooses placeholder/async mode.

Current repo fit:

- We have placeholder response helpers and edit-based streaming.
- Next step is production queue adapters and framework integrations.

### 6. Passive Ingestion Without @Mentions Is Hard

Public symptoms:

- Developers want all selected-space messages without relying on mentions.
- Workspace Events requires Pub/Sub setup, publisher principals, subscription
  targets, and sometimes tenant policy changes.
- Some teams choose polling because Workspace Events is operationally heavier.

Feature opportunity:

- `IngestionMode`: direct interactions, Workspace Events, Pub/Sub push/pull,
  and polling fallback under one interface.
- A Workspace Events setup doctor that checks publisher IAM, org-policy blocks,
  target resource shape, include-resource settings, and cleanup.
- A poller that uses `spaces.messages.list` filters, cursors, and checkpoints
  with the same normalized event envelope as pushed events.

Current repo fit:

- We already support Workspace Events parsing/checkpoints and read history.
- Next step is a resilient polling fallback and production subscription doctor.

### 7. Installation And Marketplace Setup Remain Fragile

Public symptoms:

- Developers enable the API but do not configure a Chat app and get app-not-found
  404s.
- Apps are not visible to add, or they install but cannot act in the target
  space.
- Internal Marketplace / Workspace app authorization / OAuth branding setup has
  too many manual steps.

Feature opportunity:

- `chat setup doctor`: Cloud project, APIs, OAuth client, branding, Chat app
  config, endpoint reachability, install visibility, scopes, app authorization,
  and test-space membership in one command.
- A redacted "setup bundle" report operators can send to admins.
- A Chrome-assisted checklist for the steps Google has no API for.

Current repo fit:

- We have strong private setup docs and smoke commands.
- Next step is a polished public CLI flow with redacted operator output.

### 8. Developer Tooling Should Be Evidence-First

Public symptoms:

- Failures are opaque: Chat UI says unable/not responding, Cloud Run may have no
  log, and the API error often hides the actual setup mistake.
- Developers need to know whether Chat sent no request, sent a bad envelope, or
  the app returned an invalid response.

Feature opportunity:

- Correlated evidence bundle: Chat UI screenshot, Cloud Run request/log window,
  normalized event summary, response-shape validation, and remediation.
- Local fixture recorder/replayer that strips tokens and message text while
  preserving useful structure.
- CI-ready smoke matrix for direct event, add-on envelope, card click, dialog,
  upload, async response, duplicate delivery, and rate-limit retry.

Current repo fit:

- Our live evidence discipline is already unusually strong.
- Next step is productizing it as `googlechatai doctor --since 5m`.

## Highest-Leverage Next Features

1. Public `chat doctor` CLI covering setup, endpoint, interaction, auth, and log
   correlation.
2. Principal-aware capability/error explanation API generated from discovery
   metadata plus curated method rules.
3. Chat card linter/translator with surface profiles and Card Builder-friendly
   output.
4. High-level media upload/send/download pipeline with Drive fallback and
   accessory-widget conflict handling.
5. Production async AI response kit: placeholder, queue adapters, reply handles,
   and edit/stream policies.
6. Passive ingestion layer with Workspace Events plus polling fallback using the
   same normalized envelope.

## Build/Do-Not-Build Notes

- Do build features that turn Google Chat's confusing auth/event/config matrix
  into explicit plans, diagnostics, and remediation.
- Do build thin wrappers around existing Google APIs, but make the wrappers
  opinionated about principal, scopes, retry, idempotency, and AI context.
- Do not over-invest in unsupported or tenant-blocked preview surfaces until the
  API is reliable in live smoke tests.
- Do not hide auth ambiguity. Every high-level method should say which principal
  is acting and why.
