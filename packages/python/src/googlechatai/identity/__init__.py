"""Directory identity enrichment helpers."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlencode


DIRECTORY_USER_READONLY_SCOPE = (
    "https://www.googleapis.com/auth/admin.directory.user.readonly"
)
DIRECTORY_SYNC_TTL_MS = 24 * 60 * 60 * 1000


def _iso(ms: int) -> str:
    return (
        datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _email_list(user: Mapping[str, Any]) -> list[str]:
    emails: list[str] = []
    for value in [user.get("primaryEmail"), *list(user.get("aliases") or [])]:
        if isinstance(value, str) and value:
            emails.append(value.lower())
    for item in user.get("emails") or []:
        if isinstance(item, str):
            emails.append(item.lower())
        elif isinstance(item, Mapping) and isinstance(item.get("address"), str):
            emails.append(item["address"].lower())
    return list(dict.fromkeys(emails))


def _display_name(user: Mapping[str, Any]) -> str | None:
    name = user.get("name") if isinstance(user.get("name"), Mapping) else {}
    if isinstance(name.get("fullName"), str) and name["fullName"]:
        return name["fullName"]
    parts = [
        value
        for value in [name.get("givenName"), name.get("familyName")]
        if isinstance(value, str) and value
    ]
    return " ".join(parts) if parts else user.get("primaryEmail")


def _status(user: Mapping[str, Any]) -> str:
    if user.get("deleted"):
        return "deleted"
    if user.get("suspended"):
        return "suspended"
    return "active"


def _record_from_user(user: Mapping[str, Any], now_ms: int) -> dict[str, Any] | None:
    user_id = user.get("id") if isinstance(user.get("id"), str) else None
    emails = _email_list(user)
    email = (
        user.get("primaryEmail").lower()
        if isinstance(user.get("primaryEmail"), str)
        else (emails[0] if emails else None)
    )
    if not user_id and not email:
        return None
    return {
        "id": user_id,
        "name": f"users/{user_id}" if user_id else None,
        "email": email,
        "aliases": [candidate for candidate in emails if candidate != email],
        "displayName": _display_name(user),
        "source": "directory_cache",
        "directoryStatus": _status(user),
        "stale": False,
        "lastSeenAt": _iso(now_ms),
        "lastDirectorySyncAt": _iso(now_ms),
        "access": {"status": "available", "reason": None},
    }


def _clone(record: Mapping[str, Any]) -> dict[str, Any]:
    cloned = dict(record)
    cloned["aliases"] = list(record.get("aliases") or [])
    cloned["access"] = dict(record.get("access") or {})
    return cloned


def _id_from_ref(ref: Mapping[str, Any]) -> str | None:
    if isinstance(ref.get("id"), str):
        return ref["id"]
    name = ref.get("name")
    if isinstance(name, str) and name.startswith("users/"):
        return name[len("users/") :]
    return None


def build_directory_users_list_plan(
    *,
    customer: str = "my_customer",
    projection: str = "BASIC",
    view_type: str = "domain_public",
    max_results: int = 500,
) -> dict[str, Any]:
    query = urlencode(
        {
            "customer": customer,
            "projection": projection,
            "viewType": view_type,
            "maxResults": max_results,
        }
    )
    return {
        "kind": "directory.users.list",
        "method": "GET",
        "url": f"https://admin.googleapis.com/admin/directory/v1/users?{query}",
        "auth": {
            "required": True,
            "mode": "user",
            "scopes": [DIRECTORY_USER_READONLY_SCOPE],
            "notes": [
                "Uses the Admin SDK Directory API surface, but viewType=domain_public only asks for fields visible within the domain.",
                "If the signed-in user or tenant policy cannot grant this scope, identity enrichment should stay unavailable instead of failing Chat handling.",
            ],
        },
        "cache": {
            "recommendedTtlMs": DIRECTORY_SYNC_TTL_MS,
            "neverDeleteMissingUsers": True,
        },
    }


class InMemoryIdentityCache:
    def __init__(self) -> None:
        self._records: dict[str, dict[str, Any]] = {}

    def get_by_id(self, user_id: str) -> dict[str, Any] | None:
        record = self._records.get(f"id:{user_id}")
        return _clone(record) if record else None

    def get_by_email(self, email: str) -> dict[str, Any] | None:
        record = self._records.get(f"email:{email.lower()}")
        return _clone(record) if record else None

    def list(self) -> list[dict[str, Any]]:
        unique: dict[str, dict[str, Any]] = {}
        for record in self._records.values():
            key = record.get("id") or record.get("email")
            if key:
                unique[str(key)] = _clone(record)
        return list(unique.values())

    def put_many(self, records: list[Mapping[str, Any]]) -> None:
        for record in records:
            self._put(_clone(record))

    def _put(self, record: dict[str, Any]) -> None:
        if record.get("id"):
            self._records[f"id:{record['id']}"] = record
        if record.get("email"):
            self._records[f"email:{str(record['email']).lower()}"] = record
        for alias in record.get("aliases") or []:
            self._records[f"email:{str(alias).lower()}"] = record


class FileIdentityCache:
    def __init__(self, file_path: str | Path) -> None:
        self.file_path = Path(file_path)

    def get_by_id(self, user_id: str) -> dict[str, Any] | None:
        return self._load().get_by_id(user_id)

    def get_by_email(self, email: str) -> dict[str, Any] | None:
        return self._load().get_by_email(email)

    def list(self) -> list[dict[str, Any]]:
        return self._load().list()

    def put_many(self, records: list[Mapping[str, Any]]) -> None:
        cache = self._load()
        cache.put_many(records)
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        self.file_path.write_text(
            f"{json.dumps({'version': 1, 'records': cache.list()}, indent=2)}\n",
            "utf-8",
        )

    def _load(self) -> InMemoryIdentityCache:
        cache = InMemoryIdentityCache()
        if self.file_path.exists():
            payload = json.loads(self.file_path.read_text("utf-8"))
            cache.put_many(payload.get("records") or [])
        return cache


def sync_directory_users_to_cache(
    users: list[Mapping[str, Any]],
    *,
    cache: InMemoryIdentityCache | FileIdentityCache,
    now_ms: int | None = None,
    mark_missing_stale: bool = False,
) -> dict[str, int]:
    effective_now = (
        now_ms
        if isinstance(now_ms, int) and now_ms >= 0
        else round(datetime.now(tz=timezone.utc).timestamp() * 1000)
    )
    incoming = [
        record
        for record in (_record_from_user(user, effective_now) for user in users)
        if record is not None
    ]
    incoming_keys = {record.get("id") or record.get("email") for record in incoming}
    stale = 0
    if mark_missing_stale:
        for record in cache.list():
            key = record.get("id") or record.get("email")
            if key and key not in incoming_keys and record.get("directoryStatus") != "stale":
                stale_record = {
                    **record,
                    "directoryStatus": "stale",
                    "stale": True,
                    "access": {
                        "status": "available",
                        "reason": "directory_user_missing_from_latest_sync",
                    },
                }
                incoming.append(stale_record)
                stale += 1
    cache.put_many(incoming)
    return {"synced": len(incoming) - stale, "stale": stale}


def resolve_human_identity(
    ref: Mapping[str, Any],
    *,
    cache: InMemoryIdentityCache | FileIdentityCache,
) -> dict[str, Any]:
    user_id = _id_from_ref(ref)
    if user_id:
        found = cache.get_by_id(user_id)
        if found:
            return found
    if isinstance(ref.get("email"), str):
        found = cache.get_by_email(ref["email"])
        if found:
            return found
    if ref.get("displayName") or ref.get("email"):
        return {
            "id": user_id,
            "name": ref.get("name") or (f"users/{user_id}" if user_id else None),
            "email": ref.get("email"),
            "aliases": [],
            "displayName": ref.get("displayName") or ref.get("email"),
            "source": "chat_payload",
            "directoryStatus": "unavailable",
            "stale": False,
            "lastSeenAt": None,
            "lastDirectorySyncAt": None,
            "access": {"status": "available", "reason": None},
        }
    return {
        "id": user_id,
        "name": ref.get("name") or (f"users/{user_id}" if user_id else None),
        "email": None,
        "aliases": [],
        "displayName": None,
        "source": "unresolved",
        "directoryStatus": "unavailable",
        "stale": False,
        "lastSeenAt": None,
        "lastDirectorySyncAt": None,
        "access": {"status": "access_limited", "reason": "identity_not_in_cache"},
    }


def render_identity_system_note(identity: Mapping[str, Any], *, role: str = "user") -> str:
    access = identity.get("access") if isinstance(identity.get("access"), Mapping) else {}
    if access.get("status") == "access_limited":
        label = identity.get("name") or identity.get("email") or "unknown"
        return (
            f"System Note: The {role} identity {label} could not be resolved "
            "to a human-readable directory user."
        )
    stale = " This directory record is stale and may be out of date." if identity.get("stale") else ""
    email = f" <{identity['email']}>" if identity.get("email") else ""
    return f"System Note: The {role} is {identity.get('displayName') or 'Unknown'}{email}.{stale}"


__all__ = [
    "DIRECTORY_USER_READONLY_SCOPE",
    "FileIdentityCache",
    "InMemoryIdentityCache",
    "build_directory_users_list_plan",
    "render_identity_system_note",
    "resolve_human_identity",
    "sync_directory_users_to_cache",
]
