import { createPublicKey, verify as cryptoVerify } from "node:crypto";

type JsonObject = Record<string, unknown>;

export const GOOGLE_CHAT_TOKEN_ISSUER = "chat@system.gserviceaccount.com";
export const GOOGLE_CHAT_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com";
export const GOOGLE_OIDC_ISSUERS = [
  "https://accounts.google.com",
  "accounts.google.com",
];
export const GOOGLE_OIDC_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

const DEFAULT_CLOCK_SKEW_MS = 300_000;
const DEFAULT_JWKS_CACHE_TTL_MS = 3_600_000;

export type JwtVerificationStatus =
  | "verified"
  | "missing_token"
  | "malformed"
  | "unsupported_algorithm"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "not_yet_valid"
  | "expired"
  | "wrong_email"
  | "email_not_verified"
  | "keys_unavailable";

export interface DecodedJwt {
  header: JsonObject;
  payload: JsonObject;
  signingInput: string;
  signatureB64: string;
}

export interface JwtVerificationOptions {
  keys: JsonObject[];
  audience: string | string[];
  issuers?: string[];
  nowMs?: number;
  clockSkewMs?: number;
  expectedEmail?: string | null;
  requireEmailVerified?: boolean;
}

export interface JwtVerificationResult {
  kind: "chat.request_verification";
  ok: boolean;
  status: JwtVerificationStatus;
  reason: string;
  claims: JsonObject | null;
  keyId: string | null;
  checkedAt: string;
  warnings: string[];
}

export interface GoogleChatTokenVerifier {
  verify(token: string | null | undefined): Promise<JwtVerificationResult>;
}

export interface CreateTokenVerifierOptions {
  audience: string | string[];
  issuers?: string[];
  jwksUrl?: string;
  fetch?: (url: string) => Promise<Response>;
  cacheTtlMs?: number;
  clockSkewMs?: number;
  now?: () => number;
  expectedEmail?: string | null;
  requireEmailVerified?: boolean;
}

export interface CreatePubSubPushVerifierOptions
  extends Omit<CreateTokenVerifierOptions, "issuers" | "jwksUrl" | "expectedEmail"> {
  serviceAccountEmail?: string | null;
  issuers?: string[];
  jwksUrl?: string;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function base64UrlDecode(value: string): Buffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function decodeJsonSegment(segment: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(segment).toString("utf8"));
  } catch {
    throw new TypeError("Token segment is not base64url-encoded JSON.");
  }
  const record = asRecord(parsed);
  if (!record) {
    throw new TypeError("Token segment did not decode to a JSON object.");
  }
  return record;
}

export function decodeJwtWithoutVerifying(token: string): DecodedJwt {
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("Expected token to be a non-empty string.");
  }
  const segments = token.split(".");
  if (segments.length !== 3) {
    throw new TypeError("Expected token to have three dot-separated segments.");
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  return {
    header: decodeJsonSegment(headerSegment!),
    payload: decodeJsonSegment(payloadSegment!),
    signingInput: `${headerSegment}.${payloadSegment}`,
    signatureB64: signatureSegment ?? "",
  };
}

function normalizedAudiences(audience: string | string[]): string[] {
  const values = (Array.isArray(audience) ? audience : [audience])
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  if (values.length === 0) {
    throw new TypeError("Expected audience to include at least one non-empty string.");
  }
  return values;
}

function tokenAudiences(payload: JsonObject): string[] {
  const aud = payload.aud;
  if (typeof aud === "string") {
    return [aud];
  }
  if (Array.isArray(aud)) {
    return aud.filter((value): value is string => typeof value === "string");
  }
  return [];
}

function findKey(keys: JsonObject[], kid: string | null): JsonObject | null {
  if (keys.length === 0) {
    return null;
  }
  if (kid === null) {
    return keys.length === 1 ? keys[0]! : null;
  }
  return keys.find((key) => asString(key.kid) === kid) ?? null;
}

function verifyRs256Signature(
  key: JsonObject,
  signingInput: string,
  signatureB64: string,
): boolean {
  const n = asString(key.n);
  const e = asString(key.e);
  if (!n || !e) {
    return false;
  }
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: { kty: "RSA", n, e },
      format: "jwk",
    });
  } catch {
    return false;
  }
  const signature = base64UrlDecode(signatureB64);
  if (signature.length === 0) {
    return false;
  }
  try {
    return cryptoVerify(
      "sha256",
      Buffer.from(signingInput, "utf8"),
      publicKey,
      signature,
    );
  } catch {
    return false;
  }
}

function result(
  status: JwtVerificationStatus,
  reason: string,
  options: {
    nowMs: number;
    claims?: JsonObject | null;
    keyId?: string | null;
    warnings?: string[];
  },
): JwtVerificationResult {
  return {
    kind: "chat.request_verification",
    ok: status === "verified",
    status,
    reason,
    claims: options.claims ?? null,
    keyId: options.keyId ?? null,
    checkedAt: new Date(options.nowMs).toISOString(),
    warnings: options.warnings ?? [],
  };
}

export function verifyGoogleChatToken(
  token: string | null | undefined,
  options: JwtVerificationOptions,
): JwtVerificationResult {
  if (!Array.isArray(options.keys)) {
    throw new TypeError(
      "Expected options.keys to be an array of JWKs for offline verification. Use createGoogleChatTokenVerifier for fetch-based verification.",
    );
  }
  const audiences = normalizedAudiences(options.audience);
  const issuers =
    options.issuers && options.issuers.length > 0
      ? options.issuers
      : [GOOGLE_CHAT_TOKEN_ISSUER];
  const nowMs = options.nowMs ?? Date.now();
  const clockSkewMs = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;

  if (!token) {
    return result("missing_token", "No bearer token was provided.", { nowMs });
  }

  let decoded: DecodedJwt;
  try {
    decoded = decodeJwtWithoutVerifying(token);
  } catch {
    return result("malformed", "Token is not a structurally valid JWT.", { nowMs });
  }

  const claims = decoded.payload;
  const alg = asString(decoded.header.alg) ?? "missing";
  const kid = asString(decoded.header.kid);

  if (alg !== "RS256") {
    return result(
      "unsupported_algorithm",
      `Token algorithm ${alg} is not RS256.`,
      { nowMs, claims, keyId: kid },
    );
  }

  const key = findKey(options.keys, kid);
  if (!key) {
    return result(
      "unknown_key",
      `No JWKS key matches kid ${kid ?? "missing"}.`,
      { nowMs, claims, keyId: kid },
    );
  }

  if (!verifyRs256Signature(key, decoded.signingInput, decoded.signatureB64)) {
    return result("bad_signature", "Token signature verification failed.", {
      nowMs,
      claims,
      keyId: kid,
    });
  }

  const issuer = asString(claims.iss) ?? "missing";
  if (!issuers.includes(issuer)) {
    return result(
      "wrong_issuer",
      `Token issuer ${issuer} is not an accepted issuer.`,
      { nowMs, claims, keyId: kid },
    );
  }

  const audValues = tokenAudiences(claims);
  if (!audValues.some((value) => audiences.includes(value))) {
    return result(
      "wrong_audience",
      `Token audience ${audValues.join(",") || "missing"} does not match the expected audience.`,
      { nowMs, claims, keyId: kid },
    );
  }

  const nowSec = nowMs / 1000;
  const skewSec = clockSkewMs / 1000;
  const notBefore = asNumber(claims.nbf) ?? asNumber(claims.iat);
  if (notBefore !== null && notBefore - skewSec > nowSec) {
    return result(
      "not_yet_valid",
      "Token is not valid yet beyond allowed clock skew.",
      { nowMs, claims, keyId: kid },
    );
  }
  const expiry = asNumber(claims.exp);
  if (expiry === null || expiry + skewSec < nowSec) {
    return result(
      "expired",
      "Token is expired beyond allowed clock skew.",
      { nowMs, claims, keyId: kid },
    );
  }

  const expectedEmail = options.expectedEmail ?? null;
  const requireEmailVerified =
    options.requireEmailVerified ?? expectedEmail !== null;
  if (expectedEmail !== null && asString(claims.email) !== expectedEmail) {
    return result(
      "wrong_email",
      "Token email does not match the expected service account.",
      { nowMs, claims, keyId: kid },
    );
  }
  if (requireEmailVerified && claims.email !== undefined && claims.email_verified !== true) {
    return result(
      "email_not_verified",
      "Token email is present but not marked verified.",
      { nowMs, claims, keyId: kid },
    );
  }

  return result("verified", "Token signature and claims verified.", {
    nowMs,
    claims,
    keyId: kid,
  });
}

export function bearerTokenFromAuthorization(
  authorization: string | null | undefined,
): string | null {
  if (typeof authorization !== "string") {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1]!.trim() : null;
}

export function verifyChatRequestAuthorization(
  authorization: string | null | undefined,
  options: JwtVerificationOptions,
): JwtVerificationResult {
  return verifyGoogleChatToken(bearerTokenFromAuthorization(authorization), options);
}

interface JwksCacheEntry {
  keys: JsonObject[];
  fetchedAtMs: number;
}

async function fetchJwks(
  fetchImpl: (url: string) => Promise<Response>,
  url: string,
): Promise<JsonObject[]> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`JWKS request returned HTTP ${response.status}.`);
  }
  const body = asRecord(await response.json());
  const keys = Array.isArray(body?.keys)
    ? body!.keys.map((key) => asRecord(key)).filter((key): key is JsonObject => key !== null)
    : [];
  if (keys.length === 0) {
    throw new Error("JWKS response did not include any keys.");
  }
  return keys;
}

export function createGoogleChatTokenVerifier(
  options: CreateTokenVerifierOptions,
): GoogleChatTokenVerifier {
  const audiences = normalizedAudiences(options.audience);
  const issuers = options.issuers ?? [GOOGLE_CHAT_TOKEN_ISSUER];
  const jwksUrl = options.jwksUrl ?? GOOGLE_CHAT_JWKS_URL;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Expected options.fetch to be a fetch-compatible function.");
  }
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  let cache: JwksCacheEntry | null = null;

  async function loadKeys(forceRefresh: boolean): Promise<JsonObject[]> {
    const nowMs = now();
    if (!forceRefresh && cache && nowMs - cache.fetchedAtMs < cacheTtlMs) {
      return cache.keys;
    }
    const keys = await fetchJwks(fetchImpl, jwksUrl);
    cache = { keys, fetchedAtMs: nowMs };
    return keys;
  }

  async function verify(token: string | null | undefined): Promise<JwtVerificationResult> {
    const nowMs = now();
    let keys: JsonObject[];
    try {
      keys = await loadKeys(false);
    } catch (error) {
      return result(
        "keys_unavailable",
        `Failed to load JWKS from ${jwksUrl}: ${(error as Error).message}`,
        { nowMs },
      );
    }

    const verifyOptions: JwtVerificationOptions = {
      keys,
      audience: audiences,
      issuers,
      nowMs,
      clockSkewMs: options.clockSkewMs,
      expectedEmail: options.expectedEmail,
      requireEmailVerified: options.requireEmailVerified,
    };
    let outcome = verifyGoogleChatToken(token, verifyOptions);
    if (outcome.status === "unknown_key") {
      try {
        keys = await loadKeys(true);
      } catch (error) {
        return result(
          "keys_unavailable",
          `Failed to refresh JWKS from ${jwksUrl}: ${(error as Error).message}`,
          { nowMs },
        );
      }
      outcome = verifyGoogleChatToken(token, { ...verifyOptions, keys });
    }
    return outcome;
  }

  return { verify };
}

export function createPubSubPushVerifier(
  options: CreatePubSubPushVerifierOptions,
): GoogleChatTokenVerifier {
  return createGoogleChatTokenVerifier({
    ...options,
    issuers: options.issuers ?? GOOGLE_OIDC_ISSUERS,
    jwksUrl: options.jwksUrl ?? GOOGLE_OIDC_JWKS_URL,
    expectedEmail: options.serviceAccountEmail ?? null,
    requireEmailVerified:
      options.requireEmailVerified ?? Boolean(options.serviceAccountEmail),
  });
}

export type ChatRequestVerifier = (
  request: Request,
) => Promise<JwtVerificationResult>;

export function createChatRequestVerifier(
  options: CreateTokenVerifierOptions,
): ChatRequestVerifier {
  const verifier = createGoogleChatTokenVerifier(options);
  return async (request: Request) =>
    verifier.verify(bearerTokenFromAuthorization(request.headers.get("authorization")));
}
