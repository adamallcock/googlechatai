"""Live streaming of model output through Google Chat message edits.

A pure, deterministic scheduler decides when accumulated stream chunks
justify a message patch (cadence, patch budget with a reserved final
patch, message-size truncate/split, failure degradation). Language
drivers wrap it: ``stream_chat_reply`` consumes a synchronous iterable,
``astream_chat_reply`` an async iterable. The scheduler is shared with
the Node SDK through conformance fixtures, so its JSON state and action
shapes must not drift.
"""

from __future__ import annotations

import inspect
import json
import math
import os
import time
from pathlib import Path
from typing import Any, AsyncIterable, Callable, Iterable, Mapping

from ..transport import create_retrying_chat_client
from .._file_state import atomic_write_text, file_state_lock

STATE_KIND = "chat.stream_scheduler_state"
REPLAY_KIND = "chat.stream_scheduler_replay"
REPORT_KIND = "chat.stream_report"
_PLACEHOLDER_HANDLE_KIND = "chat.placeholder_response_handle"

_DEFAULT_MIN_PATCH_CHARS = 120
_DEFAULT_MIN_INTERVAL_MS = 1000
_DEFAULT_MAX_PATCHES = 20
_DEFAULT_MAX_MESSAGE_CHARS = 4000
_DEFAULT_TRUNCATION_NOTE = (
    "\n\n[Output truncated: Google Chat message size limit reached.]"
)
_DEFAULT_CONTINUATION_PREFIX = "(continued)\n"
_DEFAULT_CONTINUATION_PLACEHOLDER = "…"
_DEFAULT_CANCEL_NOTE = "\n\n[Stopped at user request.]"
_DEFAULT_ERROR_NOTE = "\n\n[Response interrupted by an error.]"
_DEFAULT_EMPTY_FINAL_TEXT = "No response was generated."
_DEFAULT_MAX_CONSECUTIVE_PATCH_FAILURES = 3

JsonObject = dict[str, Any]


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _as_record(value: Any) -> JsonObject | None:
    return value if isinstance(value, dict) else None


def _as_array(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    return value if isinstance(value, (int, float)) else None


def _positive_number(value: Any, fallback: float) -> float:
    number = _as_number(value)
    return number if number is not None and number > 0 else fallback


def _non_negative_number(value: Any, fallback: float) -> float:
    number = _as_number(value)
    return number if number is not None and number >= 0 else fallback


def _resolved_config(config: Mapping[str, Any] | None) -> JsonObject:
    config = dict(config or {})
    overflow = config.get("overflow", "truncate")
    if overflow not in ("truncate", "split"):
        raise TypeError("Expected overflow to be either truncate or split.")
    min_interval = config.get("minIntervalMs")
    if min_interval is None:
        min_interval = config.get("throttleMs")
    return {
        "minPatchChars": _positive_number(
            config.get("minPatchChars"), _DEFAULT_MIN_PATCH_CHARS
        ),
        "minIntervalMs": _non_negative_number(
            min_interval, _DEFAULT_MIN_INTERVAL_MS
        ),
        "maxPatches": max(
            1,
            int(math.floor(_positive_number(config.get("maxPatches"), _DEFAULT_MAX_PATCHES))),
        ),
        "maxMessageChars": max(
            80,
            int(
                math.floor(
                    _positive_number(
                        config.get("maxMessageChars"), _DEFAULT_MAX_MESSAGE_CHARS
                    )
                )
            ),
        ),
        "overflow": overflow,
        "prefix": config.get("prefix", "") or "",
        "suffix": config.get("suffix", "") or "",
        "typingIndicator": config.get("typingIndicator", "") or "",
        "truncationNote": (
            config["truncationNote"]
            if isinstance(config.get("truncationNote"), str)
            else _DEFAULT_TRUNCATION_NOTE
        ),
        "continuationPrefix": (
            config["continuationPrefix"]
            if isinstance(config.get("continuationPrefix"), str)
            else _DEFAULT_CONTINUATION_PREFIX
        ),
        "cancelNote": (
            config["cancelNote"]
            if isinstance(config.get("cancelNote"), str)
            else _DEFAULT_CANCEL_NOTE
        ),
        "errorNote": (
            config["errorNote"]
            if isinstance(config.get("errorNote"), str)
            else _DEFAULT_ERROR_NOTE
        ),
        "emptyFinalText": (
            config["emptyFinalText"]
            if isinstance(config.get("emptyFinalText"), str)
            else _DEFAULT_EMPTY_FINAL_TEXT
        ),
        "maxConsecutivePatchFailures": max(
            1,
            int(
                math.floor(
                    _positive_number(
                        config.get("maxConsecutivePatchFailures"),
                        _DEFAULT_MAX_CONSECUTIVE_PATCH_FAILURES,
                    )
                )
            ),
        ),
    }


def create_stream_scheduler_state(
    config: Mapping[str, Any] | None = None,
) -> JsonObject:
    return {
        "kind": STATE_KIND,
        "config": _resolved_config(config),
        "content": "",
        "pendingChars": 0,
        "lastPatchAtMs": None,
        "patchesUsed": 0,
        "segmentIndex": 0,
        "totalChunks": 0,
        "truncated": False,
        "finished": False,
        "cancelled": False,
        "errored": False,
        "consecutivePatchFailures": 0,
        "degradedToFinalOnly": False,
        "warnings": [],
    }


def _clone_state(state: Any) -> JsonObject:
    record = _as_record(state)
    if not record or record.get("kind") != STATE_KIND:
        raise TypeError(f"Expected state.kind to equal {STATE_KIND}.")
    config = _as_record(record.get("config"))
    if config is None:
        raise TypeError("Expected state.config to be an object.")
    cloned = dict(record)
    cloned["warnings"] = [str(item) for item in _as_array(record.get("warnings"))]
    return cloned


def _segment_prefix(config: JsonObject, segment_index: int) -> str:
    return (
        str(config["prefix"]) if segment_index == 0 else str(config["continuationPrefix"])
    )


def _render_segment(
    config: JsonObject,
    content: str,
    segment_index: int,
    *,
    final: bool,
    note: str = "",
) -> str:
    indicator = "" if final else str(config["typingIndicator"])
    return (
        f"{_segment_prefix(config, segment_index)}{content}{note}"
        f"{config['suffix']}{indicator}"
    )


def _segment_capacity(config: JsonObject, segment_index: int, note: str = "") -> int:
    overhead = (
        len(_segment_prefix(config, segment_index))
        + len(str(config["suffix"]))
        + len(note)
    )
    return max(1, int(config["maxMessageChars"]) - overhead)


def _warn_once(state: JsonObject, warning: str) -> None:
    if warning not in state["warnings"]:
        state["warnings"].append(warning)


def _split_point(content: str, capacity: int) -> int:
    if len(content) <= capacity:
        return len(content)
    window = content[:capacity]
    best = -1
    for index in range(len(window) - 1, -1, -1):
        if window[index] in (" ", "\n", "\t"):
            best = index
            break
    return best if best > 0 else capacity


def _handle_overflow(state: JsonObject, actions: list[JsonObject]) -> None:
    if state["truncated"] is True:
        return
    config = state["config"]
    overflow = str(config["overflow"])
    content = str(state["content"])
    segment_index = int(state["segmentIndex"])

    while (
        len(_render_segment(config, content, segment_index, final=True))
        > int(config["maxMessageChars"])
    ):
        if overflow == "truncate":
            state["truncated"] = True
            _warn_once(state, "truncated_at_message_size_limit")
            break
        capacity = _segment_capacity(config, segment_index)
        cut = _split_point(content, capacity)
        head = content[:cut]
        rest = content[cut:]
        if rest[:1] in (" ", "\n", "\t"):
            rest = rest[1:]
        actions.append(
            {
                "action": "finalize",
                "segmentIndex": segment_index,
                "text": _render_segment(config, head, segment_index, final=True),
                "updateMask": "text",
                "final": True,
                "truncated": False,
            }
        )
        segment_index += 1
        actions.append(
            {
                "action": "start_continuation",
                "segmentIndex": segment_index,
                "text": (
                    f"{_segment_prefix(config, segment_index)}"
                    f"{_DEFAULT_CONTINUATION_PLACEHOLDER}"
                ),
                "updateMask": "text",
                "final": False,
            }
        )
        _warn_once(state, "split_into_continuation_messages")
        content = rest
        state["segmentIndex"] = segment_index
        state["content"] = content
        state["pendingChars"] = len(content)
        state["patchesUsed"] = 0
        state["lastPatchAtMs"] = None


def _maybe_patch(
    state: JsonObject,
    actions: list[JsonObject],
    at_ms: float,
    force: bool,
) -> None:
    config = state["config"]
    if (
        state["truncated"] is True
        or state["degradedToFinalOnly"] is True
        or state["finished"] is True
        or state["cancelled"] is True
    ):
        return
    pending = int(state["pendingChars"])
    if pending <= 0:
        return
    if int(state["patchesUsed"]) >= int(config["maxPatches"]) - 1:
        _warn_once(state, "patch_budget_reserved_for_final_text")
        return
    if not force and pending < int(config["minPatchChars"]):
        return
    last_patch_at = state["lastPatchAtMs"]
    if last_patch_at is not None and at_ms - float(last_patch_at) < float(
        config["minIntervalMs"]
    ):
        return
    actions.append(
        {
            "action": "patch",
            "segmentIndex": int(state["segmentIndex"]),
            "text": _render_segment(
                config,
                str(state["content"]),
                int(state["segmentIndex"]),
                final=False,
            ),
            "updateMask": "text",
            "final": False,
        }
    )
    state["patchesUsed"] = int(state["patchesUsed"]) + 1
    state["lastPatchAtMs"] = at_ms
    state["pendingChars"] = 0


def _finalize(
    state: JsonObject,
    actions: list[JsonObject],
    *,
    note: str = "",
    cancelled: bool = False,
    errored: bool = False,
) -> None:
    config = state["config"]
    content = str(state["content"])
    truncated = state["truncated"] is True

    capacity = _segment_capacity(
        config,
        int(state["segmentIndex"]),
        str(config["truncationNote"]) if truncated else note,
    )
    if len(content) > capacity:
        if str(config["overflow"]) == "truncate" or truncated:
            truncated = True
            content = content[
                : _segment_capacity(
                    config, int(state["segmentIndex"]), str(config["truncationNote"])
                )
            ]

    rendered_note = note
    if truncated:
        rendered_note = f"{config['truncationNote']}{note}"
        state["truncated"] = True
        _warn_once(state, "truncated_at_message_size_limit")
    text = _render_segment(
        config,
        content,
        int(state["segmentIndex"]),
        final=True,
        note=rendered_note,
    )
    if len(text) == 0:
        text = str(config["emptyFinalText"])
    action: JsonObject = {
        "action": "finalize",
        "segmentIndex": int(state["segmentIndex"]),
        "text": text,
        "updateMask": "text",
        "final": True,
        "truncated": truncated,
    }
    if cancelled:
        action["cancelled"] = True
    if errored:
        action["errored"] = True
    actions.append(action)
    state["finished"] = True
    if cancelled:
        state["cancelled"] = True
    if errored:
        state["errored"] = True


def advance_stream_scheduler(state: Any, event: Mapping[str, Any]) -> JsonObject:
    cloned = _clone_state(state)
    actions: list[JsonObject] = []
    record = _as_record(dict(event) if isinstance(event, Mapping) else event)
    event_type = _as_string(record.get("type")) if record else None
    if not record or not event_type:
        raise TypeError("Expected event.type to be a non-empty string.")
    at_ms = _non_negative_number(record.get("atMs"), 0)

    if event_type == "chunk":
        if cloned["finished"] is True or cloned["cancelled"] is True:
            _warn_once(cloned, "chunk_received_after_finish")
        else:
            text = _as_string(record.get("text")) or ""
            if text:
                cloned["content"] = f"{cloned['content']}{text}"
                cloned["pendingChars"] = int(cloned["pendingChars"]) + len(text)
                cloned["totalChunks"] = int(cloned["totalChunks"]) + 1
                _handle_overflow(cloned, actions)
                _maybe_patch(cloned, actions, at_ms, False)
    elif event_type == "flush":
        if cloned["finished"] is not True and cloned["cancelled"] is not True:
            _maybe_patch(cloned, actions, at_ms, True)
    elif event_type == "finish":
        if cloned["finished"] is True:
            _warn_once(cloned, "finish_received_after_finish")
        else:
            final_text = _as_string(record.get("finalText"))
            if final_text is not None:
                cloned["content"] = final_text
                cloned["pendingChars"] = len(final_text)
                cloned["truncated"] = False
            _handle_overflow(cloned, actions)
            _finalize(cloned, actions)
    elif event_type == "cancel":
        if cloned["finished"] is True:
            _warn_once(cloned, "cancel_received_after_finish")
        else:
            _finalize(
                cloned,
                actions,
                note=str(cloned["config"]["cancelNote"]),
                cancelled=True,
            )
    elif event_type == "error":
        if cloned["finished"] is True:
            _warn_once(cloned, "error_received_after_finish")
        else:
            _finalize(
                cloned,
                actions,
                note=str(cloned["config"]["errorNote"]),
                errored=True,
            )
    elif event_type == "patch_result":
        if record.get("ok") is True:
            cloned["consecutivePatchFailures"] = 0
        else:
            failures = int(cloned["consecutivePatchFailures"]) + 1
            cloned["consecutivePatchFailures"] = failures
            if (
                failures >= int(cloned["config"]["maxConsecutivePatchFailures"])
                and cloned["degradedToFinalOnly"] is not True
            ):
                cloned["degradedToFinalOnly"] = True
                _warn_once(cloned, "degraded_to_final_only_after_patch_failures")
    else:
        raise TypeError(f"Unsupported stream scheduler event type: {event_type}.")

    return {"state": cloned, "actions": actions}


def replay_stream_scheduler(input_data: Mapping[str, Any]) -> JsonObject:
    record = _as_record(dict(input_data)) or {}
    events = _as_array(record.get("events"))
    state = create_stream_scheduler_state(_as_record(record.get("config")) or {})
    actions: list[JsonObject] = []
    for index, event in enumerate(events):
        advanced = advance_stream_scheduler(state, event)
        state = advanced["state"]
        for action in advanced["actions"]:
            actions.append({"eventIndex": index, **action})
    return {
        "kind": REPLAY_KIND,
        "actions": actions,
        "state": state,
    }


class InMemoryStreamCancellationRegistry:
    def __init__(self) -> None:
        self._entries: dict[str, str] = {}

    def cancel(self, stream_id: str, reason: str = "cancelled") -> None:
        self._entries[stream_id] = reason

    def is_cancelled(self, stream_id: str) -> bool:
        return stream_id in self._entries

    def reason(self, stream_id: str) -> str | None:
        return self._entries.get(stream_id)

    def clear(self, stream_id: str) -> None:
        self._entries.pop(stream_id, None)


class FileStreamCancellationRegistry:
    def __init__(self, file_path: str | os.PathLike[str]) -> None:
        if not str(file_path):
            raise TypeError("Expected file_path to be a non-empty string.")
        self._path = Path(file_path)

    def _read(self) -> dict[str, str]:
        try:
            parsed = json.loads(self._path.read_text("utf-8"))
        except FileNotFoundError:
            return {}
        cancelled = parsed.get("cancelled") if isinstance(parsed, dict) else None
        if not isinstance(cancelled, dict):
            return {}
        return {
            key: value for key, value in cancelled.items() if isinstance(value, str)
        }

    def _write(self, cancelled: dict[str, str]) -> None:
        payload = json.dumps({"version": 1, "cancelled": cancelled}, indent=2) + "\n"
        atomic_write_text(self._path, payload)

    def cancel(self, stream_id: str, reason: str = "cancelled") -> None:
        with file_state_lock(self._path):
            cancelled = self._read()
            cancelled[stream_id] = reason
            self._write(cancelled)

    def is_cancelled(self, stream_id: str) -> bool:
        return stream_id in self._read()

    def reason(self, stream_id: str) -> str | None:
        return self._read().get(stream_id)

    def clear(self, stream_id: str) -> None:
        with file_state_lock(self._path):
            cancelled = self._read()
            if stream_id in cancelled:
                del cancelled[stream_id]
                self._write(cancelled)


def create_chat_request_applier(
    *,
    get_access_token: Callable[..., dict[str, Any]],
    send: Callable[[Mapping[str, Any]], Mapping[str, Any]] | None = None,
    auth_mode: str = "app",
    base_url: str = "https://chat.googleapis.com",
    sleep: Callable[[int], None] | None = None,
    retry_policy: Any = None,
) -> Callable[[Mapping[str, Any]], JsonObject]:
    if not callable(get_access_token):
        raise TypeError("Expected get_access_token to be callable.")
    client_kwargs: dict[str, Any] = {
        "principal": auth_mode,
        "get_access_token": get_access_token,
        "base_url": base_url,
    }
    if send is not None:
        client_kwargs["send"] = send
    if sleep is not None:
        client_kwargs["sleep"] = sleep
    if retry_policy is not None:
        client_kwargs["retry_policy"] = retry_policy
    client = create_retrying_chat_client(**client_kwargs)

    def apply(request: Mapping[str, Any]) -> JsonObject:
        result = client.request(
            resource_path=str(request["path"]),
            method=str(request["method"]),
            query=dict(request.get("query") or {}),
            body=request.get("body"),
            idempotent=str(request["method"]).upper() == "PATCH",
        )
        return {
            "ok": result.ok,
            "status": result.status,
            "json": result.json,
            "error": result.error,
        }

    return apply


def _normalize_stream_target(target: Any) -> JsonObject:
    record = _as_record(target)
    if record is None:
        raise TypeError("Expected a stream target object.")
    if record.get("kind") == _PLACEHOLDER_HANDLE_KIND:
        message_name = _as_string(record.get("messageName"))
        if not message_name or record.get("editable") is not True:
            raise TypeError(
                "Expected an editable placeholder response handle with "
                "messageName. Hydrate the handle with "
                "hydrate_placeholder_response_handle first."
            )
        return {
            "messageName": message_name,
            "space": _as_string(record.get("space")),
            "threadName": _as_string(record.get("threadName")),
            "threadKey": _as_string(record.get("threadKey")),
        }
    message_name = _as_string(record.get("messageName"))
    if not message_name:
        raise TypeError("Expected target.messageName to be a non-empty string.")
    return {
        "messageName": message_name,
        "space": _as_string(record.get("space")),
        "threadName": _as_string(record.get("threadName")),
        "threadKey": _as_string(record.get("threadKey")),
    }


def _chunk_text(chunk: Any) -> str:
    if isinstance(chunk, str):
        return chunk
    record = _as_record(chunk)
    if record is None:
        return ""
    text = _as_string(record.get("text"))
    if text is None:
        text = _as_string(record.get("delta"))
    return text or ""


_CONFIG_KEYS = {
    "min_patch_chars": "minPatchChars",
    "min_interval_ms": "minIntervalMs",
    "throttle_ms": "throttleMs",
    "max_patches": "maxPatches",
    "max_message_chars": "maxMessageChars",
    "overflow": "overflow",
    "prefix": "prefix",
    "suffix": "suffix",
    "typing_indicator": "typingIndicator",
    "truncation_note": "truncationNote",
    "continuation_prefix": "continuationPrefix",
    "cancel_note": "cancelNote",
    "error_note": "errorNote",
    "empty_final_text": "emptyFinalText",
    "max_consecutive_patch_failures": "maxConsecutivePatchFailures",
}


class _StreamRun:
    """Shared driver core for the sync and async stream drivers."""

    def __init__(
        self,
        target: Any,
        *,
        apply: Callable[[Mapping[str, Any]], Any],
        clock: Callable[[], float] | None,
        should_cancel: Callable[[], Any] | None,
        cancel_reason: str | None,
        final_cards: list[Any] | None,
        resume_state: Mapping[str, Any] | None,
        on_action: Callable[[JsonObject], None] | None,
        on_state: Callable[[JsonObject], None] | None,
        config_kwargs: Mapping[str, Any],
    ) -> None:
        if not callable(apply):
            raise TypeError(
                "Expected apply to be callable. Build one with "
                "create_chat_request_applier."
            )
        self.target = _normalize_stream_target(target)
        self.apply_fn = apply
        self.clock = clock or (lambda: time.time() * 1000)
        self.should_cancel = should_cancel
        self.cancel_reason = cancel_reason
        self.final_cards = final_cards
        self.on_action = on_action
        self.on_state = on_state

        config = {
            _CONFIG_KEYS[key]: value
            for key, value in config_kwargs.items()
            if key in _CONFIG_KEYS and value is not None
        }
        if not self.target.get("space") and config.get("overflow") == "split":
            config["overflow"] = "truncate"
        if resume_state is not None:
            self.state = _clone_state(resume_state)
        else:
            self.state = create_stream_scheduler_state(config)

        self.continuations: list[str] = []
        self.current_message_name = str(self.target["messageName"])
        self.patches = 0
        self.final_text: str | None = None
        self.failure: JsonObject | None = None
        self.saw_finalize = False

    def report(self) -> JsonObject:
        return {
            "kind": REPORT_KIND,
            "ok": self.failure is None and self.saw_finalize,
            "messageName": self.target["messageName"],
            "finalText": self.final_text,
            "patches": self.patches,
            "continuations": self.continuations,
            "truncated": self.state["truncated"] is True,
            "cancelled": self.state["cancelled"] is True,
            "errored": self.state["errored"] is True,
            "degradedToFinalOnly": self.state["degradedToFinalOnly"] is True,
            "failure": self.failure,
            "warnings": [str(item) for item in _as_array(self.state.get("warnings"))],
            "state": self.state,
        }


def _run_stream_sync(run: _StreamRun, stream: Iterable[Any]) -> JsonObject:
    def call_apply(request: JsonObject) -> Mapping[str, Any]:
        return run.apply_fn(request)

    def apply_action(action: JsonObject) -> bool:
        if run.on_action:
            run.on_action(action)
        if action["action"] == "start_continuation":
            space = run.target.get("space")
            if not space:
                run.failure = {
                    "name": "StreamContinuationError",
                    "message": "Cannot start a continuation message without target.space.",
                }
                return False
            body: JsonObject = {"text": action["text"]}
            if run.target.get("threadName"):
                body["thread"] = {"name": run.target["threadName"]}
            elif run.target.get("threadKey"):
                body["thread"] = {"threadKey": run.target["threadKey"]}
            result = call_apply(
                {
                    "kind": "create",
                    "method": "POST",
                    "path": f"/v1/{space}/messages",
                    "query": (
                        {"messageReplyOption": "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"}
                        if "thread" in body
                        else {}
                    ),
                    "body": body,
                    "segmentIndex": action["segmentIndex"],
                    "final": False,
                }
            )
            if not result.get("ok"):
                run.failure = result.get("error") or {
                    "name": "HttpError",
                    "message": (
                        f"Continuation create failed with HTTP {result.get('status')}."
                    ),
                }
                return False
            created = _as_record(result.get("json"))
            name = _as_string(created.get("name")) if created else None
            if not name:
                run.failure = {
                    "name": "StreamContinuationError",
                    "message": (
                        "Continuation create response did not include a message name."
                    ),
                }
                return False
            run.continuations.append(name)
            run.current_message_name = name
            return True

        attach_cards = (
            action.get("final") is True
            and action["action"] == "finalize"
            and bool(run.final_cards)
        )
        body = {"text": action["text"]}
        update_mask = str(action["updateMask"])
        if attach_cards:
            body["cardsV2"] = run.final_cards
            update_mask = f"{update_mask},cardsV2"
        result = call_apply(
            {
                "kind": "patch",
                "method": "PATCH",
                "path": f"/v1/{run.current_message_name}",
                "query": {"updateMask": update_mask},
                "body": body,
                "segmentIndex": action["segmentIndex"],
                "final": action.get("final") is True,
            }
        )
        advanced = advance_stream_scheduler(
            run.state,
            {"type": "patch_result", "ok": bool(result.get("ok")), "atMs": run.clock()},
        )
        run.state = advanced["state"]
        if result.get("ok"):
            run.patches += 1
            if action.get("final") is True:
                run.final_text = str(action["text"])
                run.saw_finalize = True
            return True
        if action.get("final") is True:
            run.failure = result.get("error") or {
                "name": "HttpError",
                "message": f"Final patch failed with HTTP {result.get('status')}.",
            }
            return False
        return True

    def advance_and_apply(event: JsonObject) -> bool:
        advanced = advance_stream_scheduler(run.state, event)
        run.state = advanced["state"]
        for action in advanced["actions"]:
            if not apply_action(action):
                return False
        if run.on_state:
            run.on_state(run.state)
        return True

    def is_cancelled() -> bool:
        if run.should_cancel is None:
            return False
        return bool(run.should_cancel())

    aborted = False
    try:
        for chunk in stream:
            if is_cancelled():
                aborted = True
                break
            text = _chunk_text(chunk)
            if not text:
                continue
            if not advance_and_apply(
                {"type": "chunk", "text": text, "atMs": run.clock()}
            ):
                break
    except Exception as exc:  # noqa: BLE001 - reported in the stream report
        run.failure = {"name": exc.__class__.__name__, "message": str(exc)}
        advance_and_apply({"type": "error", "atMs": run.clock()})

    if run.failure is None:
        if aborted or is_cancelled():
            event: JsonObject = {"type": "cancel", "atMs": run.clock()}
            if run.cancel_reason:
                event["reason"] = run.cancel_reason
            advance_and_apply(event)
        elif run.state["finished"] is not True:
            advance_and_apply({"type": "finish", "atMs": run.clock()})

    return run.report()


def stream_chat_reply(
    target: Any,
    stream: Iterable[Any],
    *,
    apply: Callable[[Mapping[str, Any]], Any],
    clock: Callable[[], float] | None = None,
    should_cancel: Callable[[], Any] | None = None,
    cancel_reason: str | None = None,
    final_cards: list[Any] | None = None,
    resume_state: Mapping[str, Any] | None = None,
    on_action: Callable[[JsonObject], None] | None = None,
    on_state: Callable[[JsonObject], None] | None = None,
    **config_kwargs: Any,
) -> JsonObject:
    run = _StreamRun(
        target,
        apply=apply,
        clock=clock,
        should_cancel=should_cancel,
        cancel_reason=cancel_reason,
        final_cards=final_cards,
        resume_state=resume_state,
        on_action=on_action,
        on_state=on_state,
        config_kwargs=config_kwargs,
    )
    return _run_stream_sync(run, stream)


async def astream_chat_reply(
    target: Any,
    stream: AsyncIterable[Any] | Iterable[Any],
    *,
    apply: Callable[[Mapping[str, Any]], Any],
    clock: Callable[[], float] | None = None,
    should_cancel: Callable[[], Any] | None = None,
    cancel_reason: str | None = None,
    final_cards: list[Any] | None = None,
    resume_state: Mapping[str, Any] | None = None,
    on_action: Callable[[JsonObject], None] | None = None,
    on_state: Callable[[JsonObject], None] | None = None,
    **config_kwargs: Any,
) -> JsonObject:
    run = _StreamRun(
        target,
        apply=apply,
        clock=clock,
        should_cancel=should_cancel,
        cancel_reason=cancel_reason,
        final_cards=final_cards,
        resume_state=resume_state,
        on_action=on_action,
        on_state=on_state,
        config_kwargs=config_kwargs,
    )

    async def call_apply(request: JsonObject) -> Mapping[str, Any]:
        result = run.apply_fn(request)
        if inspect.isawaitable(result):
            return await result
        return result

    async def apply_action(action: JsonObject) -> bool:
        if run.on_action:
            run.on_action(action)
        if action["action"] == "start_continuation":
            space = run.target.get("space")
            if not space:
                run.failure = {
                    "name": "StreamContinuationError",
                    "message": "Cannot start a continuation message without target.space.",
                }
                return False
            body: JsonObject = {"text": action["text"]}
            if run.target.get("threadName"):
                body["thread"] = {"name": run.target["threadName"]}
            elif run.target.get("threadKey"):
                body["thread"] = {"threadKey": run.target["threadKey"]}
            result = await call_apply(
                {
                    "kind": "create",
                    "method": "POST",
                    "path": f"/v1/{space}/messages",
                    "query": (
                        {"messageReplyOption": "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"}
                        if "thread" in body
                        else {}
                    ),
                    "body": body,
                    "segmentIndex": action["segmentIndex"],
                    "final": False,
                }
            )
            if not result.get("ok"):
                run.failure = result.get("error") or {
                    "name": "HttpError",
                    "message": (
                        f"Continuation create failed with HTTP {result.get('status')}."
                    ),
                }
                return False
            created = _as_record(result.get("json"))
            name = _as_string(created.get("name")) if created else None
            if not name:
                run.failure = {
                    "name": "StreamContinuationError",
                    "message": (
                        "Continuation create response did not include a message name."
                    ),
                }
                return False
            run.continuations.append(name)
            run.current_message_name = name
            return True

        attach_cards = (
            action.get("final") is True
            and action["action"] == "finalize"
            and bool(run.final_cards)
        )
        body = {"text": action["text"]}
        update_mask = str(action["updateMask"])
        if attach_cards:
            body["cardsV2"] = run.final_cards
            update_mask = f"{update_mask},cardsV2"
        result = await call_apply(
            {
                "kind": "patch",
                "method": "PATCH",
                "path": f"/v1/{run.current_message_name}",
                "query": {"updateMask": update_mask},
                "body": body,
                "segmentIndex": action["segmentIndex"],
                "final": action.get("final") is True,
            }
        )
        advanced = advance_stream_scheduler(
            run.state,
            {"type": "patch_result", "ok": bool(result.get("ok")), "atMs": run.clock()},
        )
        run.state = advanced["state"]
        if result.get("ok"):
            run.patches += 1
            if action.get("final") is True:
                run.final_text = str(action["text"])
                run.saw_finalize = True
            return True
        if action.get("final") is True:
            run.failure = result.get("error") or {
                "name": "HttpError",
                "message": f"Final patch failed with HTTP {result.get('status')}.",
            }
            return False
        return True

    async def advance_and_apply(event: JsonObject) -> bool:
        advanced = advance_stream_scheduler(run.state, event)
        run.state = advanced["state"]
        for action in advanced["actions"]:
            if not await apply_action(action):
                return False
        if run.on_state:
            run.on_state(run.state)
        return True

    async def is_cancelled() -> bool:
        if run.should_cancel is None:
            return False
        result = run.should_cancel()
        if inspect.isawaitable(result):
            result = await result
        return bool(result)

    async def iterate():
        if hasattr(stream, "__aiter__"):
            async for chunk in stream:  # type: ignore[union-attr]
                yield chunk
        else:
            for chunk in stream:  # type: ignore[union-attr]
                yield chunk

    aborted = False
    try:
        async for chunk in iterate():
            if await is_cancelled():
                aborted = True
                break
            text = _chunk_text(chunk)
            if not text:
                continue
            if not await advance_and_apply(
                {"type": "chunk", "text": text, "atMs": run.clock()}
            ):
                break
    except Exception as exc:  # noqa: BLE001 - reported in the stream report
        run.failure = {"name": exc.__class__.__name__, "message": str(exc)}
        await advance_and_apply({"type": "error", "atMs": run.clock()})

    if run.failure is None:
        if aborted or await is_cancelled():
            event: JsonObject = {"type": "cancel", "atMs": run.clock()}
            if run.cancel_reason:
                event["reason"] = run.cancel_reason
            await advance_and_apply(event)
        elif run.state["finished"] is not True:
            await advance_and_apply({"type": "finish", "atMs": run.clock()})

    return run.report()
