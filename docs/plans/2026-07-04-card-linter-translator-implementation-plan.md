---
title: Card Linter Translator Implementation Plan
date: 2026-07-04
type: plan
status: implemented-slice
---

# Card Linter Translator Implementation Plan

## Status

Implemented slice:

- Existing card builders, summaries, action routing, live card-action smokes,
  visual smokes, schemas, and tests inspected.
- Current Google card/message/add-on envelope rules checked against official
  documentation.
- Shared profile-aware lint result shape in Node and Python.
- Node/Python `lintCardPayload` / `lint_card_payload` APIs.
- Node CLI: `corepack pnpm chat:card-lint -- --input <json> --surface <profile>`.
- Shared conformance fixtures covering valid Chat message, casing mistakes,
  add-on envelope mistakes, broken actions, accessory conflicts, add-on
  endpoint-function routing, and translator output.
- Compatibility: keep `validateCardMessage` as a strict legacy wrapper over
  the Chat-message profile.

Planned follow-ups:

- More exhaustive fixtures for widget-limit sections, missing alt text, and
  large payload warnings.
- Link-preview, dialog-close notification, and widget-suggestion translators.
- Optional live smoke that lints every visual/card-action payload before posting.

## Problem

Google Chat card failures are easy to create and hard to diagnose. Developers
mix `cards`/`cardsV2`/`cards_v2`, return a plain Chat `Message` where a
Workspace add-on response must return an `action`, use named functions where
add-ons need full URLs, exceed widget limits so sections silently disappear,
or create icon/image controls without alt text. The current SDK has useful card
builders and a minimal `validateCardMessage`, but it doesn't encode the target
surface. Developers need a preflight tool that says "this payload is good for
this Chat surface" before they post it or deploy a webhook.

## Verified Source Rules

Official Google docs checked on 2026-07-04:

- Cards v2 reference:
  <https://developers.google.com/workspace/chat/api/reference/rest/v1/cards>
  says cards display in Google Chat messages or Workspace add-ons and the
  shared card widget limit is 100 widgets per card. If a section pushes the
  count over 100, that section and following sections are ignored.
- Message REST reference:
  <https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages>
  defines `cards` as deprecated, `cardsV2` as the card-message field,
  `fallbackText` as the plain-text fallback, and `accessoryWidgets` as
  bottom-of-message widgets that require app auth and are unsupported for
  messages containing dialogs.
- Message creation guide:
  <https://developers.google.com/workspace/chat/create-messages>
  says app auth can send rich text, cards, and interactive widgets, while user
  auth is text-only outside the Developer Preview cards path.
- Interactive card guide:
  <https://developers.google.com/workspace/chat/design-interactive-card-dialog>
  describes message cards, homepages, dialogs, buttons, text inputs, selection
  inputs, accessibility alt text, and interactive actions.
- Chat add-on conversion guide:
  <https://developers.google.com/workspace/add-ons/chat/convert>
  maps legacy Chat interaction responses to Workspace add-on actions. Add-ons
  use `hostAppDataAction.chatDataAction.createMessageAction`,
  `hostAppDataAction.chatDataAction.updateMessageAction`, or
  `action.navigations[].pushCard/updateCard` rather than returning a plain
  `Message` object. It also says add-on card action functions should be full
  HTTP URLs unless a historical card interaction URL is configured.

## Current Repo Baseline

Implemented:

- [packages/node/src/cards/index.ts](../../packages/node/src/cards/index.ts)
  and [packages/python/src/googlechatai/cards/__init__.py](../../packages/python/src/googlechatai/cards/__init__.py)
  provide card builders, AI helper card builders, accessory feedback widgets,
  dialog builders, add-on response builders, navigation helpers, action-state
  encoding, action routing, card summaries, and basic `validateCardMessage`.
- [tools/live-smoke/chat-visual-smoke.mjs](../../tools/live-smoke/chat-visual-smoke.mjs)
  and [tools/live-smoke/chat-card-action-smoke.mjs](../../tools/live-smoke/chat-card-action-smoke.mjs)
  have live visual and interaction evidence for card messages, dialogs,
  navigation, accessory feedback, and rich widgets.
- [tools/live-smoke/chat-card-action-webhook-smoke.mjs](../../tools/live-smoke/chat-card-action-webhook-smoke.mjs)
  validates deployed webhook response envelopes for add-on-style card actions.
- [spec/cards.schema.json](../../spec/cards.schema.json)
  covers built messages, dialogs, card summaries, and card action context, but
  not linter findings or translation plans.

Missing:

- No public card lint CLI.
- No profile-specific validation for Chat message, direct Chat interaction
  response, Workspace add-on action response, dialog response, or Dialogflow
  custom payload.
- No machine-readable lint findings with severity, path, rule id, remediation,
  and source profile.
- No reusable translator for common envelope transforms.

## Public API

Node:

```ts
lintCardPayload(payload, {
  surface: "chat-message",
  principal: "app",
  baseUrl: "https://example.run.app/api/chat/events"
})

translateCardPayload(payload, {
  from: "direct-chat-response",
  to: "workspace-addon-action-response",
  mode: "update-message",
  baseUrl: "https://example.run.app/api/chat/events"
})
```

Python:

```python
lint_card_payload(payload, {
    "surface": "chat-message",
    "principal": "app",
    "baseUrl": "https://example.run.app/api/chat/events",
})

translate_card_payload(payload, {
    "from": "direct-chat-response",
    "to": "workspace-addon-action-response",
    "mode": "update-message",
    "baseUrl": "https://example.run.app/api/chat/events",
})
```

Profiles:

- `chat-message`: body passed to `spaces.messages.create` or message patch.
- `direct-chat-response`: plain response body returned to a legacy Chat HTTP
  interaction endpoint.
- `chat-dialog-response`: legacy Chat response with
  `actionResponse.type="DIALOG"`.
- `workspace-addon-action-response`: add-on response with `hostAppDataAction`
  or `action.navigations`.
- `dialogflow-custom-payload`: custom payload that should contain a Chat
  message-like body without add-on-only wrappers.

Lint result:

```json
{
  "kind": "chat.card_lint_result",
  "surface": "chat-message",
  "ok": false,
  "summary": "2 errors, 1 warning",
  "stats": {
    "cards": 1,
    "sections": 2,
    "widgets": 104,
    "buttons": 3,
    "images": 1,
    "bytes": 1800
  },
  "findings": [
    {
      "severity": "error",
      "code": "wrong_cards_field",
      "path": "$.cards_v2",
      "message": "Use cardsV2 for Google Chat REST messages.",
      "remediation": "Rename cards_v2 to cardsV2 for the chat-message profile."
    }
  ],
  "translated": null
}
```

## Rule Set For First Slice

Errors:

- Non-object payload for object profiles.
- `cards_v2` used for REST/direct Chat profiles.
- `cards` used when `cardsV2` is expected.
- `cardsV2` used as the top-level add-on response without
  `hostAppDataAction` or `action.navigations`.
- `hostAppDataAction` or `action.navigations` used in a raw Chat message body.
- Missing text/fallback when cards are present.
- Missing `card.header.title` for Chat message cards.
- Missing `section.widgets`.
- Button without `onClick.action.function` or `onClick.openLink.url`.
- Workspace add-on action button with non-URL `action.function`, unless
  `allowNamedFunctions` is explicit.
- Message has both `attachment`/`attachments` and `accessoryWidgets`.
- Message has `actionResponse.type="DIALOG"` and `accessoryWidgets`.

Warnings:

- More than 100 widgets in a card; identify the first section that will be
  ignored by Google Chat.
- Message/card JSON is near or above 32 KB.
- Icon button or image lacks `altText`/`imageAltText`.
- User-auth profile attempts to send cards/accessory widgets outside a preview
  feature gate.
- More than one primary path is present in an add-on response
  (`createMessageAction`, `updateMessageAction`, `action.navigations`).
- Text-only payload is valid but has no fallback/card summary.

## Translation Helpers For First Slice

Supported:

- Direct Chat update response:

  ```json
  {
    "actionResponse": { "type": "UPDATE_MESSAGE" },
    "text": "Done"
  }
  ```

  to add-on:

  ```json
  {
    "hostAppDataAction": {
      "chatDataAction": {
        "updateMessageAction": {
          "message": { "text": "Done" }
        }
      }
    }
  }
  ```

- Direct Chat new message response to add-on `createMessageAction`.
- Direct Chat dialog response to add-on `action.navigations[].pushCard`.
- Chat message body to direct Chat response by preserving `text`,
  `fallbackText`, `cardsV2`, and `accessoryWidgets`.

Planned later:

- Link preview `updateInlinePreviewAction`.
- Dialog close notification.
- Widget-update suggestions across Chat and add-on envelopes.

## CLI

Command:

```bash
corepack pnpm chat:card-lint -- --input fixtures/cards/lint/valid-chat-message.json --surface chat-message
```

Options:

- `--input <path>`: JSON file to lint.
- `--surface <profile>`: required target profile.
- `--principal app|user`: optional auth principal for feature warnings.
- `--format summary|json`: default summary.
- `--translate-to <profile>`: optional translation target.
- `--translation-mode create-message|update-message|open-dialog`.
- `--base-url <url>`: used to validate/fill add-on action URLs.
- `--allow-named-functions`: suppress add-on URL function errors.

Exit codes:

- `0`: no errors.
- `1`: lint errors.
- `2`: invalid CLI invocation or unreadable input.

## Implementation Slices

1. Add schemas for `chat.card_lint_result`, findings, stats, and translation.
2. Add shared fixture cases and conformance runner support.
3. Implement Node/Python linter core in the existing cards modules.
4. Keep `validateCardMessage` by mapping lint errors to existing legacy error
   strings for compatibility.
5. Implement Node CLI using built package exports.
6. Add docs and update README/docs index.
7. Update the live completion audit with the F3 claim boundary.

## Test Plan

Focused tests:

```bash
corepack pnpm --filter googlechatai test -- cards
PYTHONPATH=packages/python/src python3 -m unittest packages.python.tests.test_cards
node --test tools/chat/card-lint.test.mjs
corepack pnpm conformance
```

Required gates before F3 commit:

```bash
corepack pnpm validate
corepack pnpm discovery:check
corepack pnpm release:check
git diff --check
```

## Live Test Boundary

F3 is primarily local and fixture-driven. No new live write is required for the
first slice because existing visual/card-action smokes have already proven the
valid generated payloads. If a later live confidence run is useful, use only
the dedicated smoke space and leave messages in place unless the user asks for
cleanup.

## Completion Conditions

- Node/Python linter APIs exported.
- CLI exists and handles summary/json output plus errors correctly.
- Shared fixtures prove Node/Python parity for valid, invalid, and translated
  payloads.
- Existing builders lint cleanly for the Chat-message profile.
- Existing `validateCardMessage` behavior remains compatible.
- Docs explain profiles and common fixes.
- Required validation gates pass.
- F3 has a logical commit.
