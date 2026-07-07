# Python FastAPI Example

Implemented example. Shows the optional `FastAPIAdapter` mounting a
`GoogleChatAI` instance at `/chat/events` on a FastAPI app, for local Google
Chat event fixture POSTs without any live Google Chat calls.

## Run it

Install the optional extras, then run from the repository root:

```bash
pip install "fastapi>=0.138.2,<0.139.0" "uvicorn[standard]>=0.49.0,<0.50.0"
PYTHONPATH=packages/python/src uvicorn app:app --app-dir examples/python-fastapi --host 127.0.0.1 --port 8787
```

POST a fixture from `fixtures/events/` to `/chat/events`; `GET /healthz`
returns `{"ok": true}`.

## Import path note

`app.py` puts `packages/python/src` on `PYTHONPATH` because `googlechatai`
can also be installed from the registry. Alternatively, install with
`pip install "googlechatai[fastapi]"` and drop `PYTHONPATH`.
