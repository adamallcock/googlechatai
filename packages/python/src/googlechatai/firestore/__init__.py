"""Dependency-free Firestore REST idempotency reference adapter.

The adapter owns only Firestore document shaping and conditional-create/CAS
logic. Applications inject an already-authenticated transport, so credentials
remain in their existing Google auth stack and never enter SDK persistence or
logs.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import random as random_module
import time
from typing import Any, Callable, Mapping
from urllib.parse import quote, urlencode

from ..transport import IdempotencyClaim


DEFAULT_TTL_MS = 10 * 60 * 1000
DEFAULT_BASE_URL = "https://firestore.googleapis.com/v1"
_MAX_CAS_ATTEMPTS = 5
_DEFAULT_CAS_RETRY_BASE_DELAY_MS = 5
_DEFAULT_CAS_RETRY_MAX_DELAY_MS = 100

FirestoreTransport = Callable[[dict[str, Any]], Mapping[str, Any]]


class FirestoreIdempotencyStoreError(RuntimeError):
    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class _StoredDocument:
    key: str
    first_seen_at_ms: int
    last_seen_at_ms: int
    expires_at_ms: int
    seen_count: int
    metadata: dict[str, Any] | None
    update_time: str


def _required_string(value: Any, message: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TypeError(message)
    return value


def _positive_ms(value: Any, fallback: int) -> int:
    return value if isinstance(value, int) and value > 0 else fallback


def _non_negative_option_ms(value: Any, fallback: int) -> int:
    return value if isinstance(value, int) and value >= 0 else fallback


def _non_negative_ms(value: Any) -> int:
    if isinstance(value, int) and value >= 0:
        return value
    return round(datetime.now(tz=timezone.utc).timestamp() * 1000)


def _iso(value: int) -> str:
    return (
        datetime.fromtimestamp(value / 1000, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _parse_iso_ms(value: str) -> int:
    return round(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def _as_mapping(value: Any) -> Mapping[str, Any] | None:
    return value if isinstance(value, Mapping) else None


def _string_field(fields: Mapping[str, Any], name: str) -> str | None:
    field = _as_mapping(fields.get(name))
    value = field.get("stringValue") if field is not None else None
    if not isinstance(value, str):
        value = field.get("timestampValue") if field is not None else None
    return value if isinstance(value, str) else None


def _integer_field(fields: Mapping[str, Any], name: str) -> int | None:
    field = _as_mapping(fields.get(name))
    value = field.get("integerValue") if field is not None else None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _parse_metadata(fields: Mapping[str, Any]) -> dict[str, Any] | None:
    value = _string_field(fields, "metadataJson")
    if not value:
        return None
    try:
        parsed = _as_mapping(json.loads(value))
    except json.JSONDecodeError as exc:
        raise TypeError("Firestore idempotency metadataJson must contain an object.") from exc
    if parsed is None:
        raise TypeError("Firestore idempotency metadataJson must contain an object.")
    return dict(parsed)


def _document_from_response(value: Any) -> _StoredDocument:
    document = _as_mapping(value)
    fields = _as_mapping(document.get("fields") if document is not None else None)
    update_time = document.get("updateTime") if document is not None else None
    if fields is None or not isinstance(update_time, str) or not update_time:
        raise TypeError("Firestore idempotency document is missing fields or updateTime.")
    key = _string_field(fields, "key")
    first_seen_at = _string_field(fields, "firstSeenAt")
    last_seen_at = _string_field(fields, "lastSeenAt")
    expires_at = _string_field(fields, "expiresAt")
    seen_count = _integer_field(fields, "seenCount")
    if not all((key, first_seen_at, last_seen_at, expires_at, seen_count)):
        raise TypeError("Firestore idempotency document has invalid claim fields.")
    try:
        return _StoredDocument(
            key=key,
            first_seen_at_ms=_parse_iso_ms(first_seen_at),
            last_seen_at_ms=_parse_iso_ms(last_seen_at),
            expires_at_ms=_parse_iso_ms(expires_at),
            seen_count=seen_count,
            metadata=_parse_metadata(fields),
            update_time=update_time,
        )
    except (TypeError, ValueError) as exc:
        raise TypeError("Firestore idempotency document has invalid claim timestamps.") from exc


def _claim_from_document(
    document: _StoredDocument,
    *,
    claimed: bool,
    duplicate: bool,
) -> IdempotencyClaim:
    return IdempotencyClaim(
        key=document.key,
        claimed=claimed,
        duplicate=duplicate,
        first_seen_at=_iso(document.first_seen_at_ms),
        last_seen_at=_iso(document.last_seen_at_ms),
        expires_at=_iso(document.expires_at_ms),
        seen_count=document.seen_count,
        metadata=document.metadata,
    )


def _fields_for_document(document: _StoredDocument) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "key": {"stringValue": document.key},
        "firstSeenAt": {"timestampValue": _iso(document.first_seen_at_ms)},
        "lastSeenAt": {"timestampValue": _iso(document.last_seen_at_ms)},
        "expiresAt": {"timestampValue": _iso(document.expires_at_ms)},
        "seenCount": {"integerValue": str(document.seen_count)},
    }
    if document.metadata is not None:
        fields["metadataJson"] = {"stringValue": json.dumps(document.metadata)}
    return fields


def _update_fields_for_document(document: _StoredDocument) -> dict[str, Any]:
    return {
        "lastSeenAt": {"timestampValue": _iso(document.last_seen_at_ms)},
        "seenCount": {"integerValue": str(document.seen_count)},
    }


def _normalized_collection_path(value: Any) -> str:
    path = _required_string(value, "Firestore collection_path must be non-empty.")
    segments = path.split("/")
    if not segments or any(not segment.strip() for segment in segments) or len(segments) % 2 == 0:
        raise TypeError(
            "Firestore collection_path must contain an odd number of non-empty path segments."
        )
    return "/".join(quote(segment, safe="") for segment in segments)


def _document_id(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _with_query(url: str, values: list[tuple[str, str]]) -> str:
    return f"{url}?{urlencode(values)}"


class FirestoreIdempotencyStore:
    """Firestore REST store using create + update-time compare-and-set.

    ``request`` receives dictionaries with ``method``, ``url``, and optionally
    ``body``. It must return a mapping with integer ``status`` and optional
    decoded JSON ``json``. The transport is expected to add authentication.
    """

    # Firestore REST transports are normally blocking network calls. The
    # router observes this marker and offloads them in async/deadline paths;
    # generic application-owned stores remain inline by default so a
    # thread-affine SQLite/session store retains its declared contract.
    requires_thread_offload = True

    def __init__(
        self,
        *,
        project_id: str,
        collection_path: str,
        request: FirestoreTransport,
        database_id: str = "(default)",
        base_url: str = DEFAULT_BASE_URL,
        default_ttl_ms: int = DEFAULT_TTL_MS,
        max_cas_attempts: int = _MAX_CAS_ATTEMPTS,
        cas_retry_base_delay_ms: int = _DEFAULT_CAS_RETRY_BASE_DELAY_MS,
        cas_retry_max_delay_ms: int = _DEFAULT_CAS_RETRY_MAX_DELAY_MS,
        sleep: Callable[[float], None] | None = None,
        random: Callable[[], float] | None = None,
    ) -> None:
        self._project_id = _required_string(project_id, "Firestore project_id must be non-empty.")
        self._collection_path = _normalized_collection_path(collection_path)
        if not callable(request):
            raise TypeError("FirestoreIdempotencyStore requires an injected request transport.")
        self._request = request
        self._database_id = _required_string(
            database_id,
            "Firestore database_id must be non-empty.",
        )
        self._base_url = _required_string(base_url, "Firestore base_url must be non-empty.").rstrip("/")
        self._default_ttl_ms = _positive_ms(default_ttl_ms, DEFAULT_TTL_MS)
        self._max_cas_attempts = _positive_ms(max_cas_attempts, _MAX_CAS_ATTEMPTS)
        self._cas_retry_base_delay_ms = _non_negative_option_ms(
            cas_retry_base_delay_ms,
            _DEFAULT_CAS_RETRY_BASE_DELAY_MS,
        )
        self._cas_retry_max_delay_ms = _non_negative_option_ms(
            cas_retry_max_delay_ms,
            _DEFAULT_CAS_RETRY_MAX_DELAY_MS,
        )
        if self._cas_retry_max_delay_ms < self._cas_retry_base_delay_ms:
            raise TypeError(
                "cas_retry_max_delay_ms must be greater than or equal to cas_retry_base_delay_ms."
            )
        self._sleep = sleep or time.sleep
        self._random = random or random_module.random

    def claim(
        self,
        key: str,
        *,
        ttl_ms: int | None = None,
        now_ms: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> IdempotencyClaim:
        normalized_key = _required_string(key, "Idempotency key must be a non-empty string.")
        effective_now = _non_negative_ms(now_ms)
        document_id = _document_id(normalized_key)
        collection_url = self._collection_url()
        document_url = f"{collection_url}/{document_id}"
        initial = _StoredDocument(
            key=normalized_key,
            first_seen_at_ms=effective_now,
            last_seen_at_ms=effective_now,
            expires_at_ms=effective_now + _positive_ms(ttl_ms, self._default_ttl_ms),
            seen_count=1,
            metadata=dict(metadata) if metadata is not None else None,
            update_time="created",
        )

        for attempt in range(self._max_cas_attempts):
            create = self._send(
                "POST",
                _with_query(collection_url, [("documentId", document_id)]),
                {"fields": _fields_for_document(initial)},
            )
            if self._ok(create):
                return _claim_from_document(initial, claimed=True, duplicate=False)
            if self._status(create) != 409:
                raise FirestoreIdempotencyStoreError(
                    "Firestore idempotency create request failed.", self._status(create)
                )

            existing_response = self._send("GET", document_url)
            if self._status(existing_response) == 404:
                self._retry_after_conflict(attempt)
                continue
            if not self._ok(existing_response):
                raise FirestoreIdempotencyStoreError(
                    "Firestore idempotency read request failed.", self._status(existing_response)
                )
            existing = _document_from_response(existing_response.get("json"))
            if existing.key != normalized_key:
                raise FirestoreIdempotencyStoreError(
                    "Firestore idempotency document key did not match its document ID.",
                    self._status(existing_response),
                )

            if existing.expires_at_ms <= effective_now:
                remove = self._send(
                    "DELETE",
                    _with_query(
                        document_url,
                        [("currentDocument.updateTime", existing.update_time)],
                    ),
                )
                if (
                    self._ok(remove)
                    or self._status(remove) == 404
                    or self._is_failed_precondition(remove)
                ):
                    self._retry_after_conflict(attempt)
                    continue
                raise FirestoreIdempotencyStoreError(
                    "Firestore idempotency expiry cleanup failed.", self._status(remove)
                )

            updated = _StoredDocument(
                key=existing.key,
                first_seen_at_ms=existing.first_seen_at_ms,
                last_seen_at_ms=effective_now,
                expires_at_ms=existing.expires_at_ms,
                seen_count=existing.seen_count + 1,
                metadata=existing.metadata,
                update_time=existing.update_time,
            )
            update = self._send(
                "PATCH",
                _with_query(
                    document_url,
                    [
                        ("currentDocument.updateTime", existing.update_time),
                        ("updateMask.fieldPaths", "lastSeenAt"),
                        ("updateMask.fieldPaths", "seenCount"),
                    ],
                ),
                {"fields": _update_fields_for_document(updated)},
            )
            if self._ok(update):
                return _claim_from_document(updated, claimed=False, duplicate=True)
            if self._is_failed_precondition(update):
                self._retry_after_conflict(attempt)
                continue
            raise FirestoreIdempotencyStoreError(
                "Firestore idempotency compare-and-set update failed.", self._status(update)
            )

        raise FirestoreIdempotencyStoreError(
            "Firestore idempotency claim conflicted repeatedly; retry the delivery.", 409
        )

    def _collection_url(self) -> str:
        return (
            f"{self._base_url}/projects/{quote(self._project_id, safe='')}"
            f"/databases/{quote(self._database_id, safe='')}/documents/{self._collection_path}"
        )

    def _send(
        self,
        method: str,
        url: str,
        body: dict[str, Any] | None = None,
    ) -> Mapping[str, Any]:
        request: dict[str, Any] = {"method": method, "url": url}
        if body is not None:
            request["body"] = body
        response = _as_mapping(self._request(request))
        if response is None:
            raise TypeError("Firestore transport must return a mapping response.")
        if not isinstance(response.get("status"), int):
            raise TypeError("Firestore transport response must include an integer status.")
        return response

    @staticmethod
    def _status(response: Mapping[str, Any]) -> int:
        return int(response["status"])

    @classmethod
    def _ok(cls, response: Mapping[str, Any]) -> bool:
        return 200 <= cls._status(response) < 300

    @classmethod
    def _is_failed_precondition(cls, response: Mapping[str, Any]) -> bool:
        if cls._status(response) == 409:
            return True
        if cls._status(response) != 400:
            return False
        payload = _as_mapping(response.get("json")) or {}
        error = _as_mapping(payload.get("error")) or payload
        return error.get("status") == "FAILED_PRECONDITION"

    def _retry_after_conflict(self, attempt: int) -> None:
        if (
            attempt + 1 >= self._max_cas_attempts
            or self._cas_retry_base_delay_ms == 0
        ):
            return
        exponential = min(
            self._cas_retry_max_delay_ms,
            self._cas_retry_base_delay_ms * 2**attempt,
        )
        jitter = self._random()
        if not isinstance(jitter, (int, float)):
            jitter = 0.5
        jitter = min(1.0, max(0.0, float(jitter)))
        self._sleep(round(exponential * (0.5 + jitter * 0.5)) / 1000)


__all__ = [
    "DEFAULT_BASE_URL",
    "DEFAULT_TTL_MS",
    "FirestoreIdempotencyStore",
    "FirestoreIdempotencyStoreError",
    "FirestoreTransport",
]
