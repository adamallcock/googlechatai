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
const CUSTOM_EMOJI_SCOPES = USER_AUTH_SCOPES.readCustomEmojis;

class ChatCustomEmojisSmokeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ChatCustomEmojisSmokeError";
    this.details = details;
  }
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    allowBlocked: false,
    metadataPath: null,
    evidencePath: null,
    pageSize: 25,
    filter: null,
    exerciseGet: false,
    getName: null,
    expectEmojiName: null,
    expectMinCustomEmojis: null,
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
    } else if (arg === "--filter") {
      args.filter = rest[++index];
    } else if (arg.startsWith("--filter=")) {
      args.filter = arg.slice("--filter=".length);
    } else if (arg === "--exercise-get") {
      args.exerciseGet = true;
    } else if (arg === "--get-name") {
      args.getName = rest[++index];
      args.exerciseGet = true;
    } else if (arg.startsWith("--get-name=")) {
      args.getName = arg.slice("--get-name=".length);
      args.exerciseGet = true;
    } else if (arg === "--expect-emoji-name") {
      args.expectEmojiName = rest[++index];
    } else if (arg.startsWith("--expect-emoji-name=")) {
      args.expectEmojiName = arg.slice("--expect-emoji-name=".length);
    } else if (arg === "--created-by-me") {
      args.filter = 'creator("users/me")';
    } else if (arg === "--not-created-by-me") {
      args.filter = 'NOT creator("users/me")';
    } else if (arg === "--expect-min-custom-emojis") {
      args.expectMinCustomEmojis = Number(rest[++index]);
    } else if (arg.startsWith("--expect-min-custom-emojis=")) {
      args.expectMinCustomEmojis = Number(
        arg.slice("--expect-min-custom-emojis=".length),
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

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function requireNonNegativeIntegerOrNull(value, name) {
  if (value !== null && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

function normalizeExpectedEmojiName(value) {
  if (!value) {
    return null;
  }
  const trimmed = String(value).trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith(":") && trimmed.endsWith(":")
    ? trimmed
    : `:${trimmed.replace(/^:+|:+$/g, "")}:`;
}

function requireCustomEmojiResourceName(value, optionName) {
  if (!value) {
    return;
  }
  if (!/^customEmojis\/[^/]+$/.test(value)) {
    throw new Error(`${optionName} must match customEmojis/{customEmoji}.`);
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
  if (env.GOOGLE_CHAT_CUSTOM_EMOJIS_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_CUSTOM_EMOJIS_SMOKE_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `custom-emojis-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function buildCustomEmojisUrl({ pageSize, filter }) {
  const url = new URL("https://chat.googleapis.com/v1/customEmojis");
  url.searchParams.set("pageSize", String(pageSize));
  if (filter) {
    url.searchParams.set("filter", filter);
  }
  return url.toString();
}

function buildCustomEmojiGetUrl(name) {
  requireCustomEmojiResourceName(name, "custom emoji resource name");
  return `https://chat.googleapis.com/v1/${name}`;
}

function customEmojiSummary(customEmoji) {
  const name = typeof customEmoji.name === "string" ? customEmoji.name : null;
  const uid = typeof customEmoji.uid === "string" ? customEmoji.uid : null;
  const emojiName =
    typeof customEmoji.emojiName === "string" ? customEmoji.emojiName : null;
  const creator = customEmoji.creator ?? {};

  return {
    nameHash: name ? stableHash(name) : null,
    uidHash: uid ? stableHash(uid) : null,
    emojiNameHash: emojiName ? stableHash(emojiName) : null,
    hasTemporaryImageUri:
      typeof customEmoji.temporaryImageUri === "string" &&
      customEmoji.temporaryImageUri.length > 0,
    creator: {
      type: typeof creator.type === "string" ? creator.type : null,
      nameHash:
        typeof creator.name === "string" ? stableHash(creator.name) : null,
      displayNameAvailable: typeof creator.displayName === "string",
      emailAvailable: typeof creator.email === "string",
    },
  };
}

function selectCustomEmojiForGet(customEmojis, { getName, expectEmojiName }) {
  if (getName) {
    return customEmojis.find((customEmoji) => customEmoji.name === getName) ?? null;
  }
  if (expectEmojiName) {
    return (
      customEmojis.find((customEmoji) => {
        const emojiName =
          typeof customEmoji.emojiName === "string"
            ? normalizeExpectedEmojiName(customEmoji.emojiName)
            : null;
        return emojiName === expectEmojiName;
      }) ?? null
    );
  }
  return customEmojis.find((customEmoji) => typeof customEmoji.name === "string") ?? null;
}

function summarizeFailure(result) {
  const json = result.json && typeof result.json === "object" ? result.json : {};
  if (result.status === 403) {
    return "permission_or_custom_emoji_disabled";
  }
  if (result.status === 404) {
    return "not_found_or_not_enabled";
  }
  return json.error?.status ?? `http_${result.status}`;
}

export async function loadCustomEmojisSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    return { help: true };
  }
  if (!args.dryRun && env.RUN_LIVE_CHAT_CUSTOM_EMOJIS_SMOKE !== "1") {
    throw new ChatCustomEmojisSmokeError(
      "Refusing to run custom emojis Chat smoke without RUN_LIVE_CHAT_CUSTOM_EMOJIS_SMOKE=1.",
      { envVar: "RUN_LIVE_CHAT_CUSTOM_EMOJIS_SMOKE" },
    );
  }

  requirePositiveInteger(args.pageSize, "--page-size");
  if (args.pageSize > 200) {
    throw new Error("--page-size must be <= 200.");
  }
  requireNonNegativeIntegerOrNull(
    args.expectMinCustomEmojis,
    "--expect-min-custom-emojis",
  );
  requireCustomEmojiResourceName(args.getName, "--get-name");
  const expectEmojiName = normalizeExpectedEmojiName(args.expectEmojiName);
  if (args.expectEmojiName && !expectEmojiName) {
    throw new Error("--expect-emoji-name must not be blank.");
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
    path.join(defaultEvidenceDir, `chat-custom-emojis-smoke-${runId}.json`);

  return {
    help: false,
    dryRun: args.dryRun,
    allowBlocked: args.allowBlocked,
    runId,
    pageSize: args.pageSize,
    filter: args.filter,
    exerciseGet: args.exerciseGet,
    getName: args.getName,
    expectEmojiName,
    expectMinCustomEmojis: args.expectMinCustomEmojis,
    metadataPath,
    evidencePath,
    spaceHash: stableHash(metadata.space),
    displayNameHash: stableHash(metadata.displayName),
    userAuth: resolveUserAuthConfig(env, {}),
  };
}

export function buildCustomEmojisSmokePlan(config) {
  return {
    mode: "dry-run",
    runId: config.runId,
    authPrincipal: "user",
    operation: "customEmojis.list",
    followUpOperation: config.exerciseGet ? "customEmojis.get" : null,
    method: "GET",
    urlTemplate: "https://chat.googleapis.com/v1/customEmojis",
    requiredScopes: CUSTOM_EMOJI_SCOPES,
    query: {
      pageSize: config.pageSize,
      filter: config.filter,
      exerciseGet: config.exerciseGet,
      getNameHash: config.getName ? stableHash(config.getName) : null,
      expectEmojiNameHash: config.expectEmojiName
        ? stableHash(config.expectEmojiName)
        : null,
    },
    writes: false,
    scope: "workspace-visible custom emoji metadata",
    evidence: {
      savesRawCustomEmojiNames: false,
      savesRawEmojiNames: false,
      savesRawImageUris: false,
      savesRawCreatorNames: false,
      savesRawCreatorEmails: false,
      savesRawAccessTokens: false,
    },
  };
}

export async function runCustomEmojisSmoke(
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
  const plan = buildCustomEmojisSmokePlan(config);

  if (config.dryRun) {
    return {
      ok: true,
      mode: "custom-emojis-smoke",
      status: "dry_run",
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
  let result;
  let authRequired = null;
  try {
    result = await chatRequestWithUserAuthImpl({
      oauthClient,
      tokenStorePath: config.userAuth.tokenStorePath,
      scopes: CUSTOM_EMOJI_SCOPES,
      url: buildCustomEmojisUrl(config),
      init: {
        method: "GET",
        idempotent: true,
      },
    });
  } catch (error) {
    if (!(error instanceof UserAuthRequiredError) || !config.allowBlocked) {
      throw error;
    }
    authRequired = error.details ?? {};
    result = {
      ok: false,
      status: null,
      attempts: 0,
      refreshed: false,
      replayedAfter401: false,
      retryDecisions: [],
      json: {},
    };
  }

  const blocked = !result.ok;
  const json = result.json && typeof result.json === "object" ? result.json : {};
  const customEmojis = Array.isArray(json.customEmojis) ? json.customEmojis : [];
  const customEmojiCount = customEmojis.length;
  const selectedForGet = config.exerciseGet
    ? selectCustomEmojiForGet(customEmojis, {
        getName: config.getName,
        expectEmojiName: config.expectEmojiName,
      })
    : null;
  let getResult = null;
  if (result.ok && config.exerciseGet && selectedForGet?.name) {
    getResult = await chatRequestWithUserAuthImpl({
      oauthClient,
      tokenStorePath: config.userAuth.tokenStorePath,
      scopes: CUSTOM_EMOJI_SCOPES,
      url: buildCustomEmojiGetUrl(selectedForGet.name),
      init: {
        method: "GET",
        idempotent: true,
      },
    });
  }
  const expectedMinMatches =
    config.expectMinCustomEmojis === null ||
    customEmojiCount >= config.expectMinCustomEmojis;
  const expectedEmojiNameMatches =
    config.expectEmojiName === null ||
    customEmojis.some((customEmoji) => {
      const emojiName =
        typeof customEmoji.emojiName === "string"
          ? normalizeExpectedEmojiName(customEmoji.emojiName)
          : null;
      return emojiName === config.expectEmojiName;
    });
  const selectedGetTargetAvailable =
    !config.exerciseGet || Boolean(selectedForGet?.name);
  const getVerified = !config.exerciseGet || Boolean(getResult?.ok);
  const ok =
    (result.ok &&
      expectedMinMatches &&
      expectedEmojiNameMatches &&
      selectedGetTargetAvailable &&
      getVerified) ||
    (blocked && config.allowBlocked && config.expectMinCustomEmojis === null);
  const getJson =
    getResult?.json && typeof getResult.json === "object" ? getResult.json : {};
  const getBlocked = Boolean(getResult && !getResult.ok);
  const getReturnedSummary = getResult?.ok ? customEmojiSummary(getJson) : null;
  const selectedSummary = selectedForGet ? customEmojiSummary(selectedForGet) : null;
  const getNameMatchesList =
    !config.exerciseGet ||
    (selectedSummary?.nameHash !== null &&
      selectedSummary?.nameHash === getReturnedSummary?.nameHash);
  const getEmojiNameMatchesList =
    !config.exerciseGet ||
    (selectedSummary?.emojiNameHash !== null &&
      selectedSummary?.emojiNameHash === getReturnedSummary?.emojiNameHash);
  const evidence = {
    ok,
    mode: "custom-emojis-smoke",
    status: blocked ? "blocked" : "verified",
    runId: config.runId,
    generatedAt,
    spaceHash: config.spaceHash,
    displayNameHash: config.displayNameHash,
    request: {
      operation: "customEmojis.list",
      followUpOperation: config.exerciseGet ? "customEmojis.get" : null,
      authPrincipal: "user",
      scopes: CUSTOM_EMOJI_SCOPES,
      pageSize: config.pageSize,
      filter: config.filter,
      exerciseGet: config.exerciseGet,
      getNameHash: config.getName ? stableHash(config.getName) : null,
      expectEmojiNameHash: config.expectEmojiName
        ? stableHash(config.expectEmojiName)
        : null,
    },
    response: {
      status: result.status,
      attempts: result.attempts,
      refreshed: Boolean(result.refreshed),
      replayedAfter401: Boolean(result.replayedAfter401),
      retryDecisionCount: Array.isArray(result.retryDecisions)
        ? result.retryDecisions.length
        : 0,
      blocked,
      allowedBlocked: blocked && config.allowBlocked,
      blockedReason: authRequired
        ? authRequired.reason ?? "auth_required"
        : blocked
          ? summarizeFailure(result)
          : null,
      authRequired: authRequired
        ? {
            reason: authRequired.reason ?? null,
            scopes: Array.isArray(authRequired.scopes) ? authRequired.scopes : [],
          }
        : null,
      customEmojiCount,
      hasNextPageToken:
        typeof json.nextPageToken === "string" && json.nextPageToken.length > 0,
      customEmojiSummaries: customEmojis.slice(0, 10).map(customEmojiSummary),
      get: config.exerciseGet
        ? {
            selectedFromList: Boolean(selectedForGet?.name),
            selectedSummary,
            status: getResult?.status ?? null,
            attempts: getResult?.attempts ?? 0,
            refreshed: Boolean(getResult?.refreshed),
            replayedAfter401: Boolean(getResult?.replayedAfter401),
            retryDecisionCount: Array.isArray(getResult?.retryDecisions)
              ? getResult.retryDecisions.length
              : 0,
            blocked: getBlocked,
            allowedBlocked: getBlocked && config.allowBlocked,
            blockedReason: getBlocked ? summarizeFailure(getResult) : null,
            returnedSummary: getReturnedSummary,
            nameMatchesList: getNameMatchesList,
            emojiNameMatchesList: getEmojiNameMatchesList,
          }
        : null,
    },
    assertions: {
      smokeMetadataValidated: true,
      readOnlyOnly: true,
      usedUserAuthOnly: true,
      expectedMinCustomEmojisMatches: expectedMinMatches,
      expectedEmojiNameMatches,
      selectedGetTargetAvailable,
      getVerified,
      getNameMatchesList,
      getEmojiNameMatchesList,
      noWebhookExpected: true,
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
    savesRawCustomEmojiNames: false,
    savesRawEmojiNames: false,
    savesRawImageUris: false,
    savesRawCreatorNames: false,
    savesRawCreatorEmails: false,
    savesRawAccessTokens: false,
  };
}

function printHelp() {
  console.log([
    "Usage: pnpm live:chat-custom-emojis-smoke [-- --dry-run]",
    "",
    "Read-only custom emoji metadata smoke for installed-user Google Chat auth.",
    "",
    "Environment:",
    "  RUN_LIVE_CHAT_CUSTOM_EMOJIS_SMOKE=1  Required unless --dry-run is used.",
    "  GOOGLE_CHAT_CUSTOM_EMOJIS_SMOKE_RUN_ID",
    "                                      Optional stable run id.",
    "",
    "Options:",
    "  --dry-run                          Print the read-only plan without API calls.",
    "  --allow-blocked                    Save 403/404 disabled/unavailable responses as blocked evidence.",
    "  --metadata <path>                  Smoke space metadata JSON.",
    "  --evidence <path>                  Evidence output path.",
    "  --page-size <n>                    Page size. Default: 25, max: 200.",
    "  --created-by-me                    Filter to creator(\"users/me\").",
    "  --not-created-by-me                Filter to NOT creator(\"users/me\").",
    "  --filter <expr>                    Custom API filter.",
    "  --exercise-get                     Read one listed custom emoji with customEmojis.get.",
    "  --get-name <customEmojis/...>       Exact custom emoji resource to get after list.",
    "  --expect-emoji-name <name>          Require a listed emojiName, such as :test:.",
    "  --expect-min-custom-emojis <n>     Minimum returned custom emojis.",
  ].join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadCustomEmojisSmokeConfig()
    .then(async (config) => {
      if (config.help) {
        printHelp();
        return { ok: true };
      }
      return runCustomEmojisSmoke(config);
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
