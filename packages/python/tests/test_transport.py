import unittest
import json
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from googlechatai import (
    FileIdempotencyStore,
    InMemoryIdempotencyStore,
    RetryDecisionInput,
    RetryPolicyOptions,
    RetryingJsonResponse,
    build_retry_decision,
    create_retrying_chat_client,
    guard_duplicate_event_delivery,
    is_replay_safe,
    parse_retry_after_ms,
    request_json_with_retry,
)


class TransportRetryPolicyTests(unittest.TestCase):
    def test_classifies_expired_user_auth_as_refresh_auth_retry(self) -> None:
        decision = build_retry_decision(
            RetryDecisionInput(
                attempt=1,
                method="GET",
                status=401,
                principal="user",
            )
        )

        self.assertEqual(decision.action, "refresh_auth")
        self.assertTrue(decision.retryable)
        self.assertTrue(decision.refresh_auth)
        self.assertTrue(decision.replay_safe)
        self.assertEqual(decision.reason, "access_token_expired_or_invalid")
        self.assertEqual(decision.delay_ms, 0)
        self.assertEqual(decision.status, 401)
        self.assertEqual(decision.principal, "user")

    def test_honors_retry_after_for_rate_limits(self) -> None:
        decision = build_retry_decision(
            RetryDecisionInput(
                attempt=1,
                method="GET",
                status=429,
                retry_after="2",
            )
        )

        self.assertEqual(decision.action, "retry")
        self.assertEqual(decision.reason, "rate_limited")
        self.assertEqual(decision.delay_ms, 2_000)

    def test_retries_transient_read_failures_with_bounded_backoff(self) -> None:
        decision = build_retry_decision(
            RetryDecisionInput(
                attempt=2,
                method="GET",
                status=503,
            ),
            RetryPolicyOptions(base_delay_ms=100, max_delay_ms=150),
        )

        self.assertEqual(decision.action, "retry")
        self.assertTrue(decision.retryable)
        self.assertEqual(decision.reason, "transient_failure")
        self.assertEqual(decision.delay_ms, 150)

    def test_does_not_replay_unsafe_writes_after_transient_failures(self) -> None:
        decision = build_retry_decision(
            RetryDecisionInput(
                attempt=1,
                method="POST",
                status=503,
            )
        )

        self.assertEqual(decision.action, "fail")
        self.assertFalse(decision.retryable)
        self.assertFalse(decision.replay_safe)
        self.assertEqual(decision.reason, "non_idempotent_request_not_replayed")

    def test_replays_idempotent_writes_and_pre_send_failures(self) -> None:
        self.assertTrue(
            is_replay_safe(
                RetryDecisionInput(attempt=1, method="POST", idempotent=True)
            )
        )
        idempotent = build_retry_decision(
            RetryDecisionInput(
                attempt=1,
                method="POST",
                status=500,
                idempotent=True,
            )
        )
        pre_send = build_retry_decision(
            RetryDecisionInput(
                attempt=1,
                method="POST",
                network_error=True,
                pre_send_failure=True,
            )
        )

        self.assertEqual(idempotent.action, "retry")
        self.assertTrue(idempotent.retryable)
        self.assertTrue(idempotent.replay_safe)
        self.assertEqual(pre_send.action, "retry")
        self.assertTrue(pre_send.retryable)
        self.assertTrue(pre_send.replay_safe)

    def test_fails_after_max_attempts_and_ignores_invalid_retry_after(self) -> None:
        decision = build_retry_decision(
            RetryDecisionInput(
                attempt=3,
                method="GET",
                status=503,
            )
        )

        self.assertEqual(decision.action, "fail")
        self.assertEqual(decision.reason, "max_attempts_exhausted")
        self.assertIsNone(parse_retry_after_ms("not a date"))

    def test_idempotency_store_claims_duplicates_and_expires(self) -> None:
        store = InMemoryIdempotencyStore(max_entries=10)

        first = store.claim("event-id-hash-1", ttl_ms=1_000, now_ms=1_000)
        duplicate = store.claim("event-id-hash-1", ttl_ms=1_000, now_ms=1_100)
        after_expiry = store.claim("event-id-hash-1", ttl_ms=1_000, now_ms=2_001)

        self.assertTrue(first.claimed)
        self.assertFalse(first.duplicate)
        self.assertEqual(first.seen_count, 1)
        self.assertFalse(duplicate.claimed)
        self.assertTrue(duplicate.duplicate)
        self.assertEqual(duplicate.seen_count, 2)
        self.assertTrue(after_expiry.claimed)
        self.assertFalse(after_expiry.duplicate)
        self.assertEqual(after_expiry.seen_count, 1)

    def test_in_memory_idempotency_claim_is_atomic_across_threads(self) -> None:
        store = InMemoryIdempotencyStore()

        with ThreadPoolExecutor(max_workers=16) as executor:
            claims = list(
                executor.map(
                    lambda index: store.claim(
                        "same-event",
                        ttl_ms=60_000,
                        now_ms=1_000 + index,
                    ),
                    range(16),
                )
            )

        self.assertEqual(sum(claim.claimed for claim in claims), 1)
        self.assertEqual(sum(claim.duplicate for claim in claims), 15)

    def test_file_idempotency_store_persists_across_instances(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "claims.json"
            first_store = FileIdempotencyStore(path)
            second_store = FileIdempotencyStore(path)

            first = first_store.claim(
                "event-id-hash-2",
                ttl_ms=60_000,
                now_ms=1_000,
            )
            second = second_store.claim(
                "event-id-hash-2",
                ttl_ms=60_000,
                now_ms=2_000,
            )

            self.assertTrue(first.claimed)
            self.assertFalse(first.duplicate)
            self.assertFalse(second.claimed)
            self.assertTrue(second.duplicate)
            self.assertEqual(second.seen_count, 2)
            saved = json.loads(path.read_text("utf8"))
            self.assertEqual(saved["entries"]["event-id-hash-2"]["seenCount"], 2)

    def test_request_json_with_retry_refreshes_user_auth_after_401(self) -> None:
        token_calls: list[bool] = []
        authorizations: list[str] = []

        def get_access_token(*, force_refresh: bool = False):
            token_calls.append(force_refresh)
            return {
                "access_token": "fresh-token" if force_refresh else "stale-token",
                "refreshed": force_refresh,
            }

        def send(request):
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

        self.assertTrue(result.ok)
        self.assertEqual(result.status, 200)
        self.assertEqual(result.json, {"spaces": []})
        self.assertEqual(result.attempts, 2)
        self.assertTrue(result.refreshed)
        self.assertTrue(result.replayed_after_401)
        self.assertEqual(token_calls, [False, True])
        self.assertEqual(authorizations, ["Bearer stale-token", "Bearer fresh-token"])

    def test_request_json_with_retry_does_not_replay_unsafe_writes(self) -> None:
        calls = 0

        def send(_request):
            nonlocal calls
            calls += 1
            return {
                "ok": False,
                "status": 503,
                "json": {"error": {"status": "UNAVAILABLE"}},
                "headers": {},
            }

        result = request_json_with_retry(
            method="POST",
            url="https://chat.googleapis.com/v1/spaces/AAA/messages",
            principal="app",
            body={"text": "hello"},
            get_access_token=lambda force_refresh=False: {
                "access_token": "app-token",
                "refreshed": False,
            },
            send=send,
            sleep=lambda _delay_ms: None,
        )

        self.assertEqual(calls, 1)
        self.assertFalse(result.ok)
        self.assertEqual(result.status, 503)
        self.assertEqual(len(result.retry_decisions), 1)
        self.assertEqual(
            result.retry_decisions[0].reason,
            "non_idempotent_request_not_replayed",
        )

    def test_retrying_chat_client_hides_retry_and_refresh_handling(self) -> None:
        calls: list[dict[str, object]] = []

        def request_json_with_retry_impl(**kwargs):
            calls.append(
                {
                    "url": kwargs["url"],
                    "method": kwargs["method"],
                    "principal": kwargs["principal"],
                    "idempotent": kwargs["idempotent"],
                }
            )
            return RetryingJsonResponse(
                ok=True,
                status=200,
                json={"spaces": []},
                headers={},
                attempts=1,
                refreshed=False,
                replayed_after_401=False,
                retry_decisions=[],
            )

        client = create_retrying_chat_client(
            principal="user",
            get_access_token=lambda force_refresh=False: {
                "access_token": "fresh-token" if force_refresh else "cached-token"
            },
            request_json_with_retry_impl=request_json_with_retry_impl,
        )

        result = client.get(
            "spaces",
            query={"pageSize": 10, "filter": 'spaceType = "SPACE"'},
        )

        self.assertTrue(result.ok)
        self.assertEqual(result.json, {"spaces": []})
        self.assertEqual(
            calls,
            [
                {
                    "url": "https://chat.googleapis.com/v1/spaces?pageSize=10&filter=spaceType+%3D+%22SPACE%22",
                    "method": "GET",
                    "principal": "user",
                    "idempotent": True,
                }
            ],
        )

    def test_duplicate_delivery_guard_claims_event_idempotency_key(self) -> None:
        store = InMemoryIdempotencyStore()
        event = {
            "idempotencyKey": "chat-http:spaces/AAA/messages/one:2026-07-03T12:00:00Z",
            "kind": "message.created",
            "source": {"kind": "chat_http"},
        }

        first = guard_duplicate_event_delivery(
            event,
            store=store,
            ttl_ms=60_000,
            now_ms=1_000,
        )
        duplicate = guard_duplicate_event_delivery(
            event,
            store=store,
            ttl_ms=60_000,
            now_ms=2_000,
        )

        self.assertFalse(first["duplicate"])
        self.assertIsNone(first["responseBody"])
        self.assertTrue(first["claim"].claimed)
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(duplicate["responseBody"], {})
        self.assertFalse(duplicate["claim"].claimed)
        self.assertEqual(duplicate["claim"].seen_count, 2)
        self.assertEqual(
            duplicate["claim"].metadata,
            {"eventKind": "message.created", "sourceKind": "chat_http"},
        )


if __name__ == "__main__":
    unittest.main()
