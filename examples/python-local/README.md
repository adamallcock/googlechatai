# Python Local Example

Implemented example. A stdlib-only `ThreadingHTTPServer` that wires a
`GoogleChatAI` instance to `/chat/events` and `/healthz`, with no optional
framework dependencies, for local Google Chat event fixture POSTs without
any live Google Chat calls.

## Run it

From the repository root:

```bash
PYTHONPATH=packages/python/src python3 examples/python-local/server.py
```

Add `--host` / `--port` to override the default `127.0.0.1:8787`. POST a
fixture from `fixtures/events/` to `/chat/events`; `GET /healthz` returns
`{"ok": true}`.

## Import path note

`server.py` puts `packages/python/src` on `PYTHONPATH` because the
`googlechatai` package can also be installed from the registry. Alternatively, install
it normally (`pip install googlechatai`) and drop the `PYTHONPATH` prefix.
