import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function resolveDeployConfig(env = process.env) {
  const project = env.GOOGLE_CLOUD_PROJECT ?? "chat-ai-sdk";
  const location = env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
  const service = env.GOOGLE_CHAT_CLOUD_RUN_SERVICE ?? "chat-ai-sdk-dev-webhook";
  const runtimeServiceAccountId =
    env.GOOGLE_CHAT_CLOUD_RUN_SERVICE_ACCOUNT_ID ?? "chat-ai-sdk-runtime";
  const runtimeServiceAccount =
    env.GOOGLE_CHAT_CLOUD_RUN_SERVICE_ACCOUNT ??
    `${runtimeServiceAccountId}@${project}.iam.gserviceaccount.com`;

  return {
    project,
    location,
    service,
    runtimeServiceAccount,
    source: env.GOOGLE_CHAT_CLOUD_RUN_SOURCE
      ? path.resolve(env.GOOGLE_CHAT_CLOUD_RUN_SOURCE)
      : path.join(root, "examples/cloud-run-node"),
    envVars: buildRuntimeEnvVars(env, project),
  };
}

export function buildRuntimeEnvVars(env = process.env, project = env.GOOGLE_CLOUD_PROJECT) {
  return {
    GOOGLE_CLOUD_PROJECT: project,
    NODE_ENV: "production",
    ...optionalEnvVars(env, [
      "GOOGLE_CHAT_BASE_URL",
      "GOOGLE_CHAT_LOG_EVENT_SUMMARY",
      "GOOGLE_CHAT_IDEMPOTENCY_STORE",
      "GOOGLE_CHAT_IDEMPOTENCY_TTL_MS",
      "GOOGLE_CHAT_IDEMPOTENCY_MAX_ENTRIES",
      "GOOGLE_CHAT_IDEMPOTENCY_FAIL_OPEN",
      "GOOGLE_CHAT_IDEMPOTENCY_FILE",
      "GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_DATABASE",
      "GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION",
    ]),
  };
}

function optionalEnvVars(env, names) {
  return Object.fromEntries(
    names
      .filter((name) => typeof env[name] === "string" && env[name] !== "")
      .map((name) => [name, env[name]]),
  );
}

function envVarsArgument(envVars) {
  return Object.entries(envVars)
    .map(([key, value]) => `${key}=${String(value).replaceAll(",", "\\,")}`)
    .join(",");
}

export function buildDeployArgs(config) {
  return [
    "run",
    "deploy",
    config.service,
    "--source",
    config.source,
    "--project",
    config.project,
    "--region",
    config.location,
    "--service-account",
    config.runtimeServiceAccount,
    "--allow-unauthenticated",
    "--set-env-vars",
    envVarsArgument(config.envVars),
    "--quiet",
  ];
}

export function buildDisableInvokerIamArgs(config) {
  return [
    "run",
    "services",
    "update",
    config.service,
    "--project",
    config.project,
    "--region",
    config.location,
    "--no-invoker-iam-check",
    "--quiet",
  ];
}

function runGcloud(args, { allowFailure = false } = {}) {
  const result = spawnSync("gcloud", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `gcloud ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }

  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

export async function deployWebhook({ env = process.env } = {}) {
  const config = resolveDeployConfig(env);
  const deploy = runGcloud(buildDeployArgs(config), { allowFailure: true });

  if (!deploy.ok) {
    return {
      ok: false,
      project: config.project,
      location: config.location,
      service: config.service,
      error: `${deploy.stdout}\n${deploy.stderr}`
        .split("\n")
        .filter(Boolean)
        .slice(0, 12),
    };
  }

  const publicAccess = runGcloud(buildDisableInvokerIamArgs(config), {
    allowFailure: true,
  });

  if (!publicAccess.ok) {
    return {
      ok: false,
      project: config.project,
      location: config.location,
      service: config.service,
      error: `${publicAccess.stdout}\n${publicAccess.stderr}`
        .split("\n")
        .filter(Boolean)
        .slice(0, 12),
    };
  }

  const describe = runGcloud([
    "run",
    "services",
    "describe",
    config.service,
    "--project",
    config.project,
    "--region",
    config.location,
    "--format=value(status.url)",
  ]);
  const baseUrl = `${describe.stdout.replace(/\/+$/, "")}/api`;

  return {
    ok: true,
    project: config.project,
    location: config.location,
    service: config.service,
    publicAccess: "invoker-iam-check-disabled",
    serviceUrl: describe.stdout,
    baseUrl,
    avatarUrl: `${baseUrl}/avatar.png`,
    chatEventsUrl: `${baseUrl}/chat/events`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await deployWebhook();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exit(1);
  }
}
