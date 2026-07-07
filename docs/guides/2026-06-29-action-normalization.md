---
title: Action Normalization
date: 2026-06-29
type: guide
status: draft
---

# Action Normalization

Google Chat action-bearing events should be routed through `normalizeAction`
or read from `event.action` after `normalizeEvent`.

The normalized action shape is shared by Node and Python through fixtures under
`fixtures/actions/**` and expected outputs under `fixtures/expected/actions/**`.
It covers card clicks, dialog submissions, widget updates, slash commands, app
commands, form values, actor identity, event time, validation errors, and
AI-facing system notes.

## Node

```ts
import { normalizeAction, normalizeEvent } from "googlechatai";

const action = normalizeAction(rawEvent, { source: "fixture" });
const event = normalizeEvent(rawEvent, { source: "fixture" });

console.log(action?.methodName);
console.log(event.action?.systemNotes);
```

## Python

```python
from googlechatai import normalize_action, normalize_event

action = normalize_action(raw_event, source="fixture")
event = normalize_event(raw_event, source="fixture")

print(action["methodName"] if action else None)
print(event["action"]["systemNotes"] if event["action"] else [])
```

## Card Action Responses

For Chat add-on card action handlers, use the card response builders instead of
hand-rolling the nested response envelopes:

```ts
import {
  buildCreateMessageResponse,
  buildOpenDialogResponse,
  buildUpdateCardResponse,
} from "googlechatai";

return buildUpdateCardResponse(cardMessage);
return buildOpenDialogResponse(dialogOptions);
return buildCreateMessageResponse("Dialog submitted.");
```

```python
from googlechatai import (
    build_create_message_response,
    build_open_dialog_response,
    build_update_card_response,
)

return build_update_card_response(card_message)
return build_open_dialog_response(dialog_options)
return build_create_message_response("Dialog submitted.")
```

These helpers wrap the response shapes verified by the live webhook smoke in
the private live test tenant:

- `hostAppDataAction.chatDataAction.updateMessageAction.message`
- `hostAppDataAction.chatDataAction.createMessageAction.message`
- `action.navigations[0].pushCard`

Shared Node/Python fixtures live at
`fixtures/cards/builders/action-responses.json` and
`fixtures/expected/cards/builders/action-responses.json`.

Card summaries also preserve richer widget metadata for AI context. The shared
rich-widget fixture covers image, divider, grid, columns, chips, date/time
picker, and selected dropdown values:

- `fixtures/cards/inbound/rich-widgets.json`
- `fixtures/expected/cards/inbound/rich-widgets.summary.json`

## Contract

The shared action object includes:

- `actionId`: deterministic source/type/method/message/time identifier.
- `actionType`: `slash_command`, `app_command`, `card_click`,
  `dialog_submit`, `dialog_cancel`, `widget_update`, or `link_preview`.
- `methodName`: invoked function, action method name, command name, or app
  command identifier when available.
- `actor` and `eventTime`: human-readable actor reference and timestamp for
  model context.
- `parameters`: hidden action parameters, common parameters, command metadata,
  and app-command metadata as strings.
- `formInputs`: typed values for strings, multi-selects, booleans, dates,
  times, date-times, user pickers, space pickers, and unknown inputs.
- `selectedUsers` and `selectedSpaces`: resource refs extracted from picker
  outputs.
- `validationErrors`: stable typed errors for malformed parameters or inputs.
- `systemNotes`: deterministic plain-language notes for AI context.
- `raw`: the original `action`, `common` or `commonEventObject`,
  `slashCommand`, `appCommandMetadata`, and `dialogEventType` slices.

Unknown form fields are preserved in `formInputs.<field>.raw` with
`kind: "unknown"` and a validation error instead of being dropped.

## Fixture Assumptions

Current W4 fixtures are provisional, source-controlled payloads shaped from the
Google Chat event documentation. They are not captured live payloads. W7/W10
should replace or supplement them with captured safe smoke-test payloads when
live Chat testing is available.
