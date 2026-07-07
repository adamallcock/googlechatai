import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const expectedServices = [
  "admin.googleapis.com",
  "appsmarket-component.googleapis.com",
  "appsmarket.googleapis.com",
  "artifactregistry.googleapis.com",
  "chat.googleapis.com",
  "cloudbuild.googleapis.com",
  "cloudresourcemanager.googleapis.com",
  "drive.googleapis.com",
  "firestore.googleapis.com",
  "gsuiteaddons.googleapis.com",
  "iam.googleapis.com",
  "iamcredentials.googleapis.com",
  "logging.googleapis.com",
  "monitoring.googleapis.com",
  "people.googleapis.com",
  "pubsub.googleapis.com",
  "run.googleapis.com",
  "secretmanager.googleapis.com",
  "serviceusage.googleapis.com",
  "workspaceevents.googleapis.com",
];

export const billingGatedServices = [
  "artifactregistry.googleapis.com",
  "cloudbuild.googleapis.com",
  "run.googleapis.com",
  "secretmanager.googleapis.com",
];

export function parseBootstrapArgs(argv) {
  const args = {
    dryRun: false,
    allowPartial: false,
  };

  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--allow-partial") {
      args.allowPartial = true;
    } else if (arg === "--") {
      continue;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

export function resolveBootstrapConfig(env = process.env) {
  const project = env.GOOGLE_CLOUD_PROJECT ?? "example-chat-project";
  const location = env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
  const runtimeServiceAccountId =
    env.GOOGLE_CHAT_CLOUD_RUN_SERVICE_ACCOUNT_ID ?? "chat-ai-sdk-runtime";

  return {
    project,
    location,
    credentialsPath:
      env.GOOGLE_APPLICATION_CREDENTIALS ??
      path.join(
        os.homedir(),
        ".config/googlechatai-sdk/credentials/chat-ai-sdk-service-account.json",
      ),
    runtimeServiceAccountId,
    runtimeServiceAccountEmail:
      env.GOOGLE_CHAT_CLOUD_RUN_SERVICE_ACCOUNT ??
      `${runtimeServiceAccountId}@${project}.iam.gserviceaccount.com`,
    artifactRepository: env.GOOGLE_CHAT_ARTIFACT_REPOSITORY ?? "chat-ai-sdk",
    workspaceEventsTopic:
      env.WORKSPACE_EVENTS_PUBSUB_TOPIC ?? "chat-ai-sdk-workspace-events",
    workspaceEventsSubscription:
      env.WORKSPACE_EVENTS_PUBSUB_SUBSCRIPTION ??
      "chat-ai-sdk-workspace-events-dev-pull",
    smokeTestsTopic:
      env.GOOGLE_CHAT_SMOKE_PUBSUB_TOPIC ?? "chat-ai-sdk-smoke-tests",
    smokeTestsSubscription:
      env.GOOGLE_CHAT_SMOKE_PUBSUB_SUBSCRIPTION ??
      "chat-ai-sdk-smoke-tests-dev-pull",
    runtimeProjectRoles: ["roles/datastore.user"],
  };
}

export function splitServicesByBillingRequirement(services = expectedServices) {
  const billingGated = [];
  const normal = [];

  for (const service of services) {
    if (billingGatedServices.includes(service)) {
      billingGated.push(service);
    } else {
      normal.push(service);
    }
  }

  return { normal, billingGated };
}

export function buildBootstrapPlan(config) {
  return {
    project: config.project,
    location: config.location,
    services: splitServicesByBillingRequirement(),
    resources: {
      runtimeServiceAccount: config.runtimeServiceAccountEmail,
      artifactRepository: config.artifactRepository,
      topics: [config.workspaceEventsTopic, config.smokeTestsTopic],
      subscriptions: [
        {
          name: config.workspaceEventsSubscription,
          topic: config.workspaceEventsTopic,
        },
        {
          name: config.smokeTestsSubscription,
          topic: config.smokeTestsTopic,
        },
      ],
      runtimeProjectRoles: config.runtimeProjectRoles,
    },
  };
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
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function hasBillingBlock(output) {
  return (
    /billing/i.test(output) &&
    /not found|must be enabled|billing-enabled/i.test(output)
  );
}

function exists(args) {
  return runGcloud(args, { allowFailure: true }).ok;
}

function ensureServiceEnabled(project, service, dryRun) {
  if (dryRun) {
    return { service, action: "would-enable", ok: true };
  }

  const result = runGcloud(
    ["services", "enable", service, "--project", project, "--quiet"],
    { allowFailure: true },
  );
  const output = `${result.stdout}\n${result.stderr}`;

  return {
    service,
    action: "enable",
    ok: result.ok,
    blockedByBilling: !result.ok && hasBillingBlock(output),
    error: result.ok ? null : output.split("\n").filter(Boolean).slice(0, 6),
  };
}

function ensureRuntimeServiceAccount(config, dryRun) {
  const describeArgs = [
    "iam",
    "service-accounts",
    "describe",
    config.runtimeServiceAccountEmail,
    "--project",
    config.project,
  ];

  if (exists(describeArgs)) {
    return {
      resource: config.runtimeServiceAccountEmail,
      type: "serviceAccount",
      action: "exists",
      ok: true,
    };
  }

  if (dryRun) {
    return {
      resource: config.runtimeServiceAccountEmail,
      type: "serviceAccount",
      action: "would-create",
      ok: true,
    };
  }

  const result = runGcloud(
    [
      "iam",
      "service-accounts",
      "create",
      config.runtimeServiceAccountId,
      "--project",
      config.project,
      "--display-name",
      "Google Chat AI SDK Cloud Run runtime",
      "--description",
      "Runtime identity for Google Chat AI SDK smoke webhook.",
    ],
    { allowFailure: true },
  );

  return {
    resource: config.runtimeServiceAccountEmail,
    type: "serviceAccount",
    action: "create",
    ok: result.ok,
    error: result.ok
      ? null
      : `${result.stdout}\n${result.stderr}`.split("\n").filter(Boolean).slice(0, 6),
  };
}

function ensureTopic(project, topic, dryRun) {
  if (
    exists(["pubsub", "topics", "describe", topic, "--project", project])
  ) {
    return { resource: topic, type: "topic", action: "exists", ok: true };
  }

  if (dryRun) {
    return { resource: topic, type: "topic", action: "would-create", ok: true };
  }

  const result = runGcloud(
    ["pubsub", "topics", "create", topic, "--project", project],
    { allowFailure: true },
  );

  return {
    resource: topic,
    type: "topic",
    action: "create",
    ok: result.ok,
    error: result.ok
      ? null
      : `${result.stdout}\n${result.stderr}`.split("\n").filter(Boolean).slice(0, 6),
  };
}

function ensureSubscription(project, subscription, topic, dryRun) {
  if (
    exists([
      "pubsub",
      "subscriptions",
      "describe",
      subscription,
      "--project",
      project,
    ])
  ) {
    return {
      resource: subscription,
      type: "subscription",
      topic,
      action: "exists",
      ok: true,
    };
  }

  if (dryRun) {
    return {
      resource: subscription,
      type: "subscription",
      topic,
      action: "would-create",
      ok: true,
    };
  }

  const result = runGcloud(
    [
      "pubsub",
      "subscriptions",
      "create",
      subscription,
      "--topic",
      topic,
      "--project",
      project,
    ],
    { allowFailure: true },
  );

  return {
    resource: subscription,
    type: "subscription",
    topic,
    action: "create",
    ok: result.ok,
    error: result.ok
      ? null
      : `${result.stdout}\n${result.stderr}`.split("\n").filter(Boolean).slice(0, 6),
  };
}

function ensureArtifactRepository(config, dryRun) {
  const describeArgs = [
    "artifacts",
    "repositories",
    "describe",
    config.artifactRepository,
    "--project",
    config.project,
    "--location",
    config.location,
  ];

  if (exists(describeArgs)) {
    return {
      resource: config.artifactRepository,
      type: "artifactRepository",
      action: "exists",
      ok: true,
    };
  }

  if (dryRun) {
    return {
      resource: config.artifactRepository,
      type: "artifactRepository",
      action: "would-create",
      ok: true,
    };
  }

  const result = runGcloud(
    [
      "artifacts",
      "repositories",
      "create",
      config.artifactRepository,
      "--repository-format",
      "docker",
      "--project",
      config.project,
      "--location",
      config.location,
      "--description",
      "Google Chat AI SDK smoke webhook images.",
    ],
    { allowFailure: true },
  );

  const output = `${result.stdout}\n${result.stderr}`;

  return {
    resource: config.artifactRepository,
    type: "artifactRepository",
    action: "create",
    ok: result.ok,
    blockedByBilling: !result.ok && hasBillingBlock(output),
    error: result.ok ? null : output.split("\n").filter(Boolean).slice(0, 6),
  };
}

function ensureProjectIamBinding(project, member, role, dryRun) {
  const existing = runGcloud(
    [
      "projects",
      "get-iam-policy",
      project,
      "--flatten=bindings[].members",
      `--filter=bindings.role:${role} AND bindings.members:${member}`,
      "--format=value(bindings.role)",
    ],
    { allowFailure: true },
  );

  if (existing.ok && existing.stdout.includes(role)) {
    return {
      resource: `${member}:${role}`,
      type: "projectIamBinding",
      action: "exists",
      ok: true,
    };
  }

  if (dryRun) {
    return {
      resource: `${member}:${role}`,
      type: "projectIamBinding",
      action: "would-grant",
      ok: true,
    };
  }

  const result = runGcloud(
    [
      "projects",
      "add-iam-policy-binding",
      project,
      "--member",
      member,
      "--role",
      role,
      "--quiet",
    ],
    { allowFailure: true },
  );

  return {
    resource: `${member}:${role}`,
    type: "projectIamBinding",
    action: "grant",
    ok: result.ok,
    error: result.ok
      ? null
      : `${result.stdout}\n${result.stderr}`.split("\n").filter(Boolean).slice(0, 6),
  };
}

export async function bootstrapProject({ argv = process.argv, env = process.env } = {}) {
  const args = parseBootstrapArgs(argv);
  const config = resolveBootstrapConfig(env);
  const plan = buildBootstrapPlan(config);

  if (args.dryRun) {
    return {
      ok: true,
      dryRun: true,
      plan,
    };
  }

  const services = expectedServices.map((service) =>
    ensureServiceEnabled(config.project, service, args.dryRun),
  );
  const artifactRegistryService = services.find(
    (item) => item.service === "artifactregistry.googleapis.com",
  );
  const resources = [
    ensureRuntimeServiceAccount(config, args.dryRun),
    ensureTopic(config.project, config.workspaceEventsTopic, args.dryRun),
    ensureTopic(config.project, config.smokeTestsTopic, args.dryRun),
    ensureSubscription(
      config.project,
      config.workspaceEventsSubscription,
      config.workspaceEventsTopic,
      args.dryRun,
    ),
    ensureSubscription(
      config.project,
      config.smokeTestsSubscription,
      config.smokeTestsTopic,
      args.dryRun,
    ),
    artifactRegistryService?.ok
      ? ensureArtifactRepository(config, args.dryRun)
      : {
          resource: config.artifactRepository,
          type: "artifactRepository",
          action: "skipped",
          ok: false,
          blockedByBilling: artifactRegistryService?.blockedByBilling ?? false,
          error: [
            "Artifact Registry repository creation skipped because artifactregistry.googleapis.com is not enabled.",
          ],
        },
    ...config.runtimeProjectRoles.map((role) =>
      ensureProjectIamBinding(
        config.project,
        `serviceAccount:${config.runtimeServiceAccountEmail}`,
        role,
        args.dryRun,
      ),
    ),
  ];
  const blockers = [
    ...services.filter((item) => !item.ok),
    ...resources.filter((item) => !item.ok),
  ];
  const billingBlocked = blockers.filter((item) => item.blockedByBilling);

  return {
    ok: blockers.length === 0,
    partial: blockers.length > 0 && resources.some((item) => item.ok),
    project: config.project,
    location: config.location,
    credentialsPath: config.credentialsPath,
    services,
    resources,
    blockers,
    next: {
      attachBilling:
        billingBlocked.length > 0
          ? "Attach billing to the project, then rerun corepack pnpm cloud:bootstrap."
          : null,
      deployWebhook:
        blockers.length === 0
          ? "Run corepack pnpm cloud:deploy-webhook after bootstrap is complete."
          : null,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await bootstrapProject();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok && !parseBootstrapArgs(process.argv).allowPartial) {
    process.exit(1);
  }
}
