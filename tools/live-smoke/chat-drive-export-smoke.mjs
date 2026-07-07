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
const DRIVE_READ_SCOPES = USER_AUTH_SCOPES.readDrive;
const DRIVE_FILE_SCOPES = USER_AUTH_SCOPES.writeDrive;
const DEFAULT_SOURCE_CONTENT_TYPE = "application/vnd.google-apps.document";
const SYNTHETIC_KINDS = {
  "blob-text": {
    sourceContentType: "text/plain",
    mediaContentType: "text/plain",
    workspace: false,
    defaultExtension: ".txt",
    expectedTextFromBody: true,
  },
  doc: {
    sourceContentType: "application/vnd.google-apps.document",
    mediaContentType: "text/plain",
    workspace: true,
    defaultExtension: ".txt",
    expectedTextFromBody: true,
  },
  sheet: {
    sourceContentType: "application/vnd.google-apps.spreadsheet",
    mediaContentType: "text/csv",
    workspace: true,
    defaultExtension: ".csv",
    expectedTextFromBody: true,
  },
  slide: {
    sourceContentType: "application/vnd.google-apps.presentation",
    mediaContentType: null,
    workspace: true,
    defaultExtension: "",
    expectedTextFromBody: false,
  },
};

class DriveExportSmokeError extends Error {
  constructor(operation, status, response) {
    super(`${operation} failed with HTTP ${status}`);
    this.name = "DriveExportSmokeError";
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
    driveFileId: null,
    sourceContentType: DEFAULT_SOURCE_CONTENT_TYPE,
    exportMimeType: null,
    createSynthetic: null,
    syntheticText: null,
    keepCreatedFile: false,
    expectText: null,
    expectSha256: null,
    maxBytes: 10 * 1024 * 1024,
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
    } else if (arg === "--drive-file-id") {
      args.driveFileId = rest[++index];
    } else if (arg.startsWith("--drive-file-id=")) {
      args.driveFileId = arg.slice("--drive-file-id=".length);
    } else if (arg === "--source-content-type") {
      args.sourceContentType = rest[++index];
    } else if (arg.startsWith("--source-content-type=")) {
      args.sourceContentType = arg.slice("--source-content-type=".length);
    } else if (arg === "--export-mime-type") {
      args.exportMimeType = rest[++index];
    } else if (arg.startsWith("--export-mime-type=")) {
      args.exportMimeType = arg.slice("--export-mime-type=".length);
    } else if (arg === "--create-synthetic") {
      args.createSynthetic = rest[++index];
    } else if (arg.startsWith("--create-synthetic=")) {
      args.createSynthetic = arg.slice("--create-synthetic=".length);
    } else if (arg === "--synthetic-text") {
      args.syntheticText = rest[++index];
    } else if (arg.startsWith("--synthetic-text=")) {
      args.syntheticText = arg.slice("--synthetic-text=".length);
    } else if (arg === "--keep-created-file") {
      args.keepCreatedFile = true;
    } else if (arg === "--expect-text") {
      args.expectText = rest[++index];
    } else if (arg.startsWith("--expect-text=")) {
      args.expectText = arg.slice("--expect-text=".length);
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
  if (value !== null && !/^[a-f0-9]{64}$/i.test(String(value))) {
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
  if (env.GOOGLE_CHAT_DRIVE_EXPORT_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_DRIVE_EXPORT_SMOKE_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `drive-export-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export async function loadDriveExportSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_CHAT_DRIVE_EXPORT_SMOKE !== "1") {
    throw new Error(
      "Refusing to run Drive export smoke without RUN_LIVE_CHAT_DRIVE_EXPORT_SMOKE=1.",
    );
  }

  const space = env.GOOGLE_CHAT_TEST_SPACE?.trim();
  requireSmokeSpaceName(space);
  requirePositiveInteger(args.maxBytes, "--max-bytes");
  requireSha256(args.expectSha256);

  const createSynthetic = args.createSynthetic ?? env.GOOGLE_CHAT_DRIVE_EXPORT_CREATE_SYNTHETIC ?? null;
  if (createSynthetic && !SYNTHETIC_KINDS[createSynthetic]) {
    throw new Error(
      `--create-synthetic must be one of: ${Object.keys(SYNTHETIC_KINDS).join(", ")}.`,
    );
  }
  const syntheticKind = createSynthetic ? SYNTHETIC_KINDS[createSynthetic] : null;
  const driveFileId = args.driveFileId ?? env.GOOGLE_CHAT_DRIVE_EXPORT_FILE_ID ?? null;
  if (!driveFileId && !createSynthetic) {
    throw new Error("--drive-file-id or GOOGLE_CHAT_DRIVE_EXPORT_FILE_ID is required.");
  }
  const runId = makeRunId(env);
  const syntheticText =
    args.syntheticText ??
    env.GOOGLE_CHAT_DRIVE_EXPORT_SYNTHETIC_TEXT ??
    `Google Chat AI SDK Drive smoke ${runId}`;
  const sourceContentType = syntheticKind?.sourceContentType ?? args.sourceContentType;
  const expectText =
    args.expectText ??
    (syntheticKind?.expectedTextFromBody ? syntheticText : null);

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
    runId,
    credentialsPath: userAuthConfig.credentialsPath,
    tokenStorePath: userAuthConfig.tokenStorePath,
    driveFileId,
    sourceContentType,
    exportMimeType: args.exportMimeType,
    createSynthetic,
    synthetic: createSynthetic
      ? {
          kind: createSynthetic,
          sourceContentType,
          mediaContentType: syntheticKind.mediaContentType,
          workspace: syntheticKind.workspace,
          defaultExtension: syntheticKind.defaultExtension,
          text: syntheticText,
          textHash: stableHash(metadata.displayName, syntheticText),
          cleanupCreatedFile: !args.keepCreatedFile,
        }
      : null,
    expectText,
    expectSha256: args.expectSha256?.toLowerCase() ?? null,
    maxBytes: args.maxBytes,
    driveScopes: createSynthetic
      ? [...new Set([...DRIVE_READ_SCOPES, ...DRIVE_FILE_SCOPES])]
      : DRIVE_READ_SCOPES,
    liveDriveEnv: {
      GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE: env.GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE,
      GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE_WRITE: env.GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE_WRITE,
    },
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_DRIVE_EXPORT_SMOKE_EVIDENCE,
      cwd,
    ),
    repoRoot,
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

export function buildDriveExportSmokePlan(config) {
  return {
    mode: config.dryRun ? "dry-run" : "live",
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    runId: config.runId,
    driveFileIdProvided: Boolean(config.driveFileId),
    driveFileIdHash: config.driveFileId
      ? stableHash(config.metadata.displayName, config.driveFileId)
      : null,
    createSynthetic: config.synthetic
      ? {
          kind: config.synthetic.kind,
          sourceContentType: config.synthetic.sourceContentType,
          mediaContentType: config.synthetic.mediaContentType,
          workspace: config.synthetic.workspace,
          textHash: config.synthetic.textHash,
          cleanupCreatedFile: config.synthetic.cleanupCreatedFile,
        }
      : null,
    sourceContentType: config.sourceContentType,
    exportMimeType: config.exportMimeType,
    maxBytes: config.maxBytes,
    calls: [
      ...(config.synthetic
        ? [
            {
              operation: "drive.files.create.synthetic",
              method: config.synthetic.mediaContentType ? "POST multipart" : "POST",
              path: config.synthetic.mediaContentType
                ? "/upload/drive/v3/files?uploadType=multipart"
                : "/drive/v3/files",
              writes: true,
              authMode: "user",
              requiredScopes: config.driveScopes,
              liveGates: [
                "RUN_LIVE_CHAT_DRIVE_EXPORT_SMOKE=1",
                "GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE=1",
                "GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE_WRITE=1",
              ],
              safetyCheck:
                "Creates only a synthetic smoke file owned by the installing user; evidence hashes file ids/names and cleanup trashes by default.",
            },
          ]
        : []),
      {
        operation: "drive.files.get.metadata",
        method: "GET",
        path: "/drive/v3/files/{fileId}?fields=id,name,mimeType,size,modifiedTime,capabilities/canDownload",
        writes: false,
        authMode: "user",
        requiredScopes: config.driveScopes,
        safetyCheck:
          "Reads metadata for a synthetic Drive file already attached in the dedicated smoke space.",
      },
      {
        operation: "drive.files.export-or-download",
        method: "GET",
        path: "/drive/v3/files/{fileId}/export or /drive/v3/files/{fileId}?alt=media",
        writes: false,
        authMode: "user",
        requiredScopes: config.driveScopes,
        liveGates: [
          "RUN_LIVE_CHAT_DRIVE_EXPORT_SMOKE=1",
          "GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE=1",
        ],
        safetyCheck:
          "Exports only the configured synthetic Drive file; evidence stores hashes/status, not raw bytes or document text.",
      },
      ...(config.synthetic?.cleanupCreatedFile
        ? [
            {
              operation: "drive.files.update.trash",
              method: "PATCH",
              path: "/drive/v3/files/{fileId}",
              writes: true,
              authMode: "user",
              requiredScopes: config.driveScopes,
              liveGates: [
                "RUN_LIVE_CHAT_DRIVE_EXPORT_SMOKE=1",
                "GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE=1",
                "GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE_WRITE=1",
              ],
              safetyCheck:
                "Trashes only the file created by this synthetic smoke run.",
            },
          ]
        : []),
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
        "Run `corepack pnpm chat:user-auth-smoke -- --authorize --read-drive` to grant the local user token drive.readonly. Do not use domain-wide delegation.",
    };
  }
  if (error instanceof DriveExportSmokeError) {
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
      `chat-drive-export-smoke-${config.runId}.json`,
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

async function parseErrorBody(response) {
  const bodyText = await response.text().catch(() => "");
  try {
    return bodyText ? JSON.parse(bodyText) : {};
  } catch {
    return { error: { status: bodyText.slice(0, 120) } };
  }
}

function requireDriveWriteGate(config) {
  if (config.liveDriveEnv.GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE_WRITE !== "1") {
    throw new Error(
      "Live synthetic Drive file writes require GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE_WRITE=1.",
    );
  }
}

function syntheticFileName(config) {
  const extension = config.synthetic?.defaultExtension ?? "";
  const base = `Google Chat AI SDK Drive Smoke ${config.synthetic.kind} ${config.runId}`;
  return extension && !base.endsWith(extension) ? `${base}${extension}` : base;
}

function syntheticMediaBytes(config) {
  const text =
    config.synthetic.kind === "sheet"
      ? `run_id,value\n${config.runId},42\n${config.synthetic.text},ok\n`
      : `${config.synthetic.text}\n`;
  return new TextEncoder().encode(text);
}

function buildMultipartBody({ metadata, mediaBytes, mediaContentType }) {
  const boundary = `chat_ai_sdk_${crypto.randomBytes(8).toString("hex")}`;
  const chunks = [
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(JSON.stringify(metadata)),
    Buffer.from(`\r\n--${boundary}\r\ncontent-type: ${mediaContentType}\r\n\r\n`),
    Buffer.from(mediaBytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  return {
    contentType: `multipart/related; boundary=${boundary}`,
    body: Buffer.concat(chunks),
  };
}

async function createUserAuthDriveClient(config) {
  const oauthClient = readOAuthClientConfig(
    await fs.readFile(resolvePath(config.credentialsPath, process.cwd()), "utf8"),
  );

  async function authorizedFetch(url, init = {}) {
    return fetchWithUserAuthRetry({
      oauthClient,
      tokenStorePath: config.tokenStorePath,
      scopes: config.driveScopes,
      url,
      init,
      idempotent:
        (init.method ?? "GET").toUpperCase() === "GET" ||
        Boolean(init.idempotent),
    });
  }

  return {
    async createSyntheticFile() {
      requireDriveWriteGate(config);
      const metadata = {
        name: syntheticFileName(config),
        mimeType: config.synthetic.sourceContentType,
      };
      const fields = "id,name,mimeType,size,modifiedTime,trashed";
      const mediaContentType = config.synthetic.mediaContentType;
      const url = mediaContentType
        ? new URL("https://www.googleapis.com/upload/drive/v3/files")
        : new URL("https://www.googleapis.com/drive/v3/files");
      url.searchParams.set("fields", fields);

      let body;
      let headers = { accept: "application/json" };
      if (mediaContentType) {
        url.searchParams.set("uploadType", "multipart");
        const multipart = buildMultipartBody({
          metadata,
          mediaBytes: syntheticMediaBytes(config),
          mediaContentType,
        });
        body = multipart.body;
        headers = {
          ...headers,
          "content-type": multipart.contentType,
        };
      } else {
        body = JSON.stringify(metadata);
        headers = {
          ...headers,
          "content-type": "application/json",
        };
      }

      const result = await authorizedFetch(url.toString(), {
        method: "POST",
        headers,
        body,
      });
      const json = await result.response.json().catch(() => ({}));

      if (!result.response.ok) {
        throw new DriveExportSmokeError(
          "drive.files.create.synthetic",
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

    async getMetadata(fileId) {
      const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
      url.searchParams.set(
        "fields",
        "id,name,mimeType,size,modifiedTime,capabilities/canDownload",
      );
      const result = await authorizedFetch(url.toString(), {
        headers: { accept: "application/json" },
      });
      const json = await result.response.json().catch(() => ({}));

      if (!result.response.ok) {
        throw new DriveExportSmokeError(
          "drive.files.get.metadata",
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

    async exportContent(url) {
      const result = await authorizedFetch(url);
      const contentType = result.response.headers.get("content-type");

      if (!result.response.ok) {
        throw new DriveExportSmokeError(
          "drive.files.export-or-download",
          result.response.status,
          await parseErrorBody(result.response),
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

    async trashFile(fileId) {
      requireDriveWriteGate(config);
      const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
      url.searchParams.set("fields", "id,trashed");
      const result = await authorizedFetch(url.toString(), {
        method: "PATCH",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ trashed: true }),
      });
      const json = await result.response.json().catch(() => ({}));

      if (!result.response.ok) {
        throw new DriveExportSmokeError(
          "drive.files.update.trash",
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
  };
}

function summarizeMetadata(config, result) {
  return {
    status: result.status,
    token: {
      refreshed: Boolean(result.refreshed),
      replayedAfter401: Boolean(result.replayedAfter401),
    },
    response: {
      idMatchesRequested: result.json.id === config.driveFileId,
      nameAvailable: typeof result.json.name === "string",
      nameHash: result.json.name
        ? stableHash(config.metadata.displayName, result.json.name)
        : null,
      mimeType: result.json.mimeType ?? null,
      sizeAvailable: typeof result.json.size === "string",
      modifiedTimeAvailable: typeof result.json.modifiedTime === "string",
      canDownload: result.json.capabilities?.canDownload ?? null,
    },
  };
}

function summarizeSyntheticCreate(config, result) {
  return {
    status: result.status,
    token: {
      refreshed: Boolean(result.refreshed),
      replayedAfter401: Boolean(result.replayedAfter401),
    },
    response: {
      idHash: result.json.id
        ? stableHash(config.metadata.displayName, result.json.id)
        : null,
      nameHash: result.json.name
        ? stableHash(config.metadata.displayName, result.json.name)
        : null,
      mimeType: result.json.mimeType ?? null,
      sizeAvailable: typeof result.json.size === "string",
      modifiedTimeAvailable: typeof result.json.modifiedTime === "string",
      trashed: result.json.trashed ?? null,
    },
  };
}

function summarizeTrashResult(config, result) {
  return {
    status: result.status,
    token: {
      refreshed: Boolean(result.refreshed),
      replayedAfter401: Boolean(result.replayedAfter401),
    },
    response: {
      idHash: result.json.id
        ? stableHash(config.metadata.displayName, result.json.id)
        : null,
      trashed: result.json.trashed ?? null,
    },
  };
}

function summarizeExportResult(result) {
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

function buildDriveAttachment(config, sdk, metadata) {
  return sdk.normalizeAttachment(
    {
      name: "drive-files/redacted/attachments/drive-export",
      contentName: metadata.name ?? "drive-export",
      contentType: metadata.mimeType ?? config.sourceContentType,
      contentSizeBytes: Number.isFinite(Number(metadata.size))
        ? Number(metadata.size)
        : null,
      source: "DRIVE_FILE",
      driveDataRef: {
        driveFileId: config.driveFileId,
      },
    },
    {
      context: {
        messageName: null,
        relationship: "drive_attachment",
        path: ["drive_attachment:redacted"],
      },
      policy: {
        maxDownloadBytes: config.maxBytes,
      },
    },
  );
}

function buildExportedAttachment(config, sdk, attachment, exported) {
  const contentType =
    exported.contentType?.split(";")[0] ??
    config.exportMimeType ??
    "application/octet-stream";
  return sdk.normalizeAttachment(
    {
      name: attachment.name,
      contentName: attachment.contentName,
      contentType,
      contentSizeBytes: exported.bytes.byteLength,
      source: "DRIVE_FILE",
      driveDataRef: {
        driveFileId: config.driveFileId,
      },
    },
    {
      context: attachment.context,
      policy: {
        maxDownloadBytes: config.maxBytes,
      },
    },
  );
}

function summarizePlan(plan) {
  return {
    status: plan.status,
    canExecuteLive: Boolean(plan.canExecuteLive),
    liveGate: plan.liveGate,
    blockedReasons: plan.blockedReasons ?? [],
    contentApi: plan.contentApi,
    method: plan.method,
    driveFileIdAvailable: Boolean(plan.driveFileIdAvailable),
    sourceContentType: plan.sourceContentType,
    exportMimeType: plan.exportMimeType,
    maxExportBytes: plan.maxExportBytes,
    authScopes: plan.auth?.scopes ?? [],
  };
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
    driveFileIdAvailable: typeof attachment.driveDataRef?.driveFileId === "string",
    context: {
      messageNameAvailable: typeof attachment.context.messageName === "string",
      relationship: attachment.context.relationship,
      pathDepth: attachment.context.path.length,
    },
    policy: attachment.policy,
    driveExportPlan: summarizePlan(plan),
  };
}

async function parseExportedAttachment(sdk, attachment, bytes) {
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

function buildAssertions(config, exportResult, parsed, partsSummary) {
  const bytesSha256 = sha256Bytes(exportResult.bytes);
  const extractedText = parsed.processing.extraction.text ?? "";
  return {
    metadataRead: true,
    exportedBytes: exportResult.bytes.byteLength,
    exportSha256: bytesSha256,
    expectedSha256Matches: config.expectSha256
      ? bytesSha256 === config.expectSha256
      : null,
    expectedTextFound: config.expectText
      ? extractedText.includes(config.expectText)
      : null,
    extractionStatus: parsed.processing.extraction.status,
    extractionParser: parsed.processing.extraction.parser,
    contextIncludesMetadataNote: partsSummary.hasSystemNote,
    contextIncludesAttachmentContent:
      partsSummary.hasAttachmentContentPart &&
      partsSummary.attachmentContent.length > 0,
  };
}

function assertionFailures(assertions) {
  const failures = [];

  if (assertions.expectedSha256Matches === false) {
    failures.push("expected_sha256_mismatch");
  }
  if (assertions.expectedTextFound === false) {
    failures.push("expected_text_missing");
  }

  return failures;
}

export async function runDriveExportSmoke(
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
        plan: buildDriveExportSmokePlan(config),
      },
    };
  }

  const helpers = sdk ?? (await loadSdkAttachmentHelpers(config.repoRoot));
  const drive = client ?? (await createUserAuthDriveClient(config));
  const evidence = {
    ok: false,
    mode: "live",
    runId: config.runId,
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    tokenStorePath: config.tokenStorePath,
    driveFileIdHash: config.driveFileId
      ? stableHash(config.metadata.displayName, config.driveFileId)
      : null,
    createSynthetic: config.synthetic
      ? {
          kind: config.synthetic.kind,
          sourceContentType: config.synthetic.sourceContentType,
          mediaContentType: config.synthetic.mediaContentType,
          workspace: config.synthetic.workspace,
          textHash: config.synthetic.textHash,
          cleanupCreatedFile: config.synthetic.cleanupCreatedFile,
        }
      : null,
    startedAt: new Date().toISOString(),
    operations: [],
    drive: {},
    assertions: {},
    expectedText: config.expectText
      ? {
          provided: true,
          sha256: stableHash(config.metadata.displayName, config.expectText),
        }
      : { provided: false },
    privacy: {
      rawDriveFileIdSaved: false,
      rawDriveFileNameSaved: false,
      rawExportBytesSaved: false,
      rawExportTextSaved: false,
      rawAccessTokensSaved: false,
      syntheticFileContentSaved: false,
    },
  };
  let originalError = null;
  let activeConfig = config;
  let createdDriveFileId = null;

  try {
    if (config.synthetic) {
      requireDriveWriteGate(config);
      const created = await recordOperation(
        evidence,
        "drive.files.create.synthetic",
        () => drive.createSyntheticFile(),
        (result) => summarizeSyntheticCreate(config, result),
      );
      createdDriveFileId = created.json.id;
      if (typeof createdDriveFileId !== "string") {
        throw new Error("Synthetic Drive file creation did not return an id.");
      }
      activeConfig = {
        ...config,
        driveFileId: createdDriveFileId,
        sourceContentType: created.json.mimeType ?? config.sourceContentType,
      };
      evidence.drive.synthetic = {
        created: summarizeSyntheticCreate(config, created).response,
      };
    }

    const metadata = await recordOperation(
      evidence,
      "drive.files.get.metadata",
      () => drive.getMetadata(activeConfig.driveFileId),
      (result) => summarizeMetadata(activeConfig, result),
    );
    const attachment = buildDriveAttachment(activeConfig, helpers, metadata.json);
    const plan = helpers.createDriveExportPlan(attachment, {
      targetDirectory: defaultEvidenceDir,
      exportMimeType: activeConfig.exportMimeType,
      env: activeConfig.liveDriveEnv,
    });

    evidence.drive.metadata = summarizeMetadata(activeConfig, metadata).response;
    evidence.drive.attachment = summarizeAttachment(activeConfig, attachment, plan);

    if (plan.status === "blocked") {
      throw new Error(
        `Drive export plan is blocked: ${plan.blockedReasons?.join(", ") || "unknown"}`,
      );
    }
    if (!plan.canExecuteLive) {
      throw new Error(
        `Live Drive export gates are not satisfied: ${plan.liveGate?.reasons?.join(", ") || "unknown"}`,
      );
    }

    const exported = await recordOperation(
      evidence,
      "drive.files.export-or-download",
      () => drive.exportContent(plan.url),
      summarizeExportResult,
    );

    if (exported.bytes.byteLength > config.maxBytes) {
      throw new Error(
        `Drive export exceeded --max-bytes (${exported.bytes.byteLength} > ${config.maxBytes}).`,
      );
    }

    const exportedAttachment = buildExportedAttachment(
      activeConfig,
      helpers,
      attachment,
      exported,
    );
    const parsed = await parseExportedAttachment(
      helpers,
      exportedAttachment,
      exported.bytes,
    );
    const parts = helpers.renderAttachmentContextParts(parsed);
    const partsSummary = summarizeContextParts(activeConfig, parts);

    evidence.drive.export = {
      bytes: exported.bytes.byteLength,
      sha256: sha256Bytes(exported.bytes),
      contentType: exported.contentType,
    };
    evidence.drive.processing = {
      extraction: {
        status: parsed.processing.extraction.status,
        parser: parsed.processing.extraction.parser,
        text: summarizeText(
          activeConfig.metadata.displayName,
          parsed.processing.extraction.text,
        ),
        reason: summarizeText(
          activeConfig.metadata.displayName,
          parsed.processing.extraction.reason,
        ),
      },
      transcription: {
        status: parsed.processing.transcription.status,
        provider: parsed.processing.transcription.provider,
        text: summarizeText(
          activeConfig.metadata.displayName,
          parsed.processing.transcription.text,
        ),
        reason: summarizeText(
          activeConfig.metadata.displayName,
          parsed.processing.transcription.reason,
        ),
      },
    };
    evidence.drive.contextParts = partsSummary;
    evidence.assertions = buildAssertions(
      activeConfig,
      exported,
      parsed,
      partsSummary,
    );
    evidence.assertionFailures = assertionFailures(evidence.assertions);

    if (evidence.assertionFailures.length > 0) {
      throw new Error(
        `Drive export assertions failed: ${evidence.assertionFailures.join(", ")}`,
      );
    }
  } catch (error) {
    originalError = error;
  }

  if (createdDriveFileId && config.synthetic?.cleanupCreatedFile) {
    try {
      const trashed = await recordOperation(
        evidence,
        "drive.files.update.trash",
        () => drive.trashFile(createdDriveFileId),
        (result) => summarizeTrashResult(config, result),
      );
      evidence.drive.synthetic = {
        ...(evidence.drive.synthetic ?? {}),
        cleanup: summarizeTrashResult(config, trashed).response,
      };
    } catch (cleanupError) {
      originalError ??= cleanupError;
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
    "Usage: RUN_LIVE_CHAT_DRIVE_EXPORT_SMOKE=1 GOOGLE_CHAT_TEST_SPACE=spaces/... pnpm live:chat-drive-export-smoke -- --drive-file-id <id>",
    "",
    "Required for live Drive export/download:",
    "  RUN_LIVE_CHAT_DRIVE_EXPORT_SMOKE=1",
    "  GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE=1",
    "  GOOGLE_CHAT_TEST_SPACE=spaces/...",
    "  GOOGLE_CHAT_SMOKE_METADATA=fixtures/live/chat-smoke-space.local.json",
    "  User OAuth token with https://www.googleapis.com/auth/drive.readonly",
    "  Add https://www.googleapis.com/auth/drive.file only when --create-synthetic is used",
    "",
    "Authorize missing Drive scope:",
    "  corepack pnpm chat:user-auth-smoke -- --authorize --read-drive",
    "  corepack pnpm chat:user-auth-smoke -- --authorize --read-drive --write-drive",
    "",
    "Options:",
    "  --dry-run                    Print planned read-only Drive API calls without reads/downloads.",
    "  --metadata <path>            Smoke-space metadata JSON path.",
    "  --evidence <path>            Evidence JSON output path.",
    "  --drive-file-id <id>         Drive file id for the synthetic smoke attachment.",
    "  --source-content-type <mime> Source Drive MIME type. Default: Google Docs.",
    "  --export-mime-type <mime>    Optional export MIME type for Google Workspace files.",
    "  --create-synthetic <kind>    Create a synthetic blob-text, doc, sheet, or slide before export/download.",
    "  --synthetic-text <text>      Text/CSV content for synthetic blob/doc/sheet files; evidence saves only hashes.",
    "  --keep-created-file          Do not trash the synthetic file after the run.",
    "  --expect-text <text>         Optional expected exported text; evidence saves only hash/found flag.",
    "  --expect-sha256 <digest>     Optional expected exported byte digest.",
    "  --max-bytes <n>              Maximum exported bytes. Default: 10485760.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = await loadDriveExportSmokeConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runDriveExportSmoke(config);
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
