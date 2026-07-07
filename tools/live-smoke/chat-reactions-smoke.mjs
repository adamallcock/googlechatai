import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SMOKE_SPACE_PREFIX } from "./chat-smoke.mjs";
import {
  chatRequestWithAppAuth,
  createServiceAccountTokenBroker,
} from "../chat/app-auth-client.mjs";
import {
  chatRequestWithUserAuth,
  readOAuthClientConfig,
  resolveUserAuthConfig,
  USER_AUTH_SCOPES,
  UserAuthRequiredError,
} from "../chat/user-auth-smoke.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultMetadataPath = path.join(
  repoRoot,
  "fixtures/live/chat-smoke-space.local.json",
);
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const defaultCredentialsPath = path.join(
  os.homedir(),
  ".config/googlechatai-sdk/credentials/chat-ai-sdk-service-account.json",
);
const BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const DEFAULT_EMOJI = "\u{1F44D}";

class ChatReactionSmokeError extends Error {
  constructor(operation, status, response) {
    super(`${operation} failed with HTTP ${status}`);
    this.name = "ChatReactionSmokeError";
    this.operation = operation;
    this.status = status;
    this.response = response;
  }
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    listOnly: false,
    metadataPath: null,
    evidencePath: null,
    messageName: null,
    emoji: DEFAULT_EMOJI,
    filter: null,
    pageSize: 25,
    expectMinReactions: null,
    help: false,
  };
  const rest = argv.slice(2);

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--") {
      continue;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--list-only") {
      args.listOnly = true;
    } else if (arg === "--metadata") {
      args.metadataPath = rest[++index];
    } else if (arg.startsWith("--metadata=")) {
      args.metadataPath = arg.slice("--metadata=".length);
    } else if (arg === "--evidence") {
      args.evidencePath = rest[++index];
    } else if (arg.startsWith("--evidence=")) {
      args.evidencePath = arg.slice("--evidence=".length);
    } else if (arg === "--message-name") {
      args.messageName = rest[++index];
    } else if (arg.startsWith("--message-name=")) {
      args.messageName = arg.slice("--message-name=".length);
    } else if (arg === "--emoji") {
      args.emoji = rest[++index];
    } else if (arg.startsWith("--emoji=")) {
      args.emoji = arg.slice("--emoji=".length);
    } else if (arg === "--filter") {
      args.filter = rest[++index];
    } else if (arg.startsWith("--filter=")) {
      args.filter = arg.slice("--filter=".length);
    } else if (arg === "--page-size") {
      args.pageSize = Number(rest[++index]);
    } else if (arg.startsWith("--page-size=")) {
      args.pageSize = Number(arg.slice("--page-size=".length));
    } else if (arg === "--expect-min-reactions") {
      args.expectMinReactions = Number(rest[++index]);
    } else if (arg.startsWith("--expect-min-reactions=")) {
      args.expectMinReactions = Number(arg.slice("--expect-min-reactions=".length));
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

function requireSmokeSpaceName(space) {
  if (!space || !space.startsWith("spaces/")) {
    throw new Error("GOOGLE_CHAT_TEST_SPACE must start with spaces/");
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function requireNonNegativeIntegerOrNull(value, name) {
  if (value !== null && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

function requireSmokeMetadata(metadata, expectedSpace) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Smoke metadata must be a JSON object.");
  }
  requireSmokeSpaceName(metadata.space);

  if (metadata.space !== expectedSpace) {
    throw new Error(
      `Smoke metadata space ${metadata.space} does not match GOOGLE_CHAT_TEST_SPACE ${expectedSpace}`,
    );
  }
  if (
    typeof metadata.displayName !== "string" ||
    !metadata.displayName.startsWith(SMOKE_SPACE_PREFIX)
  ) {
    throw new Error(
      `metadata displayName must start with ${SMOKE_SPACE_PREFIX}`,
    );
  }
  if (metadata.spaceType !== "SPACE") {
    throw new Error("Smoke metadata spaceType must be SPACE.");
  }
  if (metadata.safety?.dedicatedSmokeSpace !== true) {
    throw new Error("Smoke metadata must set safety.dedicatedSmokeSpace=true.");
  }
  if (metadata.safety?.noDirectMessages !== true) {
    throw new Error("Smoke metadata must set safety.noDirectMessages=true.");
  }
  if (metadata.safety?.noRealUsersInvited !== true) {
    throw new Error("Smoke metadata must set safety.noRealUsersInvited=true.");
  }
}

function requireLiveSmokeSpace(space) {
  if (space.name && !space.name.startsWith("spaces/")) {
    throw new Error(`live space name must start with spaces/: ${space.name}`);
  }
  if (space.spaceType !== "SPACE") {
    throw new Error("live space spaceType must be SPACE.");
  }
  if (
    typeof space.displayName !== "string" ||
    !space.displayName.startsWith(SMOKE_SPACE_PREFIX)
  ) {
    throw new Error(
      `live space displayName must start with ${SMOKE_SPACE_PREFIX}`,
    );
  }
}

function makeRunId(env) {
  if (env.GOOGLE_CHAT_REACTIONS_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_REACTIONS_SMOKE_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `reactions-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function clientMessageId(runId, label) {
  const slug = `${runId}-${label}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return `client-${slug || "reactions-smoke"}`;
}

function reactionFilterForEmoji(emoji) {
  return `emoji.unicode = "${String(emoji).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export async function loadReactionsSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_CHAT_REACTIONS_SMOKE !== "1") {
    throw new Error(
      "Refusing to run reactions Chat smoke without RUN_LIVE_CHAT_REACTIONS_SMOKE=1.",
    );
  }

  const space = env.GOOGLE_CHAT_TEST_SPACE?.trim();
  requireSmokeSpaceName(space);
  requirePositiveInteger(args.pageSize, "--page-size");
  requireNonNegativeIntegerOrNull(args.expectMinReactions, "--expect-min-reactions");

  if (args.messageName && !args.messageName.startsWith(`${space}/messages/`)) {
    throw new Error("--message-name must be a message inside GOOGLE_CHAT_TEST_SPACE.");
  }
  if (args.listOnly && !args.messageName) {
    throw new Error("--list-only requires --message-name.");
  }

  const metadataPath = resolvePath(
    args.metadataPath ??
      env.GOOGLE_CHAT_SMOKE_METADATA ??
      defaultMetadataPath,
    cwd,
  );
  let metadata;

  try {
    metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read smoke-space metadata at ${metadataPath}: ${error.message}`,
    );
  }

  requireSmokeMetadata(metadata, space);

  const userAuthConfig = resolveUserAuthConfig(env, {
    credentialsPath: null,
    tokenStorePath: null,
    redirectUri: null,
  });
  const lifecycle = !args.listOnly;
  const runId = makeRunId(env);

  return {
    dryRun: args.dryRun,
    lifecycle,
    space,
    metadata,
    metadataPath,
    runId,
    credentialsPath: userAuthConfig.credentialsPath,
    tokenStorePath: userAuthConfig.tokenStorePath,
    appCredentialsPath:
      env.GOOGLE_APPLICATION_CREDENTIALS ?? defaultCredentialsPath,
    messageName: args.messageName,
    messageText: `${SMOKE_SPACE_PREFIX} reaction smoke ${runId}`,
    emoji: args.emoji,
    filter: args.filter ?? reactionFilterForEmoji(args.emoji),
    pageSize: Math.min(args.pageSize, 200),
    expectMinReactions:
      args.expectMinReactions ?? (lifecycle ? 1 : null),
    userScopes: lifecycle
      ? USER_AUTH_SCOPES.writeReactions
      : USER_AUTH_SCOPES.readReactions,
    liveReactionEnv: {
      GOOGLE_CHAT_AI_ENABLE_LIVE_REACTION_WRITES:
        env.GOOGLE_CHAT_AI_ENABLE_LIVE_REACTION_WRITES,
    },
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_REACTIONS_SMOKE_EVIDENCE,
      cwd,
    ),
  };
}

export function buildReactionsSmokePlan(config) {
  const calls = [];

  if (config.lifecycle) {
    calls.push(
      {
        operation: "spaces.get",
        method: "GET",
        path: `/v1/${config.space}`,
        writes: false,
        authMode: "app",
        requiredScopes: [BOT_SCOPE],
        safetyCheck: "Requires live spaceType=SPACE and smoke displayName prefix.",
      },
      {
        operation: "spaces.messages.create",
        method: "POST",
        path: `/v1/${config.space}/messages`,
        writes: true,
        authMode: "app",
        requiredScopes: [BOT_SCOPE],
        bodyRedacted: true,
        liveGates: [
          "RUN_LIVE_CHAT_REACTIONS_SMOKE=1",
          "GOOGLE_CHAT_AI_ENABLE_LIVE_REACTION_WRITES=1",
        ],
        safetyCheck:
          "Creates only a temporary bot-owned target message in the dedicated smoke space.",
      },
      {
        operation: "spaces.messages.reactions.create",
        method: "POST",
        path: "/v1/{message}/reactions",
        writes: true,
        authMode: "user",
        requiredScopes: config.userScopes,
        bodyFields: ["emoji.unicode"],
        liveGates: [
          "RUN_LIVE_CHAT_REACTIONS_SMOKE=1",
          "GOOGLE_CHAT_AI_ENABLE_LIVE_REACTION_WRITES=1",
        ],
        safetyCheck:
          "Adds a reaction only to the target message created by this smoke run.",
      },
    );
  }

  calls.push(
    {
      operation: "spaces.messages.reactions.list",
      method: "GET",
      path: "/v1/{message}/reactions",
      query: { pageSize: config.pageSize },
      writes: false,
      authMode: "user",
      requiredScopes: config.userScopes,
      safetyCheck: "Reads reactions only from the configured smoke-space message.",
    },
    {
      operation: "spaces.messages.reactions.list.filtered",
      method: "GET",
      path: "/v1/{message}/reactions",
      query: { pageSize: config.pageSize, filter: config.filter },
      writes: false,
      authMode: "user",
      requiredScopes: config.userScopes,
      safetyCheck: "Uses the documented emoji filter on the same target message.",
    },
  );

  if (config.lifecycle) {
    calls.push(
      {
        operation: "spaces.messages.reactions.delete",
        method: "DELETE",
        path: "/v1/{message}/reactions/{reaction}",
        writes: true,
        authMode: "user",
        requiredScopes: config.userScopes,
        liveGates: [
          "RUN_LIVE_CHAT_REACTIONS_SMOKE=1",
          "GOOGLE_CHAT_AI_ENABLE_LIVE_REACTION_WRITES=1",
        ],
        safetyCheck:
          "Deletes only the reaction created by this smoke run.",
      },
      {
        operation: "spaces.messages.reactions.list.after-delete",
        method: "GET",
        path: "/v1/{message}/reactions",
        query: { pageSize: config.pageSize, filter: config.filter },
        writes: false,
        authMode: "user",
        requiredScopes: config.userScopes,
        safetyCheck: "Verifies the smoke-created reaction is gone before cleanup.",
      },
      {
        operation: "spaces.messages.delete",
        method: "DELETE",
        path: "/v1/{message}",
        writes: true,
        authMode: "app",
        requiredScopes: [BOT_SCOPE],
        safetyCheck:
          "Deletes only the temporary bot-owned target message created by this smoke run.",
      },
    );
  }

  return {
    mode: config.dryRun ? "dry-run" : "live",
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    runId: config.runId,
    lifecycle: config.lifecycle,
    messageNameProvided: Boolean(config.messageName),
    emojiHash: stableHash(config.metadata.displayName, config.emoji),
    filterHash: stableHash(config.metadata.displayName, config.filter),
    pageSize: config.pageSize,
    calls,
  };
}

function sanitizeError(error) {
  if (error instanceof UserAuthRequiredError) {
    return {
      name: error.name,
      message: error.message,
      details: error.details,
      authorizeHint:
        "Run `corepack pnpm chat:user-auth-smoke -- --authorize --read-reactions --write-reactions` to grant local user reaction scopes. Do not use domain-wide delegation.",
    };
  }
  if (error instanceof ChatReactionSmokeError) {
    return {
      name: error.name,
      operation: error.operation,
      status: error.status,
      message: error.message,
      apiReason: error.response?.error?.status ?? null,
    };
  }

  return {
    name: error.name ?? "Error",
    message: error.message ?? String(error),
  };
}

async function recordOperation(evidence, operation, fn, summarize = () => ({})) {
  const startedAt = new Date().toISOString();

  try {
    const result = await fn();
    evidence.operations.push({
      operation,
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      ...summarize(result),
    });
    return result;
  } catch (error) {
    evidence.operations.push({
      operation,
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: sanitizeError(error),
    });
    throw error;
  }
}

async function writeEvidenceFile(config, evidence) {
  const evidencePath =
    config.evidencePath ??
    path.join(defaultEvidenceDir, `chat-reactions-smoke-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

async function createAppChatClient(config) {
  const serviceAccount = JSON.parse(
    await fs.readFile(config.appCredentialsPath, "utf8"),
  );
  const scopes = [BOT_SCOPE];
  const getAccessToken = createServiceAccountTokenBroker(serviceAccount, scopes);

  return {
    getSpace: (name) =>
      appChatRequest(serviceAccount, scopes, getAccessToken, name),
    createMessage: (parent, body) =>
      appChatRequest(serviceAccount, scopes, getAccessToken, `${parent}/messages`, {
        method: "POST",
        query: {
          messageId: clientMessageId(config.runId, "reaction-target"),
        },
        body,
        idempotent: true,
      }),
    deleteMessage: (name) =>
      appChatRequest(serviceAccount, scopes, getAccessToken, name, {
        method: "DELETE",
        idempotent: true,
      }),
  };
}

async function appChatRequest(
  serviceAccount,
  scopes,
  getAccessToken,
  resourcePath,
  { method = "GET", query = {}, body = null, idempotent = false } = {},
) {
  const result = await chatRequestWithAppAuth({
    serviceAccount,
    scopes,
    resourcePath,
    query,
    init: {
      method,
      body,
      idempotent,
    },
    getAccessToken,
  });

  if (!result.ok) {
    throw new ChatReactionSmokeError(`${method} /v1/${resourcePath}`, result.status, result.json);
  }

  return result.json;
}

async function createUserReactionClient(config) {
  const oauthClient = readOAuthClientConfig(
    await fs.readFile(resolvePath(config.credentialsPath, process.cwd()), "utf8"),
  );

  function reactionCollectionUrl(parent, query = {}) {
    const url = new URL(`https://chat.googleapis.com/v1/${parent}/reactions`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  return {
    async createReaction(parent, emoji) {
      const result = await chatRequestWithUserAuth({
        oauthClient,
        tokenStorePath: config.tokenStorePath,
        scopes: config.userScopes,
        url: reactionCollectionUrl(parent),
        init: {
          method: "POST",
          body: JSON.stringify({
            emoji: { unicode: emoji },
          }),
        },
      });

      if (!result.ok) {
        throw new ChatReactionSmokeError(
          "spaces.messages.reactions.create",
          result.status,
          result.json,
        );
      }

      return result;
    },

    async listReactions(parent, query = {}) {
      const result = await chatRequestWithUserAuth({
        oauthClient,
        tokenStorePath: config.tokenStorePath,
        scopes: config.userScopes,
        url: reactionCollectionUrl(parent, query),
      });

      if (!result.ok) {
        throw new ChatReactionSmokeError(
          "spaces.messages.reactions.list",
          result.status,
          result.json,
        );
      }

      return result;
    },

    async deleteReaction(name) {
      const result = await chatRequestWithUserAuth({
        oauthClient,
        tokenStorePath: config.tokenStorePath,
        scopes: config.userScopes,
        url: `https://chat.googleapis.com/v1/${name}`,
        init: { method: "DELETE" },
      });

      if (!result.ok) {
        throw new ChatReactionSmokeError(
          "spaces.messages.reactions.delete",
          result.status,
          result.json,
        );
      }

      return result;
    },
  };
}

function stableHash(project, value) {
  return crypto
    .createHash("sha256")
    .update(project)
    .update("\0")
    .update(String(value ?? ""))
    .digest("hex");
}

function summarizeResourceName(config, name) {
  return {
    available: typeof name === "string",
    hash:
      typeof name === "string"
        ? stableHash(config.metadata.displayName, name)
        : null,
  };
}

function summarizeMessage(config, message) {
  return {
    name: summarizeResourceName(config, message?.name),
  };
}

function summarizeSpace(space) {
  return {
    resourceNameAvailable: typeof space.name === "string",
    displayName: space.displayName ?? null,
    spaceType: space.spaceType ?? null,
  };
}

function summarizeEmoji(config, emoji) {
  const unicode = typeof emoji?.unicode === "string" ? emoji.unicode : null;
  const customEmoji = emoji?.customEmoji && typeof emoji.customEmoji === "object"
    ? emoji.customEmoji
    : null;
  return {
    unicodeAvailable: unicode !== null,
    unicodeHash: unicode ? stableHash(config.metadata.displayName, unicode) : null,
    customEmojiUidHash:
      typeof customEmoji?.uid === "string"
        ? stableHash(config.metadata.displayName, customEmoji.uid)
        : null,
  };
}

function summarizeIdentity(config, user) {
  const displayName =
    typeof user?.displayName === "string" ? user.displayName : null;
  const email = typeof user?.email === "string" ? user.email : null;
  return {
    nameAvailable: typeof user?.name === "string",
    displayNameAvailable: displayName !== null,
    displayNameHash: displayName
      ? stableHash(config.metadata.displayName, displayName)
      : null,
    emailAvailable: email !== null,
    emailDomain: email?.includes("@") ? email.split("@").at(-1) : null,
    type: typeof user?.type === "string" ? user.type : null,
  };
}

function summarizeReaction(config, reaction) {
  const parent =
    typeof reaction?.name === "string"
      ? reaction.name.replace(/\/reactions\/[^/]+$/, "")
      : null;
  return {
    name: summarizeResourceName(config, reaction?.name),
    parentMessage: summarizeResourceName(config, parent),
    emoji: summarizeEmoji(config, reaction?.emoji),
    user: summarizeIdentity(config, reaction?.user),
  };
}

function summarizeReactionResponse(config, result) {
  return {
    status: result.status ?? 200,
    token: {
      refreshed: Boolean(result.refreshed),
      replayedAfter401: Boolean(result.replayedAfter401),
    },
    response: summarizeReaction(config, result.json),
  };
}

function summarizeListResult(config, result) {
  return {
    status: result.status ?? 200,
    token: {
      refreshed: Boolean(result.refreshed),
      replayedAfter401: Boolean(result.replayedAfter401),
    },
    response: {
      reactions: Array.isArray(result.json.reactions)
        ? result.json.reactions.length
        : 0,
      nextPageTokenAvailable: typeof result.json.nextPageToken === "string",
      reactionsSummary: (result.json.reactions ?? []).map((reaction) =>
        summarizeReaction(config, reaction),
      ),
    },
  };
}

function summarizeDeleteResult(result) {
  return {
    status: result.status ?? 200,
    token: {
      refreshed: Boolean(result.refreshed),
      replayedAfter401: Boolean(result.replayedAfter401),
    },
  };
}

function reactionNames(result) {
  return (result.json.reactions ?? [])
    .map((reaction) => reaction.name)
    .filter((name) => typeof name === "string");
}

function buildAssertions({
  config,
  createdMessageName,
  createdReactionName,
  listResult,
  filteredListResult,
  afterDeleteListResult,
  reactionDeleted,
  messageDeleted,
}) {
  const listedNames = reactionNames(listResult);
  const filteredNames = reactionNames(filteredListResult);
  const afterDeleteNames = afterDeleteListResult
    ? reactionNames(afterDeleteListResult)
    : [];
  return {
    targetMessageCreated: config.lifecycle ? Boolean(createdMessageName) : null,
    reactionCreated: config.lifecycle ? Boolean(createdReactionName) : null,
    reactionListReturned:
      (listResult.json.reactions ?? []).length >= (config.expectMinReactions ?? 0),
    filteredReactionListReturned:
      (filteredListResult.json.reactions ?? []).length >=
      (config.expectMinReactions ?? 0),
    listSawCreatedReaction:
      config.lifecycle && createdReactionName
        ? listedNames.includes(createdReactionName)
        : null,
    filteredListSawCreatedReaction:
      config.lifecycle && createdReactionName
        ? filteredNames.includes(createdReactionName)
        : null,
    reactionDeleted: config.lifecycle ? reactionDeleted : null,
    afterDeleteCreatedReactionAbsent:
      config.lifecycle && createdReactionName && afterDeleteListResult
        ? !afterDeleteNames.includes(createdReactionName)
        : null,
    messageDeleted: config.lifecycle ? messageDeleted : null,
  };
}

function failedAssertions(assertions) {
  return Object.entries(assertions)
    .filter(([, value]) => value === false)
    .map(([key]) => key);
}

function requireReactionWriteGate(config) {
  if (
    config.lifecycle &&
    config.liveReactionEnv.GOOGLE_CHAT_AI_ENABLE_LIVE_REACTION_WRITES !== "1"
  ) {
    throw new Error(
      "Live reaction create/delete requires GOOGLE_CHAT_AI_ENABLE_LIVE_REACTION_WRITES=1.",
    );
  }
}

export async function runReactionsSmoke(
  config,
  { appClient = null, userClient = null, writeEvidence = true } = {},
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
        plan: buildReactionsSmokePlan(config),
      },
    };
  }

  requireReactionWriteGate(config);

  const app = appClient ?? (config.lifecycle ? await createAppChatClient(config) : null);
  const user = userClient ?? (await createUserReactionClient(config));
  const evidence = {
    ok: false,
    mode: "live",
    runId: config.runId,
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    tokenStorePath: config.tokenStorePath,
    lifecycle: config.lifecycle,
    startedAt: new Date().toISOString(),
    operations: [],
    reactions: {},
    assertions: {},
    failures: [],
    privacy: {
      rawMessageTextSaved: false,
      rawReactionUserEmailsSaved: false,
      rawAccessTokensSaved: false,
      rawReactionNamesSaved: false,
    },
  };
  let createdMessageName = config.messageName;
  let createdReactionName = null;
  let listResult = null;
  let filteredListResult = null;
  let afterDeleteListResult = null;
  let reactionDeleted = false;
  let messageDeleted = false;
  let originalError = null;

  try {
    if (config.lifecycle) {
      const targetSpace = await recordOperation(
        evidence,
        "spaces.get",
        () => app.getSpace(config.space),
        summarizeSpace,
      );
      requireLiveSmokeSpace(targetSpace);

      const message = await recordOperation(
        evidence,
        "spaces.messages.create",
        () => app.createMessage(config.space, { text: config.messageText }),
        (result) => summarizeMessage(config, result),
      );
      createdMessageName = message.name;
      evidence.reactions.targetMessage = summarizeMessage(config, message);

      const createdReaction = await recordOperation(
        evidence,
        "spaces.messages.reactions.create",
        () => user.createReaction(createdMessageName, config.emoji),
        (result) => summarizeReactionResponse(config, result),
      );
      createdReactionName = createdReaction.json.name;
      evidence.reactions.created = summarizeReaction(config, createdReaction.json);
    }

    listResult = await recordOperation(
      evidence,
      "spaces.messages.reactions.list",
      () =>
        user.listReactions(createdMessageName, {
          pageSize: config.pageSize,
        }),
      (result) => summarizeListResult(config, result),
    );
    evidence.reactions.list = summarizeListResult(config, listResult).response;

    filteredListResult = await recordOperation(
      evidence,
      "spaces.messages.reactions.list.filtered",
      () =>
        user.listReactions(createdMessageName, {
          pageSize: config.pageSize,
          filter: config.filter,
        }),
      (result) => summarizeListResult(config, result),
    );
    evidence.reactions.filteredList =
      summarizeListResult(config, filteredListResult).response;
  } catch (error) {
    originalError = error;
  } finally {
    if (createdReactionName) {
      try {
        await recordOperation(
          evidence,
          "spaces.messages.reactions.delete",
          () => user.deleteReaction(createdReactionName),
          summarizeDeleteResult,
        );
        reactionDeleted = true;
        evidence.reactions.deleted = true;
      } catch (cleanupError) {
        originalError ??= cleanupError;
      }

      if (createdMessageName) {
        try {
          afterDeleteListResult = await recordOperation(
            evidence,
            "spaces.messages.reactions.list.after-delete",
            () =>
              user.listReactions(createdMessageName, {
                pageSize: config.pageSize,
                filter: config.filter,
              }),
            (result) => summarizeListResult(config, result),
          );
          evidence.reactions.afterDeleteList =
            summarizeListResult(config, afterDeleteListResult).response;
        } catch (cleanupCheckError) {
          originalError ??= cleanupCheckError;
        }
      }
    }

    if (config.lifecycle && createdMessageName) {
      try {
        await recordOperation(
          evidence,
          "spaces.messages.delete",
          () => app.deleteMessage(createdMessageName),
          () => ({ message: summarizeResourceName(config, createdMessageName) }),
        );
        messageDeleted = true;
        evidence.reactions.targetMessageDeleted = true;
      } catch (cleanupError) {
        originalError ??= cleanupError;
      }
    }
  }

  if (listResult && filteredListResult) {
    evidence.assertions = buildAssertions({
      config,
      createdMessageName,
      createdReactionName,
      listResult,
      filteredListResult,
      afterDeleteListResult,
      reactionDeleted,
      messageDeleted,
    });
    evidence.failures = failedAssertions(evidence.assertions);
    if (evidence.failures.length > 0) {
      originalError ??= new Error(
        `Chat reactions smoke assertions failed: ${evidence.failures.join(", ")}`,
      );
    }
  }

  evidence.finishedAt = new Date().toISOString();
  evidence.ok = originalError === null;

  if (writeEvidence) {
    evidence.evidencePath = await writeEvidenceFile(config, evidence);
  }

  if (originalError) {
    originalError.evidence = evidence;
    throw originalError;
  }

  return { ok: true, evidence };
}

function usage() {
  return `${[
    "Usage: RUN_LIVE_CHAT_REACTIONS_SMOKE=1 GOOGLE_CHAT_TEST_SPACE=spaces/... pnpm live:chat-reactions-smoke",
    "",
    "Required:",
    "  RUN_LIVE_CHAT_REACTIONS_SMOKE=1",
    "  GOOGLE_CHAT_TEST_SPACE=spaces/...",
    "  GOOGLE_CHAT_SMOKE_METADATA=fixtures/live/chat-smoke-space.local.json",
    "  User OAuth token with reaction read/write scopes for lifecycle mode",
    "",
    "Required for reaction create/delete lifecycle mode:",
    "  GOOGLE_CHAT_AI_ENABLE_LIVE_REACTION_WRITES=1",
    "",
    "Authorize missing scopes:",
    "  corepack pnpm chat:user-auth-smoke -- --authorize --read-reactions",
    "  corepack pnpm chat:user-auth-smoke -- --authorize --read-reactions --write-reactions",
    "",
    "Options:",
    "  --dry-run                    Print planned API calls without reads/writes.",
    "  --list-only                  Only list reactions for --message-name; no writes.",
    "  --message-name <name>        Existing smoke-space message for list-only mode.",
    "  --metadata <path>            Smoke-space metadata JSON path.",
    "  --evidence <path>            Evidence JSON output path.",
    "  --emoji <unicode>            Reaction emoji for lifecycle mode. Default: thumbs-up.",
    "  --filter <query>             Optional reactions.list filter. Default filters by emoji.",
    "  --page-size <n>              Reactions page size. Default: 25.",
    "  --expect-min-reactions <n>   Require at least n listed reactions.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = await loadReactionsSmokeConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runReactionsSmoke(config);
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

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
