from __future__ import annotations

import importlib.util
import json
import pathlib
import sys


def load_module(path: pathlib.Path):
    spec = importlib.util.spec_from_file_location("googlechatai_replay_handler", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to import handler: {path}")
    sys.path.insert(0, str(path.parent))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: python-replay.py HANDLER FIXTURE")
    handler_path = pathlib.Path(sys.argv[1]).resolve()
    fixture_path = pathlib.Path(sys.argv[2]).resolve()
    module = load_module(handler_path)
    chat = getattr(module, "chat", None)
    if chat is None or not callable(getattr(chat, "dispatch", None)):
        raise TypeError("Python handler module must export `chat` with dispatch().")
    payload = json.loads(fixture_path.read_text(encoding="utf-8"))
    result = chat.dispatch(payload, source="fixture")
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
