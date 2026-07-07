"""Dependency-free auth/retry and idempotency adapter examples."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import tempfile
from typing import Any

from googlechatai import FileIdempotencyStore, request_json_with_retry


class ExampleTokenBroker:
    def __init__(self) -> None:
        self._tokens = {
            "user:adam@example.com": {
                "stale": "stale-user-token",
                "fresh": "fresh-user-token",
            }
        }

    def get_access_token(
        self,
        *,
        principal_id: str,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        token = self._tokens.get(principal_id)
        if token is None:
            raise RuntimeError(f"No token lease is available for {principal_id}.")
        return {
            "access_token": token["fresh"] if force_refresh else token["stale"],
            "refreshed": force_refresh,
        }


@dataclass
class StoredClaim:
    first_seen_at_ms: int
    last_seen_at_ms: int
    expires_at_ms: int
    seen_count: int
    metadata: dict[str, Any] | None = None


class CompareAndSetBackend:
    def __init__(self) -> None:
        self._records: dict[str, StoredClaim] = {}

    def create_if_absent(self, key: str, value: StoredClaim) -> bool:
        if key in self._records:
            return False
        self._records[key] = value
        return True

    def get(self, key: str) -> StoredClaim | None:
        return self._records.get(key)

    def update_seen(self, key: str, now_ms: int) -> StoredClaim | None:
        current = self._records.get(key)
        if current is None:
            return None
        current.last_seen_at_ms = now_ms
        current.seen_count += 1
        return current

    def replace(self, key: str, value: StoredClaim) -> None:
        self._records[key] = value


class ExternalIdempotencyStore:
    def __init__(
        self,
        *,
        backend: CompareAndSetBackend,
        default_ttl_ms: int = 10 * 60 * 1000,
    ) -> None:
        self.backend = backend
        self.default_ttl_ms = default_ttl_ms

    def claim(
        self,
        key: str,
        *,
        ttl_ms: int | None = None,
        now_ms: int,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        existing = self.backend.get(key)
        expired = existing is not None and existing.expires_at_ms <= now_ms
        if existing is not None and not expired:
            updated = self.backend.update_seen(key, now_ms)
            return claim_from_record(key, updated, claimed=False, duplicate=True)

        effective_ttl_ms = ttl_ms or self.default_ttl_ms
        record = StoredClaim(
            first_seen_at_ms=now_ms,
            last_seen_at_ms=now_ms,
            expires_at_ms=now_ms + effective_ttl_ms,
            seen_count=1,
            metadata=metadata,
        )
        if expired:
            self.backend.replace(key, record)
            return claim_from_record(key, record, claimed=True, duplicate=False)

        inserted = self.backend.create_if_absent(key, record)
        if not inserted:
            updated = self.backend.update_seen(key, now_ms)
            return claim_from_record(key, updated, claimed=False, duplicate=True)
        return claim_from_record(key, record, claimed=True, duplicate=False)


def iso(ms: int) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace(
        "+00:00",
        "Z",
    )


def claim_from_record(
    key: str,
    record: StoredClaim | None,
    *,
    claimed: bool,
    duplicate: bool,
) -> dict[str, Any]:
    if record is None:
        raise RuntimeError("Expected stored idempotency claim.")
    return {
        "key": key,
        "claimed": claimed,
        "duplicate": duplicate,
        "firstSeenAt": iso(record.first_seen_at_ms),
        "lastSeenAt": iso(record.last_seen_at_ms),
        "expiresAt": iso(record.expires_at_ms),
        "seenCount": record.seen_count,
        "metadata": record.metadata,
    }


def demo_retrying_user_read() -> dict[str, Any]:
    token_broker = ExampleTokenBroker()
    authorizations: list[str] = []

    def get_access_token(*, force_refresh: bool = False) -> dict[str, Any]:
        return token_broker.get_access_token(
            principal_id="user:adam@example.com",
            force_refresh=force_refresh,
        )

    def send(request: dict[str, Any]) -> dict[str, Any]:
        authorizations.append(request["headers"]["authorization"])
        if len(authorizations) == 1:
            return {
                "ok": False,
                "status": 401,
                "json": {"error": {"status": "UNAUTHENTICATED"}},
                "headers": {},
            }
        return {
            "ok": True,
            "status": 200,
            "json": {"spaces": []},
            "headers": {},
        }

    result = request_json_with_retry(
        method="GET",
        url="https://chat.googleapis.com/v1/spaces?pageSize=1",
        principal="user",
        get_access_token=get_access_token,
        send=send,
        sleep=lambda _delay_ms: None,
    )

    return {
        "ok": result.ok,
        "status": result.status,
        "attempts": result.attempts,
        "refreshed": result.refreshed,
        "replayedAfter401": result.replayed_after_401,
        "rawTokensPrinted": False,
    }


def demo_idempotency_stores() -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as tmpdir:
        local_store = FileIdempotencyStore(
            Path(tmpdir) / "idempotency.json",
            default_ttl_ms=60_000,
        )
        external_store = ExternalIdempotencyStore(
            backend=CompareAndSetBackend(),
            default_ttl_ms=60_000,
        )

        local_first = local_store.claim("event-id-hash-local", now_ms=1_000)
        local_duplicate = local_store.claim("event-id-hash-local", now_ms=2_000)
        local_after_expiry = local_store.claim(
            "event-id-hash-local",
            now_ms=62_000,
        )
        external_first = external_store.claim(
            "event-id-hash-external",
            now_ms=1_000,
            metadata={"source": "direct_chat_event"},
        )
        external_duplicate = external_store.claim(
            "event-id-hash-external",
            now_ms=2_000,
        )
        external_after_expiry = external_store.claim(
            "event-id-hash-external",
            now_ms=62_000,
        )

        return {
            "localFileStore": {
                "firstClaimed": local_first.claimed,
                "duplicateSuppressed": local_duplicate.duplicate,
                "seenCount": local_duplicate.seen_count,
                "afterExpiryClaimed": local_after_expiry.claimed,
            },
            "externalCompareAndSetStore": {
                "firstClaimed": external_first["claimed"],
                "duplicateSuppressed": external_duplicate["duplicate"],
                "seenCount": external_duplicate["seenCount"],
                "afterExpiryClaimed": external_after_expiry["claimed"],
            },
        }


if __name__ == "__main__":
    print(
        json.dumps(
            {
                "retryingUserRead": demo_retrying_user_read(),
                "idempotency": demo_idempotency_stores(),
            },
            indent=2,
        )
    )
