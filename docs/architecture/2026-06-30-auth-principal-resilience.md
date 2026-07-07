---
title: Auth Principal And Resilient Transport
date: 2026-06-30
type: decision-record
status: draft
---

# Auth Principal And Resilient Transport

## Decision

Every SDK primitive must declare who it acts as, what credentials it may use,
which scopes it needs, and whether fallback to another principal is allowed.
Token refresh, retries, rate-limit handling, and transient Google API recovery
belong in shared auth and transport layers, not in local message, thread,
attachment, card, or router functions.

The default product posture is user-installed, user-authorized Google Chat apps.
Normal chatbot and extension actions should use the installing user's OAuth
permissions when the action reflects user-visible context or user agency. Do not
design the primary SDK path around domain-wide delegation. Admin or migration
authority is an optional enterprise/compliance lane and must stay separate from
ordinary chatbot primitives.

## Why This Matters

Google Chat operations are not interchangeable. Some are app-owned actions,
some require user authorization, some can be done by either principal with
different visibility, and some should never silently fall back because doing so
would change the meaning of the action.

For example:

- Sending a bot reply in a thread is usually an app action.
- Reading user-visible context may require user auth when app auth cannot see a
  message or attachment.
- Creating or finding user-visible spaces and reading broader thread context
  should usually use the installing user's OAuth grant.
- Resolving a user may have different availability under app or user
  credentials.
- Editing/deleting should usually be limited to messages created by the same
  principal unless the API and policy explicitly allow broader authority.

If this is not centralized, every local helper grows bespoke auth checks,
partial retry logic, and inconsistent error handling. Worse, a primitive might
silently switch from "as user" to "as bot" and surprise both the developer and
the end user.

## Principal Model

Introduce an explicit auth intent on every executable primitive:

```ts
type PrincipalMode =
  | "app"
  | "user"
  | "either_prefer_user"
  | "either_prefer_app"
  | "none";

type FallbackPolicy =
  | "forbid"
  | "allow_if_semantics_preserved"
  | "allow_read_degraded";

type AuthIntent = {
  operation: string;
  principal: PrincipalMode;
  fallback: FallbackPolicy;
  requiredScopes: string[];
  optionalScopes?: string[];
  subjectUser?: string | null;
  space?: string | null;
  reason: string;
};
```

Python should expose the same shape as `TypedDict` or dataclasses, and both
languages should serialize the same canonical JSON in conformance fixtures.

The result of planning an operation should include an auth plan before any live
request is attempted:

```json
{
  "operation": "messages.replyInThread",
  "auth": {
    "principal": "app",
    "fallback": "forbid",
    "requiredScopes": ["https://www.googleapis.com/auth/chat.bot"],
    "actingAs": {
      "kind": "app",
      "displayName": "Google Chat AI SDK Dev"
    },
    "onBehalfOf": null
  },
  "capability": {
    "ok": true,
    "status": "available",
    "reasons": []
  }
}
```

## Credential Broker

All live Google calls should go through a central credential broker:

```ts
interface CredentialBroker {
  getClient(intent: AuthIntent, context: RequestContext): Promise<AuthClientLease>;
}

type AuthClientLease = {
  principal: "app" | "user";
  credentialId: string;
  scopes: string[];
  expiresAt: string | null;
  client: unknown;
};
```

The broker owns:

- Token lookup from a configured token store.
- Pre-emptive refresh before expiry using a clock-skew buffer.
- Single-flight refresh so concurrent calls do not stampede the refresh token.
- One forced refresh after a `401` that looks like token expiry.
- No raw token exposure to local primitives.
- Explicit `authRequired`, `permissionDenied`, or `principalUnavailable`
  capability results when refresh or lookup fails.

Token stores should be interface-backed:

- `MemoryTokenStore` for tests.
- `KeychainTokenStore` for local development where available.
- `FileTokenStore` only for explicitly local, ignored fixtures.
- Cloud secret/store adapters later, once deployment shape is settled.

User token storage is the normal live path. Tokens are keyed by Chat app,
Google Cloud project, Workspace customer when known, user identity when known,
and scope set. A missing, revoked, expired, or insufficient user grant should
return `authRequired` with a consent URL or card prompt. Local primitives should
not know whether the broker refreshed the user's token, replayed once after a
token-expiry `401`, or returned an auth-required capability.

Stored keys must include project/app, tenant or Workspace customer where known,
principal kind, user resource or email when user-scoped, and scope set hash.
This prevents accidentally reusing a user token for the wrong workspace,
identity, or permission set.

## Resilient Transport

All Google Chat HTTP calls should go through a shared transport:

```ts
interface GoogleChatTransport {
  request<T>(request: ChatRequest<T>, options: TransportOptions): Promise<ChatResult<T>>;
}
```

The transport owns:

- Credential acquisition from `CredentialBroker`.
- Automatic refresh and single replay for token-expiry `401`.
- Retry with exponential backoff and jitter for `408`, `429`, `500`, `502`,
  `503`, `504`, and retryable network failures.
- Respect for `Retry-After`.
- Per-principal and per-space rate-limit budgets.
- Request deadlines and cancellation.
- Structured telemetry with redacted auth metadata.
- Conversion of unrecoverable failures into typed SDK errors and AI-readable
  system notes.

Local primitives should call transport methods and receive a stable result
envelope. They should not implement their own retry loops:

```ts
type ChatResult<T> =
  | {
      ok: true;
      value: T;
      principal: "app" | "user";
      attempts: number;
      warnings: string[];
    }
  | {
      ok: false;
      error: NormalizedSdkError;
      principal: "app" | "user" | null;
      attempts: number;
      aiSystemNotes: string[];
    };
```

## Retry Safety

Retries must be safe by operation class:

- Reads and list pagination can retry on transient failures.
- Edits and deletes can retry when the target resource is stable and error
  semantics are idempotent.
- Creates are only automatically retried when the API offers a stable request
  identifier or the SDK can reconcile by reading a deterministic resource. If
  not, retry stops after pre-send failures and returns a typed uncertain result.
- Streaming by edits should retry patch calls, but must preserve ordered stream
  state and never duplicate the initial create unless the create is proven safe.

This policy should live in operation metadata, not in ad hoc helper code.

## Silent Does Not Mean Invisible

The SDK should silently handle recoverable failures for application code, but
never erase them from diagnostics.

Silent:

- Refreshing an expired access token.
- Replaying once after a token-expiry `401`.
- Waiting and retrying a transient `503`.
- Backing off after `429` and respecting `Retry-After`.

Visible as structured metadata:

- Number of attempts.
- Principal actually used.
- Whether a fallback occurred.
- Rate-limit delay.
- Final non-recoverable auth or permission state.

Visible to the AI/user only when action semantics change:

- User auth is required but unavailable.
- App fallback would change visibility or authorship.
- Attachment or thread history is inaccessible under the current principal.
- A write may have had an uncertain result.

## Fallback Rules

Fallback must be explicit and narrow:

- `forbid`: fail gracefully if the requested principal cannot act.
- `allow_if_semantics_preserved`: fallback only if authorship, visibility, and
  audit semantics remain equivalent for the primitive.
- `allow_read_degraded`: return partial context with system notes rather than
  failing the whole handler.

Examples:

- A user-auth read can degrade to app-auth metadata-only context when the caller
  requested "best effort context".
- A user-auth send cannot silently become a bot-auth send unless the primitive
  was explicitly "send bot response on behalf of this app".
- A bot-auth edit cannot silently use user auth to edit a human message.
- A user-auth create/find space primitive cannot silently switch to app-auth or
  domain-wide delegation.

## Developer Experience

Runtime handlers should receive a context with pre-wired auth and transport:

```ts
chat.onMessage(async (ctx) => {
  const thread = await ctx.chat.threads.readContext({
    thread: ctx.event.thread?.name,
    auth: { principal: "either_prefer_user", fallback: "allow_read_degraded" },
    maxMessages: 25,
  });

  return ctx.reply({ text: summarize(thread) });
});
```

The handler should not know whether a token was refreshed, whether the first
request hit `503`, or whether a retry waited 800 ms. It should receive context,
warnings, or a typed capability result.

## Implementation Requirements

Each language package should add the same components:

- `auth/intents`: operation metadata and principal policy.
- `auth/broker`: app and per-user credential resolution.
- `auth/token_store`: memory, local secure store, and explicit test stores.
- `transport/retry`: retry classification, backoff, jitter, and replay budget.
- `transport/client`: Google Chat request wrapper.
- `errors`: typed normalized errors with retryability and principal metadata.
- `conformance`: shared cases for auth planning, token refresh, fallback, and
  retry decisions.

## Required Test Cases

At minimum:

- App-only primitive refuses user fallback.
- User-only primitive returns `authRequired` when no user token exists.
- User token expiring within skew refreshes before the request.
- First request receives token-expiry `401`, refreshes, and replays once.
- Refresh failure becomes a typed capability result without crashing the local
  handler.
- `429` with `Retry-After` waits according to the test clock and retries.
- `503` retries with jittered exponential backoff.
- Non-idempotent create does not blindly duplicate after an uncertain network
  failure.
- Read context degrades to app-visible metadata with AI-facing system notes when
  user auth is unavailable and fallback permits degraded reads.
- Result metadata records actual principal, attempts, fallback, and warnings.

## Non-Goals

- Do not store raw secrets in fixtures, docs, logs, or conformance expected
  files.
- Do not make a global default that allows user-to-app or app-to-user fallback.
- Do not make local primitives accept raw OAuth tokens directly.
- Do not hide unrecoverable permission failures as empty data.
- Do not make domain-wide delegation part of the default chatbot install or
  live-test path.
- Do not use admin consent to paper over a missing user OAuth grant.

## Acceptance Criteria

The feature is ready when a developer can call any live SDK primitive without
writing token refresh, retry, or rate-limit code, while still receiving explicit
auth semantics, capability metadata, and AI-facing context notes when access is
partial or unavailable.
