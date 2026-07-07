---
title: Inbound Request Verification
date: 2026-07-06
type: guide
status: implemented
---

# Inbound Request Verification

Without verification, any POST to a Chat app's webhook endpoint is treated as
a real Google Chat event — there is nothing that stops an attacker from
forging an event payload and hitting the endpoint directly. This module
verifies the bearer JWTs Google attaches to two kinds of inbound HTTP
delivery: direct Chat app events (signed by the Chat system service account)
and Pub/Sub push deliveries for Workspace Events (a general Google OIDC
token). It is implemented with each language's standard library only — no
`jsonwebtoken`, no `pyjwt`, no `cryptography` — so verification stays
dependency-free.

## Node

```ts
import {
  GoogleChatAI,
  createChatRequestVerifier,
  verifyGoogleChatToken,
} from "googlechatai";

// Offline verification against inline JWKS keys (no network call).
const result = verifyGoogleChatToken(token, {
  keys: [jwk],
  audience: "123456789012",
  nowMs: Date.now(),
});
console.log(result.status); // "verified" | "expired" | "wrong_audience" | ...

// Wired into the router: any unverified POST gets a 401 before any handler runs.
const chat = new GoogleChatAI({
  verifier: createChatRequestVerifier({ audience: "123456789012" }),
});
```

## Python

```python
from googlechatai import verify_google_chat_token
from googlechatai.verify import create_google_chat_token_verifier
from googlechatai.adapters.asgi import ASGIAdapter
from googlechatai.router import GoogleChatAI

# Offline verification against inline JWKS keys.
result = verify_google_chat_token(
    token, keys=[jwk], audience="123456789012", now_ms=now_ms
)
print(result["status"])

# Wired into an ASGI app: verification lives on the adapter, not the router.
chat = GoogleChatAI()
verifier = create_google_chat_token_verifier(audience="123456789012")
app = ASGIAdapter(chat, verifier=verifier)
```

## Offline Verification: `verifyGoogleChatToken` / `verify_google_chat_token`

Both functions are synchronous and take JWKS keys inline — no network call.
Node's signature:

```ts
verifyGoogleChatToken(
  token: string | null | undefined,
  options: {
    keys: JsonObject[];
    audience: string | string[];
    issuers?: string[];
    nowMs?: number;
    clockSkewMs?: number;
    expectedEmail?: string | null;
    requireEmailVerified?: boolean;
  },
): JwtVerificationResult
```

Python's accepts either the same camelCase options mapping (for the shared
JSON contract used by conformance fixtures) or idiomatic snake_case keyword
arguments, with keyword arguments winning on conflict:

```python
verify_google_chat_token(token, {"keys": [...], "audience": "...", "nowMs": ...})
# or
verify_google_chat_token(token, keys=[...], audience="...", now_ms=...)
```

Verification runs in this order: missing-token check, structural JWT decode,
algorithm must be `RS256`, JWK lookup by `kid`, RSASSA-PKCS1-v1_5/SHA-256
signature check, issuer allow-list check, audience match, not-yet-valid check
against `nbf`/`iat` with clock skew, expiry check against `exp` with clock
skew, and optional `expectedEmail`/`requireEmailVerified` checks.

### `JwtVerificationStatus`

The result's `status` field is one of:

- `verified` — the only status where `ok` is `true`.
- `missing_token` — no bearer token was provided.
- `malformed` — not a structurally valid JWT.
- `unsupported_algorithm` — the token's `alg` is not `RS256`.
- `unknown_key` — no JWKS key matches the token's `kid`.
- `bad_signature` — signature verification failed.
- `wrong_issuer` — the token's `iss` is not an accepted issuer.
- `wrong_audience` — the token's `aud` does not match the expected audience.
- `not_yet_valid` — the token is not valid yet beyond allowed clock skew.
- `expired` — the token is expired beyond allowed clock skew (or has no `exp`
  claim at all).
- `wrong_email` — the token's `email` does not match `expectedEmail`.
- `email_not_verified` — an `email` claim is present but `email_verified` is
  not `true`, while `requireEmailVerified` is set.
- `keys_unavailable` — JWKS fetch failed (only produced by the fetch-based
  verifier, never by direct offline verification with inline keys).

## Fetch-Based Verifier: `createGoogleChatTokenVerifier` / `create_google_chat_token_verifier`

Wraps offline verification with a JWKS fetch, an in-memory cache, and a
single unknown-kid refresh:

```ts
const verifier = createGoogleChatTokenVerifier({
  audience: "123456789012",
  fetch, // optional; defaults to globalThis.fetch
  cacheTtlMs: 3_600_000, // default: 1 hour
});
const result = await verifier.verify(token);
```

```python
verifier = create_google_chat_token_verifier(
    audience="123456789012",
    send=send,  # optional; defaults to a urllib-based sender
    cache_ttl_ms=3_600_000,
)
result = verifier.verify(token)
```

JWKS keys are fetched from `GOOGLE_CHAT_JWKS_URL` by default and cached for
`cacheTtlMs` (default one hour). If verification comes back `unknown_key` —
meaning the token's `kid` isn't in the cached key set, which happens right
after Google rotates its signing keys — the verifier forces exactly one JWKS
refresh (bypassing the cache TTL) and re-verifies once more with the fresh
keys. There is no further retry after that; a persistent `unknown_key` after
the forced refresh is reported as-is. If the JWKS fetch itself fails, the
result comes back `keys_unavailable` with a message naming the URL and the
underlying error.

Node's injected `fetch` is an async, WHATWG-fetch-shaped function
(`(url) => Promise<Response>`). Python's injected `send` is a **synchronous**
dict-in/dict-out callable — `send({url, method, headers, body}) -> {ok,
status, headers, json}` — and `GoogleChatTokenVerifier.verify()` itself is
synchronous in Python even though it is normally called from async adapter
code.

## Pub/Sub Push Verifier: `createPubSubPushVerifier` / `create_pubsub_push_verifier`

A thin wrapper over the fetch-based verifier that swaps in Google's general
OIDC issuers and JWKS endpoint instead of the Chat-specific ones, for
verifying Workspace Events Pub/Sub push deliveries:

```ts
const verifier = createPubSubPushVerifier({
  audience: "https://example.com/chat/events", // the push endpoint URL
  serviceAccountEmail: "chat-push@my-project.iam.gserviceaccount.com",
});
```

```python
verifier = create_pubsub_push_verifier(
    audience="https://example.com/chat/events",
    service_account_email="chat-push@my-project.iam.gserviceaccount.com",
)
```

Differences from the Chat-token verifier: `issuers` defaults to
`["https://accounts.google.com", "accounts.google.com"]`, `jwksUrl` defaults
to Google's general OIDC certs endpoint, `audience` is the full HTTPS push
endpoint URL (not a Chat project number), and `serviceAccountEmail` is checked
against the token's `email` claim. Supplying `serviceAccountEmail` also
auto-enables `requireEmailVerified`, so a push token with an unverified email
claim is rejected even if the email itself matches.

## Node Router Wiring: 401 On Failure

`GoogleChatAI` accepts a `verifier` constructor option — a function taking a
`Request` and returning a verification result. `createChatRequestVerifier`
builds one from the same options as the fetch-based verifier, reading the
bearer token from the request's `authorization` header:

```ts
const chat = new GoogleChatAI({
  verifier: createChatRequestVerifier({ audience: "<project number>" }),
});
```

The check runs inside `GoogleChatAI.fetch()`, after the method check but
before the event body is parsed — no handler runs until verification passes.
Two distinct failure modes:

- The verifier **returns** a result with `ok !== true` (bad signature, wrong
  audience, expired, and so on) → **HTTP 401** with
  `{ error: { code: "unauthorized_request", message: "..." } }`.
- The verifier function itself **throws** (for example, a JWKS fetch network
  error not caught internally) → **HTTP 500** with
  `{ error: { code: "verification_unavailable", message: "..." } }`.

Both outcomes are logged before responding (`chat.event.unauthorized` /
`chat.event.verifier_error`), and in either case the registered event handlers
never run.

## Python Wiring: `ASGIAdapter(chat, verifier=...)` / `mount_fastapi(..., verifier=...)`

In Python, the verifier is a property of the transport adapter, not of
`GoogleChatAI` itself — `GoogleChatAI()` has no `verifier` constructor option:

```python
from googlechatai.adapters.asgi import ASGIAdapter
from googlechatai.adapters.fastapi import mount_fastapi

app = ASGIAdapter(chat, verifier=verifier)

# or, mounting onto an existing FastAPI app:
mount_fastapi(fastapi_app, chat, verifier=verifier)
```

Both adapters check the verifier after the path/method checks and before
parsing the JSON body, returning `{"error": "unauthorized_request", "status":
"<JwtVerificationStatus>"}` with HTTP 401 when `verification["ok"]` is not
`true`. `mount_fastapi` requires the optional `fastapi` extra
(`pip install 'googlechatai[fastapi]'`); the core package stays
dependency-free without it.

## Offline Fixtures

Test fixtures live under `fixtures/verify/`:

- `fixtures/verify/jwks.json` — a single committed RSA JWK (public key only).
- `fixtures/verify/tokens.json` — pre-signed JWTs for every status case
  (`validChat`, `expiredChat`, `wrongAudience`, `unknownKid`, `badSignature`,
  `pubsubValid`, `pubsubWrongEmail`, and more), plus a `note` field stating the
  signing key is throwaway test material generated for this repository and
  that the private key was discarded after signing. Only the public key
  (`n`/`e`) is committed, which is safe by design — the point of a public key
  is that it can be shared.

These back both the Node/Python unit tests and the shared
`conformance/cases/verify.token.json` cases, so both languages are asserted to
produce byte-identical verification results for the same token/options input.

## Python's Stdlib-Only RSASSA-PKCS1-v1_5 Implementation

Node delegates RS256 signature checks to `node:crypto`. Python has no
built-in JWT verifier and avoids adding a dependency, so it reimplements
RSASSA-PKCS1-v1_5 signature verification by hand using only `hashlib`,
`hmac`, and Python's arbitrary-precision integers: it decodes the JWK's `n`
and `e` into integers, computes `signature^e mod n` via Python's built-in
`pow(base, exp, mod)`, reconstructs the expected PKCS#1 v1.5 padded SHA-256
digest structure, and compares the two with `hmac.compare_digest` (a
constant-time comparison, guarding the final comparison step against a timing
side channel). It rejects malformed keys, wrong signature lengths, or
malformed base64url input by returning `False` rather than raising. This is
functionally equivalent to Node's native-crypto verification, confirmed by
both languages producing identical results across the shared conformance
fixtures.

## Clock Skew And Audience Options

- `clockSkewMs` / `clock_skew_ms` defaults to 5 minutes (`300_000` ms),
  applied symmetrically: `nbf`/`iat` must not be more than this far in the
  future, and `exp` must not be more than this far in the past.
- `audience` accepts a single string or an array; a token's `aud` claim (also
  either a string or array) matches if any value overlaps any expected
  audience.
- `issuers` can be overridden per verifier; defaults differ between the
  Chat-token verifier (`chat@system.gserviceaccount.com`) and the Pub/Sub push
  verifier (Google's general OIDC issuers).
- `now` / `now_ms` lets tests inject a fixed clock instead of the wall clock.

## Production Boundary

Implemented:

- Node/Python offline verification parity (`verifyGoogleChatToken` /
  `verify_google_chat_token`), covering all 13 `JwtVerificationStatus`
  values.
- Fetch-based verifier with JWKS caching and single unknown-kid refresh, in
  both languages.
- Pub/Sub push OIDC verifier with audience and service-account email checks.
- Node router `verifier` option with 401/500 handling; Python `ASGIAdapter`
  and `mount_fastapi` `verifier` options with 401 handling.
- Shared conformance (`conformance/cases/verify.token.json`) and offline
  throwaway-key fixtures under `fixtures/verify/`.
