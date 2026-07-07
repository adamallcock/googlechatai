import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SMOKE_SPACE_PREFIX } from "./chat-smoke.mjs";
import { fetchWithUserAuthRetry } from "../chat/user-auth-client.mjs";
import {
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
const MESSAGE_READ_SCOPES = USER_AUTH_SCOPES.readMessages;
const MESSAGE_CREATE_SCOPES = USER_AUTH_SCOPES.writeMessages;
const LIVE_SCOPES = [...new Set([...MESSAGE_READ_SCOPES, ...MESSAGE_CREATE_SCOPES])];
const DEFAULT_CONTENT_TYPE = "text/plain";
const DEFAULT_MAX_BYTES = 64 * 1024;

class ChatUploadedMediaSmokeError extends Error {
  constructor(operation, status, response) {
    super(`${operation} failed with HTTP ${status}`);
    this.name = "ChatUploadedMediaSmokeError";
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
    filename: null,
    contentType: DEFAULT_CONTENT_TYPE,
    syntheticText: null,
    maxBytes: DEFAULT_MAX_BYTES,
    pageSize: 6,
    startTime: null,
    endTime: null,
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
    } else if (arg === "--filename") {
      args.filename = rest[++index];
    } else if (arg.startsWith("--filename=")) {
      args.filename = arg.slice("--filename=".length);
    } else if (arg === "--content-type") {
      args.contentType = rest[++index];
    } else if (arg.startsWith("--content-type=")) {
      args.contentType = arg.slice("--content-type=".length);
    } else if (arg === "--synthetic-text") {
      args.syntheticText = rest[++index];
    } else if (arg.startsWith("--synthetic-text=")) {
      args.syntheticText = arg.slice("--synthetic-text=".length);
    } else if (arg === "--max-bytes") {
      args.maxBytes = Number(rest[++index]);
    } else if (arg.startsWith("--max-bytes=")) {
      args.maxBytes = Number(arg.slice("--max-bytes=".length));
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
  if (env.GOOGLE_CHAT_UPLOADED_MEDIA_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_UPLOADED_MEDIA_SMOKE_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `uploaded-media-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function defaultStartTime(env) {
  if (env.GOOGLE_CHAT_UPLOADED_MEDIA_START_TIME) {
    return env.GOOGLE_CHAT_UPLOADED_MEDIA_START_TIME;
  }
  return new Date(Date.now() - 2 * 60 * 1000).toISOString();
}

function defaultEndTime(env) {
  if (env.GOOGLE_CHAT_UPLOADED_MEDIA_END_TIME) {
    return env.GOOGLE_CHAT_UPLOADED_MEDIA_END_TIME;
  }
  return new Date(Date.now() + 5 * 60 * 1000).toISOString();
}

function defaultFilename(runId) {
  return `chat-uploaded-media-smoke-${runId}.txt`;
}

function defaultSyntheticText(runId) {
  return [
    `Google Chat AI SDK uploaded-media smoke ${runId}`,
    "Synthetic attachment for live upload/download verification.",
    "",
  ].join("\n");
}

function liveUploadGate(config) {
  const reasons = [];
  if (config.liveMediaEnv.GOOGLE_CHAT_AI_W7_MEDIA_READY !== "1") {
    reasons.push("w7_not_complete");
  }
  if (config.liveMediaEnv.GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA !== "1") {
    reasons.push("env_flag_missing");
  }
  if (config.liveMediaEnv.GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA_UPLOAD !== "1") {
    reasons.push("upload_write_gate_missing");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

export async function loadUploadedMediaSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_CHAT_UPLOADED_MEDIA_SMOKE !== "1") {
    throw new Error(
      "Refusing to run uploaded-media Chat smoke without RUN_LIVE_CHAT_UPLOADED_MEDIA_SMOKE=1.",
    );
  }

  const space = env.GOOGLE_CHAT_TEST_SPACE?.trim();
  requireSmokeSpaceName(space);
  requirePositiveInteger(args.maxBytes, "--max-bytes");
  requirePositiveInteger(args.pageSize, "--page-size");

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

  const runId = makeRunId(env);
  const syntheticText =
    args.syntheticText ??
    env.GOOGLE_CHAT_UPLOADED_MEDIA_SYNTHETIC_TEXT ??
    defaultSyntheticText(runId);
  const sourceBytes = new TextEncoder().encode(syntheticText);
  if (sourceBytes.byteLength > args.maxBytes) {
    throw new Error(
      `Synthetic upload is ${sourceBytes.byteLength} bytes, above --max-bytes ${args.maxBytes}.`,
    );
  }

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
    runId,
    credentialsPath: userAuthConfig.credentialsPath,
    tokenStorePath: userAuthConfig.tokenStorePath,
    filename: args.filename ?? defaultFilename(runId),
    contentType: args.contentType,
    sourceBytes,
    sourceSha256: sha256Bytes(sourceBytes),
    maxBytes: args.maxBytes,
    pageSize: args.pageSize,
    startTime: args.startTime ?? defaultStartTime(env),
    endTime: args.endTime ?? defaultEndTime(env),
    liveMediaEnv: {
      GOOGLE_CHAT_AI_W7_MEDIA_READY: env.GOOGLE_CHAT_AI_W7_MEDIA_READY,
      GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA: env.GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA,
      GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA_UPLOAD:
        env.GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA_UPLOAD,
    },
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_UPLOADED_MEDIA_SMOKE_EVIDENCE,
      cwd,
    ),
    repoRoot,
  };
}

function buildListQuery(config) {
  return {
    pageSize: config.pageSize,
    filter: [
      `createTime > "${config.startTime}"`,
      `createTime < "${config.endTime}"`,
    ].join(" AND "),
    orderBy: "createTime desc",
    showDeleted: true,
  };
}

export function buildUploadedMediaSmokePlan(config) {
  return {
    mode: config.dryRun ? "dry-run" : "live",
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    runId: config.runId,
    upload: {
      contentType: config.contentType,
      sizeBytes: config.sourceBytes.byteLength,
      maxBytes: config.maxBytes,
      filenameFilterProvided: true,
      sha256KnownBeforeUpload: true,
    },
    calls: [
      {
        operation: "media.upload",
        method: "POST",
        path: `/upload/v1/${config.space}/attachments:upload`,
        query: { uploadType: "multipart" },
        writes: true,
        authMode: "user",
        requiredScopes: MESSAGE_CREATE_SCOPES,
        liveGates: [
          "RUN_LIVE_CHAT_UPLOADED_MEDIA_SMOKE=1",
          "GOOGLE_CHAT_AI_W7_MEDIA_READY=1",
          "GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA=1",
          "GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA_UPLOAD=1",
        ],
        safetyCheck:
          "Uploads one generated synthetic file into metadata-verified dedicated smoke space.",
      },
      {
        operation: "spaces.messages.create",
        method: "POST",
        path: `/v1/${config.space}/messages`,
        writes: true,
        authMode: "user",
        requiredScopes: MESSAGE_CREATE_SCOPES,
        safetyCheck:
          "Creates one user-auth smoke message with the uploaded attachment in the dedicated smoke space only.",
      },
      {
        operation: "spaces.messages.list",
        method: "GET",
        path: `/v1/${config.space}/messages`,
        query: buildListQuery(config),
        writes: false,
        authMode: "user",
        requiredScopes: MESSAGE_READ_SCOPES,
        safetyCheck:
          "Confirms the freshly created attachment is discoverable without using old smoke-space attachments.",
      },
      {
        operation: "media.download",
        method: "GET",
        path: "/v1/media/{attachmentDataRef.resourceName}?alt=media",
        writes: false,
        authMode: "user",
        requiredScopes: MESSAGE_READ_SCOPES,
        safetyCheck:
          "Downloads only the fresh attachment from this run and verifies byte SHA-256.",
      },
    ],
  };
}

function sanitizeError(error) {
  if (error instanceof UserAuthRequiredError) {
    return {
      name: error.name,
      message: error.message,
      details: error.details,
      authorizeHint:
        "Run `corepack pnpm chat:user-auth-smoke -- --authorize --read-messages --write-messages` to grant the local user token message read/create scopes. Do not use domain-wide delegation.",
    };
  }
  if (error instanceof ChatUploadedMediaSmokeError) {
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
    path.join(
      defaultEvidenceDir,
      `chat-uploaded-media-smoke-${config.runId}.json`,
    );
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

async function loadSdkAttachmentHelpers(repoRootPath) {
  try {
    return await import(pathToFileURL(path.join(repoRootPath, "packages/node/dist/index.js")));
  } catch (error) {
    throw new Error(
      `Unable to load built Node SDK attachment helpers. Run \`corepack pnpm build\` first. ${error.message}`,
    );
  }
}

export function buildMultipartRelatedBody({
  filename,
  contentType,
  bytes,
  boundary,
}) {
  const metadata = JSON.stringify({ filename });
  const chunks = [
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from("Content-Type: application/json; charset=UTF-8\r\n\r\n"),
    Buffer.from(metadata),
    Buffer.from("\r\n"),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Type: ${contentType}\r\n\r\n`),
    Buffer.from(bytes),
    Buffer.from("\r\n"),
    Buffer.from(`--${boundary}--\r\n`),
  ];

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

function uploadUrl(space) {
  return `https://chat.googleapis.com/upload/v1/${space}/attachments:upload?uploadType=multipart`;
}

async function createUserAuthUploadedMediaClient(config) {
  const oauthClient = readOAuthClientConfig(
    await fs.readFile(resolvePath(config.credentialsPath, process.cwd()), "utf8"),
  );

  async function authorizedFetch(url, init = {}, scopes = LIVE_SCOPES) {
    return fetchWithUserAuthRetry({
      oauthClient,
      tokenStorePath: config.tokenStorePath,
      scopes,
      url,
      init,
      idempotent: (init.method ?? "GET").toUpperCase() === "GET",
    });
  }

  async function readJsonResponse(operation, result) {
    const json = await result.response.json().catch(() => ({}));

    if (!result.response.ok) {
      throw new ChatUploadedMediaSmokeError(
        operation,
        result.response.status,
        json,
      );
    }

    return {
      ok: true,
      status: result.response.status,
      json,
      refreshed: result.refreshed,
      replayedAfter401: result.replayedAfter401,
    };
  }

  return {
    async uploadAttachment({ filename, contentType, bytes }) {
      const boundary = `chat_sdk_${crypto.randomBytes(12).toString("hex")}`;
      const multipart = buildMultipartRelatedBody({
        filename,
        contentType,
        bytes,
        boundary,
      });
      const result = await authorizedFetch(
        uploadUrl(config.space),
        {
          method: "POST",
          headers: {
            "content-type": multipart.contentType,
            "content-length": String(multipart.body.byteLength),
          },
          body: multipart.body,
        },
        MESSAGE_CREATE_SCOPES,
      );
      return readJsonResponse("media.upload", result);
    },

    async createMessage(body) {
      const result = await authorizedFetch(
        `https://chat.googleapis.com/v1/${config.space}/messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
        MESSAGE_CREATE_SCOPES,
      );
      return readJsonResponse("spaces.messages.create", result);
    },

    async listMessages(query) {
      const url = new URL(`https://chat.googleapis.com/v1/${config.space}/messages`);

      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }

      const result = await authorizedFetch(url.toString(), {}, MESSAGE_READ_SCOPES);
      return readJsonResponse("spaces.messages.list", result);
    },

    async downloadMedia(url) {
      const result = await authorizedFetch(url, {}, MESSAGE_READ_SCOPES);
      const contentType = result.response.headers.get("content-type");

      if (!result.response.ok) {
        const bodyText = await result.response.text().catch(() => "");
        let bodyJson = {};
        try {
          bodyJson = bodyText ? JSON.parse(bodyText) : {};
        } catch {
          bodyJson = { error: { status: bodyText.slice(0, 120) } };
        }
        throw new ChatUploadedMediaSmokeError(
          "media.download",
          result.response.status,
          bodyJson,
        );
      }

      const buffer = new Uint8Array(await result.response.arrayBuffer());
      return {
        ok: true,
        status: result.response.status,
        bytes: buffer,
        contentType,
        refreshed: result.refreshed,
        replayedAfter401: result.replayedAfter401,
      };
    },
  };
}

function stableHash(project, value) {
  return crypto
    .createHash("sha256")
    .update(project)
    .update("\0")
    .update(value ?? "")
    .digest("hex");
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function summarizeText(project, value) {
  const text = typeof value === "string" ? value : "";
  return {
    length: text.length,
    sha256: stableHash(project, text),
  };
}

function summarizeUploadResult(config, result) {
  return {
    status: result.status,
    token: {
      refreshed: Boolean(result.refreshed),
      replayedAfter401: Boolean(result.replayedAfter401),
    },
    response: {
      attachmentNameAvailable: typeof result.json.name === "string",
      attachmentDataRefAvailable:
        typeof result.json.attachmentDataRef?.resourceName === "string" ||
        typeof result.json.attachmentDataRef?.attachmentUploadToken === "string",
      contentType: result.json.contentType ?? null,
      contentNameHash: result.json.contentName
        ? stableHash(config.metadata.displayName, result.json.contentName)
        : null,
    },
  };
}

function summarizeMessageResult(config, result) {
  return {
    status: result.status,
    token: {
      refreshed: Boolean(result.refreshed),
      replayedAfter401: Boolean(result.replayedAfter401),
    },
    response: {
      nameAvailable: typeof result.json.name === "string",
      nameHash: result.json.name
        ? stableHash(config.metadata.displayName, result.json.name)
        : null,
      attachmentCount: Array.isArray(result.json.attachment)
        ? result.json.attachment.length
        : 0,
      threadAvailable: typeof result.json.thread?.name === "string",
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

function summarizeDownloadResult(result) {
  return {
    status: result.status,
    token: {
      refreshed: Boolean(result.refreshed),
      replayedAfter401: Boolean(result.replayedAfter401),
    },
    response: {
      contentType: result.contentType,
      bytes: result.bytes.byteLength,
    },
  };
}

function summarizeAttachment(config, attachment, plan) {
  return {
    nameAvailable: typeof attachment.name === "string",
    nameHash: attachment.name
      ? stableHash(config.metadata.displayName, attachment.name)
      : null,
    contentNameAvailable: typeof attachment.contentName === "string",
    contentNameHash: attachment.contentName
      ? stableHash(config.metadata.displayName, attachment.contentName)
      : null,
    safeFilenameHash: stableHash(
      config.metadata.displayName,
      attachment.safeFilename,
    ),
    contentType: attachment.contentType,
    mediaKind: attachment.mediaKind,
    source: attachment.source,
    contentSizeBytes: attachment.contentSizeBytes,
    mediaResourceNameAvailable: typeof attachment.mediaResourceName === "string",
    policy: attachment.policy,
    downloadPlan: {
      status: plan.status,
      canExecuteLive: Boolean(plan.canExecuteLive),
      blockedReasons: plan.blockedReasons ?? [],
      liveGate: plan.liveGate,
      authScopes: plan.auth?.scopes ?? [],
    },
  };
}

function attachmentMatches(config, rawAttachment) {
  return (
    rawAttachment?.contentName === config.filename &&
    rawAttachment?.contentType === config.contentType
  );
}

function normalizeCandidate(config, sdk, message, rawAttachment) {
  const attachment = sdk.normalizeAttachment(rawAttachment, {
    context: {
      messageName: message.name ?? null,
      relationship: "space_message",
      path: message.name ? [`space_message:${message.name}`] : [],
    },
    policy: {
      maxDownloadBytes: config.maxBytes,
      maxUploadBytes: config.maxBytes,
    },
  });

  if (!attachment) {
    return null;
  }

  const plan = sdk.createDownloadPlan(attachment, {
    targetDirectory: defaultEvidenceDir,
    env: config.liveMediaEnv,
  });
  return { message, attachment, plan };
}

function findFreshAttachment(config, createdMessage, listResult, sdk) {
  const rejected = [];
  const candidates = [
    createdMessage,
    ...(listResult.messages ?? []).filter(
      (message) => message.name !== createdMessage.name,
    ),
  ];

  for (const message of candidates) {
    if (!message || message.deleteTime || message.deletionMetadata) {
      continue;
    }

    for (const rawAttachment of message.attachment ?? []) {
      if (!attachmentMatches(config, rawAttachment)) {
        rejected.push({ reason: "filter_mismatch" });
        continue;
      }

      const normalized = normalizeCandidate(config, sdk, message, rawAttachment);
      if (!normalized) {
        rejected.push({ reason: "normalization_failed" });
        continue;
      }
      if (normalized.plan.status === "blocked") {
        rejected.push({
          reason: "plan_blocked",
          blockedReasons: normalized.plan.blockedReasons ?? [],
        });
        continue;
      }

      return {
        ...normalized,
        discoveredByList: message.name !== createdMessage.name,
        rejected,
      };
    }
  }

  return {
    message: null,
    attachment: null,
    plan: null,
    discoveredByList: false,
    rejected,
  };
}

async function parseDownloadedAttachment(sdk, attachment, bytes) {
  return sdk.parseAttachmentContent(attachment, bytes, {
    parsers: {
      text: ({ data }) => {
        const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
        return {
          status: "complete",
          parser: "utf8-text-decoder",
          text,
          reason: null,
        };
      },
      json: ({ data }) => {
        const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
        JSON.parse(text);
        return {
          status: "complete",
          parser: "json-parse",
          text,
          reason: null,
        };
      },
    },
  });
}

function summarizeContextParts(config, parts) {
  const systemNote = parts.find((part) => part.type === "system_note");
  const contentPart = parts.find((part) => part.type === "attachment_content");

  return {
    count: parts.length,
    hasSystemNote: Boolean(systemNote),
    systemNote: summarizeText(config.metadata.displayName, systemNote?.text),
    hasAttachmentContentPart: Boolean(contentPart),
    attachmentContentStatus: contentPart?.status ?? null,
    attachmentContent: summarizeText(
      config.metadata.displayName,
      contentPart?.text,
    ),
    note: summarizeText(config.metadata.displayName, contentPart?.note),
  };
}

function buildCreateMessageBody(config, uploadAttachment) {
  return {
    text: `[${config.runId}] Google Chat AI SDK uploaded-media smoke. Synthetic attachment only.`,
    attachment: [uploadAttachment],
  };
}

function buildAssertions(config, upload, created, list, attachment, download, parsed, partsSummary) {
  const downloadSha256 = sha256Bytes(download.bytes);
  const listedMessageNames = new Set((list.messages ?? []).map((message) => message.name));

  return {
    uploadReturnedAttachmentName: typeof upload.json.name === "string",
    uploadReturnedAttachmentDataRef: Boolean(upload.json.attachmentDataRef),
    createdMessageHasAttachment:
      Array.isArray(created.attachment) && created.attachment.length > 0,
    createdMessageListed: created.name ? listedMessageNames.has(created.name) : false,
    freshAttachmentFound: Boolean(attachment),
    downloadedBytes: download.bytes.byteLength,
    uploadSha256: config.sourceSha256,
    downloadSha256,
    downloadedSha256MatchesUpload: downloadSha256 === config.sourceSha256,
    extractionStatus: parsed.processing.extraction.status,
    extractionParser: parsed.processing.extraction.parser,
    contextIncludesMetadataNote: partsSummary.hasSystemNote,
    contextIncludesAttachmentContent:
      partsSummary.hasAttachmentContentPart &&
      partsSummary.attachmentContent.length > 0,
  };
}

export async function runUploadedMediaSmoke(
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
        plan: buildUploadedMediaSmokePlan(config),
      },
    };
  }

  const uploadGate = liveUploadGate(config);
  if (!uploadGate.allowed) {
    throw new Error(
      `Live uploaded-media gates are not satisfied: ${uploadGate.reasons.join(", ")}`,
    );
  }

  const helpers = sdk ?? (await loadSdkAttachmentHelpers(config.repoRoot));
  const chat = client ?? (await createUserAuthUploadedMediaClient(config));
  const uploadPlan = helpers.createUploadPlan(
    {
      parent: config.space,
      filename: config.filename,
      contentType: config.contentType,
      sizeBytes: config.sourceBytes.byteLength,
    },
    {
      env: config.liveMediaEnv,
      policy: {
        maxDownloadBytes: config.maxBytes,
        maxUploadBytes: config.maxBytes,
      },
    },
  );
  const evidence = {
    ok: false,
    mode: "live",
    runId: config.runId,
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    tokenStorePath: config.tokenStorePath,
    startedAt: new Date().toISOString(),
    operations: [],
    upload: {
      source: {
        contentType: config.contentType,
        bytes: config.sourceBytes.byteLength,
        sha256: config.sourceSha256,
        filenameHash: stableHash(config.metadata.displayName, config.filename),
      },
      plan: {
        status: uploadPlan.status,
        canExecuteLive: Boolean(uploadPlan.canExecuteLive),
        liveGate: uploadPlan.liveGate,
        uploadWriteGate: uploadGate,
        authScopes: uploadPlan.auth?.scopes ?? [],
        safeFilenameHash: uploadPlan.safeFilename
          ? stableHash(config.metadata.displayName, uploadPlan.safeFilename)
          : null,
      },
    },
    message: {},
    discovery: {},
    media: {},
    assertions: {},
    privacy: {
      rawMessageTextSaved: false,
      rawAttachmentBytesSaved: false,
      rawAttachmentTextSaved: false,
      rawFilenamesSaved: false,
      rawAccessTokensSaved: false,
      senderEmailsSaved: false,
    },
  };
  let originalError = null;

  try {
    if (uploadPlan.status === "blocked") {
      throw new Error(
        `SDK upload plan blocked: ${(uploadPlan.blockedReasons ?? []).join(", ")}`,
      );
    }
    if (!uploadPlan.canExecuteLive) {
      throw new Error(
        `SDK live media gates are not satisfied: ${uploadPlan.liveGate?.reasons?.join(", ") || "unknown"}`,
      );
    }

    const upload = await recordOperation(
      evidence,
      "media.upload",
      () =>
        chat.uploadAttachment({
          filename: config.filename,
          contentType: config.contentType,
          bytes: config.sourceBytes,
        }),
      (result) => summarizeUploadResult(config, result),
    );
    const created = await recordOperation(
      evidence,
      "spaces.messages.create",
      () => chat.createMessage(buildCreateMessageBody(config, upload.json)),
      (result) => summarizeMessageResult(config, result),
    );
    const list = await recordOperation(
      evidence,
      "spaces.messages.list",
      () => chat.listMessages(buildListQuery(config)),
      summarizeListResult,
    );
    const fresh = findFreshAttachment(
      config,
      created.json,
      list.json,
      helpers,
    );

    evidence.message = {
      created: summarizeMessageResult(config, created).response,
    };
    evidence.discovery = {
      pageSize: config.pageSize,
      returnedMessages: list.json.messages?.length ?? 0,
      createdMessageListed: created.json.name
        ? (list.json.messages ?? []).some((message) => message.name === created.json.name)
        : false,
      rejectedCandidates: fresh.rejected,
      filter: {
        contentType: config.contentType,
        filenameHash: stableHash(config.metadata.displayName, config.filename),
      },
    };

    if (!fresh.attachment || !fresh.plan) {
      throw new Error("Fresh uploaded attachment was not found after message create.");
    }
    if (!fresh.plan.canExecuteLive) {
      throw new Error(
        `Live media download gates are not satisfied: ${fresh.plan.liveGate?.reasons?.join(", ") || "unknown"}`,
      );
    }

    evidence.media.attachment = summarizeAttachment(
      config,
      fresh.attachment,
      fresh.plan,
    );
    evidence.media.message = {
      source: fresh.discoveredByList ? "messages.list" : "messages.create",
      nameAvailable: typeof fresh.message?.name === "string",
      nameHash: fresh.message?.name
        ? stableHash(config.metadata.displayName, fresh.message.name)
        : null,
      createdAt: fresh.message?.createTime ?? null,
      threadAvailable: typeof fresh.message?.thread?.name === "string",
    };

    const download = await recordOperation(
      evidence,
      "media.download",
      () => chat.downloadMedia(fresh.plan.url),
      summarizeDownloadResult,
    );
    const parsed = await parseDownloadedAttachment(
      helpers,
      fresh.attachment,
      download.bytes,
    );
    const parts = helpers.renderAttachmentContextParts(parsed);
    const partsSummary = summarizeContextParts(config, parts);

    evidence.media.download = {
      bytes: download.bytes.byteLength,
      sha256: sha256Bytes(download.bytes),
      contentType: download.contentType,
    };
    evidence.media.processing = {
      extraction: {
        status: parsed.processing.extraction.status,
        parser: parsed.processing.extraction.parser,
        text: summarizeText(
          config.metadata.displayName,
          parsed.processing.extraction.text,
        ),
        reason: summarizeText(
          config.metadata.displayName,
          parsed.processing.extraction.reason,
        ),
      },
      transcription: {
        status: parsed.processing.transcription.status,
        provider: parsed.processing.transcription.provider,
        text: summarizeText(
          config.metadata.displayName,
          parsed.processing.transcription.text,
        ),
        reason: summarizeText(
          config.metadata.displayName,
          parsed.processing.transcription.reason,
        ),
      },
    };
    evidence.media.contextParts = partsSummary;
    evidence.assertions = buildAssertions(
      config,
      upload,
      created.json,
      list.json,
      fresh.attachment,
      download,
      parsed,
      partsSummary,
    );
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
    "Usage: RUN_LIVE_CHAT_UPLOADED_MEDIA_SMOKE=1 GOOGLE_CHAT_TEST_SPACE=spaces/... pnpm live:chat-uploaded-media-smoke",
    "",
    "Required for live upload/create/download:",
    "  RUN_LIVE_CHAT_UPLOADED_MEDIA_SMOKE=1",
    "  GOOGLE_CHAT_AI_W7_MEDIA_READY=1",
    "  GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA=1",
    "  GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA_UPLOAD=1",
    "  GOOGLE_CHAT_TEST_SPACE=spaces/...",
    "  GOOGLE_CHAT_SMOKE_METADATA=fixtures/live/chat-smoke-space.local.json",
    "  User OAuth token with chat.messages.readonly and chat.messages.create",
    "",
    "Authorize missing user scopes:",
    "  corepack pnpm chat:user-auth-smoke -- --authorize --read-messages --write-messages",
    "",
    "Options:",
    "  --dry-run                    Print planned API calls without uploading or sending.",
    "  --metadata <path>            Smoke-space metadata JSON path.",
    "  --evidence <path>            Evidence JSON output path.",
    "  --filename <name>            Synthetic upload filename. Default includes run id.",
    "  --content-type <mime>        Synthetic upload MIME type. Default: text/plain.",
    "  --synthetic-text <text>      Synthetic text body; evidence saves only hashes.",
    "  --max-bytes <n>              Maximum generated upload/download bytes. Default: 65536.",
    "  --page-size <n>              Message-list page size for discovery proof. Default: 6.",
    "  --start-time <RFC3339>       Discovery lower bound. Default: now minus 2m.",
    "  --end-time <RFC3339>         Discovery upper bound. Default: now plus 5m.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = await loadUploadedMediaSmokeConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runUploadedMediaSmoke(config);
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
