---
title: Google Chat November discovery compatibility review
date: 2026-11-09
status: Implemented
---

# Google Chat discovery drift review

## Evidence and decision

Reviewed the complete public discovery documents, including schema and method
prose, rather than accepting the signature diff alone:

- Previous revision **20260920**: [immutable upstream source](https://raw.githubusercontent.com/googleapis/discovery-artifact-manager/1019e23adb547248d7836383a90863d92e57e9ed/discoveries/chat.v1.json), recorded in [the prior baseline](../../discovery/google-chat-v1-20260920.methods.json).
- Current revision **20261107**: [immutable upstream source](https://raw.githubusercontent.com/googleapis/discovery-artifact-manager/9f8a165ecc629ec648b3bf96353eceb9d7e1ed88/discoveries/chat.v1.json).
  Parsed JSON was exactly equal to the public live discovery document retrieved
  on November 9. No live Chat message, space, attachment, or reaction was read or
  written for this review.
- [Pinned public discovery document](../../discovery/google-chat-v1-20261107.discovery.json)
  and [reviewed baseline](../../discovery/google-chat-v1-20261107.methods.json)
  retain the full prose, source URL, source SHA-256, revision, and review link.
  The bundled document adds a final newline to the upstream bytes for repository
  formatting; its recorded SHA-256 verifies those bundled bytes.

The old signature algorithm finds 54 → 55 methods, one addition, no removals,
and 12 changed existing signatures. The existing-method changes are additive
schema reachability or scope changes, not changed HTTP paths, parameter
contracts, or removed request fields. This supports a reviewed baseline refresh,
not a claim of full SDK support for every discovery field or newly listed scope.
The prior snapshot remains unchanged for historical comparison.

## Reviewed structural changes

1. **Implemented: card replacement compatibility.**
   `spaces.messages.replaceCards` is a new POST method at
   `v1/{+name}:replaceCards`. Its required path parameter is a message resource
   name; request `ReplaceMessageCardsRequest.cardsV2` is an optional array and
   the response is an empty `ReplaceMessageCardsResponse` object. Both method
   prose and scopes require app authentication (`chat.bot`). Empty cards remove
   the current cards. For a human-created message the cards must already exist
   and belong to the calling app; after removal the app cannot add them back.
   SDK compatibility work permits an explicit empty array while rejecting
   missing/non-array input, and checks the app-auth requirement.
2. **Implemented: structured citation normalization.**
   Optional `Message.elements` references new `Elements`, with `citations` and
   `citedSources` arrays. New `Citation` has `id` and `citedSources`;
   `CitedSource` has `title`, `uri`, `snippet`, and `footer`. New `Snippet`
   contains `text` and `imagePreview`, the latter referencing new `ElementsImage`
   with `imageUri`. New `Footer` contains `text`. The two SDKs normalize these
   metadata surfaces; this review does not certify citation creation or display.
3. **Deferred: citation authoring and rendering guarantees.**
   Discovery allows elements on create/update, describes inline references as
   Markdown-only, ignores unreferenced citations, and distinguishes footer
   sources from inline citations. Citation IDs are ASCII alphanumeric and less
   than 63 characters; snippets must not exceed 1,000 characters; image URIs
   must be publicly accessible. Some inline tag examples are missing from the
   discovery prose, and its shorthand `MARKDOWN` is not the actual enum name
   `MARKUP_SYNTAX_MARKDOWN`. Do not infer a validated authoring grammar from
   that prose or automatically fetch source/image URLs. Raw payload access
   remains available; authoring helpers require their own fixtures and review.
4. **Deferred: card ownership promotion.**
   `CardWithId.ownerUser` is newly output-only, referencing `User` and described
   as the app that owns the card. It remains available through raw payloads;
   this update does not add a normalized card-ownership contract.
5. **No new silent/annotation/reaction metadata fields.**
   `Message.silent` was already present in revision 20260920 and remains an
   output-only boolean describing suppressed push notifications. It does not
   authorize a silent-send input. `Message.annotations`, `Annotation`,
   `Reaction`, and emoji reaction summary metadata are unchanged. Elements are
   distinct input/output citation metadata, not a replacement for output-only
   annotations. No new normalization or sending capability is claimed here
   for those pre-existing fields.

The 12 changed existing signatures are `media.upload`, message
`create/get/list/patch/search/update`, reactions `create/delete/list`, and space
events `get/list`. The message and event changes reflect reachable
`Message.elements` and `CardWithId.ownerUser` schemas, not distinct endpoint
behavior changes.

## Authentication contradictions: do not widen capability gates

`media.upload` and reaction `create/delete` now list `chat.bot`; reaction `list`
adds both `chat.bot` and `chat.app.messages.readonly`. Their unchanged method
prose still explicitly requires user authentication and lists only user scopes.
The SDK's conservative existing gates remain in place. A discovery scope array
alone is insufficient evidence of production app-auth availability, rollout,
installation/admin requirements, or tenant access. These additive capabilities
are explicitly deferred until corroborating documentation and authorized,
isolated validation resolve the contradiction. No tokens, grants, or auth
settings are changed. Unlike these methods, replaceCards has aligned app-auth
prose and scopes.

## Prose-only changes reviewed separately

The signature gate intentionally ignores descriptions. This review also checked
changes not visible to that gate:

- `Message.markupSyntax`: when updating text, supply markup syntax on the
  resource but include `text`, not `markup_syntax`, in the update mask.
- Space descriptions now document a 4,096-character rather than 150-character
  limit. No new SDK guarantee or server validation is inferred here.
- Dialog prose no longer says DateTimePicker/OnChangeAction are unsupported.
  This does not itself certify all dialog widgets in the SDK.
- Form-input documentation clarifies widget `name` keys, selected switch values,
  and empty values. DateTimePicker prose distinguishes minute-based configured
  offsets from typically millisecond-based event offsets.
- Card prose clarifies ten card actions and 100 widgets across sections,
  decorated-text click targets, grid item callback identifiers, and deprecated
  chip behavior. Carousel and widget examples correct names, enum spellings,
  and invalid JSON. Deprecated event guidance distinguishes non-add-on events
  from add-on event objects. These are documented upstream clarifications,
  not new parser or UI compatibility claims.

## Signature algorithm correction (separate from upstream drift)

**Implemented:** signature version 2 preserves property names when traversing
schema `properties` maps. Previously the generic prose filter dropped real
fields called `id`, `title`, `description`, or `annotations`, not just schema
metadata with those names. In particular, citation IDs/titles and message
annotations must contribute to reachable-schema signatures. Metadata descriptions
are still ignored at schema nodes, references still resolve recursively, and
cycles remain bounded. Regression tests distinguish property names from metadata
and detect changes inside referenced annotation schemas and citation IDs.

Version 2 signatures are regenerated from the pinned current document. Hash
changes caused by this correction must not be described as upstream API changes.
The 12-method count above uses the historical algorithm on both documents to
isolate upstream drift from this algorithm correction.

## CI and future drift policy

**Implemented:** ordinary PR/push CI runs
`node tools/discovery/check-baseline.mjs`. This deterministic, network-free check
validates source SHA-256, immutable provenance, API identity, revision, signature
version, a nonempty sorted unique method list, complete matching signatures,
and the accompanying review. A corrupt or inconsistent baseline fails CI.

`pnpm discovery:check` continues to be an explicit live check, as does
`node tools/discovery/check-live-drift.mjs`. The weekly/manual discovery workflow
is unchanged: contract drift exits 1 and opens/updates its issue; fetch errors
exit 2 and fail the check without pretending to be contract drift. There is no
`continue-on-error` bypass and no automatic baseline acceptance. Revision-only
changes remain informational. Ordinary CI no longer fails merely because an
external public document changed or its endpoint is unavailable.

Future baseline refreshes require the same structural and prose review,
including explicit disposition of unsupported additive capabilities.
