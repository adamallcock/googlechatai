import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SMOKE_SPACE_PREFIX } from "./chat-smoke.mjs";
import {
  chatRequestWithAppAuth,
  createServiceAccountTokenBroker,
} from "../chat/app-auth-client.mjs";
import {
  chatRequestWithUserAuth,
  readOAuthClientConfig,
  resolveUserAuthConfig,
  UserAuthRequiredError,
} from "../chat/user-auth-smoke.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultMetadataPath = path.join(
  repoRoot,
  "fixtures/live/chat-smoke-space.local.json",
);
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const defaultCredentialsPath = path.join(
  os.homedir(),
  ".config/googlechatai-sdk/credentials/chat-ai-sdk-service-account.json",
);
const defaultPublisherMember =
  "serviceAccount:chat-api-push@system.gserviceaccount.com";
const defaultEventTypes = ["google.workspace.chat.message.v1.created"];
const workspaceEventsBaseUrl = "https://workspaceevents.googleapis.com/v1";
const appBotScope = "https://www.googleapis.com/auth/chat.bot";

const scopeByFamily = {
  message: "https://www.googleapis.com/auth/chat.messages.readonly",
  reaction: "https://www.googleapis.com/auth/chat.messages.reactions.readonly",
  membership: "https://www.googleapis.com/auth/chat.memberships.readonly",
  space: "https://www.googleapis.com/auth/chat.spaces.readonly",
};

class WorkspaceEventsApiError extends Error {
  constructor(operation, status, response, responseHeaders = {}) {
    super(`${operation} failed with HTTP ${status}`);
    this.name = "WorkspaceEventsApiError";
    this.operation = operation;
    this.status = status;
    this.response = response;
    this.responseHeaders = responseHeaders;
  }
}

class ChatApiError extends Error {
  constructor(operation, status, response) {
    super(`${operation} failed with HTTP ${status}`);
    this.name = "ChatApiError";
    this.operation = operation;
    this.status = status;
    this.response = response;
  }
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    validateOnly: false,
    includeResource: false,
    metadataPath: null,
    evidencePath: null,
    eventTypes: [],
    topicName: null,
    subscriptionName: null,
    pullAttempts: 12,
    pullIntervalMs: 5_000,
    operationPollAttempts: 8,
    operationPollIntervalMs: 2_000,
    allowBlocked: false,
    help: false,
  };
  const rest = argv.slice(2);

  const valueAfter = (index, option) => {
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
    } else if (arg === "--validate-only") {
      args.validateOnly = true;
    } else if (arg === "--include-resource") {
      args.includeResource = true;
    } else if (arg === "--metadata") {
      args.metadataPath = valueAfter(index, arg);
      index += 1;
    } else if (arg.startsWith("--metadata=")) {
      args.metadataPath = arg.slice("--metadata=".length);
    } else if (arg === "--evidence") {
      args.evidencePath = valueAfter(index, arg);
      index += 1;
    } else if (arg.startsWith("--evidence=")) {
      args.evidencePath = arg.slice("--evidence=".length);
    } else if (arg === "--event-type") {
      args.eventTypes.push(valueAfter(index, arg));
      index += 1;
    } else if (arg.startsWith("--event-type=")) {
      args.eventTypes.push(arg.slice("--event-type=".length));
    } else if (arg === "--topic") {
      args.topicName = valueAfter(index, arg);
      index += 1;
    } else if (arg.startsWith("--topic=")) {
      args.topicName = arg.slice("--topic=".length);
    } else if (arg === "--subscription") {
      args.subscriptionName = valueAfter(index, arg);
      index += 1;
    } else if (arg.startsWith("--subscription=")) {
      args.subscriptionName = arg.slice("--subscription=".length);
    } else if (arg === "--pull-attempts") {
      args.pullAttempts = Number(valueAfter(index, arg));
      index += 1;
    } else if (arg.startsWith("--pull-attempts=")) {
      args.pullAttempts = Number(arg.slice("--pull-attempts=".length));
    } else if (arg === "--pull-interval-ms") {
      args.pullIntervalMs = Number(valueAfter(index, arg));
      index += 1;
    } else if (arg.startsWith("--pull-interval-ms=")) {
      args.pullIntervalMs = Number(arg.slice("--pull-interval-ms=".length));
    } else if (arg === "--operation-poll-attempts") {
      args.operationPollAttempts = Number(valueAfter(index, arg));
      index += 1;
    } else if (arg.startsWith("--operation-poll-attempts=")) {
      args.operationPollAttempts = Number(
        arg.slice("--operation-poll-attempts=".length),
      );
    } else if (arg === "--operation-poll-interval-ms") {
      args.operationPollIntervalMs = Number(valueAfter(index, arg));
      index += 1;
    } else if (arg.startsWith("--operation-poll-interval-ms=")) {
      args.operationPollIntervalMs = Number(
        arg.slice("--operation-poll-interval-ms=".length),
      );
    } else if (arg === "--allow-blocked") {
      args.allowBlocked = true;
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

function requireSmokeSpaceName(space) {
  if (!space || !space.startsWith("spaces/")) {
    throw new Error("GOOGLE_CHAT_TEST_SPACE must start with spaces/");
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

function requireSmokeMetadata(metadata, expectedSpace) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Smoke metadata must be a JSON object.");
  }
  requireSmokeSpaceName(metadata.space);

  if (metadata.space !== expectedSpace) {
    throw new Error(
      `Smoke metadata space ${metadata.space} does not match GOOGLE_CHAT_TEST_SPACE ${expectedSpace}`,
    );
  }
  if (
    typeof metadata.displayName !== "string" ||
    !metadata.displayName.startsWith(SMOKE_SPACE_PREFIX)
  ) {
    throw new Error(
      `metadata displayName must start with ${SMOKE_SPACE_PREFIX}`,
    );
  }
  if (metadata.spaceType !== "SPACE") {
    throw new Error("Smoke metadata spaceType must be SPACE.");
  }
  if (metadata.safety?.dedicatedSmokeSpace !== true) {
    throw new Error("Smoke metadata must set safety.dedicatedSmokeSpace=true.");
  }
  if (metadata.safety?.noDirectMessages !== true) {
    throw new Error("Smoke metadata must set safety.noDirectMessages=true.");
  }
  if (metadata.safety?.noRealUsersInvited !== true) {
    throw new Error("Smoke metadata must set safety.noRealUsersInvited=true.");
  }
}

function makeRunId(env) {
  if (env.GOOGLE_CHAT_WORKSPACE_EVENTS_SUBSCRIPTION_RUN_ID) {
    return env.GOOGLE_CHAT_WORKSPACE_EVENTS_SUBSCRIPTION_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `workspace-events-subscription-${stamp}-${crypto
    .randomBytes(3)
    .toString("hex")}`;
}

function slug(value, maxLength = 45) {
  const normalized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || "smoke").slice(0, maxLength).replace(/-+$/g, "");
}

function normalizeEventTypes(values) {
  const selected = values.length > 0 ? values : defaultEventTypes;
  const eventTypes = [...new Set(selected.map((value) => String(value).trim()))]
    .filter(Boolean);

  if (eventTypes.length === 0) {
    throw new Error("At least one Workspace Events event type is required.");
  }

  for (const eventType of eventTypes) {
    if (!eventType.startsWith("google.workspace.chat.")) {
      throw new Error(`Unsupported Workspace Events Chat event type: ${eventType}`);
    }
  }

  return eventTypes;
}

function requiredUserScopesForEventTypes(eventTypes) {
  const scopes = [];

  for (const eventType of eventTypes) {
    if (eventType.includes(".message.")) {
      scopes.push(scopeByFamily.message);
    } else if (eventType.includes(".reaction.")) {
      scopes.push(scopeByFamily.reaction);
    } else if (eventType.includes(".membership.")) {
      scopes.push(scopeByFamily.membership);
    } else if (eventType.includes(".space.")) {
      scopes.push(scopeByFamily.space);
    } else {
      throw new Error(`No user-auth scope mapping for event type ${eventType}`);
    }
  }

  return [...new Set(scopes)];
}

function topicResource(project, topicName) {
  return topicName.startsWith("projects/")
    ? topicName
    : `projects/${project}/topics/${topicName}`;
}

function subscriptionResource(project, subscriptionName) {
  return subscriptionName.startsWith("projects/")
    ? subscriptionName
    : `projects/${project}/subscriptions/${subscriptionName}`;
}

function localResourceName(resourceName) {
  return resourceName.split("/").at(-1) ?? resourceName;
}

export async function loadWorkspaceEventsSubscriptionSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_WORKSPACE_EVENTS_SUBSCRIPTION_SMOKE !== "1") {
    throw new Error(
      "Refusing to run Workspace Events subscription smoke without RUN_LIVE_WORKSPACE_EVENTS_SUBSCRIPTION_SMOKE=1.",
    );
  }
  if (
    !args.dryRun &&
    !args.validateOnly &&
    env.GOOGLE_CHAT_AI_ENABLE_LIVE_WORKSPACE_EVENTS_SUBSCRIPTION !== "1"
  ) {
    throw new Error(
      "Refusing to create a live Workspace Events subscription without GOOGLE_CHAT_AI_ENABLE_LIVE_WORKSPACE_EVENTS_SUBSCRIPTION=1.",
    );
  }

  requirePositiveInteger(args.pullAttempts, "--pull-attempts");
  requireNonNegativeInteger(args.pullIntervalMs, "--pull-interval-ms");
  requirePositiveInteger(args.operationPollAttempts, "--operation-poll-attempts");
  requireNonNegativeInteger(
    args.operationPollIntervalMs,
    "--operation-poll-interval-ms",
  );

  const space = env.GOOGLE_CHAT_TEST_SPACE?.trim();
  requireSmokeSpaceName(space);

  const metadataPath = resolvePath(
    args.metadataPath ??
      env.GOOGLE_CHAT_SMOKE_METADATA ??
      defaultMetadataPath,
    cwd,
  );
  let metadata;

  try {
    metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read smoke-space metadata at ${metadataPath}: ${error.message}`,
    );
  }

  requireSmokeMetadata(metadata, space);

  const project = env.GOOGLE_CLOUD_PROJECT ?? "chat-ai-sdk";
  const runId = makeRunId(env);
  const resourceSlug = slug(runId, 42);
  const topicName =
    args.topicName ??
    env.GOOGLE_CHAT_WORKSPACE_EVENTS_TOPIC ??
    `chat-ai-sdk-we-${resourceSlug}`;
  const subscriptionName =
    args.subscriptionName ??
    env.GOOGLE_CHAT_WORKSPACE_EVENTS_SUBSCRIPTION ??
    `${localResourceName(topicName)}-pull`;
  const eventTypes = normalizeEventTypes(args.eventTypes);
  const userAuthConfig = resolveUserAuthConfig(env, {
    credentialsPath: null,
    tokenStorePath: null,
    redirectUri: null,
  });

  return {
    dryRun: args.dryRun,
    validateOnly: args.validateOnly,
    allowBlocked: args.allowBlocked,
    project,
    space,
    targetResource: `//chat.googleapis.com/${space}`,
    metadata,
    metadataPath,
    runId,
    eventTypes,
    requiredUserScopes: requiredUserScopesForEventTypes(eventTypes),
    includeResource: args.includeResource,
    pubsub: {
      topicName,
      topicResource: topicResource(project, topicName),
      subscriptionName,
      subscriptionResource: subscriptionResource(project, subscriptionName),
      publisherMember:
        env.GOOGLE_CHAT_WORKSPACE_EVENTS_PUBLISHER_MEMBER ??
        defaultPublisherMember,
    },
    pull: {
      attempts: args.pullAttempts,
      intervalMs: args.pullIntervalMs,
    },
    operationPoll: {
      attempts: args.operationPollAttempts,
      intervalMs: args.operationPollIntervalMs,
    },
    credentialsPath:
      env.GOOGLE_APPLICATION_CREDENTIALS ?? defaultCredentialsPath,
    oauthCredentialsPath: userAuthConfig.credentialsPath,
    tokenStorePath: userAuthConfig.tokenStorePath,
    evidencePath: resolvePath(
      args.evidencePath ??
        env.GOOGLE_CHAT_WORKSPACE_EVENTS_SUBSCRIPTION_EVIDENCE,
      cwd,
    ),
    repoRoot,
  };
}

function subscriptionRequestBody(config) {
  return {
    targetResource: config.targetResource,
    eventTypes: config.eventTypes,
    notificationEndpoint: {
      pubsubTopic: config.pubsub.topicResource,
    },
    payloadOptions: {
      includeResource: config.includeResource,
    },
  };
}

export function buildWorkspaceEventsSubscriptionSmokePlan(config) {
  const calls = [
    {
      operation: "pubsub.topics.create",
      method: "gcloud",
      writes: !config.dryRun,
      resource: config.pubsub.topicResource,
      safetyCheck: "Creates only a temporary smoke topic and deletes it before exit.",
    },
    {
      operation: "pubsub.subscriptions.create",
      method: "gcloud",
      writes: !config.dryRun,
      resource: config.pubsub.subscriptionResource,
      safetyCheck: "Creates only a temporary pull subscription and deletes it before exit.",
    },
    {
      operation: "pubsub.topics.addPublisher",
      method: "gcloud",
      writes: !config.dryRun,
      resource: config.pubsub.topicResource,
      member: config.pubsub.publisherMember,
    },
    {
      operation: "workspaceEvents.subscriptions.create.validateOnly",
      method: "POST",
      path: "/v1/subscriptions?validateOnly=true",
      writes: false,
      authMode: "user",
      requiredScopes: config.requiredUserScopes,
    },
  ];

  if (!config.validateOnly && !config.dryRun) {
    calls.push(
      {
        operation: "workspaceEvents.subscriptions.create",
        method: "POST",
        path: "/v1/subscriptions",
        writes: true,
        authMode: "user",
        requiredScopes: config.requiredUserScopes,
      },
      {
        operation: "chat.messages.create",
        method: "POST",
        path: `/v1/${config.space}/messages`,
        writes: true,
        authMode: "app",
        bodyRedacted: true,
      },
      {
        operation: "pubsub.subscriptions.pull",
        method: "gcloud",
        writes: false,
        resource: config.pubsub.subscriptionResource,
      },
      {
        operation: "chat.messages.delete",
        method: "DELETE",
        path: "/v1/{createdMessage}",
        writes: true,
        authMode: "app",
      },
      {
        operation: "workspaceEvents.subscriptions.delete",
        method: "DELETE",
        path: "/v1/{createdSubscription}",
        writes: true,
        authMode: "user",
      },
    );
  }

  calls.push(
    {
      operation: "pubsub.subscriptions.delete",
      method: "gcloud",
      writes: !config.dryRun,
      resource: config.pubsub.subscriptionResource,
    },
    {
      operation: "pubsub.topics.delete",
      method: "gcloud",
      writes: !config.dryRun,
      resource: config.pubsub.topicResource,
    },
  );

  return {
    mode: config.dryRun
      ? "dry-run"
      : config.validateOnly
        ? "validate-only"
        : "live",
    project: config.project,
    runId: config.runId,
    targetResource: config.targetResource,
    eventTypes: config.eventTypes,
    requiredUserScopes: config.requiredUserScopes,
    payloadOptions: { includeResource: config.includeResource },
    pubsub: config.pubsub,
    pull: config.pull,
    calls,
  };
}

function stableHash(project, value) {
  if (!value) {
    return null;
  }
  return crypto
    .createHash("sha256")
    .update(project)
    .update("\0")
    .update(String(value))
    .digest("hex");
}

function summarizeResource(project, name) {
  return {
    available: typeof name === "string" && name.length > 0,
    sha256: stableHash(project, name),
  };
}

function sanitizeError(error) {
  if (error instanceof UserAuthRequiredError) {
    return {
      name: error.name,
      message: error.message,
      details: error.details,
      authorizeHint:
        "Run `corepack pnpm chat:user-auth-smoke -- --authorize --read-messages` for the local installed-user token. Do not use domain-wide delegation.",
    };
  }
  if (error instanceof WorkspaceEventsApiError || error instanceof ChatApiError) {
    return {
      name: error.name,
      operation: error.operation,
      status: error.status,
      message: error.message,
      apiReason: error.response?.error?.status ?? null,
      responseHeaders: error.responseHeaders ?? {},
    };
  }
  if (Number.isInteger(error.status)) {
    return {
      name: error.name ?? "Error",
      operation: error.operation ?? null,
      status: error.status,
      message: error.message ?? String(error),
      apiReason: error.response?.error?.status ?? null,
      responseHeaders: error.responseHeaders ?? {},
    };
  }
  return {
    name: error.name ?? "Error",
    message: error.message ?? String(error),
  };
}

function blockedSummary(error) {
  return {
    status: Number.isInteger(error.status) ? error.status : null,
    apiReason: error.response?.error?.status ?? null,
    message: error.message ?? String(error),
  };
}

function isWorkspaceEventsError(error) {
  return (
    error instanceof WorkspaceEventsApiError ||
    error?.name === "WorkspaceEventsApiError" ||
    String(error?.operation ?? "").startsWith("workspaceEvents.")
  );
}

function isKnownPublisherPolicyBlock(error) {
  const message = error?.message ?? String(error ?? "");
  return (
    /iam\.allowedPolicyMemberDomains/.test(message) ||
    /does not belong to a permitted customer/.test(message)
  );
}

async function recordOperation(evidence, operation, fn, summarize = () => ({})) {
  const startedAt = new Date().toISOString();
  try {
    const result = await fn();
    evidence.operations.push({
      operation,
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      ...summarize(result),
    });
    return result;
  } catch (error) {
    evidence.operations.push({
      operation,
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: sanitizeError(error),
    });
    throw error;
  }
}

async function recordCleanup(evidence, operation, fn, summarize = () => ({})) {
  try {
    return await recordOperation(evidence, operation, fn, summarize);
  } catch {
    return null;
  }
}

async function writeEvidenceFile(config, evidence) {
  const evidencePath =
    config.evidencePath ??
    path.join(
      defaultEvidenceDir,
      `chat-workspace-events-subscription-smoke-${config.runId}.json`,
    );
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

function summarizeOperation(operation) {
  return {
    operationName: summarizeResource("workspace-events-operation", operation?.name),
    done: operation?.done === true,
    subscriptionNameAvailable:
      typeof operation?.response?.name === "string" &&
      operation.response.name.startsWith("subscriptions/"),
  };
}

function subscriptionNameFromOperation(operation) {
  const name = operation?.response?.name;
  return typeof name === "string" && name.startsWith("subscriptions/")
    ? name
    : null;
}

async function waitForSubscriptionOperation(config, workspaceEvents, operation, sleepMs) {
  let current = operation;
  let subscriptionName = subscriptionNameFromOperation(current);

  for (let attempt = 0; !subscriptionName && attempt < config.operationPoll.attempts; attempt += 1) {
    if (!current?.name || current?.done === true) {
      break;
    }
    await sleepMs(config.operationPoll.intervalMs);
    current = await workspaceEvents.getOperation(current.name);
    subscriptionName = subscriptionNameFromOperation(current);
  }

  if (!subscriptionName) {
    throw new Error("Workspace Events subscription operation did not return a subscription name.");
  }

  return subscriptionName;
}

async function createWorkspaceEventsClient(config) {
  const oauthClient = readOAuthClientConfig(
    await fs.readFile(resolvePath(config.oauthCredentialsPath, process.cwd()), "utf8"),
  );

  async function request({ path: requestPath, method, query = {}, body = null, idempotent = false }) {
    const url = new URL(`${workspaceEventsBaseUrl}/${requestPath}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const result = await chatRequestWithUserAuth({
      oauthClient,
      tokenStorePath: config.tokenStorePath,
      scopes: config.requiredUserScopes,
      url: url.toString(),
      init: {
        method,
        body,
        idempotent,
      },
    });

    if (!result.ok) {
      throw new WorkspaceEventsApiError(
        `workspaceEvents.${requestPath}`,
        result.status,
        result.json,
        result.headers ?? {},
      );
    }

    return result.json;
  }

  return {
    createSubscription: (body, query) =>
      request({
        path: "subscriptions",
        method: "POST",
        query,
        body,
        idempotent: Boolean(query?.validateOnly),
      }),
    getOperation: (name) =>
      request({
        path: name,
        method: "GET",
        idempotent: true,
      }),
    deleteSubscription: (name) =>
      request({
        path: name,
        method: "DELETE",
        idempotent: true,
      }),
  };
}

async function createAppChatClient(config) {
  const serviceAccount = JSON.parse(
    await fs.readFile(resolvePath(config.credentialsPath, process.cwd()), "utf8"),
  );
  const scopes = [appBotScope];
  const getAccessToken = createServiceAccountTokenBroker(serviceAccount, scopes);

  async function request(resourcePath, { method, query = {}, body = null, idempotent = false }) {
    const result = await chatRequestWithAppAuth({
      serviceAccount,
      scopes,
      resourcePath,
      query,
      init: {
        method,
        body,
        idempotent,
      },
      getAccessToken,
    });

    if (!result.ok) {
      throw new ChatApiError(`${method} /v1/${resourcePath}`, result.status, result.json);
    }
    return result.json;
  }

  return {
    createMessage: (parent, body, query = {}) =>
      request(`${parent}/messages`, {
        method: "POST",
        query,
        body,
        idempotent: Boolean(query.requestId || query.messageId),
      }),
    deleteMessage: (name) =>
      request(name, {
        method: "DELETE",
        idempotent: true,
      }),
  };
}

async function loadBuiltSdk(repoRootPath) {
  try {
    return await import(pathToFileURL(path.join(repoRootPath, "packages/node/dist/index.js")));
  } catch (error) {
    throw new Error(
      `Unable to load built SDK helpers. Run \`corepack pnpm build\` first. ${error.message}`,
    );
  }
}

function createGcloudPubSub(config) {
  const run = (args) =>
    execFileSync("gcloud", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  return {
    createTopic(topic) {
      run(["pubsub", "topics", "create", localResourceName(topic), "--project", config.project]);
    },
    createSubscription(subscription, topic) {
      run([
        "pubsub",
        "subscriptions",
        "create",
        localResourceName(subscription),
        "--topic",
        localResourceName(topic),
        "--project",
        config.project,
      ]);
    },
    addPublisher(topic, member) {
      run([
        "pubsub",
        "topics",
        "add-iam-policy-binding",
        localResourceName(topic),
        "--member",
        member,
        "--role",
        "roles/pubsub.publisher",
        "--project",
        config.project,
      ]);
    },
    pull(subscription) {
      const output = run([
        "pubsub",
        "subscriptions",
        "pull",
        localResourceName(subscription),
        "--project",
        config.project,
        "--auto-ack",
        "--limit",
        "10",
        "--format=json",
      ]);
      return output ? JSON.parse(output) : [];
    },
    deleteSubscription(subscription) {
      run([
        "pubsub",
        "subscriptions",
        "delete",
        localResourceName(subscription),
        "--project",
        config.project,
        "--quiet",
      ]);
    },
    deleteTopic(topic) {
      run([
        "pubsub",
        "topics",
        "delete",
        localResourceName(topic),
        "--project",
        config.project,
        "--quiet",
      ]);
    },
  };
}

function messageId(seed) {
  return `we-${slug(seed, 54)}`;
}

function triggerText(config) {
  return `${SMOKE_SPACE_PREFIX} Workspace Events subscription smoke ${config.runId}`;
}

function messageSummary(config, message) {
  return {
    name: summarizeResource(config.project, message?.name),
    threadName: summarizeResource(config.project, message?.thread?.name),
  };
}

function operationSummary(result) {
  return {
    response: summarizeOperation(result),
  };
}

function pubsubPullSummary(items) {
  return {
    pulled: Array.isArray(items) ? items.length : 0,
  };
}

function eventSubject(parsed) {
  return (
    parsed?.event?.workspaceEvent?.subject ??
    parsed?.event?.workspaceEvent?.resourceName ??
    ""
  );
}

function normalizedEventSummary(config, parsed) {
  const checkpoint = parsed?.event?.pubSub?.checkpoint ?? {};
  return {
    eventId: summarizeResource(config.project, parsed?.event?.eventId),
    kind: parsed?.event?.kind ?? null,
    rawKind: parsed?.event?.rawKind ?? null,
    subject: summarizeResource(config.project, eventSubject(parsed)),
    resourceName: summarizeResource(
      config.project,
      parsed?.event?.workspaceEvent?.resourceName,
    ),
    checkpoint: {
      subscription: summarizeResource(config.project, checkpoint.subscription),
      messageId: summarizeResource(config.project, checkpoint.messageId),
      publishTime: checkpoint.publishTime ?? null,
      orderingKeyAvailable:
        typeof checkpoint.orderingKey === "string" && checkpoint.orderingKey.length > 0,
      deliveryAttempt:
        typeof checkpoint.deliveryAttempt === "number" ? checkpoint.deliveryAttempt : null,
    },
  };
}

function rawEventType(item) {
  return item?.message?.attributes?.["ce-type"] ?? null;
}

function rawSubject(item) {
  return item?.message?.attributes?.["ce-subject"] ?? "";
}

function findMatchingEvent(config, items, sdk) {
  const parsed = sdk.parsePubSubPullPayload(items, {
    subscription: config.pubsub.subscriptionResource,
  });

  for (let index = 0; index < parsed.length; index += 1) {
    const candidate = parsed[index];
    const item = items[index];
    const type = candidate?.event?.rawKind ?? rawEventType(item);
    const subject = eventSubject(candidate) || rawSubject(item);

    if (
      config.eventTypes.includes(type) &&
      typeof subject === "string" &&
      subject.includes(config.space)
    ) {
      return candidate;
    }
  }

  return null;
}

async function cleanupResources({ config, evidence, workspaceEvents, chat, pubsub, state }) {
  if (state.chatMessageName) {
    await recordCleanup(
      evidence,
      "cleanup.chat.messages.delete",
      () => chat.deleteMessage(state.chatMessageName),
      () => ({ message: summarizeResource(config.project, state.chatMessageName) }),
    );
    state.chatMessageName = null;
  }
  if (state.workspaceSubscriptionName) {
    await recordCleanup(
      evidence,
      "cleanup.workspaceEvents.subscriptions.delete",
      () => workspaceEvents.deleteSubscription(state.workspaceSubscriptionName),
      operationSummary,
    );
    state.workspaceSubscriptionName = null;
  }
  if (state.pubsubSubscriptionCreated) {
    await recordCleanup(
      evidence,
      "cleanup.pubsub.subscriptions.delete",
      () => pubsub.deleteSubscription(config.pubsub.subscriptionName),
      () => ({ resource: config.pubsub.subscriptionResource }),
    );
    state.pubsubSubscriptionCreated = false;
  }
  if (state.pubsubTopicCreated) {
    await recordCleanup(
      evidence,
      "cleanup.pubsub.topics.delete",
      () => pubsub.deleteTopic(config.pubsub.topicName),
      () => ({ resource: config.pubsub.topicResource }),
    );
    state.pubsubTopicCreated = false;
  }
}

export async function runWorkspaceEventsSubscriptionSmoke(
  config,
  {
    pubsub = null,
    workspaceEvents = null,
    chat = null,
    sdk = null,
    sleepMs = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    writeEvidence = true,
  } = {},
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
        plan: buildWorkspaceEventsSubscriptionSmokePlan(config),
      },
    };
  }

  const evidence = {
    ok: false,
    status: "running",
    mode: config.validateOnly ? "validate-only" : "live",
    project: config.project,
    runId: config.runId,
    targetResource: config.targetResource,
    metadataPath: config.metadataPath,
    eventTypes: config.eventTypes,
    payloadOptions: { includeResource: config.includeResource },
    pubsub: {
      topicResource: config.pubsub.topicResource,
      subscriptionResource: config.pubsub.subscriptionResource,
      matchFound: false,
      pullAttempts: 0,
    },
    subscription: {
      nameAvailable: false,
      name: null,
    },
    operations: [],
    assertions: {},
    failures: [],
    privacy: {
      rawMessageTextSaved: false,
      rawFormValuesSaved: false,
      rawAccessTokensSaved: false,
      senderEmailsSaved: false,
      rawPubSubAckIdsSaved: false,
    },
    startedAt: new Date().toISOString(),
  };
  const state = {
    pubsubTopicCreated: false,
    pubsubSubscriptionCreated: false,
    workspaceSubscriptionName: null,
    chatMessageName: null,
  };

  const pubsubClient = pubsub ?? createGcloudPubSub(config);
  const workspaceEventsClient =
    workspaceEvents ?? (await createWorkspaceEventsClient(config));
  let chatClient = chat;
  let sdkHelpers = sdk;

  try {
    await recordOperation(
      evidence,
      "pubsub.topics.create",
      () => pubsubClient.createTopic(config.pubsub.topicName),
      () => ({ resource: config.pubsub.topicResource }),
    );
    state.pubsubTopicCreated = true;

    await recordOperation(
      evidence,
      "pubsub.subscriptions.create",
      () =>
        pubsubClient.createSubscription(
          config.pubsub.subscriptionName,
          config.pubsub.topicName,
        ),
      () => ({ resource: config.pubsub.subscriptionResource }),
    );
    state.pubsubSubscriptionCreated = true;

    await recordOperation(
      evidence,
      "pubsub.topics.addPublisher",
      () =>
        pubsubClient.addPublisher(
          config.pubsub.topicName,
          config.pubsub.publisherMember,
        ),
      () => ({
        resource: config.pubsub.topicResource,
        member: config.pubsub.publisherMember,
      }),
    );

    const body = subscriptionRequestBody(config);
    const validateOperation = await recordOperation(
      evidence,
      "workspaceEvents.subscriptions.create.validateOnly",
      () => workspaceEventsClient.createSubscription(body, { validateOnly: "true" }),
      operationSummary,
    );
    evidence.validateOnlyOperation = summarizeOperation(validateOperation);

    if (config.validateOnly) {
      evidence.ok = true;
      evidence.status = "validated";
      return { ok: true, evidence };
    }

    const createOperation = await recordOperation(
      evidence,
      "workspaceEvents.subscriptions.create",
      () => workspaceEventsClient.createSubscription(body, { validateOnly: "false" }),
      operationSummary,
    );
    const subscriptionName = await waitForSubscriptionOperation(
      config,
      workspaceEventsClient,
      createOperation,
      sleepMs,
    );
    state.workspaceSubscriptionName = subscriptionName;
    evidence.subscription = {
      nameAvailable: true,
      name: summarizeResource(config.project, subscriptionName),
    };

    chatClient = chatClient ?? (await createAppChatClient(config));
    sdkHelpers = sdkHelpers ?? (await loadBuiltSdk(config.repoRoot));

    const message = await recordOperation(
      evidence,
      "chat.messages.create",
      () =>
        chatClient.createMessage(
          config.space,
          {
            text: triggerText(config),
          },
          {
            requestId: `workspace-events-subscription-${config.runId}`,
            messageId: messageId(`${config.runId}-workspace-events-trigger`),
          },
        ),
      (created) => ({
        message: messageSummary(config, created),
      }),
    );
    state.chatMessageName = message.name;
    evidence.triggerMessage = messageSummary(config, message);

    let match = null;
    for (let attempt = 1; attempt <= config.pull.attempts && !match; attempt += 1) {
      if (attempt > 1) {
        await sleepMs(config.pull.intervalMs);
      }
      const pulled = await recordOperation(
        evidence,
        `pubsub.subscriptions.pull.${attempt}`,
        () => pubsubClient.pull(config.pubsub.subscriptionName),
        pubsubPullSummary,
      );
      evidence.pubsub.pullAttempts = attempt;
      match = findMatchingEvent(config, pulled, sdkHelpers);
    }

    evidence.pubsub.matchFound = Boolean(match);
    if (match) {
      evidence.normalizedEvent = normalizedEventSummary(config, match);
    }

    evidence.assertions = {
      subscriptionCreated: evidence.subscription.nameAvailable,
      triggerMessageCreated: state.chatMessageName !== null,
      pubsubMatchFound: evidence.pubsub.matchFound,
      rawMessageTextNotSaved: evidence.privacy.rawMessageTextSaved === false,
      rawPubSubAckIdsNotSaved: evidence.privacy.rawPubSubAckIdsSaved === false,
    };
    evidence.failures = Object.entries(evidence.assertions)
      .filter(([, value]) => value === false)
      .map(([key]) => key);
    evidence.ok = evidence.failures.length === 0;
    evidence.status = evidence.ok ? "verified" : "failed";

    if (evidence.failures.length > 0) {
      const error = new Error(
        `Workspace Events subscription smoke assertions failed: ${evidence.failures.join(", ")}`,
      );
      error.evidence = evidence;
      throw error;
    }

    return { ok: true, evidence };
  } catch (error) {
    if (
      config.allowBlocked &&
      (isWorkspaceEventsError(error) || isKnownPublisherPolicyBlock(error))
    ) {
      evidence.ok = true;
      evidence.status = "blocked";
      evidence.blocked = blockedSummary(error);
      return { ok: true, evidence };
    }
    error.evidence = evidence;
    throw error;
  } finally {
    await cleanupResources({
      config,
      evidence,
      workspaceEvents: workspaceEventsClient,
      chat: chatClient,
      pubsub: pubsubClient,
      state,
    });
    evidence.finishedAt = new Date().toISOString();
    if (writeEvidence) {
      evidence.evidencePath = await writeEvidenceFile(config, evidence);
    }
  }
}

function usage() {
  return `${[
    "Usage: RUN_LIVE_WORKSPACE_EVENTS_SUBSCRIPTION_SMOKE=1 GOOGLE_CHAT_TEST_SPACE=spaces/... pnpm live:chat-workspace-events-subscription-smoke",
    "",
    "Live subscription creation also requires:",
    "  GOOGLE_CHAT_AI_ENABLE_LIVE_WORKSPACE_EVENTS_SUBSCRIPTION=1",
    "",
    "Before running, authorize the local installed user:",
    "  corepack pnpm chat:user-auth-smoke -- --authorize --read-messages",
    "",
    "Options:",
    "  --dry-run                    Print the guarded plan without side effects.",
    "  --validate-only              Create temporary Pub/Sub plumbing, call subscriptions.create validateOnly, then clean up.",
    "  --metadata <path>            Smoke-space metadata JSON.",
    "  --evidence <path>            Evidence JSON output path.",
    "  --event-type <type>          Workspace Events Chat event type. Repeatable. Default: message created.",
    "  --include-resource           Request included resource data. Off by default.",
    "  --topic <name>               Temporary Pub/Sub topic name.",
    "  --subscription <name>        Temporary Pub/Sub pull subscription name.",
    "  --pull-attempts <n>          Pub/Sub pull attempts after trigger. Default: 12.",
    "  --pull-interval-ms <n>       Delay between Pub/Sub pulls. Default: 5000.",
    "  --allow-blocked              Exit 0 and save blocked evidence for Workspace Events API permission/product blockers.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = await loadWorkspaceEventsSubscriptionSmokeConfig();
    if (config.help) {
      process.stdout.write(usage());
      return;
    }
    const result = await runWorkspaceEventsSubscriptionSmoke(config);
    console.log(JSON.stringify(result.evidence, null, 2));
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: sanitizeError(error),
          evidence: error.evidence ?? null,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
