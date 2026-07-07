---
title: Python Fixture Normalizer Example
date: 2026-06-29
type: note
status: draft
---

# Python Fixture Normalizer Example

This is the currently implemented Python example surface: parse a local Google
Chat event fixture into the shared normalized event envelope.

## Status

- Implemented: `googlechatai.normalize_event` and additional local/dry-run
  helpers for actions, messages, attachments, cards, runtime routing, thread
  context, and Workspace Events.
- Implemented: Python tests read shared fixtures and expected outputs.
- Implemented: `examples/python-local` accepts local fixture POSTs.
- Implemented: `examples/python-fastapi` shows the optional FastAPI adapter.
- Planned: inbound Google request verification and live send/reply execution
  beyond the guarded smoke harness.

## Test The Existing Example

```bash
pnpm test:python
```

The test file is:

```text
packages/python/tests/test_events.py
```

## Run A Local Fixture Parse

```bash
PYTHONPATH=packages/python/src python3 <<'PY'
import json
from pathlib import Path

from googlechatai import normalize_event

raw = json.loads(Path("fixtures/events/message-created/basic.json").read_text())

print(json.dumps(normalize_event(raw, source="fixture"), indent=2))
PY
```

## API Shape Available Today

```python
from googlechatai import normalize_event

event = normalize_event(raw_google_chat_event, source="fixture")

print(event["kind"])
print(event["message"]["plainTextForModel"])
```

## Current Limitations

Do not present the following as shipped Python SDK behavior yet:

- Google Chat request verification.
- Live send, reply, thread, or streaming execution outside W7.
- Live attachment download, upload, extraction, or transcription execution.
- Production auth token refresh/retry transport.
