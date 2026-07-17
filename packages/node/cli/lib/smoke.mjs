import crypto from "node:crypto";

import {
  CliUsageError,
  asRecord,
  asString,
  assertOnlyOptions,
  normalizedFormat,
  parseCommandArgs,
  positiveInteger,
  readJsonFile,
  writeJson,
} from "./common.mjs";

export const SMOKE_SPACE_PREFIX = "Google Chat AI SDK Smoke";
const REQUIRED_OPERATIONS = [
  "spaces.get",
  "spaces.messages.create",
  "spaces.messages.list",
  "spaces.messages.delete",
];

function requireResourceName(value, prefix, label) {
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    throw new CliUsageError(`${label} must start with ${prefix}.`);
  }
}

export function validateSmokeMetadata(metadata, expectedSpace = null) {
  const record = asRecord(metadata);
  if (!record) {
    throw new CliUsageError("Smoke metadata must be a JSON object.");
  }
  requireResourceName(record.space, "spaces/", "Smoke metadata space");
  if (expectedSpace && record.space !== expectedSpace) {
    throw new CliUsageError(
      "Smoke metadata space does not match GOOGLE_CHAT_TEST_SPACE.",
    );
  }
  if (
    typeof record.displayName !== "string" ||
    !record.displayName.startsWith(SMOKE_SPACE_PREFIX)
  ) {
    throw new CliUsageError(
      `Smoke metadata displayName must start with ${SMOKE_SPACE_PREFIX}.`,
    );
  }
  if (record.spaceType !== "SPACE") {
    throw new CliUsageError("Smoke metadata spaceType must be SPACE.");
  }
  const safety = asRecord(record.safety);
  if (
    safety?.dedicatedSmokeSpace !== true ||
    safety?.noDirectMessages !== true ||
    safety?.noRealUsersInvited !== true
  ) {
    throw new CliUsageError(
      "Smoke metadata must attest dedicatedSmokeSpace, noDirectMessages, and noRealUsersInvited.",
    );
  }
  const operations = Array.isArray(record.allowedOperations)
    ? record.allowedOperations
    : [];
  const missing = REQUIRED_OPERATIONS.filter(
    (operation) => !operations.includes(operation),
  );
  if (missing.length > 0) {
    throw new CliUsageError(
      `Smoke metadata is missing allowed operations: ${missing.join(", ")}.`,
    );
  }
  return record;
}

function clientMessageId(runId) {
  const suffix = runId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return `client-${suffix || "smoke"}`;
}

async function chatRequest(fetchImpl, token, path, { method = "GET", body } = {}) {
  const response = await fetchImpl(`https://chat.googleapis.com/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`Google Chat API ${method} request returned HTTP ${response.status}.`);
  }
  if (response.status === 204) {
    return {};
  }
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function assertLiveSpace(space, metadata) {
  const record = asRecord(space);
  if (!record) {
    throw new Error("Google Chat returned an invalid space object.");
  }
  if (
    record.name !== metadata.space ||
    record.spaceType !== "SPACE" ||
    typeof record.displayName !== "string" ||
    !record.displayName.startsWith(SMOKE_SPACE_PREFIX)
  ) {
    throw new Error("Live space does not match the dedicated smoke-space contract.");
  }
}

function findAppReply(messages, { appUser, threadName, promptName }) {
  return messages.find((message) => {
    const record = asRecord(message);
    return (
      record?.name !== promptName &&
      asString(asRecord(record?.sender)?.name) === appUser &&
      asString(asRecord(record?.thread)?.name) === threadName
    );
  });
}

function renderSummary(result) {
  if (result.mode === "dry-run") {
    return [
      "Google Chat smoke: DRY RUN",
      `Space contract: ${result.spaceDisplayName}`,
      `Operations: ${result.operations.join(", ")}`,
      "No message text, token, or API write was used.",
    ].join("\n");
  }
  return [
    `Google Chat smoke: ${result.ok ? "PASS" : "FAIL"}`,
    `Mention delivered: ${result.mentionDelivered ? "yes" : "no"}`,
    `App replied in triggering thread: ${result.correctThreadReply ? "yes" : "no"}`,
    `Prompt cleanup: ${result.promptCleanedUp ? "yes" : "no"}`,
  ].join("\n");
}

export async function runSmokeCommand(args, context) {
  const { options, positionals } = parseCommandArgs(args, {
    booleanFlags: ["live", "help"],
  });
  assertOnlyOptions(options, [
    "metadata",
    "app-user",
    "format",
    "timeout-ms",
    "poll-ms",
    "live",
    "help",
  ]);
  if (positionals.length > 0) {
    throw new CliUsageError("smoke does not accept positional arguments.");
  }

  if (options.help) {
    context.stdout.write(
      [
        "Usage: googlechatai smoke --metadata smoke-space.json [--live]",
        "       [--app-user users/APP] [--timeout-ms 30000]",
        "",
        "The default is a side-effect-free plan. Live mode requires:",
        "  RUN_LIVE_GOOGLECHATAI_SMOKE=1",
        "  GOOGLE_CHAT_USER_ACCESS_TOKEN=<user OAuth token>",
        "and dedicated-space metadata with the required safety attestations.",
      ].join("\n") + "\n",
    );
    return { exitCode: 0, result: null };
  }

  const metadataPath =
    options.metadata ?? context.env.GOOGLE_CHAT_SMOKE_METADATA;
  const metadataFile = await readJsonFile(
    metadataPath,
    context.cwd,
    "smoke metadata",
  );
  const expectedSpace = context.env.GOOGLE_CHAT_TEST_SPACE ?? null;
  const metadata = validateSmokeMetadata(metadataFile.value, expectedSpace);
  const appUser =
    options["app-user"] ??
    context.env.GOOGLE_CHAT_APP_USER ??
    asString(metadata.appUser);
  const format = normalizedFormat(options.format);
  const live = options.live === true;
  const timeoutMs = positiveInteger(
    options["timeout-ms"],
    "--timeout-ms",
    30_000,
    120_000,
  );
  const pollMs = positiveInteger(
    options["poll-ms"],
    "--poll-ms",
    2_000,
    10_000,
  );
  const runId =
    context.env.GOOGLE_CHAT_SMOKE_RUN_ID ??
    (context.randomUUID ?? crypto.randomUUID)();
  const planned = {
    kind: "googlechatai.smoke_result",
    ok: true,
    mode: "dry-run",
    spaceDisplayName: metadata.displayName,
    operations: [
      "verify-live-space",
      "create-user-auth-mention",
      "poll-for-app-reply",
      "verify-triggering-thread",
      "delete-user-auth-prompt",
    ],
    requiredScopes: [
      "https://www.googleapis.com/auth/chat.spaces.readonly",
      "https://www.googleapis.com/auth/chat.messages",
    ],
    privacy: {
      tokenPrinted: false,
      messageTextPrinted: false,
      rawPayloadSaved: false,
    },
  };

  if (!live) {
    if (format === "json") {
      writeJson(context.stdout, planned);
    } else {
      context.stdout.write(`${renderSummary(planned)}\n`);
    }
    return { exitCode: 0, result: planned };
  }

  if (
    context.env.RUN_LIVE_GOOGLECHATAI_SMOKE !== "1" &&
    context.env.RUN_LIVE_CHAT_SMOKE !== "1"
  ) {
    throw new CliUsageError(
      "Refusing live smoke without RUN_LIVE_GOOGLECHATAI_SMOKE=1.",
    );
  }
  requireResourceName(appUser, "users/", "Chat app user");
  const token = context.env.GOOGLE_CHAT_USER_ACCESS_TOKEN;
  if (!token) {
    throw new CliUsageError(
      "GOOGLE_CHAT_USER_ACCESS_TOKEN is required for a live smoke and is never printed or saved.",
    );
  }
  if (typeof context.fetch !== "function") {
    throw new Error("A fetch implementation is required for live smoke.");
  }

  const startedAt = new Date(context.now()).toISOString();
  const marker = `googlechatai smoke ${runId}`;
  const promptBody = { text: `<${appUser}> ${marker}` };
  let promptName = null;
  let promptCleanedUp = false;
  let reply = null;
  let mainError = null;

  try {
    const liveSpace = await chatRequest(
      context.fetch,
      token,
      metadata.space,
    );
    assertLiveSpace(liveSpace, metadata);

    const prompt = await chatRequest(
      context.fetch,
      token,
      `${metadata.space}/messages?messageId=${encodeURIComponent(clientMessageId(runId))}`,
      { method: "POST", body: promptBody },
    );
    promptName = asString(prompt.name);
    const threadName = asString(asRecord(prompt.thread)?.name);
    if (!promptName || !threadName) {
      throw new Error("The smoke prompt response did not include message and thread names.");
    }

    const deadline = context.now() + timeoutMs;
    while (context.now() <= deadline) {
      const filter = encodeURIComponent(
        `createTime > "${startedAt}" AND thread.name = ${threadName}`,
      );
      const listed = await chatRequest(
        context.fetch,
        token,
        `${metadata.space}/messages?pageSize=100&orderBy=DESC&filter=${filter}`,
      );
      reply = findAppReply(
        Array.isArray(listed.messages) ? listed.messages : [],
        { appUser, threadName, promptName },
      );
      if (reply) {
        break;
      }
      await context.sleep(pollMs);
    }
    if (!reply) {
      throw new Error(
        `No reply from the configured Chat app appeared in the triggering thread within ${timeoutMs}ms.`,
      );
    }
  } catch (error) {
    mainError = error;
  } finally {
    if (promptName) {
      try {
        await chatRequest(context.fetch, token, promptName, { method: "DELETE" });
        promptCleanedUp = true;
      } catch (cleanupError) {
        if (!mainError) {
          mainError = new Error(`Smoke prompt cleanup failed: ${cleanupError.message}`);
        }
      }
    }
  }

  if (mainError) {
    throw mainError;
  }

  const result = {
    kind: "googlechatai.smoke_result",
    ok: true,
    mode: "live",
    runId,
    mentionDelivered: true,
    correctThreadReply: true,
    promptCleanedUp,
    privacy: planned.privacy,
  };
  if (format === "json") {
    writeJson(context.stdout, result);
  } else {
    context.stdout.write(`${renderSummary(result)}\n`);
  }
  return { exitCode: 0, result };
}
