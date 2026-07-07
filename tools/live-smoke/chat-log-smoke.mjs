import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const DEFAULT_SERVICE = "chat-ai-sdk-dev-webhook";

function parseArgs(argv) {
  const args = {
    dryRun: false,
    evidencePath: null,
    project: null,
    service: null,
    since: null,
    until: null,
    limit: 100,
    expectEvents: null,
    expectHttpPosts: null,
    expectEventType: null,
    expectActionMethod: null,
    expectCardActionState: false,
    expectMentionCount: null,
    expectAttachmentCount: null,
    expectAttachmentDataRefCount: null,
    expectDriveAttachmentCount: null,
    expectQuotedMessage: null,
    expectQuoteDepth: null,
    expectEventIdentity: false,
    expectDuplicateDeliveries: null,
    expectIdempotencyMode: null,
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
    } else if (arg === "--expect-events") {
      args.expectEvents = Number(rest[++index]);
    } else if (arg.startsWith("--expect-events=")) {
      args.expectEvents = Number(arg.slice("--expect-events=".length));
    } else if (arg === "--expect-http-posts") {
      args.expectHttpPosts = Number(rest[++index]);
    } else if (arg.startsWith("--expect-http-posts=")) {
      args.expectHttpPosts = Number(arg.slice("--expect-http-posts=".length));
    } else if (arg === "--expect-event-type") {
      args.expectEventType = rest[++index];
    } else if (arg.startsWith("--expect-event-type=")) {
      args.expectEventType = arg.slice("--expect-event-type=".length);
    } else if (arg === "--expect-action-method") {
      args.expectActionMethod = rest[++index];
    } else if (arg.startsWith("--expect-action-method=")) {
      args.expectActionMethod = arg.slice("--expect-action-method=".length);
    } else if (arg === "--expect-card-action-state") {
      args.expectCardActionState = true;
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
    } else if (arg === "--expect-duplicate-deliveries") {
      args.expectDuplicateDeliveries = Number(rest[++index]);
    } else if (arg.startsWith("--expect-duplicate-deliveries=")) {
      args.expectDuplicateDeliveries = Number(
        arg.slice("--expect-duplicate-deliveries=".length),
      );
    } else if (arg === "--expect-idempotency-mode") {
      args.expectIdempotencyMode = rest[++index];
    } else if (arg.startsWith("--expect-idempotency-mode=")) {
      args.expectIdempotencyMode = arg.slice("--expect-idempotency-mode=".length);
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

function requireNonEmpty(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }
}

function requireIntegerOrNull(value, name) {
  if (value !== null && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

function defaultSince(env) {
  if (env.GOOGLE_CHAT_LOG_SMOKE_SINCE) {
    return env.GOOGLE_CHAT_LOG_SMOKE_SINCE;
  }
  return new Date(Date.now() - 10 * 60 * 1000).toISOString();
}

function makeRunId(env) {
  if (env.GOOGLE_CHAT_LOG_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_LOG_SMOKE_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `log-smoke-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function timestampClause(since, until) {
  return [
    `timestamp>="${since}"`,
    until ? `timestamp<="${until}"` : null,
  ]
    .filter(Boolean)
    .join(" AND ");
}

function buildFilters(config) {
  const common = [
    'resource.type="cloud_run_revision"',
    `resource.labels.service_name="${config.service}"`,
    timestampClause(config.since, config.until),
  ].join(" AND ");

  return {
    errors: `${common} AND severity>=ERROR`,
    events: `${common} AND logName="projects/${config.project}/logs/run.googleapis.com%2Fstdout" AND jsonPayload.event="chat_event_received"`,
    httpPosts: `${common} AND httpRequest.requestUrl:"/api/chat/events"`,
  };
}

export function resolveLogSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_CHAT_LOG_SMOKE !== "1") {
    throw new Error(
      "Refusing to run Chat log smoke without RUN_LIVE_CHAT_LOG_SMOKE=1.",
    );
  }

  const project = args.project ?? env.GOOGLE_CLOUD_PROJECT;
  const service = args.service ?? env.GOOGLE_CHAT_CLOUD_RUN_SERVICE ?? DEFAULT_SERVICE;
  const since = args.since ?? defaultSince(env);
  const until = args.until ?? env.GOOGLE_CHAT_LOG_SMOKE_UNTIL ?? null;

  requireNonEmpty(project, "--project or GOOGLE_CLOUD_PROJECT");
  requireNonEmpty(service, "--service or GOOGLE_CHAT_CLOUD_RUN_SERVICE");
  requireNonEmpty(since, "--since");
  requireIntegerOrNull(args.expectEvents, "--expect-events");
  requireIntegerOrNull(args.expectHttpPosts, "--expect-http-posts");
  requireIntegerOrNull(args.expectMentionCount, "--expect-mention-count");
  requireIntegerOrNull(args.expectAttachmentCount, "--expect-attachment-count");
  requireIntegerOrNull(
    args.expectAttachmentDataRefCount,
    "--expect-attachment-data-ref-count",
  );
  requireIntegerOrNull(
    args.expectDriveAttachmentCount,
    "--expect-drive-attachment-count",
  );
  requireIntegerOrNull(args.expectQuoteDepth, "--expect-quote-depth");
  requireIntegerOrNull(
    args.expectDuplicateDeliveries,
    "--expect-duplicate-deliveries",
  );
  if (!Number.isInteger(args.limit) || args.limit <= 0) {
    throw new Error("--limit must be a positive integer.");
  }

  return {
    dryRun: args.dryRun,
    project,
    service,
    since,
    until,
    limit: args.limit,
    expectations: {
      events: args.expectEvents,
      httpPosts: args.expectHttpPosts,
      eventType: args.expectEventType,
      actionMethod: args.expectActionMethod,
      cardActionState: args.expectCardActionState,
      mentionCount: args.expectMentionCount,
      attachmentCount: args.expectAttachmentCount,
      attachmentDataRefCount: args.expectAttachmentDataRefCount,
      driveAttachmentCount: args.expectDriveAttachmentCount,
      quotedMessage: args.expectQuotedMessage,
      quoteDepth: args.expectQuoteDepth,
      eventIdentity: args.expectEventIdentity,
      duplicateDeliveries: args.expectDuplicateDeliveries,
      idempotencyMode: args.expectIdempotencyMode,
    },
    runId: makeRunId(env),
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_LOG_SMOKE_EVIDENCE,
      cwd,
    ),
  };
}

function runGcloudLoggingRead(filter, config) {
  const result = spawnSync(
    "gcloud",
    [
      "logging",
      "read",
      filter,
      "--project",
      config.project,
      "--limit",
      String(config.limit),
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `gcloud logging read failed: ${result.stderr || result.stdout}`,
    );
  }

  return JSON.parse(result.stdout || "[]");
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

function summarizeEventEntry(config, entry) {
  const payload = entry.jsonPayload ?? {};
  const summary = payload.eventDebugSummary ?? {};
  const message = summary.message ?? {};
  const action = summary.action ?? {};
  const annotations = message.annotations ?? {};
  const attachments = message.attachments ?? {};
  const identity = payload.eventIdentity ?? summary.identity ?? {};
  const idempotency = payload.idempotency ?? {};

  return {
    timestamp: entry.timestamp ?? null,
    severity: entry.severity ?? null,
    revision: entry.resource?.labels?.revision_name ?? null,
    eventType: payload.eventType ?? null,
    addOnEnvelope: Boolean(payload.addOnEnvelope),
    duplicateDelivery: Boolean(payload.duplicateDelivery),
    idempotency: {
      mode: typeof idempotency.mode === "string" ? idempotency.mode : null,
      claimed:
        typeof idempotency.claimed === "boolean" ? idempotency.claimed : null,
      duplicate:
        typeof idempotency.duplicate === "boolean" ? idempotency.duplicate : null,
      seenCount:
        typeof idempotency.seenCount === "number" ? idempotency.seenCount : null,
    },
    hasAuthorization: Boolean(payload.hasAuthorization),
    messageNameAvailable: typeof payload.messageName === "string",
    messageNameHash: payload.messageName
      ? stableHash(config.project, payload.messageName)
      : null,
    debugSummary: {
      sourceShape: summary.sourceShape ?? null,
      kind: summary.kind ?? null,
      eventTime: summary.eventTime ?? null,
      dialogEventType: summary.dialogEventType ?? null,
      messageText: {
        length: message.text?.length ?? null,
        sha256: message.text?.sha256 ?? null,
      },
      formattedText: {
        length: message.formattedText?.length ?? null,
        sha256: message.formattedText?.sha256 ?? null,
      },
      annotations: {
        count: annotations.count ?? 0,
        byType: annotations.byType ?? {},
        userMentionCount: annotations.userMentionCount ?? 0,
        slashCommandCount: annotations.slashCommandCount ?? 0,
      },
      attachments: {
        count: attachments.count ?? 0,
        contentTypes: Array.isArray(attachments.items)
          ? attachments.items.map((item) => item.contentType ?? null)
          : [],
        mediaResourceNamesAvailable: Array.isArray(attachments.items)
          ? attachments.items.filter((item) => item.mediaResourceName).length
          : 0,
        attachmentDataRefsAvailable: Array.isArray(attachments.items)
          ? attachments.items.filter(
              (item) => item.hasAttachmentDataRef || item.mediaResourceName,
            ).length
          : 0,
        driveRefsAvailable: Array.isArray(attachments.items)
          ? attachments.items.filter(
              (item) => item.hasDriveDataRef || item.driveFileIdAvailable,
            ).length
          : 0,
        sources: Array.isArray(attachments.items)
          ? attachments.items.map((item) => item.source ?? null)
          : [],
      },
      action: {
        methodName: action.methodName ?? null,
        dialogEventType: action.dialogEventType ?? null,
        parameterCount: action.parameterCount ?? 0,
        parameterKeys: action.parameterKeys ?? [],
        cardActionState: {
          present: action.cardActionState?.present === true,
          decoded: action.cardActionState?.decoded === true,
          encodedLength:
            typeof action.cardActionState?.encodedLength === "number"
              ? action.cardActionState.encodedLength
              : null,
          encodedHash:
            typeof action.cardActionState?.encodedHash === "string"
              ? action.cardActionState.encodedHash
              : null,
          topLevelKeys: Array.isArray(action.cardActionState?.topLevelKeys)
            ? action.cardActionState.topLevelKeys
            : [],
          nestedObjectKeys:
            action.cardActionState?.nestedObjectKeys &&
            typeof action.cardActionState.nestedObjectKeys === "object"
              ? action.cardActionState.nestedObjectKeys
              : {},
          errorName:
            typeof action.cardActionState?.errorName === "string"
              ? action.cardActionState.errorName
              : null,
        },
        formInputCount: action.formInputCount ?? 0,
        formInputKeys: action.formInputKeys ?? [],
      },
      relationship: summary.relationship ?? null,
      identity: {
        source: identity.source ?? null,
        rawKind: identity.rawKind ?? null,
        eventTime: identity.eventTime ?? null,
        resourceNameAvailable: Boolean(identity.resourceNameAvailable),
        resourceNameHash: identity.resourceNameHash ?? null,
        eventIdHash: identity.eventIdHash ?? null,
        idempotencyKeyHash: identity.idempotencyKeyHash ?? null,
        materialShape: identity.materialShape ?? null,
      },
    },
  };
}

function summarizeHttpEntry(entry) {
  return {
    timestamp: entry.timestamp ?? null,
    severity: entry.severity ?? null,
    revision: entry.resource?.labels?.revision_name ?? null,
    method: entry.httpRequest?.requestMethod ?? null,
    status: entry.httpRequest?.status ?? null,
    requestUrlMatchesWebhook:
      typeof entry.httpRequest?.requestUrl === "string" &&
      entry.httpRequest.requestUrl.includes("/api/chat/events"),
    latency: entry.httpRequest?.latency ?? null,
  };
}

function summarizeErrorEntry(config, entry) {
  const rendered = JSON.stringify({
    timestamp: entry.timestamp ?? null,
    severity: entry.severity ?? null,
    textPayload: entry.textPayload ?? null,
    jsonPayload: entry.jsonPayload ?? null,
    status: entry.httpRequest?.status ?? null,
  });

  return {
    timestamp: entry.timestamp ?? null,
    severity: entry.severity ?? null,
    revision: entry.resource?.labels?.revision_name ?? null,
    status: entry.httpRequest?.status ?? null,
    message: summarizeText(config.project, rendered),
  };
}

function matchesExpectation(actual, expected) {
  return expected == null ? null : actual === expected;
}

function buildAssertions(config, logs) {
  const eventTypeMatches =
    config.expectations.eventType == null
      ? null
      : logs.events.every(
          (event) => event.eventType === config.expectations.eventType ||
            event.debugSummary.kind === config.expectations.eventType,
        );
  const actionMethodMatches =
    config.expectations.actionMethod == null
      ? null
      : logs.events.some(
          (event) =>
            event.debugSummary.action.methodName === config.expectations.actionMethod,
        );
  const cardActionStateMatches = config.expectations.cardActionState
    ? logs.events.some(
        (event) =>
          event.debugSummary.action.cardActionState.present === true &&
          event.debugSummary.action.cardActionState.decoded === true,
      )
    : null;
  const mentionCountMatches =
    config.expectations.mentionCount == null
      ? null
      : logs.events.every(
          (event) =>
            event.debugSummary.annotations.userMentionCount ===
            config.expectations.mentionCount,
        );
  const attachmentCountMatches =
    config.expectations.attachmentCount == null
      ? null
      : logs.events.every(
          (event) =>
            event.debugSummary.attachments.count ===
            config.expectations.attachmentCount,
        );
  const quotedMessageMatches =
    config.expectations.quotedMessage == null
      ? null
      : logs.events.every(
          (event) =>
            event.debugSummary.relationship?.hasQuotedMessage === true ||
            event.debugSummary.relationship?.isQuote === true,
        );
  const quoteDepthMatches =
    config.expectations.quoteDepth == null
      ? null
      : logs.events.every(
          (event) =>
            (event.debugSummary.relationship?.quoteDepth ?? 0) >=
            config.expectations.quoteDepth,
        );

  const attachmentDataRefCountMatches =
    config.expectations.attachmentDataRefCount == null
      ? null
      : logs.events.every(
          (event) =>
            event.debugSummary.attachments.attachmentDataRefsAvailable ===
            config.expectations.attachmentDataRefCount,
        );
  const driveAttachmentCountMatches =
    config.expectations.driveAttachmentCount == null
      ? null
      : logs.events.every(
          (event) =>
            event.debugSummary.attachments.driveRefsAvailable ===
            config.expectations.driveAttachmentCount,
        );
  const eventIdentityMatches = config.expectations.eventIdentity
    ? logs.events.every(
        (event) =>
          typeof event.debugSummary.identity.eventIdHash === "string" &&
          typeof event.debugSummary.identity.idempotencyKeyHash === "string" &&
          event.debugSummary.identity.eventIdHash ===
            event.debugSummary.identity.idempotencyKeyHash &&
          event.debugSummary.identity.resourceNameAvailable === true,
      )
    : null;
  const duplicateDeliveryCount = logs.events.filter(
    (event) => event.duplicateDelivery,
  ).length;
  const duplicateDeliveryCountMatches =
    config.expectations.duplicateDeliveries == null
      ? null
      : duplicateDeliveryCount === config.expectations.duplicateDeliveries;
  const idempotencyModeMatches =
    config.expectations.idempotencyMode == null
      ? null
      : logs.events.every(
          (event) =>
            event.idempotency.mode === config.expectations.idempotencyMode,
        );

  return {
    noCloudRunErrors: logs.errors.length === 0,
    allHttpPostsSucceeded: logs.httpPosts.every((entry) => entry.status === 200),
    eventCount: logs.events.length,
    httpPostCount: logs.httpPosts.length,
    duplicateDeliveryCount,
    expectedEventCountMatches: matchesExpectation(
      logs.events.length,
      config.expectations.events,
    ),
    expectedHttpPostCountMatches: matchesExpectation(
      logs.httpPosts.length,
      config.expectations.httpPosts,
    ),
    expectedEventTypeMatches: eventTypeMatches,
    expectedActionMethodMatches: actionMethodMatches,
    expectedCardActionStateMatches: cardActionStateMatches,
    expectedMentionCountMatches: mentionCountMatches,
    expectedAttachmentCountMatches: attachmentCountMatches,
    expectedAttachmentDataRefCountMatches: attachmentDataRefCountMatches,
    expectedDriveAttachmentCountMatches: driveAttachmentCountMatches,
    expectedQuotedMessageMatches: quotedMessageMatches,
    expectedQuoteDepthMatches: quoteDepthMatches,
    expectedEventIdentityMatches: eventIdentityMatches,
    expectedDuplicateDeliveryCountMatches: duplicateDeliveryCountMatches,
    expectedIdempotencyModeMatches: idempotencyModeMatches,
  };
}

function failedAssertions(assertions) {
  return Object.entries(assertions)
    .filter(([, value]) => value === false)
    .map(([key]) => key);
}

async function writeEvidenceFile(config, evidence) {
  const evidencePath =
    config.evidencePath ??
    path.join(defaultEvidenceDir, `chat-log-smoke-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

export function buildLogSmokePlan(config) {
  return {
    mode: config.dryRun ? "dry-run" : "live",
    project: config.project,
    service: config.service,
    since: config.since,
    until: config.until,
    limit: config.limit,
    expectations: config.expectations,
    filters: buildFilters(config),
  };
}

export async function runLogSmoke(
  config,
  { readLogs = runGcloudLoggingRead, writeEvidence = true } = {},
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
        plan: buildLogSmokePlan(config),
      },
    };
  }

  const filters = buildFilters(config);
  const rawErrors = readLogs(filters.errors, config);
  const rawEvents = readLogs(filters.events, config);
  const rawHttpPosts = readLogs(filters.httpPosts, config);
  const logs = {
    errors: rawErrors.map((entry) => summarizeErrorEntry(config, entry)),
    events: rawEvents.map((entry) => summarizeEventEntry(config, entry)),
    httpPosts: rawHttpPosts.map(summarizeHttpEntry),
  };
  const assertions = buildAssertions(config, logs);
  const failures = failedAssertions(assertions);
  const evidence = {
    ok: failures.length === 0,
    mode: "live",
    runId: config.runId,
    project: config.project,
    service: config.service,
    since: config.since,
    until: config.until,
    filters,
    counts: {
      errors: logs.errors.length,
      events: logs.events.length,
      httpPosts: logs.httpPosts.length,
    },
    expectations: config.expectations,
    assertions,
    failures,
    logs,
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

  if (failures.length > 0) {
    const error = new Error(`Chat log smoke assertions failed: ${failures.join(", ")}`);
    error.evidence = evidence;
    throw error;
  }

  return { ok: true, evidence };
}

function usage() {
  return `${[
    "Usage: RUN_LIVE_CHAT_LOG_SMOKE=1 pnpm live:chat-log-smoke -- --since <RFC3339>",
    "",
    "Options:",
    "  --dry-run                       Print Cloud Logging filters without querying logs.",
    "  --project <id>                  Google Cloud project. Defaults to GOOGLE_CLOUD_PROJECT.",
    "  --service <name>                Cloud Run service. Defaults to GOOGLE_CHAT_CLOUD_RUN_SERVICE or chat-ai-sdk-dev-webhook.",
    "  --since <RFC3339>               Lower timestamp bound. Defaults to now minus 10 minutes.",
    "  --until <RFC3339>               Optional upper timestamp bound.",
    "  --limit <n>                     Maximum log entries per query. Default: 100.",
    "  --expect-events <n>             Expected chat_event_received stdout logs.",
    "  --expect-http-posts <n>         Expected /api/chat/events HTTP request logs.",
    "  --expect-event-type <type>      Expected eventType/kind for all event logs.",
    "  --expect-action-method <name>   Expected at least one action method.",
    "  --expect-card-action-state      Expected at least one decoded card action state.",
    "  --expect-mention-count <n>      Expected user mention count for all event logs.",
    "  --expect-attachment-count <n>   Expected attachment count for all event logs.",
    "  --expect-attachment-data-ref-count <n>",
    "                                  Expected Chat media attachmentDataRef count for all event logs.",
    "  --expect-drive-attachment-count <n>",
    "                                  Expected Drive-backed attachment count for all event logs.",
    "  --expect-quoted-message         Expected all event logs to represent a quoted message.",
    "  --expect-quote-depth <n>        Expected all event logs to have quote depth at least n.",
    "  --expect-event-identity         Expected all event logs to include redacted idempotency hashes.",
    "  --expect-duplicate-deliveries <n>",
    "                                  Expected duplicateDelivery=true event log count.",
    "  --expect-idempotency-mode <mode>",
    "                                  Expected every event log to report this redacted idempotency store mode.",
    "  --evidence <path>               Evidence JSON output path.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = resolveLogSmokeConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runLogSmoke(config);
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
