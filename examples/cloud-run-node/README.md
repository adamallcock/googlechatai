# Cloud Run Node Example

Scaffolded example (W0-owned). A dependency-free `node:http` dev webhook with
`/healthz`, `/avatar.png`, and `/chat/events` (also under `/api`), used as the
guarded live-smoke target described in
`docs/runbooks/2026-06-29-live-chat-smoke-harness.md`.

## Run it locally

From this directory:

```bash
PORT=8080 node server.mjs
```

`GET http://127.0.0.1:8080/healthz` returns `{ "ok": true, ... }`. POST a
Google Chat event payload to `/chat/events` to see the logged summary and
response. `Dockerfile` builds a `node:22-slim` image for Cloud Run deploys.

## Import path note

`server.mjs` uses only Node built-ins and does not import
`googlechatai`. A future SDK-routed revision should prefer
`../../packages/node/dist/index.js` until published, then switch to the
package import.
