---
title: Google Chat Message Pins Discovery Review
date: 2026-09-03
type: research
status: implemented
---

# Google Chat Message Pins Discovery Review

## Decision

Accept discovery revision `20260828` and promote the three newly discovered
message-pin methods into the SDK's intentional, user-authorized Developer
Preview surface. Do not treat discovery alone as a live-write certification.

## Evidence

- Live source: [Google Chat v1 discovery document](https://chat.googleapis.com/$discovery/rest?version=v1), fetched on 2026-09-03.
- Added methods: `spaces.messagePins.create`, `spaces.messagePins.delete`, and
  `spaces.messagePins.list`; no existing method contract changed in the
  reviewed `20260804` to `20260828` snapshot transition.
- Official contracts: [create](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messagePins/create), [delete](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messagePins/delete), [list](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messagePins/list), and the [MessagePin resource](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messagePins).

| Method | Supported SDK behavior | Auth and scope |
| --- | --- | --- |
| `create` | `POST /v1/{space}/messagePins` with flat `{ "message": "spaces/.../messages/..." }` body | Installed-user OAuth; `chat.spaces.pins` |
| `delete` | Direct `DELETE /v1/spaces/{space}/messagePins/{message}` when given a pin or a message resource name | Installed-user OAuth; `chat.spaces.pins` |
| `list` | Paginated `GET /v1/{space}/messagePins`, clamped to the documented 1–100 page-size range | Installed-user OAuth; `chat.spaces.pins.readonly` |

The `MessagePin` reference specifies that the pin resource ID equals the
message resource ID. This makes an unpin-by-message call deterministic and
removes the prior list-and-placeholder step.

## Implementation Decision

- Keep the Node and Python planners semantically identical through shared
  conformance cases and expected-plan fixtures.
- Default all pin planners to user auth. App auth is represented as an explicit
  capability block with a remediation message; the SDK never substitutes a
  user identity.
- Preserve the old `PIN_MESSAGES_SCOPE` and `CHAT_PIN_DOCS_LISTED_NOTE`
  exports as compatibility aliases, but emit the specific pin scopes and the
  Developer Preview warning from new plans.
- Make `ensure pinned` safe against a duplicate create: it lists the full first
  page, skips a matching existing pin, and fails before writing when a page
  token shows that the list is incomplete.
- Keep the generic legacy `resolvedMessagePin` placeholder resolver for
  previously persisted plans, but do not emit it from the current pin planner.

## Validation Boundary

The upgrade has local Node/Python planner, executor, capability, shared
fixture, and conformance coverage. It does not perform a Google Chat pin or
unpin. Any live pin write remains subject to the dedicated smoke-space and
explicit-operator guards in the [live Chat smoke runbook](../runbooks/2026-06-29-live-chat-smoke-harness.md).

The curated `20260828` snapshot contains 54 method IDs with complete
request-contract fingerprints. The prior `20260804` baseline is retained under
`discovery/snapshots/` for historical comparison.
