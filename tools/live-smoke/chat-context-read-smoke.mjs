import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
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
const MESSAGE_READ_SCOPES = [
  "https://www.googleapis.com/auth/chat.messages.readonly",
];

class ChatContextReadError extends Error {
  constructor(operation, status, response) {
    super(`${operation} failed with HTTP ${status}`);
    this.name = "ChatContextReadError";
    this.operation = operation;
    this.status = status;
    this.response = response;
  }
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    metadataPath: null,
    evidencePath: null,
    limit: 6,
    pageSize: 3,
    order: "desc",
    maxContextTokens: null,
    reserveOutputTokens: 0,
    charsPerToken: 4,
    startTime: null,
    endTime: null,
    thread: null,
    expectText: null,
    expectHumanThreadAnchor: false,
    expectQuotedMessages: null,
    expectQuotedAttachments: null,
    expectDriveAttachments: null,
    expectCustomEmojis: null,
    expectPagination: false,
    expectBudgetTruncation: null,
    help: false,
    expectThreadMessages: null,
    expectThreadReplies: null,
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
    } else if (arg === "--max-context-tokens") {
      args.maxContextTokens = Number(rest[++index]);
    } else if (arg.startsWith("--max-context-tokens=")) {
      args.maxContextTokens = Number(arg.slice("--max-context-tokens=".length));
    } else if (arg === "--reserve-output-tokens") {
      args.reserveOutputTokens = Number(rest[++index]);
    } else if (arg.startsWith("--reserve-output-tokens=")) {
      args.reserveOutputTokens = Number(arg.slice("--reserve-output-tokens=".length));
    } else if (arg === "--chars-per-token") {
      args.charsPerToken = Number(rest[++index]);
    } else if (arg.startsWith("--chars-per-token=")) {
      args.charsPerToken = Number(arg.slice("--chars-per-token=".length));
    } else if (arg === "--order") {
      args.order = rest[++index];
    } else if (arg.startsWith("--order=")) {
      args.order = arg.slice("--order=".length);
    } else if (arg === "--start-time") {
      args.startTime = rest[++index];
    } else if (arg.startsWith("--start-time=")) {
      args.startTime = arg.slice("--start-time=".length);
    } else if (arg === "--end-time") {
      args.endTime = rest[++index];
    } else if (arg.startsWith("--end-time=")) {
      args.endTime = arg.slice("--end-time=".length);
    } else if (arg === "--thread") {
      args.thread = rest[++index];
    } else if (arg.startsWith("--thread=")) {
      args.thread = arg.slice("--thread=".length);
    } else if (arg === "--expect-text") {
      args.expectText = rest[++index];
    } else if (arg.startsWith("--expect-text=")) {
      args.expectText = arg.slice("--expect-text=".length);
    } else if (arg === "--expect-human-thread-anchor") {
      args.expectHumanThreadAnchor = true;
    } else if (arg === "--expect-quoted-messages") {
      args.expectQuotedMessages = Number(rest[++index]);
    } else if (arg.startsWith("--expect-quoted-messages=")) {
      args.expectQuotedMessages = Number(arg.slice("--expect-quoted-messages=".length));
    } else if (arg === "--expect-quoted-attachments") {
      args.expectQuotedAttachments = Number(rest[++index]);
    } else if (arg.startsWith("--expect-quoted-attachments=")) {
      args.expectQuotedAttachments = Number(arg.slice("--expect-quoted-attachments=".length));
    } else if (arg === "--expect-drive-attachments") {
      args.expectDriveAttachments = Number(rest[++index]);
    } else if (arg.startsWith("--expect-drive-attachments=")) {
      args.expectDriveAttachments = Number(arg.slice("--expect-drive-attachments=".length));
    } else if (arg === "--expect-custom-emojis") {
      args.expectCustomEmojis = Number(rest[++index]);
    } else if (arg.startsWith("--expect-custom-emojis=")) {
      args.expectCustomEmojis = Number(arg.slice("--expect-custom-emojis=".length));
    } else if (arg === "--expect-pagination") {
      args.expectPagination = true;
    } else if (arg === "--expect-budget-truncation") {
      args.expectBudgetTruncation = true;
    } else if (arg === "--expect-thread-messages") {
      args.expectThreadMessages = Number(rest[++index]);
    } else if (arg.startsWith("--expect-thread-messages=")) {
      args.expectThreadMessages = Number(arg.slice("--expect-thread-messages=".length));
    } else if (arg === "--expect-thread-replies") {
      args.expectThreadReplies = Number(rest[++index]);
    } else if (arg.startsWith("--expect-thread-replies=")) {
      args.expectThreadReplies = Number(arg.slice("--expect-thread-replies=".length));
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

function requireOptionalPositiveInteger(value, name) {
  if (value === null || value === undefined) {
    return;
  }
  requirePositiveInteger(value, name);
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

function requirePositiveNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
}

function requireOrder(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized !== "asc" && normalized !== "desc") {
    throw new Error("--order must be asc or desc.");
  }
  return normalized;
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
  if (env.GOOGLE_CHAT_CONTEXT_READ_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_CONTEXT_READ_SMOKE_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `context-read-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function defaultStartTime(env) {
  if (env.GOOGLE_CHAT_CONTEXT_START_TIME) {
    return env.GOOGLE_CHAT_CONTEXT_START_TIME;
  }
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function defaultEndTime(env) {
  if (env.GOOGLE_CHAT_CONTEXT_END_TIME) {
    return env.GOOGLE_CHAT_CONTEXT_END_TIME;
  }
  return new Date(Date.now() + 5 * 60 * 1000).toISOString();
}

export async function loadContextReadSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_CHAT_CONTEXT_READ_SMOKE !== "1") {
    throw new Error(
      "Refusing to run context-read Chat smoke without RUN_LIVE_CHAT_CONTEXT_READ_SMOKE=1.",
    );
  }

  const space = env.GOOGLE_CHAT_TEST_SPACE?.trim();
  requireSmokeSpaceName(space);
  requirePositiveInteger(args.limit, "--limit");
  requirePositiveInteger(args.pageSize, "--page-size");
  requireOptionalPositiveInteger(args.maxContextTokens, "--max-context-tokens");
  requireNonNegativeInteger(args.reserveOutputTokens, "--reserve-output-tokens");
  requirePositiveNumber(args.charsPerToken, "--chars-per-token");
  if (
    args.expectQuotedMessages !== null &&
    (!Number.isInteger(args.expectQuotedMessages) || args.expectQuotedMessages < 0)
  ) {
    throw new Error("--expect-quoted-messages must be a non-negative integer.");
  }
  if (
    args.expectQuotedAttachments !== null &&
    (!Number.isInteger(args.expectQuotedAttachments) || args.expectQuotedAttachments < 0)
  ) {
    throw new Error("--expect-quoted-attachments must be a non-negative integer.");
  }
  if (
    args.expectDriveAttachments !== null &&
    (!Number.isInteger(args.expectDriveAttachments) || args.expectDriveAttachments < 0)
  ) {
    throw new Error("--expect-drive-attachments must be a non-negative integer.");
  }
  if (
    args.expectThreadMessages !== null &&
    (!Number.isInteger(args.expectThreadMessages) || args.expectThreadMessages < 0)
  ) {
    throw new Error("--expect-thread-messages must be a non-negative integer.");
  }
  if (
    args.expectThreadReplies !== null &&
    (!Number.isInteger(args.expectThreadReplies) || args.expectThreadReplies < 0)
  ) {
    throw new Error("--expect-thread-replies must be a non-negative integer.");
  }
  if (
    args.expectCustomEmojis !== null &&
    (!Number.isInteger(args.expectCustomEmojis) || args.expectCustomEmojis < 0)
  ) {
    throw new Error("--expect-custom-emojis must be a non-negative integer.");
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

  return {
    dryRun: args.dryRun,
    space,
    metadata,
    metadataPath,
    runId: makeRunId(env),
    credentialsPath: userAuthConfig.credentialsPath,
    tokenStorePath: userAuthConfig.tokenStorePath,
    limit: args.limit,
    pageSize: Math.min(args.pageSize, args.limit),
    order: requireOrder(args.order),
    maxContextTokens: args.maxContextTokens,
    reserveOutputTokens: args.reserveOutputTokens,
    charsPerToken: args.charsPerToken,
    startTime: args.startTime ?? defaultStartTime(env),
    endTime: args.endTime ?? defaultEndTime(env),
    thread: args.thread,
    expectText: args.expectText,
    expectations: {
      quotedMessages: args.expectQuotedMessages,
      quotedAttachments: args.expectQuotedAttachments,
      driveAttachments: args.expectDriveAttachments,
      customEmojis: args.expectCustomEmojis,
      pagination: args.expectPagination,
      budgetTruncation: args.expectBudgetTruncation,
      humanThreadAnchor: args.expectHumanThreadAnchor,
      threadMessages: args.expectThreadMessages,
      threadReplies: args.expectThreadReplies,
    },
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_CONTEXT_READ_SMOKE_EVIDENCE,
      cwd,
    ),
    repoRoot,
  };
}

function buildReaderInput(config, overrides = {}) {
  const input = {
    space: config.space,
    limit: config.limit,
    pageSize: config.pageSize,
    order: config.order,
    startTime: config.startTime,
    endTime: config.endTime,
    maxQuoteDepth: 2,
    ...overrides,
  };
  if (config.maxContextTokens !== null) {
    input.maxContextTokens = config.maxContextTokens;
    input.reserveOutputTokens = config.reserveOutputTokens;
    input.charsPerToken = config.charsPerToken;
  }
  return input;
}

export function buildContextReadPlan(config) {
  const baseQuery = {
    pageSize: config.pageSize,
    filter: [
      `createTime > "${config.startTime}"`,
      `createTime < "${config.endTime}"`,
    ].join(" AND "),
    orderBy: `createTime ${config.order}`,
    showDeleted: true,
  };
  const calls = [
    {
      operation: "context.space.messages.list",
      method: "GET",
      path: `/v1/${config.space}/messages`,
      query: baseQuery,
      writes: false,
      authMode: "user",
      requiredScopes: MESSAGE_READ_SCOPES,
      safetyCheck: "Read-only; requires dedicated smoke space metadata.",
    },
  ];

  if (config.thread) {
    calls.push({
      operation: "context.thread.messages.list",
      method: "GET",
      path: `/v1/${config.space}/messages`,
      query: {
        ...baseQuery,
        filter: `${baseQuery.filter} AND thread.name = "${config.thread}"`,
      },
      writes: false,
      authMode: "user",
      requiredScopes: MESSAGE_READ_SCOPES,
      safetyCheck: "Read-only; thread filter stays inside the smoke space.",
    });
  }

  return {
    mode: config.dryRun ? "dry-run" : "live",
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    runId: config.runId,
    reader: {
      limit: config.limit,
      pageSize: config.pageSize,
      order: config.order,
      maxContextTokens: config.maxContextTokens,
      reserveOutputTokens:
        config.maxContextTokens === null ? null : config.reserveOutputTokens,
      charsPerToken:
        config.maxContextTokens === null ? null : config.charsPerToken,
      startTime: config.startTime,
      endTime: config.endTime,
      thread: config.thread,
    },
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
        "Run `corepack pnpm chat:user-auth-smoke -- --authorize --read-messages` to grant the local user token chat.messages.readonly. Do not use domain-wide delegation.",
    };
  }
  if (error instanceof ChatContextReadError) {
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
    path.join(defaultEvidenceDir, `chat-context-read-smoke-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

async function loadSdkContextHelpers(repoRootPath) {
  try {
    return await import(pathToFileURL(path.join(repoRootPath, "packages/node/dist/index.js")));
  } catch (error) {
    throw new Error(
      `Unable to load built Node SDK context helpers. Run \`corepack pnpm build\` first. ${error.message}`,
    );
  }
}

async function createUserAuthChatClient(config) {
  const oauthClient = readOAuthClientConfig(
    await fs.readFile(resolvePath(config.credentialsPath, process.cwd()), "utf8"),
  );

  return {
    async listMessages(query) {
      const url = new URL(`https://chat.googleapis.com/v1/${config.space}/messages`);

      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }

      const result = await chatRequestWithUserAuth({
        oauthClient,
        tokenStorePath: config.tokenStorePath,
        scopes: MESSAGE_READ_SCOPES,
        url: url.toString(),
      });

      if (!result.ok) {
        throw new ChatContextReadError("spaces.messages.list", result.status, result.json);
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
      messages: Array.isArray(result.json.messages) ? result.json.messages.length : 0,
      nextPageTokenAvailable: typeof result.json.nextPageToken === "string",
    },
  };
}

function queryWithPageToken(query, pageToken) {
  if (!pageToken) {
    return query;
  }
  return {
    ...query,
    pageToken,
  };
}

async function fetchMessagePages({
  config,
  client,
  evidence,
  sdk,
  readerInput,
  scopeLabel,
}) {
  const plan =
    scopeLabel === "thread"
      ? sdk.planReadThreadContext(readerInput)
      : sdk.planReadSpaceContext(readerInput);
  const query = {
    ...plan.requests[0].query,
    showDeleted: true,
  };
  const responses = [];
  let pageToken = null;

  while (responses.reduce((sum, page) => sum + (page.messages?.length ?? 0), 0) < config.limit) {
    const result = await recordOperation(
      evidence,
      `context.${scopeLabel}.messages.list.${responses.length + 1}`,
      () => client.listMessages(queryWithPageToken(query, pageToken)),
      summarizeListResult,
    );
    responses.push(result.json);
    pageToken = result.json.nextPageToken ?? null;

    if (!pageToken) {
      break;
    }
  }

  return {
    plan,
    responses,
    context: sdk.buildConversationContext(readerInput, responses),
  };
}

function selectThread(responses, { thread = null, expectedText = null } = {}) {
  const candidates = [];

  for (const response of responses) {
    for (const message of response.messages ?? []) {
      if (typeof message.thread?.name === "string") {
        if (thread && message.thread.name !== thread) {
          continue;
        }
        const textMatches =
          expectedText && typeof message.text === "string"
            ? message.text.includes(expectedText)
            : false;
        const senderType =
          typeof message.sender?.type === "string" ? message.sender.type : "UNKNOWN";
        candidates.push({
          thread: message.thread.name,
          anchor: message,
          score: (textMatches ? 4 : 0) + (senderType === "HUMAN" ? 2 : 0),
          selectedByExpectedText: Boolean(textMatches),
        });
      }
    }
  }

  if (candidates.length === 0) {
    return { thread, anchor: null, selectedByExpectedText: false };
  }

  return candidates.sort((left, right) => right.score - left.score)[0];
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
    sha256: stableHash(project, text),
  };
}

function summarizeIdentity(project, sender) {
  const email = typeof sender?.email === "string" ? sender.email : null;
  const displayName =
    typeof sender?.displayName === "string" ? sender.displayName : null;

  return {
    nameAvailable: typeof sender?.name === "string",
    displayNameAvailable: displayName !== null,
    displayNameHash: displayName ? stableHash(project, displayName) : null,
    emailAvailable: email !== null,
    emailDomain: email?.includes("@") ? email.split("@").at(-1) : null,
    type: typeof sender?.type === "string" ? sender.type : "UNKNOWN",
    access: typeof sender?.access === "string" ? sender.access : "unknown",
  };
}

function summarizeAttachment(attachment) {
  const driveDataRef =
    attachment?.driveDataRef && typeof attachment.driveDataRef === "object"
      ? attachment.driveDataRef
      : null;
  const attachmentDataRef =
    attachment?.attachmentDataRef && typeof attachment.attachmentDataRef === "object"
      ? attachment.attachmentDataRef
      : null;
  return {
    nameAvailable: typeof attachment?.name === "string",
    contentNameAvailable: typeof attachment?.contentName === "string",
    contentType: typeof attachment?.contentType === "string" ? attachment.contentType : null,
    source: typeof attachment?.source === "string" ? attachment.source : null,
    sizeBytes: typeof attachment?.sizeBytes === "number" ? attachment.sizeBytes : null,
    mediaResourceNameAvailable: typeof attachment?.mediaResourceName === "string",
    attachmentDataRefAvailable:
      typeof attachmentDataRef?.resourceName === "string" ||
      typeof attachment?.mediaResourceName === "string",
    driveAttachment:
      attachment?.source === "DRIVE_FILE" ||
      typeof driveDataRef?.driveFileId === "string",
    driveFileIdAvailable: typeof driveDataRef?.driveFileId === "string",
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function summarizeSystemNotes(notes) {
  const text = Array.isArray(notes) ? notes.join("\n") : "";
  return {
    count: Array.isArray(notes) ? notes.length : 0,
    hasSenderTimeNote: /sent this message at/.test(text),
    hasThreadNote: /thread/.test(text),
    hasAttachmentNote: /attached/.test(text),
    hasCardNote: /card object/.test(text),
    hasEditedNote: /edited at/.test(text),
    hasDeletedNote: /deleted/.test(text),
    hasQuoteNote: /quoted context|quoted/.test(text),
    hasReactionNote: /Reaction/.test(text),
    hasCustomEmojiNote: /Custom emoji/.test(text),
    customEmojiNoteCount: Array.isArray(notes)
      ? notes.filter((note) => /Custom emoji/.test(note)).length
      : 0,
  };
}

function emptyQuoteSummary() {
  return {
    count: 0,
    messagesWithAttachments: 0,
    attachmentCount: 0,
    driveAttachmentCount: 0,
    driveFileIdCount: 0,
    maxDepth: 0,
    attachmentContentTypes: [],
    customEmojiNoteCount: 0,
    hasQuoteSystemNote: false,
    hasAttachmentSystemNote: false,
  };
}

function mergeQuoteSummary(left, right) {
  return {
    count: left.count + right.count,
    messagesWithAttachments:
      left.messagesWithAttachments + right.messagesWithAttachments,
    attachmentCount: left.attachmentCount + right.attachmentCount,
    driveAttachmentCount:
      left.driveAttachmentCount + right.driveAttachmentCount,
    driveFileIdCount: left.driveFileIdCount + right.driveFileIdCount,
    maxDepth: Math.max(left.maxDepth, right.maxDepth),
    customEmojiNoteCount:
      left.customEmojiNoteCount + right.customEmojiNoteCount,
    attachmentContentTypes: [
      ...new Set([
        ...left.attachmentContentTypes,
        ...right.attachmentContentTypes,
      ]),
    ].sort(),
    hasQuoteSystemNote: left.hasQuoteSystemNote || right.hasQuoteSystemNote,
    hasAttachmentSystemNote:
      left.hasAttachmentSystemNote || right.hasAttachmentSystemNote,
  };
}

function summarizeQuotedMessages(messages, depth = 1) {
  return asArray(messages).reduce((summary, item) => {
    const quoted = item && typeof item === "object" ? item : {};
    const attachments = asArray(quoted.attachments);
    const summarizedAttachments = attachments.map(summarizeAttachment);
    const notes = summarizeSystemNotes(quoted.systemNotes);
    const current = {
      count: 1,
      messagesWithAttachments: attachments.length > 0 ? 1 : 0,
      attachmentCount: attachments.length,
      driveAttachmentCount: summarizedAttachments.filter(
        (attachment) => attachment.driveAttachment,
      ).length,
      driveFileIdCount: summarizedAttachments.filter(
        (attachment) => attachment.driveFileIdAvailable,
      ).length,
      maxDepth: depth,
      customEmojiNoteCount: notes.customEmojiNoteCount,
      attachmentContentTypes: [
        ...new Set(
          attachments
            .map((attachment) =>
              typeof attachment?.contentType === "string"
                ? attachment.contentType
                : null,
            )
            .filter(Boolean),
        ),
      ].sort(),
      hasQuoteSystemNote: notes.hasQuoteNote,
      hasAttachmentSystemNote: notes.hasAttachmentNote,
    };
    return mergeQuoteSummary(
      summary,
      mergeQuoteSummary(
        current,
        summarizeQuotedMessages(quoted.quotedMessages, depth + 1),
      ),
    );
  }, emptyQuoteSummary());
}

function summarizeThreadSelection(config, selection) {
  if (!selection?.anchor) {
    return null;
  }
  const anchor = selection.anchor;
  return {
    threadNameAvailable: typeof selection.thread === "string",
    selectedByExpectedText: Boolean(selection.selectedByExpectedText),
    anchorCreatedAt:
      typeof anchor.createTime === "string" ? anchor.createTime : null,
    anchorSender: summarizeIdentity(config.metadata.displayName, anchor.sender),
    anchorText: summarizeText(config.metadata.displayName, anchor.text),
  };
}

function summarizeModelTokenBudget(modelTokenBudget) {
  if (!modelTokenBudget || typeof modelTokenBudget !== "object") {
    return null;
  }

  return {
    applied: true,
    maxTokens:
      typeof modelTokenBudget.maxTokens === "number"
        ? modelTokenBudget.maxTokens
        : null,
    reserveOutputTokens:
      typeof modelTokenBudget.reserveOutputTokens === "number"
        ? modelTokenBudget.reserveOutputTokens
        : null,
    availableTokens:
      typeof modelTokenBudget.availableTokens === "number"
        ? modelTokenBudget.availableTokens
        : null,
    estimatedTokensBefore:
      typeof modelTokenBudget.estimatedTokensBefore === "number"
        ? modelTokenBudget.estimatedTokensBefore
        : null,
    estimatedTokensAfter:
      typeof modelTokenBudget.estimatedTokensAfter === "number"
        ? modelTokenBudget.estimatedTokensAfter
        : null,
    includedMessages:
      typeof modelTokenBudget.includedMessages === "number"
        ? modelTokenBudget.includedMessages
        : null,
    droppedMessages:
      typeof modelTokenBudget.droppedMessages === "number"
        ? modelTokenBudget.droppedMessages
        : null,
    truncated: modelTokenBudget.truncated === true,
    strategy:
      typeof modelTokenBudget.strategy === "string"
        ? modelTokenBudget.strategy
        : null,
    estimator: {
      strategy:
        typeof modelTokenBudget.estimator?.strategy === "string"
          ? modelTokenBudget.estimator.strategy
          : null,
      charsPerToken:
        typeof modelTokenBudget.estimator?.charsPerToken === "number"
          ? modelTokenBudget.estimator.charsPerToken
          : null,
    },
  };
}

function summarizeContext(config, context, responses) {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const rawMessages = responses.flatMap((response) => response.messages ?? []);
  const summarizedMessages = messages.map((message) => {
    const attachments = Array.isArray(message.attachments)
      ? message.attachments.map(summarizeAttachment)
      : [];
    return {
      ref: message.ref,
      sender: summarizeIdentity(config.metadata.displayName, message.sender),
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      deletedAt: message.deletedAt,
      relationship: message.relationship,
      text: summarizeText(config.metadata.displayName, message.text),
      plainTextForModel: summarizeText(
        config.metadata.displayName,
        message.plainTextForModel,
      ),
      attachments,
      quotedMessages: Array.isArray(message.quotedMessages)
        ? message.quotedMessages.length
        : 0,
      quotedMessageSummary: summarizeQuotedMessages(message.quotedMessages),
      systemNotes: summarizeSystemNotes(message.systemNotes),
    };
  });
  return {
    kind: context.kind,
    scope: context.scope,
    order: context.order,
    requestedLimit: context.requestedLimit,
    returnedMessages: context.returnedMessages,
    partial: context.partial,
    truncated: context.truncated,
    inaccessible: context.inaccessible,
    pageCursors: {
      nextAvailable: typeof context.pageCursors?.next === "string",
    },
    modelTokenBudget: summarizeModelTokenBudget(context.modelTokenBudget),
    rawApi: {
      pages: responses.length,
      returnedMessages: rawMessages.length,
      deletedMessages:
        rawMessages.filter(
          (message) => message.deleteTime || message.deletionMetadata,
        ).length,
      messagesWithCards:
        rawMessages.filter(
          (message) =>
            Array.isArray(message.cardsV2) && message.cardsV2.length > 0,
        ).length,
      messagesWithAttachments:
        rawMessages.filter(
          (message) =>
            Array.isArray(message.attachment) && message.attachment.length > 0,
        ).length,
    },
    systemNotes: {
      count: Array.isArray(context.systemNotes) ? context.systemNotes.length : 0,
      hasTruncationNote:
        Array.isArray(context.systemNotes) &&
        context.systemNotes.some((note) => /truncated/.test(note)),
      hasPaginationNote:
        Array.isArray(context.systemNotes) &&
        context.systemNotes.some((note) => /More .* history/.test(note)),
    },
    attachmentSummary: {
      messagesWithAttachments:
        summarizedMessages.filter((message) => message.attachments.length > 0)
          .length,
      attachmentCount: summarizedMessages.reduce(
        (count, message) => count + message.attachments.length,
        0,
      ),
      driveAttachmentCount: summarizedMessages.reduce(
        (count, message) =>
          count +
          message.attachments.filter(
            (attachment) => attachment.driveAttachment,
          ).length,
        0,
      ),
      driveFileIdCount: summarizedMessages.reduce(
        (count, message) =>
          count +
          message.attachments.filter(
            (attachment) => attachment.driveFileIdAvailable,
          ).length,
        0,
      ),
      attachmentDataRefCount: summarizedMessages.reduce(
        (count, message) =>
          count +
          message.attachments.filter(
            (attachment) => attachment.attachmentDataRefAvailable,
          ).length,
        0,
      ),
    },
    relationshipSummary: {
      spaceMessages: summarizedMessages.filter(
        (message) => message.relationship?.kind === "space_message",
      ).length,
      threadRoots: summarizedMessages.filter(
        (message) => message.relationship?.kind === "thread_root",
      ).length,
      threadReplies: summarizedMessages.filter(
        (message) => message.relationship?.kind === "thread_reply",
      ).length,
      replyLikeMessages:
        context.scope === "thread"
          ? Math.max(0, summarizedMessages.length - 1)
          : summarizedMessages.filter(
              (message) => message.relationship?.kind === "thread_reply",
            ).length,
    },
    messages: summarizedMessages,
  };
}

function expectedTextAssertion(project, responses, expectedText) {
  if (!expectedText) {
    return {
      provided: false,
      found: null,
      sha256: null,
    };
  }
  const messages = responses.flatMap((response) => response.messages ?? []);
  return {
    provided: true,
    found: messages.some((message) => message.text?.includes(expectedText)),
    sha256: stableHash(project, expectedText),
  };
}

function buildAssertions(
  spaceSummary,
  threadSummary,
  expectedText,
  expectations = {},
  threadSelection = null,
) {
  const allMessages = [
    ...(spaceSummary?.messages ?? []),
    ...(threadSummary?.messages ?? []),
  ];
  const quoteSummary = allMessages.reduce(
    (summary, message) =>
      mergeQuoteSummary(
        summary,
        message.quotedMessageSummary ?? emptyQuoteSummary(),
      ),
    emptyQuoteSummary(),
  );
  const directAttachmentSummary = allMessages.reduce(
    (summary, message) => ({
      attachmentCount: summary.attachmentCount + message.attachments.length,
      driveAttachmentCount:
        summary.driveAttachmentCount +
        message.attachments.filter((attachment) => attachment.driveAttachment)
          .length,
      driveFileIdCount:
        summary.driveFileIdCount +
        message.attachments.filter((attachment) => attachment.driveFileIdAvailable)
          .length,
    }),
    { attachmentCount: 0, driveAttachmentCount: 0, driveFileIdCount: 0 },
  );
  const totalDriveAttachments =
    directAttachmentSummary.driveAttachmentCount +
    quoteSummary.driveAttachmentCount;
  const totalDriveFileIds =
    directAttachmentSummary.driveFileIdCount + quoteSummary.driveFileIdCount;
  const directCustomEmojiCount = allMessages.reduce(
    (count, message) =>
      count + (message.systemNotes?.customEmojiNoteCount ?? 0),
    0,
  );
  const customEmojiCount =
    directCustomEmojiCount + quoteSummary.customEmojiNoteCount;
  const budgetSummaries = [spaceSummary, threadSummary]
    .map((summary) => summary?.modelTokenBudget)
    .filter(Boolean);
  const budgetTruncationObserved = budgetSummaries.some(
    (budget) => budget.truncated === true,
  );
  return {
    spaceMessagesReturned: (spaceSummary?.returnedMessages ?? 0) > 0,
    paginationObserved:
      expectations.pagination === true
        ? (spaceSummary?.rawApi?.pages ?? 0) > 1
        : null,
    paginationExercised:
      expectations.pagination === true
        ? (spaceSummary?.rawApi?.pages ?? 0) > 1
        : null,
    contextIncludesSenderTimeNotes:
      allMessages.length > 0 &&
      allMessages.every((message) => message.systemNotes.hasSenderTimeNote),
    contextIncludesCreatedTimes:
      allMessages.length > 0 && allMessages.every((message) => message.createdAt),
    senderIdentityResolution:
      allMessages.filter((message) => message.sender.displayNameAvailable).length,
    expectedTextFound: expectedText.provided ? expectedText.found : null,
    quotedMessageCount: quoteSummary.count,
    quotedAttachmentCount: quoteSummary.attachmentCount,
    driveAttachmentCount: totalDriveAttachments,
    driveFileIdCount: totalDriveFileIds,
    customEmojiCount,
    expectedQuotedMessageCountMatches:
      expectations.quotedMessages === null || expectations.quotedMessages === undefined
        ? null
        : quoteSummary.count >= expectations.quotedMessages,
    expectedQuotedAttachmentCountMatches:
      expectations.quotedAttachments === null || expectations.quotedAttachments === undefined
        ? null
        : quoteSummary.attachmentCount >= expectations.quotedAttachments,
    expectedDriveAttachmentCountMatches:
      expectations.driveAttachments === null || expectations.driveAttachments === undefined
        ? null
        : totalDriveAttachments >= expectations.driveAttachments,
    expectedCustomEmojiCountMatches:
      expectations.customEmojis === null || expectations.customEmojis === undefined
        ? null
        : customEmojiCount >= expectations.customEmojis,
    budgetTruncationObserved:
      budgetSummaries.length > 0 ? budgetTruncationObserved : null,
    expectedBudgetTruncationMatches:
      expectations.budgetTruncation === null ||
      expectations.budgetTruncation === undefined
        ? null
        : budgetTruncationObserved === expectations.budgetTruncation,
    threadFilterExercised: threadSummary ? true : null,
    expectedThreadMessageCountMatches:
      expectations.threadMessages === null || expectations.threadMessages === undefined
        ? null
        : (threadSummary?.returnedMessages ?? 0) >= expectations.threadMessages,
    expectedThreadReplyCountMatches:
      expectations.threadReplies === null || expectations.threadReplies === undefined
        ? null
        : (threadSummary?.relationshipSummary?.replyLikeMessages ?? 0) >=
          expectations.threadReplies,
    humanThreadAnchor:
      expectations.humanThreadAnchor === true
        ? threadSelection?.anchorSender?.type === "HUMAN"
        : null,
  };
}

function failedAssertions(assertions) {
  return Object.entries(assertions)
    .filter(([, value]) => value === false)
    .map(([key]) => key);
}

export async function runContextReadSmoke(
  config,
  { client = null, sdk = null, writeEvidence = true } = {},
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
        plan: buildContextReadPlan(config),
      },
    };
  }

  const helpers = sdk ?? (await loadSdkContextHelpers(config.repoRoot));
  const chat = client ?? (await createUserAuthChatClient(config));
  const evidence = {
    ok: false,
    mode: "live",
    runId: config.runId,
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    tokenStorePath: config.tokenStorePath,
    startedAt: new Date().toISOString(),
    operations: [],
    contexts: {},
    assertions: {},
    failures: [],
    privacy: {
      rawMessageTextSaved: false,
      rawFormValuesSaved: false,
      rawAccessTokensSaved: false,
      senderEmailsSaved: false,
    },
  };
  let originalError = null;

  try {
    const spaceReader = buildReaderInput(config);
    const spaceResult = await fetchMessagePages({
      config,
      client: chat,
      evidence,
      sdk: helpers,
      readerInput: spaceReader,
      scopeLabel: "space",
    });
    evidence.contexts.space = summarizeContext(
      config,
      spaceResult.context,
      spaceResult.responses,
    );

    const selectedThread = selectThread(spaceResult.responses, {
      thread: config.thread,
      expectedText: config.expectText,
    });
    const thread = selectedThread.thread;
    let threadSummary = null;
    let threadResponses = [];
    const threadSelection = summarizeThreadSelection(config, selectedThread);
    if (thread) {
      const threadReader = buildReaderInput(config, {
        thread,
        limit: Math.min(config.limit, 4),
        pageSize: Math.min(config.pageSize, 2),
      });
      const threadResult = await fetchMessagePages({
        config: { ...config, limit: threadReader.limit },
        client: chat,
        evidence,
        sdk: helpers,
        readerInput: threadReader,
        scopeLabel: "thread",
      });
      threadSummary = summarizeContext(
        config,
        threadResult.context,
        threadResult.responses,
      );
      threadResponses = threadResult.responses;
      evidence.contexts.thread = {
        thread,
        selection: threadSelection,
        ...threadSummary,
      };
    }

    const expected = expectedTextAssertion(
      config.metadata.displayName,
      [...spaceResult.responses, ...threadResponses],
      config.expectText,
    );
    evidence.assertions = buildAssertions(
      evidence.contexts.space,
      threadSummary,
      expected,
      config.expectations,
      threadSelection,
    );
    evidence.assertions.expectedText = expected;
    evidence.failures = failedAssertions(evidence.assertions);
    if (evidence.failures.length > 0) {
      throw new Error(
        `Chat context read smoke assertions failed: ${evidence.failures.join(", ")}`,
      );
    }
  } catch (error) {
    originalError = error;
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
    "Usage: RUN_LIVE_CHAT_CONTEXT_READ_SMOKE=1 GOOGLE_CHAT_TEST_SPACE=spaces/... pnpm live:chat-context-read-smoke",
    "",
    "Required:",
    "  RUN_LIVE_CHAT_CONTEXT_READ_SMOKE=1",
    "  GOOGLE_CHAT_TEST_SPACE=spaces/...",
    "  GOOGLE_CHAT_SMOKE_METADATA=fixtures/live/chat-smoke-space.local.json",
    "  User OAuth token with https://www.googleapis.com/auth/chat.messages.readonly",
    "",
    "Authorize missing message-read scope:",
    "  corepack pnpm chat:user-auth-smoke -- --authorize --read-messages",
    "",
    "Options:",
    "  --dry-run              Print planned read-only API calls without reads.",
    "  --metadata <path>      Smoke-space metadata JSON path.",
    "  --evidence <path>      Evidence JSON output path.",
    "  --limit <n>            Maximum messages to render into context. Default: 6.",
    "  --page-size <n>        API page size. Default: 3.",
    "  --order asc|desc       API/context order. Default: desc.",
    "  --max-context-tokens <n>     Apply SDK estimated model-token context budget.",
    "  --reserve-output-tokens <n>  Tokens to reserve from max context budget. Default: 0.",
    "  --chars-per-token <n>        Estimator ratio for budget mode. Default: 4.",
    "  --start-time <RFC3339> Date filter lower bound. Default: now minus 24h.",
    "  --end-time <RFC3339>   Date filter upper bound. Default: now plus 5m.",
    "  --thread <name>        Optional thread.name filter for thread context.",
    "  --expect-text <text>   Optional expected synthetic text; evidence saves only a hash and found flag.",
    "  --expect-human-thread-anchor   Require the selected thread anchor message to be human-authored.",
    "  --expect-quoted-messages <n>    Require at least n recursively rendered quoted messages.",
    "  --expect-quoted-attachments <n> Require at least n recursively rendered quoted attachments.",
    "  --expect-drive-attachments <n>  Require at least n direct or recursively quoted Drive attachments.",
    "  --expect-custom-emojis <n>      Require at least n direct or recursively quoted custom emoji notes.",
    "  --expect-thread-messages <n>    Require selected thread context to return at least n messages.",
    "  --expect-thread-replies <n>      Require selected thread context to include at least n reply-like messages.",
    "  --expect-pagination             Require pagination to be exercised.",
    "  --expect-budget-truncation      Require model-token budget truncation to occur.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = await loadContextReadSmokeConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runContextReadSmoke(config);
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
