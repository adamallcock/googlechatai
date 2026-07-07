import json
import pathlib
import unittest

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
