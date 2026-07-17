---
title: Production Auth, Retry, And Idempotency Adapters
date: 2026-07-02
type: guide
status: draft
---

# Production Auth, Retry, And Idempotency Adapters

This guide shows how production applications should keep local Google Chat
feature functions free from token-refresh, retry, and duplicate-delivery logic.

The SDK exposes shared transport primitives in both Node and Python:

- `createRetryingChatClient` / `create_retrying_chat_client`
- `requestJsonWithRetry` / `request_json_with_retry`
- `buildRetryDecision` / `build_retry_decision`
- `guardDuplicateEventDelivery` / `guard_duplicate_event_delivery`
- `InMemoryIdempotencyStore`
- `FileIdempotencyStore`
- `FirestoreIdempotencyStore`

Feature functions should ask a central client to perform a Chat operation. They
should not directly refresh OAuth tokens, sleep on `429`, retry `503`, or decide
whether an incoming event was already handled.

## Runnable Examples

Run the examples from the repository root after building the Node package:

```bash
corepack pnpm build
node examples/node-local-runtime/transport-adapters.mjs
PYTHONPATH=packages/python/src python3 examples/python-local/transport_adapters.py
```

The examples are dependency-free and do not contact Google. They simulate:

- a central token broker returning stale then refreshed user tokens;
- a user-auth read that receives `401`, refreshes silently, and replays once;
- the built-in local file idempotency store;
- an external compare-and-set idempotency adapter shaped like Redis `SET NX`,
  Firestore transaction create, SQL unique insert, or another atomic durable
  store.

They deliberately print summary metadata only. Raw access tokens are never
printed.

## Token Broker Contract

A production token broker should expose one narrow lease method:

```ts
type GetAccessToken = (input: {
  principalId: string;
  forceRefresh: boolean;
}) => Promise<{
  accessToken: string;
  tokenType?: string;
  refreshed?: boolean;
}>;
```

The Python shape is equivalent:

```python
def get_access_token(*, principal_id: str, force_refresh: bool = False) -> dict:
    return {
        "access_token": "...",
        "token_type": "Bearer",
        "refreshed": force_refresh,
    }
```

The broker owns:

- token lookup by Chat app, Workspace/customer, user, and required scope set;
- pre-emptive refresh before expiry with a skew buffer;
- single-flight refresh so many concurrent requests do not stampede the refresh
  token;
- one forced refresh after a Google `401`;
- secure storage of refresh tokens and encrypted access-token cache entries.

Local feature functions receive a high-level client. They should not receive raw
refresh tokens.

## Retrying Chat Calls

Use the shared retrying Chat client for feature code:

```ts
const chat = createRetryingChatClient({
  principal: "user",
  getAccessToken: ({ forceRefresh }) =>
    tokenBroker.getAccessToken({ principalId, forceRefresh }),
});

await chat.get("spaces", { query: { pageSize: 10 } });
```

```python
chat = create_retrying_chat_client(
    principal="user",
    get_access_token=lambda force_refresh=False: token_broker.get_access_token(
        principal_id=principal_id,
        force_refresh=force_refresh,
    ),
    send=send_google_request,
)

chat.get("spaces", query={"pageSize": 10})
```

Use the lower-level retry wrapper when building a custom client:

```ts
await requestJsonWithRetry(
  {
    url: "https://chat.googleapis.com/v1/spaces?pageSize=10",
    method: "GET",
    principal: "user",
  },
  {
    getAccessToken: ({ forceRefresh }) =>
      tokenBroker.getAccessToken({ principalId, forceRefresh }),
  },
);
```

```python
request_json_with_retry(
    method="GET",
    url="https://chat.googleapis.com/v1/spaces?pageSize=10",
    principal="user",
    get_access_token=lambda force_refresh=False: token_broker.get_access_token(
        principal_id=principal_id,
        force_refresh=force_refresh,
    ),
    send=send_google_request,
)
```

The wrapper handles:

- silent refresh and one replay after `401`;
- `Retry-After` for `429`;
- bounded retry for `408`, `500`, `502`, `503`, `504`, and retryable network
  failures;
- refusal to replay unsafe writes.

Set `idempotent: true` only when the request is safe to replay. For Chat message
creation, that usually means the request uses a stable `messageId` query
parameter or another Google-supported idempotency key.

## Raw Response Fetches

Not every Google call returns JSON. Media downloads, Drive exports, and other
binary fetches should still use the same retry classifier:

- get the access token from the central broker;
- call `buildRetryDecision` / `build_retry_decision` on `401`, `429`, `408`,
  `500`, `502`, `503`, `504`, and retryable network failures;
- refresh once on `401`;
- retry only replay-safe reads or writes with an explicit idempotency key;
- return the raw response body to the feature function.

The live smoke tooling follows this split: JSON app/user calls go through
`requestJsonWithRetry`, while raw media and Drive bodies use a raw-response
helper that shares the same retry decision function.

## Duplicate Delivery Idempotency

Incoming Chat webhooks can be delivered more than once. Claim the normalized
event idempotency key before any side effect:

```ts
const delivery = await guardDuplicateEventDelivery(event, {
  store: idempotencyStore,
  ttlMs: 10 * 60 * 1000,
});

if (delivery.duplicate) {
  return delivery.responseBody;
}
```

```python
delivery = guard_duplicate_event_delivery(
    event,
    store=idempotency_store,
    ttl_ms=10 * 60 * 1000,
)

if delivery["duplicate"]:
    return delivery["responseBody"]
```

The built-in `InMemoryIdempotencyStore` is for tests and warm single-instance
development. The built-in `FileIdempotencyStore` is for local development and
single-instance smoke testing only.

Production duplicate suppression must use an atomic external store. Acceptable
patterns include:

- Redis `SET key value NX PX ttl` followed by an increment/update path for
  duplicates;
- Firestore document create with the event key as the document id;
- SQL insert into a table with a unique key constraint on the event key;
- DynamoDB conditional put with a TTL attribute.

The external adapter must make the first claim and the duplicate decision in one
atomic operation. A read-then-write implementation is not sufficient for
multi-instance Cloud Run.

The package now includes `FirestoreIdempotencyStore` in Node and Python. It
uses conditional document creation and update-time compare-and-set through an
injected authenticated Firestore REST transport. The application supplies its
own OAuth, service-account, or emulator transport; the SDK does not read or
store credentials. See [Production Hardening Boundaries](2026-07-10-production-hardening.md)
for the native option names and Cloud Run integration boundary.

## Directory Identity Enrichment

Sender humanization beyond Chat-provided display names is optional. The helper
surface now plans `users.list` against the Admin SDK Directory API using:

- scope `https://www.googleapis.com/auth/admin.directory.user.readonly`;
- `viewType=domain_public`;
- `projection=BASIC`;
- user-auth mode, not domain-wide delegation.

This is an Admin SDK endpoint name, but the `domain_public` view asks only for
fields visible within the domain. Tenants can still block the scope or require
admin approval. A `403`, `401`, `404`, or unavailable Directory API must be
handled as an enrichment miss; Chat event handling should continue with explicit
`access_limited` identity notes.

The SDK caches directory users by Google user id, primary email, and aliases.
Directory sync never hard-deletes missing users: historical messages still need
human context. Missing users are marked `stale` so model context can say the
directory record may be out of date.

Conversation context enrichment is opt-in at the model handoff boundary:

- Node: call `buildConversationContextWithIdentity(input, responses, { identityCache })`.
- Python: call `build_conversation_context_with_identity(input, responses, identity_cache=cache)`.

The wrapper leaves the baseline context builder unchanged, then recursively
enriches top-level messages and quoted messages. Directory hits replace raw
`users/...` labels with display name, email, source, directory status, stale
state, and an AI-facing system note. Cache misses remain non-fatal and are
represented as explicit access-limited identity context. If the cache itself is
unavailable, the wrapper returns the baseline context and adds one root system
note that identity enrichment was skipped.

## Optional Pub/Sub Ingestion

Ordinary Google Chat app invocations do not require Pub/Sub. The direct Chat app
webhook path posts to the configured HTTPS endpoint.

Pub/Sub is only used by the optional Workspace Events API path, where Google
publishes resource-change events such as Chat message create/update/delete to a
topic. Keep this path separate from normal direct interaction handling.

## Google Endpoint Drift Probes

Some docs-listed or emerging read surfaces are intentionally tracked as live
drift probes:

- `spaces.spaceEvents.list` reached Google in the private live test tenant but
  returned HTTP 500 after bounded retries.
- `spaces.messages.search` and `spaces.messagePins.list` returned HTTP 404 and
  were not present in the current discovery method set.

Treat those outcomes as endpoint availability/rollout mismatches, not ordinary
token refresh failures. Permission problems normally surface as `401` or `403`
and are handled by the central retry/auth layer.

## Caching Strategy

The base SDK now includes dependency-free content-addressed cache helpers:

- attachment/document bytes are keyed by source id plus byte SHA-256;
- parser outputs include processor name/version/options in the cache key;
- transcription outputs include provider/model/options in the cache key;
- inaccessible resources can be negative-cached with a short TTL;
- raw bytes and transcripts stay out of committed logs and reports.

Production deployments can back these interfaces with Redis, Firestore, SQL, or
SQLite. The local file caches are for development and smoke evidence only.

## Principal Safety

Every local primitive should declare whether it acts as:

- `user`: uses the installing user's OAuth grant;
- `app`: uses Chat app credentials for app-owned messages and app-visible reads;
- `admin`: requires explicit admin approval and should not be used for normal
  user-installed chatbot flows.

This project currently keeps the private live test tenant setup on the
user-installed path. Do not widen to domain-wide delegation or admin access
unless a feature explicitly requires it and the operator approves that change.
