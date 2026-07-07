import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  chatRequestWithUserAuth,
  readOAuthClientConfig,
  resolveUserAuthConfig,
  USER_AUTH_SCOPES,
  UserAuthRequiredError,
} from "../chat/user-auth-smoke.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const defaultScratchTokenStore = path.join(
  repoRoot,
  ".tokens/google-chat-user-oauth-refresh-smoke-token.json",
);
const LIST_SPACES_SCOPES = USER_AUTH_SCOPES.listSpaces;
const LIST_SPACES_URL = "https://chat.googleapis.com/v1/spaces?pageSize=1";

class UserAuthRefreshSmokeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "UserAuthRefreshSmokeError";
    this.details = details;
  }
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    evidencePath: null,
    sourceTokenStorePath: null,
    scratchTokenStorePath: null,
    help: false,
  };
  const rest = argv.slice(2);

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--") {
      continue;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--evidence") {
      args.evidencePath = rest[++index];
    } else if (arg.startsWith("--evidence=")) {
      args.evidencePath = arg.slice("--evidence=".length);
    } else if (arg === "--source-token-store") {
      args.sourceTokenStorePath = rest[++index];
    } else if (arg.startsWith("--source-token-store=")) {
      args.sourceTokenStorePath = arg.slice("--source-token-store=".length);
    } else if (arg === "--scratch-token-store") {
      args.scratchTokenStorePath = rest[++index];
    } else if (arg.startsWith("--scratch-token-store=")) {
      args.scratchTokenStorePath = arg.slice("--scratch-token-store=".length);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function resolvePath(input, cwd) {
  if (!input) {
    return null;
  }
  return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}

function requireUnderTokensDir(filePath, { allowExternalScratch = false } = {}) {
  if (allowExternalScratch) {
    return;
  }

  const tokensDir = path.join(repoRoot, ".tokens");
  const relative = path.relative(tokensDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Scratch token store must be under ${tokensDir} so it remains gitignored.`,
    );
  }
}

function makeRunId(env) {
  if (env.GOOGLE_CHAT_USER_AUTH_REFRESH_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_USER_AUTH_REFRESH_SMOKE_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `user-auth-refresh-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export async function loadUserAuthRefreshSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
  allowExternalScratch = false,
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_CHAT_USER_AUTH_REFRESH_SMOKE !== "1") {
    throw new Error(
      "Refusing to run user-auth refresh smoke without RUN_LIVE_CHAT_USER_AUTH_REFRESH_SMOKE=1.",
    );
  }

  const userAuthConfig = resolveUserAuthConfig(env, {
    credentialsPath: null,
    tokenStorePath: args.sourceTokenStorePath,
    redirectUri: null,
  });
  const sourceTokenStorePath = resolvePath(userAuthConfig.tokenStorePath, cwd);
  const scratchTokenStorePath = resolvePath(
    args.scratchTokenStorePath ??
      env.GOOGLE_CHAT_USER_AUTH_REFRESH_SMOKE_TOKEN_STORE ??
      defaultScratchTokenStore,
    cwd,
  );
  requireUnderTokensDir(scratchTokenStorePath, { allowExternalScratch });

  if (sourceTokenStorePath === scratchTokenStorePath) {
    throw new Error("Source token store and scratch token store must be different.");
  }

  return {
    dryRun: args.dryRun,
    project: userAuthConfig.project,
    credentialsPath: resolvePath(userAuthConfig.credentialsPath, cwd),
    sourceTokenStorePath,
    scratchTokenStorePath,
    scopes: LIST_SPACES_SCOPES,
    runId: makeRunId(env),
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_USER_AUTH_REFRESH_SMOKE_EVIDENCE,
      cwd,
    ),
  };
}

function tokenScopeSet(token) {
  const scopes = token?.scope ?? token?.scopes?.join(" ") ?? "";
  return new Set(scopes.split(/\s+/).filter(Boolean));
}

function tokenCoversScopes(token, scopes) {
  const granted = tokenScopeSet(token);
  return scopes.every((scope) => granted.has(scope));
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(filePath, 0o600);
}

function validateSourceToken(token, scopes) {
  if (!token || typeof token !== "object" || Array.isArray(token)) {
    throw new UserAuthRequiredError("User OAuth token store is missing or invalid.", {
      reason: "invalid_token_store",
      scopes,
    });
  }
  if (!token.refreshToken) {
    throw new UserAuthRequiredError(
      "User OAuth token store does not contain a refresh token.",
      { reason: "missing_refresh_token", scopes },
    );
  }
  if (!tokenCoversScopes(token, scopes)) {
    throw new UserAuthRequiredError(
      "User OAuth token store is missing the scopes required for refresh smoke.",
      { reason: "missing_requested_scopes", scopes },
    );
  }
}

function summarizeSourceToken(token, scopes) {
  const granted = tokenScopeSet(token);
  return {
    hasRefreshToken: Boolean(token?.refreshToken),
    hasAccessToken: typeof token?.accessToken === "string",
    hasExpiryDate: typeof token?.expiryDate === "number",
    requestedScopesGranted: scopes.every((scope) => granted.has(scope)),
    grantedScopeCount: granted.size,
  };
}

function makeExpiredToken(token) {
  const now = Date.now();
  return {
    ...token,
    accessToken: "expired-user-auth-refresh-smoke-placeholder",
    expiryDate: now - 5 * 60 * 1000,
    updatedAt: new Date(now).toISOString(),
  };
}

function makeStaleToken(token) {
  const now = Date.now();
  return {
    ...token,
    accessToken: "invalid-user-auth-refresh-smoke-bearer",
    expiryDate: now + 60 * 60 * 1000,
    updatedAt: new Date(now).toISOString(),
  };
}

function operationCases() {
  return [
    {
      operation: "expired-token-refresh",
      requestDescription:
        "Scratch token is already expired, so the helper must refresh before the Chat API call.",
      mutate: makeExpiredToken,
      expected: {
        refreshed: true,
        replayedAfter401: false,
      },
    },
    {
      operation: "stale-token-401-replay",
      requestDescription:
        "Scratch token is unexpired but invalid, so the helper must replay once after a Google 401.",
      mutate: makeStaleToken,
      expected: {
        refreshed: true,
        replayedAfter401: true,
      },
    },
  ];
}

function summarizeChatResult(result) {
  return {
    status: result.status,
    token: {
      refreshed: Boolean(result.refreshed),
      replayedAfter401: Boolean(result.replayedAfter401),
    },
    response: result.ok
      ? {
          spaces: result.json.spaces?.length ?? 0,
          nextPageTokenAvailable: typeof result.json.nextPageToken === "string",
        }
      : {
          errorStatus: result.json?.error?.status ?? null,
          errorCode: result.json?.error?.code ?? null,
        },
  };
}

function sanitizeError(error) {
  if (error instanceof UserAuthRequiredError) {
    return {
      name: error.name,
      message: error.message,
      details: error.details,
      authorizeHint:
        "Run `corepack pnpm chat:user-auth-smoke -- --authorize` to refresh the local user token. Do not use domain-wide delegation for this path.",
    };
  }
  if (error instanceof UserAuthRefreshSmokeError) {
    return {
      name: error.name,
      message: error.message,
      details: error.details,
    };
  }

  return {
    name: error.name ?? "Error",
    message: error.message ?? String(error),
  };
}

async function writeEvidenceFile(config, evidence) {
  const evidencePath =
    config.evidencePath ??
    path.join(
      defaultEvidenceDir,
      `chat-user-auth-refresh-smoke-${config.runId}.json`,
    );
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

export function buildUserAuthRefreshSmokePlan(config) {
  return {
    mode: config.dryRun ? "dry-run" : "live",
    project: config.project,
    sourceTokenStorePath: config.sourceTokenStorePath,
    scratchTokenStorePath: config.scratchTokenStorePath,
    runId: config.runId,
    calls: operationCases().map((item) => ({
      operation: item.operation,
      method: "GET",
      path: "/v1/spaces?pageSize=1",
      writes: false,
      authMode: "user",
      requiredScopes: config.scopes,
      expectedTokenBehavior: item.expected,
      safetyCheck: item.requestDescription,
    })),
    privacy: {
      copiesRefreshTokenToIgnoredScratchStore: true,
      removesScratchTokenStoreAfterRun: true,
      rawAccessTokensSaved: false,
      refreshTokensSaved: false,
      rawTokenStoreSaved: false,
      senderEmailsSaved: false,
    },
  };
}

async function runOneOperation({
  config,
  oauthClient,
  sourceToken,
  item,
  requestWithUserAuth,
}) {
  const scratchToken = item.mutate(sourceToken);
  await writeJsonFile(config.scratchTokenStorePath, scratchToken);

  const startedAt = new Date().toISOString();
  const result = await requestWithUserAuth({
    operation: item.operation,
    oauthClient,
    tokenStorePath: config.scratchTokenStorePath,
    scopes: config.scopes,
    url: LIST_SPACES_URL,
  });

  const summary = summarizeChatResult(result);
  const matchesExpected =
    result.ok &&
    Boolean(result.refreshed) === item.expected.refreshed &&
    Boolean(result.replayedAfter401) === item.expected.replayedAfter401;

  if (!result.ok || !matchesExpected) {
    throw new UserAuthRefreshSmokeError(
      `User-auth refresh smoke operation failed: ${item.operation}`,
      {
        operation: item.operation,
        expected: item.expected,
        observed: summary,
      },
    );
  }

  return {
    operation: item.operation,
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    expected: item.expected,
    ...summary,
  };
}

export async function runUserAuthRefreshSmoke(
  config,
  {
    requestWithUserAuth = chatRequestWithUserAuth,
    writeEvidence = true,
  } = {},
) {
  if (config.help) {
    return { ok: true, evidence: { help: true } };
  }

  if (config.dryRun) {
    return {
      ok: true,
      evidence: {
        ok: true,
        mode: "dry-run",
        plan: buildUserAuthRefreshSmokePlan(config),
      },
    };
  }

  const evidence = {
    ok: false,
    mode: "live",
    runId: config.runId,
    project: config.project,
    sourceTokenStorePath: config.sourceTokenStorePath,
    scratchTokenStorePath: config.scratchTokenStorePath,
    startedAt: new Date().toISOString(),
    operations: [],
    assertions: {},
    privacy: {
      rawAccessTokensSaved: false,
      refreshTokensSaved: false,
      rawTokenStoreSaved: false,
      senderEmailsSaved: false,
      chatMessagesSaved: false,
    },
  };
  let originalError = null;

  try {
    const sourceToken = await readJsonFile(config.sourceTokenStorePath);
    validateSourceToken(sourceToken, config.scopes);
    evidence.sourceToken = summarizeSourceToken(sourceToken, config.scopes);

    const oauthClient = readOAuthClientConfig(
      await fs.readFile(config.credentialsPath, "utf8"),
    );

    for (const item of operationCases()) {
      const operation = await runOneOperation({
        config,
        oauthClient,
        sourceToken,
        item,
        requestWithUserAuth,
      });
      evidence.operations.push(operation);
    }

    evidence.assertions = {
      expiredTokenRefreshedBeforeCall:
        evidence.operations.find(
          (item) => item.operation === "expired-token-refresh",
        )?.token.refreshed === true,
      expiredTokenDidNotReplayAfter401:
        evidence.operations.find(
          (item) => item.operation === "expired-token-refresh",
        )?.token.replayedAfter401 === false,
      staleTokenRefreshedAfter401:
        evidence.operations.find(
          (item) => item.operation === "stale-token-401-replay",
        )?.token.refreshed === true,
      staleTokenReplayedAfter401:
        evidence.operations.find(
          (item) => item.operation === "stale-token-401-replay",
        )?.token.replayedAfter401 === true,
    };
  } catch (error) {
    originalError = error;
    evidence.error = sanitizeError(error);
  } finally {
    await fs.rm(config.scratchTokenStorePath, { force: true });
    evidence.scratchTokenStoreRemoved = true;
    evidence.finishedAt = new Date().toISOString();
    evidence.ok =
      originalError === null &&
      Object.values(evidence.assertions).every((value) => value === true);

    if (writeEvidence) {
      evidence.evidencePath = await writeEvidenceFile(config, evidence);
    }
  }

  if (originalError) {
    originalError.evidence = evidence;
    throw originalError;
  }

  return { ok: true, evidence };
}

function usage() {
  return `${[
    "Usage: RUN_LIVE_CHAT_USER_AUTH_REFRESH_SMOKE=1 pnpm live:chat-user-auth-refresh-smoke",
    "",
    "This read-only smoke copies the local user OAuth token into an ignored scratch",
    "token store, forces one expired-token refresh path and one stale-token 401",
    "replay path, then removes the scratch token store.",
    "",
    "Options:",
    "  --dry-run                    Print the planned read-only Chat API calls.",
    "  --source-token-store <path>   Source user token store. Defaults to GOOGLE_CHAT_USER_TOKEN_STORE or .tokens/google-chat-user-oauth-token.json.",
    "  --scratch-token-store <path>  Scratch token copy. Must stay under repo .tokens/.",
    "  --evidence <path>            Evidence JSON output path.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = await loadUserAuthRefreshSmokeConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runUserAuthRefreshSmoke(config);
    console.log(JSON.stringify(result.evidence, null, 2));
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: sanitizeError(error),
          evidence: error.evidence ?? null,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
