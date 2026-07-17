import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  loadIdempotencyMonitorJobConfig,
  runIdempotencyMonitorJobSetup,
} from "./idempotency-monitor-job.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const defaultCloudLogName = "googlechatai-sdk-idempotency-monitor";
const defaultDisplayName = "Google Chat AI SDK idempotency monitor warning/failure";
const defaultDatabase = "(default)";
const defaultCollection = "googleChatEventIdempotency";
const defaultTtlField = "expiresAt";
const notificationChannelPattern = /^projects\/[^/]+\/notificationChannels\/[^/]+$/;

function parseArgs(argv) {
  const args = {
    dryRun: false,
    project: null,
    location: null,
    job: null,
    serviceAccount: null,
    schedulerServiceAccount: null,
    schedulerJob: null,
    schedule: null,
    database: null,
    collection: null,
    ttlField: null,
    countUpTo: null,
    warnDocs: null,
    failDocs: null,
    sampleLimit: null,
    expiredWarnDocs: null,
    expiredFailDocs: null,
    expectedEventsPerMinute: null,
    retentionMinutes: null,
    allowTtlUnknown: false,
    notificationChannel: null,
    cloudLogName: null,
    displayName: null,
    skipInitialRun: false,
    evidencePath: null,
    runId: null,
    help: false,
  };
  const values = argv.slice(2);
  const aliases = new Map([
    ["--project", "project"],
    ["--location", "location"],
    ["--job", "job"],
    ["--service-account", "serviceAccount"],
    ["--scheduler-service-account", "schedulerServiceAccount"],
    ["--scheduler-job", "schedulerJob"],
    ["--schedule", "schedule"],
    ["--database", "database"],
    ["--collection", "collection"],
    ["--ttl-field", "ttlField"],
    ["--count-up-to", "countUpTo"],
    ["--warn-docs", "warnDocs"],
    ["--fail-docs", "failDocs"],
    ["--sample-limit", "sampleLimit"],
    ["--expired-warn-docs", "expiredWarnDocs"],
    ["--expired-fail-docs", "expiredFailDocs"],
    ["--expected-events-per-minute", "expectedEventsPerMinute"],
    ["--retention-minutes", "retentionMinutes"],
    ["--notification-channel", "notificationChannel"],
    ["--cloud-log-name", "cloudLogName"],
    ["--display-name", "displayName"],
    ["--evidence", "evidencePath"],
    ["--run-id", "runId"],
  ]);

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--") {
      continue;
    }
    if (value === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (value === "--skip-initial-run") {
      args.skipInitialRun = true;
      continue;
    }
    if (value === "--allow-ttl-unknown") {
      args.allowTtlUnknown = true;
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
    args[key] = new Set([
      "countUpTo",
      "warnDocs",
      "failDocs",
      "sampleLimit",
      "expiredWarnDocs",
      "expiredFailDocs",
      "expectedEventsPerMinute",
      "retentionMinutes",
    ]).has(key)
      ? Number(configuredValue)
      : configuredValue;
    if (inlineValue === undefined) {
      index += 1;
    }
  }
  return args;
}

function resolvePath(value, cwd = process.cwd()) {
  if (!value) {
    return null;
  }
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `idempotency-monitor-production-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function validNotificationChannel(value) {
  return typeof value === "string" && notificationChannelPattern.test(value);
}

function numberEnv(value) {
  return value === undefined || value === "" ? null : Number(value);
}

export function loadProductionMonitorConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    return { help: true };
  }
  if (!args.dryRun && env.RUN_LIVE_IDEMPOTENCY_MONITOR_PRODUCTION !== "1") {
    throw new Error(
      "Refusing production idempotency-monitor setup without RUN_LIVE_IDEMPOTENCY_MONITOR_PRODUCTION=1.",
    );
  }

  const project = args.project ?? env.GOOGLE_CLOUD_PROJECT ?? "chat-ai-sdk";
  const job = args.job ?? env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_JOB ?? "chat-ai-sdk-idempotency-monitor";
  const notificationChannel =
    args.notificationChannel ?? env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_NOTIFICATION_CHANNEL ?? null;
  const schedulerServiceAccountConfigured =
    args.schedulerServiceAccount ?? env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_SCHEDULER_SERVICE_ACCOUNT;
  const explicitWarnDocs =
    args.warnDocs ?? numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_WARN_DOCS);
  const explicitFailDocs =
    args.failDocs ?? numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_FAIL_DOCS);
  const expectedEventsPerMinute =
    args.expectedEventsPerMinute ??
    numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EXPECTED_EVENTS_PER_MINUTE);
  const retentionMinutes =
    args.retentionMinutes ?? numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_RETENTION_MINUTES);
  const capacityBudgetConfigured =
    (explicitWarnDocs !== null && explicitFailDocs !== null) ||
    (expectedEventsPerMinute !== null && retentionMinutes !== null);
  if ((explicitWarnDocs === null) !== (explicitFailDocs === null)) {
    throw new Error("--warn-docs and --fail-docs must be supplied together.");
  }
  if (!args.dryRun && !validNotificationChannel(notificationChannel)) {
    throw new Error(
      "A full projects/.../notificationChannels/... value is required for production idempotency monitoring.",
    );
  }
  if (!args.dryRun && !capacityBudgetConfigured) {
    throw new Error(
      "Production monitoring requires --warn-docs/--fail-docs or --expected-events-per-minute with --retention-minutes.",
    );
  }

  return {
    dryRun: args.dryRun,
    project,
    location: args.location ?? env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
    job,
    serviceAccount:
      args.serviceAccount ??
      env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_JOB_SERVICE_ACCOUNT ??
      env.GOOGLE_CHAT_CLOUD_RUN_SERVICE_ACCOUNT ??
      `chat-ai-sdk-runtime@${project}.iam.gserviceaccount.com`,
    schedulerServiceAccount:
      schedulerServiceAccountConfigured ??
      `chat-ai-sdk-monitor-scheduler@${project}.iam.gserviceaccount.com`,
    schedulerServiceAccountManaged: schedulerServiceAccountConfigured == null,
    schedulerJob:
      args.schedulerJob ??
      env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_SCHEDULER_JOB ??
      `${job}-scheduler`,
    schedule: args.schedule ?? env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_SCHEDULE ?? "*/30 * * * *",
    notificationChannel,
    cloudLogName:
      args.cloudLogName ??
      env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_CLOUD_LOG_NAME ??
      defaultCloudLogName,
    database:
      args.database ?? env.GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_DATABASE ?? defaultDatabase,
    collection:
      args.collection ??
      env.GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION ??
      defaultCollection,
    ttlField: args.ttlField ?? env.GOOGLE_CHAT_IDEMPOTENCY_TTL_FIELD ?? defaultTtlField,
    countUpTo:
      args.countUpTo ?? numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_COUNT_UP_TO),
    warnDocs: explicitWarnDocs,
    failDocs: explicitFailDocs,
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
    capacityBudgetConfigured,
    allowTtlUnknown:
      args.allowTtlUnknown || env.GOOGLE_CHAT_IDEMPOTENCY_ALLOW_TTL_UNKNOWN === "1",
    displayName:
      args.displayName ??
      env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_PRODUCTION_ALERT_DISPLAY_NAME ??
      defaultDisplayName,
    executeNow: !args.skipInitialRun,
    runId: args.runId ?? env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_PRODUCTION_RUN_ID ?? makeRunId(),
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_PRODUCTION_EVIDENCE,
      cwd,
    ),
  };
}

function logFilter(config) {
  return [
    `logName="projects/${config.project}/logs/${config.cloudLogName}"`,
    'jsonPayload.event="google_chat_idempotency_monitor"',
    "(jsonPayload.warningCount>0 OR jsonPayload.failureCount>0)",
  ].join(" AND ");
}

function jobFailureLogFilter(config) {
  return [
    'resource.type="cloud_run_job"',
    `resource.labels.job_name="${config.job}"`,
    "severity>=ERROR",
  ].join(" AND ");
}

export function buildProductionAlertPolicy(config) {
  if (!validNotificationChannel(config.notificationChannel)) {
    return null;
  }
  return {
    displayName: config.displayName,
    enabled: true,
    combiner: "OR",
    notificationChannels: [config.notificationChannel],
    conditions: [
      {
        displayName: "Idempotency monitor warning or failure log",
        conditionMatchedLog: { filter: logFilter(config) },
      },
      {
        displayName: "Idempotency monitor Cloud Run Job failure",
        conditionMatchedLog: { filter: jobFailureLogFilter(config) },
      },
    ],
    alertStrategy: {
      notificationRateLimit: { period: "300s" },
      autoClose: "604800s",
    },
    documentation: {
      mimeType: "text/markdown",
      content:
        "The Google Chat AI SDK Firestore idempotency monitor reported warnings or failures. Inspect the redacted monitor evidence and restore durable delivery protection before accepting further traffic.",
    },
    userLabels: {
      component: "googlechatai_sdk",
      production: "true",
    },
  };
}

function jobConfig(config) {
  const argv = [
    "node",
    "idempotency-monitor-job.mjs",
    ...(config.dryRun ? ["--dry-run"] : []),
    "--project",
    config.project,
    "--location",
    config.location,
    "--job",
    config.job,
    "--service-account",
    config.serviceAccount,
    "--scheduler-job",
    config.schedulerJob,
    "--schedule",
    config.schedule,
    "--database",
    config.database,
    "--collection",
    config.collection,
    "--ttl-field",
    config.ttlField,
    "--cloud-log-name",
    config.cloudLogName,
    "--upsert-scheduler",
    ...(config.executeNow ? ["--execute-now"] : []),
  ];
  if (!config.schedulerServiceAccountManaged) {
    argv.push("--scheduler-service-account", config.schedulerServiceAccount);
  }
  for (const [flag, value] of [
    ["--count-up-to", config.countUpTo],
    ["--warn-docs", config.warnDocs],
    ["--fail-docs", config.failDocs],
    ["--sample-limit", config.sampleLimit],
    ["--expired-warn-docs", config.expiredWarnDocs],
    ["--expired-fail-docs", config.expiredFailDocs],
    ["--expected-events-per-minute", config.expectedEventsPerMinute],
    ["--retention-minutes", config.retentionMinutes],
  ]) {
    if (value !== null && value !== undefined) {
      argv.push(flag, String(value));
    }
  }
  if (config.allowTtlUnknown) {
    argv.push("--allow-ttl-unknown");
  }
  return loadIdempotencyMonitorJobConfig({
    argv,
    env: { RUN_LIVE_IDEMPOTENCY_MONITOR_JOB: "1" },
  });
}

function listPolicyArgs(config) {
  return [
    "monitoring",
    "policies",
    "list",
    "--project",
    config.project,
    "--filter",
    'user_labels.component="googlechatai_sdk" AND user_labels.production="true"',
    "--format=json(name,displayName,userLabels)",
  ];
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
    "--format=json(name,displayName,enabled)",
    "--quiet",
  ];
}

function updatePolicyArgs(config, policyName, policy) {
  return [
    "monitoring",
    "policies",
    "update",
    policyName,
    "--project",
    config.project,
    "--policy",
    JSON.stringify(policy),
    "--format=json(name,displayName,enabled)",
    "--quiet",
  ];
}

function existingPolicy(raw, config) {
  const values = JSON.parse(raw);
  const policies = Array.isArray(values) ? values : [];
  return policies.find(
    (policy) =>
      policy?.displayName === config.displayName &&
      policy?.userLabels?.component === "googlechatai_sdk" &&
      policy?.userLabels?.production === "true" &&
      typeof policy?.name === "string",
  ) ?? null;
}

export function buildProductionMonitorPlan(config) {
  const alertPolicy = buildProductionAlertPolicy(config);
  const monitorJob = jobConfig(config);
  return {
    ok: Boolean(alertPolicy) && config.capacityBudgetConfigured,
    mode: config.dryRun ? "dry-run" : "live-production-monitor-apply",
    project: config.project,
    location: config.location,
    runId: config.runId,
    monitor: {
      job: config.job,
      schedulerJob: config.schedulerJob,
      schedule: config.schedule,
      schedulerMode: "upsert",
      executeNow: config.executeNow,
      metadataServerAuthentication: true,
      writesRedactedCloudLog: true,
      schedulerServiceAccountManaged: config.schedulerServiceAccountManaged,
      target: {
        database: config.database,
        collection: config.collection,
        ttlField: config.ttlField,
        cloudLogName: config.cloudLogName,
      },
      capacityBudgetConfigured: config.capacityBudgetConfigured,
    },
    alert: {
      configured: Boolean(alertPolicy),
      enabled: alertPolicy?.enabled ?? false,
      notificationChannelConfigured: Boolean(alertPolicy),
      policyAction: "create-or-update",
    },
    jobCommands: jobConfig(config).dryRun
      ? []
      : monitorJob ? ["Cloud Run Job deploy", "Cloud Run Job execute", "Cloud Scheduler upsert"] : [],
    privacy: {
      savesNotificationChannel: false,
      savesTokens: false,
      savesRawFirestoreKeys: false,
      savesRawChatPayloads: false,
    },
  };
}

function defaultRunCommand(args) {
  return execFileSync("gcloud", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function writeEvidenceFile(config, result) {
  const evidencePath =
    config.evidencePath ??
    path.join(defaultEvidenceDir, `cloud-idempotency-monitor-production-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
  return evidencePath;
}

export async function applyProductionMonitor(
  config,
  { runCommand = defaultRunCommand, writeEvidence = true } = {},
) {
  if (config.help) {
    return { ok: true, help: true };
  }
  const plan = buildProductionMonitorPlan(config);
  if (config.dryRun) {
    return plan;
  }
  if (!plan.ok) {
    throw new Error("A valid notification channel is required before production monitor apply.");
  }

  const policy = buildProductionAlertPolicy(config);
  const current = existingPolicy(runCommand(listPolicyArgs(config)), config);
  const operation = current ? "updated" : "created";
  const response = JSON.parse(
    runCommand(
      current
        ? updatePolicyArgs(config, current.name, policy)
        : createPolicyArgs(config, policy),
    ),
  );
  if (response.enabled !== true || typeof response.name !== "string" || response.name === "") {
    throw new Error(
      "Cloud Monitoring did not confirm an enabled managed alert policy with a resource name.",
    );
  }
  // The alert is deliberately created before any scheduler mutation. A failure
  // here leaves no recurring monitor active without an owner notification.
  let job;
  try {
    job = await runIdempotencyMonitorJobSetup(jobConfig(config), {
      runCommand,
      writeEvidence: false,
    });
  } catch (error) {
    const partial = {
      ...plan,
      ok: false,
      monitor: {
        ...plan.monitor,
        jobApplied: false,
      },
      alert: {
        ...plan.alert,
        operation,
        enabled: true,
        policyNamePresent: true,
      },
      failure: {
        name: error.name ?? "Error",
      },
    };
    if (writeEvidence) {
      partial.evidencePath = await writeEvidenceFile(config, partial);
    }
    const wrapped = new Error("Production idempotency monitor job setup failed after alert creation.");
    wrapped.evidence = partial;
    throw wrapped;
  }
  const result = {
    ...plan,
    ok: true,
    monitor: {
      ...plan.monitor,
      jobApplied: job.ok === true,
    },
    alert: {
      ...plan.alert,
      operation,
      enabled: true,
      policyNamePresent: true,
    },
  };
  if (writeEvidence) {
    result.evidencePath = await writeEvidenceFile(config, result);
  }
  return result;
}

function usage() {
  return `${[
    "Usage: pnpm cloud:idempotency-monitor-production [--dry-run] [options]",
    "",
    "Deploys/updates the metadata-auth monitor job, upserts its scheduler, and creates or updates an enabled LogMatch alert.",
    "Requires RUN_LIVE_IDEMPOTENCY_MONITOR_PRODUCTION=1 and a full notification channel unless --dry-run is used.",
    "",
    "Options:",
    "  --project <id>                         Google Cloud project.",
    "  --location <region>                    Cloud Run and Scheduler region.",
    "  --job <name>                           Cloud Run Job name.",
    "  --service-account <email>              Job runtime service account.",
    "  --scheduler-job <name>                 Cloud Scheduler job name.",
    "  --schedule <cron>                      Scheduler cron in UTC.",
    "  --notification-channel <resource>      projects/.../notificationChannels/... resource.",
    "  --cloud-log-name <name>                Idempotency monitor Cloud Log id.",
    "  --display-name <name>                  Stable production alert display name.",
    "  --skip-initial-run                     Deploy without immediately executing the monitor job.",
    "  --evidence <path>                      Ignored local evidence JSON path.",
    "  --run-id <id>                          Stable evidence suffix.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = loadProductionMonitorConfig();
    if (config.help) {
      process.stdout.write(usage());
      return;
    }
    const result = await applyProductionMonitor(config);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
      process.stdout.write(usage());
      return;
    }
    console.error(JSON.stringify({ name: error.name ?? "Error", message: error.message ?? String(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
