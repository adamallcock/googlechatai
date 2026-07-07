---
title: Message Fixture Conventions
date: 2026-06-29
type: reference
status: draft
---

# Message Fixture Conventions

W3 message fixtures use the same provisional convention as the event fixtures:
raw Google Chat-shaped input lives under `fixtures/messages/**`, and canonical
AST output lives under `fixtures/expected/messages/**`.

The parser emits `message-ast.v1`. Positional `segments` preserve occurrence
order from the source text. `plainTextForModel` is deterministic: message system
notes come first, then rendered message text, then each recursive child context
node in source order. User mentions render as human-readable names, while links,
slash commands, custom emoji, reactions, attachments, cards, GIFs, deleted
messages, private messages, thread replies, and inaccessible quotes add
AI-facing `System Note:` lines.

Recursive model context lives in `contextNode`. Quotes, attachments, cards, and
GIFs are all generic child context nodes rather than bespoke one-depth fields.
The nested quote fixture uses `quotedMessageMetadata.message` as a provisional
hydrated snapshot extension: the public REST message resource exposes quote
metadata, and a later context loader can attach fetched quoted contents before
calling the parser. If no hydrated message is present, the parser emits an
inaccessible quoted-message context node with the last known update time.

No live Google calls are required for these fixtures.
