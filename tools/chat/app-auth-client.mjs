import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

export function signServiceAccountJwt(serviceAccount, scopes, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const claim = {
    iss: serviceAccount.client_email,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(claim),
  )}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsigned)
    .sign(serviceAccount.private_key, "base64url");

  return `${unsigned}.${signature}`;
}

export async function fetchServiceAccountAccessToken(
  serviceAccount,
  scopes,
  { fetchImpl = fetch } = {},
) {
  const assertion = signServiceAccountJwt(serviceAccount, scopes);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const json = await response.json().catch(() => ({}));

  if (!response.ok || typeof json.access_token !== "string") {
    const error = new Error(`OAuth token request failed: HTTP ${response.status}`);
    error.status = response.status;
    error.response = json;
    throw error;
  }

  return json.access_token;
}

export function createServiceAccountTokenBroker(
  serviceAccount,
  scopes,
  { fetchImpl = fetch } = {},
) {
  let accessToken = null;

  return async ({ forceRefresh }) => {
    if (!accessToken || forceRefresh) {
      accessToken = await fetchServiceAccountAccessToken(serviceAccount, scopes, {
        fetchImpl,
      });
      return { accessToken, refreshed: Boolean(forceRefresh) };
    }

    return { accessToken, refreshed: false };
  };
}

export async function loadBuiltTransportHelpers(repoRootPath = repoRoot) {
  try {
    return await import(
      pathToFileURL(path.join(repoRootPath, "packages/node/dist/index.js"))
    );
  } catch (error) {
    throw new Error(
      `Unable to load built SDK transport helpers. Run \`corepack pnpm build\` first. ${error.message}`,
    );
  }
}

export function buildChatApiUrl(resourcePath, query = {}) {
  const url = new URL(`https://chat.googleapis.com/v1/${resourcePath}`);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

export function summarizeResponseHeaders(headers) {
  const selected = {};
  for (const name of [
    "x-goog-request-id",
    "x-request-id",
    "x-guploader-uploadid",
    "server-timing",
  ]) {
    const value =
      typeof headers?.get === "function" ? headers.get(name) : headers?.[name];
    if (value) {
      selected[name] = value;
    }
  }
  return selected;
}

export async function chatRequestWithAppAuth({
  serviceAccount,
  scopes,
  resourcePath = null,
  url = null,
  query = {},
  init = {},
  getAccessToken = null,
  requestJsonWithRetry = null,
  fetchImpl = null,
  sleepMs = null,
  repoRootPath = repoRoot,
}) {
  const requestWithRetry =
    requestJsonWithRetry ??
    (await loadBuiltTransportHelpers(repoRootPath)).requestJsonWithRetry;
  const tokenBroker =
    getAccessToken ??
    createServiceAccountTokenBroker(serviceAccount, scopes);
  const targetUrl = url ?? buildChatApiUrl(resourcePath, query);
  const result = await requestWithRetry(
    {
      url: targetUrl,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body,
      idempotent: Boolean(init.idempotent),
      principal: "app",
    },
    {
      getAccessToken: tokenBroker,
      retryPolicy: init.retryPolicy,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      ...(sleepMs ? { sleepMs } : {}),
    },
  );

  return {
    ...result,
    headers: summarizeResponseHeaders(result.headers),
  };
}
