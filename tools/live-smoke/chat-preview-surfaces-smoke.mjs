import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SMOKE_SPACE_PREFIX } from "./chat-smoke.mjs";
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

const SURFACES = {
  messagesSearch: {
    key: "messagesSearch",
    label: "spaces.messages.search",
    docsUrl:
      "https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/search",
    method: "POST",
    pathTemplate: "/v1/{parent=spaces/*}/messages:search",
    scopes: ["https://www.googleapis.com/auth/chat.messages.readonly"],
    docsStatus: "developer_preview",
  },
  messagePinsList: {
    key: "messagePinsList",
    label: "spaces.messagePins.list",
    docsUrl:
      "https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messagePins/list",
    method: "GET",
    pathTemplate: "/v1/{parent=spaces/*}/messagePins",
    scopes: ["https://www.googleapis.com/auth/chat.spaces.readonly"],
    docsStatus: "docs_listed",
  },
};

class PreviewSurfaceSmokeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PreviewSurfaceSmokeError";
    this.details = details;
  }
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    allowBlocked: false,
    metadataPath: null,
    evidencePath: null,
    pageSize: 3,
    surfaces: [],
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
    } else if (arg === "--surface") {
      args.surfaces.push(rest[++index]);
    } else if (arg.startsWith("--surface=")) {
      args.surfaces.push(arg.slice("--surface=".length));
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
  if (env.GOOGLE_CHAT_PREVIEW_SURFACES_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_PREVIEW_SURFACES_SMOKE_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `preview-surfaces-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function selectedSurfaces(names) {
  if (names.length === 0) {
    return [SURFACES.messagesSearch, SURFACES.messagePinsList];
  }

  return names.map((name) => {
    const surface = SURFACES[name];
    if (!surface) {
      throw new Error(
        `Unknown surface ${name}. Expected one of: ${Object.keys(SURFACES).join(", ")}`,
      );
    }
    return surface;
  });
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

function buildSearchBody(space, pageSize) {
  return {
    filter: `space.name = "${space}"`,
    pageSize,
    orderBy: "createTime desc",
    view: "SEARCH_MESSAGES_VIEW_BASIC",
  };
}

function surfaceUrl(surface, space, pageSize) {
  if (surface.key === "messagesSearch") {
    return "https://chat.googleapis.com/v1/spaces/-/messages:search";
  }
  if (surface.key === "messagePinsList") {
    return `https://chat.googleapis.com/v1/${space}/messagePins?pageSize=${pageSize}`;
  }
  throw new Error(`Unsupported surface ${surface.key}.`);
}

function surfaceInit(surface, space, pageSize) {
  if (surface.key === "messagesSearch") {
    return {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildSearchBody(space, pageSize)),
      idempotent: true,
    };
  }
  return {
    method: "GET",
    idempotent: true,
  };
}

function resultItems(surface, json) {
  if (!json || typeof json !== "object") {
    return [];
  }
  if (surface.key === "messagesSearch") {
    return Array.isArray(json.results) ? json.results : [];
  }
  if (surface.key === "messagePinsList") {
    return Array.isArray(json.messagePins) ? json.messagePins : [];
  }
  return [];
}

function blockedReason(result) {
  const json = result.json && typeof result.json === "object" ? result.json : {};
  if (result.status === 404) {
    return "not_found_or_not_enabled";
  }
  if (result.status === 403) {
    return "permission_or_preview_access_denied";
  }
  return json.error?.status ?? `http_${result.status}`;
}

function summarizeResult(surface, result, allowBlocked) {
  const json = result.json && typeof result.json === "object" ? result.json : {};
  const items = resultItems(surface, json);
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
    resultCount: items.length,
    hasNextPageToken:
      typeof json.nextPageToken === "string" && json.nextPageToken.length > 0,
    responseHeaders: result.headers ?? {},
  };
}

export async function loadPreviewSurfacesSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    return { help: true };
  }
  if (!args.dryRun && env.RUN_LIVE_CHAT_PREVIEW_SURFACES_SMOKE !== "1") {
    throw new PreviewSurfaceSmokeError(
      "Refusing to run preview surface smoke without RUN_LIVE_CHAT_PREVIEW_SURFACES_SMOKE=1.",
      { envVar: "RUN_LIVE_CHAT_PREVIEW_SURFACES_SMOKE" },
    );
  }

  requirePositiveInteger(args.pageSize, "--page-size");
  if (args.pageSize > 100) {
    throw new Error("--page-size must be <= 100.");
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
    path.join(defaultEvidenceDir, `chat-preview-surfaces-smoke-${runId}.json`);

  return {
    help: false,
    dryRun: args.dryRun,
    allowBlocked: args.allowBlocked,
    runId,
    pageSize: args.pageSize,
    metadataPath,
    evidencePath,
    space: metadata.space,
    spaceHash: stableHash(metadata.space),
    displayNameHash: stableHash(metadata.displayName),
    surfaces: selectedSurfaces(args.surfaces),
    userAuth: resolveUserAuthConfig(env, {}),
  };
}

export async function runPreviewSurfacesSmoke(
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
  const plan = config.surfaces.map(surfacePlan);

  if (config.dryRun) {
    return {
      ok: true,
      mode: "preview-surfaces-smoke",
      status: "dry_run",
      runId: config.runId,
      generatedAt,
      spaceHash: config.spaceHash,
      displayNameHash: config.displayNameHash,
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
    const result = await chatRequestWithUserAuthImpl({
      oauthClient,
      tokenStorePath: config.userAuth.tokenStorePath,
      scopes: surface.scopes,
      url: surfaceUrl(surface, config.space, config.pageSize),
      init: surfaceInit(surface, config.space, config.pageSize),
    });
    surfaceResults.push(summarizeResult(surface, result, config.allowBlocked));
  }

  const blocked = surfaceResults.filter((result) => result.blocked);
  const ok = blocked.length === 0 || (config.allowBlocked && blocked.length > 0);
  const evidence = {
    ok,
    mode: "preview-surfaces-smoke",
    status: blocked.length > 0 ? "blocked" : "verified",
    runId: config.runId,
    generatedAt,
    spaceHash: config.spaceHash,
    displayNameHash: config.displayNameHash,
    pageSize: config.pageSize,
    surfaces: surfaceResults,
    assertions: {
      smokeSpaceValidated: true,
      readOnlyOnly: plan.every((surface) => surface.write === false),
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
    savesRawMessageNames: false,
    savesRawMessageText: false,
    savesRawPinNames: false,
    savesRawTokenMaterial: false,
    savesRawUserEmails: false,
  };
}

function printHelp() {
  console.log([
    "Usage: pnpm live:chat-preview-surfaces-smoke [-- --dry-run] [-- --allow-blocked]",
    "",
    "Read-only smoke for docs-listed Google Chat surfaces that can drift ahead of the discovery document.",
    "",
    "Environment:",
    "  RUN_LIVE_CHAT_PREVIEW_SURFACES_SMOKE=1  Required unless --dry-run is used.",
    "  GOOGLE_CHAT_TEST_SPACE                  Dedicated smoke space resource name.",
    "  GOOGLE_CHAT_PREVIEW_SURFACES_SMOKE_RUN_ID",
    "                                         Optional stable run id.",
    "",
    "Options:",
    "  --dry-run                 Print the read-only plan without API calls.",
    "  --allow-blocked           Save 403/404/5xx docs-listed surface failures as blocked evidence.",
    "  --metadata <path>         Smoke space metadata JSON.",
    "  --evidence <path>         Evidence output path.",
    "  --page-size <n>           Page size for read probes. Default: 3.",
    "  --surface <name>          messagesSearch or messagePinsList. Repeatable.",
  ].join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadPreviewSurfacesSmokeConfig()
    .then(async (config) => {
      if (config.help) {
        printHelp();
        return { ok: true };
      }
      return runPreviewSurfacesSmoke(config);
    })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    })
    .catch((error) => {
      if (error instanceof UserAuthRequiredError) {
        console.error(JSON.stringify({ ok: false, authRequired: error.details }, null, 2));
        process.exit(1);
      }
      console.error(error.stack ?? String(error));
      process.exit(1);
    });
}
