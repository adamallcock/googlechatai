import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildSmokeSpaceMetadata,
} from "./smoke-metadata.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

export const USER_AUTH_SCOPES = {
  listSpaces: ["https://www.googleapis.com/auth/chat.spaces.readonly"],
  createSpace: [
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/chat.spaces.create",
  ],
  readMessages: [
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/chat.messages.readonly",
  ],
  writeMessages: [
    "https://www.googleapis.com/auth/chat.messages.create",
  ],
  readReactions: [
    "https://www.googleapis.com/auth/chat.messages.reactions.readonly",
  ],
  writeReactions: [
    "https://www.googleapis.com/auth/chat.messages.reactions",
  ],
  readMemberships: [
    "https://www.googleapis.com/auth/chat.memberships.readonly",
  ],
  readCustomEmojis: [
    "https://www.googleapis.com/auth/chat.customemojis.readonly",
  ],
  readState: [
    "https://www.googleapis.com/auth/chat.users.readstate.readonly",
  ],
  writeState: [
    "https://www.googleapis.com/auth/chat.users.readstate",
  ],
  readSpaceSettings: [
    "https://www.googleapis.com/auth/chat.users.spacesettings",
  ],
  readSections: [
    "https://www.googleapis.com/auth/chat.users.sections.readonly",
  ],
  writeSections: [
    "https://www.googleapis.com/auth/chat.users.sections",
  ],
  readDrive: [
    "https://www.googleapis.com/auth/drive.readonly",
  ],
  writeDrive: [
    "https://www.googleapis.com/auth/drive.file",
  ],
};

const DEFAULT_CLIENT_PATH = path.join(
  os.homedir(),
  ".config/googlechatai-sdk/oauth/client_secret.json",
);
const DEFAULT_TOKEN_STORE = ".tokens/google-chat-user-oauth-token.json";
const CALLBACK_PATH = "/oauth2callback";

export class UserAuthRequiredError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "UserAuthRequiredError";
    this.details = details;
  }
}

export function parseUserAuthSmokeArgs(argv) {
  const args = {
    authorize: false,
    createTestSpace: false,
    dryRun: false,
    readMessages: false,
    writeMessages: false,
    readReactions: false,
    writeReactions: false,
    readMemberships: false,
    readCustomEmojis: false,
    readState: false,
    writeState: false,
    readSpaceSettings: false,
    readSections: false,
    writeSections: false,
    readDrive: false,
    writeDrive: false,
    metadataOutputPath: null,
    credentialsPath: null,
    tokenStorePath: null,
    redirectUri: null,
    port: 0,
  };
  const rest = argv.slice(2);

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--") {
      continue;
    }
    if (arg === "--authorize") {
      args.authorize = true;
    } else if (arg === "--create-test-space") {
      args.createTestSpace = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--read-messages") {
      args.readMessages = true;
    } else if (arg === "--write-messages") {
      args.writeMessages = true;
    } else if (arg === "--read-reactions") {
      args.readReactions = true;
    } else if (arg === "--write-reactions") {
      args.writeReactions = true;
    } else if (arg === "--read-memberships") {
      args.readMemberships = true;
    } else if (arg === "--read-custom-emojis") {
      args.readCustomEmojis = true;
    } else if (arg === "--read-state") {
      args.readState = true;
    } else if (arg === "--write-state") {
      args.writeState = true;
    } else if (arg === "--read-space-settings") {
      args.readSpaceSettings = true;
    } else if (arg === "--read-sections") {
      args.readSections = true;
    } else if (arg === "--write-sections") {
      args.writeSections = true;
    } else if (arg === "--read-drive") {
      args.readDrive = true;
    } else if (arg === "--write-drive") {
      args.writeDrive = true;
    } else if (arg === "--metadata-output") {
      args.metadataOutputPath = rest[++index];
    } else if (arg.startsWith("--metadata-output=")) {
      args.metadataOutputPath = arg.slice("--metadata-output=".length);
    } else if (arg === "--credentials") {
      args.credentialsPath = rest[++index];
    } else if (arg.startsWith("--credentials=")) {
      args.credentialsPath = arg.slice("--credentials=".length);
    } else if (arg === "--token-store") {
      args.tokenStorePath = rest[++index];
    } else if (arg.startsWith("--token-store=")) {
      args.tokenStorePath = arg.slice("--token-store=".length);
    } else if (arg === "--redirect-uri") {
      args.redirectUri = rest[++index];
    } else if (arg.startsWith("--redirect-uri=")) {
      args.redirectUri = arg.slice("--redirect-uri=".length);
    } else if (arg === "--port") {
      args.port = Number(rest[++index]);
    } else if (arg.startsWith("--port=")) {
      args.port = Number(arg.slice("--port=".length));
    }
  }

  return args;
}

export function selectUserAuthScopes(args) {
  const scopes = [...(args.createTestSpace
    ? USER_AUTH_SCOPES.createSpace
    : USER_AUTH_SCOPES.listSpaces)];

  if (args.readMessages) {
    scopes.push(...USER_AUTH_SCOPES.readMessages);
  }

  if (args.writeMessages) {
    scopes.push(...USER_AUTH_SCOPES.writeMessages);
  }

  if (args.readReactions) {
    scopes.push(...USER_AUTH_SCOPES.readReactions);
  }

  if (args.writeReactions) {
    scopes.push(...USER_AUTH_SCOPES.writeReactions);
  }

  if (args.readMemberships) {
    scopes.push(...USER_AUTH_SCOPES.readMemberships);
  }

  if (args.readCustomEmojis) {
    scopes.push(...USER_AUTH_SCOPES.readCustomEmojis);
  }

  if (args.readState) {
    scopes.push(...USER_AUTH_SCOPES.readState);
  }

  if (args.writeState) {
    scopes.push(...USER_AUTH_SCOPES.writeState);
  }

  if (args.readSpaceSettings) {
    scopes.push(...USER_AUTH_SCOPES.readSpaceSettings);
  }

  if (args.readSections) {
    scopes.push(...USER_AUTH_SCOPES.readSections);
  }

  if (args.writeSections) {
    scopes.push(...USER_AUTH_SCOPES.writeSections);
  }

  if (args.readDrive) {
    scopes.push(...USER_AUTH_SCOPES.readDrive);
  }

  if (args.writeDrive) {
    scopes.push(...USER_AUTH_SCOPES.writeDrive);
  }

  return [...new Set(scopes)];
}

export function resolveUserAuthConfig(env = process.env, args = {}) {
  const credentialsPath =
    args.credentialsPath ||
    env.GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS ||
    DEFAULT_CLIENT_PATH;
  const tokenStorePath =
    args.tokenStorePath ||
    env.GOOGLE_CHAT_USER_TOKEN_STORE ||
    DEFAULT_TOKEN_STORE;

  return {
    project: env.GOOGLE_CLOUD_PROJECT ?? "chat-ai-sdk",
    credentialsPath,
    tokenStorePath,
    redirectUri: args.redirectUri || env.GOOGLE_CHAT_OAUTH_REDIRECT_URI || null,
  };
}

export function readOAuthClientConfig(raw) {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const client = parsed.installed ?? parsed.web ?? parsed;

  if (!client.client_id) {
    throw new Error("OAuth client credentials must include client_id.");
  }

  return {
    clientId: client.client_id,
    clientSecret: client.client_secret ?? null,
    authUri: client.auth_uri ?? "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUri: client.token_uri ?? "https://oauth2.googleapis.com/token",
    redirectUris: client.redirect_uris ?? [],
  };
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

export function createPkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizationUrl(
  oauthClient,
  { scopes, redirectUri, state, codeChallenge },
) {
  const url = new URL(oauthClient.authUri);
  url.searchParams.set("client_id", oauthClient.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function resolvePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(resolvePath(filePath), "utf8"));
}

async function loadTokenStore(tokenStorePath) {
  try {
    return await readJsonFile(tokenStorePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function saveTokenStore(tokenStorePath, token) {
  const resolved = resolvePath(tokenStorePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  await fs.writeFile(resolved, `${JSON.stringify(token, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(resolved, 0o600);
}

function tokenScopeSet(token) {
  const scopes = token?.scope ?? token?.scopes?.join(" ") ?? "";
  return new Set(scopes.split(/\s+/).filter(Boolean));
}

function tokenCoversScopes(token, scopes) {
  const granted = tokenScopeSet(token);
  return scopes.every((scope) => granted.has(scope));
}

function isFresh(token, now = Date.now()) {
  return (
    typeof token?.accessToken === "string" &&
    typeof token?.expiryDate === "number" &&
    token.expiryDate - now > 60_000
  );
}

async function tokenRequest(oauthClient, body) {
  if (oauthClient.clientSecret) {
    body.set("client_secret", oauthClient.clientSecret);
  }
  const response = await fetch(oauthClient.tokenUri, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `OAuth token request failed: ${response.status} ${JSON.stringify(json)}`,
    );
  }

  return json;
}

async function exchangeCodeForToken(
  oauthClient,
  { code, codeVerifier, redirectUri, scopes },
) {
  const json = await tokenRequest(
    oauthClient,
    new URLSearchParams({
      client_id: oauthClient.clientId,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  );

  const now = Date.now();
  return {
    tokenType: json.token_type ?? "Bearer",
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiryDate: now + Number(json.expires_in ?? 3600) * 1000,
    scope: json.scope ?? scopes.join(" "),
    scopes,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    principal: {
      kind: "user",
      email: null,
    },
  };
}

async function refreshAccessToken(oauthClient, token, scopes) {
  if (!token?.refreshToken) {
    throw new UserAuthRequiredError(
      "No refresh token is available for the requested user-auth scopes.",
      { reason: "missing_refresh_token" },
    );
  }

  const json = await tokenRequest(
    oauthClient,
    new URLSearchParams({
      client_id: oauthClient.clientId,
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
    }),
  );

  const now = Date.now();
  return {
    ...token,
    tokenType: json.token_type ?? token.tokenType ?? "Bearer",
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? token.refreshToken,
    expiryDate: now + Number(json.expires_in ?? 3600) * 1000,
    scope: json.scope ?? token.scope ?? scopes.join(" "),
    scopes: json.scope ? json.scope.split(/\s+/).filter(Boolean) : token.scopes ?? scopes,
    updatedAt: new Date(now).toISOString(),
  };
}

export async function getAccessToken({
  oauthClient,
  tokenStorePath,
  scopes,
  forceRefresh = false,
}) {
  const token = await loadTokenStore(tokenStorePath);

  if (!token || !tokenCoversScopes(token, scopes)) {
    throw new UserAuthRequiredError(
      "User OAuth authorization is required for the requested user-auth scopes.",
      {
        reason: token ? "missing_requested_scopes" : "missing_token",
        scopes,
      },
    );
  }

  if (!forceRefresh && isFresh(token)) {
    return { token, accessToken: token.accessToken, refreshed: false };
  }

  const refreshed = await refreshAccessToken(oauthClient, token, scopes);
  await saveTokenStore(tokenStorePath, refreshed);
  return { token: refreshed, accessToken: refreshed.accessToken, refreshed: true };
}

export async function chatRequestWithUserAuth({
  oauthClient,
  tokenStorePath,
  scopes,
  url,
  init = {},
}) {
  const { requestJsonWithRetry } = await loadBuiltTransportHelpers();
  const result = await requestJsonWithRetry(
    {
      url,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body,
      idempotent: Boolean(init.idempotent),
      principal: "user",
    },
    {
      getAccessToken: async ({ forceRefresh }) => {
        const lease = await getAccessToken({
          oauthClient,
          tokenStorePath,
          scopes,
          forceRefresh,
        });
        return {
          accessToken: lease.accessToken,
          refreshed: lease.refreshed,
        };
      },
    },
  );

  return {
    ...result,
    headers: summarizeResponseHeaders(result.headers),
  };
}

async function loadBuiltTransportHelpers() {
  try {
    return await import(
      pathToFileURL(path.join(repoRoot, "packages/node/dist/index.js"))
    );
  } catch (error) {
    throw new Error(
      `Unable to load built SDK transport helpers. Run \`corepack pnpm build\` first. ${error.message}`,
    );
  }
}

function summarizeResponseHeaders(headers) {
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

function chatSpaceUrl(spaceName) {
  const spaceId = spaceName?.split("/")[1];
  return spaceId ? `https://mail.google.com/chat/u/0/#chat/space/${spaceId}` : null;
}

function buildAuthRequiredResult({ project, operation, scopes, tokenStorePath }) {
  return {
    ok: false,
    project,
    operation,
    principal: "user",
    status: "authRequired",
    scopes,
    tokenStorePath,
    domainWideDelegation: false,
    hint:
      "Run `pnpm chat:user-auth-smoke -- --authorize` with the same operation flags to grant this test user the required user-auth scopes. Do not use domain-wide delegation for this path.",
  };
}

function buildDryRunResult({ project, operation, scopes, tokenStorePath }) {
  return {
    ok: true,
    project,
    operation,
    principal: "user",
    dryRun: true,
    scopes,
    tokenStorePath,
    domainWideDelegation: false,
    plannedCalls:
      operation === "create-test-space-user-auth"
        ? ["oauth.refresh-if-needed", "spaces.create"]
        : ["oauth.refresh-if-needed", "spaces.list"],
  };
}

export function buildUserCreateSpaceRequest(displayName) {
  return {
    spaceType: "SPACE",
    displayName,
  };
}

async function runAuthorize({ project, oauthClient, config, args, scopes }) {
  const state = base64url(crypto.randomBytes(18));
  const pkce = createPkcePair();
  const server = http.createServer();

  const callback = await new Promise((resolve, reject) => {
    server.on("request", async (request, response) => {
      try {
        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        if (requestUrl.pathname !== CALLBACK_PATH) {
          response.writeHead(404, { "content-type": "text/plain" });
          response.end("Not found");
          return;
        }
        if (requestUrl.searchParams.get("state") !== state) {
          throw new Error("OAuth state mismatch.");
        }
        const code = requestUrl.searchParams.get("code");
        if (!code) {
          throw new Error(
            `OAuth callback did not include a code: ${requestUrl.searchParams.get(
              "error",
            )}`,
          );
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          "<!doctype html><title>Google Chat AI SDK</title><p>Authorization captured. You can close this tab.</p>",
        );
        resolve({ code });
      } catch (error) {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("Authorization failed.");
        reject(error);
      } finally {
        server.close();
      }
    });
    server.on("error", reject);
    server.listen(Number.isFinite(args.port) ? args.port : 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const redirectUri =
        config.redirectUri ?? `http://127.0.0.1:${port}${CALLBACK_PATH}`;
      const authorizeUrl = buildAuthorizationUrl(oauthClient, {
        scopes,
        redirectUri,
        state,
        codeChallenge: pkce.challenge,
      });

      server.redirectUri = redirectUri;
      console.error("Open this URL to authorize the local test user:");
      console.error(authorizeUrl);
    });
  });

  const token = await exchangeCodeForToken(oauthClient, {
    code: callback.code,
    codeVerifier: pkce.verifier,
    redirectUri: server.redirectUri,
    scopes,
  });
  await saveTokenStore(config.tokenStorePath, token);

  return {
    ok: true,
    project,
    operation: "authorize-user",
    principal: "user",
    scopes,
    tokenStorePath: config.tokenStorePath,
    refreshTokenStored: Boolean(token.refreshToken),
    domainWideDelegation: false,
  };
}

async function runListSpaces({ project, oauthClient, config, scopes }) {
  const result = await chatRequestWithUserAuth({
    oauthClient,
    tokenStorePath: config.tokenStorePath,
    scopes,
    url: "https://chat.googleapis.com/v1/spaces?pageSize=10",
  });

  return {
    ok: result.ok,
    project,
    operation: "list-spaces-user-auth",
    principal: "user",
    status: result.status,
    token: {
      refreshed: result.refreshed,
      replayedAfter401: result.replayedAfter401,
    },
    response: result.ok
      ? {
          spaces: result.json.spaces?.length ?? 0,
          nextPageToken: result.json.nextPageToken ?? null,
        }
      : result.json,
    hint: result.ok
      ? null
      : "User-auth Chat calls require the installing user to consent to the requested Chat scopes.",
  };
}

async function runCreateTestSpace({ project, oauthClient, config, args, scopes }) {
  const displayName = `Google Chat AI SDK Smoke ${new Date()
    .toISOString()
    .slice(0, 10)}`;
  const result = await chatRequestWithUserAuth({
    oauthClient,
    tokenStorePath: config.tokenStorePath,
    scopes,
    url: "https://chat.googleapis.com/v1/spaces",
    init: {
      method: "POST",
      body: JSON.stringify(buildUserCreateSpaceRequest(displayName)),
    },
  });
  const smokeMetadata = result.ok
    ? {
        ...buildSmokeSpaceMetadata(result.json),
        createdBy: {
          principal: "user",
          note: "Created with per-user OAuth. Google Chat rejects customer ids for user-auth spaces.create. Add/install the Chat app into this smoke space before app-auth bot-message tests.",
        },
      }
    : null;

  if (result.ok && args.metadataOutputPath) {
    const metadataPath = resolvePath(args.metadataOutputPath);
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(
      metadataPath,
      `${JSON.stringify(smokeMetadata, null, 2)}\n`,
      "utf8",
    );
  }

  return {
    ok: result.ok,
    project,
    operation: "create-test-space-user-auth",
    principal: "user",
    displayName,
    status: result.status,
    token: {
      refreshed: result.refreshed,
      replayedAfter401: result.replayedAfter401,
    },
    response: result.json,
    smokeMetadata,
    metadataOutputPath:
      result.ok && args.metadataOutputPath ? args.metadataOutputPath : null,
    chatUrl: result.ok ? chatSpaceUrl(result.json.name) : null,
    nextStep: result.ok
      ? "Open the Chat URL, add/install the Google Chat AI SDK Dev app into this smoke space, set GOOGLE_CHAT_TEST_SPACE to the returned space name, then run the guarded bot-message live smoke."
      : "Authorize the installing user for chat.spaces.create and verify Workspace policy allows user-created named spaces. Do not switch this path to domain-wide delegation.",
  };
}

export async function runUserAuthSmoke(argv = process.argv, env = process.env) {
  const args = parseUserAuthSmokeArgs(argv);
  const config = resolveUserAuthConfig(env, args);
  const scopes = selectUserAuthScopes(args);
  const operation = args.createTestSpace
    ? "create-test-space-user-auth"
    : "list-spaces-user-auth";

  if (args.dryRun) {
    return buildDryRunResult({
      project: config.project,
      operation,
      scopes,
      tokenStorePath: config.tokenStorePath,
    });
  }

  const oauthClient = readOAuthClientConfig(
    await fs.readFile(resolvePath(config.credentialsPath), "utf8"),
  );

  if (args.authorize) {
    return runAuthorize({
      project: config.project,
      oauthClient,
      config,
      args,
      scopes,
    });
  }

  try {
    return args.createTestSpace
      ? await runCreateTestSpace({
          project: config.project,
          oauthClient,
          config,
          args,
          scopes,
        })
      : await runListSpaces({ project: config.project, oauthClient, config, scopes });
  } catch (error) {
    if (error instanceof UserAuthRequiredError) {
      return buildAuthRequiredResult({
        project: config.project,
        operation,
        scopes,
        tokenStorePath: config.tokenStorePath,
      });
    }
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runUserAuthSmoke()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(error.stack ?? String(error));
      process.exit(1);
    });
}
