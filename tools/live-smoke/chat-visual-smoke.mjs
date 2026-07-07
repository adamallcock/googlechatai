import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  chatRequestWithAppAuth,
  createServiceAccountTokenBroker,
} from "../chat/app-auth-client.mjs";
import {
  buildFeedbackAccessoryMessage,
  buildSourcesCard,
  buildStreamingStatusCard,
  buildThinkingCard,
  buildToolStatusCard,
  hydratePlaceholderResponseHandle,
  planBufferedStreamMessage,
  planCompletePlaceholderResponse,
  planPlaceholderResponse,
} from "../../packages/node/dist/index.js";
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
const DEFAULT_BASE_URL =
  "https://chat-ai-sdk-dev-webhook-zhmcqkt5jq-uc.a.run.app/api";
const DEFAULT_STREAM_PATCH_COUNT = 3;
const DEFAULT_BUFFERED_STREAM_MIN_PATCH_CHARS = 32;
const MAX_STREAM_PATCH_COUNT = 20;
const MAX_STREAM_PATCH_DELAY_MS = 5_000;
const MAX_BUFFERED_STREAM_MIN_PATCH_CHARS = 1_000;

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
    includeRichCard: false,
    includeCarouselCard: false,
    includeAiCardComponents: false,
    usePlaceholderResponse: false,
    useBufferedStream: false,
    cleanupFromEvidence: null,
    metadataPath: null,
    evidencePath: null,
    placeholderConfigPath: null,
    streamPatchCount: DEFAULT_STREAM_PATCH_COUNT,
    streamPatchDelayMs: 0,
    streamMinPatchChars: DEFAULT_BUFFERED_STREAM_MIN_PATCH_CHARS,
    help: false,
  };
  const rest = argv.slice(2);

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--") {
      continue;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--include-rich-card") {
      args.includeRichCard = true;
    } else if (arg === "--include-carousel-card") {
      args.includeCarouselCard = true;
    } else if (arg === "--include-ai-card-components") {
      args.includeAiCardComponents = true;
    } else if (arg === "--use-placeholder-response") {
      args.usePlaceholderResponse = true;
    } else if (arg === "--use-buffered-stream") {
      args.useBufferedStream = true;
    } else if (arg === "--metadata") {
      args.metadataPath = rest[++index];
    } else if (arg.startsWith("--metadata=")) {
      args.metadataPath = arg.slice("--metadata=".length);
    } else if (arg === "--evidence") {
      args.evidencePath = rest[++index];
    } else if (arg.startsWith("--evidence=")) {
      args.evidencePath = arg.slice("--evidence=".length);
    } else if (arg === "--placeholder-config") {
      args.placeholderConfigPath = rest[++index];
    } else if (arg.startsWith("--placeholder-config=")) {
      args.placeholderConfigPath = arg.slice("--placeholder-config=".length);
    } else if (arg === "--stream-patch-count") {
      args.streamPatchCount = Number(rest[++index]);
    } else if (arg.startsWith("--stream-patch-count=")) {
      args.streamPatchCount = Number(arg.slice("--stream-patch-count=".length));
    } else if (arg === "--stream-patch-delay-ms") {
      args.streamPatchDelayMs = Number(rest[++index]);
    } else if (arg.startsWith("--stream-patch-delay-ms=")) {
      args.streamPatchDelayMs = Number(arg.slice("--stream-patch-delay-ms=".length));
    } else if (arg === "--stream-min-patch-chars") {
      args.streamMinPatchChars = Number(rest[++index]);
    } else if (arg.startsWith("--stream-min-patch-chars=")) {
      args.streamMinPatchChars = Number(
        arg.slice("--stream-min-patch-chars=".length),
      );
    } else if (arg === "--cleanup-from-evidence") {
      args.cleanupFromEvidence = rest[++index];
    } else if (arg.startsWith("--cleanup-from-evidence=")) {
      args.cleanupFromEvidence = arg.slice("--cleanup-from-evidence=".length);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function normalizeStreamPatchCount(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("--stream-patch-count must be a positive integer.");
  }
  if (value > MAX_STREAM_PATCH_COUNT) {
    throw new Error(
      `--stream-patch-count must be ${MAX_STREAM_PATCH_COUNT} or less.`,
    );
  }
  return value;
}

function normalizeStreamPatchDelayMs(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("--stream-patch-delay-ms must be a non-negative integer.");
  }
  if (value > MAX_STREAM_PATCH_DELAY_MS) {
    throw new Error(
      `--stream-patch-delay-ms must be ${MAX_STREAM_PATCH_DELAY_MS} or less.`,
    );
  }
  return value;
}

function normalizeStreamMinPatchChars(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("--stream-min-patch-chars must be a positive integer.");
  }
  if (value > MAX_BUFFERED_STREAM_MIN_PATCH_CHARS) {
    throw new Error(
      `--stream-min-patch-chars must be ${MAX_BUFFERED_STREAM_MIN_PATCH_CHARS} or less.`,
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
  if (env.GOOGLE_CHAT_VISUAL_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_VISUAL_SMOKE_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `visual-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function clientMessageId(runId, label) {
  const slug = `${runId}-${label}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return `client-${slug || "visual-smoke"}`;
}

function parseCsvPlaceholders(raw) {
  const values = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];

    if (char === "\"") {
      if (quoted && next === "\"") {
        field += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && (char === "," || char === "\n" || char === "\r")) {
      values.push(field.trim());
      field = "";
      if (char === "\r" && next === "\n") {
        index += 1;
      }
    } else {
      field += char;
    }
  }
  values.push(field.trim());

  return values.filter(Boolean);
}

async function readPlaceholderConfigFile(configPath) {
  const raw = await fs.readFile(configPath, "utf8");
  const extension = path.extname(configPath).toLowerCase();

  if (extension === ".csv") {
    const texts = parseCsvPlaceholders(raw);
    if (texts.length === 0) {
      throw new Error(`Placeholder config ${configPath} has no non-empty CSV values.`);
    }
    return {
      format: "csv",
      input: { placeholderTexts: texts },
    };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) && (!parsed || typeof parsed !== "object")) {
      throw new Error("JSON must be an array or object.");
    }
    return {
      format: "json",
      input: Array.isArray(parsed)
        ? { placeholderTexts: parsed }
        : { placeholderConfig: parsed },
    };
  } catch (error) {
    throw new Error(
      `Unable to read placeholder config at ${configPath}: ${error.message}`,
    );
  }
}

export async function loadVisualSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_CHAT_VISUAL_SMOKE !== "1") {
    throw new Error(
      "Refusing to run visual Chat smoke without RUN_LIVE_CHAT_VISUAL_SMOKE=1.",
    );
  }

  const space = env.GOOGLE_CHAT_TEST_SPACE?.trim();
  requireSmokeSpaceName(space);

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
  const placeholderConfigPath = resolvePath(
    args.placeholderConfigPath ?? env.GOOGLE_CHAT_PLACEHOLDER_CONFIG,
    cwd,
  );
  const placeholderConfig = placeholderConfigPath
    ? await readPlaceholderConfigFile(placeholderConfigPath)
    : null;

  return {
    dryRun: args.dryRun,
    includeRichCard: args.includeRichCard,
    includeCarouselCard: args.includeCarouselCard,
    includeAiCardComponents: args.includeAiCardComponents,
    usePlaceholderResponse: args.usePlaceholderResponse,
    useBufferedStream: args.useBufferedStream,
    streamPatchCount: normalizeStreamPatchCount(args.streamPatchCount),
    streamPatchDelayMs: normalizeStreamPatchDelayMs(args.streamPatchDelayMs),
    streamMinPatchChars: normalizeStreamMinPatchChars(args.streamMinPatchChars),
    placeholderConfig,
    placeholderConfigPath,
    cleanupFromEvidence: resolvePath(args.cleanupFromEvidence, cwd),
    space,
    metadata,
    metadataPath,
    runId: makeRunId(env),
    baseUrl:
      env.GOOGLE_CHAT_BASE_URL ??
      env.BASE_URL ??
      DEFAULT_BASE_URL,
    credentialsPath:
      env.GOOGLE_APPLICATION_CREDENTIALS ?? defaultCredentialsPath,
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_VISUAL_SMOKE_EVIDENCE,
      cwd,
    ),
    repoRoot,
  };
}

export function buildVisualPlan(config) {
  const bufferedPlan = config.useBufferedStream
    ? buildBufferedStreamExecution(config).plan
    : null;
  const streamPatchRepeat =
    bufferedPlan?.streaming?.buffering?.patchCount ?? config.streamPatchCount;
  const calls = [
    {
      operation: "spaces.get",
      method: "GET",
      path: `/v1/${config.space}`,
      writes: false,
      safetyCheck: "Requires live SPACE with smoke displayName prefix.",
    },
  ];

  if (config.cleanupFromEvidence) {
    calls.push({
      operation: "cleanup.from-evidence",
      method: "DELETE",
      path: "/v1/{createdSmokeMessages}",
      writes: true,
      safetyCheck: "Deletes only message names listed in prior visual-smoke evidence.",
    });
  } else {
    calls.push(
      {
        operation: "visual.text.create",
        method: "POST",
        path: `/v1/${config.space}/messages`,
        writes: true,
        visualExpectation: "plain app-auth text bubble",
      },
      {
        operation: "visual.card.create",
        method: "POST",
        path: `/v1/${config.space}/messages`,
        writes: true,
        visualExpectation: "Cards V2 header, decorated text, and open-link button",
      },
      ...(config.includeRichCard
        ? [
            {
              operation: "visual.rich-card.create",
              method: "POST",
              path: `/v1/${config.space}/messages`,
              writes: true,
              visualExpectation:
                "Cards V2 image, divider, grid, columns, chips, and date picker",
            },
          ]
        : []),
      ...(config.includeCarouselCard
        ? [
            {
              operation: "visual.carousel-card.create",
              method: "POST",
              path: `/v1/${config.space}/messages`,
              writes: true,
              visualExpectation:
                "Developer Preview Cards V2 carousel widget with horizontally scrollable cards",
            },
          ]
        : []),
      ...(config.includeAiCardComponents
        ? [
            {
              operation: "visual.ai.feedback-card.create",
              method: "POST",
              path: `/v1/${config.space}/messages`,
              writes: true,
              visualExpectation:
                "AI feedback card with helpful, not helpful, and comment buttons",
            },
            {
              operation: "visual.ai.sources-card.create",
              method: "POST",
              path: `/v1/${config.space}/messages`,
              writes: true,
              visualExpectation:
                "AI sources card with linked source and Chat resource metadata",
            },
            {
              operation: "visual.ai.thinking-card.create",
              method: "POST",
              path: `/v1/${config.space}/messages`,
              writes: true,
              visualExpectation:
                "AI thinking/status card with detail and timestamp metadata",
            },
            {
              operation: "visual.ai.tool-status-card.create",
              method: "POST",
              path: `/v1/${config.space}/messages`,
              writes: true,
              visualExpectation:
                "AI tool status card with running, complete, and blocked calls",
            },
            {
              operation: "visual.ai.streaming-status-card.create",
              method: "POST",
              path: `/v1/${config.space}/messages`,
              writes: true,
              visualExpectation:
                "AI streaming status card with create-then-patch metadata and cancel action",
            },
          ]
        : []),
      {
        operation: "visual.thread.parent.create",
        method: "POST",
        path: `/v1/${config.space}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`,
        writes: true,
        visualExpectation: "new thread parent",
      },
      {
        operation: "visual.thread.reply.create",
        method: "POST",
        path: `/v1/${config.space}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`,
        writes: true,
        visualExpectation: "reply grouped under the parent thread",
      },
      ...(config.usePlaceholderResponse
        ? [
            {
              operation: "visual.placeholder.create",
              method: "POST",
              path: `/v1/${config.space}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`,
              writes: true,
              visualExpectation: "immediate placeholder response in the active thread",
            },
            {
              operation: "visual.placeholder.complete",
              method: "PATCH",
              path: "/v1/{placeholderMessage}?updateMask=text",
              writes: true,
              visualExpectation:
                "same placeholder message edited to the final agent response",
            },
          ]
        : []),
      {
        operation: "visual.stream.create",
        method: "POST",
        path: `/v1/${config.space}/messages`,
        writes: true,
        visualExpectation: "placeholder message",
      },
      ...(config.useBufferedStream
        ? [
            {
              operation: "visual.stream.buffered-plan",
              method: "LOCAL",
              path: "SDK planBufferedStreamMessage",
              writes: false,
              visualExpectation:
                "model-like chunks are buffered into bounded Chat patch requests",
            },
          ]
        : []),
      {
        operation: "visual.stream.patch",
        method: "PATCH",
        path: "/v1/{streamMessage}?updateMask=text",
        writes: true,
        repeat: streamPatchRepeat,
        visualExpectation: "single message edited to final stream text",
      },
    );
  }

  return {
    mode: config.dryRun ? "dry-run" : "live",
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    placeholderConfigPath: config.placeholderConfigPath,
    runId: config.runId,
    cleanupFromEvidence: config.cleanupFromEvidence,
    calls,
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
    cards: Array.isArray(message.cardsV2) ? message.cardsV2.length : 0,
    accessoryWidgets: Array.isArray(message.accessoryWidgets)
      ? message.accessoryWidgets.length
      : 0,
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
      apiMessage: error.response?.error?.message ?? null,
    };
  }

  return {
    name: error.name ?? "Error",
    message: error.message ?? String(error),
  };
}

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
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
    path.join(defaultEvidenceDir, `chat-visual-smoke-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

function rememberMessage(evidence, label, message) {
  evidence.resourcesCreated.push({
    kind: "message",
    label,
    name: message.name,
    threadName: message.thread?.name ?? null,
  });
}

export async function runVisualSmoke(
  config,
  { client = null, writeEvidence = true } = {},
) {
  if (config.help) {
    return { ok: true, evidence: { help: true } };
  }

  if (config.dryRun) {
    const evidence = {
      ok: true,
      mode: "dry-run",
      plan: buildVisualPlan(config),
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
    includeRichCard: config.includeRichCard,
    includeCarouselCard: config.includeCarouselCard,
    includeAiCardComponents: config.includeAiCardComponents,
    usePlaceholderResponse: config.usePlaceholderResponse,
    useBufferedStream: config.useBufferedStream,
    streamPatchCount: config.streamPatchCount,
    streamPatchDelayMs: config.streamPatchDelayMs,
    streamMinPatchChars: config.streamMinPatchChars,
    cleanupFromEvidence: config.cleanupFromEvidence,
    startedAt: new Date().toISOString(),
    operations: [],
    resourcesCreated: [],
    visualExpectations: [],
  };
  let originalError = null;

  try {
    const targetSpace = await recordOperation(
      evidence,
      "spaces.get",
      () => chat.getSpace(config.space),
      summarizeSpace,
    );
    requireLiveSmokeSpace(targetSpace);

    if (config.cleanupFromEvidence) {
      await runCleanupFromEvidence(config, chat, evidence);
    } else {
      await runVisualCreates(config, chat, evidence);
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

async function runVisualCreates(config, chat, evidence) {
  const textMessage = await recordOperation(
    evidence,
    "visual.text.create",
    () =>
      chat.createMessage(config.space, {
        text: `[${config.runId}] Text smoke: app-auth plain message.`,
      }),
    summarizeMessage,
  );
  rememberMessage(evidence, "text", textMessage);
  evidence.visualExpectations.push({
    label: "text",
    expect: "A GoogleChatAISDK App message with plain text and this run id.",
  });

  const cardMessage = await recordOperation(
    evidence,
    "visual.card.create",
    () => chat.createMessage(config.space, buildCardMessage(config)),
    summarizeMessage,
  );
  rememberMessage(evidence, "card", cardMessage);
  evidence.visualExpectations.push({
    label: "card",
    expect:
      "A Cards V2 message with a title, subtitle, status row, and open-link button.",
  });

  if (config.includeRichCard) {
    const richCardMessage = await recordOperation(
      evidence,
      "visual.rich-card.create",
      () => chat.createMessage(config.space, buildRichCardMessage(config)),
      summarizeMessage,
    );
    rememberMessage(evidence, "rich-card", richCardMessage);
    evidence.visualExpectations.push({
      label: "rich-card",
      expect:
        "A rich Cards V2 message with image, divider, grid, two columns, chips, and a date picker.",
    });
  }

  if (config.includeCarouselCard) {
    const carouselCardMessage = await recordOperation(
      evidence,
      "visual.carousel-card.create",
      () => chat.createMessage(config.space, buildCarouselCardMessage(config)),
      summarizeMessage,
    );
    rememberMessage(evidence, "carousel-card", carouselCardMessage);
    evidence.visualExpectations.push({
      label: "carousel-card",
      expect:
        "A Cards V2 carousel widget with horizontally scrollable carousel cards, text, image, and buttons.",
    });
  }

  if (config.includeAiCardComponents) {
    await runAiCardComponentCreates(config, chat, evidence);
  }

  const threadKey = `${config.runId}-thread`;
  const parent = await recordOperation(
    evidence,
    "visual.thread.parent.create",
    () =>
      chat.createMessage(
        config.space,
        {
          text: `[${config.runId}] Thread parent smoke.`,
          thread: { threadKey },
        },
        {
          messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
        },
      ),
    summarizeMessage,
  );
  rememberMessage(evidence, "thread-parent", parent);

  const reply = await recordOperation(
    evidence,
    "visual.thread.reply.create",
    () =>
      chat.createMessage(
        config.space,
        {
          text: `[${config.runId}] Thread reply smoke.`,
          thread: parent.thread?.name
            ? { name: parent.thread.name }
            : { threadKey },
        },
        {
          messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
        },
      ),
    summarizeMessage,
  );
  rememberMessage(evidence, "thread-reply", reply);
  evidence.visualExpectations.push({
    label: "thread",
    expect: "The reply appears grouped under the thread parent, not as an unrelated top-level message.",
  });

  if (config.usePlaceholderResponse) {
    await runPlaceholderResponseCreateThenEdit(config, chat, evidence, {
      threadName: parent.thread?.name ?? null,
      threadKey,
    });
  }

  const bufferedStream = config.useBufferedStream
    ? buildBufferedStreamExecution(config)
    : null;
  const streamCreateBody = bufferedStream?.createRequest?.body ?? {
    text: `[${config.runId}] Stream smoke: starting...`,
  };
  const streamCreateQuery = bufferedStream?.createRequest?.query ?? {};
  const stream = await recordOperation(
    evidence,
    "visual.stream.create",
    () =>
      chat.createMessage(config.space, streamCreateBody, streamCreateQuery),
    summarizeMessage,
  );
  rememberMessage(evidence, "stream", stream);

  const patchRequests =
    bufferedStream?.patchRequests ?? buildDefaultStreamPatchRequests(config);
  if (bufferedStream) {
    evidence.bufferedStream = summarizeBufferedStream(bufferedStream);
  }

  for (let index = 0; index < patchRequests.length; index += 1) {
    const request = patchRequests[index];
    const delayMs =
      request.throttle?.minDelayMs ??
      (index > 0 ? config.streamPatchDelayMs : 0);
    if (delayMs > 0 && index > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const patchNumber = index + 1;
    await recordOperation(
      evidence,
      `visual.stream.patch.${patchNumber}`,
      () => chat.patchMessage(stream.name, request.body),
      summarizeMessage,
    );
  }
  evidence.streamPatchExecutedCount = patchRequests.length;
  evidence.visualExpectations.push({
    label: "stream",
    expect:
      config.useBufferedStream
        ? "One stream message remains visible with the final buffered model-like text rather than multiple partial messages."
        : "One stream message remains visible with final edited text rather than multiple partial messages.",
  });
}

async function runPlaceholderResponseCreateThenEdit(
  config,
  chat,
  evidence,
  { threadName, threadKey },
) {
  const createInput = buildPlaceholderResponseInput(config, {
    threadName,
    threadKey,
  });
  const createPlan = planPlaceholderResponse(createInput);
  const [createRequest] = createPlan.requests;
  const placeholder = await recordOperation(
    evidence,
    "visual.placeholder.create",
    () =>
      chat.createMessage(
        config.space,
        createRequest.body,
        createRequest.query,
      ),
    summarizeMessage,
  );
  rememberMessage(evidence, "placeholder-response", placeholder);

  const handle = hydratePlaceholderResponseHandle(
    createPlan.placeholder.handle,
    placeholder,
  );
  const completePlan = planCompletePlaceholderResponse({
    handle,
    text: `[${config.runId}] Placeholder response smoke: final answer edited into the original message.`,
  });
  const [patchRequest] = completePlan.requests;

  await recordOperation(
    evidence,
    "visual.placeholder.complete",
    () => chat.patchMessage(handle.messageName, patchRequest.body),
    summarizeMessage,
  );

  evidence.placeholderResponse = summarizePlaceholderResponse(
    createPlan,
    completePlan,
    handle,
  );
  evidence.visualExpectations.push({
    label: "placeholder-response",
    expect:
      "One placeholder response remains visible with the final answer text; there is no second final-answer message.",
  });
}

async function runAiCardComponentCreates(config, chat, evidence) {
  for (const component of buildAiCardComponentMessages(config)) {
    const message = await recordOperation(
      evidence,
      component.operation,
      () => chat.createMessage(config.space, component.message),
      summarizeMessage,
    );
    rememberMessage(evidence, component.label, message);
  }

  evidence.visualExpectations.push({
    label: "ai-card-components",
    expect:
      "Five AI helper messages render: low-impact accessory feedback thumbs, sources, thinking status, tool statuses, and streaming status.",
  });
}

function buildAiCardComponentMessages(config) {
  const responseId = config.runId;
  const feedbackActionName = "ai_visual_feedback";
  const actionParameters = {
    actionName: feedbackActionName,
    responseId,
    runId: config.runId,
  };
  const actionFunction = `${config.baseUrl}/chat/events`;

  return [
    {
      label: "ai-feedback-accessory-message",
      operation: "visual.ai.feedback-accessory-message.create",
      message: buildFeedbackAccessoryMessage({
        text: `[${config.runId}] Answer smoke with low-impact accessory feedback controls.`,
        responseId,
        upAction: {
          function: actionFunction,
          parameters: { ...actionParameters, rating: "helpful" },
        },
        downAction: {
          function: actionFunction,
          parameters: { ...actionParameters, rating: "not_helpful" },
        },
      }),
    },
    {
      label: "ai-sources-card",
      operation: "visual.ai.sources-card.create",
      message: buildSourcesCard({
        cardId: `ai-sources-${config.runId}`,
        title: "Sources",
        responseId,
        sources: [
          {
            title: "Google Chat API reference",
            label: "Docs",
            confidence: "high",
            url: "https://developers.google.com/workspace/chat/api/reference/rest",
            snippet: "Primary Google Chat API reference used by this SDK.",
          },
          {
            title: "Smoke-space thread context",
            label: "Chat",
            resourceName: `${config.space}/messages/visual-smoke-context`,
          },
        ],
      }),
    },
    {
      label: "ai-thinking-card",
      operation: "visual.ai.thinking-card.create",
      message: buildThinkingCard({
        cardId: `ai-thinking-${config.runId}`,
        title: "Working on it",
        status: "thinking",
        detail:
          "Reading the thread, checking attachments, and preparing a grounded answer.",
        startedAt: new Date().toISOString(),
      }),
    },
    {
      label: "ai-tool-status-card",
      operation: "visual.ai.tool-status-card.create",
      message: buildToolStatusCard({
        cardId: `ai-tool-status-${config.runId}`,
        title: "Tool calls",
        tools: [
          {
            name: "read_thread",
            status: "complete",
            output: "12 messages summarized",
          },
          {
            name: "retrieve_sources",
            status: "running",
            detail: "Checking linked context",
          },
          {
            name: "transcribe_audio",
            status: "blocked",
            detail: "Provider key not enabled for this smoke",
          },
        ],
      }),
    },
    {
      label: "ai-streaming-status-card",
      operation: "visual.ai.streaming-status-card.create",
      message: buildStreamingStatusCard({
        cardId: `ai-streaming-status-${config.runId}`,
        title: "Streaming response",
        mode: "create_then_patch",
        status: "streaming",
        patchCount: config.streamPatchCount,
        throttleMs: config.streamPatchDelayMs,
        finalAction: {
          function: "ai_visual_cancel_stream",
          parameters: actionParameters,
        },
      }),
    },
  ];
}

function buildDefaultStreamPatchRequests(config) {
  return Array.from({ length: config.streamPatchCount }, (_, index) => {
    const patchNumber = index + 1;
    const isFinal = patchNumber === config.streamPatchCount;
    const text = isFinal
      ? `[${config.runId}] Stream smoke: final edited message after ${config.streamPatchCount} patch(es).`
      : `[${config.runId}] Stream smoke: chunk ${patchNumber}/${config.streamPatchCount} received.`;
    return {
      body: { text },
      throttle: {
        minDelayMs: index > 0 ? config.streamPatchDelayMs : 0,
        final: isFinal,
      },
    };
  });
}

function buildPlaceholderResponseInput(config, { threadName, threadKey }) {
  const prefix = `[${config.runId}] Placeholder response smoke: `;
  const input = {
    space: config.space,
    ...prefixPlaceholderConfigInput(config.placeholderConfig?.input, prefix),
    authMode: "app",
    requestId: `req-${clientMessageId(config.runId, "placeholder-response").slice("client-".length)}`,
    clientMessageId: clientMessageId(config.runId, "placeholder-response"),
    correlationId: config.runId,
  };

  if (threadName) {
    input.thread = threadName;
  } else if (threadKey) {
    input.threadKey = threadKey;
  }

  return input;
}

function prefixText(value, prefix) {
  return typeof value === "string" ? `${prefix}${value}` : value;
}

function prefixTextList(values, prefix) {
  return Array.isArray(values) ? values.map((value) => prefixText(value, prefix)) : values;
}

function prefixPlaceholderConfigObject(value, prefix) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const output = { ...value };
  for (const key of ["texts", "placeholders", "items"]) {
    if (Array.isArray(output[key])) {
      output[key] = prefixTextList(output[key], prefix);
      break;
    }
  }
  return output;
}

function prefixPlaceholderConfigInput(configInput, prefix) {
  if (!configInput) {
    return {
      placeholderText: `${prefix}Thinking...`,
    };
  }
  const input = { ...configInput };

  if (input.placeholderText !== undefined) {
    input.placeholderText = prefixText(input.placeholderText, prefix);
  }
  if (input.placeholderTexts !== undefined) {
    input.placeholderTexts = prefixTextList(input.placeholderTexts, prefix);
  }
  if (input.placeholderConfig !== undefined) {
    input.placeholderConfig = prefixPlaceholderConfigObject(
      input.placeholderConfig,
      prefix,
    );
  }

  return input;
}

function summarizePlaceholderResponse(createPlan, completePlan, handle) {
  const createRequest = createPlan.requests[0];
  const patchRequest = completePlan.requests[0];
  const finalText = patchRequest.body.text ?? "";

  return {
    enabled: true,
    strategy: createPlan.placeholder.strategy,
    completeStrategy: completePlan.placeholder.strategy,
    state: completePlan.placeholder.state,
    createResource: createRequest.resource,
    completeResource: patchRequest.resource,
    requestId: handle.requestId,
    clientMessageId: handle.clientMessageId,
    correlationId: handle.correlationId,
    messageName: handle.messageName,
    threadName: handle.threadName,
    updateMask: completePlan.placeholder.updateMask,
    textSelection: createPlan.placeholder.textSelection,
    finalTextLength: finalText.length,
    finalTextSha256: stableHash(finalText),
    fallback: completePlan.placeholder.fallback.onPatchFailure,
  };
}

function bufferedStreamChunks() {
  return [
    "Buffered ",
    "stream ",
    "planner ",
    "converted ",
    "model-like ",
    "chunks ",
    "into ",
    "bounded ",
    "Chat ",
    "edits.",
  ];
}

function buildBufferedStreamInput(config) {
  return {
    space: config.space,
    initialText: `[${config.runId}] Buffered stream smoke: starting...`,
    prefix: `[${config.runId}] Buffered stream smoke: `,
    chunks: bufferedStreamChunks(),
    minPatchChars: config.streamMinPatchChars,
    maxPatches: config.streamPatchCount,
    throttleMs: config.streamPatchDelayMs,
    requestId: `req-${clientMessageId(config.runId, "buffered-stream").slice("client-".length)}`,
    clientMessageId: clientMessageId(config.runId, "buffered-stream"),
  };
}

function buildBufferedStreamExecution(config) {
  const plan = planBufferedStreamMessage(buildBufferedStreamInput(config));
  const [createRequest, ...patchRequests] = plan.requests;
  return {
    plan,
    createRequest,
    patchRequests,
    buffering: plan.streaming.buffering,
  };
}

function summarizeBufferedStream(execution) {
  const buffering = execution.buffering;
  return {
    enabled: true,
    strategy: buffering.strategy,
    inputChunkCount: buffering.inputChunkCount,
    patchCount: buffering.patchCount,
    finalTextLength: buffering.finalText.length,
    finalTextSha256: stableHash(buffering.finalText),
    cadence: buffering.cadence,
    warningCount: buffering.warnings.length,
  };
}

async function runCleanupFromEvidence(config, chat, evidence) {
  const raw = JSON.parse(await fs.readFile(config.cleanupFromEvidence, "utf8"));
  if (raw.targetSpace !== config.space) {
    throw new Error(
      `Cleanup evidence targetSpace ${raw.targetSpace} does not match ${config.space}`,
    );
  }
  const resources = Array.isArray(raw.resourcesCreated)
    ? raw.resourcesCreated
    : [];
  const messageNames = resources
    .filter((resource) => resource.kind === "message")
    .map((resource) => resource.name)
    .filter(Boolean);

  for (const name of messageNames.reverse()) {
    if (!name.startsWith(`${config.space}/messages/`)) {
      throw new Error(`Refusing to delete message outside smoke space: ${name}`);
    }
    await recordOperation(
      evidence,
      "cleanup.visual.message.delete",
      () => chat.deleteMessage(name),
      () => ({ resourceName: name }),
    );
  }
}

function buildCardMessage(config) {
  return {
    text: `[${config.runId}] Card smoke fallback text.`,
    cardsV2: [
      {
        cardId: `visual-card-${config.runId}`,
        card: {
          header: {
            title: "Google Chat AI SDK Visual Smoke",
            subtitle: config.runId,
            imageUrl: `${config.baseUrl}/avatar.png`,
            imageType: "CIRCLE",
          },
          sections: [
            {
              header: "Cards V2 rendering",
              widgets: [
                {
                  decoratedText: {
                    topLabel: "Expected visual",
                    text: "Header, decorated text, and button are visible in Google Chat.",
                    startIcon: {
                      knownIcon: "DESCRIPTION",
                    },
                  },
                },
                {
                  buttonList: {
                    buttons: [
                      {
                        text: "Open health",
                        onClick: {
                          openLink: {
                            url: `${config.baseUrl}/healthz`,
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

function buildRichCardMessage(config) {
  return {
    text: `[${config.runId}] Rich card smoke fallback text.`,
    cardsV2: [
      {
        cardId: `visual-rich-card-${config.runId}`,
        card: {
          header: {
            title: "Google Chat AI SDK Rich Card Smoke",
            subtitle: config.runId,
            imageUrl: `${config.baseUrl}/avatar.png`,
            imageType: "CIRCLE",
            imageAltText: "Google Chat AI SDK avatar",
          },
          sections: [
            {
              header: "Richer Cards V2 widgets",
              widgets: [
                {
                  image: {
                    imageUrl: `${config.baseUrl}/avatar.png`,
                    altText: "Google Chat AI SDK avatar image widget",
                    onClick: {
                      openLink: {
                        url: `${config.baseUrl}/healthz`,
                      },
                    },
                  },
                },
                {
                  divider: {},
                },
                {
                  grid: {
                    title: "Attachment understanding",
                    columnCount: 2,
                    borderStyle: {
                      type: "STROKE",
                      cornerRadius: 4,
                    },
                    items: [
                      {
                        id: "pdf",
                        image: {
                          imageUri: `${config.baseUrl}/avatar.png`,
                          cropStyle: {
                            type: "SQUARE",
                          },
                        },
                        title: "PDF",
                        subtitle: "Parsed",
                        layout: "TEXT_BELOW",
                      },
                      {
                        id: "audio",
                        image: {
                          imageUri: `${config.baseUrl}/avatar.png`,
                          cropStyle: {
                            type: "SQUARE",
                          },
                        },
                        title: "Voice note",
                        subtitle: "Transcribed",
                        layout: "TEXT_BELOW",
                      },
                    ],
                    onClick: {
                      openLink: {
                        url: `${config.baseUrl}/healthz`,
                      },
                    },
                  },
                },
                {
                  columns: {
                    columnItems: [
                      {
                        horizontalSizeStyle: "FILL_AVAILABLE_SPACE",
                        horizontalAlignment: "START",
                        verticalAlignment: "CENTER",
                        widgets: [
                          {
                            decoratedText: {
                              topLabel: "Owner",
                              text: "Smoke test",
                              startIcon: {
                                knownIcon: "PERSON",
                              },
                            },
                          },
                        ],
                      },
                      {
                        horizontalSizeStyle: "FILL_AVAILABLE_SPACE",
                        horizontalAlignment: "END",
                        verticalAlignment: "CENTER",
                        widgets: [
                          {
                            textParagraph: {
                              text: "Ready for visual inspection.",
                            },
                          },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
            {
              header: "Inputs and tags",
              widgets: [
                {
                  chipList: {
                    chips: [
                      {
                        label: "urgent",
                      },
                      {
                        label: "research",
                        onClick: {
                          openLink: {
                            url: `${config.baseUrl}/healthz`,
                          },
                        },
                      },
                    ],
                  },
                },
                {
                  dateTimePicker: {
                    name: "visual_smoke_due_date",
                    label: "Due date",
                    type: "DATE_ONLY",
                    valueMsEpoch: "1783209600000",
                  },
                },
                {
                  selectionInput: {
                    name: "visual_smoke_priority",
                    label: "Priority",
                    type: "DROPDOWN",
                    items: [
                      {
                        text: "High",
                        value: "high",
                        selected: true,
                      },
                      {
                        text: "Normal",
                        value: "normal",
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

function buildCarouselCardMessage(config) {
  return {
    text: `[${config.runId}] Carousel card smoke fallback text.`,
    cardsV2: [
      {
        cardId: `visual-carousel-card-${config.runId}`,
        card: {
          header: {
            title: "Google Chat AI SDK Carousel Smoke",
            subtitle: config.runId,
            imageUrl: `${config.baseUrl}/avatar.png`,
            imageType: "CIRCLE",
            imageAltText: "Google Chat AI SDK avatar",
          },
          sections: [
            {
              header: "Carousel widget",
              widgets: [
                {
                  carousel: {
                    carouselCards: [
                      {
                        widgets: [
                          {
                            textParagraph: {
                              text: "First carousel panel: attachment metadata.",
                            },
                          },
                        ],
                        footerWidgets: [
                          {
                            buttonList: {
                              buttons: [
                                {
                                  text: "Open health",
                                  onClick: {
                                    openLink: {
                                      url: `${config.baseUrl}/healthz`,
                                    },
                                  },
                                },
                              ],
                            },
                          },
                        ],
                      },
                      {
                        widgets: [
                          {
                            image: {
                              imageUrl: `${config.baseUrl}/avatar.png`,
                              altText: "Carousel avatar image",
                            },
                          },
                          {
                            textParagraph: {
                              text: "Second carousel panel: AI context.",
                            },
                          },
                        ],
                        footerWidgets: [
                          {
                            buttonList: {
                              buttons: [
                                {
                                  text: "Acknowledge",
                                  onClick: {
                                    action: {
                                      function:
                                        "googlechatai_sdk_carousel_ack",
                                      parameters: [
                                        {
                                          key: "runId",
                                          value: config.runId,
                                        },
                                      ],
                                    },
                                  },
                                },
                              ],
                            },
                          },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
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
    createMessage: (parent, body, query = {}) =>
      chatRequest(serviceAccount, scopes, getAccessToken, `${parent}/messages`, {
        method: "POST",
        query: {
          messageId:
            query.messageId ??
            clientMessageId(config.runId, crypto.randomUUID().slice(0, 8)),
          ...query,
        },
        body,
        idempotent: true,
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
    "Usage: RUN_LIVE_CHAT_VISUAL_SMOKE=1 GOOGLE_CHAT_TEST_SPACE=spaces/... pnpm live:chat-visual-smoke",
    "",
    "Required:",
    "  RUN_LIVE_CHAT_VISUAL_SMOKE=1",
    "  GOOGLE_CHAT_TEST_SPACE=spaces/...",
    "  GOOGLE_CHAT_SMOKE_METADATA=fixtures/live/chat-smoke-space.local.json",
    "",
    "Options:",
    "  --dry-run                      Print planned API calls without writes.",
    "  --include-rich-card            Also create a richer Cards V2 widget inventory message.",
    "  --include-carousel-card        Also create a Developer Preview Cards V2 carousel message.",
    "  --include-ai-card-components   Also create reusable AI helper messages for accessory feedback, sources, thinking, tool status, and streaming.",
    "  --use-buffered-stream          Use SDK buffered stream planner for the stream message.",
    `  --stream-patch-count <n>       Patch the stream message n times; default ${DEFAULT_STREAM_PATCH_COUNT}, max ${MAX_STREAM_PATCH_COUNT}.`,
    `  --stream-patch-delay-ms <ms>   Delay between stream patches; default 0, max ${MAX_STREAM_PATCH_DELAY_MS}.`,
    `  --stream-min-patch-chars <n>   Buffered stream minimum text delta; default ${DEFAULT_BUFFERED_STREAM_MIN_PATCH_CHARS}, max ${MAX_BUFFERED_STREAM_MIN_PATCH_CHARS}.`,
    "  --metadata <path>              Smoke-space metadata JSON path.",
    "  --evidence <path>              Evidence JSON output path.",
    "  --cleanup-from-evidence <path> Delete messages created by a prior visual smoke.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = await loadVisualSmokeConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runVisualSmoke(config);
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
