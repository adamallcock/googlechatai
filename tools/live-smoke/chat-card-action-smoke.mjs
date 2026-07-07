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
const BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const MESSAGE_READ_SCOPES = [
  "https://www.googleapis.com/auth/chat.messages.readonly",
];
const DEFAULT_BASE_URL =
  "https://chat-ai-sdk-dev-webhook-zhmcqkt5jq-uc.a.run.app/api";
const CARD_ACTION_STATE_PARAMETER = "__googleChatAiState";

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
    cleanupFromEvidence: null,
    cleanupConfirmationsFromEvidence: null,
    metadataPath: null,
    evidencePath: null,
    cleanupSearchLimit: 100,
    cleanupPageSize: 25,
    cleanupStartTime: null,
    cleanupEndTime: null,
    includeState: false,
    help: false,
  };
  const rest = argv.slice(2);

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--") {
      continue;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--metadata") {
      args.metadataPath = rest[++index];
    } else if (arg.startsWith("--metadata=")) {
      args.metadataPath = arg.slice("--metadata=".length);
    } else if (arg === "--evidence") {
      args.evidencePath = rest[++index];
    } else if (arg.startsWith("--evidence=")) {
      args.evidencePath = arg.slice("--evidence=".length);
    } else if (arg === "--cleanup-from-evidence") {
      args.cleanupFromEvidence = rest[++index];
    } else if (arg.startsWith("--cleanup-from-evidence=")) {
      args.cleanupFromEvidence = arg.slice("--cleanup-from-evidence=".length);
    } else if (arg === "--cleanup-confirmations-from-evidence") {
      args.cleanupConfirmationsFromEvidence = rest[++index];
    } else if (arg.startsWith("--cleanup-confirmations-from-evidence=")) {
      args.cleanupConfirmationsFromEvidence = arg.slice(
        "--cleanup-confirmations-from-evidence=".length,
      );
    } else if (arg === "--cleanup-search-limit") {
      args.cleanupSearchLimit = Number(rest[++index]);
    } else if (arg.startsWith("--cleanup-search-limit=")) {
      args.cleanupSearchLimit = Number(arg.slice("--cleanup-search-limit=".length));
    } else if (arg === "--cleanup-page-size") {
      args.cleanupPageSize = Number(rest[++index]);
    } else if (arg.startsWith("--cleanup-page-size=")) {
      args.cleanupPageSize = Number(arg.slice("--cleanup-page-size=".length));
    } else if (arg === "--cleanup-start-time") {
      args.cleanupStartTime = rest[++index];
    } else if (arg.startsWith("--cleanup-start-time=")) {
      args.cleanupStartTime = arg.slice("--cleanup-start-time=".length);
    } else if (arg === "--cleanup-end-time") {
      args.cleanupEndTime = rest[++index];
    } else if (arg.startsWith("--cleanup-end-time=")) {
      args.cleanupEndTime = arg.slice("--cleanup-end-time=".length);
    } else if (arg === "--include-state") {
      args.includeState = true;
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

function requireLiveSmokeSpace(space) {
  if (space.name && !space.name.startsWith("spaces/")) {
    throw new Error(`live space name must start with spaces/: ${space.name}`);
  }
  if (space.spaceType !== "SPACE") {
    throw new Error("live space spaceType must be SPACE.");
  }
  if (
    typeof space.displayName !== "string" ||
    !space.displayName.startsWith(SMOKE_SPACE_PREFIX)
  ) {
    throw new Error(
      `live space displayName must start with ${SMOKE_SPACE_PREFIX}`,
    );
  }
}

function makeRunId(env) {
  if (env.GOOGLE_CHAT_CARD_ACTION_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_CARD_ACTION_SMOKE_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `card-action-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function clientMessageId(runId, label) {
  const slug = `${runId}-${label}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return `client-${slug || "card-action-smoke"}`;
}

export async function loadCardActionSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_CHAT_CARD_ACTION_SMOKE !== "1") {
    throw new Error(
      "Refusing to run card-action Chat smoke without RUN_LIVE_CHAT_CARD_ACTION_SMOKE=1.",
    );
  }

  const space = env.GOOGLE_CHAT_TEST_SPACE?.trim();
  requireSmokeSpaceName(space);
  if (args.cleanupFromEvidence && args.cleanupConfirmationsFromEvidence) {
    throw new Error(
      "Use either --cleanup-from-evidence or --cleanup-confirmations-from-evidence, not both.",
    );
  }
  if (!Number.isInteger(args.cleanupSearchLimit) || args.cleanupSearchLimit <= 0) {
    throw new Error("--cleanup-search-limit must be a positive integer.");
  }
  if (!Number.isInteger(args.cleanupPageSize) || args.cleanupPageSize <= 0) {
    throw new Error("--cleanup-page-size must be a positive integer.");
  }

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

  return {
    dryRun: args.dryRun,
    cleanupFromEvidence: resolvePath(args.cleanupFromEvidence, cwd),
    cleanupConfirmationsFromEvidence: resolvePath(
      args.cleanupConfirmationsFromEvidence,
      cwd,
    ),
    cleanupSearchLimit: args.cleanupSearchLimit,
    cleanupPageSize: args.cleanupPageSize,
    cleanupStartTime: args.cleanupStartTime,
    cleanupEndTime: args.cleanupEndTime,
    includeState: args.includeState,
    space,
    metadata,
    metadataPath,
    runId: makeRunId(env),
    baseUrl:
      env.GOOGLE_CHAT_BASE_URL ??
      env.BASE_URL ??
      DEFAULT_BASE_URL,
    credentialsPath:
      env.GOOGLE_APPLICATION_CREDENTIALS ?? defaultCredentialsPath,
    userCredentialsPath: resolvePath(
      resolveUserAuthConfig(env, {
        credentialsPath: null,
        tokenStorePath: null,
        redirectUri: null,
      }).credentialsPath,
      cwd,
    ),
    userTokenStorePath: resolvePath(
      resolveUserAuthConfig(env, {
        credentialsPath: null,
        tokenStorePath: null,
        redirectUri: null,
      }).tokenStorePath,
      cwd,
    ),
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_CARD_ACTION_SMOKE_EVIDENCE,
      cwd,
    ),
    repoRoot,
  };
}

export function buildCardActionPlan(config) {
  const calls = [
    {
      operation: "spaces.get",
      method: "GET",
      path: `/v1/${config.space}`,
      writes: false,
      safetyCheck: "Requires live SPACE with smoke displayName prefix.",
    },
  ];

  if (config.cleanupConfirmationsFromEvidence) {
    calls.push({
      operation: "cleanup.confirmations.messages.list",
      method: "GET",
      path: `/v1/${config.space}/messages`,
      writes: false,
      authMode: "user",
      requiredScopes: MESSAGE_READ_SCOPES,
      safetyCheck:
        "Discovers only exact run-id dialog confirmation text in the dedicated smoke space.",
    });
    calls.push({
      operation: "cleanup.confirmations.message.delete",
      method: "DELETE",
      path: "/v1/{matchedDialogConfirmationMessage}",
      writes: true,
      authMode: "app",
      safetyCheck:
        "Deletes only exact-match confirmation messages whose resource names are inside the smoke space.",
    });
  } else if (config.cleanupFromEvidence) {
    calls.push({
      operation: "cleanup.from-evidence",
      method: "DELETE",
      path: "/v1/{createdCardActionMessage}",
      writes: true,
      safetyCheck: "Deletes only message names listed in prior card-action evidence.",
    });
  } else {
    calls.push({
      operation: "card-action.create",
      method: "POST",
      path: `/v1/${config.space}/messages`,
      writes: true,
      requestBodyFields: ["text", "cardsV2"],
      statefulActionParameters: config.includeState,
      visualExpectation:
        "interactive card with Mark received, Open dialog, and Open navigation buttons",
    });
  }

  return {
    mode: config.dryRun ? "dry-run" : "live",
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    runId: config.runId,
    cleanupFromEvidence: config.cleanupFromEvidence,
    cleanupConfirmationsFromEvidence: config.cleanupConfirmationsFromEvidence,
    calls,
  };
}

function summarizeSpace(space) {
  return {
    resourceName: space.name ?? null,
    displayName: space.displayName ?? null,
    spaceType: space.spaceType ?? null,
  };
}

function summarizeMessage(message) {
  return {
    resourceName: message.name ?? null,
    threadName: message.thread?.name ?? null,
    cards: Array.isArray(message.cardsV2) ? message.cardsV2.length : 0,
  };
}

function sanitizeError(error) {
  if (error instanceof UserAuthRequiredError) {
    return {
      name: error.name,
      message: error.message,
      details: error.details,
      authorizeHint:
        "Run `corepack pnpm chat:user-auth-smoke -- --authorize --read-messages` to grant the local user token chat.messages.readonly. Do not use domain-wide delegation.",
    };
  }
  if (error instanceof ChatApiError) {
    return {
      name: error.name,
      operation: error.operation,
      status: error.status,
      message: error.message,
      apiReason: error.response?.error?.status ?? null,
    };
  }

  return {
    name: error.name ?? "Error",
    message: error.message ?? String(error),
  };
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

async function writeEvidenceFile(config, evidence) {
  const evidencePath =
    config.evidencePath ??
    path.join(defaultEvidenceDir, `chat-card-action-smoke-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

function rememberMessage(evidence, label, message) {
  evidence.resourcesCreated.push({
    kind: "message",
    label,
    name: message.name,
    threadName: message.thread?.name ?? null,
  });
}

export async function runCardActionSmoke(
  config,
  { client = null, userClient = null, writeEvidence = true } = {},
) {
  if (config.help) {
    return { ok: true, evidence: { help: true } };
  }

  if (config.dryRun) {
    const evidence = {
      ok: true,
      mode: "dry-run",
      plan: buildCardActionPlan(config),
    };
    return { ok: true, evidence };
  }

  const chat = client ?? (await createChatClient(config));
  const evidence = {
    ok: false,
    mode: "live",
    runId: config.runId,
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    cleanupFromEvidence: config.cleanupFromEvidence,
    cleanupConfirmationsFromEvidence: config.cleanupConfirmationsFromEvidence,
    startedAt: new Date().toISOString(),
    operations: [],
    resourcesCreated: [],
    visualExpectations: [],
    manualTestSteps: [],
    cleanup: {},
    statefulActionParameters: config.includeState,
    privacy: {
      rawMessageTextSaved: false,
      rawFormValuesSaved: false,
      rawActionStateSaved: false,
      rawAccessTokensSaved: false,
      senderEmailsSaved: false,
    },
  };
  let originalError = null;

  try {
    const targetSpace = await recordOperation(
      evidence,
      "spaces.get",
      () => chat.getSpace(config.space),
      summarizeSpace,
    );
    requireLiveSmokeSpace(targetSpace);

    if (config.cleanupConfirmationsFromEvidence) {
      const userChat = userClient ?? (await createUserAuthMessageReader(config));
      await runCleanupConfirmationsFromEvidence(config, chat, userChat, evidence);
    } else if (config.cleanupFromEvidence) {
      await runCleanupFromEvidence(config, chat, evidence);
    } else {
      await runCardActionCreate(config, chat, evidence);
    }
  } catch (error) {
    originalError = error;
  }

  evidence.finishedAt = new Date().toISOString();
  evidence.ok = originalError === null;

  if (writeEvidence) {
    evidence.evidencePath = await writeEvidenceFile(config, evidence);
  }

  if (originalError) {
    const wrapped = new Error(originalError.message);
    wrapped.cause = originalError;
    wrapped.evidence = evidence;
    throw wrapped;
  }

  return { ok: true, evidence };
}

async function runCardActionCreate(config, chat, evidence) {
  const cardMessage = await recordOperation(
    evidence,
    "card-action.create",
    () => chat.createMessage(config.space, buildCardActionMessage(config)),
    summarizeMessage,
  );
  rememberMessage(evidence, "card-action", cardMessage);
  evidence.visualExpectations.push({
    label: "card-action",
    expect:
      "A Cards V2 message with Mark received, Open dialog, and Open navigation buttons is visible in Google Chat.",
  });
  evidence.manualTestSteps.push(
    {
      label: "mark-received",
      action: "Click Mark received on the card.",
      expect:
        config.includeState
          ? "The same card updates to show Button action received by the dev webhook. State decoded."
          : "The same card updates to show Button action received by the dev webhook.",
    },
    {
      label: "open-dialog",
      action: "Click Open dialog on the card.",
      expect: "A Google Chat AI SDK Dialog Smoke dialog opens for the current user.",
    },
    {
      label: "open-navigation",
      action: "Click Open navigation on the card.",
      expect:
        "A Google Chat AI SDK Navigation Smoke pushed card opens with an Update top card button.",
    },
    {
      label: "update-navigation-card",
      action: "Click Update top card on the pushed navigation card.",
      expect:
        "The top card updates to Google Chat AI SDK Navigation Update Smoke.",
    },
    {
      label: "submit-dialog",
      action: "Enter a non-sensitive smoke note and click Submit dialog.",
      expect:
        "The dialog submits and the app sends a visible Dialog smoke submitted confirmation message.",
    },
  );
}

async function runCleanupFromEvidence(config, chat, evidence) {
  const raw = JSON.parse(await fs.readFile(config.cleanupFromEvidence, "utf8"));
  if (raw.targetSpace !== config.space) {
    throw new Error(
      `Cleanup evidence targetSpace ${raw.targetSpace} does not match ${config.space}`,
    );
  }
  const resources = Array.isArray(raw.resourcesCreated)
    ? raw.resourcesCreated
    : [];
  const messageNames = resources
    .filter((resource) => resource.kind === "message")
    .map((resource) => resource.name)
    .filter(Boolean);

  for (const name of messageNames.reverse()) {
    if (!name.startsWith(`${config.space}/messages/`)) {
      throw new Error(`Refusing to delete message outside smoke space: ${name}`);
    }
    await recordOperation(
      evidence,
      "cleanup.card-action.message.delete",
      () => chat.deleteMessage(name),
      () => ({ resourceName: name }),
    );
  }
}

function readEvidenceWindow(raw, config) {
  const start = config.cleanupStartTime ?? raw.startedAt;
  const end =
    config.cleanupEndTime ??
    new Date(Date.now() + 5 * 60 * 1000).toISOString();

  if (!start) {
    throw new Error(
      "Confirmation cleanup requires evidence.startedAt or --cleanup-start-time.",
    );
  }

  return { start, end };
}

function dialogConfirmationText(runId) {
  return `[${runId}] Dialog smoke submitted.`;
}

function encodeCardActionState(state) {
  return `v1.${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")}`;
}

function stateParameters(config, target) {
  if (!config.includeState) {
    return [];
  }

  return [
    {
      key: CARD_ACTION_STATE_PARAMETER,
      value: encodeCardActionState({
        target,
        cursor: "card-action-smoke-page-2",
        runId: config.runId,
      }),
    },
  ];
}

function summarizeTextHash(spaceDisplayName, value) {
  return {
    length: value.length,
    sha256: crypto
      .createHash("sha256")
      .update(spaceDisplayName)
      .update("\0")
      .update(value)
      .digest("hex"),
  };
}

function summarizeMessageMatch(message) {
  return {
    name: message.name,
    threadName: message.thread?.name ?? null,
    createTime: message.createTime ?? null,
    senderType: message.sender?.type ?? null,
    annotations: Array.isArray(message.annotations) ? message.annotations.length : 0,
    cards: Array.isArray(message.cardsV2) ? message.cardsV2.length : 0,
  };
}

async function fetchMatchingConfirmationMessages(config, userChat, rawEvidence) {
  const expectedText = dialogConfirmationText(rawEvidence.runId);
  const { start, end } = readEvidenceWindow(rawEvidence, config);
  const baseQuery = {
    pageSize: Math.min(config.cleanupPageSize, config.cleanupSearchLimit),
    filter: [
      `createTime > "${start}"`,
      `createTime < "${end}"`,
    ].join(" AND "),
    orderBy: "createTime desc",
  };
  const matches = [];
  let scanned = 0;
  let pageToken = null;

  while (scanned < config.cleanupSearchLimit) {
    const query = pageToken ? { ...baseQuery, pageToken } : baseQuery;
    const result = await userChat.listMessages(query);
    const messages = Array.isArray(result.json.messages) ? result.json.messages : [];
    scanned += messages.length;
    matches.push(
      ...messages.filter((message) => message.text === expectedText),
    );
    pageToken = result.json.nextPageToken ?? null;

    if (!pageToken) {
      break;
    }
  }

  return {
    expectedText,
    window: { start, end },
    scanned,
    matches,
  };
}

async function runCleanupConfirmationsFromEvidence(config, chat, userChat, evidence) {
  const raw = JSON.parse(
    await fs.readFile(config.cleanupConfirmationsFromEvidence, "utf8"),
  );
  if (raw.targetSpace !== config.space) {
    throw new Error(
      `Confirmation cleanup evidence targetSpace ${raw.targetSpace} does not match ${config.space}`,
    );
  }
  if (typeof raw.runId !== "string" || raw.runId.trim() === "") {
    throw new Error("Confirmation cleanup evidence must include a runId.");
  }

  const discovered = await recordOperation(
    evidence,
    "cleanup.confirmations.messages.list",
    () => fetchMatchingConfirmationMessages(config, userChat, raw),
    (result) => ({
      expectedText: summarizeTextHash(config.metadata.displayName, result.expectedText),
      searchWindow: result.window,
      scannedMessages: result.scanned,
      matchedMessages: result.matches.length,
      matches: result.matches.map(summarizeMessageMatch),
    }),
  );

  if (discovered.matches.length === 0) {
    throw new Error(
      `No dialog confirmation messages found for card-action run ${raw.runId}.`,
    );
  }

  for (const message of discovered.matches) {
    if (!message.name?.startsWith(`${config.space}/messages/`)) {
      throw new Error(
        `Refusing to delete confirmation outside smoke space: ${message.name}`,
      );
    }
    await recordOperation(
      evidence,
      "cleanup.confirmations.message.delete",
      () => chat.deleteMessage(message.name),
      () => ({
        resourceName: message.name,
        threadName: message.thread?.name ?? null,
      }),
    );
  }

  evidence.cleanup = {
    kind: "dialog-confirmation",
    sourceEvidencePath: config.cleanupConfirmationsFromEvidence,
    sourceRunId: raw.runId,
    searchedMessages: discovered.scanned,
    deletedMessages: discovered.matches.length,
    expectedText: summarizeTextHash(
      config.metadata.displayName,
      discovered.expectedText,
    ),
  };
}

export function buildCardActionMessage(config) {
  const markReceivedState = stateParameters(config, "mark_received");
  const openDialogState = stateParameters(config, "open_dialog");
  const openNavigationState = stateParameters(config, "open_navigation");
  return {
    text: `[${config.runId}] Card action smoke fallback text.`,
    cardsV2: [
      {
        cardId: `card-action-smoke-${config.runId}`,
        card: {
          header: {
            title: "Google Chat AI SDK Card Action Smoke",
            subtitle: config.runId,
            imageUrl: `${config.baseUrl}/avatar.png`,
            imageType: "CIRCLE",
          },
          sections: [
            {
              header: "Interactive actions",
              widgets: [
                {
                  decoratedText: {
                    topLabel: "Initial state",
                    text: "Waiting for a card button click.",
                    startIcon: {
                      knownIcon: "DESCRIPTION",
                    },
                  },
                },
                {
                  buttonList: {
                    buttons: [
                      {
                        text: "Mark received",
                        onClick: {
                          action: {
                            function: `${config.baseUrl}/chat/events`,
                            parameters: [
                              {
                                key: "actionName",
                                value:
                                  "googlechatai_sdk_card_mark_received",
                              },
                              {
                                key: "runId",
                                value: config.runId,
                              },
                              ...markReceivedState,
                            ],
                          },
                        },
                      },
                      {
                        text: "Open dialog",
                        onClick: {
                          action: {
                            function: `${config.baseUrl}/chat/events`,
                            interaction: "OPEN_DIALOG",
                            parameters: [
                              {
                                key: "actionName",
                                value:
                                  "googlechatai_sdk_card_open_dialog",
                              },
                              {
                                key: "runId",
                                value: config.runId,
                              },
                              ...openDialogState,
                            ],
                          },
                        },
                      },
                      {
                        text: "Open navigation",
                        onClick: {
                          action: {
                            function: `${config.baseUrl}/chat/events`,
                            interaction: "OPEN_DIALOG",
                            parameters: [
                              {
                                key: "actionName",
                                value:
                                  "googlechatai_sdk_card_navigation_next",
                              },
                              {
                                key: "runId",
                                value: config.runId,
                              },
                              ...openNavigationState,
                            ],
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

async function createChatClient(config) {
  const serviceAccount = JSON.parse(
    await fs.readFile(config.credentialsPath, "utf8"),
  );
  const scopes = [BOT_SCOPE];
  const getAccessToken = createServiceAccountTokenBroker(serviceAccount, scopes);

  return {
    getSpace: (name) =>
      chatRequest(serviceAccount, scopes, getAccessToken, name),
    createMessage: (parent, body, query = {}) =>
      chatRequest(serviceAccount, scopes, getAccessToken, `${parent}/messages`, {
        method: "POST",
        query: {
          messageId: query.messageId ?? clientMessageId(config.runId, "card"),
          ...query,
        },
        body,
        idempotent: true,
      }),
    deleteMessage: (name) =>
      chatRequest(serviceAccount, scopes, getAccessToken, name, {
        method: "DELETE",
        idempotent: true,
      }),
  };
}

async function createUserAuthMessageReader(config) {
  const oauthClient = readOAuthClientConfig(
    await fs.readFile(config.userCredentialsPath, "utf8"),
  );

  return {
    async listMessages(query) {
      const url = new URL(`https://chat.googleapis.com/v1/${config.space}/messages`);

      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }

      const result = await chatRequestWithUserAuth({
        oauthClient,
        tokenStorePath: config.userTokenStorePath,
        scopes: MESSAGE_READ_SCOPES,
        url: url.toString(),
      });

      if (!result.ok) {
        throw new ChatApiError(
          "user-auth spaces.messages.list",
          result.status,
          result.json,
        );
      }

      return result;
    },
  };
}

async function chatRequest(
  serviceAccount,
  scopes,
  getAccessToken,
  resourcePath,
  { method = "GET", query = {}, body = null, idempotent = false } = {},
) {
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

function usage() {
  return `${[
    "Usage: RUN_LIVE_CHAT_CARD_ACTION_SMOKE=1 GOOGLE_CHAT_TEST_SPACE=spaces/... pnpm live:chat-card-action-smoke",
    "",
    "Required:",
    "  RUN_LIVE_CHAT_CARD_ACTION_SMOKE=1",
    "  GOOGLE_CHAT_TEST_SPACE=spaces/...",
    "  GOOGLE_CHAT_SMOKE_METADATA=fixtures/live/chat-smoke-space.local.json",
    "",
    "Options:",
    "  --dry-run                      Print planned API calls without writes.",
    "  --metadata <path>              Smoke-space metadata JSON path.",
    "  --evidence <path>              Evidence JSON output path.",
    "  --cleanup-from-evidence <path> Delete messages created by a prior card-action smoke.",
    "  --cleanup-confirmations-from-evidence <path>",
    "                                  Find exact dialog confirmation messages from prior evidence with user auth, then delete with app auth.",
    "  --cleanup-start-time <time>     Optional confirmation search start time.",
    "  --cleanup-end-time <time>       Optional confirmation search end time.",
    "  --cleanup-search-limit <n>      Maximum messages to scan. Default: 100.",
    "  --cleanup-page-size <n>         Page size for confirmation discovery. Default: 25.",
    "  --include-state                 Add hidden encoded action state to card buttons.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = await loadCardActionSmokeConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runCardActionSmoke(config);
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
