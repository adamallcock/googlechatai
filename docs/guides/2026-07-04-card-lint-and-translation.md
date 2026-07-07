---
title: Card Lint And Translation
date: 2026-07-04
type: guide
status: implemented
---

# Card Lint And Translation

Use the card linter before posting or returning card payloads. It checks the
payload against the Google Chat surface you are targeting, so casing mistakes,
wrong response envelopes, add-on function routing, widget-limit risk, and
accessory conflicts are caught before users see a broken card.

## CLI

```bash
corepack pnpm chat:card-lint -- \
  --input fixtures/cards/builders/action-responses.json \
  --surface workspace-addon-action-response
```

Machine-readable output:

```bash
corepack pnpm chat:card-lint -- \
  --input card.json \
  --surface chat-message \
  --format json
```

Translate a direct Chat `UPDATE_MESSAGE` response into the Workspace add-on
action envelope:

```bash
corepack pnpm chat:card-lint -- \
  --input direct-response.json \
  --surface direct-chat-response \
  --translate-to workspace-addon-action-response \
  --translation-mode update-message \
  --format json
```

## Node

```ts
import { lintCardPayload, translateCardPayload } from "googlechatai";

const lint = lintCardPayload(payload, {
  surface: "chat-message",
  principal: "app",
});

const translated = translateCardPayload(response, {
  from: "direct-chat-response",
  to: "workspace-addon-action-response",
  mode: "update-message",
});
```

## Python

```python
from googlechatai import lint_card_payload, translate_card_payload

lint = lint_card_payload(payload, {
    "surface": "chat-message",
    "principal": "app",
})

translated = translate_card_payload(response, {
    "from": "direct-chat-response",
    "to": "workspace-addon-action-response",
    "mode": "update-message",
})
```

## Profiles

- `chat-message`: raw body for `spaces.messages.create` or message patch.
- `direct-chat-response`: legacy direct Chat interaction response body.
- `chat-dialog-response`: legacy direct Chat dialog response.
- `workspace-addon-action-response`: Workspace add-on `hostAppDataAction` or
  `action.navigations` response.
- `dialogflow-custom-payload`: Dialogflow custom payload shaped like a Chat
  message body.

Findings include `severity`, `code`, JSON `path`, message, and remediation.
Stats include cards, sections, widgets, buttons, images, and compact JSON byte
size.

Implemented translation covers direct Chat create/update/open-dialog responses
to Workspace add-on envelopes, plus Chat-message to direct-response passthrough.
Link preview, dialog-close notification, and widget-suggestion translators are
planned follow-ups.
