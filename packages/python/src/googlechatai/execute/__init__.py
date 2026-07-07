"""Execute dry-run Google Chat call plans against the live API.

The executor walks ``plan.requests`` sequentially, applies the shared
capability/safety gates, resolves two-step path placeholders, and sends
each request through the retry-aware transport client. ``mode`` defaults
to ``"dryRun"`` so nothing touches the network unless the caller
explicitly opts into ``"live"``.
"""

from __future__ import annotations

import re
import time
import urllib.parse
from typing import Any, Callable, Mapping

from ..transport import create_retrying_chat_client

CHAT_API_BASE_URL = "https://chat.googleapis.com"

_PLACEHOLDER_PATTERN = re.compile(r"\{([a-zA-Z0-9_]+)\}")
_ENCODE_SAFE = "-_.!~*'()"

JsonObject = dict[str, Any]


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _as_record(value: Any) -> JsonObject | None:
    return value if isinstance(value, dict) else None


def _as_array(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _string_list(value: Any) -> list[str]:
    return [item for item in _as_array(value) if isinstance(item, str)]


def _find_direct_message_resolver(context: JsonObject) -> str | None:
    for response in reversed(context["responses"]):
        record = _as_record(response)
        name = _as_string(record.get("name")) if record else None
        if name and name.startswith("spaces/"):
            return name
    return None


def _message_pin_resolver(context: JsonObject) -> str | None:
    plan_pin = _as_record(context["plan"].get("pin"))
    target_message = _as_string(plan_pin.get("message")) if plan_pin else None
    for response in reversed(context["responses"]):
        record = _as_record(response)
        for raw_pin in _as_array(record.get("messagePins")) if record else []:
            pin = _as_record(raw_pin)
            if not pin:
                continue
            pin_message = _as_string(pin.get("message"))
            if pin_message is None:
                nested = _as_record(pin.get("message"))
                pin_message = _as_string(nested.get("name")) if nested else None
            pin_name = _as_string(pin.get("name"))
            if pin_name and (target_message is None or pin_message == target_message):
                return pin_name
    return None


DEFAULT_PLACEHOLDER_RESOLVERS: dict[str, Callable[[JsonObject], str | None]] = {
    "resolvedDirectMessageSpace": _find_direct_message_resolver,
    "resolvedMessagePin": _message_pin_resolver,
}


def _placeholder_names(path: str) -> list[str]:
    return _PLACEHOLDER_PATTERN.findall(path)


def _encode_component(value: Any) -> str:
    return urllib.parse.quote(str(value), safe=_ENCODE_SAFE)


def _build_query_string(query: JsonObject) -> str:
    parts = [
        f"{_encode_component(key)}={_encode_component(value)}"
        for key, value in query.items()
        if value is not None
    ]
    return f"?{'&'.join(parts)}" if parts else ""


def _token_source_for_auth_mode(auth: Any, auth_mode: str) -> Callable[..., Any] | None:
    if auth is None:
        return None
    if callable(auth):
        return auth
    get_access_token = getattr(auth, "get_access_token", None)
    if callable(get_access_token):
        return get_access_token
    if isinstance(auth, Mapping):
        source = auth.get("user") if auth_mode == "user" else auth.get("app")
        if callable(source):
            return source
        nested = getattr(source, "get_access_token", None)
        if callable(nested):
            return nested
    return None


def _base_step(index: int, request: JsonObject) -> JsonObject:
    return {
        "index": index,
        "resource": _as_string(request.get("resource")),
        "method": _as_string(request.get("method")) or "GET",
        "path": _as_string(request.get("path")) or "",
        "url": None,
        "query": _as_record(request.get("query")) or {},
        "status": "not_reached",
        "httpStatus": None,
        "attempts": 0,
        "throttleAppliedMs": 0,
        "response": None,
        "error": None,
        "skippedReason": None,
        "fallback": None,
    }


def _is_message_create(step: JsonObject) -> bool:
    return step["resource"] == "spaces.messages.create"


def _compute_block(
    plan: JsonObject,
    *,
    mode: str,
    auth: Any,
    auth_mode: str,
    allow_direct_messages: bool,
    override_capability: bool,
) -> JsonObject | None:
    capability = _as_record(plan.get("capability"))
    if capability and capability.get("ok") is False and not override_capability:
        return {
            "reason": "capability",
            "details": _string_list(capability.get("reasons")),
        }
    safety = _as_record(plan.get("safety"))
    if safety and safety.get("directMessage") is True and not allow_direct_messages:
        return {
            "reason": "direct_message_policy",
            "details": [
                "The plan targets a direct message; pass allowDirectMessages: true to execute it.",
            ],
        }
    if mode == "live" and _token_source_for_auth_mode(auth, auth_mode) is None:
        target = "user" if auth_mode == "user" else "app"
        return {
            "reason": "missing_auth",
            "details": [
                f"No token source is configured for authMode {auth_mode}. "
                f"Provide auth.{target} or a single token source.",
            ],
        }
    return None


def execute_chat_plan(
    plan: Any,
    *,
    mode: str = "dryRun",
    auth: Any = None,
    send: Callable[[Mapping[str, Any]], Mapping[str, Any]] | None = None,
    sleep: Callable[[int], None] | None = None,
    retry_policy: Any = None,
    base_url: str = CHAT_API_BASE_URL,
    allow_direct_messages: bool = False,
    override_capability: bool = False,
    idempotency_store: Any = None,
    placeholder_values: Mapping[str, str] | None = None,
    placeholder_resolvers: Mapping[str, Callable[[JsonObject], str | None]] | None = None,
    on_step: Callable[[JsonObject], None] | None = None,
) -> JsonObject:
    plan_record = _as_record(plan)
    if plan_record is None:
        raise TypeError("Expected plan to be an object.")
    requests = [
        request
        for request in (_as_record(item) for item in _as_array(plan_record.get("requests")))
        if request is not None
    ]
    if not requests:
        raise TypeError(
            "Expected plan.requests to include at least one planned request. "
            "Async response plans must be executed through their placeholder "
            "and queue sub-plans."
        )
    if mode not in ("dryRun", "live"):
        raise TypeError("Expected mode to be either dryRun or live.")

    capability = _as_record(plan_record.get("capability"))
    auth_mode = (_as_string(capability.get("authMode")) if capability else None) or "app"
    warnings = _string_list(plan_record.get("warnings"))
    blocked = _compute_block(
        plan_record,
        mode=mode,
        auth=auth,
        auth_mode=auth_mode,
        allow_direct_messages=allow_direct_messages,
        override_capability=override_capability,
    )
    resolved_placeholders: dict[str, str] = dict(placeholder_values or {})
    resolvers: dict[str, Callable[[JsonObject], str | None]] = {
        **DEFAULT_PLACEHOLDER_RESOLVERS,
        **dict(placeholder_resolvers or {}),
    }
    steps = [_base_step(index, request) for index, request in enumerate(requests)]
    responses: list[Any] = []
    created_messages: list[JsonObject] = []

    execution: JsonObject = {
        "kind": "chat.plan_execution",
        "operation": _as_string(plan_record.get("operation")),
        "planKind": _as_string(plan_record.get("kind")),
        "mode": mode,
        "ok": False,
        "authMode": auth_mode,
        "blocked": blocked,
        "steps": steps,
        "resolvedPlaceholders": resolved_placeholders,
        "createdMessages": created_messages,
        "warnings": warnings,
    }

    def resolve_path(step: JsonObject, request: JsonObject) -> str | None:
        resolved = step["path"]
        for name in _placeholder_names(step["path"]):
            value = resolved_placeholders.get(name)
            if value is None:
                resolver = resolvers.get(name)
                value = (
                    resolver(
                        {
                            "plan": plan_record,
                            "request": request,
                            "steps": steps,
                            "responses": responses,
                        }
                    )
                    if resolver
                    else None
                )
                if value is not None:
                    resolved_placeholders[name] = value
            if value is None:
                return None
            resolved = resolved.replace("{" + name + "}", value)
        return resolved

    def step_url(step: JsonObject, path: str) -> str:
        trimmed = path[1:] if path.startswith("/") else path
        return f"{base_url}/{trimmed}{_build_query_string(step['query'])}"

    if mode == "dryRun":
        for index, request in enumerate(requests):
            step = steps[index]
            resolved = resolve_path(step, request)
            path = resolved if resolved is not None else step["path"]
            step["url"] = step_url(step, path)
            step["status"] = "planned"
            if resolved is None:
                step["skippedReason"] = "unresolved_placeholder"
            if on_step:
                on_step(step)
        execution["ok"] = blocked is None
        return execution

    if blocked is not None:
        for step in steps:
            step["status"] = "skipped"
            step["skippedReason"] = f"blocked_{blocked['reason']}"
        return execution

    token_source = _token_source_for_auth_mode(auth, auth_mode)
    client_kwargs: dict[str, Any] = {
        "principal": auth_mode,
        "get_access_token": token_source,
        "base_url": base_url,
    }
    if send is not None:
        client_kwargs["send"] = send
    if sleep is not None:
        client_kwargs["sleep"] = sleep
    if retry_policy is not None:
        client_kwargs["retry_policy"] = retry_policy
    client = create_retrying_chat_client(**client_kwargs)
    sleep_fn = sleep or (lambda delay_ms: time.sleep(delay_ms / 1000))

    def perform_request(step: JsonObject, request: JsonObject, path: str) -> Any:
        method = step["method"].upper()
        request_id = _as_string(step["query"].get("requestId"))
        idempotent = method in ("GET", "DELETE", "PATCH", "PUT") or request_id is not None
        step["url"] = step_url(step, path)
        return client.request(
            resource_path=path,
            method=method,
            query=dict(step["query"]),
            body=request.get("body"),
            idempotent=idempotent,
        )

    def record_success(step: JsonObject, result: Any) -> None:
        step["status"] = "executed"
        step["response"] = result.json
        responses.append(result.json)
        record = _as_record(result.json)
        if record is not None and _is_message_create(step):
            created_messages.append(record)

    failed = False
    for index, request in enumerate(requests):
        if failed:
            break
        step = steps[index]

        path = resolve_path(step, request)
        if path is None:
            step["status"] = "failed"
            step["error"] = {
                "name": "UnresolvedPlaceholderError",
                "message": f"Could not resolve path placeholder in {step['path']}.",
            }
            failed = True
            if on_step:
                on_step(step)
            break

        request_id = _as_string(step["query"].get("requestId"))
        if request_id and idempotency_store is not None:
            claim = idempotency_store.claim(f"chat-plan-request:{request_id}")
            duplicate = (
                claim.duplicate
                if hasattr(claim, "duplicate")
                else bool(_as_record(claim) and claim.get("duplicate"))
            )
            if duplicate:
                step["status"] = "skipped"
                step["skippedReason"] = "duplicate_request_id"
                warnings.append(
                    f"Request {request_id} was already claimed; skipping duplicate send."
                )
                if on_step:
                    on_step(step)
                continue

        throttle = _as_record(request.get("throttle"))
        min_delay_ms = throttle.get("minDelayMs") if throttle else 0
        if isinstance(min_delay_ms, (int, float)) and min_delay_ms > 0:
            step["throttleAppliedMs"] = min_delay_ms
            sleep_fn(int(min_delay_ms))

        result = perform_request(step, request, path)
        step["httpStatus"] = result.status
        step["attempts"] = result.attempts
        if result.ok:
            record_success(step, result)
        else:
            step["status"] = "failed"
            step["error"] = result.error or {
                "name": "HttpError",
                "message": f"Request failed with HTTP {result.status}.",
            }
            placeholder = _as_record(plan_record.get("placeholder"))
            fallback = _as_record(placeholder.get("fallback")) if placeholder else None
            fallback_request = _as_record(fallback.get("request")) if fallback else None
            handled_by_fallback = False
            if (
                step["method"].upper() == "PATCH"
                and fallback is not None
                and fallback.get("onPatchFailure") == "createNewMessage"
                and fallback_request is not None
            ):
                fallback_step = _base_step(step["index"], fallback_request)
                fallback_path = resolve_path(fallback_step, fallback_request)
                if fallback_path is not None:
                    fallback_result = perform_request(
                        fallback_step, fallback_request, fallback_path
                    )
                    fallback_step["httpStatus"] = fallback_result.status
                    fallback_step["attempts"] = fallback_result.attempts
                    if fallback_result.ok:
                        record_success(fallback_step, fallback_result)
                        handled_by_fallback = True
                    else:
                        fallback_step["status"] = "failed"
                        fallback_step["error"] = fallback_result.error or {
                            "name": "HttpError",
                            "message": (
                                f"Fallback request failed with HTTP {fallback_result.status}."
                            ),
                        }
                    step["fallback"] = fallback_step
            if not handled_by_fallback:
                failed = True
        if on_step:
            on_step(step)

    execution["ok"] = not failed
    return execution
