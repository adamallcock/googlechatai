import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateGcloudIgnore } from "./source-upload-check.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const defaultService = "googlechatai-sdk-staging";
const defaultCollection = "googleChatEventIdempotency";
const defaultConcurrency = 20;
const defaultMemory = "512Mi";

function parseArgs(argv) {
  const args = {
    dryRun: false,
    project: null,
    location: null,
    service: null,
    audience: null,
    collection: null,
    repository: null,
    image: null,
    serviceAccount: null,
    concurrency: null,
    memory: null,
    source: null,
    evidencePath: null,
    runId: null,
    help: false,
  };
  const values = argv.slice(2);
  const aliases = new Map([
    ["--project", "project"],
    ["--location", "location"],
    ["--service", "service"],
    ["--audience", "audience"],
    ["--collection", "collection"],
    ["--repository", "repository"],
    ["--image", "image"],
    ["--service-account", "serviceAccount"],
    ["--concurrency", "concurrency"],
    ["--memory", "memory"],
    ["--source", "source"],
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
    args[key] = key === "concurrency" ? Number(configuredValue) : configuredValue;
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

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function positiveInteger(value, fallback, name) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return selected;
}

function numberEnv(value) {
  return value === undefined || value === "" ? null : Number(value);
}

function memoryValue(value) {
  if (typeof value !== "string" || !/^\d+(?:Mi|Gi)$/.test(value)) {
    throw new Error("--memory must use an explicit Cloud Run quantity such as 512Mi or 1Gi.");
  }
  return value;
}

function firestoreCollectionPath(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("--collection must be a non-empty Firestore collection path.");
  }
  const segments = value.split("/");
  if (segments.length % 2 === 0 || segments.some((segment) => segment.trim() === "")) {
    throw new Error(
      "--collection must be an odd-segment Firestore collection path, such as claims or apps/app-id/claims.",
    );
  }
  return segments.join("/");
}

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `sdk-reference-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function envVarsArgument(envVars) {
  return Object.entries(envVars)
    .map(([name, value]) => `${name}=${String(value).replaceAll(",", "\\,")}`)
    .join(",");
}

export function loadSdkReferenceDeployConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    return { help: true };
  }
  if (!args.dryRun && env.RUN_LIVE_SDK_REFERENCE_DEPLOY !== "1") {
    throw new Error(
      "Refusing to deploy the SDK reference without RUN_LIVE_SDK_REFERENCE_DEPLOY=1.",
    );
  }

  const project = args.project ?? env.GOOGLE_CLOUD_PROJECT ?? "chat-ai-sdk";
  const location = args.location ?? env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
  const repository =
    args.repository ?? env.GOOGLE_CHAT_ARTIFACT_REPOSITORY ?? "googlechatai-images";
  const runId = args.runId ?? env.GOOGLE_CHAT_SDK_REFERENCE_RUN_ID ?? makeRunId();
  const service = args.service ?? env.GOOGLE_CHAT_SDK_REFERENCE_SERVICE ?? defaultService;
  const image =
    args.image ??
    env.GOOGLE_CHAT_SDK_REFERENCE_IMAGE ??
    `${location}-docker.pkg.dev/${project}/${repository}/googlechatai-sdk-reference:${runId}`;
  const serviceAccount =
    args.serviceAccount ??
    env.GOOGLE_CHAT_CLOUD_RUN_SERVICE_ACCOUNT ??
    `chat-ai-sdk-runtime@${project}.iam.gserviceaccount.com`;
  const audience = args.audience ?? env.GOOGLE_CHAT_SDK_REFERENCE_AUDIENCE ?? null;
  const source = resolvePath(args.source ?? env.GOOGLE_CHAT_SDK_REFERENCE_SOURCE, cwd) ?? repoRoot;

  if (!args.dryRun) {
    requiredString(audience, "GOOGLE_CHAT_SDK_REFERENCE_AUDIENCE or --audience");
    validateGcloudIgnore(source);
  }

  return {
    dryRun: args.dryRun,
    project,
    location,
    service,
    audience,
    collection: firestoreCollectionPath(
      args.collection ??
        env.GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION ??
        defaultCollection,
    ),
    repository,
    image,
    serviceAccount,
    concurrency: positiveInteger(
      args.concurrency ?? numberEnv(env.GOOGLE_CHAT_SDK_REFERENCE_CONCURRENCY),
      defaultConcurrency,
      "--concurrency",
    ),
    memory: memoryValue(args.memory ?? env.GOOGLE_CHAT_SDK_REFERENCE_MEMORY ?? defaultMemory),
    source,
    cloudBuildConfig: path.join(repoRoot, "examples/cloud-run-node-sdk/cloudbuild.yaml"),
    evidencePath: resolvePath(args.evidencePath ?? env.GOOGLE_CHAT_SDK_REFERENCE_EVIDENCE, cwd),
    runId,
  };
}

export function buildSdkReferenceDeployCommands(config) {
  const envVars = {
    GOOGLE_CLOUD_PROJECT: config.project,
    GOOGLE_CHAT_AUDIENCE: config.audience,
    GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION: config.collection,
    GOOGLE_CHAT_MAX_BODY_BYTES: "1048576",
    NODE_ENV: "production",
  };
  return [
    {
      operation: "cloudbuild.submit.sdk-reference",
      args: [
        "builds",
        "submit",
        config.source,
        "--project",
        config.project,
        "--config",
        config.cloudBuildConfig,
        "--substitutions",
        `_IMAGE=${config.image}`,
        "--quiet",
      ],
    },
    {
      operation: "run.deploy.sdk-reference",
      args: [
        "run",
        "deploy",
        config.service,
        "--project",
        config.project,
        "--region",
        config.location,
        "--image",
        config.image,
        "--service-account",
        config.serviceAccount,
        "--concurrency",
        String(config.concurrency),
        "--memory",
        config.memory,
        "--allow-unauthenticated",
        "--set-env-vars",
        envVarsArgument(envVars),
        "--quiet",
      ],
    },
  ];
}

function describeArgs(config) {
  return [
    "run",
    "services",
    "describe",
    config.service,
    "--project",
    config.project,
    "--region",
    config.location,
    "--format=json(status.url,status.latestReadyRevisionName,status.traffic)",
  ];
}

function publicCommandSummary(command) {
  return {
    operation: command.operation,
    writes: true,
  };
}

export function buildSdkReferenceDeployPlan(config) {
  const commands = buildSdkReferenceDeployCommands(config);
  return {
    ok: true,
    mode: config.dryRun ? "dry-run" : "live-sdk-reference-deploy",
    project: config.project,
    location: config.location,
    service: config.service,
    image: config.image,
    runId: config.runId,
    audienceConfigured: Boolean(config.audience),
    idempotency: {
      mode: "firestore",
      collectionConfigured: Boolean(config.collection),
      metadataServerAuthentication: true,
    },
    capacity: {
      concurrency: config.concurrency,
      memory: config.memory,
      maxRequestBodyBytes: 1_048_576,
    },
    commands: commands.map(publicCommandSummary),
    chatBoundary: {
      chatAppConfigurationChanged: false,
      liveChatWritePerformed: false,
      requiredBeforeChatSmoke: [
        "Configure the dedicated staging Chat app endpoint manually.",
        "Set GOOGLE_CHAT_SDK_REFERENCE_CHAT_ENDPOINT_CONFIGURED=1.",
        "Use the dedicated smoke-space runbook and its explicit guard.",
      ],
    },
    privacy: {
      savesTokens: false,
      savesRawChatPayloads: false,
      savesAudienceValue: false,
    },
  };
}

function defaultRunCommand(args) {
  return execFileSync("gcloud", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function deploymentSummary(raw) {
  const description = JSON.parse(raw);
  const serviceUrl = description?.status?.url;
  if (typeof serviceUrl !== "string" || serviceUrl === "") {
    throw new Error("Cloud Run service description did not contain a service URL.");
  }
  return {
    serviceUrl,
    healthUrl: `${serviceUrl.replace(/\/+$/, "")}/healthz`,
    chatEventsUrl: `${serviceUrl.replace(/\/+$/, "")}/chat/events`,
    latestReadyRevisionName:
      typeof description?.status?.latestReadyRevisionName === "string"
        ? description.status.latestReadyRevisionName
        : null,
    traffic: Array.isArray(description?.status?.traffic)
      ? description.status.traffic.map((entry) => ({
          percent: typeof entry?.percent === "number" ? entry.percent : null,
          latestRevision: entry?.latestRevision === true,
        }))
      : [],
  };
}

async function writeEvidenceFile(config, result) {
  const evidencePath =
    config.evidencePath ??
    path.join(defaultEvidenceDir, `cloud-sdk-reference-deploy-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
  return evidencePath;
}

export async function deploySdkReference(
  config,
  { runCommand = defaultRunCommand, writeEvidence = true } = {},
) {
  if (config.help) {
    return { ok: true, help: true };
  }
  const plan = buildSdkReferenceDeployPlan(config);
  if (config.dryRun) {
    return plan;
  }

  for (const command of buildSdkReferenceDeployCommands(config)) {
    runCommand(command.args);
  }
  const deployment = deploymentSummary(runCommand(describeArgs(config)));
  const result = {
    ...plan,
    deployment,
  };
  if (writeEvidence) {
    result.evidencePath = await writeEvidenceFile(config, result);
  }
  return result;
}

function usage() {
  return `${[
    "Usage: pnpm cloud:deploy-sdk-reference [--dry-run] [options]",
    "",
    "Builds the package-routed Cloud Run reference in Cloud Build and deploys a separate service.",
    "Requires RUN_LIVE_SDK_REFERENCE_DEPLOY=1 unless --dry-run is supplied.",
    "A live deploy also requires --audience or GOOGLE_CHAT_SDK_REFERENCE_AUDIENCE.",
    "",
    "Options:",
    "  --project <id>            Google Cloud project.",
    "  --location <region>       Cloud Run and Artifact Registry region.",
    `  --service <name>          Service name. Default: ${defaultService}.`,
    "  --audience <value>        Required Google Chat JWT audience for the staging endpoint.",
    "  --collection <path>       Firestore idempotency collection path.",
    "  --repository <name>       Artifact Registry repository.",
    "  --image <uri>             Artifact Registry image URI.",
    "  --service-account <email> Cloud Run runtime service account.",
    `  --concurrency <n>        Explicit per-instance concurrency. Default: ${defaultConcurrency}.`,
    `  --memory <quantity>      Explicit Cloud Run memory (for example 512Mi). Default: ${defaultMemory}.`,
    "  --source <path>           Repository root sent to Cloud Build.",
    "  --evidence <path>         Ignored local evidence JSON path.",
    "  --run-id <id>             Stable evidence/image suffix.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = loadSdkReferenceDeployConfig();
    if (config.help) {
      process.stdout.write(usage());
      return;
    }
    process.stdout.write(`${JSON.stringify(await deploySdkReference(config), null, 2)}\n`);
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
