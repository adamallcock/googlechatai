"""Production token stores for Google Chat AI SDK principals.

Mirrors the Node token-store module (packages/node/src/token-store/index.ts):
an in-memory store, an atomically-written file-backed store, and a Google
Secret Manager-backed store, plus a helper that builds a
transport-compatible get_access_token callable from any TokenStore.
"""

from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Protocol
from urllib.parse import quote, urlencode

from .._file_state import atomic_write_text, file_state_lock


DEFAULT_SECRET_PREFIX = "chat-token-"
DEFAULT_SECRET_MANAGER_BASE_URL = "https://secretmanager.googleapis.com"
_FRESHNESS_MARGIN_MS = 60_000
_MAX_SLUG_LENGTH = 200


@dataclass
class TokenRecord:
    principal_id: str
    access_token: str | None = None
    refresh_token: str | None = None
    expires_at: str | None = None
    scopes: list[str] | None = None
    token_type: str | None = None
    metadata: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"principalId": self.principal_id}
        if self.access_token is not None:
            payload["accessToken"] = self.access_token
        if self.refresh_token is not None:
            payload["refreshToken"] = self.refresh_token
        if self.expires_at is not None:
            payload["expiresAt"] = self.expires_at
        if self.scopes is not None:
            payload["scopes"] = list(self.scopes)
        if self.token_type is not None:
            payload["tokenType"] = self.token_type
        if self.metadata is not None:
            payload["metadata"] = dict(self.metadata)
        return payload

    @staticmethod
    def from_dict(value: dict[str, Any]) -> "TokenRecord":
        return TokenRecord(
            principal_id=value["principalId"],
            access_token=value.get("accessToken"),
            refresh_token=value.get("refreshToken"),
            expires_at=value.get("expiresAt"),
            scopes=list(value["scopes"]) if value.get("scopes") is not None else None,
            token_type=value.get("tokenType"),
            metadata=dict(value["metadata"]) if value.get("metadata") is not None else None,
        )

    def clone(self) -> "TokenRecord":
        return TokenRecord(
            principal_id=self.principal_id,
            access_token=self.access_token,
            refresh_token=self.refresh_token,
            expires_at=self.expires_at,
            scopes=list(self.scopes) if self.scopes is not None else None,
            token_type=self.token_type,
            metadata=dict(self.metadata) if self.metadata is not None else None,
        )


class TokenStore(Protocol):
    def load(self, principal_id: str) -> TokenRecord | None: ...

    def save(self, record: TokenRecord) -> None: ...

    def delete(self, principal_id: str) -> None: ...

    def list(self) -> list[str]: ...


def _required_non_empty_string(value: Any, message: str) -> str:
    if not isinstance(value, str) or value.strip() == "":
        raise TypeError(message)
    return value


def slug(principal_id: str) -> str:
    """Slugify a principal id into a Secret Manager compatible secret-id
    fragment: lowercase, non [a-z0-9-] characters become "-", leading and
    trailing dashes are trimmed, and the result is capped at 200 characters.
    """
    lowered = _required_non_empty_string(
        principal_id,
        "Expected principal_id to be a non-empty string.",
    ).lower()
    replaced = "".join(char if (char.isalnum() and char.isascii()) or char == "-" else "-" for char in lowered)
    trimmed = replaced.strip("-")
    return trimmed[:_MAX_SLUG_LENGTH]


class InMemoryTokenStore:
    def __init__(self) -> None:
        self._records: dict[str, TokenRecord] = {}

    def load(self, principal_id: str) -> TokenRecord | None:
        key = _required_non_empty_string(
            principal_id,
            "Expected principal_id to be a non-empty string.",
        )
        found = self._records.get(key)
        return found.clone() if found is not None else None

    def save(self, record: TokenRecord) -> None:
        key = _required_non_empty_string(
            getattr(record, "principal_id", None),
            "Expected record.principal_id to be a non-empty string.",
        )
        self._records[key] = record.clone()

    def delete(self, principal_id: str) -> None:
        key = _required_non_empty_string(
            principal_id,
            "Expected principal_id to be a non-empty string.",
        )
        self._records.pop(key, None)

    def list(self) -> list[str]:
        return list(self._records.keys())


class FileTokenStore:
    def __init__(self, file_path: str | Path) -> None:
        if not file_path:
            raise TypeError("FileTokenStore requires file_path.")
        self.file_path = Path(file_path)

    def load(self, principal_id: str) -> TokenRecord | None:
        key = _required_non_empty_string(
            principal_id,
            "Expected principal_id to be a non-empty string.",
        )
        records = self._read_records()
        found = records.get(key)
        return found.clone() if found is not None else None

    def save(self, record: TokenRecord) -> None:
        key = _required_non_empty_string(
            getattr(record, "principal_id", None),
            "Expected record.principal_id to be a non-empty string.",
        )
        with file_state_lock(self.file_path):
            records = self._read_records()
            records[key] = record.clone()
            self._write_records(records)

    def delete(self, principal_id: str) -> None:
        key = _required_non_empty_string(
            principal_id,
            "Expected principal_id to be a non-empty string.",
        )
        with file_state_lock(self.file_path):
            records = self._read_records()
            if records.pop(key, None) is not None:
                self._write_records(records)

    def list(self) -> list[str]:
        return list(self._read_records().keys())

    def _read_records(self) -> dict[str, TokenRecord]:
        if not self.file_path.exists():
            return {}
        parsed = json.loads(self.file_path.read_text("utf8"))
        return {
            key: TokenRecord.from_dict(value)
            for key, value in parsed.get("records", {}).items()
        }

    def _write_records(self, records: dict[str, TokenRecord]) -> None:
        payload = {
            "version": 1,
            "records": {key: record.to_dict() for key, record in records.items()},
        }
        atomic_write_text(self.file_path, f"{json.dumps(payload, indent=2)}\n")


def _secret_manager_base_url(base_url: str | None) -> str:
    return (base_url or DEFAULT_SECRET_MANAGER_BASE_URL).rstrip("/")


def _bytes_to_base64(value: str) -> str:
    return base64.b64encode(value.encode("utf8")).decode("ascii")


def _base64_to_str(value: str) -> str:
    return base64.b64decode(value).decode("utf8")


def _token_value(lease: dict[str, Any]) -> str:
    return str(lease.get("access_token") or lease.get("accessToken") or "")


def _token_type(lease: dict[str, Any]) -> str:
    return str(lease.get("token_type") or lease.get("tokenType") or "Bearer")


class SecretManagerTokenStore:
    def __init__(
        self,
        *,
        project_id: str,
        send: Callable[[dict[str, Any]], dict[str, Any]],
        get_access_token: Callable[..., dict[str, Any]],
        secret_prefix: str = DEFAULT_SECRET_PREFIX,
        base_url: str | None = None,
    ) -> None:
        if not project_id:
            raise TypeError("SecretManagerTokenStore requires project_id.")
        if not callable(send):
            raise TypeError("SecretManagerTokenStore requires an injected send callable.")
        if not callable(get_access_token):
            raise TypeError("SecretManagerTokenStore requires an injected get_access_token callable.")
        self.project_id = project_id
        self.send = send
        self.get_access_token = get_access_token
        self.secret_prefix = secret_prefix
        self.base_url = _secret_manager_base_url(base_url)

    def load(self, principal_id: str) -> TokenRecord | None:
        secret_name = self._secret_name(principal_id)
        response = self._request(
            "GET",
            f"{self.base_url}/v1/projects/{quote(self.project_id, safe='')}/secrets/{quote(secret_name, safe='')}/versions/latest:access",
            secret_name,
            allow_404=True,
        )
        if response is None:
            return None
        payload = (response.get("json") or {}).get("payload") or {}
        data = payload.get("data")
        if not data:
            return None
        decoded = _base64_to_str(data)
        return TokenRecord.from_dict(json.loads(decoded))

    def save(self, record: TokenRecord) -> None:
        principal_id = _required_non_empty_string(
            getattr(record, "principal_id", None),
            "Expected record.principal_id to be a non-empty string.",
        )
        secret_name = self._secret_name(principal_id)
        encoded_payload = _bytes_to_base64(json.dumps(record.to_dict()))

        add_version_response = self._request(
            "POST",
            f"{self.base_url}/v1/projects/{quote(self.project_id, safe='')}/secrets/{quote(secret_name, safe='')}:addVersion",
            secret_name,
            allow_404=True,
            body={"payload": {"data": encoded_payload}},
        )
        if add_version_response is not None:
            return

        self._request(
            "POST",
            f"{self.base_url}/v1/projects/{quote(self.project_id, safe='')}/secrets?secretId={quote(secret_name, safe='')}",
            secret_name,
            body={
                "replication": {"automatic": {}},
                "labels": {"principal": slug(principal_id)},
            },
        )
        self._request(
            "POST",
            f"{self.base_url}/v1/projects/{quote(self.project_id, safe='')}/secrets/{quote(secret_name, safe='')}:addVersion",
            secret_name,
            body={"payload": {"data": encoded_payload}},
        )

    def delete(self, principal_id: str) -> None:
        secret_name = self._secret_name(principal_id)
        self._request(
            "DELETE",
            f"{self.base_url}/v1/projects/{quote(self.project_id, safe='')}/secrets/{quote(secret_name, safe='')}",
            secret_name,
            allow_404=True,
        )

    def list(self) -> list[str]:
        principal_ids: list[str] = []
        page_token: str | None = None
        filter_value = f"name:{self.secret_prefix}"

        while True:
            query = {"filter": filter_value}
            if page_token:
                query["pageToken"] = page_token
            response = self._request(
                "GET",
                f"{self.base_url}/v1/projects/{quote(self.project_id, safe='')}/secrets?{urlencode(query)}",
                "list",
            )
            if response is None:
                break
            body = response.get("json") or {}
            for secret in body.get("secrets") or []:
                name = secret.get("name") or ""
                short_name = name.rsplit("/", 1)[-1]
                if short_name.startswith(self.secret_prefix):
                    principal_ids.append(short_name[len(self.secret_prefix):])
            page_token = body.get("nextPageToken")
            if not page_token:
                break

        return principal_ids

    def _secret_name(self, principal_id: str) -> str:
        validated = _required_non_empty_string(
            principal_id,
            "Expected principal_id to be a non-empty string.",
        )
        return f"{self.secret_prefix}{slug(validated)}"

    def _request(
        self,
        method: str,
        url: str,
        secret_name: str,
        *,
        allow_404: bool = False,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        lease = self.get_access_token(force_refresh=False)
        request = {
            "url": url,
            "method": method,
            "headers": {
                "content-type": "application/json",
                "authorization": f"{_token_type(lease)} {_token_value(lease)}",
            },
            "body": body,
        }
        response = self.send(request)

        if response.get("ok"):
            return response
        status = int(response.get("status") or 0)
        if allow_404 and status == 404:
            return None
        raise Exception(f"Secret Manager {method} {status} for {secret_name}")


def _is_fresh(record: TokenRecord, now_ms: int) -> bool:
    if not record.access_token:
        return False
    if not record.expires_at:
        return True
    try:
        expires_at_ms = round(
            datetime.fromisoformat(record.expires_at.replace("Z", "+00:00")).timestamp() * 1000
        )
    except ValueError:
        return True
    return expires_at_ms > now_ms + _FRESHNESS_MARGIN_MS


def get_access_token_from_store(
    *,
    store: TokenStore,
    principal_id: str,
    refresh: Callable[[TokenRecord], TokenRecord],
) -> Callable[..., dict[str, Any]]:
    """Builds a transport-compatible get_access_token callable backed by a
    TokenStore. On each call it loads the stored record for principal_id; if
    the stored access token is fresh (expires_at missing or more than 60s in
    the future) and force_refresh was not requested, it returns the cached
    token. Otherwise it calls the injected refresh callback, persists the
    refreshed record back to the store, and returns the new lease.
    """
    if store is None:
        raise TypeError("get_access_token_from_store requires store.")
    validated_principal_id = _required_non_empty_string(
        principal_id,
        "Expected principal_id to be a non-empty string.",
    )
    if not callable(refresh):
        raise TypeError("get_access_token_from_store requires refresh.")

    def get_access_token(*, force_refresh: bool = False) -> dict[str, Any]:
        record = store.load(validated_principal_id)
        if record is None:
            raise Exception(f"No token record found for principal {validated_principal_id}.")

        if not force_refresh and _is_fresh(record, round(time.time() * 1000)):
            return {
                "access_token": record.access_token,
                "refreshed": False,
                "token_type": record.token_type,
            }

        refreshed_record = refresh(record)
        store.save(refreshed_record)
        return {
            "access_token": refreshed_record.access_token,
            "refreshed": True,
            "token_type": refreshed_record.token_type,
        }

    return get_access_token


__all__ = [
    "DEFAULT_SECRET_MANAGER_BASE_URL",
    "DEFAULT_SECRET_PREFIX",
    "FileTokenStore",
    "InMemoryTokenStore",
    "SecretManagerTokenStore",
    "TokenRecord",
    "TokenStore",
    "get_access_token_from_store",
    "slug",
]
