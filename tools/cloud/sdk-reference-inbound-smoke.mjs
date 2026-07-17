import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const defaultService = "googlechatai-sdk-staging";

function parseArgs(argv) {
  const args = {
    dryRun: false,
    project: null,
    service: null,
    runId: null,
    since: null,
    until: null,
    waitSeconds: 60,
    pollIntervalMs: 5_000,
    limit: 100,
    evidencePath: null,
    help: false,
  };
  const aliases = new Map([
    ["--project", "project"],
    ["--service", "service"],
    ["--run-id", "runId"],
    ["--since", "since"],
    ["--until", "until"],
    ["--wait-seconds", "waitSeconds"],
    ["--poll-interval-ms", "pollIntervalMs"],
    ["--limit", "limit"],
    ["--evidence", "evidencePath"],
  ]);
  const numberKeys = new Set(["waitSeconds", "pollIntervalMs", "limit"]);
  const values = argv.slice(2);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--") {
      continue;
    }
    if (value === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (value === "--help" || value === "-h") {
      args.help = true;
      continue;
    }
    const [name, inlineValue] = value.split("=", 2);
    const key = aliases.get(name);
    if (!key) {
      throw new Error(`Unknown argument: ${value}`);
    }
    const configuredValue = inlineValue ?? values[index + 1];
    if (!configuredValue || configuredValue.startsWith("--")) {
      throw new Error(`${name} requires a value.`);
    }
    args[key] = numberKeys.has(key) ? Number(configuredValue) : configuredValue;
    if (inlineValue === undefined) {
      index += 1;
    }
  }
  return args;
}

function resolvePath(value, cwd = process.cwd()) {
  return value ? (path.isAbsolute(value) ? value : path.resolve(cwd, value)) : null;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function timestamp(value, name) {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be an RFC3339 timestamp.`);
  }
  return value;
}

export function smokeCorrelation(runId) {
  return crypto.createHash("sha256").update(runId, "utf8").digest("hex");
}

export function loadSdkReferenceInboundSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    return { help: true };
  }
  if (!args.dryRun) {
    for (const [name, value] of [
      ["RUN_LIVE_CHAT_SMOKE", env.RUN_LIVE_CHAT_SMOKE],
      ["RUN_LIVE_CHAT_INBOUND_SMOKE", env.RUN_LIVE_CHAT_INBOUND_SMOKE],
      ["RUN_LIVE_SDK_REFERENCE_INBOUND_SMOKE", env.RUN_LIVE_SDK_REFERENCE_INBOUND_SMOKE],
      [
        "GOOGLE_CHAT_SDK_REFERENCE_CHAT_ENDPOINT_CONFIGURED",
        env.GOOGLE_CHAT_SDK_REFERENCE_CHAT_ENDPOINT_CONFIGURED,
      ],
    ]) {
      if (value !== "1") {
        throw new Error(`${name}=1 is required for the reference inbound smoke.`);
      }
    }
  }

  const project = requiredString(
    args.project ?? env.GOOGLE_CLOUD_PROJECT,
    "--project or GOOGLE_CLOUD_PROJECT",
  );
  const runId = requiredString(
    args.runId ?? env.GOOGLE_CHAT_SDK_REFERENCE_INBOUND_SMOKE_RUN_ID,
    "--run-id",
  );
  const since = timestamp(
    requiredString(
      args.since ?? env.GOOGLE_CHAT_SDK_REFERENCE_INBOUND_SMOKE_SINCE,
      "--since",
    ),
    "--since",
  );
  const until = args.until ?? env.GOOGLE_CHAT_SDK_REFERENCE_INBOUND_SMOKE_UNTIL ?? null;
  if (until) {
    timestamp(until, "--until");
  }

  return {
    dryRun: args.dryRun,
    project,
    service: args.service ?? env.GOOGLE_CHAT_SDK_REFERENCE_SERVICE ?? defaultService,
    runId,
    correlation: smokeCorrelation(runId),
    since,
    until,
    waitSeconds: nonNegativeInteger(args.waitSeconds, "--wait-seconds"),
    pollIntervalMs: positiveInteger(args.pollIntervalMs, "--poll-interval-ms"),
    limit: positiveInteger(args.limit, "--limit"),
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_SDK_REFERENCE_INBOUND_SMOKE_EVIDENCE,
      cwd,
    ),
  };
}

function timestampClause(config) {
  return [
    `timestamp>=\"${config.since}\"`,
    config.until ? `timestamp<=\"${config.until}\"` : null,
  ]
    .filter(Boolean)
    .join(" AND ");
}

export function buildSdkReferenceInboundSmokeFilters(config) {
  const common = [
    'resource.type="cloud_run_revision"',
    `resource.labels.service_name="${config.service}"`,
    timestampClause(config),
  ].join(" AND ");
  return {
    errors: `${common} AND severity>=ERROR`,
    correlatedHandler: [
      common,
      `logName="projects/${config.project}/logs/run.googleapis.com%2Fstdout"`,
      'jsonPayload.message="cloud_run_reference.inbound_smoke_handled"',
      `jsonPayload.smokeCorrelation="${config.correlation}"`,
      'jsonPayload.eventKind="message"',
      'jsonPayload.source="chat_http"',
      "jsonPayload.responseStatus=200",
    ].join(" AND "),
    httpPosts: `${common} AND httpRequest.requestMethod="POST" AND httpRequest.requestUrl:"/chat/events"`,
  };
}

export function buildSdkReferenceInboundSmokePlan(config) {
  return {
    ok: true,
    mode: config.dryRun ? "dry-run" : "manual-inbound-certification",
    project: config.project,
    service: config.service,
    runId: config.runId,
    since: config.since,
    until: config.until,
    waitSeconds: config.waitSeconds,
    pollIntervalMs: config.pollIntervalMs,
    manualAction: {
      surface: "chat.google.com",
      instruction:
        `In the dedicated smoke space, select GoogleChatAISDK from @ autocomplete, include googlechatai-smoke:${config.runId} in the message, and send exactly one mention.`,
      rawAtTextWarning:
        "Do not type a raw @GoogleChatAISDK string; select the app from autocomplete so Chat creates a real mention.",
    },
    filters: buildSdkReferenceInboundSmokeFilters(config),
    privacy: {
      writesChatMessages: false,
      savesRawMessageText: false,
      savesRawEventIds: false,
      savesAccessTokens: false,
      correlationStoredAsHash: true,
    },
  };
}

function defaultReadLogs(filter, config) {
  const output = execFileSync(
    "gcloud",
    [
      "logging",
      "read",
      filter,
      "--project",
      config.project,
      "--limit",
      String(config.limit),
      "--format=json",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const parsed = JSON.parse(output || "[]");
  return Array.isArray(parsed) ? parsed : [];
}

function summarizeError(entry) {
  return {
    timestamp: typeof entry?.timestamp === "string" ? entry.timestamp : null,
    severity: typeof entry?.severity === "string" ? entry.severity : null,
    revision:
      typeof entry?.resource?.labels?.revision_name === "string"
        ? entry.resource.labels.revision_name
        : null,
  };
}

function summarizeHandler(entry) {
  const payload = entry?.jsonPayload ?? {};
  return {
    timestamp: typeof entry?.timestamp === "string" ? entry.timestamp : null,
    severity: typeof entry?.severity === "string" ? entry.severity : null,
    revision:
      typeof entry?.resource?.labels?.revision_name === "string"
        ? entry.resource.labels.revision_name
        : null,
    eventKind: typeof payload.eventKind === "string" ? payload.eventKind : null,
    source: typeof payload.source === "string" ? payload.source : null,
    responseStatus: typeof payload.responseStatus === "number" ? payload.responseStatus : null,
  };
}

function summarizeHttpPost(entry) {
  return {
    timestamp: typeof entry?.timestamp === "string" ? entry.timestamp : null,
    revision:
      typeof entry?.resource?.labels?.revision_name === "string"
        ? entry.resource.labels.revision_name
        : null,
    status: typeof entry?.httpRequest?.status === "number" ? entry.httpRequest.status : null,
    method:
      typeof entry?.httpRequest?.requestMethod === "string"
        ? entry.httpRequest.requestMethod
        : null,
  };
}

function assertions(logs) {
  return {
    noCloudRunErrors: logs.errors.length === 0,
    exactlyOneCorrelatedHandler: logs.handlers.length === 1,
    exactlyOneHttpPost: logs.httpPosts.length === 1,
    allHttpPostsSucceeded: logs.httpPosts.every((entry) => entry.status === 200),
  };
}

function failedAssertionNames(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== true)
    .map(([name]) => name);
}

async function writeEvidenceFile(config, evidence) {
  const evidencePath =
    config.evidencePath ??
    path.join(defaultEvidenceDir, `cloud-sdk-reference-inbound-smoke-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runSdkReferenceInboundSmoke(
  config,
  {
    readLogs = defaultReadLogs,
    writeEvidence = true,
    wait = sleep,
    now = () => Date.now(),
  } = {},
) {
  if (config.help) {
    return { ok: true, evidence: { help: true } };
  }
  const plan = buildSdkReferenceInboundSmokePlan(config);
  if (config.dryRun) {
    return { ok: true, evidence: plan };
  }

  const deadline = now() + config.waitSeconds * 1_000;
  const attempts = [];
  let lastEvidence = null;
  do {
    const filters = buildSdkReferenceInboundSmokeFilters(config);
    const logs = {
      errors: readLogs(filters.errors, config).map(summarizeError),
      handlers: readLogs(filters.correlatedHandler, config)
        .filter((entry) => entry?.jsonPayload?.smokeCorrelation === config.correlation)
        .map(summarizeHandler),
      httpPosts: readLogs(filters.httpPosts, config).map(summarizeHttpPost),
    };
    const results = assertions(logs);
    const failures = failedAssertionNames(results);
    const evidence = {
      ...plan,
      ok: failures.length === 0,
      filters,
      logs,
      assertions: results,
      failures,
      attempts: attempts.length + 1,
    };
    lastEvidence = evidence;
    attempts.push({ ok: evidence.ok, failures, counts: {
      errors: logs.errors.length,
      handlers: logs.handlers.length,
      httpPosts: logs.httpPosts.length,
    } });
    if (evidence.ok) {
      evidence.attempts = attempts;
      if (writeEvidence) {
        evidence.evidencePath = await writeEvidenceFile(config, evidence);
      }
      return { ok: true, evidence };
    }
    if (now() >= deadline) {
      break;
    }
    await wait(Math.min(config.pollIntervalMs, Math.max(0, deadline - now())));
  } while (true);

  const evidence = {
    ...lastEvidence,
    ok: false,
    attempts,
  };
  if (writeEvidence) {
    evidence.evidencePath = await writeEvidenceFile(config, evidence);
  }
  const error = new Error(
    `Reference inbound smoke did not observe the correlated handler event within ${config.waitSeconds}s.`,
  );
  error.evidence = evidence;
  throw error;
}

function usage() {
  return `${[
    "Usage: pnpm cloud:sdk-reference-inbound-smoke -- --run-id <id> --since <RFC3339>",
    "",
    "Verifies a manually sent dedicated-space mention against the package-routed /chat/events and structured handler-log contract.",
    "It never sends a Chat message; send the instructed mention before running this verifier.",
    "",
    "Options:",
    "  --dry-run                  Print the manual action and redacted log filters.",
    "  --project <id>             Google Cloud project.",
    `  --service <name>           Cloud Run service. Default: ${defaultService}.`,
    "  --run-id <id>              Unique marker included in the manual message.",
    "  --since <RFC3339>          Timestamp from before the manual message.",
    "  --until <RFC3339>          Optional upper timestamp bound.",
    "  --wait-seconds <n>         Poll timeout. Default: 60.",
    "  --poll-interval-ms <n>     Poll interval. Default: 5000.",
    "  --limit <n>                Maximum matching logs per query. Default: 100.",
    "  --evidence <path>          Ignored local evidence path.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = loadSdkReferenceInboundSmokeConfig();
    if (config.help) {
      process.stdout.write(usage());
      return;
    }
    const result = await runSdkReferenceInboundSmoke(config);
    process.stdout.write(`${JSON.stringify(result.evidence, null, 2)}\n`);
  } catch (error) {
    console.error(JSON.stringify({
      name: error.name ?? "Error",
      message: error.message ?? String(error),
      evidence: error.evidence ?? null,
    }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
