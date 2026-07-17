import crypto from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";

import {
  FirestoreIdempotencyStore,
  GoogleChatAI,
  createChatRequestVerifier,
} from "../../packages/node/dist/index.js";

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const INTERNAL_REQUEST_ORIGIN = "http://googlechatai.local";
const DEFAULT_IDEMPOTENCY_COLLECTION = "googleChatEventIdempotency";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_METADATA_TIMEOUT_MS = 5_000;
const DEFAULT_FIRESTORE_TIMEOUT_MS = 8_000;
const SMOKE_MARKER_PATTERN = /(?:^|\s)googlechatai-smoke:([a-z0-9][a-z0-9_-]{7,127})(?=\s|$)/i;

class RequestBodyTooLargeError extends Error {
  constructor(maxBodyBytes) {
    super(`Google Chat event payload exceeds the ${maxBodyBytes} byte limit.`);
    this.name = "RequestBodyTooLargeError";
  }
}

class InvalidRequestTargetError extends Error {
  constructor() {
    super("Cloud Run reference accepts origin-form request targets only.");
    this.name = "InvalidRequestTargetError";
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required in normal Cloud Run mode.`);
  }
  return value;
}

function headerValue(headers, name) {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value == null ? undefined : String(value);
}

function requestHeaders(headers) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    result.set(name, Array.isArray(value) ? value.join(", ") : String(value));
  }
  return result;
}

function requestUrl(request) {
  const target = request.url ?? "/";
  // A normal Node HTTP server receives origin-form targets. Reject absolute
  // and scheme-relative forms instead of letting an attacker select the URL
  // observed by an injected request verifier.
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) {
    throw new InvalidRequestTargetError();
  }
  const url = new URL(target, INTERNAL_REQUEST_ORIGIN);
  if (url.origin !== INTERNAL_REQUEST_ORIGIN) {
    throw new InvalidRequestTargetError();
  }
  return url;
}

export async function readBoundedBody(request, maxBodyBytes) {
  const declaredLength = Number(headerValue(request.headers, "content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    // Do not leave a keep-alive socket paused after an early length rejection.
    // The data is deliberately discarded rather than buffered.
    request.resume();
    throw new RequestBodyTooLargeError(maxBodyBytes);
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > maxBodyBytes) {
      request.resume();
      throw new RequestBodyTooLargeError(maxBodyBytes);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function parseJson(text) {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

class FetchDeadlineError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} exceeded its ${timeoutMs}ms deadline.`);
    this.name = "FetchDeadlineError";
  }
}

export async function fetchWithDeadline(fetchImpl, url, init, { timeoutMs, label }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const inheritedSignal = init?.signal;
  const signal = inheritedSignal
    ? AbortSignal.any([inheritedSignal, controller.signal])
    : controller.signal;
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new FetchDeadlineError(label, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function smokeCorrelationForText(text) {
  if (typeof text !== "string") {
    return null;
  }
  const marker = text.match(SMOKE_MARKER_PATTERN)?.[1];
  return marker
    ? crypto.createHash("sha256").update(marker, "utf8").digest("hex")
    : null;
}

/**
 * Return short-lived Cloud Run metadata-server access tokens without exposing
 * them to the SDK, logs, or persistent storage.
 */
export function createMetadataAccessTokenProvider({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  metadataUrl = METADATA_TOKEN_URL,
  timeoutMs = DEFAULT_METADATA_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Metadata token provider requires a fetch implementation.");
  }
  let cached = null;
  let refreshInFlight = null;

  return async () => {
    const currentTime = now();
    if (cached && cached.expiresAtMs > currentTime) {
      return cached.accessToken;
    }
    if (refreshInFlight) {
      return refreshInFlight;
    }

    refreshInFlight = (async () => {
      const response = await fetchWithDeadline(
        fetchImpl,
        metadataUrl,
        { headers: { "Metadata-Flavor": "Google" } },
        { timeoutMs: positiveInteger(timeoutMs, DEFAULT_METADATA_TIMEOUT_MS), label: "Cloud Run metadata token request" },
      );
      if (!response.ok) {
        throw new Error(`Cloud Run metadata token request failed with HTTP ${response.status}.`);
      }
      const payload = await response.json();
      const accessToken = payload && typeof payload.access_token === "string"
        ? payload.access_token
        : null;
      const expiresInSeconds = Number(payload?.expires_in);
      if (!accessToken) {
        throw new Error("Cloud Run metadata token response did not contain an access token.");
      }
      const usableLifetimeMs = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
        ? Math.max(1_000, expiresInSeconds * 1_000 - TOKEN_REFRESH_SKEW_MS)
        : 300_000;
      cached = {
        accessToken,
        expiresAtMs: now() + usableLifetimeMs,
      };
      return accessToken;
    })();

    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  };
}

/**
 * Adapt Cloud Run's metadata credentials to the SDK's injected Firestore REST
 * transport contract. The token stays entirely within this application layer.
 */
export function createMetadataFirestoreTransport({
  fetchImpl = globalThis.fetch,
  getAccessToken = createMetadataAccessTokenProvider({ fetchImpl }),
  timeoutMs = DEFAULT_FIRESTORE_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function" || typeof getAccessToken !== "function") {
    throw new TypeError("Firestore transport requires fetch and access-token functions.");
  }

  return async ({ method, url, body }) => {
    const accessToken = await getAccessToken();
    const response = await fetchWithDeadline(
      fetchImpl,
      url,
      {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      { timeoutMs: positiveInteger(timeoutMs, DEFAULT_FIRESTORE_TIMEOUT_MS), label: "Firestore request" },
    );
    const text = await response.text();
    return {
      status: response.status,
      json: parseJson(text),
    };
  };
}

function logRuntimeEvent(severity, message, metadata = {}) {
  const safeMetadata = {
    eventKind: typeof metadata.eventKind === "string" ? metadata.eventKind : undefined,
    source: typeof metadata.source === "string" ? metadata.source : undefined,
    responseStatus: typeof metadata.responseStatus === "number" ? metadata.responseStatus : undefined,
    verificationStatus:
      typeof metadata.verificationStatus === "string" ? metadata.verificationStatus : undefined,
    smokeCorrelation:
      typeof metadata.smokeCorrelation === "string" && /^[a-f0-9]{64}$/i.test(metadata.smokeCorrelation)
        ? metadata.smokeCorrelation
        : undefined,
  };
  console[severity === "ERROR" ? "error" : severity === "WARNING" ? "warn" : "log"](
    JSON.stringify({ severity, message, ...safeMetadata }),
  );
}

async function sendFetchResponse(response, fetchResponse) {
  response.writeHead(fetchResponse.status, Object.fromEntries(fetchResponse.headers.entries()));
  response.end(await fetchResponse.text());
}

function makeChat({
  localFixtures,
  audience,
  verifier,
  projectId,
  collectionPath,
  metadataTimeoutMs,
  firestoreTimeoutMs,
}) {
  if (!localFixtures && !verifier && !audience) {
    throw new Error(
      "GOOGLE_CHAT_AUDIENCE is required unless GOOGLE_CHAT_LOCAL_FIXTURES=1 is set.",
    );
  }
  const requestVerifier = localFixtures
    ? undefined
    : verifier ?? createChatRequestVerifier({ audience });
  const dedupe = localFixtures
    ? undefined
    : {
        store: new FirestoreIdempotencyStore({
          projectId: requiredString(projectId, "GOOGLE_CLOUD_PROJECT"),
          collectionPath: collectionPath ?? DEFAULT_IDEMPOTENCY_COLLECTION,
          request: createMetadataFirestoreTransport({
            getAccessToken: createMetadataAccessTokenProvider({ timeoutMs: metadataTimeoutMs }),
            timeoutMs: firestoreTimeoutMs,
          }),
          recordDuplicateDeliveries: false,
        }),
      };
  const chat = new GoogleChatAI({
    source: localFixtures ? "fixture" : "chat_http",
    verifier: requestVerifier,
    dedupe,
    logger: {
      info(message, metadata) {
        logRuntimeEvent("INFO", message, metadata);
      },
      warn(message, metadata) {
        logRuntimeEvent("WARNING", message, metadata);
      },
      error(message, metadata) {
        logRuntimeEvent("ERROR", message, metadata);
      },
    },
  });

  chat.onMessage((event, context) => {
    const reply = context.reply.text("Google Chat AI SDK Cloud Run reference received the event.");
    const smokeCorrelation = smokeCorrelationForText(event.message?.text);
    if (smokeCorrelation) {
      logRuntimeEvent("INFO", "cloud_run_reference.inbound_smoke_handled", {
        eventKind: event.kind,
        source: event.source,
        responseStatus: 200,
        smokeCorrelation,
      });
    }
    return reply;
  });
  chat.onUnknownEvent((_event, context) => context.reply.json({}));
  return chat;
}

/**
 * Create the package-routed HTTP boundary without starting a listener. Tests
 * and platform wrappers can inject a verifier; production defaults to the SDK
 * Google Chat JWT verifier and only local fixture mode bypasses it.
 */
export function createServer(options = {}) {
  const localFixtures = options.localFixtures ?? process.env.GOOGLE_CHAT_LOCAL_FIXTURES === "1";
  const maxBodyBytes = positiveInteger(
    options.maxBodyBytes ?? process.env.GOOGLE_CHAT_MAX_BODY_BYTES,
    DEFAULT_MAX_BODY_BYTES,
  );
  const metadataTimeoutMs = positiveInteger(
    options.metadataTimeoutMs ?? process.env.GOOGLE_CHAT_METADATA_REQUEST_TIMEOUT_MS,
    DEFAULT_METADATA_TIMEOUT_MS,
  );
  const firestoreTimeoutMs = positiveInteger(
    options.firestoreTimeoutMs ?? process.env.GOOGLE_CHAT_FIRESTORE_REQUEST_TIMEOUT_MS,
    DEFAULT_FIRESTORE_TIMEOUT_MS,
  );
  if (options.chat && !localFixtures) {
    throw new Error(
      "Injected chat runtimes are only allowed with localFixtures: true. " +
        "Normal mode must use the verifier-bearing SDK factory.",
    );
  }
  const chat = options.chat ?? makeChat({
    localFixtures,
    audience: options.audience ?? process.env.GOOGLE_CHAT_AUDIENCE,
    verifier: options.verifier,
    projectId: options.projectId ?? process.env.GOOGLE_CLOUD_PROJECT,
    collectionPath:
      options.idempotencyCollection ??
      process.env.GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION ??
      DEFAULT_IDEMPOTENCY_COLLECTION,
    metadataTimeoutMs,
    firestoreTimeoutMs,
  });

  return http.createServer(async (request, response) => {
    try {
      // Do not give an attacker-controlled Host header (or absolute request
      // target) to a custom verifier as the Request URL.
      const url = requestUrl(request);
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, {
          ok: true,
          service: "googlechatai-cloud-run-reference",
          verification: localFixtures ? "local-fixtures-only" : "google-chat-jwt",
          idempotency: localFixtures ? "local-fixtures-only" : "firestore",
        });
        return;
      }
      if (url.pathname !== "/chat/events") {
        sendJson(response, 404, { ok: false, paths: ["/healthz", "/chat/events"] });
        return;
      }

      const method = request.method ?? "GET";
      const body = method === "GET" || method === "HEAD"
        ? undefined
        : await readBoundedBody(request, maxBodyBytes);
      const fetchRequest = new Request(url, {
        method,
        headers: requestHeaders(request.headers),
        ...(body !== undefined && body.byteLength > 0 ? { body } : {}),
      });
      await sendFetchResponse(response, await chat.fetch(fetchRequest));
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        sendJson(response, 413, {
          error: { code: "payload_too_large", message: error.message },
        });
        return;
      }
      if (error instanceof InvalidRequestTargetError) {
        sendJson(response, 400, {
          error: { code: "invalid_request_target", message: error.message },
        });
        return;
      }
      console.error(
        JSON.stringify({
          severity: "ERROR",
          message: "cloud_run_reference.request_failed",
          error: error instanceof Error ? error.name : "unknown_error",
        }),
      );
      sendJson(response, 500, {
        error: { code: "request_failed", message: "Request processing failed." },
      });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = positiveInteger(process.env.PORT, 8080);
  const server = createServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(
      JSON.stringify({
        severity: "INFO",
        message: "cloud_run_reference.started",
        port,
        localFixtures: process.env.GOOGLE_CHAT_LOCAL_FIXTURES === "1",
      }),
    );
  });
}
