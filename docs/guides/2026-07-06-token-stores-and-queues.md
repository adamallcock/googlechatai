---
title: Token Stores And Queues
date: 2026-07-06
type: guide
status: implemented
---

# Token Stores And Queues

Two small, dependency-light pieces support production auth and async-response
delivery: a `TokenStore` for persisting OAuth token records across restarts,
and an `AsyncResponseQueue` for handing off deferred work to a real queue
instead of an in-process `Map`. Both ship as parallel Node/Python
implementations, and the file-backed variants share one JSON file format so
either language can read a file the other wrote.

## Node

```ts
import {
  FileTokenStore,
  getAccessTokenFromStore,
  FileAsyncResponseQueue,
} from "googlechatai";

const store = new FileTokenStore({ filePath: "./.tokens/tokens.json" });
await store.save({
  principalId: "users/alice",
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: "2026-07-06T12:00:00.000Z",
  tokenType: "Bearer",
});

const getAccessToken = getAccessTokenFromStore({
  store,
  principalId: "users/alice",
  refresh: async (record) => ({
    ...record,
    accessToken: "refreshed-token",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }),
});

const lease = await getAccessToken({ forceRefresh: false });

const queue = new FileAsyncResponseQueue({ filePath: "./.tokens/queue.json" });
await queue.enqueue({ kind: "chat.async_response_task", taskId: "task-1" });
```

## Python

```python
from googlechatai import (
    FileTokenStore,
    TokenRecord,
    get_access_token_from_store,
    FileAsyncResponseQueue,
)

store = FileTokenStore("./.tokens/tokens.json")
store.save(
    TokenRecord(
        principal_id="users/alice",
        access_token="access-1",
        refresh_token="refresh-1",
        expires_at="2026-07-06T12:00:00.000Z",
        token_type="Bearer",
    )
)

def refresh(record: TokenRecord) -> TokenRecord:
    record.access_token = "refreshed-token"
    record.expires_at = "2026-07-06T13:00:00.000Z"
    return record

get_access_token = get_access_token_from_store(
    store=store, principal_id="users/alice", refresh=refresh
)
lease = get_access_token(force_refresh=False)

queue = FileAsyncResponseQueue("./.tokens/queue.json")
queue.enqueue({"kind": "chat.async_response_task", "taskId": "task-1"})
```

## TokenStore Implementations

`TokenStore` (Node interface, Python Protocol) exposes `load(principalId)`,
`save(record)`, `delete(principalId)`, `list()`. A `TokenRecord` carries
`principalId`, `accessToken`, `refreshToken`, `expiresAt` (ISO string),
`scopes`, `tokenType`, and a free-form `metadata` map.

- **`InMemoryTokenStore`** — backed by a `Map`/`dict`, for tests and local
  runs. Deep-clones records on save and load so callers can't mutate internal
  state through references they hold.
- **`FileTokenStore`** — persists to a single JSON file. Same-runtime
  read-modify-write operations are serialized per path; writes use a randomly
  named sibling temp file and atomic replacement, followed by best-effort
  `chmod` to `0600`. Node also creates parent directories with mode `0700`.
  A missing file is treated as empty rather than an error. This remains a
  local/single-host helper, not a cross-process or multi-instance lock. The
  file format is the cross-language contract:

  ```json
  {
    "version": 1,
    "records": {
      "users/alice": {
        "principalId": "users/alice",
        "accessToken": "access-1",
        "refreshToken": "refresh-1",
        "expiresAt": "2026-07-06T12:00:00.000Z",
        "scopes": ["scope-a"],
        "tokenType": "Bearer",
        "metadata": { "note": "hi" }
      }
    }
  }
  ```

  Keys inside each record are always the camelCase field names shown above,
  regardless of which language wrote the file — Python's `TokenRecord`
  explicitly translates to/from this exact key set, which is what lets a file
  written by the Node package be loaded by the Python package and vice versa.
- **`SecretManagerTokenStore`** — backs each principal with a Google Secret
  Manager secret named `<secretPrefix><slugified-principal-id>` (default
  prefix `chat-token-`). It requires an injected HTTP transport and token
  source at construction time — there is no implicit global-fetch fallback:

  ```ts
  new SecretManagerTokenStore({
    projectId: "my-project",
    fetch, // (url, init) => Promise<Response>
    getAccessToken, // (input) => Promise<AccessTokenLease>
  });
  ```

  ```python
  SecretManagerTokenStore(
      project_id="my-project",
      send=send,  # (request_dict) -> {"ok", "status", "json", "headers"}
      get_access_token=get_access_token,
  )
  ```

  Node's injected callable is `fetch`, an async WHATWG-fetch-shaped function
  you call `.text()`/`.json()` on. Python's is `send`, a synchronous
  dict-in/dict-out callable that already returns pre-parsed JSON. `save`
  tries `secrets:addVersion` first and creates the secret via `secrets/create`
  only if it doesn't exist yet; `load`/`delete` tolerate a 404 as "not found";
  `list` paginates by `filter=name:<secretPrefix>` and strips the prefix back
  to principal IDs. On any other non-OK response, both throw a
  status-and-identifier-only error (for example `Secret Manager POST 500 for
  chat-token-users-alice`) and never include the response body — this is a
  deliberate guard against leaking token material through error messages or
  logs.

## `getAccessTokenFromStore` Refresh Flow

`getAccessTokenFromStore` / `get_access_token_from_store` wraps a `TokenStore`
and a `refresh` callback into a single `getAccessToken` function shaped like
any other token source in this SDK (the same shape `executeChatPlan`'s `auth`
option expects):

1. Load the record for `principalId`. If none exists, throw/raise
   `No token record found for principal <id>.`
2. If `forceRefresh` is not set and the record is still fresh, return its
   cached `accessToken` with `refreshed: false`.
3. Otherwise call `refresh(record)`, save the returned record back to the
   store, and return the new `accessToken` with `refreshed: true`.

A record counts as fresh only if it has an `accessToken` and either has no
`expiresAt` at all, or has one more than 60 seconds in the future — tokens
within 60 seconds of expiry are treated as stale and proactively refreshed.
Node's `refresh` callback returns a `Promise<TokenRecord>`; Python's `refresh`
is a plain synchronous function returning a `TokenRecord`.

## AsyncResponseQueue Implementations

`AsyncResponseQueue` exposes `enqueue(task)`, `dequeue()`, `list()`,
`drain(limit?)`. This is distinct from the synchronous in-process
`InMemoryAsyncResponseQueue` used by the async response kit — these adapters
back real queue services.

- **`FileAsyncResponseQueue`** — a JSON-file FIFO with the same same-runtime
  lock, atomic replacement, and `0600` discipline as `FileTokenStore`, using
  a `{ "version": 1, "tasks": [...] }` file shape. Fully supports
  `enqueue`/`dequeue`/`list`/`drain` for local use.
- **`CloudTasksQueueAdapter`** — `enqueue` POSTs to
  `{baseUrl}/v2/{queuePath}/tasks` with the task body base64-encoded into
  `task.httpRequest.body`, targeting `targetUrl`. Supplying
  `serviceAccountEmail` adds an `oidcToken.serviceAccountEmail` field so Cloud
  Tasks authenticates its push call; omitting it leaves `oidcToken` out
  entirely.
- **`PubSubQueueAdapter`** — `enqueue` POSTs to `{baseUrl}/v1/{topic}:publish`
  with the task body base64-encoded into `messages[0].data` and `taskId`
  carried as a message attribute.

Both Cloud service adapters need an injected transport and token source at
construction, same as `SecretManagerTokenStore` (Node: `fetch` +
`getAccessToken`; Python: `send` + `get_access_token`), and both redact error
bodies the same way (`Cloud Tasks POST 500 for <queuePath>` /
`Pub/Sub POST 503 for <topic>`, with no response body attached).

## Pull-Methods-Throw Semantics

Cloud Tasks and Pub/Sub only deliver work by push — Cloud Tasks invokes your
`targetUrl`, and a Pub/Sub push subscription invokes your endpoint. There is
nothing to pull from either adapter's perspective, so `dequeue`, `list`, and
`drain` on both `CloudTasksQueueAdapter` and `PubSubQueueAdapter` unconditionally
throw the same error:

```
Cloud Tasks delivers tasks by push; dequeue is not supported.
```

(The message names "Cloud Tasks" even on the Pub/Sub adapter — it's a shared
constant reused by both, not a bug worth working around in application code.)
Only `enqueue` is meaningful on these two adapters; use `FileAsyncResponseQueue`
or a worker that reads its own push endpoint's incoming requests instead of
polling for tasks.

## Production Boundary

Implemented:

- Node/Python `TokenStore` parity: in-memory, file-backed with a shared
  cross-language JSON file format, and Secret Manager-backed with injected
  transport.
- `getAccessTokenFromStore` / `get_access_token_from_store` refresh flow with
  a 60-second freshness margin.
- Node/Python `AsyncResponseQueue` parity: file FIFO, Cloud Tasks push
  adapter, Pub/Sub publish adapter, with consistent pull-methods-throw
  semantics on the two push adapters.
- Same-runtime serialized file writes, random temporary files, atomic
  replacement, and `0600` permission enforcement for both file-backed stores.

Cross-language note: Node and Python create parent directories with `0700`
where the platform honors POSIX modes. The files themselves end up `0600` in
both languages regardless.
