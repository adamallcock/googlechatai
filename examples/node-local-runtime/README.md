# Node Local Runtime Example

Implemented example. A plain `node:http` server that wires a `GoogleChatAI`
instance to `/chat/events` and `/healthz`, so you can POST local Google Chat
event fixtures and see normalized message/mention/card-click/dialog handling
without any live Google Chat calls.

## Run it

From the repository root:

```bash
corepack pnpm build
node examples/node-local-runtime/server.mjs
```

Listens on `http://127.0.0.1:8787` (override with `PORT`). POST a fixture
from `fixtures/events/` to `/chat/events`; `GET /healthz` returns `{ "ok": true }`.

## Import path note

`server.mjs` imports the SDK via `../../packages/node/dist/index.js` because
`googlechatai` can also be installed from the registry. Run `pnpm build` first so
`dist/` exists. After publishing, switch to the package import.
