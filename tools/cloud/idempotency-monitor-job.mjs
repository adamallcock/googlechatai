import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateGcloudIgnore } from "./source-upload-check.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const defaultJobName = "chat-ai-sdk-idempotency-monitor";
const defaultSchedule = "*/30 * * * *";
const defaultDatabase = "(default)";
const defaultCollection = "googleChatEventIdempotency";
const defaultTtlField = "expiresAt";
const defaultCloudLogName = "googlechatai-sdk-idempotency-monitor";

function parseArgs(argv) {
  const args = {
    dryRun: false,
    project: null,
    location: null,
    job: null,
    source: null,
    serviceAccount: null,
    schedulerServiceAccount: null,
    database: null,
    collection: null,
    ttlField: null,
    cloudLogName: null,
    countUpTo: null,
    warnDocs: null,
    failDocs: null,
    sampleLimit: null,
    expiredWarnDocs: null,
    expiredFailDocs: null,
    expectedEventsPerMinute: null,
    retentionMinutes: null,
    allowTtlUnknown: false,
    executeNow: false,
    createScheduler: false,
    upsertScheduler: false,
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
    } else if (arg === "--scheduler-service-account") {
      args.schedulerServiceAccount = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--scheduler-service-account=")) {
      args.schedulerServiceAccount = arg.slice("--scheduler-service-account=".length);
    } else if (arg === "--database") {
      args.database = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--database=")) {
      args.database = arg.slice("--database=".length);
    } else if (arg === "--collection") {
      args.collection = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--collection=")) {
      args.collection = arg.slice("--collection=".length);
    } else if (arg === "--ttl-field") {
      args.ttlField = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--ttl-field=")) {
      args.ttlField = arg.slice("--ttl-field=".length);
    } else if (arg === "--cloud-log-name") {
      args.cloudLogName = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--cloud-log-name=")) {
      args.cloudLogName = arg.slice("--cloud-log-name=".length);
    } else if (arg === "--count-up-to") {
      args.countUpTo = Number(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--count-up-to=")) {
      args.countUpTo = Number(arg.slice("--count-up-to=".length));
    } else if (arg === "--warn-docs") {
      args.warnDocs = Number(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--warn-docs=")) {
      args.warnDocs = Number(arg.slice("--warn-docs=".length));
    } else if (arg === "--fail-docs") {
      args.failDocs = Number(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--fail-docs=")) {
      args.failDocs = Number(arg.slice("--fail-docs=".length));
    } else if (arg === "--sample-limit") {
      args.sampleLimit = Number(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--sample-limit=")) {
      args.sampleLimit = Number(arg.slice("--sample-limit=".length));
    } else if (arg === "--expired-warn-docs") {
      args.expiredWarnDocs = Number(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--expired-warn-docs=")) {
      args.expiredWarnDocs = Number(arg.slice("--expired-warn-docs=".length));
    } else if (arg === "--expired-fail-docs") {
      args.expiredFailDocs = Number(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--expired-fail-docs=")) {
      args.expiredFailDocs = Number(arg.slice("--expired-fail-docs=".length));
    } else if (arg === "--expected-events-per-minute") {
      args.expectedEventsPerMinute = Number(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--expected-events-per-minute=")) {
      args.expectedEventsPerMinute = Number(arg.slice("--expected-events-per-minute=".length));
    } else if (arg === "--retention-minutes") {
      args.retentionMinutes = Number(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--retention-minutes=")) {
      args.retentionMinutes = Number(arg.slice("--retention-minutes=".length));
    } else if (arg === "--allow-ttl-unknown") {
      args.allowTtlUnknown = true;
    } else if (arg === "--execute-now") {
      args.executeNow = true;
    } else if (arg === "--create-scheduler") {
      args.createScheduler = true;
    } else if (arg === "--upsert-scheduler") {
      args.upsertScheduler = true;
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
  if (args.createScheduler && args.upsertScheduler) {
    throw new Error("Choose either --create-scheduler or --upsert-scheduler, not both.");
  }

  const project = args.project ?? env.GOOGLE_CLOUD_PROJECT ?? "chat-ai-sdk";
  const location = args.location ?? env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
  const job = args.job ?? env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_JOB ?? defaultJobName;
  const serviceAccount =
    args.serviceAccount ??
    env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_JOB_SERVICE_ACCOUNT ??
    env.GOOGLE_CHAT_CLOUD_RUN_SERVICE_ACCOUNT ??
    `chat-ai-sdk-runtime@${project}.iam.gserviceaccount.com`;
  const source =
    resolvePath(args.source ?? env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_JOB_SOURCE, cwd) ?? repoRoot;
  const schedulerServiceAccountConfigured =
    args.schedulerServiceAccount ?? env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_SCHEDULER_SERVICE_ACCOUNT;
  const schedulerServiceAccount =
    schedulerServiceAccountConfigured ??
    `chat-ai-sdk-monitor-scheduler@${project}.iam.gserviceaccount.com`;
  const warnDocs = args.warnDocs ?? numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_WARN_DOCS);
  const failDocs = args.failDocs ?? numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_FAIL_DOCS);
  const expectedEventsPerMinute =
    args.expectedEventsPerMinute ??
    numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EXPECTED_EVENTS_PER_MINUTE);
  const retentionMinutes =
    args.retentionMinutes ?? numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_RETENTION_MINUTES);
  if ((warnDocs === null) !== (failDocs === null)) {
    throw new Error("--warn-docs and --fail-docs must be supplied together.");
  }
  if (
    !args.dryRun &&
    !((warnDocs !== null && failDocs !== null) ||
      (expectedEventsPerMinute !== null && retentionMinutes !== null))
  ) {
    throw new Error(
      "Cloud Run monitor setup requires --warn-docs/--fail-docs or --expected-events-per-minute with --retention-minutes.",
    );
  }
  if (!args.dryRun) {
    validateGcloudIgnore(source);
  }

  return {
    dryRun: args.dryRun,
    project,
    location,
    job,
    source,
    serviceAccount,
    schedulerServiceAccount,
    schedulerServiceAccountManaged: schedulerServiceAccountConfigured == null,
    database:
      args.database ?? env.GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_DATABASE ?? defaultDatabase,
    collection:
      args.collection ?? env.GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION ?? defaultCollection,
    ttlField: args.ttlField ?? env.GOOGLE_CHAT_IDEMPOTENCY_TTL_FIELD ?? defaultTtlField,
    cloudLogName:
      args.cloudLogName ??
      env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_CLOUD_LOG_NAME ??
      defaultCloudLogName,
    countUpTo:
      args.countUpTo ?? numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_COUNT_UP_TO),
    warnDocs,
    failDocs,
    sampleLimit:
      args.sampleLimit ?? numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_SAMPLE_LIMIT),
    expiredWarnDocs:
      args.expiredWarnDocs ??
      numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EXPIRED_WARN_DOCS),
    expiredFailDocs:
      args.expiredFailDocs ??
      numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EXPIRED_FAIL_DOCS),
    expectedEventsPerMinute,
    retentionMinutes,
    allowTtlUnknown:
      args.allowTtlUnknown || env.GOOGLE_CHAT_IDEMPOTENCY_ALLOW_TTL_UNKNOWN === "1",
    executeNow: args.executeNow,
    createScheduler: args.createScheduler,
    upsertScheduler: args.upsertScheduler,
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

function numberEnv(value) {
  return value === undefined || value === "" ? null : Number(value);
}

function envVarsArgument(envVars) {
  return Object.entries(envVars)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${String(value).replaceAll(",", "\\,")}`)
    .join(",");
}

function monitorEnvironment(config) {
  return {
    GOOGLE_CLOUD_PROJECT: config.project,
    RUN_LIVE_IDEMPOTENCY_MONITOR: "1",
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_AUTH: "metadata",
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_WRITE_CLOUD_LOG: "1",
    GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_DATABASE: config.database,
    GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION: config.collection,
    GOOGLE_CHAT_IDEMPOTENCY_TTL_FIELD: config.ttlField,
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_CLOUD_LOG_NAME: config.cloudLogName,
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_COUNT_UP_TO: config.countUpTo,
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_WARN_DOCS: config.warnDocs,
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_FAIL_DOCS: config.failDocs,
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_SAMPLE_LIMIT: config.sampleLimit,
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EXPIRED_WARN_DOCS: config.expiredWarnDocs,
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EXPIRED_FAIL_DOCS: config.expiredFailDocs,
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EXPECTED_EVENTS_PER_MINUTE:
      config.expectedEventsPerMinute,
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_RETENTION_MINUTES: config.retentionMinutes,
    ...(config.allowTtlUnknown
      ? { GOOGLE_CHAT_IDEMPOTENCY_ALLOW_TTL_UNKNOWN: "1" }
      : {}),
  };
}

function serviceAccountMember(config) {
  return `serviceAccount:${config.serviceAccount}`;
}

function schedulerServiceAccountMember(config) {
  return `serviceAccount:${config.schedulerServiceAccount}`;
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

function schedulerServiceAccountId(config) {
  const [account] = config.schedulerServiceAccount.split("@");
  return account;
}

function schedulerServiceAccountDescribeArgs(config) {
  return [
    "iam",
    "service-accounts",
    "describe",
    config.schedulerServiceAccount,
    "--project",
    config.project,
    "--format=json(email)",
  ];
}

function schedulerServiceAccountCreateArgs(config) {
  return [
    "iam",
    "service-accounts",
    "create",
    schedulerServiceAccountId(config),
    "--project",
    config.project,
    "--display-name",
    "Google Chat AI SDK monitor scheduler",
    "--quiet",
  ];
}

function addJobInvokerBindingArgs(config) {
  return [
    "run",
    "jobs",
    "add-iam-policy-binding",
    config.job,
    "--project",
    config.project,
    "--region",
    config.location,
    "--member",
    schedulerServiceAccountMember(config),
    "--role",
    "roles/run.invoker",
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
    envVarsArgument(monitorEnvironment(config)),
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
  return `https://run.googleapis.com/v2/projects/${config.project}/locations/${config.location}/jobs/${config.job}:run`;
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
    config.schedulerServiceAccount,
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

function schedulerUpdateArgs(config) {
  const create = schedulerArgs(config);
  return ["scheduler", "jobs", "update", "http", ...create.slice(4)];
}

function schedulerDescribeArgs(config) {
  return [
    "scheduler",
    "jobs",
    "describe",
    config.schedulerJob,
    "--project",
    config.project,
    "--location",
    config.location,
    "--format=json(name)",
  ];
}

function command(operation, args, { persistent = true } = {}) {
  return { operation, args, persistent };
}

export function buildIdempotencyMonitorJobPlan(config) {
  const commands = [
    command(
      "projects.addIamPolicyBinding.datastoreViewer",
      addIamPolicyBindingArgs(config, "roles/datastore.viewer"),
    ),
    command(
      "projects.addIamPolicyBinding.loggingWriter",
      addIamPolicyBindingArgs(config, "roles/logging.logWriter"),
    ),
    command("run.jobs.deploy", deployArgs(config)),
  ];

  const schedulerEnabled = config.createScheduler || config.upsertScheduler;
  if (schedulerEnabled) {
    // A standalone Job deployment does not need an invocation identity. Create
    // and bind the dedicated Scheduler account only when a recurring trigger
    // is actually requested.
    commands.push(
      command(
        "iam.serviceAccounts.ensure.scheduler",
        schedulerServiceAccountDescribeArgs(config),
      ),
    );
    commands.push(
      command("run.jobs.addIamPolicyBinding.invoker", addJobInvokerBindingArgs(config)),
    );
  }

  if (config.executeNow) {
    commands.push(command("run.jobs.execute", executeArgs(config), { persistent: false }));
  }

  if (schedulerEnabled) {
    commands.push(
      command("services.enable.cloudscheduler", enableSchedulerApiArgs(config)),
    );
    commands.push(
      command(
        config.upsertScheduler ? "scheduler.jobs.upsert.http" : "scheduler.jobs.create.http",
        schedulerArgs(config),
      ),
    );
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
      monitorTarget: {
        database: config.database,
        collection: config.collection,
        ttlField: config.ttlField,
        cloudLogName: config.cloudLogName,
      },
    },
    scheduler: {
      enabled: schedulerEnabled,
      mode: config.upsertScheduler ? "upsert" : config.createScheduler ? "create" : "none",
      job: config.schedulerJob,
      schedule: config.schedule,
      uri: schedulerRunUri(config),
      oauthServiceAccount: config.schedulerServiceAccount,
      serviceAccountManaged: config.schedulerServiceAccountManaged,
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
    let operation = entry.operation;
    let output;
    if (entry.operation === "iam.serviceAccounts.ensure.scheduler") {
      if (!config.schedulerServiceAccountManaged) {
        output = runCommand(schedulerServiceAccountDescribeArgs(config));
        operation = "iam.serviceAccounts.verify.scheduler";
      } else {
        try {
          output = runCommand(schedulerServiceAccountDescribeArgs(config));
          operation = "iam.serviceAccounts.exists.scheduler";
        } catch {
          output = runCommand(schedulerServiceAccountCreateArgs(config));
          operation = "iam.serviceAccounts.create.scheduler";
        }
      }
    } else if (entry.operation === "scheduler.jobs.upsert.http") {
      let exists = false;
      try {
        runCommand(schedulerDescribeArgs(config));
        exists = true;
      } catch {
        exists = false;
      }
      operation = exists ? "scheduler.jobs.update.http" : "scheduler.jobs.create.http";
      output = runCommand(exists ? schedulerUpdateArgs(config) : schedulerArgs(config));
    } else {
      output = runCommand(entry.args);
    }
    results.push({
      operation,
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
    "  --scheduler-service-account <email> Dedicated Cloud Scheduler invocation identity (created when omitted).",
    "  --database <id>               Firestore database. Default: (default).",
    "  --collection <path>           Firestore idempotency collection path.",
    "  --ttl-field <field>           Firestore TTL field.",
    "  --cloud-log-name <name>       Redacted monitor Cloud Logging log id.",
    "  --count-up-to <n>             Monitor aggregation upper bound.",
    "  --warn-docs <n>               Monitor document warning threshold.",
    "  --fail-docs <n>               Monitor document failure threshold.",
    "  --sample-limit <n>            Monitor diagnostic sample bound.",
    "  --expired-warn-docs <n>       Expired-document warning threshold.",
    "  --expired-fail-docs <n>       Expired-document failure threshold.",
    "  --expected-events-per-minute <n> Pilot capacity budget for derived document thresholds.",
    "  --retention-minutes <n>       Idempotency retention duration for derived thresholds.",
    "  --allow-ttl-unknown           Allow unavailable TTL metadata.",
    "  --execute-now                Execute the job once after deploy.",
    "  --create-scheduler           Also create a Cloud Scheduler HTTP job.",
    "  --upsert-scheduler           Create or update the Cloud Scheduler HTTP job idempotently.",
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
