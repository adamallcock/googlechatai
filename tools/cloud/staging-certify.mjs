import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const defaultService = "googlechatai-sdk-staging";
const requiredRuntimeEnvNames = new Set([
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CHAT_AUDIENCE",
  "GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION",
]);

function parseArgs(argv) {
  const args = {
    dryRun: false,
    project: null,
    location: null,
    service: null,
    expectedRevision: null,
    chatSmoke: false,
    chatSmokeSince: null,
    evidencePath: null,
    runId: null,
    help: false,
  };
  const values = argv.slice(2);
  const aliases = new Map([
    ["--project", "project"],
    ["--location", "location"],
    ["--service", "service"],
    ["--expected-revision", "expectedRevision"],
    ["--chat-smoke-since", "chatSmokeSince"],
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
    if (value === "--chat-smoke") {
      args.chatSmoke = true;
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
    args[key] = configuredValue;
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
  return `sdk-reference-certify-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export function loadStagingCertificationConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    return { help: true };
  }
  if (args.chatSmoke && env.RUN_LIVE_SDK_REFERENCE_CHAT_SMOKE !== "1") {
    throw new Error(
      "Refusing to run a Chat smoke through staging without RUN_LIVE_SDK_REFERENCE_CHAT_SMOKE=1.",
    );
  }
  if (args.chatSmoke && env.GOOGLE_CHAT_SDK_REFERENCE_CHAT_ENDPOINT_CONFIGURED !== "1") {
    throw new Error(
      "Refusing to run a Chat smoke until GOOGLE_CHAT_SDK_REFERENCE_CHAT_ENDPOINT_CONFIGURED=1 attests that the app uses this staging endpoint.",
    );
  }
  if (args.chatSmoke && env.RUN_LIVE_CHAT_SMOKE !== "1") {
    throw new Error("The standard RUN_LIVE_CHAT_SMOKE=1 guard is also required for a staging Chat smoke.");
  }
  if (args.chatSmoke && env.RUN_LIVE_CHAT_INBOUND_SMOKE !== "1") {
    throw new Error(
      "RUN_LIVE_CHAT_INBOUND_SMOKE=1 is required because staging certification verifies a real inbound mention rather than sending an outbound bot message.",
    );
  }
  if (args.chatSmoke && env.RUN_LIVE_SDK_REFERENCE_INBOUND_SMOKE !== "1") {
    throw new Error(
      "RUN_LIVE_SDK_REFERENCE_INBOUND_SMOKE=1 is required for the package-routed reference inbound smoke.",
    );
  }

  const configuredRunId =
    args.runId ?? env.GOOGLE_CHAT_SDK_REFERENCE_CERTIFY_RUN_ID ?? null;
  const chatSmokeSince =
    args.chatSmokeSince ?? env.GOOGLE_CHAT_SDK_REFERENCE_CHAT_SMOKE_SINCE ?? null;
  if (args.chatSmoke && !configuredRunId) {
    throw new Error(
      "--chat-smoke requires an explicit --run-id prepared before the manual dedicated-space mention.",
    );
  }
  if (args.chatSmoke && !chatSmokeSince) {
    throw new Error(
      "--chat-smoke requires --chat-smoke-since from immediately before the manual dedicated-space mention.",
    );
  }
  const expectedRevision =
    args.expectedRevision ?? env.GOOGLE_CHAT_SDK_REFERENCE_EXPECTED_REVISION ?? null;
  if (!args.dryRun && !expectedRevision) {
    throw new Error(
      "--expected-revision or GOOGLE_CHAT_SDK_REFERENCE_EXPECTED_REVISION is required to bind certification to the deployment just performed.",
    );
  }

  return {
    dryRun: args.dryRun,
    project: args.project ?? env.GOOGLE_CLOUD_PROJECT ?? "chat-ai-sdk",
    location: args.location ?? env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
    service: args.service ?? env.GOOGLE_CHAT_SDK_REFERENCE_SERVICE ?? defaultService,
    expectedRevision,
    chatSmoke: args.chatSmoke,
    chatSmokeSince,
    runId: configuredRunId ?? makeRunId(),
    evidencePath: resolvePath(args.evidencePath ?? env.GOOGLE_CHAT_SDK_REFERENCE_CERTIFY_EVIDENCE, cwd),
  };
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
    "--format=json",
  ];
}

function normalizedBaseUrl(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().replace(/\/+$/, "")
    : null;
}

function containerEnvNames(description) {
  const containers = description?.spec?.template?.spec?.containers ??
    description?.template?.containers ??
    [];
  const values = Array.isArray(containers) ? containers : [];
  return new Set(
    values.flatMap((container) =>
      Array.isArray(container?.env)
        ? container.env.map((entry) => entry?.name).filter((name) => typeof name === "string")
        : [],
    ),
  );
}

function readServiceDescription(raw) {
  const description = JSON.parse(raw);
  const baseUrl = normalizedBaseUrl(description?.status?.url);
  if (!baseUrl) {
    throw new Error("Cloud Run service description did not contain status.url.");
  }
  return {
    baseUrl,
    environmentNames: containerEnvNames(description),
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

async function healthPayload(fetchImpl, baseUrl) {
  const response = await fetchImpl(`${baseUrl}/healthz`, {
    headers: { accept: "application/json" },
    redirect: "error",
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return { response, payload };
}

function check(id, ok, detail) {
  return { id, ok, detail };
}

export function buildStagingCertificationPlan(config) {
  return {
    ok: true,
    mode: config.dryRun ? "dry-run" : "read-only-staging-certification",
    project: config.project,
    location: config.location,
    service: config.service,
    runId: config.runId,
    expectedRevisionConfigured: Boolean(config.expectedRevision),
    checks: [
      "Cloud Run service description and ready revision",
      "Required normal-mode environment variable names",
      "Unauthenticated /healthz response for Google Chat JWT and Firestore mode",
    ],
    chatSmoke: {
      requested: config.chatSmoke,
      writesChatMessages: false,
      requiresManualDedicatedSpaceMention: config.chatSmoke,
      requiresPreparedRunIdAndSince: config.chatSmoke,
      requiresDedicatedSmokeSpace: config.chatSmoke,
      requiresEndpointAttestation: config.chatSmoke,
    },
    privacy: {
      savesRawChatPayloads: false,
      savesTokens: false,
      savesAudienceValue: false,
      savesRuntimeEnvironmentValues: false,
    },
  };
}

function defaultRunCommand(args) {
  return execFileSync("gcloud", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function defaultRunChatSmoke(config) {
  execFileSync("corepack", [
    "pnpm",
    "cloud:sdk-reference-inbound-smoke",
    "--",
    "--project",
    config.project,
    "--service",
    config.service,
    "--run-id",
    config.runId,
    "--since",
    config.chatSmokeSince,
  ], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

async function writeEvidenceFile(config, result) {
  const evidencePath =
    config.evidencePath ??
    path.join(defaultEvidenceDir, `cloud-sdk-reference-certification-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
  return evidencePath;
}

export async function certifyStagingReference(
  config,
  {
    runCommand = defaultRunCommand,
    fetchImpl = globalThis.fetch,
    runChatSmoke = defaultRunChatSmoke,
    writeEvidence = true,
  } = {},
) {
  if (config.help) {
    return { ok: true, help: true };
  }
  const plan = buildStagingCertificationPlan(config);
  if (config.dryRun) {
    return plan;
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Staging certification requires a fetch implementation.");
  }

  const service = readServiceDescription(runCommand(describeArgs(config)));
  const { response, payload } = await healthPayload(fetchImpl, service.baseUrl);
  const checks = [
    check("service-ready-revision", Boolean(service.latestReadyRevisionName), "Cloud Run reports a ready revision."),
    check(
      "expected-ready-revision",
      service.latestReadyRevisionName === config.expectedRevision,
      "The ready revision matches the revision reported by the staging deployment.",
    ),
    check(
      "latest-revision-receives-all-traffic",
      service.traffic.length === 1 &&
        service.traffic[0]?.percent === 100 &&
        service.traffic[0]?.latestRevision === true,
      "The expected latest revision receives 100% of service traffic.",
    ),
    ...[...requiredRuntimeEnvNames].map((name) =>
      check(`runtime-env-${name.toLowerCase()}`, service.environmentNames.has(name), `${name} is configured by name.`),
    ),
    check(
      "local-fixtures-disabled",
      !service.environmentNames.has("GOOGLE_CHAT_LOCAL_FIXTURES"),
      "The service does not configure the local verifier bypass.",
    ),
    check("health-status", response.ok, "The Cloud Run health endpoint returned a successful status."),
    check(
      "health-identity",
      payload?.ok === true && payload?.service === "googlechatai-cloud-run-reference",
      "The health endpoint identifies the package-routed Cloud Run reference.",
    ),
    check(
      "health-verification-mode",
      payload?.verification === "google-chat-jwt",
      "The health endpoint reports normal Google Chat JWT verification mode.",
    ),
    check(
      "health-idempotency-mode",
      payload?.idempotency === "firestore",
      "The health endpoint reports durable Firestore idempotency mode.",
    ),
  ];
  const result = {
    ...plan,
    ok: checks.every((entry) => entry.ok),
    checks,
    deployment: {
      baseUrlConfigured: true,
      latestReadyRevisionName: service.latestReadyRevisionName,
      traffic: service.traffic,
    },
    chatSmoke: {
      ...plan.chatSmoke,
      executed: false,
    },
  };

  if (config.chatSmoke && result.ok) {
    await runChatSmoke(config);
    result.chatSmoke.executed = true;
  }
  if (writeEvidence) {
    result.evidencePath = await writeEvidenceFile(config, result);
  }
  return result;
}

function usage() {
  return `${[
    "Usage: pnpm cloud:staging-certify [--dry-run] [--chat-smoke] [options]",
    "",
    "Reads the deployed package-routed staging service and verifies its public health contract.",
    "--chat-smoke additionally runs the guarded manual inbound-mention smoke only after explicit endpoint attestation.",
    "",
    "Options:",
    "  --project <id>       Google Cloud project.",
    "  --location <region>  Cloud Run region.",
    `  --service <name>     Service name. Default: ${defaultService}.`,
    "  --expected-revision <name> Required ready revision from the deploy result.",
    "  --chat-smoke         Run the manual dedicated-space inbound smoke after read-only checks.",
    "  --chat-smoke-since <RFC3339> Manual-mention lower timestamp bound; required with --chat-smoke.",
    "  --evidence <path>    Ignored local evidence JSON path.",
    "  --run-id <id>        Stable evidence suffix.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = loadStagingCertificationConfig();
    if (config.help) {
      process.stdout.write(usage());
      return;
    }
    const result = await certifyStagingReference(config);
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
