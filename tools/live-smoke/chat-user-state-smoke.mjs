import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SMOKE_SPACE_PREFIX } from "./chat-smoke.mjs";
import {
  chatRequestWithUserAuth,
  readOAuthClientConfig,
  resolveUserAuthConfig,
  USER_AUTH_SCOPES,
  UserAuthRequiredError,
} from "../chat/user-auth-smoke.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultMetadataPath = path.join(
  repoRoot,
  "fixtures/live/chat-smoke-space.local.json",
);
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");

const USER_STATE_SURFACES = {
  spaceReadState: {
    key: "spaceReadState",
    label: "users.spaces.getSpaceReadState",
    docsUrl:
      "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.spaces/getSpaceReadState",
    method: "GET",
    pathTemplate: "/v1/{name=users/*/spaces/*/spaceReadState}",
    scopes: USER_AUTH_SCOPES.readState,
    docsStatus: "docs_listed",
    requiresThread: false,
  },
  threadReadState: {
    key: "threadReadState",
    label: "users.spaces.threads.getThreadReadState",
    docsUrl:
      "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.spaces.threads/getThreadReadState",
    method: "GET",
    pathTemplate: "/v1/{name=users/*/spaces/*/threads/*/threadReadState}",
    scopes: USER_AUTH_SCOPES.readState,
    docsStatus: "docs_listed",
    requiresThread: true,
  },
  spaceNotificationSetting: {
    key: "spaceNotificationSetting",
    label: "users.spaces.spaceNotificationSetting.get",
    docsUrl:
      "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.spaces.spaceNotificationSetting/get",
    method: "GET",
    pathTemplate: "/v1/{name=users/*/spaces/*/spaceNotificationSetting}",
    scopes: USER_AUTH_SCOPES.readSpaceSettings,
    docsStatus: "developer_preview",
    requiresThread: false,
  },
};

const NOTIFICATION_PATCH_SURFACE = {
  key: "spaceNotificationSettingPatch",
  label: "users.spaces.spaceNotificationSetting.patch",
  docsUrl:
    "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.spaces.spaceNotificationSetting/patch",
  method: "PATCH",
  pathTemplate:
    "/v1/{spaceNotificationSetting.name=users/*/spaces/*/spaceNotificationSetting}?updateMask=notificationSetting",
  scopes: USER_AUTH_SCOPES.readSpaceSettings,
  docsStatus: "developer_preview",
};

const SPACE_READ_STATE_UPDATE_SURFACE = {
  key: "spaceReadStateUpdate",
  label: "users.spaces.updateSpaceReadState",
  docsUrl:
    "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.spaces/updateSpaceReadState",
  method: "PATCH",
  pathTemplate:
    "/v1/{spaceReadState.name=users/*/spaces/*/spaceReadState}?updateMask=lastReadTime",
  scopes: USER_AUTH_SCOPES.writeState,
  docsStatus: "docs_listed",
};

const USER_WRITE_GATES = new Set([
  "GOOGLE_CHAT_AI_ENABLE_LIVE_USER_SETTINGS_WRITE",
  "GOOGLE_CHAT_AI_ENABLE_LIVE_USER_READ_STATE_WRITE",
]);

const NOTIFICATION_SETTINGS = new Set([
  "ALL",
  "MAIN_CONVERSATIONS",
  "FOR_YOU",
  "OFF",
]);

class ChatUserStateSmokeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ChatUserStateSmokeError";
    this.details = details;
  }
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    allowBlocked: false,
    metadataPath: null,
    evidencePath: null,
    thread: null,
    surfaces: [],
    exerciseNotificationPatch: false,
    exerciseSpaceReadStateUpdate: false,
    notificationSettingTarget: null,
    help: false,
  };
  const rest = argv.slice(2);

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--") {
      continue;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--allow-blocked") {
      args.allowBlocked = true;
    } else if (arg === "--metadata") {
      args.metadataPath = rest[++index];
    } else if (arg.startsWith("--metadata=")) {
      args.metadataPath = arg.slice("--metadata=".length);
    } else if (arg === "--evidence") {
      args.evidencePath = rest[++index];
    } else if (arg.startsWith("--evidence=")) {
      args.evidencePath = arg.slice("--evidence=".length);
    } else if (arg === "--thread") {
      args.thread = rest[++index];
    } else if (arg.startsWith("--thread=")) {
      args.thread = arg.slice("--thread=".length);
    } else if (arg === "--surface") {
      args.surfaces.push(rest[++index]);
    } else if (arg.startsWith("--surface=")) {
      args.surfaces.push(arg.slice("--surface=".length));
    } else if (arg === "--exercise-notification-patch") {
      args.exerciseNotificationPatch = true;
    } else if (arg === "--exercise-space-read-state-update") {
      args.exerciseSpaceReadStateUpdate = true;
    } else if (arg === "--notification-setting-target") {
      args.notificationSettingTarget = rest[++index];
    } else if (arg.startsWith("--notification-setting-target=")) {
      args.notificationSettingTarget = arg.slice(
        "--notification-setting-target=".length,
      );
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

function makeRunId(env) {
  if (env.GOOGLE_CHAT_USER_STATE_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_USER_STATE_SMOKE_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `user-state-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function parseSpaceId(space) {
  const match = /^spaces\/([^/]+)$/.exec(space ?? "");
  if (!match) {
    throw new Error("Space must be in spaces/{space} resource-name form.");
  }
  return match[1];
}

function parseThreadId(thread, expectedSpaceId) {
  if (!thread) {
    return null;
  }

  const fullMatch = /^spaces\/([^/]+)\/threads\/([^/]+)$/.exec(thread);
  if (fullMatch) {
    if (fullMatch[1] !== expectedSpaceId) {
      throw new Error("Thread resource must belong to the configured smoke space.");
    }
    return fullMatch[2];
  }

  const shortMatch = /^threads\/([^/]+)$/.exec(thread);
  if (shortMatch) {
    return shortMatch[1];
  }

  throw new Error(
    "Thread must be in spaces/{space}/threads/{thread} or threads/{thread} form.",
  );
}

function selectedSurfaces(names, hasThread) {
  const selected =
    names.length === 0
      ? [
          USER_STATE_SURFACES.spaceReadState,
          USER_STATE_SURFACES.spaceNotificationSetting,
          ...(hasThread ? [USER_STATE_SURFACES.threadReadState] : []),
        ]
      : names.map((name) => {
          const surface = USER_STATE_SURFACES[name];
          if (!surface) {
            throw new Error(
              `Unknown surface ${name}. Expected one of: ${Object.keys(
                USER_STATE_SURFACES,
              ).join(", ")}`,
            );
          }
          return surface;
        });

  for (const surface of selected) {
    if (surface.requiresThread && !hasThread) {
      throw new Error(
        `${surface.key} requires --thread=spaces/{space}/threads/{thread}.`,
      );
    }
  }

  return selected;
}

function normalizeNotificationSetting(value, optionName) {
  if (!value) {
    return null;
  }

  const normalized = String(value).trim().toUpperCase();
  if (!NOTIFICATION_SETTINGS.has(normalized)) {
    throw new Error(
      `${optionName} must be one of: ${[...NOTIFICATION_SETTINGS].join(", ")}`,
    );
  }

  return normalized;
}

function surfacePlan(surface) {
  return {
    surface: surface.label,
    method: surface.method,
    pathTemplate: surface.pathTemplate,
    docsStatus: surface.docsStatus,
    docsUrl: surface.docsUrl,
    authPrincipal: "user",
    scopes: surface.scopes,
    write: false,
  };
}

function notificationPatchPlan(config) {
  if (!config.mutation?.exerciseNotificationPatch) {
    return [];
  }

  return [
    {
      surface: NOTIFICATION_PATCH_SURFACE.label,
      method: NOTIFICATION_PATCH_SURFACE.method,
      pathTemplate: NOTIFICATION_PATCH_SURFACE.pathTemplate,
      docsStatus: NOTIFICATION_PATCH_SURFACE.docsStatus,
      docsUrl: NOTIFICATION_PATCH_SURFACE.docsUrl,
      authPrincipal: "user",
      scopes: NOTIFICATION_PATCH_SURFACE.scopes,
      write: true,
      reversible: true,
      explicitWriteGate: "GOOGLE_CHAT_AI_ENABLE_LIVE_USER_SETTINGS_WRITE",
      targetNotificationSetting:
        config.mutation?.notificationSettingTarget ?? "auto-alternate",
      restoreOriginal: true,
    },
  ];
}

function spaceReadStateUpdatePlan(config) {
  if (!config.mutation?.exerciseSpaceReadStateUpdate) {
    return [];
  }

  return [
    {
      surface: SPACE_READ_STATE_UPDATE_SURFACE.label,
      method: SPACE_READ_STATE_UPDATE_SURFACE.method,
      pathTemplate: SPACE_READ_STATE_UPDATE_SURFACE.pathTemplate,
      docsStatus: SPACE_READ_STATE_UPDATE_SURFACE.docsStatus,
      docsUrl: SPACE_READ_STATE_UPDATE_SURFACE.docsUrl,
      authPrincipal: "user",
      scopes: SPACE_READ_STATE_UPDATE_SURFACE.scopes,
      write: true,
      idempotentNoOp: true,
      reversible: true,
      explicitWriteGate: "GOOGLE_CHAT_AI_ENABLE_LIVE_USER_READ_STATE_WRITE",
      updateMask: "lastReadTime",
      targetLastReadTime: "current-observed-lastReadTime",
    },
  ];
}

function encodePathPart(value) {
  return encodeURIComponent(value);
}

function surfaceUrl(surface, { spaceId, threadId }) {
  const userSpace = `users/me/spaces/${encodePathPart(spaceId)}`;
  if (surface.key === "spaceReadState") {
    return `https://chat.googleapis.com/v1/${userSpace}/spaceReadState`;
  }
  if (surface.key === "threadReadState") {
    return `https://chat.googleapis.com/v1/${userSpace}/threads/${encodePathPart(
      threadId,
    )}/threadReadState`;
  }
  if (surface.key === "spaceNotificationSetting") {
    return `https://chat.googleapis.com/v1/${userSpace}/spaceNotificationSetting`;
  }
  throw new Error(`Unsupported surface ${surface.key}.`);
}

function notificationSettingName(spaceId) {
  return `users/me/spaces/${spaceId}/spaceNotificationSetting`;
}

function spaceReadStateName(spaceId) {
  return `users/me/spaces/${spaceId}/spaceReadState`;
}

function notificationPatchUrl(spaceId) {
  const url = new URL(
    `https://chat.googleapis.com/v1/${notificationSettingName(
      encodePathPart(spaceId),
    )}`,
  );
  url.searchParams.set("updateMask", "notificationSetting");
  return url.toString();
}

function spaceReadStateUpdateUrl(spaceId) {
  const url = new URL(
    `https://chat.googleapis.com/v1/${spaceReadStateName(
      encodePathPart(spaceId),
    )}`,
  );
  url.searchParams.set("updateMask", "lastReadTime");
  return url.toString();
}

function surfaceInit() {
  return {
    method: "GET",
    idempotent: true,
  };
}

function notificationPatchInit({ spaceId, notificationSetting }) {
  return {
    method: "PATCH",
    idempotent: true,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: notificationSettingName(spaceId),
      notificationSetting,
    }),
  };
}

function spaceReadStateUpdateInit({ spaceId, lastReadTime }) {
  return {
    method: "PATCH",
    idempotent: true,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: spaceReadStateName(spaceId),
      lastReadTime,
    }),
  };
}

function safeResponseKeys(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return [];
  }
  return Object.keys(json).sort();
}

function summarizeSuccess(surface, json) {
  const resourceName = typeof json?.name === "string" ? json.name : null;
  const summary = {
    resourceNameHash: resourceName ? stableHash(resourceName) : null,
    responseKeys: safeResponseKeys(json),
  };

  if (surface.key === "spaceReadState" || surface.key === "threadReadState") {
    summary.lastReadTimeAvailable = typeof json?.lastReadTime === "string";
  }

  if (surface.key === "spaceNotificationSetting") {
    summary.notificationSetting =
      typeof json?.notificationSetting === "string"
        ? json.notificationSetting
        : null;
    summary.muteSetting =
      typeof json?.muteSetting === "string" ? json.muteSetting : null;
    summary.muteTimeAvailable = typeof json?.muteTime === "string";
  }

  return summary;
}

function summarizeNotificationSetting(json) {
  const resourceName = typeof json?.name === "string" ? json.name : null;
  return {
    resourceNameHash: resourceName ? stableHash(resourceName) : null,
    responseKeys: safeResponseKeys(json),
    notificationSetting:
      typeof json?.notificationSetting === "string"
        ? json.notificationSetting
        : null,
    muteSetting:
      typeof json?.muteSetting === "string" ? json.muteSetting : null,
  };
}

function summarizeSpaceReadState(json) {
  const resourceName = typeof json?.name === "string" ? json.name : null;
  const lastReadTime =
    typeof json?.lastReadTime === "string" ? json.lastReadTime : null;
  return {
    resourceNameHash: resourceName ? stableHash(resourceName) : null,
    responseKeys: safeResponseKeys(json),
    lastReadTimeAvailable: Boolean(lastReadTime),
    lastReadTimeHash: lastReadTime ? stableHash(lastReadTime) : null,
  };
}

function blockedReason(result) {
  const json = result.json && typeof result.json === "object" ? result.json : {};
  if (result.status === 401) {
    return "auth_failed_after_refresh";
  }
  if (result.status === 403) {
    return "permission_or_preview_access_denied";
  }
  if (result.status === 404) {
    return "not_found_or_not_enabled";
  }
  return json.error?.status ?? `http_${result.status}`;
}

function summarizeMutationStep({ operation, method, result, allowBlocked }) {
  const json = result.json && typeof result.json === "object" ? result.json : {};
  const blocked = !result.ok;
  const surface =
    method === "GET"
      ? USER_STATE_SURFACES.spaceNotificationSetting
      : NOTIFICATION_PATCH_SURFACE;
  return {
    operation,
    surface: surface.label,
    docsStatus: surface.docsStatus,
    docsUrl: surface.docsUrl,
    method,
    pathTemplate:
      method === "GET"
        ? USER_STATE_SURFACES.spaceNotificationSetting.pathTemplate
        : NOTIFICATION_PATCH_SURFACE.pathTemplate,
    authPrincipal: "user",
    scopes: NOTIFICATION_PATCH_SURFACE.scopes,
    write: method !== "GET",
    status: result.status,
    ok: Boolean(result.ok),
    blocked,
    allowedBlocked: blocked && allowBlocked,
    blockedReason: blocked ? blockedReason(result) : null,
    attempts: result.attempts,
    refreshed: Boolean(result.refreshed),
    replayedAfter401: Boolean(result.replayedAfter401),
    retryDecisionCount: Array.isArray(result.retryDecisions)
      ? result.retryDecisions.length
      : 0,
    response: result.ok ? summarizeNotificationSetting(json) : null,
    responseHeaders: result.headers ?? {},
  };
}

function summarizeReadStateUpdateStep({ operation, method, result, allowBlocked }) {
  const json = result.json && typeof result.json === "object" ? result.json : {};
  const blocked = !result.ok;
  const surface =
    method === "GET"
      ? USER_STATE_SURFACES.spaceReadState
      : SPACE_READ_STATE_UPDATE_SURFACE;
  return {
    operation,
    surface: surface.label,
    docsStatus: surface.docsStatus,
    docsUrl: surface.docsUrl,
    method,
    pathTemplate:
      method === "GET"
        ? USER_STATE_SURFACES.spaceReadState.pathTemplate
        : SPACE_READ_STATE_UPDATE_SURFACE.pathTemplate,
    authPrincipal: "user",
    scopes: SPACE_READ_STATE_UPDATE_SURFACE.scopes,
    write: method !== "GET",
    status: result.status,
    ok: Boolean(result.ok),
    blocked,
    allowedBlocked: blocked && allowBlocked,
    blockedReason: blocked ? blockedReason(result) : null,
    attempts: result.attempts,
    refreshed: Boolean(result.refreshed),
    replayedAfter401: Boolean(result.replayedAfter401),
    retryDecisionCount: Array.isArray(result.retryDecisions)
      ? result.retryDecisions.length
      : 0,
    response: result.ok ? summarizeSpaceReadState(json) : null,
    responseHeaders: result.headers ?? {},
  };
}

function summarizeResult(surface, result, allowBlocked) {
  const json = result.json && typeof result.json === "object" ? result.json : {};
  const blocked = !result.ok;

  return {
    surface: surface.label,
    docsStatus: surface.docsStatus,
    docsUrl: surface.docsUrl,
    method: surface.method,
    pathTemplate: surface.pathTemplate,
    authPrincipal: "user",
    scopes: surface.scopes,
    status: result.status,
    ok: Boolean(result.ok),
    blocked,
    allowedBlocked: blocked && allowBlocked,
    blockedReason: blocked ? blockedReason(result) : null,
    attempts: result.attempts,
    refreshed: Boolean(result.refreshed),
    replayedAfter401: Boolean(result.replayedAfter401),
    retryDecisionCount: Array.isArray(result.retryDecisions)
      ? result.retryDecisions.length
      : 0,
    response: result.ok ? summarizeSuccess(surface, json) : null,
    responseHeaders: result.headers ?? {},
  };
}

function summarizeAuthRequired(surface, error, allowBlocked) {
  return {
    surface: surface.label,
    docsStatus: surface.docsStatus,
    docsUrl: surface.docsUrl,
    method: surface.method,
    pathTemplate: surface.pathTemplate,
    authPrincipal: "user",
    scopes: surface.scopes,
    status: "auth_required",
    ok: false,
    blocked: true,
    allowedBlocked: allowBlocked,
    blockedReason: error.details?.reason ?? "auth_required",
    attempts: 0,
    refreshed: false,
    replayedAfter401: false,
    retryDecisionCount: 0,
    response: null,
    responseHeaders: {},
  };
}

function summarizeMutationAuthRequired(operation, method, error, allowBlocked) {
  const surface =
    method === "GET"
      ? USER_STATE_SURFACES.spaceNotificationSetting
      : NOTIFICATION_PATCH_SURFACE;
  return {
    operation,
    surface: surface.label,
    docsStatus: surface.docsStatus,
    docsUrl: surface.docsUrl,
    method,
    pathTemplate:
      method === "GET"
        ? USER_STATE_SURFACES.spaceNotificationSetting.pathTemplate
        : NOTIFICATION_PATCH_SURFACE.pathTemplate,
    authPrincipal: "user",
    scopes: NOTIFICATION_PATCH_SURFACE.scopes,
    write: method !== "GET",
    status: "auth_required",
    ok: false,
    blocked: true,
    allowedBlocked: allowBlocked,
    blockedReason: error.details?.reason ?? "auth_required",
    attempts: 0,
    refreshed: false,
    replayedAfter401: false,
    retryDecisionCount: 0,
    response: null,
    responseHeaders: {},
  };
}

function summarizeReadStateAuthRequired(operation, method, error, allowBlocked) {
  const surface =
    method === "GET"
      ? USER_STATE_SURFACES.spaceReadState
      : SPACE_READ_STATE_UPDATE_SURFACE;
  return {
    operation,
    surface: surface.label,
    docsStatus: surface.docsStatus,
    docsUrl: surface.docsUrl,
    method,
    pathTemplate:
      method === "GET"
        ? USER_STATE_SURFACES.spaceReadState.pathTemplate
        : SPACE_READ_STATE_UPDATE_SURFACE.pathTemplate,
    authPrincipal: "user",
    scopes: SPACE_READ_STATE_UPDATE_SURFACE.scopes,
    write: method !== "GET",
    status: "auth_required",
    ok: false,
    blocked: true,
    allowedBlocked: allowBlocked,
    blockedReason: error.details?.reason ?? "auth_required",
    attempts: 0,
    refreshed: false,
    replayedAfter401: false,
    retryDecisionCount: 0,
    response: null,
    responseHeaders: {},
  };
}

function chooseNotificationTarget(currentSetting, configuredTarget) {
  if (!NOTIFICATION_SETTINGS.has(currentSetting)) {
    return null;
  }

  if (configuredTarget && configuredTarget !== currentSetting) {
    return configuredTarget;
  }

  if (currentSetting === "FOR_YOU") {
    return "MAIN_CONVERSATIONS";
  }

  return "FOR_YOU";
}

function makeSkippedMutationResult({
  reason,
  allowBlocked,
  before = null,
  targetNotificationSetting = null,
}) {
  return {
    surface: NOTIFICATION_PATCH_SURFACE.label,
    docsStatus: NOTIFICATION_PATCH_SURFACE.docsStatus,
    docsUrl: NOTIFICATION_PATCH_SURFACE.docsUrl,
    authPrincipal: "user",
    scopes: NOTIFICATION_PATCH_SURFACE.scopes,
    write: true,
    reversible: true,
    ok: false,
    blocked: true,
    allowedBlocked: allowBlocked,
    blockedReason: reason,
    before,
    targetNotificationSetting,
    patch: null,
    restore: null,
    after: null,
    changedAwayFromOriginal: false,
    restoredOriginal: false,
  };
}

function makeSkippedReadStateUpdateResult({
  reason,
  allowBlocked,
  before = null,
  targetLastReadTimeHash = null,
}) {
  return {
    surface: SPACE_READ_STATE_UPDATE_SURFACE.label,
    docsStatus: SPACE_READ_STATE_UPDATE_SURFACE.docsStatus,
    docsUrl: SPACE_READ_STATE_UPDATE_SURFACE.docsUrl,
    authPrincipal: "user",
    scopes: SPACE_READ_STATE_UPDATE_SURFACE.scopes,
    write: true,
    idempotentNoOp: true,
    reversible: true,
    ok: false,
    blocked: true,
    allowedBlocked: allowBlocked,
    blockedReason: reason,
    before,
    targetLastReadTimeHash,
    patch: null,
    after: null,
    preservedLastReadTime: false,
  };
}

async function callUserAuthSurface({
  oauthClient,
  tokenStorePath,
  scopes,
  url,
  init,
  chatRequestWithUserAuthImpl,
}) {
  return chatRequestWithUserAuthImpl({
    oauthClient,
    tokenStorePath,
    scopes,
    url,
    init,
  });
}

async function exerciseSpaceReadStateUpdate({
  config,
  oauthClient,
  chatRequestWithUserAuthImpl,
}) {
  let before = null;
  let beforeLastReadTime = null;
  let patch = null;
  let after = null;
  let afterLastReadTime = null;

  try {
    const beforeResult = await callUserAuthSurface({
      oauthClient,
      tokenStorePath: config.userAuth.tokenStorePath,
      scopes: SPACE_READ_STATE_UPDATE_SURFACE.scopes,
      url: surfaceUrl(USER_STATE_SURFACES.spaceReadState, config),
      init: surfaceInit(USER_STATE_SURFACES.spaceReadState),
      chatRequestWithUserAuthImpl,
    });
    beforeLastReadTime =
      typeof beforeResult.json?.lastReadTime === "string"
        ? beforeResult.json.lastReadTime
        : null;
    before = summarizeReadStateUpdateStep({
      operation: "spaceReadState.get.beforeUpdate",
      method: "GET",
      result: beforeResult,
      allowBlocked: config.allowBlocked,
    });
  } catch (error) {
    if (error instanceof UserAuthRequiredError) {
      before = summarizeReadStateAuthRequired(
        "spaceReadState.get.beforeUpdate",
        "GET",
        error,
        config.allowBlocked,
      );
    } else {
      throw error;
    }
  }

  if (!before.ok) {
    return makeSkippedReadStateUpdateResult({
      reason: before.blockedReason ?? "before_update_get_failed",
      allowBlocked: config.allowBlocked,
      before,
    });
  }

  if (!beforeLastReadTime) {
    return makeSkippedReadStateUpdateResult({
      reason: "missing_current_last_read_time",
      allowBlocked: config.allowBlocked,
      before,
    });
  }

  try {
    const patchResult = await callUserAuthSurface({
      oauthClient,
      tokenStorePath: config.userAuth.tokenStorePath,
      scopes: SPACE_READ_STATE_UPDATE_SURFACE.scopes,
      url: spaceReadStateUpdateUrl(config.spaceId),
      init: spaceReadStateUpdateInit({
        spaceId: config.spaceId,
        lastReadTime: beforeLastReadTime,
      }),
      chatRequestWithUserAuthImpl,
    });
    patch = summarizeReadStateUpdateStep({
      operation: "spaceReadState.patch.currentLastReadTime",
      method: "PATCH",
      result: patchResult,
      allowBlocked: config.allowBlocked,
    });
  } catch (error) {
    if (error instanceof UserAuthRequiredError) {
      patch = summarizeReadStateAuthRequired(
        "spaceReadState.patch.currentLastReadTime",
        "PATCH",
        error,
        config.allowBlocked,
      );
    } else {
      throw error;
    }
  }

  if (patch.ok) {
    try {
      const afterResult = await callUserAuthSurface({
        oauthClient,
        tokenStorePath: config.userAuth.tokenStorePath,
        scopes: SPACE_READ_STATE_UPDATE_SURFACE.scopes,
        url: surfaceUrl(USER_STATE_SURFACES.spaceReadState, config),
        init: surfaceInit(USER_STATE_SURFACES.spaceReadState),
        chatRequestWithUserAuthImpl,
      });
      afterLastReadTime =
        typeof afterResult.json?.lastReadTime === "string"
          ? afterResult.json.lastReadTime
          : null;
      after = summarizeReadStateUpdateStep({
        operation: "spaceReadState.get.afterUpdate",
        method: "GET",
        result: afterResult,
        allowBlocked: config.allowBlocked,
      });
    } catch (error) {
      if (error instanceof UserAuthRequiredError) {
        after = summarizeReadStateAuthRequired(
          "spaceReadState.get.afterUpdate",
          "GET",
          error,
          config.allowBlocked,
        );
      } else {
        throw error;
      }
    }
  }

  const preservedLastReadTime = afterLastReadTime === beforeLastReadTime;
  const blocked = [before, patch, after].some((step) => step?.blocked);

  return {
    surface: SPACE_READ_STATE_UPDATE_SURFACE.label,
    docsStatus: SPACE_READ_STATE_UPDATE_SURFACE.docsStatus,
    docsUrl: SPACE_READ_STATE_UPDATE_SURFACE.docsUrl,
    authPrincipal: "user",
    scopes: SPACE_READ_STATE_UPDATE_SURFACE.scopes,
    write: true,
    idempotentNoOp: true,
    reversible: true,
    ok:
      Boolean(before?.ok) &&
      Boolean(patch?.ok) &&
      Boolean(after?.ok) &&
      preservedLastReadTime,
    blocked,
    allowedBlocked: blocked && config.allowBlocked,
    blockedReason: blocked ? "space_read_state_update_blocked" : null,
    before,
    targetLastReadTimeHash: stableHash(beforeLastReadTime),
    patch,
    after,
    preservedLastReadTime,
  };
}

async function exerciseNotificationPatch({
  config,
  oauthClient,
  chatRequestWithUserAuthImpl,
}) {
  let before = null;
  let patch = null;
  let restore = null;
  let after = null;

  try {
    const beforeResult = await callUserAuthSurface({
      oauthClient,
      tokenStorePath: config.userAuth.tokenStorePath,
      scopes: NOTIFICATION_PATCH_SURFACE.scopes,
      url: surfaceUrl(USER_STATE_SURFACES.spaceNotificationSetting, config),
      init: surfaceInit(USER_STATE_SURFACES.spaceNotificationSetting),
      chatRequestWithUserAuthImpl,
    });
    before = summarizeMutationStep({
      operation: "spaceNotificationSetting.get.beforePatch",
      method: "GET",
      result: beforeResult,
      allowBlocked: config.allowBlocked,
    });
  } catch (error) {
    if (error instanceof UserAuthRequiredError) {
      before = summarizeMutationAuthRequired(
        "spaceNotificationSetting.get.beforePatch",
        "GET",
        error,
        config.allowBlocked,
      );
    } else {
      throw error;
    }
  }

  if (!before.ok) {
    return makeSkippedMutationResult({
      reason: before.blockedReason ?? "before_patch_get_failed",
      allowBlocked: config.allowBlocked,
      before,
    });
  }

  const beforeSetting = before.response?.notificationSetting ?? null;
  const targetSetting = chooseNotificationTarget(
    beforeSetting,
    config.mutation.notificationSettingTarget,
  );

  if (!targetSetting) {
    return makeSkippedMutationResult({
      reason: "unsupported_current_notification_setting",
      allowBlocked: config.allowBlocked,
      before,
      targetNotificationSetting: config.mutation.notificationSettingTarget,
    });
  }

  try {
    const patchResult = await callUserAuthSurface({
      oauthClient,
      tokenStorePath: config.userAuth.tokenStorePath,
      scopes: NOTIFICATION_PATCH_SURFACE.scopes,
      url: notificationPatchUrl(config.spaceId),
      init: notificationPatchInit({
        spaceId: config.spaceId,
        notificationSetting: targetSetting,
      }),
      chatRequestWithUserAuthImpl,
    });
    patch = summarizeMutationStep({
      operation: "spaceNotificationSetting.patch.target",
      method: "PATCH",
      result: patchResult,
      allowBlocked: config.allowBlocked,
    });
  } catch (error) {
    if (error instanceof UserAuthRequiredError) {
      patch = summarizeMutationAuthRequired(
        "spaceNotificationSetting.patch.target",
        "PATCH",
        error,
        config.allowBlocked,
      );
    } else {
      throw error;
    }
  }

  if (patch.ok) {
    try {
      const restoreResult = await callUserAuthSurface({
        oauthClient,
        tokenStorePath: config.userAuth.tokenStorePath,
        scopes: NOTIFICATION_PATCH_SURFACE.scopes,
        url: notificationPatchUrl(config.spaceId),
        init: notificationPatchInit({
          spaceId: config.spaceId,
          notificationSetting: beforeSetting,
        }),
        chatRequestWithUserAuthImpl,
      });
      restore = summarizeMutationStep({
        operation: "spaceNotificationSetting.patch.restore",
        method: "PATCH",
        result: restoreResult,
        allowBlocked: config.allowBlocked,
      });
    } catch (error) {
      if (error instanceof UserAuthRequiredError) {
        restore = summarizeMutationAuthRequired(
          "spaceNotificationSetting.patch.restore",
          "PATCH",
          error,
          config.allowBlocked,
        );
      } else {
        throw error;
      }
    }
  }

  if (restore?.ok) {
    try {
      const afterResult = await callUserAuthSurface({
        oauthClient,
        tokenStorePath: config.userAuth.tokenStorePath,
        scopes: NOTIFICATION_PATCH_SURFACE.scopes,
        url: surfaceUrl(USER_STATE_SURFACES.spaceNotificationSetting, config),
        init: surfaceInit(USER_STATE_SURFACES.spaceNotificationSetting),
        chatRequestWithUserAuthImpl,
      });
      after = summarizeMutationStep({
        operation: "spaceNotificationSetting.get.afterRestore",
        method: "GET",
        result: afterResult,
        allowBlocked: config.allowBlocked,
      });
    } catch (error) {
      if (error instanceof UserAuthRequiredError) {
        after = summarizeMutationAuthRequired(
          "spaceNotificationSetting.get.afterRestore",
          "GET",
          error,
          config.allowBlocked,
        );
      } else {
        throw error;
      }
    }
  }

  const restoredSetting =
    after?.response?.notificationSetting ??
    restore?.response?.notificationSetting ??
    null;
  const changedAwayFromOriginal =
    patch?.response?.notificationSetting === targetSetting &&
    targetSetting !== beforeSetting;
  const restoredOriginal = restoredSetting === beforeSetting;
  const blocked = [before, patch, restore, after].some((step) => step?.blocked);

  return {
    surface: NOTIFICATION_PATCH_SURFACE.label,
    docsStatus: NOTIFICATION_PATCH_SURFACE.docsStatus,
    docsUrl: NOTIFICATION_PATCH_SURFACE.docsUrl,
    authPrincipal: "user",
    scopes: NOTIFICATION_PATCH_SURFACE.scopes,
    write: true,
    reversible: true,
    ok:
      Boolean(before?.ok) &&
      Boolean(patch?.ok) &&
      Boolean(restore?.ok) &&
      Boolean(after?.ok) &&
      changedAwayFromOriginal &&
      restoredOriginal,
    blocked,
    allowedBlocked: blocked && config.allowBlocked,
    blockedReason: blocked ? "notification_patch_or_restore_blocked" : null,
    before,
    targetNotificationSetting: targetSetting,
    patch,
    restore,
    after,
    changedAwayFromOriginal,
    restoredOriginal,
  };
}

export async function loadUserStateSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    return { help: true };
  }
  if (!args.dryRun && env.RUN_LIVE_CHAT_USER_STATE_SMOKE !== "1") {
    throw new ChatUserStateSmokeError(
      "Refusing to run user-state Chat smoke without RUN_LIVE_CHAT_USER_STATE_SMOKE=1.",
      { envVar: "RUN_LIVE_CHAT_USER_STATE_SMOKE" },
    );
  }
  if (
    args.exerciseNotificationPatch &&
    !args.dryRun &&
    env.GOOGLE_CHAT_AI_ENABLE_LIVE_USER_SETTINGS_WRITE !== "1"
  ) {
    throw new ChatUserStateSmokeError(
      "Refusing to mutate user notification settings without GOOGLE_CHAT_AI_ENABLE_LIVE_USER_SETTINGS_WRITE=1.",
      { envVar: "GOOGLE_CHAT_AI_ENABLE_LIVE_USER_SETTINGS_WRITE" },
    );
  }
  if (
    args.exerciseSpaceReadStateUpdate &&
    !args.dryRun &&
    env.GOOGLE_CHAT_AI_ENABLE_LIVE_USER_READ_STATE_WRITE !== "1"
  ) {
    throw new ChatUserStateSmokeError(
      "Refusing to mutate user read state without GOOGLE_CHAT_AI_ENABLE_LIVE_USER_READ_STATE_WRITE=1.",
      { envVar: "GOOGLE_CHAT_AI_ENABLE_LIVE_USER_READ_STATE_WRITE" },
    );
  }

  const metadataPath =
    resolvePath(args.metadataPath || env.GOOGLE_CHAT_SMOKE_METADATA, cwd) ??
    defaultMetadataPath;
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  const expectedSpace = env.GOOGLE_CHAT_TEST_SPACE ?? metadata.space;
  requireSmokeMetadata(metadata, expectedSpace);

  const spaceId = parseSpaceId(metadata.space);
  const threadId = parseThreadId(args.thread, spaceId);
  const runId = makeRunId(env);
  const evidencePath =
    resolvePath(args.evidencePath, cwd) ??
    path.join(defaultEvidenceDir, `chat-user-state-smoke-${runId}.json`);

  return {
    help: false,
    dryRun: args.dryRun,
    allowBlocked: args.allowBlocked,
    runId,
    metadataPath,
    evidencePath,
    spaceId,
    threadId,
    spaceHash: stableHash(metadata.space),
    displayNameHash: stableHash(metadata.displayName),
    threadHash: args.thread ? stableHash(args.thread) : null,
    surfaces: selectedSurfaces(args.surfaces, Boolean(threadId)),
    mutation: {
      exerciseNotificationPatch: args.exerciseNotificationPatch,
      exerciseSpaceReadStateUpdate: args.exerciseSpaceReadStateUpdate,
      notificationSettingTarget: normalizeNotificationSetting(
        args.notificationSettingTarget,
        "--notification-setting-target",
      ),
    },
    userAuth: resolveUserAuthConfig(env, {}),
  };
}

export async function runUserStateSmoke(
  config,
  {
    readFile = fs.readFile,
    writeFile = fs.writeFile,
    mkdir = fs.mkdir,
    chatRequestWithUserAuthImpl = chatRequestWithUserAuth,
    readOAuthClientConfigImpl = readOAuthClientConfig,
    now = () => new Date(),
  } = {},
) {
  if (config.help) {
    return { ok: true, help: true };
  }

  const generatedAt = now().toISOString();
  const plan = [
    ...config.surfaces.map(surfacePlan),
    ...notificationPatchPlan(config),
    ...spaceReadStateUpdatePlan(config),
  ];

  if (config.dryRun) {
    return {
      ok: true,
      mode: "user-state-smoke",
      status: "dry_run",
      runId: config.runId,
      generatedAt,
      spaceHash: config.spaceHash,
      displayNameHash: config.displayNameHash,
      threadHash: config.threadHash,
      plan,
      privacy: privacySummary(),
    };
  }

  const credentialsPath = path.isAbsolute(config.userAuth.credentialsPath)
    ? config.userAuth.credentialsPath
    : path.resolve(config.userAuth.credentialsPath);
  const rawClient = await readFile(credentialsPath, "utf8");
  const oauthClient = readOAuthClientConfigImpl(rawClient);

  const surfaceResults = [];
  for (const surface of config.surfaces) {
    try {
      const result = await chatRequestWithUserAuthImpl({
        oauthClient,
        tokenStorePath: config.userAuth.tokenStorePath,
        scopes: surface.scopes,
        url: surfaceUrl(surface, config),
        init: surfaceInit(surface),
      });
      surfaceResults.push(summarizeResult(surface, result, config.allowBlocked));
    } catch (error) {
      if (error instanceof UserAuthRequiredError) {
        surfaceResults.push(
          summarizeAuthRequired(surface, error, config.allowBlocked),
        );
        continue;
      }
      throw error;
    }
  }

  const mutationResults = [];
  if (config.mutation?.exerciseNotificationPatch) {
    mutationResults.push(
      await exerciseNotificationPatch({
        config,
        oauthClient,
        chatRequestWithUserAuthImpl,
      }),
    );
  }
  if (config.mutation?.exerciseSpaceReadStateUpdate) {
    mutationResults.push(
      await exerciseSpaceReadStateUpdate({
        config,
        oauthClient,
        chatRequestWithUserAuthImpl,
      }),
    );
  }

  const allResults = [...surfaceResults, ...mutationResults];
  const blocked = allResults.filter((result) => result.blocked || !result.ok);
  const ok =
    blocked.length === 0 ||
    (config.allowBlocked &&
      blocked.length > 0 &&
      blocked.every((result) => result.allowedBlocked));
  const evidence = {
    ok,
    mode: "user-state-smoke",
    status: blocked.length > 0 ? "blocked" : "verified",
    runId: config.runId,
    generatedAt,
    spaceHash: config.spaceHash,
    displayNameHash: config.displayNameHash,
    threadHash: config.threadHash,
    surfaces: surfaceResults,
    mutations: mutationResults,
    assertions: {
      smokeSpaceValidated: true,
      readOnlyOnly: plan.every((surface) => surface.write === false),
      writesRequireExplicitGate: plan
        .filter((surface) => surface.write)
        .every((surface) => USER_WRITE_GATES.has(surface.explicitWriteGate)),
      reversibleMutationOnly: plan
        .filter((surface) => surface.write)
        .every((surface) => surface.reversible === true),
      usedUserAuthOnly: plan.every((surface) => surface.authPrincipal === "user"),
      noWebhookExpected: true,
      blockedAllowed: config.allowBlocked,
      allBlockedAllowed:
        blocked.length === 0 || blocked.every((result) => result.allowedBlocked),
    },
    privacy: privacySummary(),
  };

  await mkdir(path.dirname(config.evidencePath), { recursive: true });
  await writeFile(config.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  return {
    ...evidence,
    evidencePath: path.relative(repoRoot, config.evidencePath),
  };
}

function privacySummary() {
  return {
    savesRawSpaceName: false,
    savesRawThreadName: false,
    savesRawMessageNames: false,
    savesRawMessageText: false,
    savesRawTokenMaterial: false,
    savesRawUserEmails: false,
    savesRawNotificationResourceName: false,
    savesRawReadStateTimestamp: false,
  };
}

function printHelp() {
  console.log([
    "Usage: pnpm live:chat-user-state-smoke [-- --dry-run] [-- --allow-blocked]",
    "",
    "User-auth smoke for Chat space/thread read state and notification settings.",
    "",
    "Environment:",
    "  RUN_LIVE_CHAT_USER_STATE_SMOKE=1  Required unless --dry-run is used.",
    "  GOOGLE_CHAT_TEST_SPACE            Dedicated smoke space resource name.",
    "  GOOGLE_CHAT_USER_STATE_SMOKE_RUN_ID",
    "                                   Optional stable run id.",
    "",
    "Options:",
    "  --dry-run                 Print the read-only plan without API calls.",
    "  --allow-blocked           Save auth/scope/preview failures as blocked evidence.",
    "  --metadata <path>         Smoke space metadata JSON.",
    "  --evidence <path>         Evidence output path.",
    "  --thread <resource>       Optional spaces/{space}/threads/{thread} resource.",
    "  --surface <name>          spaceReadState, threadReadState, or spaceNotificationSetting. Repeatable.",
    "  --exercise-notification-patch",
    "                            Patch the smoke-space notification setting to an alternate value,",
    "                            restore the original value, and verify restoration.",
    "                            Requires GOOGLE_CHAT_AI_ENABLE_LIVE_USER_SETTINGS_WRITE=1 live.",
    "  --exercise-space-read-state-update",
    "                            PATCH the current observed space lastReadTime back to itself.",
    "                            Requires GOOGLE_CHAT_AI_ENABLE_LIVE_USER_READ_STATE_WRITE=1 live.",
    "  --notification-setting-target <enum>",
    "                            Optional ALL, MAIN_CONVERSATIONS, FOR_YOU, or OFF target.",
    "",
    "Authorize scopes centrally if needed:",
    "  pnpm chat:user-auth-smoke -- --authorize --read-state --write-state --read-space-settings",
  ].join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadUserStateSmokeConfig()
    .then(async (config) => {
      if (config.help) {
        printHelp();
        return { ok: true };
      }
      return runUserStateSmoke(config);
    })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(error.stack ?? String(error));
      process.exit(1);
    });
}
