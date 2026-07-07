import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildLogSmokePlan, runLogSmoke } from "./chat-log-smoke.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const DEFAULT_SERVICE = "chat-ai-sdk-dev-webhook";

function parseArgs(argv) {
  const args = {
    dryRun: false,
    evidencePath: null,
    project: null,
    service: null,
    runId: null,
    since: null,
    until: null,
    limit: 100,
    waitSeconds: 60,
    pollIntervalMs: 5000,
    expectEventType: "message",
    expectMentionCount: 1,
    expectAttachmentCount: 0,
    expectAttachmentDataRefCount: null,
    expectDriveAttachmentCount: null,
    expectQuotedMessage: false,
    expectQuoteDepth: null,
    expectEventIdentity: false,
    expectActionMethod: null,
    help: false,
  };
  const rest = argv.slice(2);

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--") {
      continue;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--evidence") {
      args.evidencePath = rest[++index];
    } else if (arg.startsWith("--evidence=")) {
      args.evidencePath = arg.slice("--evidence=".length);
    } else if (arg === "--project") {
      args.project = rest[++index];
    } else if (arg.startsWith("--project=")) {
      args.project = arg.slice("--project=".length);
    } else if (arg === "--service") {
      args.service = rest[++index];
    } else if (arg.startsWith("--service=")) {
      args.service = arg.slice("--service=".length);
    } else if (arg === "--run-id") {
      args.runId = rest[++index];
    } else if (arg.startsWith("--run-id=")) {
      args.runId = arg.slice("--run-id=".length);
    } else if (arg === "--since") {
      args.since = rest[++index];
    } else if (arg.startsWith("--since=")) {
      args.since = arg.slice("--since=".length);
    } else if (arg === "--until") {
      args.until = rest[++index];
    } else if (arg.startsWith("--until=")) {
      args.until = arg.slice("--until=".length);
    } else if (arg === "--limit") {
      args.limit = Number(rest[++index]);
    } else if (arg.startsWith("--limit=")) {
      args.limit = Number(arg.slice("--limit=".length));
    } else if (arg === "--wait-seconds") {
      args.waitSeconds = Number(rest[++index]);
    } else if (arg.startsWith("--wait-seconds=")) {
      args.waitSeconds = Number(arg.slice("--wait-seconds=".length));
    } else if (arg === "--poll-interval-ms") {
      args.pollIntervalMs = Number(rest[++index]);
    } else if (arg.startsWith("--poll-interval-ms=")) {
      args.pollIntervalMs = Number(arg.slice("--poll-interval-ms=".length));
    } else if (arg === "--expect-event-type") {
      args.expectEventType = rest[++index];
    } else if (arg.startsWith("--expect-event-type=")) {
      args.expectEventType = arg.slice("--expect-event-type=".length);
    } else if (arg === "--expect-mention-count") {
      args.expectMentionCount = Number(rest[++index]);
    } else if (arg.startsWith("--expect-mention-count=")) {
      args.expectMentionCount = Number(arg.slice("--expect-mention-count=".length));
    } else if (arg === "--expect-attachment-count") {
      args.expectAttachmentCount = Number(rest[++index]);
    } else if (arg.startsWith("--expect-attachment-count=")) {
      args.expectAttachmentCount = Number(arg.slice("--expect-attachment-count=".length));
    } else if (arg === "--expect-attachment-data-ref-count") {
      args.expectAttachmentDataRefCount = Number(rest[++index]);
    } else if (arg.startsWith("--expect-attachment-data-ref-count=")) {
      args.expectAttachmentDataRefCount = Number(
        arg.slice("--expect-attachment-data-ref-count=".length),
      );
    } else if (arg === "--expect-drive-attachment-count") {
      args.expectDriveAttachmentCount = Number(rest[++index]);
    } else if (arg.startsWith("--expect-drive-attachment-count=")) {
      args.expectDriveAttachmentCount = Number(
        arg.slice("--expect-drive-attachment-count=".length),
      );
    } else if (arg === "--expect-quoted-message") {
      args.expectQuotedMessage = true;
    } else if (arg === "--expect-quote-depth") {
      args.expectQuoteDepth = Number(rest[++index]);
    } else if (arg.startsWith("--expect-quote-depth=")) {
      args.expectQuoteDepth = Number(arg.slice("--expect-quote-depth=".length));
    } else if (arg === "--expect-event-identity") {
      args.expectEventIdentity = true;
    } else if (arg === "--expect-action-method") {
      args.expectActionMethod = rest[++index];
    } else if (arg.startsWith("--expect-action-method=")) {
      args.expectActionMethod = arg.slice("--expect-action-method=".length);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function requireNonEmpty(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function resolvePath(input, cwd) {
  if (!input) {
    return null;
  }
  return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function makeRunId(env) {
  if (env.GOOGLE_CHAT_INBOUND_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_INBOUND_SMOKE_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `inbound-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export function resolveInboundSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_CHAT_INBOUND_SMOKE !== "1") {
    throw new Error(
      "Refusing to run Chat inbound smoke without RUN_LIVE_CHAT_INBOUND_SMOKE=1.",
    );
  }

  const project = args.project ?? env.GOOGLE_CLOUD_PROJECT;
  const service = args.service ?? env.GOOGLE_CHAT_CLOUD_RUN_SERVICE ?? DEFAULT_SERVICE;
  const runId = args.runId ?? makeRunId(env);
  const since = args.since ?? env.GOOGLE_CHAT_INBOUND_SMOKE_SINCE ?? isoNow();
  const until = args.until ?? env.GOOGLE_CHAT_INBOUND_SMOKE_UNTIL ?? null;
  const smokeSpace = env.GOOGLE_CHAT_TEST_SPACE ?? null;

  requireNonEmpty(project, "--project or GOOGLE_CLOUD_PROJECT");
  requireNonEmpty(service, "--service or GOOGLE_CHAT_CLOUD_RUN_SERVICE");
  requireNonEmpty(runId, "--run-id");
  requireNonEmpty(since, "--since");
  requirePositiveInteger(args.limit, "--limit");
  requireNonNegativeInteger(args.waitSeconds, "--wait-seconds");
  requirePositiveInteger(args.pollIntervalMs, "--poll-interval-ms");
  requireNonNegativeInteger(args.expectMentionCount, "--expect-mention-count");
  requireNonNegativeInteger(
    args.expectAttachmentCount,
    "--expect-attachment-count",
  );
  if (args.expectAttachmentDataRefCount !== null) {
    requireNonNegativeInteger(
      args.expectAttachmentDataRefCount,
      "--expect-attachment-data-ref-count",
    );
  }
  if (args.expectDriveAttachmentCount !== null) {
    requireNonNegativeInteger(
      args.expectDriveAttachmentCount,
      "--expect-drive-attachment-count",
    );
  }
  if (args.expectQuoteDepth !== null) {
    requireNonNegativeInteger(args.expectQuoteDepth, "--expect-quote-depth");
  }

  return {
    dryRun: args.dryRun,
    project,
    service,
    runId,
    since,
    until,
    smokeSpace,
    limit: args.limit,
    waitSeconds: args.waitSeconds,
    pollIntervalMs: args.pollIntervalMs,
    expectations: {
      events: 1,
      httpPosts: 1,
      eventType: args.expectEventType,
      actionMethod: args.expectActionMethod,
      mentionCount: args.expectMentionCount,
      attachmentCount: args.expectAttachmentCount,
      attachmentDataRefCount: args.expectAttachmentDataRefCount,
      driveAttachmentCount: args.expectDriveAttachmentCount,
      quotedMessage: args.expectQuotedMessage ? true : null,
      quoteDepth: args.expectQuoteDepth,
      eventIdentity: args.expectEventIdentity,
    },
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_INBOUND_SMOKE_EVIDENCE,
      cwd,
    ),
  };
}

function buildLogConfig(config) {
  return {
    dryRun: false,
    project: config.project,
    service: config.service,
    since: config.since,
    until: config.until,
    limit: config.limit,
    expectations: config.expectations,
    runId: `log-${config.runId}`,
    evidencePath: null,
  };
}

function manualAction(config) {
  const expectationHints = [];
  if (config.expectations.attachmentCount > 0) {
    expectationHints.push(
      `attach ${config.expectations.attachmentCount} file(s) before sending`,
    );
  }
  if (config.expectations.driveAttachmentCount !== null) {
    expectationHints.push("use the Drive picker for the expected Drive attachment(s)");
  }
  if (config.expectations.quotedMessage) {
    expectationHints.push("send as a quote/reply to an existing smoke-space message");
  }
  if (config.expectations.actionMethod) {
    expectationHints.push(
      `trigger card/action method ${config.expectations.actionMethod}`,
    );
  }

  return {
    surface: "chat.google.com",
    smokeSpace: config.smokeSpace,
    runId: config.runId,
    instruction:
      `In the dedicated smoke space, type @, select GoogleChatAISDK from autocomplete so Chat creates a real mention pill, add this run id,${expectationHints.length > 0 ? ` ${expectationHints.join(", ")},` : ""} and send.`,
    rawAtTextWarning:
      "Do not type raw @GoogleChatAISDK text without selecting the autocomplete suggestion; that does not create a Chat mention object.",
  };
}

export function buildInboundSmokePlan(config) {
  const logConfig = buildLogConfig(config);

  return {
    mode: config.dryRun ? "dry-run" : "live",
    runId: config.runId,
    since: config.since,
    until: config.until,
    waitSeconds: config.waitSeconds,
    pollIntervalMs: config.pollIntervalMs,
    manualAction: manualAction(config),
    logSmokePlan: buildLogSmokePlan(logConfig),
  };
}

async function writeEvidenceFile(config, evidence) {
  const evidencePath =
    config.evidencePath ??
    path.join(defaultEvidenceDir, `chat-inbound-smoke-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

function attemptFromError(attempt, error) {
  return {
    attempt,
    ok: false,
    message: error.message ?? String(error),
    failures: error.evidence?.failures ?? null,
    counts: error.evidence?.counts ?? null,
  };
}

function attemptFromSuccess(attempt, evidence) {
  return {
    attempt,
    ok: true,
    counts: evidence.counts,
    assertions: evidence.assertions,
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function runInboundSmoke(
  config,
  {
    runLogSmokeImpl = runLogSmoke,
    writeEvidence = true,
    wait = sleep,
    now = () => Date.now(),
  } = {},
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
        plan: buildInboundSmokePlan(config),
      },
    };
  }

  const logConfig = buildLogConfig(config);
  const deadline = now() + config.waitSeconds * 1000;
  const attempts = [];
  let attempt = 0;
  let lastError = null;

  do {
    attempt += 1;
    try {
      const result = await runLogSmokeImpl(logConfig, { writeEvidence: false });
      attempts.push(attemptFromSuccess(attempt, result.evidence));
      const evidence = {
        ok: true,
        mode: "live",
        runId: config.runId,
        project: config.project,
        service: config.service,
        since: config.since,
        until: config.until,
        waitSeconds: config.waitSeconds,
        pollIntervalMs: config.pollIntervalMs,
        manualAction: manualAction(config),
        attempts,
        logEvidence: result.evidence,
        privacy: {
          rawLogEntriesSaved: false,
          rawMessageTextSaved: false,
          rawFormValuesSaved: false,
          rawAccessTokensSaved: false,
          senderEmailsSaved: false,
        },
      };

      if (writeEvidence) {
        evidence.evidencePath = await writeEvidenceFile(config, evidence);
      }

      return { ok: true, evidence };
    } catch (error) {
      lastError = error;
      attempts.push(attemptFromError(attempt, error));
    }

    if (now() >= deadline) {
      break;
    }

    await wait(Math.min(config.pollIntervalMs, Math.max(0, deadline - now())));
  } while (true);

  const evidence = {
    ok: false,
    mode: "live",
    runId: config.runId,
    project: config.project,
    service: config.service,
    since: config.since,
    until: config.until,
    waitSeconds: config.waitSeconds,
    pollIntervalMs: config.pollIntervalMs,
    manualAction: manualAction(config),
    attempts,
    lastLogEvidence: lastError?.evidence ?? null,
    privacy: {
      rawLogEntriesSaved: false,
      rawMessageTextSaved: false,
      rawFormValuesSaved: false,
      rawAccessTokensSaved: false,
      senderEmailsSaved: false,
    },
  };

  if (writeEvidence) {
    evidence.evidencePath = await writeEvidenceFile(config, evidence);
  }

  const error = new Error(
    `Chat inbound smoke did not observe the expected event within ${config.waitSeconds}s.`,
  );
  error.evidence = evidence;
  throw error;
}

function usage() {
  return `${[
    "Usage: RUN_LIVE_CHAT_INBOUND_SMOKE=1 pnpm live:chat-inbound-smoke -- --since <RFC3339>",
    "",
    "This helper does not send Chat messages. Send a real @GoogleChatAISDK mention in the dedicated smoke room, then let this command poll Cloud Logging.",
    "",
    "Options:",
    "  --dry-run                       Print the manual instruction and log-smoke plan.",
    "  --run-id <id>                   Run id to include in the manual Chat message.",
    "  --project <id>                  Google Cloud project. Defaults to GOOGLE_CLOUD_PROJECT.",
    "  --service <name>                Cloud Run service. Defaults to GOOGLE_CHAT_CLOUD_RUN_SERVICE or chat-ai-sdk-dev-webhook.",
    "  --since <RFC3339>               Lower timestamp bound. Defaults to command start time.",
    "  --until <RFC3339>               Optional upper timestamp bound.",
    "  --limit <n>                     Maximum log entries per query. Default: 100.",
    "  --wait-seconds <n>              Poll timeout. Default: 60.",
    "  --poll-interval-ms <n>          Poll interval. Default: 5000.",
    "  --expect-event-type <type>      Expected eventType/kind. Default: message.",
    "  --expect-mention-count <n>      Expected user mention count. Default: 1.",
    "  --expect-attachment-count <n>   Expected attachment count. Default: 0.",
    "  --expect-attachment-data-ref-count <n> Expected attachment dataRef count.",
    "  --expect-drive-attachment-count <n>    Expected Drive attachment count.",
    "  --expect-quoted-message         Require a quoted message.",
    "  --expect-quote-depth <n>        Expected quoted-message nesting depth.",
    "  --expect-event-identity         Require redacted event identity metadata.",
    "  --expect-action-method <name>   Expected at least one action method.",
    "  --evidence <path>               Evidence JSON output path.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = resolveInboundSmokeConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runInboundSmoke(config);
    console.log(JSON.stringify(result.evidence, null, 2));
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: {
            name: error.name ?? "Error",
            message: error.message ?? String(error),
          },
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
