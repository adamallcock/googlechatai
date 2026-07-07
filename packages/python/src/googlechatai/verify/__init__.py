"""Inbound Google Chat request verification.

Verifies the bearer JWTs Google attaches to Chat app HTTP events and
Pub/Sub push deliveries. Signature verification is implemented with the
standard library only (RSASSA-PKCS1-v1_5 with SHA-256), so the package
stays dependency-free.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable, Mapping

GOOGLE_CHAT_TOKEN_ISSUER = "chat@system.gserviceaccount.com"
GOOGLE_CHAT_JWKS_URL = (
    "https://www.googleapis.com/service_accounts/v1/jwk/"
    "chat@system.gserviceaccount.com"
)
GOOGLE_OIDC_ISSUERS = ["https://accounts.google.com", "accounts.google.com"]
GOOGLE_OIDC_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"

_DEFAULT_CLOCK_SKEW_MS = 300_000
_DEFAULT_JWKS_CACHE_TTL_MS = 3_600_000
_SHA256_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")
_BEARER_PATTERN = re.compile(r"^Bearer\s+(.+)$", re.IGNORECASE)

JsonObject = dict[str, Any]


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    return float(value) if isinstance(value, (int, float)) else None


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _decode_json_segment(segment: str) -> JsonObject:
    try:
        parsed = json.loads(_b64url_decode(segment).decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - normalized below
        raise TypeError("Token segment is not base64url-encoded JSON.") from exc
    if not isinstance(parsed, dict):
        raise TypeError("Token segment did not decode to a JSON object.")
    return parsed


def decode_jwt_without_verifying(token: str) -> JsonObject:
    if not isinstance(token, str) or not token:
        raise TypeError("Expected token to be a non-empty string.")
    segments = token.split(".")
    if len(segments) != 3:
        raise TypeError("Expected token to have three dot-separated segments.")
    header_segment, payload_segment, signature_segment = segments
    return {
        "header": _decode_json_segment(header_segment),
        "payload": _decode_json_segment(payload_segment),
        "signingInput": f"{header_segment}.{payload_segment}",
        "signatureB64": signature_segment,
    }


def _normalized_audiences(audience: Any) -> list[str]:
    raw = audience if isinstance(audience, list) else [audience]
    values = [item.strip() for item in raw if isinstance(item, str) and item.strip()]
    if not values:
        raise TypeError("Expected audience to include at least one non-empty string.")
    return values


def _token_audiences(payload: JsonObject) -> list[str]:
    aud = payload.get("aud")
    if isinstance(aud, str):
        return [aud]
    if isinstance(aud, list):
        return [item for item in aud if isinstance(item, str)]
    return []


def _find_key(keys: list[JsonObject], kid: str | None) -> JsonObject | None:
    if not keys:
        return None
    if kid is None:
        return keys[0] if len(keys) == 1 else None
    for key in keys:
        if _as_string(key.get("kid")) == kid:
            return key
    return None


def _verify_rs256_signature(
    key: JsonObject,
    signing_input: str,
    signature_b64: str,
) -> bool:
    n_b64 = _as_string(key.get("n"))
    e_b64 = _as_string(key.get("e"))
    if not n_b64 or not e_b64:
        return False
    try:
        modulus = int.from_bytes(_b64url_decode(n_b64), "big")
        exponent = int.from_bytes(_b64url_decode(e_b64), "big")
        signature = _b64url_decode(signature_b64)
    except Exception:  # noqa: BLE001 - malformed key/signature material
        return False
    if modulus <= 0 or exponent <= 0 or not signature:
        return False
    key_bytes = (modulus.bit_length() + 7) // 8
    if len(signature) != key_bytes:
        return False
    signature_int = int.from_bytes(signature, "big")
    if signature_int >= modulus:
        return False
    encoded = pow(signature_int, exponent, modulus).to_bytes(key_bytes, "big")
    digest = hashlib.sha256(signing_input.encode("utf-8")).digest()
    padding_length = key_bytes - len(_SHA256_DIGEST_INFO) - len(digest) - 3
    if padding_length < 8:
        return False
    expected = (
        b"\x00\x01"
        + b"\xff" * padding_length
        + b"\x00"
        + _SHA256_DIGEST_INFO
        + digest
    )
    return hmac.compare_digest(encoded, expected)


def _checked_at(now_ms: float) -> str:
    total_ms = int(now_ms)
    seconds, ms = divmod(total_ms, 1000)
    stamp = datetime.fromtimestamp(seconds, tz=timezone.utc)
    return f"{stamp.strftime('%Y-%m-%dT%H:%M:%S')}.{ms:03d}Z"


def _result(
    status: str,
    reason: str,
    *,
    now_ms: float,
    claims: JsonObject | None = None,
    key_id: str | None = None,
    warnings: list[str] | None = None,
) -> JsonObject:
    return {
        "kind": "chat.request_verification",
        "ok": status == "verified",
        "status": status,
        "reason": reason,
        "claims": claims,
        "keyId": key_id,
        "checkedAt": _checked_at(now_ms),
        "warnings": warnings or [],
    }


def _now_ms_default() -> float:
    return datetime.now(tz=timezone.utc).timestamp() * 1000


def verify_google_chat_token(
    token: str | None,
    options: Mapping[str, Any] | None = None,
    *,
    keys: list[JsonObject] | None = None,
    audience: str | list[str] | None = None,
    issuers: list[str] | None = None,
    now_ms: float | None = None,
    clock_skew_ms: float | None = None,
    expected_email: str | None = None,
    require_email_verified: bool | None = None,
) -> JsonObject:
    """Verify a Google Chat bearer JWT against inline JWKS keys.

    Accepts either a camelCase options mapping (the shared JSON contract)
    or snake_case keyword arguments; keyword arguments win on conflict.
    """

    shared = dict(options or {})
    keys = keys if keys is not None else shared.get("keys")
    audience = audience if audience is not None else shared.get("audience")
    issuers = issuers if issuers is not None else shared.get("issuers")
    now_ms = now_ms if now_ms is not None else _as_number(shared.get("nowMs"))
    clock_skew_ms = (
        clock_skew_ms
        if clock_skew_ms is not None
        else _as_number(shared.get("clockSkewMs"))
    )
    expected_email = (
        expected_email
        if expected_email is not None
        else _as_string(shared.get("expectedEmail"))
    )
    if require_email_verified is None:
        raw_require = shared.get("requireEmailVerified")
        require_email_verified = raw_require if isinstance(raw_require, bool) else None

    if not isinstance(keys, list):
        raise TypeError(
            "Expected options.keys to be an array of JWKs for offline "
            "verification. Use create_google_chat_token_verifier for "
            "fetch-based verification."
        )
    audiences = _normalized_audiences(audience)
    accepted_issuers = issuers if issuers else [GOOGLE_CHAT_TOKEN_ISSUER]
    resolved_now_ms = now_ms if now_ms is not None else _now_ms_default()
    skew_ms = clock_skew_ms if clock_skew_ms is not None else _DEFAULT_CLOCK_SKEW_MS

    if not token:
        return _result(
            "missing_token",
            "No bearer token was provided.",
            now_ms=resolved_now_ms,
        )

    try:
        decoded = decode_jwt_without_verifying(token)
    except TypeError:
        return _result(
            "malformed",
            "Token is not a structurally valid JWT.",
            now_ms=resolved_now_ms,
        )

    claims: JsonObject = decoded["payload"]
    alg = _as_string(decoded["header"].get("alg")) or "missing"
    kid = _as_string(decoded["header"].get("kid"))

    if alg != "RS256":
        return _result(
            "unsupported_algorithm",
            f"Token algorithm {alg} is not RS256.",
            now_ms=resolved_now_ms,
            claims=claims,
            key_id=kid,
        )

    key = _find_key([k for k in keys if isinstance(k, dict)], kid)
    if key is None:
        return _result(
            "unknown_key",
            f"No JWKS key matches kid {kid if kid is not None else 'missing'}.",
            now_ms=resolved_now_ms,
            claims=claims,
            key_id=kid,
        )

    if not _verify_rs256_signature(key, decoded["signingInput"], decoded["signatureB64"]):
        return _result(
            "bad_signature",
            "Token signature verification failed.",
            now_ms=resolved_now_ms,
            claims=claims,
            key_id=kid,
        )

    issuer = _as_string(claims.get("iss")) or "missing"
    if issuer not in accepted_issuers:
        return _result(
            "wrong_issuer",
            f"Token issuer {issuer} is not an accepted issuer.",
            now_ms=resolved_now_ms,
            claims=claims,
            key_id=kid,
        )

    aud_values = _token_audiences(claims)
    if not any(value in audiences for value in aud_values):
        joined = ",".join(aud_values) or "missing"
        return _result(
            "wrong_audience",
            f"Token audience {joined} does not match the expected audience.",
            now_ms=resolved_now_ms,
            claims=claims,
            key_id=kid,
        )

    now_sec = resolved_now_ms / 1000
    skew_sec = skew_ms / 1000
    not_before = _as_number(claims.get("nbf"))
    if not_before is None:
        not_before = _as_number(claims.get("iat"))
    if not_before is not None and not_before - skew_sec > now_sec:
        return _result(
            "not_yet_valid",
            "Token is not valid yet beyond allowed clock skew.",
            now_ms=resolved_now_ms,
            claims=claims,
            key_id=kid,
        )
    expiry = _as_number(claims.get("exp"))
    if expiry is None or expiry + skew_sec < now_sec:
        return _result(
            "expired",
            "Token is expired beyond allowed clock skew.",
            now_ms=resolved_now_ms,
            claims=claims,
            key_id=kid,
        )

    resolved_require_verified = (
        require_email_verified
        if require_email_verified is not None
        else expected_email is not None
    )
    if expected_email is not None and _as_string(claims.get("email")) != expected_email:
        return _result(
            "wrong_email",
            "Token email does not match the expected service account.",
            now_ms=resolved_now_ms,
            claims=claims,
            key_id=kid,
        )
    if (
        resolved_require_verified
        and "email" in claims
        and claims.get("email_verified") is not True
    ):
        return _result(
            "email_not_verified",
            "Token email is present but not marked verified.",
            now_ms=resolved_now_ms,
            claims=claims,
            key_id=kid,
        )

    return _result(
        "verified",
        "Token signature and claims verified.",
        now_ms=resolved_now_ms,
        claims=claims,
        key_id=kid,
    )


def bearer_token_from_authorization(authorization: str | None) -> str | None:
    if not isinstance(authorization, str):
        return None
    match = _BEARER_PATTERN.match(authorization.strip())
    return match.group(1).strip() if match else None


def verify_chat_request_authorization(
    authorization: str | None,
    options: Mapping[str, Any] | None = None,
    **kwargs: Any,
) -> JsonObject:
    return verify_google_chat_token(
        bearer_token_from_authorization(authorization),
        options,
        **kwargs,
    )


def _default_send(request: Mapping[str, Any]) -> JsonObject:
    req = urllib.request.Request(
        request["url"],
        method=str(request.get("method") or "GET"),
        headers=dict(request.get("headers") or {}),
    )
    with urllib.request.urlopen(req, timeout=30) as response:  # noqa: S310
        body = response.read().decode("utf-8")
        return {
            "ok": 200 <= response.status < 300,
            "status": response.status,
            "headers": dict(response.headers.items()),
            "json": json.loads(body) if body else {},
        }


class GoogleChatTokenVerifier:
    """JWKS-backed verifier with caching and single unknown-kid refresh."""

    def __init__(
        self,
        *,
        audience: str | list[str],
        issuers: list[str] | None = None,
        jwks_url: str = GOOGLE_CHAT_JWKS_URL,
        send: Callable[[Mapping[str, Any]], Mapping[str, Any]] | None = None,
        cache_ttl_ms: float = _DEFAULT_JWKS_CACHE_TTL_MS,
        clock_skew_ms: float | None = None,
        now: Callable[[], float] | None = None,
        expected_email: str | None = None,
        require_email_verified: bool | None = None,
    ) -> None:
        self._audiences = _normalized_audiences(audience)
        self._issuers = issuers if issuers else [GOOGLE_CHAT_TOKEN_ISSUER]
        self._jwks_url = jwks_url
        self._send = send or _default_send
        self._cache_ttl_ms = cache_ttl_ms
        self._clock_skew_ms = clock_skew_ms
        self._now = now or _now_ms_default
        self._expected_email = expected_email
        self._require_email_verified = require_email_verified
        self._cached_keys: list[JsonObject] | None = None
        self._fetched_at_ms: float = 0.0

    def _load_keys(self, force_refresh: bool) -> list[JsonObject]:
        now_ms = self._now()
        if (
            not force_refresh
            and self._cached_keys is not None
            and now_ms - self._fetched_at_ms < self._cache_ttl_ms
        ):
            return self._cached_keys
        response = self._send(
            {
                "url": self._jwks_url,
                "method": "GET",
                "headers": {"accept": "application/json"},
                "body": None,
            }
        )
        if not response.get("ok"):
            raise RuntimeError(
                f"JWKS request returned HTTP {int(response.get('status') or 0)}."
            )
        body = response.get("json") or {}
        raw_keys = body.get("keys") if isinstance(body, dict) else None
        keys = [key for key in raw_keys or [] if isinstance(key, dict)]
        if not keys:
            raise RuntimeError("JWKS response did not include any keys.")
        self._cached_keys = keys
        self._fetched_at_ms = now_ms
        return keys

    def verify(self, token: str | None) -> JsonObject:
        now_ms = self._now()
        try:
            keys = self._load_keys(False)
        except Exception as exc:  # noqa: BLE001 - reported as a result
            return _result(
                "keys_unavailable",
                f"Failed to load JWKS from {self._jwks_url}: {exc}",
                now_ms=now_ms,
            )

        outcome = verify_google_chat_token(
            token,
            keys=keys,
            audience=self._audiences,
            issuers=self._issuers,
            now_ms=now_ms,
            clock_skew_ms=self._clock_skew_ms,
            expected_email=self._expected_email,
            require_email_verified=self._require_email_verified,
        )
        if outcome["status"] == "unknown_key":
            try:
                keys = self._load_keys(True)
            except Exception as exc:  # noqa: BLE001 - reported as a result
                return _result(
                    "keys_unavailable",
                    f"Failed to refresh JWKS from {self._jwks_url}: {exc}",
                    now_ms=now_ms,
                )
            outcome = verify_google_chat_token(
                token,
                keys=keys,
                audience=self._audiences,
                issuers=self._issuers,
                now_ms=now_ms,
                clock_skew_ms=self._clock_skew_ms,
                expected_email=self._expected_email,
                require_email_verified=self._require_email_verified,
            )
        return outcome


def create_google_chat_token_verifier(**kwargs: Any) -> GoogleChatTokenVerifier:
    return GoogleChatTokenVerifier(**kwargs)


def create_pubsub_push_verifier(
    *,
    audience: str | list[str],
    service_account_email: str | None = None,
    issuers: list[str] | None = None,
    jwks_url: str | None = None,
    require_email_verified: bool | None = None,
    **kwargs: Any,
) -> GoogleChatTokenVerifier:
    return GoogleChatTokenVerifier(
        audience=audience,
        issuers=issuers if issuers is not None else list(GOOGLE_OIDC_ISSUERS),
        jwks_url=jwks_url if jwks_url is not None else GOOGLE_OIDC_JWKS_URL,
        expected_email=service_account_email,
        require_email_verified=(
            require_email_verified
            if require_email_verified is not None
            else service_account_email is not None
        ),
        **kwargs,
    )
