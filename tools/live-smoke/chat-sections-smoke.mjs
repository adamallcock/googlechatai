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
const SECTIONS_READ_SCOPES = USER_AUTH_SCOPES.readSections;
const SECTIONS_WRITE_SCOPES = USER_AUTH_SCOPES.writeSections;
const SECTIONS_WRITE_GATE = "GOOGLE_CHAT_AI_ENABLE_LIVE_SECTIONS_WRITE";

class ChatSectionsSmokeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ChatSectionsSmokeError";
    this.details = details;
  }
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    allowBlocked: false,
    metadataPath: null,
    evidencePath: null,
    pageSize: 10,
    maxPages: 10,
    expectSmokeSpaceItem: false,
    exerciseSectionMutations: false,
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
    } else if (arg === "--page-size") {
      args.pageSize = Number(rest[++index]);
    } else if (arg.startsWith("--page-size=")) {
      args.pageSize = Number(arg.slice("--page-size=".length));
    } else if (arg === "--max-pages") {
      args.maxPages = Number(rest[++index]);
    } else if (arg.startsWith("--max-pages=")) {
      args.maxPages = Number(arg.slice("--max-pages=".length));
    } else if (arg === "--expect-smoke-space-item") {
      args.expectSmokeSpaceItem = true;
    } else if (arg === "--exercise-section-mutations") {
      args.exerciseSectionMutations = true;
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
  if (env.GOOGLE_CHAT_SECTIONS_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_SECTIONS_SMOKE_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `sections-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function sectionsUrl({ pageSize, pageToken = null }) {
  const url = new URL("https://chat.googleapis.com/v1/users/me/sections");
  url.searchParams.set("pageSize", String(pageSize));
  if (pageToken) {
    url.searchParams.set("pageToken", pageToken);
  }
  return url.toString();
}

function sectionItemsUrl({ pageSize, space, pageToken = null }) {
  const url = new URL("https://chat.googleapis.com/v1/users/me/sections/-/items");
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("filter", `space = ${space}`);
  if (pageToken) {
    url.searchParams.set("pageToken", pageToken);
  }
  return url.toString();
}

function createSectionUrl() {
  return "https://chat.googleapis.com/v1/users/me/sections";
}

function sectionUrl(sectionName) {
  return `https://chat.googleapis.com/v1/${sectionName}`;
}

function patchSectionUrl(sectionName) {
  const url = new URL(sectionUrl(sectionName));
  url.searchParams.set("updateMask", "displayName");
  return url.toString();
}

function positionSectionUrl(sectionName) {
  return `${sectionUrl(sectionName)}:position`;
}

function moveSectionItemUrl(sectionItemName) {
  return `https://chat.googleapis.com/v1/${sectionItemName}:move`;
}

function parentSectionNameFromItemName(itemName) {
  if (typeof itemName !== "string") {
    return null;
  }
  const marker = "/items/";
  const index = itemName.indexOf(marker);
  return index === -1 ? null : itemName.slice(0, index);
}

function readRequestInit() {
  return {
    method: "GET",
    idempotent: true,
  };
}

function createSectionInit(displayName) {
  return {
    method: "POST",
    idempotent: false,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      displayName,
      type: "CUSTOM_SECTION",
    }),
  };
}

function patchSectionInit(sectionName, displayName) {
  return {
    method: "PATCH",
    idempotent: true,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: sectionName,
      displayName,
    }),
  };
}

function positionSectionInit() {
  return {
    method: "POST",
    idempotent: true,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      relativePosition: "END",
    }),
  };
}

function moveSectionItemInit(targetSection) {
  return {
    method: "POST",
    idempotent: false,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      targetSection,
    }),
  };
}

function deleteSectionInit() {
  return {
    method: "DELETE",
    idempotent: false,
  };
}

function safeResponseKeys(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return [];
  }
  return Object.keys(json).sort();
}

function summarizeSection(section) {
  const name = typeof section?.name === "string" ? section.name : null;
  const displayName =
    typeof section?.displayName === "string" ? section.displayName : null;
  return {
    nameHash: name ? stableHash(name) : null,
    displayNameHash: displayName ? stableHash(displayName) : null,
    displayNameAvailable: Boolean(displayName),
    type: typeof section?.type === "string" ? section.type : null,
    sortOrderAvailable: Number.isInteger(section?.sortOrder),
  };
}

function summarizeSectionItem(item, smokeSpace) {
  const name = typeof item?.name === "string" ? item.name : null;
  const section = parentSectionNameFromItemName(name);
  const space = typeof item?.space === "string" ? item.space : null;
  return {
    nameHash: name ? stableHash(name) : null,
    sectionHash: section ? stableHash(section) : null,
    spaceHash: space ? stableHash(space) : null,
    matchesSmokeSpace: space === smokeSpace,
  };
}

function blockedReason(result) {
  const json = result.json && typeof result.json === "object" ? result.json : {};
  if (result.status === 401) {
    return "auth_failed_after_refresh";
  }
  if (result.status === 403) {
    return "permission_or_sections_access_denied";
  }
  if (result.status === 404) {
    return "not_found_or_not_enabled";
  }
  return json.error?.status ?? `http_${result.status}`;
}

function summarizeApiResult({
  operation,
  result,
  allowBlocked,
  smokeSpace,
  pageIndex = 0,
  pageToken = null,
}) {
  const json = result.json && typeof result.json === "object" ? result.json : {};
  const blocked = !result.ok;
  const list =
    operation === "sections.list"
      ? (Array.isArray(json.sections) ? json.sections : [])
      : (Array.isArray(json.sectionItems) ? json.sectionItems : []);

  return {
    operation,
    method: "GET",
    authPrincipal: "user",
    scopes: SECTIONS_READ_SCOPES,
    pageIndex,
    pageTokenHash: pageToken ? stableHash(pageToken) : null,
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
    response: result.ok
      ? {
          responseKeys: safeResponseKeys(json),
          resultCount: list.length,
          hasNextPageToken:
            typeof json.nextPageToken === "string" && json.nextPageToken.length > 0,
          sections:
            operation === "sections.list" ? list.map(summarizeSection) : [],
          sectionItems:
            operation === "sections.items.list"
              ? list.map((item) => summarizeSectionItem(item, smokeSpace))
              : [],
        }
      : null,
    responseHeaders: result.headers ?? {},
  };
}

function summarizeAuthRequired(operation, error, allowBlocked) {
  return {
    operation,
    method: "GET",
    authPrincipal: "user",
    scopes: SECTIONS_READ_SCOPES,
    pageIndex: 0,
    pageTokenHash: null,
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

function sectionMutationMeta(operation) {
  if (operation.startsWith("sections.items.list")) {
    return {
      method: "GET",
      pathTemplate: "/v1/{parent=users/*/sections/*}/items",
      docsUrl:
        "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.sections.items/list",
      scopes: SECTIONS_READ_SCOPES,
      write: false,
    };
  }
  if (operation.startsWith("sections.create")) {
    return {
      method: "POST",
      pathTemplate: "/v1/{parent=users/*}/sections",
      docsUrl:
        "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.sections/create",
      scopes: SECTIONS_WRITE_SCOPES,
      write: true,
    };
  }
  if (operation.startsWith("sections.patch")) {
    return {
      method: "PATCH",
      pathTemplate:
        "/v1/{section.name=users/*/sections/*}?updateMask=displayName",
      docsUrl:
        "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.sections/patch",
      scopes: SECTIONS_WRITE_SCOPES,
      write: true,
    };
  }
  if (operation.startsWith("sections.position")) {
    return {
      method: "POST",
      pathTemplate: "/v1/{name=users/*/sections/*}:position",
      docsUrl:
        "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.sections/position",
      scopes: SECTIONS_WRITE_SCOPES,
      write: true,
    };
  }
  if (operation.startsWith("sections.items.move")) {
    return {
      method: "POST",
      pathTemplate: "/v1/{name=users/*/sections/*/items/*}:move",
      docsUrl:
        "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.sections.items/move",
      scopes: SECTIONS_WRITE_SCOPES,
      write: true,
    };
  }
  if (operation.startsWith("sections.delete")) {
    return {
      method: "DELETE",
      pathTemplate: "/v1/{section.name=users/*/sections/*}",
      docsUrl:
        "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.sections/delete",
      scopes: SECTIONS_WRITE_SCOPES,
      write: true,
    };
  }
  throw new Error(`Unsupported sections mutation operation ${operation}.`);
}

function responseSection(json) {
  if (json?.section && typeof json.section === "object") {
    return json.section;
  }
  return json && typeof json === "object" && !Array.isArray(json) ? json : {};
}

function responseSectionItem(json) {
  if (json?.sectionItem && typeof json.sectionItem === "object") {
    return json.sectionItem;
  }
  if (json?.item && typeof json.item === "object") {
    return json.item;
  }
  return json && typeof json === "object" && !Array.isArray(json) ? json : {};
}

function summarizeSectionStepResponse(operation, json, smokeSpace) {
  if (operation.startsWith("sections.items.list")) {
    const items = Array.isArray(json.sectionItems) ? json.sectionItems : [];
    return {
      responseKeys: safeResponseKeys(json),
      resultCount: items.length,
      hasNextPageToken:
        typeof json.nextPageToken === "string" && json.nextPageToken.length > 0,
      sectionItems: items.map((item) => summarizeSectionItem(item, smokeSpace)),
    };
  }
  if (operation.startsWith("sections.items.move")) {
    return {
      responseKeys: safeResponseKeys(json),
      sectionItem: summarizeSectionItem(responseSectionItem(json), smokeSpace),
    };
  }
  if (operation.startsWith("sections.delete")) {
    return {
      responseKeys: safeResponseKeys(json),
    };
  }
  return {
    responseKeys: safeResponseKeys(json),
    section: summarizeSection(responseSection(json)),
  };
}

function summarizeSectionStep({ operation, result, allowBlocked, smokeSpace }) {
  const json = result.json && typeof result.json === "object" ? result.json : {};
  const meta = sectionMutationMeta(operation);
  const blocked = !result.ok;
  const summary = {
    operation,
    method: meta.method,
    pathTemplate: meta.pathTemplate,
    docsUrl: meta.docsUrl,
    authPrincipal: "user",
    scopes: meta.scopes,
    write: meta.write,
    pageIndex: 0,
    pageTokenHash: null,
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
    response: result.ok
      ? summarizeSectionStepResponse(operation, json, smokeSpace)
      : null,
    responseHeaders: result.headers ?? {},
  };
  Object.defineProperty(summary, "rawJson", {
    value: json,
    enumerable: false,
  });
  return summary;
}

function summarizeSectionStepAuthRequired(operation, error, allowBlocked) {
  const meta = sectionMutationMeta(operation);
  return {
    operation,
    method: meta.method,
    pathTemplate: meta.pathTemplate,
    docsUrl: meta.docsUrl,
    authPrincipal: "user",
    scopes: meta.scopes,
    write: meta.write,
    pageIndex: 0,
    pageTokenHash: null,
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

function makeTemporarySectionDisplayName(config, suffix = "") {
  const runSlug = String(config.runId)
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 30);
  return `GCAI SDK Smoke ${runSlug}${suffix}`;
}

function makeSkippedSectionMutationResult({
  reason,
  allowBlocked,
  before = null,
  create = null,
  patch = null,
  position = null,
  moveToTemporary = null,
  moveRestore = null,
  afterRestore = null,
  cleanupDelete = null,
}) {
  return {
    surface: "users.sections reversible custom-section mutation",
    authPrincipal: "user",
    scopes: SECTIONS_WRITE_SCOPES,
    write: true,
    reversible: true,
    explicitWriteGate: SECTIONS_WRITE_GATE,
    ok: false,
    blocked: true,
    allowedBlocked: allowBlocked,
    blockedReason: reason,
    before,
    create,
    patch,
    position,
    moveToTemporary,
    moveRestore,
    afterRestore,
    cleanupDelete,
    temporarySectionCreated: Boolean(create?.ok),
    temporarySectionDeleted: Boolean(cleanupDelete?.ok),
    smokeSpaceMoved: Boolean(moveToTemporary?.ok),
    smokeSpaceRestoredToOriginalSection: false,
  };
}

async function callSectionStep({
  operation,
  oauthClient,
  tokenStorePath,
  scopes,
  url,
  init,
  allowBlocked,
  smokeSpace,
  chatRequestWithUserAuthImpl,
}) {
  try {
    const result = await chatRequestWithUserAuthImpl({
      oauthClient,
      tokenStorePath,
      scopes,
      url,
      init,
    });
    return summarizeSectionStep({
      operation,
      result,
      allowBlocked,
      smokeSpace,
    });
  } catch (error) {
    if (error instanceof UserAuthRequiredError) {
      return summarizeSectionStepAuthRequired(operation, error, allowBlocked);
    }
    throw error;
  }
}

function firstSmokeSectionItem(sectionItems, smokeSpace) {
  return sectionItems.find((item) => item?.space === smokeSpace) ?? null;
}

async function readPaginatedOperation({
  operation,
  config,
  oauthClient,
  chatRequestWithUserAuthImpl,
}) {
  const results = [];
  let pageToken = null;

  for (let pageIndex = 0; pageIndex < config.maxPages; pageIndex += 1) {
    const url =
      operation === "sections.list"
        ? sectionsUrl({ pageSize: config.pageSize, pageToken })
        : sectionItemsUrl({
            pageSize: config.pageSize,
            pageToken,
            space: config.space,
          });
    try {
      const result = await chatRequestWithUserAuthImpl({
        oauthClient,
        tokenStorePath: config.userAuth.tokenStorePath,
        scopes: SECTIONS_READ_SCOPES,
        url,
        init: readRequestInit(),
      });
      const summary = summarizeApiResult({
        operation,
        result,
        allowBlocked: config.allowBlocked,
        smokeSpace: config.space,
        pageIndex,
        pageToken,
      });
      results.push(summary);
      if (!result.ok) {
        break;
      }
      const nextPageToken =
        typeof result.json?.nextPageToken === "string" &&
        result.json.nextPageToken.length > 0
          ? result.json.nextPageToken
          : null;
      if (!nextPageToken) {
        break;
      }
      pageToken = nextPageToken;
    } catch (error) {
      if (error instanceof UserAuthRequiredError) {
        results.push(summarizeAuthRequired(operation, error, config.allowBlocked));
        break;
      }
      throw error;
    }
  }

  return results;
}

async function exerciseSectionMutations({
  config,
  oauthClient,
  chatRequestWithUserAuthImpl,
}) {
  let before = null;
  let create = null;
  let patch = null;
  let position = null;
  let moveToTemporary = null;
  let moveRestore = null;
  let afterRestore = null;
  let cleanupDelete = null;
  let createdSectionName = null;
  let movedItemName = null;
  let originalSectionName = null;
  let originalSectionHash = null;

  const tokenStorePath = config.userAuth.tokenStorePath;
  const beforeResult = await callSectionStep({
    operation: "sections.items.list.beforeMutation",
    oauthClient,
    tokenStorePath,
    scopes: SECTIONS_READ_SCOPES,
    url: sectionItemsUrl({ pageSize: config.pageSize, space: config.space }),
    init: readRequestInit(),
    allowBlocked: config.allowBlocked,
    smokeSpace: config.space,
    chatRequestWithUserAuthImpl,
  });
  before = beforeResult;

  if (!before.ok) {
    return makeSkippedSectionMutationResult({
      reason: before.blockedReason ?? "before_items_list_failed",
      allowBlocked: config.allowBlocked,
      before,
    });
  }

  const rawBeforeItems = Array.isArray(beforeResult.rawJson?.sectionItems)
    ? beforeResult.rawJson.sectionItems
    : [];
  const smokeItem = firstSmokeSectionItem(
    rawBeforeItems,
    config.space,
  );

  if (!smokeItem?.name) {
    return makeSkippedSectionMutationResult({
      reason:
        rawBeforeItems.length === 0
          ? "smoke_space_section_item_not_found"
          : "smoke_space_section_item_name_missing",
      allowBlocked: config.allowBlocked,
      before,
    });
  }

  originalSectionName = parentSectionNameFromItemName(smokeItem.name);
  if (!originalSectionName) {
    return makeSkippedSectionMutationResult({
      reason: "original_section_name_unparseable",
      allowBlocked: config.allowBlocked,
      before,
    });
  }
  originalSectionHash = stableHash(originalSectionName);

  const createDisplayName = makeTemporarySectionDisplayName(config);
  create = await callSectionStep({
    operation: "sections.create.temporary",
    oauthClient,
    tokenStorePath,
    scopes: SECTIONS_WRITE_SCOPES,
    url: createSectionUrl(),
    init: createSectionInit(createDisplayName),
    allowBlocked: config.allowBlocked,
    smokeSpace: config.space,
    chatRequestWithUserAuthImpl,
  });
  createdSectionName =
    typeof responseSection(create?.rawJson).name === "string"
      ? responseSection(create.rawJson).name
      : null;
  if (!createdSectionName) {
    let rawCreateResult = null;
    if (create?.ok) {
      try {
        rawCreateResult = await chatRequestWithUserAuthImpl({
          oauthClient,
          tokenStorePath,
          scopes: SECTIONS_READ_SCOPES,
          url: sectionsUrl({ pageSize: config.pageSize }),
          init: readRequestInit(),
        });
      } catch (error) {
        if (!(error instanceof UserAuthRequiredError)) {
          throw error;
        }
      }
    }
    createdSectionName =
      rawCreateResult?.json?.sections?.find?.(
        (section) => section.displayName === createDisplayName,
      )?.name ?? null;
  }

  if (!create.ok || !createdSectionName) {
    return makeSkippedSectionMutationResult({
      reason: create.blockedReason ?? "temporary_section_create_failed",
      allowBlocked: config.allowBlocked,
      before,
      create,
    });
  }

  const renamedDisplayName = makeTemporarySectionDisplayName(config, " Renamed");
  patch = await callSectionStep({
    operation: "sections.patch.temporaryDisplayName",
    oauthClient,
    tokenStorePath,
    scopes: SECTIONS_WRITE_SCOPES,
    url: patchSectionUrl(createdSectionName),
    init: patchSectionInit(createdSectionName, renamedDisplayName),
    allowBlocked: config.allowBlocked,
    smokeSpace: config.space,
    chatRequestWithUserAuthImpl,
  });

  position = patch.ok
    ? await callSectionStep({
        operation: "sections.position.temporaryEnd",
        oauthClient,
        tokenStorePath,
        scopes: SECTIONS_WRITE_SCOPES,
        url: positionSectionUrl(createdSectionName),
        init: positionSectionInit(),
        allowBlocked: config.allowBlocked,
        smokeSpace: config.space,
        chatRequestWithUserAuthImpl,
      })
    : null;

  if (position?.ok) {
    moveToTemporary = await callSectionStep({
      operation: "sections.items.move.toTemporarySection",
      oauthClient,
      tokenStorePath,
      scopes: SECTIONS_WRITE_SCOPES,
      url: moveSectionItemUrl(smokeItem.name),
      init: moveSectionItemInit(createdSectionName),
      allowBlocked: config.allowBlocked,
      smokeSpace: config.space,
      chatRequestWithUserAuthImpl,
    });
    movedItemName =
      typeof responseSectionItem(moveToTemporary?.rawJson)?.name === "string"
        ? responseSectionItem(moveToTemporary.rawJson).name
        : null;
  }

  if (moveToTemporary?.ok) {
    const itemNameForRestore = movedItemName ?? smokeItem.name;
    moveRestore = await callSectionStep({
      operation: "sections.items.move.restoreOriginalSection",
      oauthClient,
      tokenStorePath,
      scopes: SECTIONS_WRITE_SCOPES,
      url: moveSectionItemUrl(itemNameForRestore),
      init: moveSectionItemInit(originalSectionName),
      allowBlocked: config.allowBlocked,
      smokeSpace: config.space,
      chatRequestWithUserAuthImpl,
    });
  }

  if (moveRestore?.ok) {
    afterRestore = await callSectionStep({
      operation: "sections.items.list.afterRestore",
      oauthClient,
      tokenStorePath,
      scopes: SECTIONS_READ_SCOPES,
      url: sectionItemsUrl({ pageSize: config.pageSize, space: config.space }),
      init: readRequestInit(),
      allowBlocked: config.allowBlocked,
      smokeSpace: config.space,
      chatRequestWithUserAuthImpl,
    });
  }

  if (createdSectionName) {
    cleanupDelete = await callSectionStep({
      operation: "sections.delete.temporary",
      oauthClient,
      tokenStorePath,
      scopes: SECTIONS_WRITE_SCOPES,
      url: sectionUrl(createdSectionName),
      init: deleteSectionInit(),
      allowBlocked: config.allowBlocked,
      smokeSpace: config.space,
      chatRequestWithUserAuthImpl,
    });
  }

  const afterItems = afterRestore?.response?.sectionItems ?? [];
  const restoredItem =
    afterItems.find((item) => item.matchesSmokeSpace) ?? null;
  const smokeSpaceRestoredToOriginalSection =
    restoredItem?.sectionHash === originalSectionHash;
  const temporarySectionDeleted = Boolean(cleanupDelete?.ok);
  const blocked = [
    create,
    patch,
    position,
    moveToTemporary,
    moveRestore,
    afterRestore,
    cleanupDelete,
  ].some((step) => step?.blocked || step?.ok === false);
  const ok =
    Boolean(create?.ok) &&
    Boolean(patch?.ok) &&
    Boolean(position?.ok) &&
    Boolean(moveToTemporary?.ok) &&
    Boolean(moveRestore?.ok) &&
    Boolean(afterRestore?.ok) &&
    temporarySectionDeleted &&
    smokeSpaceRestoredToOriginalSection;

  if (!ok) {
    return makeSkippedSectionMutationResult({
      reason: blocked
        ? "section_mutation_or_restore_blocked"
        : "section_mutation_restore_verification_failed",
      allowBlocked: config.allowBlocked,
      before,
      create,
      patch,
      position,
      moveToTemporary,
      moveRestore,
      afterRestore,
      cleanupDelete,
    });
  }

  return {
    surface: "users.sections reversible custom-section mutation",
    authPrincipal: "user",
    scopes: SECTIONS_WRITE_SCOPES,
    write: true,
    reversible: true,
    explicitWriteGate: SECTIONS_WRITE_GATE,
    ok: true,
    blocked: false,
    allowedBlocked: false,
    blockedReason: null,
    before,
    create,
    patch,
    position,
    moveToTemporary,
    moveRestore,
    afterRestore,
    cleanupDelete,
    originalSectionHash,
    temporarySectionCreated: true,
    temporarySectionDeleted,
    smokeSpaceMoved: true,
    smokeSpaceRestoredToOriginalSection,
  };
}

export async function loadSectionsSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    return { help: true };
  }
  if (!args.dryRun && env.RUN_LIVE_CHAT_SECTIONS_SMOKE !== "1") {
    throw new ChatSectionsSmokeError(
      "Refusing to run sections Chat smoke without RUN_LIVE_CHAT_SECTIONS_SMOKE=1.",
      { envVar: "RUN_LIVE_CHAT_SECTIONS_SMOKE" },
    );
  }
  if (
    args.exerciseSectionMutations &&
    !args.dryRun &&
    env[SECTIONS_WRITE_GATE] !== "1"
  ) {
    throw new ChatSectionsSmokeError(
      `Refusing to mutate user Chat sidebar sections without ${SECTIONS_WRITE_GATE}=1.`,
      { envVar: SECTIONS_WRITE_GATE },
    );
  }

  requirePositiveInteger(args.pageSize, "--page-size");
  if (args.pageSize > 100) {
    throw new Error("--page-size must be <= 100.");
  }
  requirePositiveInteger(args.maxPages, "--max-pages");
  if (args.maxPages > 20) {
    throw new Error("--max-pages must be <= 20.");
  }

  const metadataPath =
    resolvePath(args.metadataPath || env.GOOGLE_CHAT_SMOKE_METADATA, cwd) ??
    defaultMetadataPath;
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  const expectedSpace = env.GOOGLE_CHAT_TEST_SPACE ?? metadata.space;
  requireSmokeMetadata(metadata, expectedSpace);

  const runId = makeRunId(env);
  const evidencePath =
    resolvePath(args.evidencePath, cwd) ??
    path.join(defaultEvidenceDir, `chat-sections-smoke-${runId}.json`);

  return {
    help: false,
    dryRun: args.dryRun,
    allowBlocked: args.allowBlocked,
    runId,
    pageSize: args.pageSize,
    maxPages: args.maxPages,
    expectSmokeSpaceItem: args.expectSmokeSpaceItem,
    exerciseSectionMutations: args.exerciseSectionMutations,
    metadataPath,
    evidencePath,
    space: metadata.space,
    spaceHash: stableHash(metadata.space),
    displayNameHash: stableHash(metadata.displayName),
    userAuth: resolveUserAuthConfig(env, {}),
  };
}

function plan(config) {
  const readPlan = [
    {
      operation: "sections.list",
      method: "GET",
      pathTemplate: "/v1/{parent=users/*}/sections",
      docsUrl:
        "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.sections/list",
      authPrincipal: "user",
      scopes: SECTIONS_READ_SCOPES,
      write: false,
    },
    {
      operation: "sections.items.list",
      method: "GET",
      pathTemplate: "/v1/{parent=users/*/sections/*}/items",
      docsUrl:
        "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.sections.items/list",
      authPrincipal: "user",
      scopes: SECTIONS_READ_SCOPES,
      filter: "space = <smoke-space>",
      write: false,
    },
  ];
  if (!config.exerciseSectionMutations) {
    return readPlan;
  }
  return [
    ...readPlan,
    {
      operation: "sections.create.temporary",
      method: "POST",
      pathTemplate: "/v1/{parent=users/*}/sections",
      docsUrl:
        "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.sections/create",
      authPrincipal: "user",
      scopes: SECTIONS_WRITE_SCOPES,
      write: true,
      reversible: true,
      explicitWriteGate: SECTIONS_WRITE_GATE,
      bodyFields: ["displayName", "type"],
    },
    {
      operation: "sections.patch.temporaryDisplayName",
      method: "PATCH",
      pathTemplate:
        "/v1/{section.name=users/*/sections/*}?updateMask=displayName",
      docsUrl:
        "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.sections/patch",
      authPrincipal: "user",
      scopes: SECTIONS_WRITE_SCOPES,
      write: true,
      reversible: true,
      explicitWriteGate: SECTIONS_WRITE_GATE,
      updateMask: "displayName",
    },
    {
      operation: "sections.position.temporaryEnd",
      method: "POST",
      pathTemplate: "/v1/{name=users/*/sections/*}:position",
      docsUrl:
        "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.sections/position",
      authPrincipal: "user",
      scopes: SECTIONS_WRITE_SCOPES,
      write: true,
      reversible: true,
      explicitWriteGate: SECTIONS_WRITE_GATE,
      relativePosition: "END",
    },
    {
      operation: "sections.items.move.toTemporarySection",
      method: "POST",
      pathTemplate: "/v1/{name=users/*/sections/*/items/*}:move",
      docsUrl:
        "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.sections.items/move",
      authPrincipal: "user",
      scopes: SECTIONS_WRITE_SCOPES,
      write: true,
      reversible: true,
      explicitWriteGate: SECTIONS_WRITE_GATE,
      targetSection: "<temporary-section>",
    },
    {
      operation: "sections.items.move.restoreOriginalSection",
      method: "POST",
      pathTemplate: "/v1/{name=users/*/sections/*/items/*}:move",
      docsUrl:
        "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.sections.items/move",
      authPrincipal: "user",
      scopes: SECTIONS_WRITE_SCOPES,
      write: true,
      reversible: true,
      explicitWriteGate: SECTIONS_WRITE_GATE,
      targetSection: "<original-section>",
    },
    {
      operation: "sections.delete.temporary",
      method: "DELETE",
      pathTemplate: "/v1/{section.name=users/*/sections/*}",
      docsUrl:
        "https://developers.google.com/workspace/chat/api/reference/rest/v1/users.sections/delete",
      authPrincipal: "user",
      scopes: SECTIONS_WRITE_SCOPES,
      write: true,
      reversible: true,
      explicitWriteGate: SECTIONS_WRITE_GATE,
    },
  ];
}

export async function runSectionsSmoke(
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
  const smokePlan = plan(config);

  if (config.dryRun) {
    return {
      ok: true,
      mode: "sections-smoke",
      status: "dry_run",
      runId: config.runId,
      generatedAt,
      spaceHash: config.spaceHash,
      displayNameHash: config.displayNameHash,
      pageSize: config.pageSize,
      maxPages: config.maxPages,
      plan: smokePlan,
      privacy: privacySummary(),
    };
  }

  const credentialsPath = path.isAbsolute(config.userAuth.credentialsPath)
    ? config.userAuth.credentialsPath
    : path.resolve(config.userAuth.credentialsPath);
  const rawClient = await readFile(credentialsPath, "utf8");
  const oauthClient = readOAuthClientConfigImpl(rawClient);

  const results = [];
  for (const operation of ["sections.list", "sections.items.list"]) {
    results.push(
      ...(await readPaginatedOperation({
        operation,
        config,
        oauthClient,
        chatRequestWithUserAuthImpl,
      })),
    );
  }

  const mutationResults = [];
  if (config.exerciseSectionMutations) {
    mutationResults.push(
      await exerciseSectionMutations({
        config,
        oauthClient,
        chatRequestWithUserAuthImpl,
      }),
    );
  }

  const allResults = [...results, ...mutationResults];
  const blocked = allResults.filter((result) => result.blocked || !result.ok);
  const itemResults = results.filter(
    (result) => result.operation === "sections.items.list",
  );
  const smokeSpaceItemCount =
    itemResults.reduce(
      (count, result) =>
        count +
        (result.response?.sectionItems?.filter((item) => item.matchesSmokeSpace)
          .length ?? 0),
      0,
    );
  const paginationTruncated = results.some(
    (result) =>
      result.response?.hasNextPageToken === true &&
      result.pageIndex + 1 >= config.maxPages,
  );
  const expectationFailed =
    (config.expectSmokeSpaceItem && blocked.length === 0 && smokeSpaceItemCount < 1) ||
    paginationTruncated;
  const ok =
    !expectationFailed &&
    (blocked.length === 0 ||
      (config.allowBlocked &&
        blocked.length > 0 &&
        blocked.every((result) => result.allowedBlocked)));
  const evidence = {
    ok,
    mode: "sections-smoke",
    status:
      blocked.length > 0 ? "blocked" : expectationFailed ? "failed" : "verified",
    runId: config.runId,
    generatedAt,
    spaceHash: config.spaceHash,
    displayNameHash: config.displayNameHash,
    pageSize: config.pageSize,
    maxPages: config.maxPages,
    results,
    mutations: mutationResults,
    assertions: {
      smokeSpaceValidated: true,
      readOnlyOnly: smokePlan.every((entry) => entry.write === false),
      writesRequireExplicitGate: smokePlan
        .filter((entry) => entry.write)
        .every((entry) => entry.explicitWriteGate === SECTIONS_WRITE_GATE),
      reversibleMutationOnly: smokePlan
        .filter((entry) => entry.write)
        .every((entry) => entry.reversible === true),
      usedUserAuthOnly: smokePlan.every(
        (entry) => entry.authPrincipal === "user",
      ),
      noWebhookExpected: true,
      blockedAllowed: config.allowBlocked,
      allBlockedAllowed:
        blocked.length === 0 || blocked.every((result) => result.allowedBlocked),
      paginationTruncated,
      maxPagesRespected:
        results.length === 0 ||
        results.every((result) => result.pageIndex < config.maxPages),
      temporarySectionDeleted:
        mutationResults.length === 0 ||
        mutationResults.every(
          (result) =>
            result.temporarySectionCreated !== true ||
            result.temporarySectionDeleted === true,
        ),
      smokeSpaceRestoredToOriginalSection:
        mutationResults.length === 0 ||
        mutationResults.every(
          (result) =>
            result.smokeSpaceMoved !== true ||
            result.smokeSpaceRestoredToOriginalSection === true,
        ),
      smokeSpaceItemExpected: config.expectSmokeSpaceItem,
      smokeSpaceItemCount,
      smokeSpaceItemExpectationMet:
        !config.expectSmokeSpaceItem || smokeSpaceItemCount >= 1,
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
    savesRawSectionNames: false,
    savesRawSectionDisplayNames: false,
    savesRawSectionItemNames: false,
    savesRawTemporarySectionDisplayNames: false,
    savesRawOtherSpaceNames: false,
    savesRawMessageText: false,
    savesRawTokenMaterial: false,
    savesRawUserEmails: false,
  };
}

function printHelp() {
  console.log([
    "Usage: pnpm live:chat-sections-smoke [-- --dry-run] [-- --allow-blocked]",
    "",
    "Installed-user smoke for Chat sidebar sections/navigation.",
    "",
    "Environment:",
    "  RUN_LIVE_CHAT_SECTIONS_SMOKE=1  Required unless --dry-run is used.",
    `  ${SECTIONS_WRITE_GATE}=1  Required for --exercise-section-mutations.`,
    "  GOOGLE_CHAT_TEST_SPACE          Dedicated smoke space resource name.",
    "  GOOGLE_CHAT_SECTIONS_SMOKE_RUN_ID",
    "                                 Optional stable run id.",
    "",
    "Options:",
    "  --dry-run                   Print the read-only plan without API calls.",
    "  --allow-blocked             Save auth/scope/API failures as blocked evidence.",
    "  --metadata <path>           Smoke space metadata JSON.",
    "  --evidence <path>           Evidence output path.",
    "  --page-size <n>             Page size for list probes. Default: 10.",
    "  --max-pages <n>             Maximum list pages per operation. Default: 10.",
    "  --expect-smoke-space-item   Require the smoke space to be present in section items.",
    "  --exercise-section-mutations",
    "                               Create/rename/position/delete a temporary custom section and",
    "                               move the smoke-space item into it, then back to its original section.",
    "",
    "Authorize scopes centrally if needed:",
    "  pnpm chat:user-auth-smoke -- --authorize --read-sections --write-sections",
  ].join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadSectionsSmokeConfig()
    .then(async (config) => {
      if (config.help) {
        printHelp();
        return { ok: true };
      }
      return runSectionsSmoke(config);
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
