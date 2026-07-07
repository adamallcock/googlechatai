import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getAccessToken } from "./user-auth-smoke.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function loadBuiltRetryHelpers(repoRootPath = repoRoot) {
  try {
    return await import(
      pathToFileURL(path.join(repoRootPath, "packages/node/dist/index.js"))
    );
  } catch (error) {
    throw new Error(
      `Unable to load built SDK retry helpers. Run \`corepack pnpm build\` first. ${error.message}`,
    );
  }
}

function tokenHeader(lease) {
  return `${lease.token?.tokenType ?? "Bearer"} ${lease.accessToken}`;
}

function responseRetryAfter(response) {
  return typeof response.headers?.get === "function"
    ? response.headers.get("retry-after")
    : null;
}

export async function fetchWithUserAuthRetry({
  oauthClient,
  tokenStorePath,
  scopes,
  url,
  init = {},
  idempotent = false,
  preSendFailure = false,
  principal = "user",
  retryPolicy = null,
  fetchImpl = fetch,
  sleepMs = defaultSleep,
  getAccessTokenImpl = getAccessToken,
  buildRetryDecisionImpl = null,
  repoRootPath = repoRoot,
}) {
  const buildRetryDecision =
    buildRetryDecisionImpl ??
    (await loadBuiltRetryHelpers(repoRootPath)).buildRetryDecision;
  const method = (init.method ?? "GET").toUpperCase();
  const {
    idempotent: _ignoredIdempotent,
    preSendFailure: _ignoredPreSendFailure,
    principal: _ignoredPrincipal,
    retryPolicy: _ignoredRetryPolicy,
    ...fetchInit
  } = init;
  const retryDecisions = [];
  let lease = await getAccessTokenImpl({
    oauthClient,
    tokenStorePath,
    scopes,
    forceRefresh: false,
  });
  let refreshed = Boolean(lease.refreshed);
  let replayedAfter401 = false;
  let attempts = 0;

  while (true) {
    attempts += 1;
    let response;

    try {
      response = await fetchImpl(url, {
        ...fetchInit,
        method,
        headers: {
          ...(fetchInit.headers ?? {}),
          authorization: tokenHeader(lease),
        },
      });
    } catch (error) {
      const decision = buildRetryDecision(
        {
          attempt: attempts,
          method,
          status: null,
          networkError: true,
          idempotent,
          preSendFailure,
          principal,
        },
        retryPolicy ?? undefined,
      );
      retryDecisions.push(decision);

      if (decision.action === "retry") {
        await sleepMs(decision.delayMs);
        continue;
      }

      error.retry = {
        attempts,
        refreshed,
        replayedAfter401,
        retryDecisions,
      };
      throw error;
    }

    if (response.ok) {
      return {
        response,
        ok: true,
        status: response.status,
        attempts,
        refreshed,
        replayedAfter401,
        retryDecisions,
      };
    }

    const decision = buildRetryDecision(
      {
        attempt: attempts,
        method,
        status: response.status,
        retryAfter: responseRetryAfter(response),
        idempotent,
        preSendFailure,
        principal,
      },
      retryPolicy ?? undefined,
    );
    retryDecisions.push(decision);

    if (decision.action === "refresh_auth") {
      lease = await getAccessTokenImpl({
        oauthClient,
        tokenStorePath,
        scopes,
        forceRefresh: true,
      });
      refreshed = true;
      replayedAfter401 = true;
      continue;
    }

    if (decision.action === "retry") {
      await sleepMs(decision.delayMs);
      continue;
    }

    return {
      response,
      ok: false,
      status: response.status,
      attempts,
      refreshed,
      replayedAfter401,
      retryDecisions,
    };
  }
}
