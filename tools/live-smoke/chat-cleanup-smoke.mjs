import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  chatRequestWithAppAuth,
  createServiceAccountTokenBroker,
} from "../chat/app-auth-client.mjs";
import { SMOKE_SPACE_PREFIX } from "./chat-smoke.mjs";

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
const DEFAULT_MIN_AGE_MINUTES = 15;

class ChatApiError extends Error {
  constructor(operation, status, response) {
    super(`${operation} failed with HTTP ${status}`);
    this.name = "ChatApiError";
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
    evidenceDir: null,
    minAgeMinutes: DEFAULT_MIN_AGE_MINUTES,
    limit: 50,
    help: false,
  };
  const rest = argv.slice(2);

  const readRequiredValue = (index, option) => {
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value.`);
    }
    return value;
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--") {
      continue;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--metadata") {
      args.metadataPath = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--metadata=")) {
      args.metadataPath = arg.slice("--metadata=".length);
    } else if (arg === "--evidence") {
      args.evidencePath = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--evidence=")) {
      args.evidencePath = arg.slice("--evidence=".length);
    } else if (arg === "--evidence-dir") {
      args.evidenceDir = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--evidence-dir=")) {
      args.evidenceDir = arg.slice("--evidence-dir=".length);
    } else if (arg === "--min-age-minutes") {
      args.minAgeMinutes = Number(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--min-age-minutes=")) {
      args.minAgeMinutes = Number(arg.slice("--min-age-minutes=".length));
    } else if (arg === "--limit") {
      args.limit = Number(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--limit=")) {
      args.limit = Number(arg.slice("--limit=".length));
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

function requireNonNegativeNumber(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function makeRunId(env) {
  if (env.GOOGLE_CHAT_CLEANUP_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_CLEANUP_SMOKE_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `cleanup-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export async function loadCleanupSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_CHAT_CLEANUP_SMOKE !== "1") {
    throw new Error(
      "Refusing to run cleanup smoke without RUN_LIVE_CHAT_CLEANUP_SMOKE=1.",
    );
  }

  const space = env.GOOGLE_CHAT_TEST_SPACE?.trim();
  requireSmokeSpaceName(space);
  requireNonNegativeNumber(args.minAgeMinutes, "--min-age-minutes");
  requirePositiveInteger(args.limit, "--limit");

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

  return {
    dryRun: args.dryRun,
    liveCleanupEnabled: env.GOOGLE_CHAT_AI_ENABLE_LIVE_CLEANUP === "1",
    space,
    metadata,
    metadataPath,
    evidenceDir: resolvePath(args.evidenceDir, cwd) ?? defaultEvidenceDir,
    minAgeMinutes: args.minAgeMinutes,
    limit: args.limit,
    runId: makeRunId(env),
    credentialsPath:
      env.GOOGLE_APPLICATION_CREDENTIALS ?? defaultCredentialsPath,
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_CLEANUP_SMOKE_EVIDENCE,
      cwd,
    ),
  };
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update("googlechatai-cleanup-smoke")
    .update("\0")
    .update(String(value ?? ""))
    .digest("hex");
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function parseTime(value) {
  if (typeof value !== "string") {
    return null;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function resourceNameFromOperation(operation) {
  if (typeof operation?.resourceName === "string") {
    return operation.resourceName;
  }
  if (typeof operation?.name === "string") {
    return operation.name;
  }
  return null;
}

function isMessageName(value, space) {
  return typeof value === "string" && value.startsWith(`${space}/messages/`);
}

function sourceTimeForEvidence(evidence, operation) {
  return (
    operation?.finishedAt ??
    operation?.startedAt ??
    evidence.finishedAt ??
    evidence.startedAt ??
    null
  );
}

export function extractEvidenceResources({ filePath, evidence, space }) {
  const created = [];
  const deleted = [];
  const targetSpace =
    typeof evidence.targetSpace === "string" ? evidence.targetSpace : null;
  const runId = typeof evidence.runId === "string" ? evidence.runId : null;

  for (const resource of Array.isArray(evidence.resourcesCreated)
    ? evidence.resourcesCreated
    : []) {
    if (resource?.kind !== "message" || !isMessageName(resource.name, space)) {
      continue;
    }
    created.push({
      messageName: resource.name,
      label: resource.label ?? null,
      runId,
      sourceFile: filePath,
      sourceKind: "resourcesCreated",
      sourceTime: evidence.finishedAt ?? evidence.startedAt ?? null,
      targetSpace,
    });
  }

  for (const operation of Array.isArray(evidence.operations)
    ? evidence.operations
    : []) {
    const name = resourceNameFromOperation(operation);
    if (!isMessageName(name, space)) {
      continue;
    }
    if (operation.ok === true && /(^|\.|_)create$|messages\.create$/.test(operation.operation ?? "")) {
      created.push({
        messageName: name,
        label: operation.operation ?? null,
        runId,
        sourceFile: filePath,
        sourceKind: "operation.create",
        sourceTime: sourceTimeForEvidence(evidence, operation),
        targetSpace,
      });
    }
    if (operation.ok === true && /delete/.test(operation.operation ?? "")) {
      deleted.push({
        messageName: name,
        runId,
        sourceFile: filePath,
        sourceKind: "operation.delete",
        sourceTime: sourceTimeForEvidence(evidence, operation),
      });
    }
  }

  return { created, deleted };
}

async function readJsonEvidence(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? { ok: true, parsed } : { ok: false };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function listEvidenceFiles(evidenceDir) {
  const entries = await fs.readdir(evidenceDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(evidenceDir, entry.name))
    .sort();
}

function summarizeCandidate(candidate) {
  return {
    messageName: candidate.messageName,
    messageNameHash: stableHash(candidate.messageName),
    runId: candidate.runId,
    label: candidate.label,
    sourceFile: path.relative(repoRoot, candidate.sourceFile),
    sourceKind: candidate.sourceKind,
    sourceTime: candidate.sourceTime,
    ageMinutes: candidate.ageMinutes,
  };
}

export async function discoverCleanupCandidates(
  config,
  { now = Date.now() } = {},
) {
  const files = await listEvidenceFiles(config.evidenceDir);
  const createdByName = new Map();
  const deletedNames = new Set();
  const skippedFiles = [];

  for (const filePath of files) {
    const result = await readJsonEvidence(filePath);
    if (!result.ok) {
      skippedFiles.push({
        file: path.relative(repoRoot, filePath),
        reason: result.error ?? "not_json_object",
      });
      continue;
    }

    const { created, deleted } = extractEvidenceResources({
      filePath,
      evidence: result.parsed,
      space: config.space,
    });

    for (const item of created) {
      if (!createdByName.has(item.messageName)) {
        createdByName.set(item.messageName, item);
      }
    }
    for (const item of deleted) {
      deletedNames.add(item.messageName);
    }
  }

  const candidates = [];
  const ignored = [];
  const minAgeMs = config.minAgeMinutes * 60 * 1000;

  for (const candidate of createdByName.values()) {
    if (deletedNames.has(candidate.messageName)) {
      ignored.push({
        ...candidate,
        reason: "local_delete_evidence_found",
      });
      continue;
    }

    const sourceMillis = parseTime(candidate.sourceTime);
    const ageMs = sourceMillis === null ? null : now - sourceMillis;
    if (ageMs !== null && ageMs < minAgeMs) {
      ignored.push({
        ...candidate,
        ageMinutes: Math.max(0, Math.round(ageMs / 60_000)),
        reason: "too_recent",
      });
      continue;
    }

    candidates.push({
      ...candidate,
      ageMinutes:
        ageMs === null ? null : Math.max(0, Math.round(ageMs / 60_000)),
    });
  }

  candidates.sort((left, right) =>
    String(left.sourceTime ?? "").localeCompare(String(right.sourceTime ?? "")),
  );

  return {
    evidenceFilesScanned: files.length,
    skippedFiles,
    candidates: candidates.slice(0, config.limit),
    ignored,
    limitApplied: candidates.length > config.limit,
    totalCandidateCount: candidates.length,
  };
}

export function buildCleanupPlan(config, discovery) {
  return {
    mode: config.dryRun ? "dry-run" : "live",
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    evidenceDir: config.evidenceDir,
    minAgeMinutes: config.minAgeMinutes,
    limit: config.limit,
    liveCleanupEnabled: config.liveCleanupEnabled,
    candidates: discovery.candidates.map(summarizeCandidate),
    counts: {
      evidenceFilesScanned: discovery.evidenceFilesScanned,
      candidates: discovery.candidates.length,
      ignored: discovery.ignored.length,
      skippedFiles: discovery.skippedFiles.length,
    },
  };
}

function sanitizeError(error) {
  if (error instanceof ChatApiError) {
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

async function writeEvidenceFile(config, evidence) {
  const evidencePath =
    config.evidencePath ??
    path.join(defaultEvidenceDir, `chat-cleanup-smoke-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
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

async function runLiveCleanup(config, client, discovery, evidence) {
  const space = await recordOperation(
    evidence,
    "spaces.get",
    () => client.getSpace(config.space),
    (result) => ({
      resourceName: result.name ?? null,
      displayName: result.displayName ?? null,
      spaceType: result.spaceType ?? null,
    }),
  );
  requireLiveSmokeSpace(space);

  for (const candidate of discovery.candidates) {
    await recordOperation(
      evidence,
      "cleanup.stale-message.delete",
      async () => {
        try {
          await client.deleteMessage(candidate.messageName);
          return {
            messageName: candidate.messageName,
            deleted: true,
            alreadyMissing: false,
          };
        } catch (error) {
          if (error instanceof ChatApiError && error.status === 404) {
            return {
              messageName: candidate.messageName,
              deleted: false,
              alreadyMissing: true,
            };
          }
          throw error;
        }
      },
      (result) => ({
        resourceName: result.messageName,
        resourceNameHash: stableHash(result.messageName),
        deleted: result.deleted,
        alreadyMissing: result.alreadyMissing,
      }),
    );
  }
}

export async function runCleanupSmoke(
  config,
  { client = null, writeEvidence = true, now = Date.now() } = {},
) {
  if (config.help) {
    return { ok: true, evidence: { help: true } };
  }

  const discovery = await discoverCleanupCandidates(config, { now });
  const evidence = {
    ok: false,
    mode: config.dryRun ? "dry-run" : "live",
    runId: config.runId,
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    evidenceDir: config.evidenceDir,
    minAgeMinutes: config.minAgeMinutes,
    limit: config.limit,
    startedAt: new Date().toISOString(),
    plan: buildCleanupPlan(config, discovery),
    candidates: discovery.candidates.map(summarizeCandidate),
    ignored: discovery.ignored.map((candidate) => ({
      ...summarizeCandidate(candidate),
      reason: candidate.reason,
    })),
    skippedFiles: discovery.skippedFiles,
    operations: [],
    privacy: {
      rawMessageTextSaved: false,
      rawAccessTokensSaved: false,
      senderEmailsSaved: false,
    },
  };
  let originalError = null;

  try {
    if (!config.dryRun) {
      if (!config.liveCleanupEnabled) {
        throw new Error(
          "Refusing live cleanup without GOOGLE_CHAT_AI_ENABLE_LIVE_CLEANUP=1.",
        );
      }
      await runLiveCleanup(config, client ?? (await createChatClient(config)), discovery, evidence);
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
    const wrapped = new Error(originalError.message);
    wrapped.cause = originalError;
    wrapped.evidence = evidence;
    throw wrapped;
  }

  return { ok: true, evidence };
}

async function chatRequest(
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
    throw new ChatApiError(`${method} /v1/${resourcePath}`, result.status, result.json);
  }

  return result.json;
}

async function createChatClient(config) {
  const serviceAccount = JSON.parse(
    await fs.readFile(config.credentialsPath, "utf8"),
  );
  const scopes = [BOT_SCOPE];
  const getAccessToken = createServiceAccountTokenBroker(serviceAccount, scopes);

  return {
    getSpace: (name) =>
      chatRequest(serviceAccount, scopes, getAccessToken, name),
    deleteMessage: (name) =>
      chatRequest(serviceAccount, scopes, getAccessToken, name, {
        method: "DELETE",
        idempotent: true,
      }),
  };
}

function usage() {
  return `${[
    "Usage: RUN_LIVE_CHAT_CLEANUP_SMOKE=1 pnpm live:chat-cleanup-smoke -- --dry-run",
    "",
    "Scans ignored live evidence for app-created smoke messages that appear not to have matching local delete evidence.",
    "Dry-run is read-only. Live cleanup additionally requires GOOGLE_CHAT_AI_ENABLE_LIVE_CLEANUP=1.",
    "",
    "Options:",
    "  --dry-run                 Build the stale cleanup plan without deleting.",
    "  --metadata <path>         Smoke-space metadata JSON path.",
    "  --evidence-dir <path>     Evidence directory. Default: fixtures/live/evidence.",
    "  --evidence <path>         Evidence JSON output path.",
    "  --min-age-minutes <n>     Minimum candidate age. Default: 15.",
    "  --limit <n>               Maximum stale messages to include. Default: 50.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = await loadCleanupSmokeConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runCleanupSmoke(config);
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
