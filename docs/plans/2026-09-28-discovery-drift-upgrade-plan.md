---
title: Google Chat September Discovery Upgrade Plan
date: 2026-09-28
type: plan
status: implemented
---

# Google Chat September Discovery Upgrade Plan

## Decision And Outcome

The September drift was additive upstream capability. The Node and Python
packages now support semantic `spaceTypes` search with the correct scope,
preserve optional Chat avatar metadata in structured identities, prefer
complete Chat-provided identity to Directory cache data, and keep anonymous
identity inaccessible. Search model context omits avatar URLs. The reviewed
`20260920` snapshot is active. Space membership visibility management remains
a separate feature decision.

## Evidence At Review

- The [September 28 workflow](https://github.com/adamallcock/googlechatai/actions/runs/36432514747)
  compared baseline revision `20260828` with live revision `20260922`: 54
  methods on both sides, none added or removed, and 24 changed signatures.
- The [September 17 upstream change](https://github.com/googleapis/discovery-artifact-manager/commit/f986d80b9e9670d76d5bfcfd2c4a402415a1bbc9)
  added `AccessPermissionSettings.viewSpaceMembershipSetting` and
  `PermissionSettings.viewSpaceMembership`. They propagate through 17 methods
  that accept or return `Space`. Google's [Space reference](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces)
  requires the two fields together when updating who can view membership.
- The [September 24 upstream change](https://github.com/googleapis/discovery-artifact-manager/commit/1019e23adb54)
  added output-only `User.avatarUrl` and `User.email` to the discovery schema.
  The seven additional affected methods are five membership methods and two
  reaction methods; methods already affected through `Space` also carry this
  nested `User` change. The discovery prose conditions these fields on user
  authentication and a user's space membership or prior affinity. Their
  absence must remain a normal result. The older standalone [User REST page](https://developers.google.com/workspace/chat/api/reference/rest/v1/User)
  has not caught up with this schema; Google's [user-identification guide](https://developers.google.com/workspace/chat/identify-reference-users)
  already shows both fields in an interaction event.
- The same September 24 artifact documents a `space.space_type` filter for
  message search. This is a prose-only discovery edit, so the drift checker
  correctly did not count it. Google's [search reference](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/search)
  allows `DIRECT_MESSAGE`, `GROUP_CHAT`, or `SPACE`, permits OR between values,
  and requires a space-read scope for this filter. Search remains Developer
  Preview and user-authorized.
- Before implementation, event and message normalizers accepted `email`, while
  action normalization dropped it. `avatarUrl` was absent from the structured
  public identity types, and the search planner did not recognize
  `space.space_type` for its required scope. Model-context projection and
  search-context construction already redacted email by default; the
  lower-level message AST's `plainTextForModel` could contain an address.

## Implemented Work And Remaining Decision

1. **Search planner: implemented.** Both packages validate and deduplicate
   `spaceTypes`, compose OR across the three documented types, and preserve the
   1,000-character filter limit. Semantic and raw `space.space_type` filters
   report `chat.spaces.readonly`. User-auth and Developer Preview warnings
   remain in place.
2. **Identity handling: implemented.** Both packages keep `email` optional and
   preserve `avatarUrl` as optional structured metadata in event, action,
   message, mention, membership, reaction, and Chat-link identity paths.
   Complete Chat-provided identity avoids Directory lookup; partial identity
   can use the optional cache with explicit mixed-source provenance. Anonymous
   identities do not expose supplied email, display name, or avatar metadata.
   The SDK does not fetch avatar bytes.
   Search model context omits avatar URLs and redacts email by default. The
   lower-level message AST's `plainTextForModel` remains a distinct surface
   that can contain an address when the raw payload includes one; callers
   should use the redacting model-context projection at the model boundary.
3. **Space visibility: awaiting a user-facing use case.** A read-only
   interpretation of who can view a space's member list could be useful to an
   admin-oriented product flow. Keep absent settings distinct from restrictive
   settings. If an update planner is later justified, take an explicit intent
   such as target audiences and allowed roles, include both linked fields and
   update-mask paths, validate their cross-field rule, and remain dry-run by
   default. Do not infer permission to modify a space from this discovery
   change.
4. **Monitoring loop: locally implemented.** The new curated snapshot is
   pinned to [Google's September 24 artifact](https://github.com/googleapis/discovery-artifact-manager/commit/1019e23adb547248d7836383a90863d92e57e9ed),
   revision `20260920`. The live revision `20260922` matches its 54 method
   signatures. The checker now uses this baseline. The open
   [drift issue](https://github.com/adamallcock/googlechatai/issues/27) is a
   remote workflow state and has not been changed by this local implementation.

## Validation

- Shared fixtures and Node/Python conformance cover populated and missing
  `User` fields, external and anonymous identities, safe avatar handling, and
  multiple space types. Focused tests cover invalid types, filter-dependent
  scopes, Directory fallback, and model-context omission of avatar URLs.
- `corepack pnpm discovery:check` passed against live revision `20260922` with
  54 methods and no changed signatures. `corepack pnpm release:check` passed
  with `NPM_CONFIG_CACHE` pointed at a writable temporary directory because
  this machine's default npm cache is not writable. The gate includes full
  Node/Python tests, conformance, build, format, docs, package contents,
  secret scan, and dependency freshness policy checks.
- No live Chat action was used for this implementation. Future live validation
  must follow the dedicated smoke-space runbook and stay read-only for these
  surfaces.

## Open Product Decision

Is member-list visibility a supported SDK job? If no concrete consumer needs
it, classify the `Space` fields and leave them accessible through raw payloads.
