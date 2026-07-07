import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const defaultCloudLogName = "googlechatai-sdk-idempotency-monitor";
const defaultDisplayName = "Google Chat AI SDK idempotency monitor warning/failure";

function parseArgs(argv) {
  const args = {
    dryRun: false,
    project: null,
    runId: null,
    cloudLogName: null,
    displayName: null,
    evidencePath: null,
    keepPolicy: false,
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
    } else if (arg === "--project") {
      args.project = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--project=")) {
      args.project = arg.slice("--project=".length);
    } else if (arg === "--run-id") {
      args.runId = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--run-id=")) {
      args.runId = arg.slice("--run-id=".length);
    } else if (arg === "--cloud-log-name") {
      args.cloudLogName = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--cloud-log-name=")) {
      args.cloudLogName = arg.slice("--cloud-log-name=".length);
    } else if (arg === "--display-name") {
      args.displayName = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--display-name=")) {
      args.displayName = arg.slice("--display-name=".length);
    } else if (arg === "--evidence") {
      args.evidencePath = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--evidence=")) {
      args.evidencePath = arg.slice("--evidence=".length);
    } else if (arg === "--keep-policy") {
      args.keepPolicy = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function resolvePath(input, cwd = process.cwd()) {
  if (!input) {
    return null;
  }
  return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `idempotency-alert-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export function loadIdempotencyAlertSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_IDEMPOTENCY_ALERT_SMOKE !== "1" && !args.dryRun) {
    throw new Error(
      "Refusing to run idempotency alert smoke without RUN_LIVE_IDEMPOTENCY_ALERT_SMOKE=1.",
    );
  }

  return {
    dryRun: args.dryRun,
    project: args.project ?? env.GOOGLE_CLOUD_PROJECT ?? "chat-ai-sdk",
    runId:
      args.runId ?? env.GOOGLE_CHAT_IDEMPOTENCY_ALERT_RUN_ID ?? makeRunId(),
    cloudLogName:
      args.cloudLogName ??
      env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_CLOUD_LOG_NAME ??
      defaultCloudLogName,
    displayName:
      args.displayName ??
      env.GOOGLE_CHAT_IDEMPOTENCY_ALERT_DISPLAY_NAME ??
      defaultDisplayName,
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_IDEMPOTENCY_ALERT_EVIDENCE,
      cwd,
    ),
    deleteAfterCreate: !args.keepPolicy,
  };
}

function logFilter(config) {
  return [
    `logName="projects/${config.project}/logs/${config.cloudLogName}"`,
    'jsonPayload.event="google_chat_idempotency_monitor"',
    "(jsonPayload.warningCount>0 OR jsonPayload.failureCount>0)",
  ].join(" AND ");
}

export function buildIdempotencyAlertPolicy(config) {
  return {
    displayName: `[smoke:${config.runId}] ${config.displayName}`,
    enabled: false,
    combiner: "OR",
    conditions: [
      {
        displayName: "Idempotency monitor warning or failure log",
        conditionMatchedLog: {
          filter: logFilter(config),
        },
      },
    ],
    alertStrategy: {
      notificationRateLimit: {
        period: "300s",
      },
      autoClose: "604800s",
    },
    documentation: {
      mimeType: "text/markdown",
      content:
        "Temporary smoke policy for the Google Chat AI SDK idempotency monitor. Production policies should add approved notification channels and a scheduled monitor runner.",
    },
    userLabels: {
      component: "googlechatai_sdk",
      smoke: "true",
    },
  };
}

function defaultRunCommand(args) {
  return execFileSync("gcloud", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createPolicyArgs(config, policy) {
  return [
    "monitoring",
    "policies",
    "create",
    "--project",
    config.project,
    "--policy",
    JSON.stringify(policy),
    "--format=json",
    "--quiet",
  ];
}

function deletePolicyArgs(config, policyName) {
  return [
    "monitoring",
    "policies",
    "delete",
    policyName,
    "--project",
    config.project,
    "--quiet",
  ];
}

async function writeEvidenceFile(config, evidence) {
  const evidencePath =
    config.evidencePath ??
    path.join(defaultEvidenceDir, `cloud-idempotency-alert-smoke-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

export async function runIdempotencyAlertSmoke(
  config,
  { runCommand = defaultRunCommand, writeEvidence = true } = {},
) {
  if (config.help) {
    return { ok: true, help: true };
  }

  const policy = buildIdempotencyAlertPolicy(config);
  const plan = {
    ok: true,
    mode: config.dryRun ? "dry-run" : "live-temporary-alert-policy",
    project: config.project,
    runId: config.runId,
    deleteAfterCreate: config.deleteAfterCreate,
    policy,
    privacy: {
      rawLogEntriesSaved: false,
      messageTextSaved: false,
      tokensSaved: false,
    },
  };

  if (config.dryRun) {
    return plan;
  }

  const created = JSON.parse(runCommand(createPolicyArgs(config, policy)));
  const result = {
    ...plan,
    created: {
      name: created.name ?? null,
      displayName: created.displayName ?? null,
      enabled: created.enabled ?? null,
    },
    deleted: false,
  };

  if (!result.created.name) {
    throw new Error("Cloud Monitoring policy create did not return a policy name.");
  }

  if (config.deleteAfterCreate) {
    runCommand(deletePolicyArgs(config, result.created.name));
    result.deleted = true;
  }

  if (writeEvidence) {
    result.evidencePath = await writeEvidenceFile(config, result);
  }

  return result;
}

function usage() {
  return `${[
    "Usage: pnpm cloud:idempotency-alert-smoke",
    "",
    "Creates a temporary disabled Cloud Monitoring LogMatch alert policy for the",
    "Google Chat idempotency monitor log, then deletes it by default.",
    "Requires RUN_LIVE_IDEMPOTENCY_ALERT_SMOKE=1 unless --dry-run is supplied.",
    "",
    "Options:",
    "  --dry-run                    Show the alert policy JSON without creating it.",
    "  --project <id>               Google Cloud project. Defaults to GOOGLE_CLOUD_PROJECT.",
    `  --cloud-log-name <name>      Cloud Logging log id. Default: ${defaultCloudLogName}.`,
    "  --display-name <name>        Alert display name suffix.",
    "  --keep-policy                Leave the disabled policy in Cloud Monitoring.",
    "  --evidence <path>            Evidence JSON output path.",
    "  --run-id <id>                Stable run id for evidence.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = loadIdempotencyAlertSmokeConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runIdempotencyAlertSmoke(config);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
      process.stdout.write(usage());
      return;
    }
    console.error(
      JSON.stringify(
        {
          name: error.name ?? "Error",
          message: error.message ?? String(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
