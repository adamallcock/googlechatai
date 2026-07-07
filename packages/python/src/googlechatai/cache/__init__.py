"""Content-addressed local cache helpers for attachments, documents, and transcripts."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from typing import Any


DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000


def _bytes(value: str | bytes | bytearray | memoryview) -> bytes:
    if isinstance(value, str):
        return value.encode("utf-8")
    return bytes(value)


def _iso(ms: int) -> str:
    return (
        datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _parse_iso(value: str | None) -> int | None:
    if not value:
        return None
    return round(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def _now(value: int | None) -> int:
    if isinstance(value, int) and value >= 0:
        return value
    return round(datetime.now(tz=timezone.utc).timestamp() * 1000)


def _ttl(value: int | None) -> int:
    if isinstance(value, int) and value > 0:
        return value
    return DEFAULT_CACHE_TTL_MS


def _key(value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TypeError("Cache key must be a non-empty string.")
    return value


def _stable_json(value: Any) -> str:
    if isinstance(value, Mapping):
        return "{" + ",".join(
            f"{json.dumps(key)}:{_stable_json(value[key])}"
            for key in sorted(value.keys())
            if value[key] is not None
        ) + "}"
    if isinstance(value, list):
        return "[" + ",".join(_stable_json(item) for item in value) + "]"
    return json.dumps(value)


def _hash_string(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def hash_bytes(value: str | bytes | bytearray | memoryview) -> str:
    return hashlib.sha256(_bytes(value)).hexdigest()


def build_artifact_cache_key(
    *,
    namespace: str,
    source_id: str,
    bytes_value: str | bytes | bytearray | memoryview,
    processor: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    normalized_namespace = _key(namespace)
    normalized_source_id = _key(source_id)
    content_sha256 = hash_bytes(bytes_value)
    processor_hash = _hash_string(_stable_json(processor)) if processor else None
    material = _stable_json(
        {
            "namespace": normalized_namespace,
            "sourceId": normalized_source_id,
            "contentSha256": content_sha256,
            "processorHash": processor_hash,
        }
    )
    return {
        "namespace": normalized_namespace,
        "key": f"{normalized_namespace}:{_hash_string(material)}",
        "contentSha256": content_sha256,
        "processorHash": processor_hash,
        "sizeBytes": len(_bytes(bytes_value)),
    }


def build_negative_cache_entry(
    *,
    key: str,
    reason: str,
    source_id: str | None = None,
    now_ms: int | None = None,
    ttl_ms: int | None = None,
) -> dict[str, Any]:
    effective_now = _now(now_ms)
    effective_ttl = _ttl(ttl_ms)
    return {
        "hit": True,
        "negative": True,
        "key": _key(key),
        "reason": _key(reason),
        "sourceId": source_id,
        "createdAt": _iso(effective_now),
        "expiresAt": _iso(effective_now + effective_ttl),
    }


def _expired(expires_at: str | None, now_ms: int) -> bool:
    parsed = _parse_iso(expires_at)
    return parsed is not None and parsed <= now_ms


class InMemoryArtifactCache:
    def __init__(self) -> None:
        self._entries: dict[str, dict[str, Any]] = {}

    def get(self, key: str, *, now_ms: int | None = None) -> dict[str, Any]:
        normalized_key = _key(key)
        effective_now = _now(now_ms)
        entry = self._entries.get(normalized_key)
        if entry is None:
            return {"hit": False, "key": normalized_key, "reason": "missing"}
        if _expired(entry.get("expiresAt"), effective_now):
            del self._entries[normalized_key]
            return {"hit": False, "key": normalized_key, "reason": "expired"}
        if entry.get("negative"):
            return dict(entry)
        bytes_value = entry["bytes"]
        return {
            "hit": True,
            "negative": False,
            "key": normalized_key,
            "metadata": dict(entry.get("metadata") or {}),
            "bytes": bytes_value,
            "text": bytes_value.decode("utf-8"),
            "createdAt": entry["createdAt"],
            "expiresAt": entry.get("expiresAt"),
        }

    def put(
        self,
        *,
        key: str,
        bytes_value: str | bytes | bytearray | memoryview,
        metadata: Mapping[str, Any] | None = None,
        now_ms: int | None = None,
        ttl_ms: int | None = None,
    ) -> dict[str, Any]:
        normalized_key = _key(key)
        effective_now = _now(now_ms)
        effective_ttl = _ttl(ttl_ms)
        self._entries[normalized_key] = {
            "negative": False,
            "key": normalized_key,
            "metadata": dict(metadata or {}),
            "bytes": _bytes(bytes_value),
            "createdAt": _iso(effective_now),
            "expiresAt": _iso(effective_now + effective_ttl),
        }
        return self.get(normalized_key, now_ms=effective_now)

    def put_negative(self, entry: Mapping[str, Any]) -> dict[str, Any]:
        normalized_key = _key(str(entry.get("key")))
        self._entries[normalized_key] = dict(entry)
        return dict(entry)


class FileArtifactCache:
    def __init__(self, directory: str | Path) -> None:
        self.directory = Path(directory)

    def get(self, key: str, *, now_ms: int | None = None) -> dict[str, Any]:
        normalized_key = _key(key)
        metadata = self._read_metadata(normalized_key)
        if metadata is None:
            return {"hit": False, "key": normalized_key, "reason": "missing"}
        if _expired(metadata.get("expiresAt"), _now(now_ms)):
            return {"hit": False, "key": normalized_key, "reason": "expired"}
        if metadata.get("kind") == "negative":
            return {
                "hit": True,
                "negative": True,
                "key": normalized_key,
                "reason": metadata.get("reason") or "negative_cache",
                "sourceId": metadata.get("sourceId"),
                "createdAt": metadata["createdAt"],
                "expiresAt": metadata["expiresAt"],
            }
        blob = metadata.get("blob")
        if not blob:
            return {"hit": False, "key": normalized_key, "reason": "missing"}
        bytes_value = (self.directory / "blobs" / blob).read_bytes()
        return {
            "hit": True,
            "negative": False,
            "key": normalized_key,
            "metadata": dict(metadata.get("metadata") or {}),
            "bytes": bytes_value,
            "text": bytes_value.decode("utf-8"),
            "createdAt": metadata["createdAt"],
            "expiresAt": metadata.get("expiresAt"),
        }

    def put(
        self,
        *,
        key: str,
        bytes_value: str | bytes | bytearray | memoryview,
        metadata: Mapping[str, Any] | None = None,
        now_ms: int | None = None,
        ttl_ms: int | None = None,
    ) -> dict[str, Any]:
        normalized_key = _key(key)
        effective_now = _now(now_ms)
        effective_ttl = _ttl(ttl_ms)
        bytes_data = _bytes(bytes_value)
        blob = f"{hash_bytes(bytes_data)}.bin"
        blob_dir = self.directory / "blobs"
        blob_dir.mkdir(parents=True, exist_ok=True)
        (blob_dir / blob).write_bytes(bytes_data)
        self._write_metadata(
            normalized_key,
            {
                "version": 1,
                "kind": "artifact",
                "key": normalized_key,
                "metadata": dict(metadata or {}),
                "blob": blob,
                "createdAt": _iso(effective_now),
                "expiresAt": _iso(effective_now + effective_ttl),
            },
        )
        return self.get(normalized_key, now_ms=effective_now)

    def put_negative(self, entry: Mapping[str, Any]) -> dict[str, Any]:
        normalized_key = _key(str(entry.get("key")))
        self._write_metadata(
            normalized_key,
            {
                "version": 1,
                "kind": "negative",
                "key": normalized_key,
                "reason": entry.get("reason"),
                "sourceId": entry.get("sourceId"),
                "createdAt": entry.get("createdAt"),
                "expiresAt": entry.get("expiresAt"),
            },
        )
        return dict(entry)

    def _metadata_path(self, key: str) -> Path:
        return self.directory / "metadata" / f"{_hash_string(key)}.json"

    def _read_metadata(self, key: str) -> dict[str, Any] | None:
        path = self._metadata_path(key)
        if not path.exists():
            return None
        return json.loads(path.read_text("utf-8"))

    def _write_metadata(self, key: str, metadata: Mapping[str, Any]) -> None:
        metadata_dir = self.directory / "metadata"
        metadata_dir.mkdir(parents=True, exist_ok=True)
        self._metadata_path(key).write_text(
            f"{json.dumps(dict(metadata), indent=2)}\n",
            "utf-8",
        )


__all__ = [
    "FileArtifactCache",
    "InMemoryArtifactCache",
    "build_artifact_cache_key",
    "build_negative_cache_entry",
    "hash_bytes",
]
