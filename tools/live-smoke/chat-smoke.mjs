import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  chatRequestWithAppAuth,
  createServiceAccountTokenBroker,
} from "../chat/app-auth-client.mjs";
import { resolveSmokeCustomer } from "../chat/smoke-metadata.mjs";

export const SMOKE_SPACE_PREFIX = "Google Chat AI SDK Smoke";

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
const APP_SPACE_LIFECYCLE_SCOPES = [
  "https://www.googleapis.com/auth/chat.app.spaces.create",
  "https://www.googleapis.com/auth/chat.app.delete",
];
const MAX_PAUSE_BEFORE_CLEANUP_MS = 120_000;
const MAX_THREAD_REPLY_COUNT = 5;

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
    includeMessages: true,
    includeThreadReplies: false,
    threadReplyCount: 1,
    replyToExistingThread: null,
    includeSpaceLifecycle: false,
    metadataPath: null,
    evidencePath: null,
    cleanupResources: [],
    pauseBeforeCleanupMs: 0,
    help: false,
  };
  const rest = argv.slice(2);

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--") {
      continue;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--include-space-lifecycle") {
      args.includeSpaceLifecycle = true;
    } else if (arg === "--include-thread-replies") {
      args.includeThreadReplies = true;
    } else if (arg === "--thread-reply-count") {
      args.threadReplyCount = Number(rest[++index]);
      args.includeThreadReplies = true;
    } else if (arg.startsWith("--thread-reply-count=")) {
      args.threadReplyCount = Number(arg.slice("--thread-reply-count=".length));
      args.includeThreadReplies = true;
    } else if (arg === "--reply-to-existing-thread") {
      args.replyToExistingThread = rest[++index];
    } else if (arg.startsWith("--reply-to-existing-thread=")) {
      args.replyToExistingThread = arg.slice("--reply-to-existing-thread=".length);
    } else if (arg === "--skip-messages" || arg === "--no-messages") {
      args.includeMessages = false;
    } else if (
      arg === "--skip-space-lifecycle" ||
      arg === "--no-space-lifecycle"
    ) {
      args.includeSpaceLifecycle = false;
    } else if (arg === "--metadata") {
      args.metadataPath = rest[++index];
    } else if (arg.startsWith("--metadata=")) {
      args.metadataPath = arg.slice("--metadata=".length);
    } else if (arg === "--evidence") {
      args.evidencePath = rest[++index];
    } else if (arg.startsWith("--evidence=")) {
      args.evidencePath = arg.slice("--evidence=".length);
    } else if (arg === "--cleanup-resource") {
      args.cleanupResources.push(rest[++index]);
    } else if (arg.startsWith("--cleanup-resource=")) {
      args.cleanupResources.push(arg.slice("--cleanup-resource=".length));
    } else if (arg === "--pause-before-cleanup-ms") {
      args.pauseBeforeCleanupMs = Number(rest[++index]);
    } else if (arg.startsWith("--pause-before-cleanup-ms=")) {
      args.pauseBeforeCleanupMs = Number(
        arg.slice("--pause-before-cleanup-ms=".length),
      );
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function isLifecycleSpaceCleanup(resourceName, targetSpace) {
  return resourceName.startsWith("spaces/") && resourceName !== targetSpace;
}

export function buildLiveScopes(config) {
  const scopes = [BOT_SCOPE];

  if (
    config.includeSpaceLifecycle ||
    config.cleanupResources.some((resourceName) =>
      isLifecycleSpaceCleanup(resourceName, config.space),
    )
  ) {
    scopes.push(...APP_SPACE_LIFECYCLE_SCOPES);
  }

  return scopes;
}

function normalizePauseBeforeCleanupMs(value) {
  if (value === null || value === undefined || value === "" || Number(value) === 0) {
    return 0;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("--pause-before-cleanup-ms must be a non-negative integer.");
  }
  if (value > MAX_PAUSE_BEFORE_CLEANUP_MS) {
    throw new Error(
      `--pause-before-cleanup-ms must be ${MAX_PAUSE_BEFORE_CLEANUP_MS} or less.`,
    );
  }
  return value;
}

function normalizeThreadReplyCount(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("--thread-reply-count must be a positive integer.");
  }
  if (value > MAX_THREAD_REPLY_COUNT) {
    throw new Error(
      `--thread-reply-count must be ${MAX_THREAD_REPLY_COUNT} or less.`,
    );
  }
  return value;
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

function requireThreadNameInSpace(thread, space) {
  if (thread === null || thread === undefined) {
    return null;
  }
  if (typeof thread !== "string" || !thread.startsWith(`${space}/threads/`)) {
    throw new Error(
      "--reply-to-existing-thread must be a thread in GOOGLE_CHAT_TEST_SPACE.",
    );
  }
  return thread;
}

function requireSmokeDisplayName(displayName, source) {
  if (
    typeof displayName !== "string" ||
    !displayName.startsWith(SMOKE_SPACE_PREFIX)
  ) {
    throw new Error(
      `${source} displayName must start with ${SMOKE_SPACE_PREFIX}`,
    );
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
  requireSmokeDisplayName(metadata.displayName, "metadata");

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
  requireSmokeDisplayName(space.displayName, "live space");
}

function makeRunId(env) {
  if (env.GOOGLE_CHAT_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_SMOKE_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `smoke-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function buildMessageText(runId, env) {
  return (
    env.GOOGLE_CHAT_SMOKE_MESSAGE_TEXT ??
    `${SMOKE_SPACE_PREFIX} live smoke ${runId}`
  );
}

function clientMessageId(runId) {
  const slug = String(runId)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return `client-${slug || "smoke"}`;
}

export async function loadSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_CHAT_SMOKE !== "1") {
    throw new Error(
      "Refusing to run live Chat smoke without RUN_LIVE_CHAT_SMOKE=1.",
    );
  }

  const space = env.GOOGLE_CHAT_TEST_SPACE?.trim();
  requireSmokeSpaceName(space);

  const metadataPath = resolvePath(
    args.metadataPath ?? env.GOOGLE_CHAT_SMOKE_METADATA ?? defaultMetadataPath,
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
  const evidencePath = resolvePath(
    args.evidencePath ?? env.GOOGLE_CHAT_SMOKE_EVIDENCE,
    cwd,
  );

  return {
    dryRun: args.dryRun,
    includeMessages: args.includeMessages,
    includeThreadReplies: args.includeThreadReplies,
    threadReplyCount: normalizeThreadReplyCount(args.threadReplyCount),
    replyToExistingThread: requireThreadNameInSpace(
      args.replyToExistingThread,
      space,
    ),
    includeSpaceLifecycle: args.includeSpaceLifecycle,
    space,
    metadata,
    metadataPath,
    customer: env.GOOGLE_CHAT_CUSTOMER ?? metadata.customer ?? resolveSmokeCustomer(env),
    runId,
    messageText: buildMessageText(runId, env),
    pauseBeforeCleanupMs: normalizePauseBeforeCleanupMs(
      args.pauseBeforeCleanupMs,
    ),
    credentialsPath:
      env.GOOGLE_APPLICATION_CREDENTIALS ?? defaultCredentialsPath,
    evidencePath,
    cleanupResources: args.cleanupResources.filter(Boolean),
    repoRoot,
  };
}

export function buildPlannedCalls(config) {
  const lifecycleDisplayName = `${SMOKE_SPACE_PREFIX} W7 Lifecycle ${config.runId}`;
  const calls = [
    {
      operation: "spaces.list",
      method: "GET",
      path: "/v1/spaces?pageSize=10",
      writes: false,
    },
    {
      operation: "spaces.get",
      method: "GET",
      path: `/v1/${config.space}`,
      writes: false,
      safetyCheck: "Requires live spaceType=SPACE and smoke displayName prefix.",
    },
  ];

  if (config.includeSpaceLifecycle) {
    calls.push(
      {
        operation: "spaces.create",
        method: "POST",
        path: "/v1/spaces",
        writes: true,
        requestBodyFields: ["spaceType", "displayName", "customer"],
        displayName: lifecycleDisplayName,
        safetyCheck: "Creates only a transient smoke-named SPACE.",
      },
      {
        operation: "spaces.get.lifecycle",
        method: "GET",
        path: "/v1/{createdLifecycleSpace}",
        writes: false,
      },
      {
        operation: "spaces.delete",
        method: "DELETE",
        path: "/v1/{createdLifecycleSpace}",
        writes: true,
        safetyCheck: "Deletes only the transient space created in this run.",
      },
    );
  }

  if (config.includeMessages) {
    calls.push(
      {
        operation: "spaces.messages.create",
        method: "POST",
        path: `/v1/${config.space}/messages`,
        writes: true,
        requestBodyFields: ["text"],
        bodyRedacted: true,
        safetyCheck: "Runs only after smoke-space validation succeeds.",
      },
      {
        operation: "spaces.messages.patch",
        method: "PATCH",
        path: "/v1/{createdMessage}?updateMask=text",
        writes: true,
        requestBodyFields: ["text"],
        bodyRedacted: true,
      },
      {
        operation: "spaces.messages.delete",
        method: "DELETE",
        path: "/v1/{createdMessage}",
        writes: true,
        safetyCheck: "Cleans up only the message created in this run.",
      },
    );
  }

  if (config.includeThreadReplies) {
    calls.push(
      {
        operation: "spaces.messages.create.threadRoot",
        method: "POST",
        path: `/v1/${config.space}/messages`,
        writes: true,
        requestBodyFields: ["text", "thread.threadKey", "messageId"],
        bodyRedacted: true,
        safetyCheck: "Creates only a smoke thread root in the dedicated smoke space.",
      },
      {
        operation: "spaces.messages.create.threadReply",
        method: "POST",
        path: `/v1/${config.space}/messages`,
        writes: true,
        repeat: config.threadReplyCount,
        requestBodyFields: ["text", "thread.name", "messageId"],
        bodyRedacted: true,
        safetyCheck: "Replies only inside the smoke thread created in this run.",
      },
      {
        operation: "spaces.messages.patch.threadReply",
        method: "PATCH",
        path: "/v1/{createdThreadReply}?updateMask=text",
        writes: true,
        requestBodyFields: ["text"],
        bodyRedacted: true,
      },
      {
        operation: "spaces.messages.delete.threadReply",
        method: "DELETE",
        path: "/v1/{createdThreadReply}",
        writes: true,
        safetyCheck: "Cleans up only the smoke reply created in this run.",
      },
      {
        operation: "spaces.messages.delete.threadRoot",
        method: "DELETE",
        path: "/v1/{createdThreadRoot}",
        writes: true,
        safetyCheck: "Cleans up only the smoke thread root created in this run.",
      },
    );
  }

  if (config.replyToExistingThread) {
    calls.push(
      {
        operation: "spaces.messages.create.existingThreadReply",
        method: "POST",
        path: `/v1/${config.space}/messages`,
        writes: true,
        requestBodyFields: ["text", "thread.name", "messageId"],
        bodyRedacted: true,
        safetyCheck:
          "Replies only inside an operator-supplied thread in the configured dedicated smoke space.",
      },
      {
        operation: "spaces.messages.patch.existingThreadReply",
        method: "PATCH",
        path: "/v1/{createdExistingThreadReply}?updateMask=text",
        writes: true,
        requestBodyFields: ["text"],
        bodyRedacted: true,
      },
      {
        operation: "spaces.messages.delete.existingThreadReply",
        method: "DELETE",
        path: "/v1/{createdExistingThreadReply}",
        writes: true,
        safetyCheck:
          "Cleans up only the reply created in the operator-supplied smoke thread.",
      },
    );
  }

  return {
    mode: config.dryRun ? "dry-run" : "live",
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    runId: config.runId,
    cleanupResources: config.cleanupResources,
    replyToExistingThread: config.replyToExistingThread,
    threadReplyCount: config.threadReplyCount,
    pauseBeforeCleanupMs: config.pauseBeforeCleanupMs,
    calls,
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

function summarizeSpace(space) {
  return {
    resourceName: space.name ?? null,
    displayName: space.displayName ?? null,
    spaceType: space.spaceType ?? null,
  };
}

function summarizeMessage(message) {
  return {
    resourceName: message.name ?? null,
    threadName: message.thread?.name ?? null,
    threadKey: message.thread?.threadKey ?? null,
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
    path.join(defaultEvidenceDir, `chat-smoke-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

export async function runChatSmoke(
  config,
  {
    client = null,
    writeEvidence = true,
    sleepMs = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  } = {},
) {
  if (config.help) {
    return { ok: true, evidence: { help: true } };
  }
  if (config.dryRun) {
    const evidence = {
      ok: true,
      mode: "dry-run",
      plan: buildPlannedCalls(config),
    };
    return { ok: true, evidence };
  }

  const chat = client ?? (await createChatClient(config));
  const evidence = {
    ok: false,
    mode: "live",
    runId: config.runId,
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    startedAt: new Date().toISOString(),
    operations: [],
  };
  const createdMessageNames = [];
  let createdLifecycleSpaceName = null;
  let originalError = null;

  try {
    if (config.cleanupResources.length > 0) {
      await runCleanupResources(config, chat, evidence);
      evidence.finishedAt = new Date().toISOString();
      evidence.ok = true;

      if (writeEvidence) {
        evidence.evidencePath = await writeEvidenceFile(config, evidence);
      }

      return { ok: true, evidence };
    }

    await recordOperation(evidence, "spaces.list", () =>
      chat.listSpaces({ pageSize: 10 }),
    );

    const targetSpace = await recordOperation(
      evidence,
      "spaces.get",
      () => chat.getSpace(config.space),
      summarizeSpace,
    );
    requireLiveSmokeSpace(targetSpace);

    if (config.includeSpaceLifecycle) {
      const displayName = `${SMOKE_SPACE_PREFIX} W7 Lifecycle ${config.runId}`;
      const body = {
        spaceType: "SPACE",
        displayName,
      };
      if (config.customer) {
        body.customer = config.customer;
      }

      const lifecycleSpace = await recordOperation(
        evidence,
        "spaces.create",
        () => chat.createSpace(body, { requestId: config.runId }),
        summarizeSpace,
      );
      createdLifecycleSpaceName = lifecycleSpace.name;
      const checkedLifecycleSpace = await recordOperation(
        evidence,
        "spaces.get.lifecycle",
        () => chat.getSpace(createdLifecycleSpaceName),
        summarizeSpace,
      );
      requireLiveSmokeSpace(checkedLifecycleSpace);
    }

    if (config.includeMessages) {
      const message = await recordOperation(
        evidence,
        "spaces.messages.create",
        () =>
          chat.createMessage(config.space, {
            text: config.messageText,
          }, {
            requestId: `message-create-${config.runId}`,
            messageId: clientMessageId(config.runId),
          }),
        summarizeMessage,
      );
      createdMessageNames.push(message.name);

      await recordOperation(
        evidence,
        "spaces.messages.patch",
        () =>
          chat.patchMessage(message.name, {
            text: `${config.messageText} edited ${config.runId}`,
          }),
        summarizeMessage,
      );
    }

    if (config.includeThreadReplies) {
      const threadKey = `smoke-thread-${config.runId}`;
      const root = await recordOperation(
        evidence,
        "spaces.messages.create.threadRoot",
        () =>
          chat.createMessage(
            config.space,
            {
              text: `${config.messageText} thread root ${config.runId}`,
              thread: { threadKey },
            },
            {
              requestId: `thread-root-${config.runId}`,
              messageId: clientMessageId(`${config.runId}-thread-root`),
              messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
            },
          ),
        summarizeMessage,
      );
      createdMessageNames.push(root.name);
      const threadName = root.thread?.name;
      if (!threadName) {
        throw new Error("Thread root response did not include thread.name.");
      }

      let lastReply = null;
      for (let replyIndex = 1; replyIndex <= config.threadReplyCount; replyIndex += 1) {
        const replySuffix = config.threadReplyCount === 1 ? "" : `.${replyIndex}`;
        const reply = await recordOperation(
          evidence,
          `spaces.messages.create.threadReply${replySuffix}`,
          () =>
            chat.createMessage(
              config.space,
              {
                text: `${config.messageText} thread reply ${replyIndex} ${config.runId}`,
                thread: { name: threadName },
              },
              {
                requestId: `thread-reply-${replyIndex}-${config.runId}`,
                messageId: clientMessageId(
                  `${config.runId}-thread-reply-${replyIndex}`,
                ),
                messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
              },
            ),
          summarizeMessage,
        );
        createdMessageNames.push(reply.name);
        lastReply = reply;
      }

      if (lastReply) {
        await recordOperation(
          evidence,
          "spaces.messages.patch.threadReply",
          () =>
            chat.patchMessage(lastReply.name, {
              text: `${config.messageText} thread reply ${config.threadReplyCount} edited ${config.runId}`,
            }),
          summarizeMessage,
        );
      }
    }

    if (config.replyToExistingThread) {
      const reply = await recordOperation(
        evidence,
        "spaces.messages.create.existingThreadReply",
        () =>
          chat.createMessage(
            config.space,
            {
              text: `${config.messageText} existing thread reply ${config.runId}`,
              thread: { name: config.replyToExistingThread },
            },
            {
              requestId: `existing-thread-reply-${config.runId}`,
              messageId: clientMessageId(`${config.runId}-existing-thread-reply`),
              messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
            },
          ),
        summarizeMessage,
      );
      createdMessageNames.push(reply.name);

      await recordOperation(
        evidence,
        "spaces.messages.patch.existingThreadReply",
        () =>
          chat.patchMessage(reply.name, {
            text: `${config.messageText} existing thread reply edited ${config.runId}`,
          }),
        summarizeMessage,
      );
    }
  } catch (error) {
    originalError = error;
  } finally {
    if (
      originalError === null &&
      config.pauseBeforeCleanupMs > 0 &&
      createdMessageNames.length > 0
    ) {
      try {
        await recordOperation(
          evidence,
          "pause.beforeCleanup",
          async () => {
            await sleepMs(config.pauseBeforeCleanupMs);
            return { pauseBeforeCleanupMs: config.pauseBeforeCleanupMs };
          },
          (result) => result,
        );
      } catch (cleanupPauseError) {
        originalError ??= cleanupPauseError;
      }
    }

    for (const createdMessageName of [...createdMessageNames].reverse()) {
      try {
        await recordOperation(
          evidence,
          "spaces.messages.delete",
          () => chat.deleteMessage(createdMessageName),
          () => ({ resourceName: createdMessageName }),
        );
      } catch (cleanupError) {
        originalError ??= cleanupError;
      }
    }

    if (createdLifecycleSpaceName) {
      try {
        await recordOperation(
          evidence,
          "spaces.delete",
          () => chat.deleteSpace(createdLifecycleSpaceName),
          () => ({ resourceName: createdLifecycleSpaceName }),
        );
      } catch (cleanupError) {
        originalError ??= cleanupError;
      }
    }
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

async function runCleanupResources(config, chat, evidence) {
  const targetSpace = await recordOperation(
    evidence,
    "spaces.get",
    () => chat.getSpace(config.space),
    summarizeSpace,
  );
  requireLiveSmokeSpace(targetSpace);

  for (const resourceName of config.cleanupResources) {
    if (resourceName.startsWith(`${config.space}/messages/`)) {
      await recordOperation(
        evidence,
        "cleanup.spaces.messages.delete",
        () => chat.deleteMessage(resourceName),
        () => ({ resourceName }),
      );
      continue;
    }

    if (resourceName.startsWith("spaces/") && resourceName !== config.space) {
      const cleanupSpace = await recordOperation(
        evidence,
        "cleanup.spaces.get",
        () => chat.getSpace(resourceName),
        summarizeSpace,
      );
      requireLiveSmokeSpace(cleanupSpace);

      if (
        typeof cleanupSpace.displayName !== "string" ||
        !cleanupSpace.displayName.startsWith(`${SMOKE_SPACE_PREFIX} W7 Lifecycle`)
      ) {
        throw new Error(
          "cleanup space displayName must identify a W7 lifecycle smoke space.",
        );
      }

      await recordOperation(
        evidence,
        "cleanup.spaces.delete",
        () => chat.deleteSpace(resourceName),
        () => ({ resourceName }),
      );
      continue;
    }

    throw new Error(
      `Refusing cleanup for resource outside the configured smoke run: ${resourceName}`,
    );
  }
}

async function createChatClient(config) {
  const serviceAccount = JSON.parse(
    await fs.readFile(config.credentialsPath, "utf8"),
  );
  const scopes = buildLiveScopes(config);
  const getAccessToken = createServiceAccountTokenBroker(serviceAccount, scopes);

  return {
    listSpaces: ({ pageSize }) =>
      chatRequest(serviceAccount, scopes, getAccessToken, "spaces", {
        query: { pageSize: String(pageSize) },
      }),
    getSpace: (name) =>
      chatRequest(serviceAccount, scopes, getAccessToken, name),
    createSpace: (body, { requestId }) =>
      chatRequest(serviceAccount, scopes, getAccessToken, "spaces", {
        method: "POST",
        query: { requestId },
        body,
        idempotent: Boolean(requestId),
      }),
    deleteSpace: (name) =>
      chatRequest(serviceAccount, scopes, getAccessToken, name, {
        method: "DELETE",
        idempotent: true,
      }),
    createMessage: (
      parent,
      body,
      { requestId, messageId, messageReplyOption } = {},
    ) =>
      chatRequest(serviceAccount, scopes, getAccessToken, `${parent}/messages`, {
        method: "POST",
        query: { requestId, messageId, messageReplyOption },
        body,
        idempotent: Boolean(requestId || messageId),
      }),
    patchMessage: (name, body) =>
      chatRequest(serviceAccount, scopes, getAccessToken, name, {
        method: "PATCH",
        query: { updateMask: "text" },
        body,
        idempotent: true,
      }),
    deleteMessage: (name) =>
      chatRequest(serviceAccount, scopes, getAccessToken, name, {
        method: "DELETE",
        idempotent: true,
      }),
  };
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

function usage() {
  return `${[
    "Usage: RUN_LIVE_CHAT_SMOKE=1 GOOGLE_CHAT_TEST_SPACE=spaces/... pnpm live:chat-smoke [--dry-run]",
    "",
    "Required:",
    "  RUN_LIVE_CHAT_SMOKE=1",
    "  GOOGLE_CHAT_TEST_SPACE=spaces/...",
    "  GOOGLE_CHAT_SMOKE_METADATA=fixtures/live/chat-smoke-space.local.json",
    "",
    "Options:",
    "  --dry-run                 Print planned API calls without network writes.",
    "  --metadata <path>         Smoke-space metadata JSON path.",
    "  --evidence <path>         Evidence JSON output path.",
    "  --cleanup-resource <name> Delete a message or transient W7 lifecycle space from evidence.",
    "  --include-space-lifecycle Include legacy app-auth transient create/get/delete space checks.",
    "  --include-thread-replies  Create, patch, and clean up a smoke thread root/reply pair.",
    `  --thread-reply-count <n> Create n smoke-thread replies, max ${MAX_THREAD_REPLY_COUNT}; implies --include-thread-replies.`,
    "  --reply-to-existing-thread <thread.name>",
    "                             Create, patch, and clean up one reply inside an existing smoke-space thread.",
    "  --pause-before-cleanup-ms <ms>",
    `                             Pause after successful writes before cleanup, max ${MAX_PAUSE_BEFORE_CLEANUP_MS} ms.`,
    "  --skip-space-lifecycle    Deprecated no-op; lifecycle checks are skipped by default.",
    "  --skip-messages           Skip message create/edit/delete checks.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = await loadSmokeConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runChatSmoke(config);
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
