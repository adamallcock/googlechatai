import base64
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from googlechatai.token_store import (
    FileTokenStore,
    InMemoryTokenStore,
    SecretManagerTokenStore,
    TokenRecord,
    get_access_token_from_store,
    slug,
)


FIXED_LEASE = {"access_token": "lease-token-1", "token_type": "Bearer"}


def _base64_json(value: object) -> str:
    return base64.b64encode(json.dumps(value).encode("utf8")).decode("ascii")


def _decode_base64_json(value: str) -> object:
    return json.loads(base64.b64decode(value).decode("utf8"))


class FakeSend:
    """Records requests and dispatches to a handler, mirroring the Node
    fake-fetch helper used in the token-store/queues vitest suites."""

    def __init__(self, handler):
        self.handler = handler
        self.requests: list[dict[str, object]] = []

    def __call__(self, request: dict[str, object]) -> dict[str, object]:
        self.requests.append(request)
        return self.handler(request)


def _json_response(status: int, body: object) -> dict[str, object]:
    return {"ok": 200 <= status < 300, "status": status, "json": body, "headers": {}}


class SlugTests(unittest.TestCase):
    def test_lowercases_replaces_disallowed_characters_trims_dashes_and_caps_length(self) -> None:
        self.assertEqual(slug("Users/Alice@Example.com"), "users-alice-example-com")
        self.assertEqual(slug("--leading-and-trailing--"), "leading-and-trailing")
        self.assertEqual(slug("a" * 250), "a" * 200)

    def test_raises_type_error_for_empty_input(self) -> None:
        with self.assertRaises(TypeError):
            slug("")
        with self.assertRaises(TypeError):
            slug("   ")


class InMemoryTokenStoreTests(unittest.TestCase):
    def test_round_trips_records_and_deep_copies_on_load_and_save(self) -> None:
        store = InMemoryTokenStore()
        record = TokenRecord(
            principal_id="users/alice",
            access_token="access-1",
            refresh_token="refresh-1",
            expires_at="2026-07-06T12:00:00.000Z",
            scopes=["scope-a"],
            token_type="Bearer",
            metadata={"note": "original"},
        )

        store.save(record)
        record.scopes.append("mutated-after-save")
        record.metadata["note"] = "mutated-after-save"

        loaded = store.load("users/alice")
        self.assertEqual(loaded.scopes, ["scope-a"])
        self.assertEqual(loaded.metadata, {"note": "original"})

        loaded.scopes.append("mutated-after-load")
        loaded.metadata["note"] = "mutated-after-load"
        loaded_again = store.load("users/alice")
        self.assertEqual(loaded_again.scopes, ["scope-a"])
        self.assertEqual(loaded_again.metadata, {"note": "original"})

    def test_returns_none_for_unknown_principals_and_supports_delete_and_list(self) -> None:
        store = InMemoryTokenStore()
        self.assertIsNone(store.load("missing"))

        store.save(TokenRecord(principal_id="users/alice", access_token="a"))
        store.save(TokenRecord(principal_id="users/bob", access_token="b"))
        self.assertEqual(sorted(store.list()), ["users/alice", "users/bob"])

        store.delete("users/alice")
        self.assertEqual(store.list(), ["users/bob"])
        self.assertIsNone(store.load("users/alice"))

    def test_raises_type_error_for_empty_principal_id(self) -> None:
        store = InMemoryTokenStore()
        with self.assertRaises(TypeError):
            store.load("")
        with self.assertRaises(TypeError):
            store.save(TokenRecord(principal_id=""))
        with self.assertRaises(TypeError):
            store.delete("")


class FileTokenStoreTests(unittest.TestCase):
    def test_returns_none_and_empty_list_for_missing_file_without_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            store = FileTokenStore(Path(tmpdir) / "tokens.json")
            self.assertIsNone(store.load("users/alice"))
            self.assertEqual(store.list(), [])

    def test_creates_file_on_first_save_and_persists_across_instances(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = Path(tmpdir) / "nested" / "tokens.json"
            store = FileTokenStore(file_path)

            store.save(
                TokenRecord(
                    principal_id="users/alice",
                    access_token="access-1",
                    refresh_token="refresh-1",
                    expires_at="2026-07-06T12:00:00.000Z",
                    scopes=["scope-a"],
                    token_type="Bearer",
                    metadata={"note": "hi"},
                )
            )

            raw = json.loads(file_path.read_text("utf8"))
            self.assertEqual(
                raw,
                {
                    "version": 1,
                    "records": {
                        "users/alice": {
                            "principalId": "users/alice",
                            "accessToken": "access-1",
                            "refreshToken": "refresh-1",
                            "expiresAt": "2026-07-06T12:00:00.000Z",
                            "scopes": ["scope-a"],
                            "tokenType": "Bearer",
                            "metadata": {"note": "hi"},
                        }
                    },
                },
            )

            second_store = FileTokenStore(file_path)
            loaded = second_store.load("users/alice")
            self.assertEqual(loaded.access_token, "access-1")

    def test_chmods_file_to_0o600_after_write(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = Path(tmpdir) / "tokens.json"
            store = FileTokenStore(file_path)
            store.save(TokenRecord(principal_id="users/alice", access_token="a"))

            mode = file_path.stat().st_mode & 0o777
            self.assertEqual(mode, 0o600)

    def test_supports_delete_and_list_across_multiple_principals(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = Path(tmpdir) / "tokens.json"
            store = FileTokenStore(file_path)

            store.save(TokenRecord(principal_id="users/alice", access_token="a"))
            store.save(TokenRecord(principal_id="users/bob", access_token="b"))
            self.assertEqual(sorted(store.list()), ["users/alice", "users/bob"])

            store.delete("users/alice")
            self.assertEqual(store.list(), ["users/bob"])
            self.assertIsNone(store.load("users/alice"))

    def test_writes_atomically_via_temp_file_and_rename_no_leftover_temp_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = Path(tmpdir) / "tokens.json"
            store = FileTokenStore(file_path)
            store.save(TokenRecord(principal_id="users/alice", access_token="a"))

            entries = [entry.name for entry in Path(tmpdir).iterdir()]
            self.assertEqual(entries, ["tokens.json"])

    def test_cross_language_file_format_matches_the_documented_node_shape(self) -> None:
        """A FileTokenStore file written by Node must be loadable by Python:
        assert the exact serialized {version, records} shape literally and
        confirm Python's FileTokenStore can load it."""
        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = Path(tmpdir) / "tokens.json"
            node_style_payload = {
                "version": 1,
                "records": {
                    "users/alice": {
                        "principalId": "users/alice",
                        "accessToken": "access-1",
                        "refreshToken": "refresh-1",
                        "expiresAt": "2026-07-06T12:00:00.000Z",
                        "scopes": ["scope-a"],
                        "tokenType": "Bearer",
                        "metadata": {"note": "hi"},
                    }
                },
            }
            file_path.write_text(f"{json.dumps(node_style_payload, indent=2)}\n", "utf8")

            store = FileTokenStore(file_path)
            loaded = store.load("users/alice")
            self.assertEqual(loaded.principal_id, "users/alice")
            self.assertEqual(loaded.access_token, "access-1")
            self.assertEqual(loaded.refresh_token, "refresh-1")
            self.assertEqual(loaded.expires_at, "2026-07-06T12:00:00.000Z")
            self.assertEqual(loaded.scopes, ["scope-a"])
            self.assertEqual(loaded.token_type, "Bearer")
            self.assertEqual(loaded.metadata, {"note": "hi"})
            self.assertEqual(store.list(), ["users/alice"])


class SecretManagerTokenStoreTests(unittest.TestCase):
    def test_loads_a_token_record_via_versions_latest_access_and_decodes_base64_payload(self) -> None:
        record_body = {"principalId": "users/alice", "accessToken": "access-1", "refreshToken": "refresh-1"}

        def handler(request: dict[str, object]) -> dict[str, object]:
            self.assertEqual(
                request["url"],
                "https://secretmanager.googleapis.com/v1/projects/my-project/secrets/chat-token-users-alice/versions/latest:access",
            )
            self.assertEqual(request["method"], "GET")
            self.assertEqual(request["headers"]["authorization"], "Bearer lease-token-1")
            return _json_response(
                200,
                {
                    "name": "projects/my-project/secrets/chat-token-users-alice/versions/1",
                    "payload": {"data": _base64_json(record_body)},
                },
            )

        send = FakeSend(handler)
        store = SecretManagerTokenStore(
            project_id="my-project",
            send=send,
            get_access_token=lambda force_refresh=False: FIXED_LEASE,
        )

        loaded = store.load("users/alice")
        self.assertEqual(loaded.principal_id, "users/alice")
        self.assertEqual(loaded.access_token, "access-1")
        self.assertEqual(loaded.refresh_token, "refresh-1")
        self.assertEqual(len(send.requests), 1)

    def test_returns_none_on_404_when_loading(self) -> None:
        send = FakeSend(lambda request: _json_response(404, {"error": {"code": 404}}))
        store = SecretManagerTokenStore(
            project_id="my-project",
            send=send,
            get_access_token=lambda force_refresh=False: FIXED_LEASE,
        )

        self.assertIsNone(store.load("users/missing"))

    def test_saves_via_add_version_using_the_lease_token_and_base64_payload(self) -> None:
        def handler(request: dict[str, object]) -> dict[str, object]:
            self.assertEqual(request["headers"]["authorization"], "Bearer lease-token-1")
            self.assertEqual(request["method"], "POST")
            self.assertEqual(
                request["url"],
                "https://secretmanager.googleapis.com/v1/projects/my-project/secrets/chat-token-users-alice:addVersion",
            )
            decoded = _decode_base64_json(request["body"]["payload"]["data"])
            self.assertEqual(decoded, {"principalId": "users/alice", "accessToken": "access-1"})
            return _json_response(200, {"name": "projects/my-project/secrets/chat-token-users-alice/versions/2"})

        send = FakeSend(handler)
        store = SecretManagerTokenStore(
            project_id="my-project",
            send=send,
            get_access_token=lambda force_refresh=False: FIXED_LEASE,
        )

        store.save(TokenRecord(principal_id="users/alice", access_token="access-1"))
        self.assertEqual(len(send.requests), 1)

    def test_creates_secret_then_retries_add_version_when_add_version_first_404s(self) -> None:
        def handler(request: dict[str, object]) -> dict[str, object]:
            call_number = len(send.requests)
            if call_number == 1:
                self.assertEqual(request["method"], "POST")
                self.assertEqual(
                    request["url"],
                    "https://secretmanager.googleapis.com/v1/projects/my-project/secrets/chat-token-users-alice:addVersion",
                )
                return _json_response(404, {"error": {"code": 404}})
            if call_number == 2:
                self.assertEqual(request["method"], "POST")
                self.assertEqual(
                    request["url"],
                    "https://secretmanager.googleapis.com/v1/projects/my-project/secrets?secretId=chat-token-users-alice",
                )
                self.assertEqual(
                    request["body"],
                    {"replication": {"automatic": {}}, "labels": {"principal": "users-alice"}},
                )
                return _json_response(200, {"name": "projects/my-project/secrets/chat-token-users-alice"})
            self.assertEqual(request["method"], "POST")
            self.assertEqual(
                request["url"],
                "https://secretmanager.googleapis.com/v1/projects/my-project/secrets/chat-token-users-alice:addVersion",
            )
            return _json_response(200, {"name": "projects/my-project/secrets/chat-token-users-alice/versions/1"})

        send = FakeSend(handler)
        store = SecretManagerTokenStore(
            project_id="my-project",
            send=send,
            get_access_token=lambda force_refresh=False: FIXED_LEASE,
        )

        store.save(TokenRecord(principal_id="users/alice", access_token="access-1"))
        self.assertEqual(len(send.requests), 3)

    def test_deletes_the_secret(self) -> None:
        def handler(request: dict[str, object]) -> dict[str, object]:
            self.assertEqual(request["method"], "DELETE")
            self.assertEqual(
                request["url"],
                "https://secretmanager.googleapis.com/v1/projects/my-project/secrets/chat-token-users-alice",
            )
            return _json_response(200, {})

        send = FakeSend(handler)
        store = SecretManagerTokenStore(
            project_id="my-project",
            send=send,
            get_access_token=lambda force_refresh=False: FIXED_LEASE,
        )

        store.delete("users/alice")
        self.assertEqual(len(send.requests), 1)

    def test_lists_principal_ids_handling_page_token_pagination(self) -> None:
        def handler(request: dict[str, object]) -> dict[str, object]:
            self.assertEqual(request["method"], "GET")
            if "pageToken" not in request["url"]:
                self.assertEqual(
                    request["url"],
                    "https://secretmanager.googleapis.com/v1/projects/my-project/secrets?filter=name%3Achat-token-",
                )
                return _json_response(
                    200,
                    {
                        "secrets": [
                            {"name": "projects/my-project/secrets/chat-token-users-alice"},
                            {"name": "projects/my-project/secrets/chat-token-users-bob"},
                        ],
                        "nextPageToken": "page-2",
                    },
                )
            self.assertEqual(
                request["url"],
                "https://secretmanager.googleapis.com/v1/projects/my-project/secrets?filter=name%3Achat-token-&pageToken=page-2",
            )
            return _json_response(
                200, {"secrets": [{"name": "projects/my-project/secrets/chat-token-users-carol"}]}
            )

        send = FakeSend(handler)
        store = SecretManagerTokenStore(
            project_id="my-project",
            send=send,
            get_access_token=lambda force_refresh=False: FIXED_LEASE,
        )

        principals = store.list()
        self.assertEqual(sorted(principals), ["users-alice", "users-bob", "users-carol"])
        self.assertEqual(len(send.requests), 2)

    def test_raises_status_only_error_with_no_body_contents_on_non_ok_non_404_responses(self) -> None:
        send = FakeSend(lambda request: _json_response(500, {"error": {"message": "super secret token leaked in error"}}))
        store = SecretManagerTokenStore(
            project_id="my-project",
            send=send,
            get_access_token=lambda force_refresh=False: FIXED_LEASE,
        )

        with self.assertRaises(Exception) as ctx:
            store.save(TokenRecord(principal_id="users/alice", access_token="a"))
        self.assertEqual(str(ctx.exception), "Secret Manager POST 500 for chat-token-users-alice")
        self.assertNotIn("leaked", str(ctx.exception))

    def test_raises_type_error_when_send_or_get_access_token_are_missing(self) -> None:
        with self.assertRaises(TypeError):
            SecretManagerTokenStore(
                project_id="my-project",
                send=None,
                get_access_token=lambda force_refresh=False: FIXED_LEASE,
            )
        with self.assertRaises(TypeError):
            SecretManagerTokenStore(
                project_id="my-project",
                send=FakeSend(lambda request: _json_response(200, {})),
                get_access_token=None,
            )


class GetAccessTokenFromStoreTests(unittest.TestCase):
    def test_returns_cached_lease_when_fresh_and_force_refresh_is_false(self) -> None:
        store = InMemoryTokenStore()
        now_ms = round(time.mktime(time.strptime("2026-07-06T12:00:00", "%Y-%m-%dT%H:%M:%S")) * 1000)
        with mock.patch("time.time", return_value=now_ms / 1000):
            store.save(
                TokenRecord(
                    principal_id="users/alice",
                    access_token="still-fresh",
                    expires_at=_iso_ms(now_ms + 10 * 60 * 1000),
                    token_type="Bearer",
                )
            )

            refresh = mock.Mock()
            get_access_token = get_access_token_from_store(
                store=store, principal_id="users/alice", refresh=refresh
            )

            lease = get_access_token(force_refresh=False)
            self.assertEqual(
                lease, {"access_token": "still-fresh", "refreshed": False, "token_type": "Bearer"}
            )
            refresh.assert_not_called()

    def test_treats_record_with_no_expires_at_as_fresh_when_access_token_present(self) -> None:
        store = InMemoryTokenStore()
        store.save(TokenRecord(principal_id="users/alice", access_token="no-expiry-token"))

        refresh = mock.Mock()
        get_access_token = get_access_token_from_store(
            store=store, principal_id="users/alice", refresh=refresh
        )

        lease = get_access_token(force_refresh=False)
        self.assertEqual(
            lease, {"access_token": "no-expiry-token", "refreshed": False, "token_type": None}
        )
        refresh.assert_not_called()

    def test_refreshes_when_expired_and_saves_new_record_back_to_store(self) -> None:
        store = InMemoryTokenStore()
        now_ms = round(time.mktime(time.strptime("2026-07-06T12:00:00", "%Y-%m-%dT%H:%M:%S")) * 1000)
        with mock.patch("time.time", return_value=now_ms / 1000):
            store.save(
                TokenRecord(
                    principal_id="users/alice",
                    access_token="expired-token",
                    expires_at=_iso_ms(now_ms - 1_000),
                    token_type="Bearer",
                )
            )

            def refresh(record: TokenRecord) -> TokenRecord:
                record.access_token = "refreshed-token"
                record.expires_at = _iso_ms(now_ms + 3_600_000)
                return record

            get_access_token = get_access_token_from_store(
                store=store, principal_id="users/alice", refresh=refresh
            )

            lease = get_access_token(force_refresh=False)
            self.assertEqual(
                lease, {"access_token": "refreshed-token", "refreshed": True, "token_type": "Bearer"}
            )

            saved = store.load("users/alice")
            self.assertEqual(saved.access_token, "refreshed-token")

    def test_refreshes_within_60s_freshness_margin_even_if_not_technically_expired(self) -> None:
        store = InMemoryTokenStore()
        now_ms = round(time.mktime(time.strptime("2026-07-06T12:00:00", "%Y-%m-%dT%H:%M:%S")) * 1000)
        with mock.patch("time.time", return_value=now_ms / 1000):
            store.save(
                TokenRecord(
                    principal_id="users/alice",
                    access_token="about-to-expire",
                    expires_at=_iso_ms(now_ms + 30_000),
                )
            )

            calls = []

            def refresh(record: TokenRecord) -> TokenRecord:
                calls.append(record)
                record.access_token = "refreshed-token"
                record.expires_at = _iso_ms(now_ms + 3_600_000)
                return record

            get_access_token = get_access_token_from_store(
                store=store, principal_id="users/alice", refresh=refresh
            )

            lease = get_access_token(force_refresh=False)
            self.assertTrue(lease["refreshed"])
            self.assertEqual(len(calls), 1)

    def test_forces_refresh_when_force_refresh_true_even_if_fresh(self) -> None:
        store = InMemoryTokenStore()
        now_ms = round(time.mktime(time.strptime("2026-07-06T12:00:00", "%Y-%m-%dT%H:%M:%S")) * 1000)
        with mock.patch("time.time", return_value=now_ms / 1000):
            store.save(
                TokenRecord(
                    principal_id="users/alice",
                    access_token="still-fresh",
                    expires_at=_iso_ms(now_ms + 10 * 60 * 1000),
                )
            )

            def refresh(record: TokenRecord) -> TokenRecord:
                record.access_token = "force-refreshed-token"
                return record

            get_access_token = get_access_token_from_store(
                store=store, principal_id="users/alice", refresh=refresh
            )

            lease = get_access_token(force_refresh=True)
            self.assertEqual(
                lease,
                {"access_token": "force-refreshed-token", "refreshed": True, "token_type": None},
            )

    def test_raises_when_no_record_exists_for_principal(self) -> None:
        store = InMemoryTokenStore()
        get_access_token = get_access_token_from_store(
            store=store, principal_id="users/missing", refresh=mock.Mock()
        )

        with self.assertRaises(Exception) as ctx:
            get_access_token(force_refresh=False)
        self.assertEqual(str(ctx.exception), "No token record found for principal users/missing.")

    def test_raises_type_error_when_required_options_are_missing(self) -> None:
        with self.assertRaises(TypeError):
            get_access_token_from_store(store=None, principal_id="users/alice", refresh=mock.Mock())
        with self.assertRaises(TypeError):
            get_access_token_from_store(
                store=InMemoryTokenStore(), principal_id="", refresh=mock.Mock()
            )
        with self.assertRaises(TypeError):
            get_access_token_from_store(
                store=InMemoryTokenStore(), principal_id="users/alice", refresh=None
            )


def _iso_ms(ms: int) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    unittest.main()
