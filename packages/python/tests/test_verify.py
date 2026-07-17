import json
import pathlib
import asyncio
import sys
import time
import threading
import types
import unittest
from unittest.mock import patch

from googlechatai.verify import (
    GOOGLE_CHAT_JWKS_URL,
    GOOGLE_CHAT_TOKEN_ISSUER,
    GOOGLE_OIDC_ISSUERS,
    bearer_token_from_authorization,
    create_google_chat_token_verifier,
    create_pubsub_push_verifier,
    decode_jwt_without_verifying,
    verify_chat_request_authorization,
    verify_google_chat_token,
)

ROOT = pathlib.Path(__file__).resolve().parents[3]


def read_json(relative_path: str):
    return json.loads((ROOT / relative_path).read_text())


FIXTURE = read_json("fixtures/verify/tokens.json")
JWKS = read_json("fixtures/verify/jwks.json")
KEYS = JWKS["keys"]
NOW_MS = FIXTURE["nowMs"]
AUDIENCE = FIXTURE["audience"]
PUSH_AUDIENCE = FIXTURE["pushAudience"]
PUSH_EMAIL = FIXTURE["pushServiceAccountEmail"]
TOKENS = FIXTURE["tokens"]


def expected(name: str):
    return read_json(f"fixtures/expected/verify/{name}.json")


class VerifyGoogleChatTokenTest(unittest.TestCase):
    def test_matches_shared_expected_fixtures(self) -> None:
        base = {"keys": KEYS, "audience": AUDIENCE, "now_ms": NOW_MS}
        push = {
            "keys": KEYS,
            "audience": PUSH_AUDIENCE,
            "issuers": GOOGLE_OIDC_ISSUERS,
            "expected_email": PUSH_EMAIL,
            "now_ms": NOW_MS,
        }
        cases = [
            ("valid-chat", TOKENS["validChat"], base),
            ("expired-chat", TOKENS["expiredChat"], base),
            ("not-yet-valid", TOKENS["notYetValid"], base),
            ("wrong-audience", TOKENS["wrongAudience"], base),
            ("wrong-issuer", TOKENS["wrongIssuer"], base),
            ("bad-signature", TOKENS["badSignature"], base),
            ("unknown-kid", TOKENS["unknownKid"], base),
            ("alg-none", TOKENS["algNone"], base),
            ("malformed", TOKENS["malformed"], base),
            ("missing-token", None, base),
            ("pubsub-valid", TOKENS["pubsubValid"], push),
            ("pubsub-wrong-email", TOKENS["pubsubWrongEmail"], push),
            ("pubsub-unverified-email", TOKENS["pubsubUnverifiedEmail"], push),
            (
                "expired-with-skew",
                TOKENS["expiredChat"],
                {**base, "clock_skew_ms": 10_000_000_000},
            ),
        ]
        for name, token, kwargs in cases:
            with self.subTest(case=name):
                self.assertEqual(
                    verify_google_chat_token(token, **kwargs), expected(name)
                )

    def test_accepts_camel_case_options_mapping(self) -> None:
        result = verify_google_chat_token(
            TOKENS["validChat"],
            {"keys": KEYS, "audience": AUDIENCE, "nowMs": NOW_MS},
        )
        self.assertEqual(result, expected("valid-chat"))

    def test_accepts_audience_lists(self) -> None:
        result = verify_google_chat_token(
            TOKENS["validChat"],
            keys=KEYS,
            audience=["something-else", AUDIENCE],
            now_ms=NOW_MS,
        )
        self.assertEqual(result["status"], "verified")

    def test_default_issuer_is_the_chat_system_account(self) -> None:
        result = verify_google_chat_token(
            TOKENS["validChat"], keys=KEYS, audience=AUDIENCE, now_ms=NOW_MS
        )
        self.assertEqual(result["claims"]["iss"], GOOGLE_CHAT_TOKEN_ISSUER)

    def test_missing_keys_raises(self) -> None:
        with self.assertRaises(TypeError):
            verify_google_chat_token(TOKENS["validChat"], audience=AUDIENCE)

    def test_empty_audience_raises(self) -> None:
        with self.assertRaises(TypeError):
            verify_google_chat_token(
                TOKENS["validChat"], keys=KEYS, audience=[]
            )


class DecodeJwtTest(unittest.TestCase):
    def test_round_trips_header_and_payload(self) -> None:
        decoded = decode_jwt_without_verifying(TOKENS["validChat"])
        self.assertEqual(decoded["header"]["alg"], "RS256")
        self.assertEqual(decoded["payload"]["aud"], AUDIENCE)
        self.assertIn(".", decoded["signingInput"])

    def test_rejects_non_jwt_strings(self) -> None:
        with self.assertRaises(TypeError):
            decode_jwt_without_verifying("nope")


class BearerTokenTest(unittest.TestCase):
    def test_parses_bearer_headers_case_insensitively(self) -> None:
        token = TOKENS["validChat"]
        self.assertEqual(
            bearer_token_from_authorization(f"Bearer {token}"), token
        )
        self.assertEqual(
            bearer_token_from_authorization(f"bearer {token}"), token
        )

    def test_rejects_missing_or_non_bearer_headers(self) -> None:
        self.assertIsNone(bearer_token_from_authorization(None))
        self.assertIsNone(bearer_token_from_authorization("Basic abc"))


class VerifyAuthorizationTest(unittest.TestCase):
    def test_verifies_bearer_header_end_to_end(self) -> None:
        result = verify_chat_request_authorization(
            f"Bearer {TOKENS['validChat']}",
            keys=KEYS,
            audience=AUDIENCE,
            now_ms=NOW_MS,
        )
        self.assertEqual(result["status"], "verified")

    def test_reports_missing_token_for_absent_header(self) -> None:
        result = verify_chat_request_authorization(
            None, keys=KEYS, audience=AUDIENCE, now_ms=NOW_MS
        )
        self.assertEqual(result["status"], "missing_token")


class FakeJwksSend:
    def __init__(self, *, ok: bool = True) -> None:
        self.ok = ok
        self.calls: list[dict] = []

    def __call__(self, request):
        self.calls.append(dict(request))
        if not self.ok:
            return {"ok": False, "status": 503, "headers": {}, "json": {}}
        return {"ok": True, "status": 200, "headers": {}, "json": JWKS}


class TokenVerifierTest(unittest.TestCase):
    def test_fetches_jwks_once_and_caches_within_ttl(self) -> None:
        send = FakeJwksSend()
        verifier = create_google_chat_token_verifier(
            audience=AUDIENCE, send=send, now=lambda: NOW_MS
        )
        self.assertEqual(verifier.verify(TOKENS["validChat"])["status"], "verified")
        self.assertEqual(verifier.verify(TOKENS["validChat"])["status"], "verified")
        self.assertEqual(len(send.calls), 1)
        self.assertEqual(send.calls[0]["url"], GOOGLE_CHAT_JWKS_URL)

    def test_refreshes_once_for_unknown_key_ids(self) -> None:
        send = FakeJwksSend()
        verifier = create_google_chat_token_verifier(
            audience=AUDIENCE, send=send, now=lambda: NOW_MS
        )
        result = verifier.verify(TOKENS["unknownKid"])
        self.assertEqual(result["status"], "unknown_key")
        self.assertEqual(len(send.calls), 2)

    def test_refetches_after_cache_ttl(self) -> None:
        send = FakeJwksSend()
        clock = {"now": NOW_MS}
        verifier = create_google_chat_token_verifier(
            audience=AUDIENCE,
            send=send,
            cache_ttl_ms=1000,
            now=lambda: clock["now"],
        )
        verifier.verify(TOKENS["validChat"])
        clock["now"] += 5000
        verifier.verify(TOKENS["validChat"])
        self.assertEqual(len(send.calls), 2)

    def test_reports_keys_unavailable_when_fetch_fails(self) -> None:
        verifier = create_google_chat_token_verifier(
            audience=AUDIENCE, send=FakeJwksSend(ok=False), now=lambda: NOW_MS
        )
        result = verifier.verify(TOKENS["validChat"])
        self.assertEqual(result["status"], "keys_unavailable")
        self.assertFalse(result["ok"])


class PubSubPushVerifierTest(unittest.TestCase):
    def test_verifies_push_oidc_tokens(self) -> None:
        verifier = create_pubsub_push_verifier(
            audience=PUSH_AUDIENCE,
            service_account_email=PUSH_EMAIL,
            send=FakeJwksSend(),
            now=lambda: NOW_MS,
        )
        self.assertEqual(
            verifier.verify(TOKENS["pubsubValid"])["status"], "verified"
        )
        self.assertEqual(
            verifier.verify(TOKENS["pubsubWrongEmail"])["status"], "wrong_email"
        )


if __name__ == "__main__":
    unittest.main()


class AsgiVerifierTest(unittest.TestCase):
    def test_asgi_adapter_rejects_unverified_and_accepts_verified(self) -> None:
        import asyncio

        from googlechatai.adapters.asgi import ASGIAdapter
        from googlechatai.router import GoogleChatAI

        chat = GoogleChatAI()

        @chat.on_message
        def handle(context):
            return {"text": "ok"}

        verifier = create_google_chat_token_verifier(
            audience=AUDIENCE, send=FakeJwksSend(), now=lambda: NOW_MS
        )
        adapter = ASGIAdapter(chat, verifier=verifier)
        payload = json.dumps(
            {
                "type": "MESSAGE",
                "eventTime": "2026-07-06T12:00:00Z",
                "message": {
                    "name": "spaces/AAA/messages/BBB",
                    "text": "hello",
                    "sender": {"name": "users/123", "type": "HUMAN"},
                    "space": {"name": "spaces/AAA"},
                },
                "space": {"name": "spaces/AAA"},
            }
        ).encode("utf-8")

        def run(headers):
            sent = []

            async def receive():
                return {"type": "http.request", "body": payload, "more_body": False}

            async def send(message):
                sent.append(message)

            scope = {
                "type": "http",
                "path": "/chat/events",
                "method": "POST",
                "headers": headers,
            }
            asyncio.run(adapter(scope, receive, send))
            return sent[0]["status"], json.loads(sent[1]["body"])

        status, body = run([])
        self.assertEqual(status, 401)
        self.assertEqual(body["error"], "unauthorized_request")

        status, body = run(
            [(b"authorization", f"Bearer {TOKENS['badSignature']}".encode("latin-1"))]
        )
        self.assertEqual(status, 401)
        self.assertEqual(body["status"], "bad_signature")

        status, body = run(
            [(b"authorization", f"Bearer {TOKENS['validChat']}".encode("latin-1"))]
        )
        self.assertEqual(status, 200)
        self.assertEqual(body.get("text"), "ok")


class AsyncAsgiVerifierTest(unittest.IsolatedAsyncioTestCase):
    async def test_synchronous_verifier_is_offloaded_without_blocking_the_event_loop(self) -> None:
        from googlechatai.adapters.asgi import ASGIAdapter
        from googlechatai.router import GoogleChatAI

        class SlowVerifier:
            def verify(self, token):
                _ = token
                time.sleep(0.1)
                return {"ok": False, "status": "missing_token"}

        adapter = ASGIAdapter(GoogleChatAI(), verifier=SlowVerifier())
        sent: list[dict] = []

        async def receive():
            return {"type": "http.request", "body": b"{}", "more_body": False}

        async def send(message):
            sent.append(message)

        loop = asyncio.get_running_loop()
        started = loop.time()
        observed_delay: list[float] = []

        async def probe():
            await asyncio.sleep(0.005)
            observed_delay.append(loop.time() - started)

        probe_task = asyncio.create_task(probe())
        await adapter(
            {
                "type": "http",
                "path": "/chat/events",
                "method": "POST",
                "headers": [],
            },
            receive,
            send,
        )
        await probe_task

        self.assertEqual(sent[0]["status"], 401)
        self.assertLess(observed_delay[0], 0.03)

    async def test_stalled_verifier_returns_safe_timeout_response(self) -> None:
        from googlechatai.adapters.asgi import ASGIAdapter
        from googlechatai.router import GoogleChatAI

        class SlowVerifier:
            def verify(self, token):
                _ = token
                time.sleep(0.1)
                return {"ok": True}

        adapter = ASGIAdapter(
            GoogleChatAI(),
            verifier=SlowVerifier(),
            verification_timeout_ms=5,
        )
        sent: list[dict] = []

        async def receive():
            return {"type": "http.request", "body": b"{}", "more_body": False}

        async def send(message):
            sent.append(message)

        started = time.perf_counter()
        await adapter(
            {
                "type": "http",
                "path": "/chat/events",
                "method": "POST",
                "headers": [],
            },
            receive,
            send,
        )

        self.assertLess(time.perf_counter() - started, 0.06)
        self.assertEqual(sent[0]["status"], 500)
        self.assertEqual(json.loads(sent[1]["body"])["error"], "verification_unavailable")

    async def test_async_verifier_is_bounded_by_the_same_timeout(self) -> None:
        from googlechatai.adapters.asgi import ASGIAdapter
        from googlechatai.router import GoogleChatAI

        class SlowAsyncVerifier:
            async def verify(self, token):
                _ = token
                await asyncio.sleep(0.1)
                return {"ok": True}

        adapter = ASGIAdapter(
            GoogleChatAI(),
            verifier=SlowAsyncVerifier(),
            verification_timeout_ms=5,
        )
        sent: list[dict] = []

        async def receive():
            return {"type": "http.request", "body": b"{}", "more_body": False}

        async def send(message):
            sent.append(message)

        started = time.perf_counter()
        await adapter(
            {
                "type": "http",
                "path": "/chat/events",
                "method": "POST",
                "headers": [],
            },
            receive,
            send,
        )

        self.assertLess(time.perf_counter() - started, 0.06)
        self.assertEqual(sent[0]["status"], 500)

    async def test_asgi_adapter_bounds_streamed_body_and_rejects_invalid_utf8(self) -> None:
        from googlechatai.adapters.asgi import ASGIAdapter
        from googlechatai.router import GoogleChatAI

        oversized = ASGIAdapter(GoogleChatAI(), max_body_bytes=4)
        sent: list[dict] = []
        messages = iter(
            [
                {"type": "http.request", "body": b"123", "more_body": True},
                {"type": "http.request", "body": b"456", "more_body": False},
            ]
        )

        async def receive_oversized():
            return next(messages)

        async def send_oversized(message):
            sent.append(message)

        await oversized(
            {
                "type": "http",
                "path": "/chat/events",
                "method": "POST",
                "headers": [],
            },
            receive_oversized,
            send_oversized,
        )
        self.assertEqual(sent[0]["status"], 413)

        invalid_utf8 = ASGIAdapter(GoogleChatAI())
        sent.clear()

        async def receive_invalid_utf8():
            return {"type": "http.request", "body": b"\xff", "more_body": False}

        await invalid_utf8(
            {
                "type": "http",
                "path": "/chat/events",
                "method": "POST",
                "headers": [],
            },
            receive_invalid_utf8,
            send_oversized,
        )
        self.assertEqual(sent[0]["status"], 400)

    async def test_asgi_adapter_maps_delivery_and_verifier_capacity_to_503(self) -> None:
        import googlechatai.adapters.asgi as asgi_module
        import googlechatai.router.runtime as runtime_module

        from googlechatai.adapters.asgi import ASGIAdapter
        from googlechatai.router import GoogleChatAI

        payload = json.dumps(
            {
                "type": "MESSAGE",
                "eventTime": "2026-07-10T12:00:00Z",
                "message": {
                    "name": "spaces/AAA/messages/BBB",
                    "text": "hello",
                    "sender": {"name": "users/123", "type": "HUMAN"},
                    "space": {"name": "spaces/AAA"},
                },
                "space": {"name": "spaces/AAA"},
            }
        ).encode("utf-8")

        async def receive():
            return {"type": "http.request", "body": payload, "more_body": False}

        async def invoke(adapter):
            sent: list[dict] = []

            async def send(message):
                sent.append(message)

            await adapter(
                {
                    "type": "http",
                    "path": "/chat/events",
                    "method": "POST",
                    "headers": [],
                },
                receive,
                send,
            )
            return sent

        delivery_chat = GoogleChatAI(deadline={"budget_ms": 20})
        delivery_chat.on_message(lambda ctx: "handled")
        with patch.object(
            runtime_module,
            "_blocking_work_slots",
            threading.BoundedSemaphore(0),
        ):
            sent = await invoke(ASGIAdapter(delivery_chat))
        self.assertEqual(sent[0]["status"], 503)
        self.assertEqual(json.loads(sent[1]["body"])["error"], "delivery_capacity_exhausted")

        class Verifier:
            def verify(self, token):
                _ = token
                return {"ok": True}

        with patch.object(
            asgi_module,
            "_verifier_work_slots",
            threading.BoundedSemaphore(0),
        ):
            sent = await invoke(ASGIAdapter(GoogleChatAI(), verifier=Verifier()))
        self.assertEqual(sent[0]["status"], 503)
        self.assertEqual(
            json.loads(sent[1]["body"])["error"],
            "verification_capacity_exhausted",
        )


class AsyncFastAPIAdapterVerifierTest(unittest.IsolatedAsyncioTestCase):
    def _mount_handler(self, adapter):
        from googlechatai.adapters.fastapi import FastAPIAdapter

        class FakeRequestAnnotation:
            pass

        class FakeJSONResponse:
            def __init__(self, content, status_code=200):
                self.content = content
                self.status_code = status_code

        class FakeApp:
            def __init__(self):
                self.handler = None

            def post(self, path):
                self.path = path

                def register(handler):
                    self.handler = handler
                    return handler

                return register

        fastapi_module = types.ModuleType("fastapi")
        fastapi_module.Request = FakeRequestAnnotation
        responses_module = types.ModuleType("fastapi.responses")
        responses_module.JSONResponse = FakeJSONResponse
        previous_fastapi = sys.modules.get("fastapi")
        previous_responses = sys.modules.get("fastapi.responses")
        app = FakeApp()
        try:
            sys.modules["fastapi"] = fastapi_module
            sys.modules["fastapi.responses"] = responses_module
            FastAPIAdapter(adapter.chat, verifier=adapter.verifier,
                           verification_timeout_ms=adapter.verification_timeout_ms,
                           max_body_bytes=adapter.max_body_bytes).mount(app)
            return app.handler
        finally:
            if previous_fastapi is None:
                sys.modules.pop("fastapi", None)
            else:
                sys.modules["fastapi"] = previous_fastapi
            if previous_responses is None:
                sys.modules.pop("fastapi.responses", None)
            else:
                sys.modules["fastapi.responses"] = previous_responses

    class _Request:
        def __init__(self, chunks, headers=None):
            self._chunks = chunks
            self.headers = headers or {}

        async def stream(self):
            for chunk in self._chunks:
                yield chunk

    async def test_fastapi_adapter_handles_sync_async_throwing_and_timed_out_verifiers(self) -> None:
        from googlechatai.adapters.fastapi import FastAPIAdapter
        from googlechatai.router import GoogleChatAI

        class SyncVerifier:
            def verify(self, token):
                _ = token
                return {"ok": False, "status": "missing_token"}

        class AsyncVerifier:
            async def verify(self, token):
                _ = token
                return {"ok": False, "status": "async_rejected"}

        class ThrowingVerifier:
            def verify(self, token):
                _ = token
                raise RuntimeError("unavailable")

        class SlowAsyncVerifier:
            async def verify(self, token):
                _ = token
                await asyncio.sleep(0.1)
                return {"ok": True}

        for verifier, expected_status in (
            (SyncVerifier(), 401),
            (AsyncVerifier(), 401),
            (ThrowingVerifier(), 500),
            (SlowAsyncVerifier(), 500),
        ):
            with self.subTest(verifier=type(verifier).__name__):
                handler = self._mount_handler(
                    FastAPIAdapter(
                        GoogleChatAI(),
                        verifier=verifier,
                        verification_timeout_ms=5,
                    )
                )
                response = await handler(self._Request([b"{}"] ))
                self.assertEqual(response.status_code, expected_status)

    async def test_fastapi_adapter_streams_a_bounded_body(self) -> None:
        from googlechatai.adapters.fastapi import FastAPIAdapter
        from googlechatai.router import GoogleChatAI

        handler = self._mount_handler(FastAPIAdapter(GoogleChatAI(), max_body_bytes=4))
        response = await handler(self._Request([b"123", b"456"]))

        self.assertEqual(response.status_code, 413)

    async def test_fastapi_adapter_maps_delivery_capacity_to_503(self) -> None:
        import googlechatai.router.runtime as runtime_module

        from googlechatai.adapters.fastapi import FastAPIAdapter
        from googlechatai.router import GoogleChatAI

        chat = GoogleChatAI(deadline={"budget_ms": 20})
        chat.on_message(lambda ctx: "handled")
        handler = self._mount_handler(FastAPIAdapter(chat))
        payload = json.dumps(
            {
                "type": "MESSAGE",
                "eventTime": "2026-07-10T12:00:00Z",
                "message": {
                    "name": "spaces/AAA/messages/BBB",
                    "text": "hello",
                    "sender": {"name": "users/123", "type": "HUMAN"},
                    "space": {"name": "spaces/AAA"},
                },
                "space": {"name": "spaces/AAA"},
            }
        ).encode("utf-8")

        with patch.object(
            runtime_module,
            "_blocking_work_slots",
            threading.BoundedSemaphore(0),
        ):
            response = await handler(self._Request([payload]))

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.content["error"], "delivery_capacity_exhausted")
