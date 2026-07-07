import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const defaultJobName = "chat-ai-sdk-idempotency-monitor";
const defaultSchedule = "*/30 * * * *";

function parseArgs(argv) {
  const args = {
    dryRun: false,
    project: null,
    location: null,
    job: null,
    source: null,
    serviceAccount: null,
    executeNow: false,
    createScheduler: false,
    schedulerJob: null,
    schedule: null,
    evidencePath: null,
    runId: null,
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
    } else if (arg === "--location") {
      args.location = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--location=")) {
      args.location = arg.slice("--location=".length);
    } else if (arg === "--job") {
      args.job = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--job=")) {
      args.job = arg.slice("--job=".length);
    } else if (arg === "--source") {
      args.source = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--source=")) {
      args.source = arg.slice("--source=".length);
    } else if (arg === "--service-account") {
      args.serviceAccount = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--service-account=")) {
      args.serviceAccount = arg.slice("--service-account=".length);
    } else if (arg === "--execute-now") {
      args.executeNow = true;
    } else if (arg === "--create-scheduler") {
      args.createScheduler = true;
    } else if (arg === "--scheduler-job") {
      args.schedulerJob = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--scheduler-job=")) {
      args.schedulerJob = arg.slice("--scheduler-job=".length);
    } else if (arg === "--schedule") {
      args.schedule = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--schedule=")) {
      args.schedule = arg.slice("--schedule=".length);
    } else if (arg === "--evidence") {
      args.evidencePath = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--evidence=")) {
      args.evidencePath = arg.slice("--evidence=".length);
    } else if (arg === "--run-id") {
      args.runId = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--run-id=")) {
      args.runId = arg.slice("--run-id=".length);
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
  return `idempotency-monitor-job-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export function loadIdempotencyMonitorJobConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_IDEMPOTENCY_MONITOR_JOB !== "1" && !args.dryRun) {
    throw new Error(
      "Refusing to set up idempotency monitor Cloud Run job without RUN_LIVE_IDEMPOTENCY_MONITOR_JOB=1.",
    );
  }

  const project = args.project ?? env.GOOGLE_CLOUD_PROJECT ?? "chat-ai-sdk";
  const location = args.location ?? env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
  const job = args.job ?? env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_JOB ?? defaultJobName;
  const serviceAccount =
    args.serviceAccount ??
    env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_JOB_SERVICE_ACCOUNT ??
    env.GOOGLE_CHAT_CLOUD_RUN_SERVICE_ACCOUNT ??
    `chat-ai-sdk-runtime@${project}.iam.gserviceaccount.com`;

  return {
    dryRun: args.dryRun,
    project,
    location,
    job,
    source: resolvePath(args.source ?? env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_JOB_SOURCE, cwd) ?? repoRoot,
    serviceAccount,
    executeNow: args.executeNow,
    createScheduler: args.createScheduler,
    schedulerJob:
      args.schedulerJob ??
      env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_SCHEDULER_JOB ??
      `${job}-scheduler`,
    schedule: args.schedule ?? env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_SCHEDULE ?? defaultSchedule,
    runId: args.runId ?? env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_JOB_RUN_ID ?? makeRunId(),
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_JOB_EVIDENCE,
      cwd,
    ),
  };
}

function envVarsArgument(envVars) {
  return Object.entries(envVars)
    .map(([key, value]) => `${key}=${String(value).replaceAll(",", "\\,")}`)
    .join(",");
}

function serviceAccountMember(config) {
  return `serviceAccount:${config.serviceAccount}`;
}

function addIamPolicyBindingArgs(config, role) {
  return [
    "projects",
    "add-iam-policy-binding",
    config.project,
    "--member",
    serviceAccountMember(config),
    "--role",
    role,
    "--quiet",
  ];
}

function enableSchedulerApiArgs(config) {
  return [
    "services",
    "enable",
    "cloudscheduler.googleapis.com",
    "--project",
    config.project,
    "--quiet",
  ];
}

function deployArgs(config) {
  return [
    "run",
    "jobs",
    "deploy",
    config.job,
    "--source",
    config.source,
    "--project",
    config.project,
    "--region",
    config.location,
    "--service-account",
    config.serviceAccount,
    "--tasks=1",
    "--max-retries=1",
    "--task-timeout=300s",
    "--labels",
    "component=googlechatai-sdk,purpose=idempotency-monitor",
    "--set-env-vars",
    envVarsArgument({
      GOOGLE_CLOUD_PROJECT: config.project,
      RUN_LIVE_IDEMPOTENCY_MONITOR: "1",
      GOOGLE_CHAT_IDEMPOTENCY_MONITOR_AUTH: "metadata",
      GOOGLE_CHAT_IDEMPOTENCY_MONITOR_WRITE_CLOUD_LOG: "1",
    }),
    "--command",
    "node",
    "--args",
    "tools/cloud/idempotency-monitor.mjs",
    "--quiet",
  ];
}

function executeArgs(config) {
  return [
    "run",
    "jobs",
    "execute",
    config.job,
    "--project",
    config.project,
    "--region",
    config.location,
    "--wait",
    "--quiet",
  ];
}

function schedulerRunUri(config) {
  return `https://${config.location}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${config.project}/jobs/${config.job}:run`;
}

function schedulerArgs(config) {
  return [
    "scheduler",
    "jobs",
    "create",
    "http",
    config.schedulerJob,
    "--project",
    config.project,
    "--location",
    config.location,
    "--schedule",
    config.schedule,
    "--time-zone",
    "Etc/UTC",
    "--uri",
    schedulerRunUri(config),
    "--http-method",
    "POST",
    "--message-body",
    "{}",
    "--oauth-service-account-email",
    config.serviceAccount,
    "--oauth-token-scope",
    "https://www.googleapis.com/auth/cloud-platform",
    "--attempt-deadline",
    "180s",
    "--max-retry-attempts",
    "1",
    "--description",
    "Runs the Google Chat AI SDK Firestore idempotency monitor.",
    "--quiet",
  ];
}

function command(operation, args, { persistent = true } = {}) {
  return { operation, args, persistent };
}

export function buildIdempotencyMonitorJobPlan(config) {
  const commands = [
    command(
      "projects.addIamPolicyBinding.datastoreUser",
      addIamPolicyBindingArgs(config, "roles/datastore.user"),
    ),
    command(
      "projects.addIamPolicyBinding.datastoreIndexAdmin",
      addIamPolicyBindingArgs(config, "roles/datastore.indexAdmin"),
    ),
    command(
      "projects.addIamPolicyBinding.loggingWriter",
      addIamPolicyBindingArgs(config, "roles/logging.logWriter"),
    ),
    command("run.jobs.deploy", deployArgs(config)),
  ];

  if (config.executeNow) {
    commands.push(command("run.jobs.execute", executeArgs(config), { persistent: false }));
  }

  if (config.createScheduler) {
    commands.push(
      command("services.enable.cloudscheduler", enableSchedulerApiArgs(config)),
    );
    commands.push(command("scheduler.jobs.create.http", schedulerArgs(config)));
  }

  return {
    ok: true,
    mode: config.dryRun ? "dry-run" : "live-cloud-run-job-setup",
    project: config.project,
    location: config.location,
    runId: config.runId,
    job: {
      name: config.job,
      source: config.source,
      serviceAccount: config.serviceAccount,
      authMode: "metadata",
      emitsCloudLog: true,
    },
    scheduler: {
      enabled: config.createScheduler,
      job: config.schedulerJob,
      schedule: config.schedule,
      uri: schedulerRunUri(config),
      oauthServiceAccount: config.serviceAccount,
    },
    commands,
    privacy: {
      usesDownloadedServiceAccountKey: false,
      uploadsIgnoredSecrets: false,
      monitorWritesRawDocumentNames: false,
      monitorWritesRawEventKeys: false,
      monitorWritesMetadataJson: false,
    },
  };
}

function defaultRunCommand(args) {
  return execFileSync("gcloud", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function writeEvidenceFile(config, evidence) {
  const evidencePath =
    config.evidencePath ??
    path.join(defaultEvidenceDir, `cloud-idempotency-monitor-job-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

export async function runIdempotencyMonitorJobSetup(
  config,
  { runCommand = defaultRunCommand, writeEvidence = true } = {},
) {
  if (config.help) {
    return { ok: true, help: true };
  }

  const plan = buildIdempotencyMonitorJobPlan(config);

  if (config.dryRun) {
    return plan;
  }

  const results = [];
  for (const entry of plan.commands) {
    const output = runCommand(entry.args);
    results.push({
      operation: entry.operation,
      output: output ? safeJson(output) : null,
    });
  }

  const result = {
    ...plan,
    results,
  };

  if (writeEvidence) {
    result.evidencePath = await writeEvidenceFile(config, result);
  }

  return result;
}

function safeJson(output) {
  try {
    return JSON.parse(output);
  } catch {
    return { text: output.slice(0, 500) };
  }
}

function usage() {
  return `${[
    "Usage: pnpm cloud:idempotency-monitor-job",
    "",
    "Plans or deploys a Cloud Run Job that runs the Firestore idempotency monitor",
    "with metadata-server auth and redacted Cloud Logging output.",
    "Requires RUN_LIVE_IDEMPOTENCY_MONITOR_JOB=1 unless --dry-run is supplied.",
    "",
    "Options:",
    "  --dry-run                    Show planned gcloud commands.",
    "  --project <id>               Google Cloud project. Defaults to GOOGLE_CLOUD_PROJECT.",
    "  --location <region>          Google Cloud region. Default: us-central1.",
    `  --job <name>                 Cloud Run Job name. Default: ${defaultJobName}.`,
    "  --source <path>              Source directory. Default: repo root.",
    "  --service-account <email>    Job runtime service account.",
    "  --execute-now                Execute the job once after deploy.",
    "  --create-scheduler           Also create a Cloud Scheduler HTTP job.",
    `  --schedule <cron>            Scheduler cron. Default: ${defaultSchedule}.`,
    "  --scheduler-job <name>       Cloud Scheduler job name.",
    "  --evidence <path>            Evidence JSON output path.",
    "  --run-id <id>                Stable run id for evidence.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = loadIdempotencyMonitorJobConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runIdempotencyMonitorJobSetup(config);
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
