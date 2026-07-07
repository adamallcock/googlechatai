import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SMOKE_SPACE_PREFIX } from "./chat-smoke.mjs";
import { fetchWithUserAuthRetry } from "../chat/user-auth-client.mjs";
import {
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

class ChatMediaDownloadError extends Error {
  constructor(operation, status, response) {
    super(`${operation} failed with HTTP ${status}`);
    this.name = "ChatMediaDownloadError";
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
    limit: 12,
    pageSize: 6,
    startTime: null,
    endTime: null,
    contentType: "text/plain",
    filenameContains: null,
    expectSha256: null,
    maxBytes: 1024 * 1024,
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
    } else if (arg === "--content-type") {
      args.contentType = rest[++index];
    } else if (arg.startsWith("--content-type=")) {
      args.contentType = arg.slice("--content-type=".length);
    } else if (arg === "--filename-contains") {
      args.filenameContains = rest[++index];
    } else if (arg.startsWith("--filename-contains=")) {
      args.filenameContains = arg.slice("--filename-contains=".length);
    } else if (arg === "--expect-sha256") {
      args.expectSha256 = rest[++index];
    } else if (arg.startsWith("--expect-sha256=")) {
      args.expectSha256 = arg.slice("--expect-sha256=".length);
    } else if (arg === "--max-bytes") {
      args.maxBytes = Number(rest[++index]);
    } else if (arg.startsWith("--max-bytes=")) {
      args.maxBytes = Number(arg.slice("--max-bytes=".length));
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

function requireSha256(value) {
  if (
    value !== null &&
    !/^[a-f0-9]{64}$/i.test(String(value))
  ) {
    throw new Error("--expect-sha256 must be a 64-character hex SHA-256 digest.");
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
  if (env.GOOGLE_CHAT_MEDIA_DOWNLOAD_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_MEDIA_DOWNLOAD_SMOKE_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `media-download-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function defaultStartTime(env) {
  if (env.GOOGLE_CHAT_MEDIA_DOWNLOAD_START_TIME) {
    return env.GOOGLE_CHAT_MEDIA_DOWNLOAD_START_TIME;
  }
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function defaultEndTime(env) {
  if (env.GOOGLE_CHAT_MEDIA_DOWNLOAD_END_TIME) {
    return env.GOOGLE_CHAT_MEDIA_DOWNLOAD_END_TIME;
  }
  return new Date(Date.now() + 5 * 60 * 1000).toISOString();
}

export async function loadMediaDownloadSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_CHAT_MEDIA_DOWNLOAD_SMOKE !== "1") {
    throw new Error(
      "Refusing to run media-download Chat smoke without RUN_LIVE_CHAT_MEDIA_DOWNLOAD_SMOKE=1.",
    );
  }

  const space = env.GOOGLE_CHAT_TEST_SPACE?.trim();
  requireSmokeSpaceName(space);
  requirePositiveInteger(args.limit, "--limit");
  requirePositiveInteger(args.pageSize, "--page-size");
  requirePositiveInteger(args.maxBytes, "--max-bytes");
  requireSha256(args.expectSha256);

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
    startTime: args.startTime ?? defaultStartTime(env),
    endTime: args.endTime ?? defaultEndTime(env),
    contentType: args.contentType,
    filenameContains: args.filenameContains,
    expectSha256: args.expectSha256?.toLowerCase() ?? null,
    maxBytes: args.maxBytes,
    liveMediaEnv: {
      GOOGLE_CHAT_AI_W7_MEDIA_READY: env.GOOGLE_CHAT_AI_W7_MEDIA_READY,
      GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA: env.GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA,
    },
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_MEDIA_DOWNLOAD_SMOKE_EVIDENCE,
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

export function buildMediaDownloadPlan(config) {
  return {
    mode: config.dryRun ? "dry-run" : "live",
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    runId: config.runId,
    discovery: {
      limit: config.limit,
      pageSize: config.pageSize,
      startTime: config.startTime,
      endTime: config.endTime,
      contentType: config.contentType,
      filenameFilterProvided: Boolean(config.filenameContains),
      maxBytes: config.maxBytes,
    },
    calls: [
      {
        operation: "media.messages.list.attachments",
        method: "GET",
        path: `/v1/${config.space}/messages`,
        query: buildListQuery(config),
        writes: false,
        authMode: "user",
        requiredScopes: MESSAGE_READ_SCOPES,
        safetyCheck: "Read-only discovery in dedicated smoke space metadata.",
      },
      {
        operation: "media.download",
        method: "GET",
        path: "/v1/media/{attachmentDataRef.resourceName}?alt=media",
        writes: false,
        authMode: "user",
        requiredScopes: MESSAGE_READ_SCOPES,
        liveGates: [
          "RUN_LIVE_CHAT_MEDIA_DOWNLOAD_SMOKE=1",
          "GOOGLE_CHAT_AI_W7_MEDIA_READY=1",
          "GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA=1",
        ],
        safetyCheck:
          "Downloads only the first matching allowed attachment in the dedicated smoke space; evidence hashes bytes and parser output.",
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
        "Run `corepack pnpm chat:user-auth-smoke -- --authorize --read-messages` to grant the local user token chat.messages.readonly. Do not use domain-wide delegation.",
    };
  }
  if (error instanceof ChatMediaDownloadError) {
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
      `chat-media-download-smoke-${config.runId}.json`,
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

async function createUserAuthMediaClient(config) {
  const oauthClient = readOAuthClientConfig(
    await fs.readFile(resolvePath(config.credentialsPath, process.cwd()), "utf8"),
  );

  async function authorizedFetch(url, init = {}) {
    return fetchWithUserAuthRetry({
      oauthClient,
      tokenStorePath: config.tokenStorePath,
      scopes: MESSAGE_READ_SCOPES,
      url,
      init,
      idempotent: (init.method ?? "GET").toUpperCase() === "GET",
    });
  }

  return {
    async listMessages(query) {
      const url = new URL(`https://chat.googleapis.com/v1/${config.space}/messages`);

      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }

      const result = await authorizedFetch(url.toString());
      const json = await result.response.json().catch(() => ({}));

      if (!result.response.ok) {
        throw new ChatMediaDownloadError(
          "spaces.messages.list",
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
    },

    async downloadMedia(url) {
      const result = await authorizedFetch(url);
      const contentType = result.response.headers.get("content-type");

      if (!result.response.ok) {
        const bodyText = await result.response.text().catch(() => "");
        let bodyJson = {};
        try {
          bodyJson = bodyText ? JSON.parse(bodyText) : {};
        } catch {
          bodyJson = { error: { status: bodyText.slice(0, 120) } };
        }
        throw new ChatMediaDownloadError(
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

function queryWithPageToken(query, pageToken) {
  if (!pageToken) {
    return query;
  }
  return {
    ...query,
    pageToken,
  };
}

async function fetchMessagePages({ config, client, evidence }) {
  const query = buildListQuery(config);
  const responses = [];
  let pageToken = null;

  while (responses.reduce((sum, page) => sum + (page.messages?.length ?? 0), 0) < config.limit) {
    const result = await recordOperation(
      evidence,
      `media.messages.list.${responses.length + 1}`,
      () => client.listMessages(queryWithPageToken(query, pageToken)),
      summarizeListResult,
    );
    responses.push(result.json);
    pageToken = result.json.nextPageToken ?? null;

    if (!pageToken) {
      break;
    }
  }

  return responses;
}

function stableHash(project, value) {
  return crypto
    .createHash("sha256")
    .update(project)
    .update("\0")
    .update(value)
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

function attachmentMatches(config, rawAttachment) {
  if (
    config.contentType &&
    rawAttachment.contentType !== config.contentType
  ) {
    return false;
  }

  if (
    config.filenameContains &&
    typeof rawAttachment.contentName === "string" &&
    !rawAttachment.contentName.includes(config.filenameContains)
  ) {
    return false;
  }

  if (config.filenameContains && typeof rawAttachment.contentName !== "string") {
    return false;
  }

  return true;
}

function summarizeAttachment(config, attachment, plan) {
  return {
    nameAvailable: typeof attachment.name === "string",
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
    context: {
      messageNameAvailable: typeof attachment.context.messageName === "string",
      relationship: attachment.context.relationship,
      pathDepth: attachment.context.path.length,
    },
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

function findCandidateAttachment(config, responses, sdk) {
  const rejected = [];

  for (const response of responses) {
    for (const message of response.messages ?? []) {
      if (message.deleteTime || message.deletionMetadata) {
        continue;
      }

      for (const rawAttachment of message.attachment ?? []) {
        if (!attachmentMatches(config, rawAttachment)) {
          rejected.push({ reason: "filter_mismatch" });
          continue;
        }

        const attachment = sdk.normalizeAttachment(rawAttachment, {
          context: {
            messageName: message.name ?? null,
            relationship: "space_message",
            path: message.name ? [`space_message:${message.name}`] : [],
          },
          policy: {
            maxDownloadBytes: config.maxBytes,
          },
        });

        if (!attachment) {
          rejected.push({ reason: "normalization_failed" });
          continue;
        }

        const plan = sdk.createDownloadPlan(attachment, {
          targetDirectory: defaultEvidenceDir,
          env: config.liveMediaEnv,
        });

        if (plan.status === "blocked") {
          rejected.push({
            reason: "plan_blocked",
            blockedReasons: plan.blockedReasons ?? [],
          });
          continue;
        }

        return { message, attachment, plan, rejected };
      }
    }
  }

  return { message: null, attachment: null, plan: null, rejected };
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

function buildAssertions(config, attachment, download, parsed, partsSummary) {
  const bytesSha256 = sha256Bytes(download.bytes);
  return {
    attachmentFound: Boolean(attachment),
    downloadedBytes: download.bytes.byteLength,
    downloadSha256: bytesSha256,
    expectedSha256Matches: config.expectSha256
      ? bytesSha256 === config.expectSha256
      : null,
    extractionStatus: parsed.processing.extraction.status,
    extractionParser: parsed.processing.extraction.parser,
    contextIncludesMetadataNote: partsSummary.hasSystemNote,
    contextIncludesAttachmentContent:
      partsSummary.hasAttachmentContentPart &&
      partsSummary.attachmentContent.length > 0,
  };
}

export async function runMediaDownloadSmoke(
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
        plan: buildMediaDownloadPlan(config),
      },
    };
  }

  const helpers = sdk ?? (await loadSdkAttachmentHelpers(config.repoRoot));
  const chat = client ?? (await createUserAuthMediaClient(config));
  const evidence = {
    ok: false,
    mode: "live",
    runId: config.runId,
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    tokenStorePath: config.tokenStorePath,
    startedAt: new Date().toISOString(),
    operations: [],
    media: {},
    assertions: {},
    privacy: {
      rawMessageTextSaved: false,
      rawAttachmentBytesSaved: false,
      rawAttachmentTextSaved: false,
      rawAccessTokensSaved: false,
      senderEmailsSaved: false,
    },
  };
  let originalError = null;

  try {
    const responses = await fetchMessagePages({
      config,
      client: chat,
      evidence,
    });
    const { message, attachment, plan, rejected } = findCandidateAttachment(
      config,
      responses,
      helpers,
    );

    evidence.discovery = {
      pages: responses.length,
      returnedMessages: responses.flatMap((response) => response.messages ?? []).length,
      rejectedCandidates: rejected,
      filter: {
        contentType: config.contentType,
        filenameFilterProvided: Boolean(config.filenameContains),
      },
    };

    if (!attachment || !plan) {
      throw new Error("No matching downloadable attachment found in the smoke space.");
    }

    evidence.media.attachment = summarizeAttachment(config, attachment, plan);
    evidence.media.message = {
      nameAvailable: typeof message?.name === "string",
      createdAt: message?.createTime ?? null,
      threadAvailable: typeof message?.thread?.name === "string",
    };

    if (!plan.canExecuteLive) {
      throw new Error(
        `Live media download gates are not satisfied: ${plan.liveGate?.reasons?.join(", ") || "unknown"}`,
      );
    }

    const download = await recordOperation(
      evidence,
      "media.download",
      () => chat.downloadMedia(plan.url),
      summarizeDownloadResult,
    );
    const parsed = await parseDownloadedAttachment(
      helpers,
      attachment,
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
      attachment,
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
    "Usage: RUN_LIVE_CHAT_MEDIA_DOWNLOAD_SMOKE=1 GOOGLE_CHAT_TEST_SPACE=spaces/... pnpm live:chat-media-download-smoke",
    "",
    "Required for live download:",
    "  RUN_LIVE_CHAT_MEDIA_DOWNLOAD_SMOKE=1",
    "  GOOGLE_CHAT_AI_W7_MEDIA_READY=1",
    "  GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA=1",
    "  GOOGLE_CHAT_TEST_SPACE=spaces/...",
    "  GOOGLE_CHAT_SMOKE_METADATA=fixtures/live/chat-smoke-space.local.json",
    "  User OAuth token with https://www.googleapis.com/auth/chat.messages.readonly",
    "",
    "Authorize missing message-read scope:",
    "  corepack pnpm chat:user-auth-smoke -- --authorize --read-messages",
    "",
    "Options:",
    "  --dry-run                    Print planned read-only API calls without reads/downloads.",
    "  --metadata <path>            Smoke-space metadata JSON path.",
    "  --evidence <path>            Evidence JSON output path.",
    "  --limit <n>                  Maximum messages to inspect. Default: 12.",
    "  --page-size <n>              API page size. Default: 6.",
    "  --start-time <RFC3339>       Date filter lower bound. Default: now minus 24h.",
    "  --end-time <RFC3339>         Date filter upper bound. Default: now plus 5m.",
    "  --content-type <mime>        Attachment content type to download. Default: text/plain.",
    "  --filename-contains <text>   Optional content-name filter; evidence saves only hashes.",
    "  --expect-sha256 <digest>     Optional expected downloaded byte digest.",
    "  --max-bytes <n>              Maximum allowed attachment bytes. Default: 1048576.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = await loadMediaDownloadSmokeConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runMediaDownloadSmoke(config);
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
