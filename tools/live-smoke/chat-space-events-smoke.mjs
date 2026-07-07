import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SMOKE_SPACE_PREFIX } from "./chat-smoke.mjs";
import {
  chatRequestWithUserAuth,
  readOAuthClientConfig,
  resolveUserAuthConfig,
  UserAuthRequiredError,
} from "../chat/user-auth-smoke.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultMetadataPath = path.join(
  repoRoot,
  "fixtures/live/chat-smoke-space.local.json",
);
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");

const DEFAULT_EVENT_TYPES = [
  "google.workspace.chat.message.v1.created",
  "google.workspace.chat.message.v1.updated",
  "google.workspace.chat.message.v1.deleted",
  "google.workspace.chat.reaction.v1.created",
  "google.workspace.chat.reaction.v1.deleted",
];

const SPACE_EVENT_SCOPES = {
  messages: "https://www.googleapis.com/auth/chat.messages.readonly",
  reactions: "https://www.googleapis.com/auth/chat.messages.reactions.readonly",
  memberships: "https://www.googleapis.com/auth/chat.memberships.readonly",
  spaces: "https://www.googleapis.com/auth/chat.spaces.readonly",
};

class ChatSpaceEventsReadError extends Error {
  constructor(operation, status, response, details = {}) {
    super(`${operation} failed with HTTP ${status}`);
    this.name = "ChatSpaceEventsReadError";
    this.operation = operation;
    this.status = status;
    this.response = response;
    this.responseHeaders = details.responseHeaders ?? {};
    this.attempts = details.attempts ?? null;
  }
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    metadataPath: null,
    evidencePath: null,
    limit: 10,
    pageSize: 5,
    startTime: null,
    endTime: null,
    eventTypes: [],
    expectedEventTypes: [],
    expectMinEvents: null,
    expectMessageCreated: null,
    expectReactionCreated: null,
    expectReactionDeleted: null,
    maxAttempts: 3,
    retryDelayMs: 1000,
    allowBlocked: false,
    help: false,
  };
  const rest = argv.slice(2);

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--") {
      continue;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--metadata") {
      args.metadataPath = rest[++index];
    } else if (arg.startsWith("--metadata=")) {
      args.metadataPath = arg.slice("--metadata=".length);
    } else if (arg === "--evidence") {
      args.evidencePath = rest[++index];
    } else if (arg.startsWith("--evidence=")) {
      args.evidencePath = arg.slice("--evidence=".length);
    } else if (arg === "--limit") {
      args.limit = Number(rest[++index]);
    } else if (arg.startsWith("--limit=")) {
      args.limit = Number(arg.slice("--limit=".length));
    } else if (arg === "--page-size") {
      args.pageSize = Number(rest[++index]);
    } else if (arg.startsWith("--page-size=")) {
      args.pageSize = Number(arg.slice("--page-size=".length));
    } else if (arg === "--start-time") {
      args.startTime = rest[++index];
    } else if (arg.startsWith("--start-time=")) {
      args.startTime = arg.slice("--start-time=".length);
    } else if (arg === "--end-time") {
      args.endTime = rest[++index];
    } else if (arg.startsWith("--end-time=")) {
      args.endTime = arg.slice("--end-time=".length);
    } else if (arg === "--event-type") {
      args.eventTypes.push(rest[++index]);
    } else if (arg.startsWith("--event-type=")) {
      args.eventTypes.push(arg.slice("--event-type=".length));
    } else if (arg === "--expect-event-type") {
      args.expectedEventTypes.push(rest[++index]);
    } else if (arg.startsWith("--expect-event-type=")) {
      args.expectedEventTypes.push(arg.slice("--expect-event-type=".length));
    } else if (arg === "--expect-min-events") {
      args.expectMinEvents = Number(rest[++index]);
    } else if (arg.startsWith("--expect-min-events=")) {
      args.expectMinEvents = Number(arg.slice("--expect-min-events=".length));
    } else if (arg === "--expect-message-created") {
      args.expectMessageCreated = Number(rest[++index]);
    } else if (arg.startsWith("--expect-message-created=")) {
      args.expectMessageCreated = Number(arg.slice("--expect-message-created=".length));
    } else if (arg === "--expect-reaction-created") {
      args.expectReactionCreated = Number(rest[++index]);
    } else if (arg.startsWith("--expect-reaction-created=")) {
      args.expectReactionCreated = Number(arg.slice("--expect-reaction-created=".length));
    } else if (arg === "--expect-reaction-deleted") {
      args.expectReactionDeleted = Number(rest[++index]);
    } else if (arg.startsWith("--expect-reaction-deleted=")) {
      args.expectReactionDeleted = Number(arg.slice("--expect-reaction-deleted=".length));
    } else if (arg === "--max-attempts") {
      args.maxAttempts = Number(rest[++index]);
    } else if (arg.startsWith("--max-attempts=")) {
      args.maxAttempts = Number(arg.slice("--max-attempts=".length));
    } else if (arg === "--retry-delay-ms") {
      args.retryDelayMs = Number(rest[++index]);
    } else if (arg.startsWith("--retry-delay-ms=")) {
      args.retryDelayMs = Number(arg.slice("--retry-delay-ms=".length));
    } else if (arg === "--allow-blocked") {
      args.allowBlocked = true;
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

function makeRunId(env) {
  if (env.GOOGLE_CHAT_SPACE_EVENTS_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_SPACE_EVENTS_SMOKE_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `space-events-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function defaultStartTime(env) {
  if (env.GOOGLE_CHAT_SPACE_EVENTS_START_TIME) {
    return env.GOOGLE_CHAT_SPACE_EVENTS_START_TIME;
  }
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function defaultEndTime(env) {
  if (env.GOOGLE_CHAT_SPACE_EVENTS_END_TIME) {
    return env.GOOGLE_CHAT_SPACE_EVENTS_END_TIME;
  }
  return new Date(Date.now() + 5 * 60 * 1000).toISOString();
}

function normalizeEventTypes(values) {
  const selected = values.length > 0 ? values : DEFAULT_EVENT_TYPES;
  const eventTypes = [...new Set(selected.map((value) => String(value).trim()))]
    .filter(Boolean);

  if (eventTypes.length === 0) {
    throw new Error("At least one --event-type is required.");
  }

  for (const eventType of eventTypes) {
    if (!eventType.startsWith("google.workspace.chat.")) {
      throw new Error(`Unsupported Chat SpaceEvent type: ${eventType}`);
    }
  }

  return eventTypes;
}

function normalizeExpectedEventTypes(values) {
  const eventTypes = [...new Set(values.map((value) => String(value).trim()))]
    .filter(Boolean);

  for (const eventType of eventTypes) {
    if (!eventType.startsWith("google.workspace.chat.")) {
      throw new Error(`Unsupported expected Chat SpaceEvent type: ${eventType}`);
    }
  }

  return eventTypes;
}

function requiredScopesForEventTypes(eventTypes) {
  const scopes = [];

  for (const eventType of eventTypes) {
    if (eventType.includes(".message.")) {
      scopes.push(SPACE_EVENT_SCOPES.messages);
    } else if (eventType.includes(".reaction.")) {
      scopes.push(SPACE_EVENT_SCOPES.reactions);
    } else if (eventType.includes(".membership.")) {
      scopes.push(SPACE_EVENT_SCOPES.memberships);
    } else if (eventType.includes(".space.")) {
      scopes.push(SPACE_EVENT_SCOPES.spaces);
    } else {
      throw new Error(`No user-auth scope mapping for event type ${eventType}`);
    }
  }

  return [...new Set(scopes)];
}

export async function loadSpaceEventsSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_CHAT_SPACE_EVENTS_SMOKE !== "1") {
    throw new Error(
      "Refusing to run SpaceEvents Chat smoke without RUN_LIVE_CHAT_SPACE_EVENTS_SMOKE=1.",
    );
  }

  const space = env.GOOGLE_CHAT_TEST_SPACE?.trim();
  requireSmokeSpaceName(space);
  requirePositiveInteger(args.limit, "--limit");
  requirePositiveInteger(args.pageSize, "--page-size");
  requirePositiveInteger(args.maxAttempts, "--max-attempts");
  requireNonNegativeIntegerOrNull(args.expectMinEvents, "--expect-min-events");
  requireNonNegativeIntegerOrNull(args.expectMessageCreated, "--expect-message-created");
  requireNonNegativeIntegerOrNull(args.expectReactionCreated, "--expect-reaction-created");
  requireNonNegativeIntegerOrNull(args.expectReactionDeleted, "--expect-reaction-deleted");
  if (!Number.isInteger(args.retryDelayMs) || args.retryDelayMs < 0) {
    throw new Error("--retry-delay-ms must be a non-negative integer.");
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

  const eventTypes = normalizeEventTypes(args.eventTypes);
  const scopes = requiredScopesForEventTypes(eventTypes);
  const userAuthConfig = resolveUserAuthConfig(env, {
    credentialsPath: null,
    tokenStorePath: null,
    redirectUri: null,
  });

  return {
    dryRun: args.dryRun,
    project: env.GOOGLE_CLOUD_PROJECT ?? "chat-ai-sdk",
    space,
    metadata,
    metadataPath,
    runId: makeRunId(env),
    credentialsPath: userAuthConfig.credentialsPath,
    tokenStorePath: userAuthConfig.tokenStorePath,
    limit: args.limit,
    pageSize: Math.min(args.pageSize, args.limit),
    startTime: args.startTime ?? defaultStartTime(env),
    endTime: args.endTime ?? defaultEndTime(env),
    eventTypes,
    scopes,
    retry: {
      maxAttempts: args.maxAttempts,
      retryDelayMs: args.retryDelayMs,
      allowBlocked: args.allowBlocked,
      retryableStatuses: [429, 500, 502, 503, 504],
    },
    expectations: {
      eventTypes: normalizeExpectedEventTypes(args.expectedEventTypes),
      minEvents: args.expectMinEvents,
      messageCreated: args.expectMessageCreated,
      reactionCreated: args.expectReactionCreated,
      reactionDeleted: args.expectReactionDeleted,
    },
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_SPACE_EVENTS_SMOKE_EVIDENCE,
      cwd,
    ),
  };
}

function buildFilter(config) {
  const eventTypeClauses = config.eventTypes.map(
    (eventType) => `eventTypes:"${eventType}"`,
  );
  const eventFilter =
    eventTypeClauses.length === 1
      ? eventTypeClauses[0]
      : `(${eventTypeClauses.join(" OR ")})`;

  return [
    eventFilter,
    `startTime="${config.startTime}"`,
    `endTime="${config.endTime}"`,
  ].join(" AND ");
}

export function buildSpaceEventsSmokePlan(config) {
  const query = {
    pageSize: config.pageSize,
    filter: buildFilter(config),
  };

  return {
    mode: config.dryRun ? "dry-run" : "live",
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    runId: config.runId,
    retry: config.retry,
    calls: [
      {
        operation: "spaceEvents.list",
        method: "GET",
        path: `/v1/${config.space}/spaceEvents`,
        query,
        writes: false,
        authMode: "user",
        requiredScopes: config.scopes,
        safetyCheck: "Read-only; requires dedicated smoke space metadata.",
      },
    ],
    expectations: config.expectations,
  };
}

function sanitizeError(error) {
  if (error instanceof UserAuthRequiredError) {
    return {
      name: error.name,
      message: error.message,
      details: error.details,
      authorizeHint:
        "Run `corepack pnpm chat:user-auth-smoke -- --authorize --read-messages --read-reactions --read-memberships` to grant local user SpaceEvent read scopes. Do not use domain-wide delegation.",
    };
  }
  if (error instanceof ChatSpaceEventsReadError) {
    return {
      name: error.name,
      operation: error.operation,
      status: error.status,
      message: error.message,
      apiReason: error.response?.error?.status ?? null,
      responseHeaders: error.responseHeaders,
      attempts: Array.isArray(error.attempts) ? error.attempts : undefined,
    };
  }
  if (Number.isInteger(error.status)) {
    return {
      name: error.name ?? "Error",
      operation: error.operation ?? null,
      status: error.status,
      message: error.message ?? String(error),
      apiReason: error.response?.error?.status ?? null,
      responseHeaders: error.responseHeaders ?? {},
      attempts: Array.isArray(error.attempts) ? error.attempts : undefined,
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
    path.join(defaultEvidenceDir, `chat-space-events-smoke-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

async function createUserAuthChatClient(config) {
  const oauthClient = readOAuthClientConfig(
    await fs.readFile(resolvePath(config.credentialsPath, process.cwd()), "utf8"),
  );

  return {
    async listSpaceEvents(query) {
      const url = new URL(`https://chat.googleapis.com/v1/${config.space}/spaceEvents`);

      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }

      const result = await chatRequestWithUserAuth({
        oauthClient,
        tokenStorePath: config.tokenStorePath,
        scopes: config.scopes,
        url: url.toString(),
      });

      if (!result.ok) {
        throw new ChatSpaceEventsReadError(
          "spaces.spaceEvents.list",
          result.status,
          result.json,
          { responseHeaders: result.headers ?? {} },
        );
      }

      return result;
    },
  };
}

function summarizeListResult(result) {
  return {
    status: result.status,
    token: {
      refreshed: Boolean(result.refreshed),
      replayedAfter401: Boolean(result.replayedAfter401),
    },
    response: {
      spaceEvents: Array.isArray(result.json.spaceEvents)
        ? result.json.spaceEvents.length
        : 0,
      nextPageTokenAvailable: typeof result.json.nextPageToken === "string",
    },
    responseHeaders: result.headers ?? {},
  };
}

function summarizeAttemptError(error) {
  return {
    name: error.name ?? "Error",
    status: Number.isInteger(error.status) ? error.status : null,
    apiReason: error.response?.error?.status ?? null,
    responseHeaders: error.responseHeaders ?? {},
  };
}

function isRetryableStatus(status, retryableStatuses) {
  return retryableStatuses.includes(status);
}

function isRetryableSpaceEventsError(error, config) {
  return isRetryableStatus(error.status, config.retry.retryableStatuses);
}

function isGoogleInternalBlocker(error) {
  return (
    error.status === 500 &&
    error.response?.error?.status === "INTERNAL"
  );
}

function retryDelayForAttempt(config, attempt) {
  return config.retry.retryDelayMs * attempt;
}

async function defaultSleep(ms) {
  if (ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

async function listSpaceEventsWithRetry({
  config,
  client,
  query,
  sleep = defaultSleep,
}) {
  const attempts = [];

  for (let attempt = 1; attempt <= config.retry.maxAttempts; attempt += 1) {
    try {
      const result = await client.listSpaceEvents(query);
      attempts.push({
        attempt,
        ok: true,
        status: result.status,
        token: {
          refreshed: Boolean(result.refreshed),
          replayedAfter401: Boolean(result.replayedAfter401),
        },
        responseHeaders: result.headers ?? {},
      });
      return { result, attempts };
    } catch (error) {
      const retryable = isRetryableSpaceEventsError(error, config);
      const willRetry = retryable && attempt < config.retry.maxAttempts;
      attempts.push({
        attempt,
        ok: false,
        retryable,
        willRetry,
        delayMsBeforeNextAttempt: willRetry
          ? retryDelayForAttempt(config, attempt)
          : null,
        error: summarizeAttemptError(error),
      });

      if (!willRetry) {
        error.attempts = attempts;
        throw error;
      }

      await sleep(retryDelayForAttempt(config, attempt));
    }
  }

  throw new Error("Unreachable SpaceEvents retry state.");
}

function summarizeRetriedListResult(value) {
  return {
    ...summarizeListResult(value.result),
    attempts: value.attempts,
  };
}

function queryWithPageToken(query, pageToken, pageSize) {
  return {
    ...query,
    pageSize,
    ...(pageToken ? { pageToken } : {}),
  };
}

function stableHash(project, value) {
  return crypto
    .createHash("sha256")
    .update(project)
    .update("\0")
    .update(value)
    .digest("hex");
}

function summarizeText(project, value) {
  const text = typeof value === "string" ? value : "";
  return {
    length: text.length,
    sha256: text ? stableHash(project, text) : null,
  };
}

function summarizeResourceName(project, value) {
  return typeof value === "string" ? stableHash(project, value) : null;
}

function summarizeIdentity(project, value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    nameHash: summarizeResourceName(project, value.name),
    type: value.type ?? null,
    displayNameAvailable: typeof value.displayName === "string",
    emailAvailable: typeof value.email === "string",
  };
}

function summarizeMessage(project, message) {
  if (!message || typeof message !== "object") {
    return null;
  }

  return {
    nameHash: summarizeResourceName(project, message.name),
    createTime: message.createTime ?? null,
    lastUpdateTime: message.lastUpdateTime ?? null,
    deleteTime: message.deleteTime ?? null,
    threadNameHash: summarizeResourceName(project, message.thread?.name),
    sender: summarizeIdentity(project, message.sender),
    text: summarizeText(project, message.text),
    formattedText: summarizeText(project, message.formattedText),
    annotations: Array.isArray(message.annotations) ? message.annotations.length : 0,
    attachments: Array.isArray(message.attachment) ? message.attachment.length : 0,
    cards: Array.isArray(message.cardsV2) ? message.cardsV2.length : 0,
    reactionSummaries: Array.isArray(message.emojiReactionSummaries)
      ? message.emojiReactionSummaries.length
      : 0,
  };
}

function summarizeEmoji(emoji) {
  if (!emoji || typeof emoji !== "object") {
    return null;
  }

  return {
    type: emoji.type ?? null,
    unicodeAvailable: typeof emoji.unicode === "string",
    customEmojiAvailable: Boolean(emoji.customEmoji),
  };
}

function summarizeReaction(project, reaction) {
  if (!reaction || typeof reaction !== "object") {
    return null;
  }

  const messageName =
    typeof reaction.name === "string"
      ? reaction.name.replace(/\/reactions\/[^/]+$/, "")
      : null;

  return {
    nameHash: summarizeResourceName(project, reaction.name),
    messageNameHash: summarizeResourceName(project, messageName),
    emoji: summarizeEmoji(reaction.emoji),
    user: summarizeIdentity(project, reaction.user),
  };
}

function summarizeMembership(project, membership) {
  if (!membership || typeof membership !== "object") {
    return null;
  }

  return {
    nameHash: summarizeResourceName(project, membership.name),
    state: membership.state ?? null,
    role: membership.role ?? null,
    createTime: membership.createTime ?? null,
    deleteTime: membership.deleteTime ?? null,
    member: summarizeIdentity(project, membership.member),
  };
}

function summarizeSpace(project, space) {
  if (!space || typeof space !== "object") {
    return null;
  }

  return {
    nameHash: summarizeResourceName(project, space.name),
    spaceType: space.spaceType ?? null,
    displayNameAvailable: typeof space.displayName === "string",
  };
}

function summarizePayload(project, payload) {
  const message = summarizeMessage(project, payload?.message);
  const reaction = summarizeReaction(project, payload?.reaction);
  const membership = summarizeMembership(project, payload?.membership);
  const space = summarizeSpace(project, payload?.space);

  return {
    resource:
      (message && "message") ||
      (reaction && "reaction") ||
      (membership && "membership") ||
      (space && "space") ||
      "unknown",
    message,
    reaction,
    membership,
    space,
    batchMessages: Array.isArray(payload?.messages) ? payload.messages.length : 0,
    batchReactions: Array.isArray(payload?.reactions) ? payload.reactions.length : 0,
    batchMemberships: Array.isArray(payload?.memberships)
      ? payload.memberships.length
      : 0,
  };
}

function summarizeSpaceEvent(config, event) {
  return {
    nameHash: summarizeResourceName(config.project, event.name),
    eventTime: event.eventTime ?? null,
    eventType: event.eventType ?? null,
    payload: summarizePayload(config.project, event.payload ?? {}),
  };
}

function countBy(items, keyFn) {
  const output = {};
  for (const item of items) {
    const key = keyFn(item) ?? "unknown";
    output[key] = (output[key] ?? 0) + 1;
  }
  return output;
}

function exactExpectation(actual, expected) {
  return expected === null ? null : actual === expected;
}

function buildAssertions(config, events) {
  const countsByEventType = countBy(events, (event) => event.eventType);
  const reactionCreated =
    countsByEventType["google.workspace.chat.reaction.v1.created"] ?? 0;
  const reactionDeleted =
    countsByEventType["google.workspace.chat.reaction.v1.deleted"] ?? 0;
  const messageCreated =
    countsByEventType["google.workspace.chat.message.v1.created"] ?? 0;
  const expectedTypesPresent = config.expectations.eventTypes.every(
    (eventType) => (countsByEventType[eventType] ?? 0) > 0,
  );

  return {
    eventCount: events.length,
    countsByEventType,
    expectedMinEventsMatches:
      config.expectations.minEvents === null
        ? null
        : events.length >= config.expectations.minEvents,
    expectedEventTypesPresent:
      config.expectations.eventTypes.length === 0 ? null : expectedTypesPresent,
    expectedMessageCreatedMatches: exactExpectation(
      messageCreated,
      config.expectations.messageCreated,
    ),
    expectedReactionCreatedMatches: exactExpectation(
      reactionCreated,
      config.expectations.reactionCreated,
    ),
    expectedReactionDeletedMatches: exactExpectation(
      reactionDeleted,
      config.expectations.reactionDeleted,
    ),
    redaction: {
      rawMessageTextSaved: false,
      rawFormattedTextSaved: false,
      rawSenderEmailsSaved: false,
      rawResourceNamesSaved: false,
      rawAccessTokensSaved: false,
    },
  };
}

function failedAssertions(assertions) {
  return Object.entries(assertions)
    .filter(([, value]) => value === false)
    .map(([key]) => key);
}

export async function runSpaceEventsSmoke(
  config,
  { client = null, writeEvidence = true, sleep = defaultSleep } = {},
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
        plan: buildSpaceEventsSmokePlan(config),
      },
    };
  }

  const chatClient = client ?? await createUserAuthChatClient(config);
  const baseQuery = buildSpaceEventsSmokePlan(config).calls[0].query;
  const evidence = {
    ok: false,
    mode: "live",
    runId: config.runId,
    project: config.project,
    targetSpaceHash: summarizeResourceName(config.project, config.space),
    metadataPath: config.metadataPath,
    startTime: config.startTime,
    endTime: config.endTime,
    eventTypes: config.eventTypes,
    scopes: config.scopes,
    retry: config.retry,
    status: "running",
    operations: [],
    rawApi: {
      pages: 0,
      nextPageTokenAvailable: false,
    },
    events: [],
    assertions: null,
    failures: [],
    privacy: {
      rawApiResponsesSaved: false,
      rawMessageTextSaved: false,
      rawSenderEmailsSaved: false,
      rawAccessTokensSaved: false,
      rawResourceNamesSaved: false,
    },
  };
  let pageToken = null;

  try {
    while (evidence.events.length < config.limit) {
      const remaining = config.limit - evidence.events.length;
      const query = queryWithPageToken(
        baseQuery,
        pageToken,
        Math.min(config.pageSize, remaining),
      );
      const result = await recordOperation(
        evidence,
        `spaceEvents.list.${evidence.rawApi.pages + 1}`,
        () =>
          listSpaceEventsWithRetry({
            config,
            client: chatClient,
            query,
            sleep,
          }),
        summarizeRetriedListResult,
      );
      const apiResult = result.result;
      evidence.rawApi.pages += 1;

      for (const event of apiResult.json.spaceEvents ?? []) {
        if (evidence.events.length >= config.limit) {
          break;
        }
        evidence.events.push(summarizeSpaceEvent(config, event));
      }

      pageToken = apiResult.json.nextPageToken ?? null;
      evidence.rawApi.nextPageTokenAvailable = typeof pageToken === "string";

      if (!pageToken) {
        break;
      }
    }
  } catch (error) {
    evidence.finishedAt = new Date().toISOString();
    const blocked = config.retry.allowBlocked && isGoogleInternalBlocker(error);
    evidence.ok = blocked;
    evidence.status = blocked ? "blocked" : "failed";
    evidence.failures = blocked ? [] : ["spaceEvents.list"];
    evidence.blocked = blocked
      ? {
          reason: "google_internal_error",
          operation: error.operation,
          status: error.status,
          apiReason: error.response?.error?.status ?? null,
          attempts: Array.isArray(error.attempts) ? error.attempts : [],
          note:
            "Google Chat SpaceEvents returned HTTP 500 INTERNAL after configured retry attempts. The harness reached Google with user auth; this is recorded as a live-environment blocker.",
        }
      : null;
    if (writeEvidence) {
      evidence.evidencePath = await writeEvidenceFile(config, evidence);
    }
    if (blocked) {
      return { ok: true, evidence };
    }
    error.evidence = evidence;
    throw error;
  }

  const assertions = buildAssertions(config, evidence.events);
  const failures = failedAssertions(assertions);
  evidence.assertions = assertions;
  evidence.failures = failures;
  evidence.ok = failures.length === 0;
  evidence.status = evidence.ok ? "verified" : "failed";

  if (writeEvidence) {
    evidence.evidencePath = await writeEvidenceFile(config, evidence);
  }

  if (failures.length > 0) {
    const error = new Error(
      `Chat SpaceEvents smoke assertions failed: ${failures.join(", ")}`,
    );
    error.evidence = evidence;
    throw error;
  }

  return { ok: true, evidence };
}

function usage() {
  return `${[
    "Usage: RUN_LIVE_CHAT_SPACE_EVENTS_SMOKE=1 GOOGLE_CHAT_TEST_SPACE=spaces/... pnpm live:chat-space-events-smoke",
    "",
    "Before reaction/event reads, authorize user scopes as needed:",
    "  corepack pnpm chat:user-auth-smoke -- --authorize --read-messages --read-reactions --read-memberships",
    "",
    "Options:",
    "  --dry-run                         Print the read-only plan without calling Chat.",
    "  --metadata <path>                  Smoke-space metadata JSON.",
    "  --evidence <path>                  Evidence JSON output path.",
    "  --limit <n>                        Maximum events to summarize. Default: 10.",
    "  --page-size <n>                    API page size. Default: 5.",
    "  --start-time <RFC3339>             Exclusive lower event-time bound.",
    "  --end-time <RFC3339>               Inclusive upper event-time bound.",
    "  --event-type <type>                Event type filter; repeatable.",
    "  --expect-event-type <type>         Assert at least one matching event; repeatable.",
    "  --expect-min-events <n>            Assert at least n events.",
    "  --expect-message-created <n>       Assert exact message-created count.",
    "  --expect-reaction-created <n>      Assert exact reaction-created count.",
    "  --expect-reaction-deleted <n>      Assert exact reaction-deleted count.",
    "  --max-attempts <n>                 Retry transient 429/5xx responses. Default: 3.",
    "  --retry-delay-ms <n>               Linear retry delay in ms. Default: 1000.",
    "  --allow-blocked                    Exit 0 and save blocked evidence for repeated Google 500 INTERNAL.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = await loadSpaceEventsSmokeConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runSpaceEventsSmoke(config);
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
