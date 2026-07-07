import tempfile
import unittest
from pathlib import Path

from googlechatai import (
    DIRECTORY_USER_READONLY_SCOPE,
    FileIdentityCache,
    InMemoryIdentityCache,
    build_directory_users_list_plan,
    render_identity_system_note,
    resolve_human_identity,
    sync_directory_users_to_cache,
)


class IdentityDirectoryTests(unittest.TestCase):
    def test_plans_directory_users_list_with_domain_public_fields(self) -> None:
        self.assertEqual(
            build_directory_users_list_plan(),
            {
                "kind": "directory.users.list",
                "method": "GET",
                "url": "https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer&projection=BASIC&viewType=domain_public&maxResults=500",
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
                    "recommendedTtlMs": 24 * 60 * 60 * 1000,
                    "neverDeleteMissingUsers": True,
                },
            },
        )

    def test_caches_users_without_deleting_missing_people(self) -> None:
        cache = InMemoryIdentityCache()
        sync_directory_users_to_cache(
            [
                {
                    "id": "123",
                    "primaryEmail": "ada@example.com",
                    "name": {"fullName": "Ada Lovelace"},
                    "aliases": ["a.lovelace@example.com"],
                },
                {
                    "id": "456",
                    "primaryEmail": "grace@example.com",
                    "name": {"fullName": "Grace Hopper"},
                    "suspended": True,
                },
            ],
            cache=cache,
            now_ms=1_000,
            mark_missing_stale=True,
        )
        sync_directory_users_to_cache(
            [
                {
                    "id": "123",
                    "primaryEmail": "ada@example.com",
                    "name": {"fullName": "Ada Lovelace"},
                }
            ],
            cache=cache,
            now_ms=2_000,
            mark_missing_stale=True,
        )

        self.assertEqual(
            resolve_human_identity({"name": "users/123"}, cache=cache)["displayName"],
            "Ada Lovelace",
        )
        self.assertEqual(
            resolve_human_identity({"email": "a.lovelace@example.com"}, cache=cache)[
                "displayName"
            ],
            "Ada Lovelace",
        )
        grace = resolve_human_identity({"name": "users/456"}, cache=cache)
        self.assertEqual(grace["displayName"], "Grace Hopper")
        self.assertEqual(grace["directoryStatus"], "stale")
        self.assertTrue(grace["stale"])

    def test_file_cache_and_inaccessible_identity_note(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = Path(tmpdir) / "identities.json"
            cache = FileIdentityCache(file_path)
            sync_directory_users_to_cache(
                [
                    {
                        "id": "123",
                        "primaryEmail": "ada@example.com",
                        "name": {"fullName": "Ada Lovelace"},
                    }
                ],
                cache=cache,
                now_ms=1_000,
            )

            from_disk = resolve_human_identity(
                {"name": "users/123"},
                cache=FileIdentityCache(file_path),
            )
            unresolved = resolve_human_identity({"name": "users/999"}, cache=cache)

            self.assertEqual(from_disk["displayName"], "Ada Lovelace")
            self.assertEqual(
                unresolved["access"],
                {"status": "access_limited", "reason": "identity_not_in_cache"},
            )
            self.assertEqual(
                render_identity_system_note(unresolved, role="sender"),
                "System Note: The sender identity users/999 could not be resolved to a human-readable directory user.",
            )


if __name__ == "__main__":
    unittest.main()
