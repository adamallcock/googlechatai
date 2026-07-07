"""Shared retry policy helpers for Google Chat transport calls."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import json
from pathlib import Path
import time
from typing import Any, Callable, Literal
from urllib.parse import urlencode


RetryAction = Literal["retry", "refresh_auth", "fail"]

DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_BASE_DELAY_MS = 250
DEFAULT_MAX_DELAY_MS = 5_000
DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000
DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 500
IDEMPOTENT_METHODS = {"GET", "HEAD", "OPTIONS"}
RETRYABLE_STATUSES = {408, 429, 500, 502, 503, 504}


@dataclass(frozen=True)
class RetryPolicyOptions:
    max_attempts: int = DEFAULT_MAX_ATTEMPTS
    base_delay_ms: int = DEFAULT_BASE_DELAY_MS
    max_delay_ms: int = DEFAULT_MAX_DELAY_MS


@dataclass(frozen=True)
class RetryDecisionInput:
    attempt: int
    method: str | None = None
    status: int | None = None
    retry_after: str | None = None
    network_error: bool = False
    idempotent: bool = False
    pre_send_failure: bool = False
    principal: str | None = None


@dataclass(frozen=True)
class RetryDecision:
    action: RetryAction
    retryable: bool
    refresh_auth: bool
    replay_safe: bool
    reason: str
    attempt: int
    max_attempts: int
    delay_ms: int
    status: int | None
    principal: str | None


@dataclass(frozen=True)
class IdempotencyClaim:
    key: str
    claimed: bool
    duplicate: bool
    first_seen_at: str
    last_seen_at: str
    expires_at: str
    seen_count: int
    metadata: dict[str, Any] | None = None


@dataclass
class _StoredIdempotencyEntry:
    first_seen_at_ms: int
    last_seen_at_ms: int
    expires_at_ms: int
    seen_count: int
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class RetryingJsonResponse:
    ok: bool
    status: int
    json: Any
    headers: dict[str, str]
    attempts: int
    refreshed: bool
    replayed_after_401: bool
    retry_decisions: list[RetryDecision]
    error: dict[str, str] | None = None


@dataclass(frozen=True)
class DuplicateEventGuardResult:
    duplicate: bool
    response_body: dict[str, Any] | None
    claim: IdempotencyClaim


def _positive_integer(value: int | None, fallback: int) -> int:
    return value if isinstance(value, int) and value > 0 else fallback


def _non_negative_integer(value: int | None, fallback: int) -> int:
    return value if isinstance(value, int) and value >= 0 else fallback


def _policy(options: RetryPolicyOptions | None) -> RetryPolicyOptions:
    if options is None:
        return RetryPolicyOptions()
    return RetryPolicyOptions(
        max_attempts=_positive_integer(
            options.max_attempts,
            DEFAULT_MAX_ATTEMPTS,
        ),
        base_delay_ms=_non_negative_integer(
            options.base_delay_ms,
            DEFAULT_BASE_DELAY_MS,
        ),
        max_delay_ms=_non_negative_integer(
            options.max_delay_ms,
            DEFAULT_MAX_DELAY_MS,
        ),
    )


def _normalize_method(method: str | None) -> str:
    return (method or "GET").upper()


def parse_retry_after_ms(
    retry_after: str | None,
    now: datetime | None = None,
) -> int | None:
    if not retry_after:
        return None

    try:
        seconds = float(retry_after)
    except ValueError:
        seconds = None
    if seconds is not None and seconds >= 0:
        return round(seconds * 1000)

    try:
        parsed = parsedate_to_datetime(retry_after)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return max(0, round((parsed - current).total_seconds() * 1000))


def is_replay_safe(input_value: RetryDecisionInput) -> bool:
    method = _normalize_method(input_value.method)
    if input_value.pre_send_failure:
        return True
    if method in IDEMPOTENT_METHODS:
        return True
    return input_value.idempotent is True


def _backoff_delay_ms(
    attempt: int,
    retry_after: str | None,
    policy: RetryPolicyOptions,
) -> int:
    retry_after_ms = parse_retry_after_ms(retry_after)
    if retry_after_ms is not None:
        return min(retry_after_ms, policy.max_delay_ms)
    exponential = policy.base_delay_ms * (2 ** max(0, attempt - 1))
    return min(exponential, policy.max_delay_ms)


def _fail_decision(
    input_value: RetryDecisionInput,
    policy: RetryPolicyOptions,
    reason: str,
) -> RetryDecision:
    return RetryDecision(
        action="fail",
        retryable=False,
        refresh_auth=False,
        replay_safe=is_replay_safe(input_value),
        reason=reason,
        attempt=input_value.attempt,
        max_attempts=policy.max_attempts,
        delay_ms=0,
        status=input_value.status,
        principal=input_value.principal,
    )


def build_retry_decision(
    input_value: RetryDecisionInput,
    options: RetryPolicyOptions | None = None,
) -> RetryDecision:
    policy = _policy(options)
    replay_safe = is_replay_safe(input_value)
    attempts_remaining = input_value.attempt < policy.max_attempts

    if not isinstance(input_value.attempt, int) or input_value.attempt <= 0:
        return _fail_decision(input_value, policy, "invalid_attempt")
    if not attempts_remaining:
        return _fail_decision(input_value, policy, "max_attempts_exhausted")

    if input_value.status == 401:
        return RetryDecision(
            action="refresh_auth",
            retryable=True,
            refresh_auth=True,
            replay_safe=replay_safe,
            reason="access_token_expired_or_invalid",
            attempt=input_value.attempt,
            max_attempts=policy.max_attempts,
            delay_ms=0,
            status=input_value.status,
            principal=input_value.principal,
        )

    if input_value.network_error or input_value.status in RETRYABLE_STATUSES:
        if not replay_safe:
            return _fail_decision(
                input_value,
                policy,
                "non_idempotent_request_not_replayed",
            )
        return RetryDecision(
            action="retry",
            retryable=True,
            refresh_auth=False,
            replay_safe=True,
            reason="rate_limited"
            if input_value.status == 429
            else "transient_failure",
            attempt=input_value.attempt,
            max_attempts=policy.max_attempts,
            delay_ms=_backoff_delay_ms(
                input_value.attempt,
                input_value.retry_after,
                policy,
            ),
            status=input_value.status,
            principal=input_value.principal,
        )

    return _fail_decision(input_value, policy, "non_retryable_status")


def _normalize_key(key: str) -> str:
    if not isinstance(key, str) or not key.strip():
        raise TypeError("Idempotency key must be a non-empty string.")
    return key


def _positive_ms(value: int | None, fallback: int) -> int:
    return value if isinstance(value, int) and value > 0 else fallback


def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace(
        "+00:00",
        "Z",
    )


def _parse_iso_ms(value: str) -> int:
    return round(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def _claim_from_entry(
    key: str,
    entry: _StoredIdempotencyEntry,
    *,
    claimed: bool,
    duplicate: bool,
) -> IdempotencyClaim:
    return IdempotencyClaim(
        key=key,
        claimed=claimed,
        duplicate=duplicate,
        first_seen_at=_iso(entry.first_seen_at_ms),
        last_seen_at=_iso(entry.last_seen_at_ms),
        expires_at=_iso(entry.expires_at_ms),
        seen_count=entry.seen_count,
        metadata=entry.metadata,
    )


def _purge_expired(
    entries: dict[str, _StoredIdempotencyEntry],
    now_ms: int,
) -> None:
    for key in list(entries.keys()):
        if entries[key].expires_at_ms <= now_ms:
            del entries[key]


def _enforce_max_entries(
    entries: dict[str, _StoredIdempotencyEntry],
    max_entries: int,
) -> None:
    while len(entries) > max_entries:
        oldest = min(entries.items(), key=lambda item: item[1].expires_at_ms)[0]
        del entries[oldest]


def _claim_in_entries(
    entries: dict[str, _StoredIdempotencyEntry],
    key: str,
    *,
    ttl_ms: int | None = None,
    now_ms: int | None = None,
    metadata: dict[str, Any] | None = None,
    default_ttl_ms: int = DEFAULT_IDEMPOTENCY_TTL_MS,
    max_entries: int = DEFAULT_IDEMPOTENCY_MAX_ENTRIES,
) -> IdempotencyClaim:
    normalized_key = _normalize_key(key)
    effective_ttl_ms = _positive_ms(ttl_ms, default_ttl_ms)
    effective_now_ms = (
        now_ms if isinstance(now_ms, int) and now_ms >= 0 else round(time.time() * 1000)
    )
    _purge_expired(entries, effective_now_ms)

    existing = entries.get(normalized_key)
    if existing is not None:
        existing.last_seen_at_ms = effective_now_ms
        existing.seen_count += 1
        return _claim_from_entry(
            normalized_key,
            existing,
            claimed=False,
            duplicate=True,
        )

    entry = _StoredIdempotencyEntry(
        first_seen_at_ms=effective_now_ms,
        last_seen_at_ms=effective_now_ms,
        expires_at_ms=effective_now_ms + effective_ttl_ms,
        seen_count=1,
        metadata=metadata,
    )
    entries[normalized_key] = entry
    _enforce_max_entries(entries, max_entries)
    return _claim_from_entry(
        normalized_key,
        entry,
        claimed=True,
        duplicate=False,
    )


class InMemoryIdempotencyStore:
    def __init__(
        self,
        *,
        max_entries: int = DEFAULT_IDEMPOTENCY_MAX_ENTRIES,
        default_ttl_ms: int = DEFAULT_IDEMPOTENCY_TTL_MS,
    ) -> None:
        self.max_entries = _positive_integer(max_entries, DEFAULT_IDEMPOTENCY_MAX_ENTRIES)
        self.default_ttl_ms = _positive_ms(default_ttl_ms, DEFAULT_IDEMPOTENCY_TTL_MS)
        self._entries: dict[str, _StoredIdempotencyEntry] = {}

    def claim(
        self,
        key: str,
        *,
        ttl_ms: int | None = None,
        now_ms: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> IdempotencyClaim:
        return _claim_in_entries(
            self._entries,
            key,
            ttl_ms=ttl_ms,
            now_ms=now_ms,
            metadata=metadata,
            default_ttl_ms=self.default_ttl_ms,
            max_entries=self.max_entries,
        )


class FileIdempotencyStore:
    def __init__(
        self,
        file_path: str | Path,
        *,
        max_entries: int = DEFAULT_IDEMPOTENCY_MAX_ENTRIES,
        default_ttl_ms: int = DEFAULT_IDEMPOTENCY_TTL_MS,
    ) -> None:
        self.file_path = Path(file_path)
        self.max_entries = _positive_integer(max_entries, DEFAULT_IDEMPOTENCY_MAX_ENTRIES)
        self.default_ttl_ms = _positive_ms(default_ttl_ms, DEFAULT_IDEMPOTENCY_TTL_MS)

    def claim(
        self,
        key: str,
        *,
        ttl_ms: int | None = None,
        now_ms: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> IdempotencyClaim:
        entries = self._read_entries()
        claim = _claim_in_entries(
            entries,
            key,
            ttl_ms=ttl_ms,
            now_ms=now_ms,
            metadata=metadata,
            default_ttl_ms=self.default_ttl_ms,
            max_entries=self.max_entries,
        )
        self._write_entries(entries)
        return claim

    def _read_entries(self) -> dict[str, _StoredIdempotencyEntry]:
        if not self.file_path.exists():
            return {}
        parsed = json.loads(self.file_path.read_text("utf8"))
        return {
            key: _StoredIdempotencyEntry(
                first_seen_at_ms=_parse_iso_ms(value["firstSeenAt"]),
                last_seen_at_ms=_parse_iso_ms(value["lastSeenAt"]),
                expires_at_ms=_parse_iso_ms(value["expiresAt"]),
                seen_count=_positive_integer(value.get("seenCount"), 1),
                metadata=value.get("metadata"),
            )
            for key, value in parsed.get("entries", {}).items()
        }

    def _write_entries(
        self,
        entries: dict[str, _StoredIdempotencyEntry],
    ) -> None:
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "entries": {
                key: {
                    "firstSeenAt": _iso(entry.first_seen_at_ms),
                    "lastSeenAt": _iso(entry.last_seen_at_ms),
                    "expiresAt": _iso(entry.expires_at_ms),
                    "seenCount": entry.seen_count,
                    **({"metadata": entry.metadata} if entry.metadata else {}),
                }
                for key, entry in entries.items()
            },
        }
        temp_path = self.file_path.with_suffix(f"{self.file_path.suffix}.tmp")
        temp_path.write_text(f"{json.dumps(payload, indent=2)}\n", "utf8")
        temp_path.replace(self.file_path)


def _token_value(lease: dict[str, Any]) -> str:
    return str(lease.get("access_token") or lease.get("accessToken") or "")


def _token_type(lease: dict[str, Any]) -> str:
    return str(lease.get("token_type") or lease.get("tokenType") or "Bearer")


def _headers_retry_after(headers: dict[str, str] | None) -> str | None:
    if not headers:
        return None
    return headers.get("retry-after") or headers.get("Retry-After")


def _default_sleep(delay_ms: int) -> None:
    time.sleep(delay_ms / 1000)


def request_json_with_retry(
    *,
    method: str = "GET",
    url: str,
    principal: str | None = None,
    headers: dict[str, str] | None = None,
    body: Any = None,
    idempotent: bool = False,
    pre_send_failure: bool = False,
    get_access_token: Callable[..., dict[str, Any]],
    send: Callable[[dict[str, Any]], dict[str, Any]],
    sleep: Callable[[int], None] = _default_sleep,
    retry_policy: RetryPolicyOptions | None = None,
) -> RetryingJsonResponse:
    normalized_method = _normalize_method(method)
    retry_decisions: list[RetryDecision] = []
    attempts = 0
    lease = get_access_token(force_refresh=False)
    refreshed = bool(lease.get("refreshed"))
    replayed_after_401 = False

    while True:
        attempts += 1
        request = {
            "url": url,
            "method": normalized_method,
            "headers": {
                "content-type": "application/json",
                **(headers or {}),
                "authorization": f"{_token_type(lease)} {_token_value(lease)}",
            },
            "body": body,
        }

        try:
            response = send(request)
        except Exception as exc:
            decision = build_retry_decision(
                RetryDecisionInput(
                    attempt=attempts,
                    method=normalized_method,
                    network_error=True,
                    idempotent=idempotent,
                    pre_send_failure=pre_send_failure,
                    principal=principal,
                ),
                retry_policy,
            )
            retry_decisions.append(decision)
            if decision.action == "retry":
                sleep(decision.delay_ms)
                continue
            return RetryingJsonResponse(
                ok=False,
                status=0,
                json={},
                headers={},
                attempts=attempts,
                refreshed=refreshed,
                replayed_after_401=replayed_after_401,
                retry_decisions=retry_decisions,
                error={"name": exc.__class__.__name__, "message": str(exc)},
            )

        ok = bool(response.get("ok"))
        status = int(response.get("status") or 0)
        response_headers = dict(response.get("headers") or {})
        response_json = response.get("json", {})
        if ok:
            return RetryingJsonResponse(
                ok=True,
                status=status,
                json=response_json,
                headers=response_headers,
                attempts=attempts,
                refreshed=refreshed,
                replayed_after_401=replayed_after_401,
                retry_decisions=retry_decisions,
            )

        decision = build_retry_decision(
            RetryDecisionInput(
                attempt=attempts,
                method=normalized_method,
                status=status,
                retry_after=_headers_retry_after(response_headers),
                idempotent=idempotent,
                pre_send_failure=pre_send_failure,
                principal=principal,
            ),
            retry_policy,
        )
        retry_decisions.append(decision)

        if decision.action == "refresh_auth":
            lease = get_access_token(force_refresh=True)
            refreshed = True
            replayed_after_401 = True
            continue
        if decision.action == "retry":
            sleep(decision.delay_ms)
            continue

        return RetryingJsonResponse(
            ok=False,
            status=status,
            json=response_json,
            headers=response_headers,
            attempts=attempts,
            refreshed=refreshed,
            replayed_after_401=replayed_after_401,
            retry_decisions=retry_decisions,
        )


def _build_chat_url(
    base_url: str,
    resource_path: str,
    query: dict[str, Any] | None = None,
) -> str:
    trimmed_base = base_url[:-1] if base_url.endswith("/") else base_url
    trimmed_path = resource_path[1:] if resource_path.startswith("/") else resource_path
    encoded = urlencode(
        {
            key: value
            for key, value in (query or {}).items()
            if value is not None
        }
    )
    suffix = f"?{encoded}" if encoded else ""
    return f"{trimmed_base}/{trimmed_path}{suffix}"


class RetryingChatClient:
    def __init__(
        self,
        *,
        principal: str,
        get_access_token: Callable[..., dict[str, Any]],
        request_json_with_retry_impl: Callable[..., RetryingJsonResponse] = request_json_with_retry,
        base_url: str = "https://chat.googleapis.com/v1",
        send: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
        sleep: Callable[[int], None] = _default_sleep,
        retry_policy: RetryPolicyOptions | None = None,
    ) -> None:
        self.principal = principal
        self.get_access_token = get_access_token
        self.request_json_with_retry_impl = request_json_with_retry_impl
        self.base_url = base_url
        self.send = send
        self.sleep = sleep
        self.retry_policy = retry_policy

    def request(
        self,
        *,
        resource_path: str | None = None,
        url: str | None = None,
        query: dict[str, Any] | None = None,
        method: str = "GET",
        headers: dict[str, str] | None = None,
        body: Any = None,
        idempotent: bool = False,
        pre_send_failure: bool = False,
    ) -> RetryingJsonResponse:
        target_url = url or _build_chat_url(self.base_url, resource_path or "", query)
        kwargs = {
            "method": method,
            "url": target_url,
            "principal": self.principal,
            "headers": headers,
            "body": body,
            "idempotent": idempotent,
            "pre_send_failure": pre_send_failure,
            "get_access_token": self.get_access_token,
            "sleep": self.sleep,
            "retry_policy": self.retry_policy,
        }
        if self.send is not None:
            kwargs["send"] = self.send
        return self.request_json_with_retry_impl(**kwargs)

    def get(
        self,
        resource_path: str,
        *,
        query: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> RetryingJsonResponse:
        return self.request(
            resource_path=resource_path,
            query=query,
            headers=headers,
            method="GET",
            idempotent=True,
        )

    def post(
        self,
        resource_path: str,
        body: Any = None,
        *,
        query: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        idempotent: bool = False,
    ) -> RetryingJsonResponse:
        return self.request(
            resource_path=resource_path,
            query=query,
            headers=headers,
            method="POST",
            body=body,
            idempotent=idempotent,
        )


def create_retrying_chat_client(**kwargs: Any) -> RetryingChatClient:
    return RetryingChatClient(**kwargs)


def _event_idempotency_key(event: dict[str, Any]) -> str:
    key = event.get("idempotencyKey") or event.get("eventId")
    if not isinstance(key, str) or not key.strip():
        raise TypeError("Chat event is missing idempotencyKey.")
    return key


def _event_metadata(event: dict[str, Any]) -> dict[str, Any]:
    source = event.get("source") if isinstance(event.get("source"), dict) else {}
    return {
        "eventKind": event.get("kind") if isinstance(event.get("kind"), str) else None,
        "sourceKind": source.get("kind") if isinstance(source.get("kind"), str) else None,
    }


def guard_duplicate_event_delivery(
    event: dict[str, Any],
    *,
    store: InMemoryIdempotencyStore | FileIdempotencyStore,
    ttl_ms: int | None = None,
    now_ms: int | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    claim = store.claim(
        _event_idempotency_key(event),
        ttl_ms=ttl_ms,
        now_ms=now_ms,
        metadata=metadata or _event_metadata(event),
    )
    return {
        "duplicate": claim.duplicate,
        "responseBody": {} if claim.duplicate else None,
        "claim": claim,
    }


__all__ = [
    "FileIdempotencyStore",
    "IdempotencyClaim",
    "InMemoryIdempotencyStore",
    "DuplicateEventGuardResult",
    "RetryDecision",
    "RetryDecisionInput",
    "RetryPolicyOptions",
    "RetryingChatClient",
    "RetryingJsonResponse",
    "build_retry_decision",
    "create_retrying_chat_client",
    "guard_duplicate_event_delivery",
    "is_replay_safe",
    "parse_retry_after_ms",
    "request_json_with_retry",
]
