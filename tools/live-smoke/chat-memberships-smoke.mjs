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

class ChatMembershipsSmokeError extends Error {
  constructor(operation, status, response) {
    super(`${operation} failed with HTTP ${status}`);
    this.name = "ChatMembershipsSmokeError";
    this.operation = operation;
    this.status = status;
    this.response = response;
  }
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    metadataPath: null,
    evidencePath: null,
    pageSize: 100,
    limit: 100,
    filter: null,
    showGroups: false,
    showInvited: false,
    skipAppGet: false,
    expectMinMemberships: 1,
    expectMinHumanMembers: null,
    expectMinBotMembers: null,
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
    } else if (arg === "--page-size") {
      args.pageSize = Number(rest[++index]);
    } else if (arg.startsWith("--page-size=")) {
      args.pageSize = Number(arg.slice("--page-size=".length));
    } else if (arg === "--limit") {
      args.limit = Number(rest[++index]);
    } else if (arg.startsWith("--limit=")) {
      args.limit = Number(arg.slice("--limit=".length));
    } else if (arg === "--filter") {
      args.filter = rest[++index];
    } else if (arg.startsWith("--filter=")) {
      args.filter = arg.slice("--filter=".length);
    } else if (arg === "--show-groups") {
      args.showGroups = true;
    } else if (arg === "--show-invited") {
      args.showInvited = true;
    } else if (arg === "--skip-app-get") {
      args.skipAppGet = true;
    } else if (arg === "--expect-min-memberships") {
      args.expectMinMemberships = Number(rest[++index]);
    } else if (arg.startsWith("--expect-min-memberships=")) {
      args.expectMinMemberships = Number(
        arg.slice("--expect-min-memberships=".length),
      );
    } else if (arg === "--expect-min-human-members") {
      args.expectMinHumanMembers = Number(rest[++index]);
    } else if (arg.startsWith("--expect-min-human-members=")) {
      args.expectMinHumanMembers = Number(
        arg.slice("--expect-min-human-members=".length),
      );
    } else if (arg === "--expect-min-bot-members") {
      args.expectMinBotMembers = Number(rest[++index]);
    } else if (arg.startsWith("--expect-min-bot-members=")) {
      args.expectMinBotMembers = Number(
        arg.slice("--expect-min-bot-members=".length),
      );
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function resolvePath(input, cwd = process.cwd()) {
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
  if (env.GOOGLE_CHAT_MEMBERSHIPS_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_MEMBERSHIPS_SMOKE_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `memberships-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export async function loadMembershipsSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_CHAT_MEMBERSHIPS_SMOKE !== "1") {
    throw new Error(
      "Refusing to run memberships Chat smoke without RUN_LIVE_CHAT_MEMBERSHIPS_SMOKE=1.",
    );
  }

  const space = env.GOOGLE_CHAT_TEST_SPACE?.trim();
  requireSmokeSpaceName(space);
  requirePositiveInteger(args.pageSize, "--page-size");
  requirePositiveInteger(args.limit, "--limit");
  requireNonNegativeIntegerOrNull(
    args.expectMinMemberships,
    "--expect-min-memberships",
  );
  requireNonNegativeIntegerOrNull(
    args.expectMinHumanMembers,
    "--expect-min-human-members",
  );
  requireNonNegativeIntegerOrNull(
    args.expectMinBotMembers,
    "--expect-min-bot-members",
  );

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

  const userAuthConfig = resolveUserAuthConfig(env, {
    credentialsPath: null,
    tokenStorePath: null,
    redirectUri: null,
  });

  return {
    dryRun: args.dryRun,
    space,
    metadata,
    metadataPath,
    runId: makeRunId(env),
    credentialsPath: userAuthConfig.credentialsPath,
    tokenStorePath: userAuthConfig.tokenStorePath,
    pageSize: Math.min(args.pageSize, 1000),
    limit: args.limit,
    filter: args.filter,
    showGroups: args.showGroups,
    showInvited: args.showInvited,
    getAppMembership: !args.skipAppGet,
    expectations: {
      minMemberships: args.expectMinMemberships,
      minHumanMembers: args.expectMinHumanMembers,
      minBotMembers: args.expectMinBotMembers,
      appMembership: !args.skipAppGet,
    },
    userScopes: USER_AUTH_SCOPES.readMemberships,
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_MEMBERSHIPS_SMOKE_EVIDENCE,
      cwd,
    ),
  };
}

export function buildMembershipsSmokePlan(config) {
  const calls = [
    {
      operation: "spaces.members.list",
      method: "GET",
      path: `/v1/${config.space}/members`,
      query: {
        pageSize: config.pageSize,
        filter: config.filter,
        showGroups: config.showGroups || undefined,
        showInvited: config.showInvited || undefined,
      },
      writes: false,
      authMode: "user",
      requiredScopes: config.userScopes,
      safetyCheck:
        "Reads memberships only for the configured dedicated smoke space; useAdminAccess is never set.",
    },
  ];

  if (config.getAppMembership) {
    calls.push({
      operation: "spaces.members.get.app",
      method: "GET",
      path: `/v1/${config.space}/members/app`,
      writes: false,
      authMode: "user",
      requiredScopes: config.userScopes,
      safetyCheck:
        "Reads only the installed app membership alias in the dedicated smoke space.",
    });
  }

  return {
    mode: config.dryRun ? "dry-run" : "live",
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    runId: config.runId,
    pageSize: config.pageSize,
    limit: config.limit,
    filterHash: config.filter
      ? stableHash(config.metadata.displayName, config.filter)
      : null,
    showGroups: config.showGroups,
    showInvited: config.showInvited,
    calls,
  };
}

function sanitizeError(error) {
  if (error instanceof UserAuthRequiredError) {
    return {
      name: error.name,
      message: error.message,
      details: error.details,
      authorizeHint:
        "Run `corepack pnpm chat:user-auth-smoke -- --authorize --read-memberships` to grant local user membership read scope. Do not use domain-wide delegation.",
    };
  }
  if (error instanceof ChatMembershipsSmokeError) {
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
    path.join(defaultEvidenceDir, `chat-memberships-smoke-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

async function createMembershipsClient(config) {
  const oauthClient = readOAuthClientConfig(
    await fs.readFile(resolvePath(config.credentialsPath), "utf8"),
  );

  return {
    async listMemberships(query = {}) {
      const url = new URL(`https://chat.googleapis.com/v1/${config.space}/members`);
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }

      const result = await chatRequestWithUserAuth({
        oauthClient,
        tokenStorePath: config.tokenStorePath,
        scopes: config.userScopes,
        url: url.toString(),
      });

      if (!result.ok) {
        throw new ChatMembershipsSmokeError(
          "spaces.members.list",
          result.status,
          result.json,
        );
      }

      return result;
    },

    async getMembership(name) {
      const result = await chatRequestWithUserAuth({
        oauthClient,
        tokenStorePath: config.tokenStorePath,
        scopes: config.userScopes,
        url: `https://chat.googleapis.com/v1/${name}`,
      });

      if (!result.ok) {
        throw new ChatMembershipsSmokeError(
          "spaces.members.get",
          result.status,
          result.json,
        );
      }

      return result;
    },
  };
}

function stableHash(project, value) {
  return crypto
    .createHash("sha256")
    .update(project)
    .update("\0")
    .update(String(value ?? ""))
    .digest("hex");
}

function summarizeResourceName(config, name) {
  return {
    available: typeof name === "string",
    hash:
      typeof name === "string"
        ? stableHash(config.metadata.displayName, name)
        : null,
  };
}

function summarizeIdentity(config, user) {
  const displayName =
    typeof user?.displayName === "string" ? user.displayName : null;
  const email = typeof user?.email === "string" ? user.email : null;
  return {
    name: summarizeResourceName(config, user?.name),
    type: typeof user?.type === "string" ? user.type : null,
    displayNameAvailable: displayName !== null,
    displayNameHash: displayName
      ? stableHash(config.metadata.displayName, displayName)
      : null,
    emailAvailable: email !== null,
    emailDomain: email?.includes("@") ? email.split("@").at(-1) : null,
    domainHash: email?.includes("@")
      ? stableHash(config.metadata.displayName, email.split("@").at(-1))
      : null,
  };
}

function summarizeMembership(config, membership) {
  return {
    name: summarizeResourceName(config, membership?.name),
    state: membership?.state ?? null,
    role: membership?.role ?? null,
    createTime: membership?.createTime ?? null,
    deleteTime: membership?.deleteTime ?? null,
    member: summarizeIdentity(config, membership?.member),
  };
}

function summarizeListPage(config, result) {
  const memberships = Array.isArray(result.json.memberships)
    ? result.json.memberships
    : [];
  return {
    status: result.status ?? 200,
    token: {
      refreshed: Boolean(result.refreshed),
      replayedAfter401: Boolean(result.replayedAfter401),
    },
    response: {
      memberships: memberships.length,
      nextPageTokenAvailable: typeof result.json.nextPageToken === "string",
      membershipsSummary: memberships.map((membership) =>
        summarizeMembership(config, membership),
      ),
    },
  };
}

function countBy(values, selector) {
  const counts = {};
  for (const value of values) {
    const key = selector(value) ?? "UNKNOWN";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function buildSummary(memberships) {
  return {
    totalMemberships: memberships.length,
    byMemberType: countBy(memberships, (membership) => membership.member?.type),
    byRole: countBy(memberships, (membership) => membership.role),
    byState: countBy(memberships, (membership) => membership.state),
    displayNameAvailable: memberships.filter(
      (membership) => typeof membership.member?.displayName === "string",
    ).length,
    emailAvailable: memberships.filter(
      (membership) => typeof membership.member?.email === "string",
    ).length,
  };
}

function buildAssertions({ config, memberships, appMembershipResult }) {
  const summary = buildSummary(memberships);
  return {
    minMemberships:
      config.expectations.minMemberships === null
        ? null
        : memberships.length >= config.expectations.minMemberships,
    minHumanMembers:
      config.expectations.minHumanMembers === null
        ? null
        : (summary.byMemberType.HUMAN ?? 0) >=
          config.expectations.minHumanMembers,
    minBotMembers:
      config.expectations.minBotMembers === null
        ? null
        : (summary.byMemberType.BOT ?? 0) >= config.expectations.minBotMembers,
    appMembershipResolved: config.expectations.appMembership
      ? Boolean(appMembershipResult?.json?.name)
      : null,
  };
}

function failedAssertions(assertions) {
  return Object.entries(assertions)
    .filter(([, value]) => value === false)
    .map(([key]) => key);
}

export async function runMembershipsSmoke(
  config,
  { client = null, writeEvidence = true } = {},
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
        plan: buildMembershipsSmokePlan(config),
      },
    };
  }

  const membershipsClient = client ?? (await createMembershipsClient(config));
  const evidence = {
    ok: false,
    mode: "live",
    runId: config.runId,
    targetSpace: config.space,
    metadataPath: config.metadataPath,
    tokenStorePath: config.tokenStorePath,
    startedAt: new Date().toISOString(),
    operations: [],
    memberships: {
      pages: [],
      app: null,
      summary: null,
    },
    assertions: {},
    failures: [],
    privacy: {
      rawMembershipNamesSaved: false,
      rawMemberResourceNamesSaved: false,
      rawMemberEmailsSaved: false,
      rawMemberDisplayNamesSaved: false,
      rawAccessTokensSaved: false,
      useAdminAccess: false,
      writesPerformed: false,
    },
  };
  const memberships = [];
  let pageToken = null;
  let appMembershipResult = null;

  try {
    do {
      const remaining = config.limit - memberships.length;
      if (remaining <= 0) {
        break;
      }
      const query = {
        pageSize: Math.min(config.pageSize, remaining),
        pageToken,
        filter: config.filter,
        showGroups: config.showGroups || undefined,
        showInvited: config.showInvited || undefined,
      };
      const page = await recordOperation(
        evidence,
        "spaces.members.list",
        () => membershipsClient.listMemberships(query),
        (result) => summarizeListPage(config, result),
      );
      const pageMemberships = Array.isArray(page.json.memberships)
        ? page.json.memberships
        : [];
      memberships.push(...pageMemberships);
      evidence.memberships.pages.push(summarizeListPage(config, page).response);
      pageToken = page.json.nextPageToken ?? null;
    } while (pageToken);

    if (config.getAppMembership) {
      appMembershipResult = await recordOperation(
        evidence,
        "spaces.members.get.app",
        () => membershipsClient.getMembership(`${config.space}/members/app`),
        (result) => ({
          status: result.status ?? 200,
          token: {
            refreshed: Boolean(result.refreshed),
            replayedAfter401: Boolean(result.replayedAfter401),
          },
          response: summarizeMembership(config, result.json),
        }),
      );
      evidence.memberships.app = summarizeMembership(
        config,
        appMembershipResult.json,
      );
    }

    evidence.memberships.summary = buildSummary(memberships);
    evidence.assertions = buildAssertions({
      config,
      memberships,
      appMembershipResult,
    });
    evidence.failures = failedAssertions(evidence.assertions);
    if (evidence.failures.length > 0) {
      throw new Error(
        `Chat memberships smoke assertions failed: ${evidence.failures.join(", ")}`,
      );
    }
  } catch (error) {
    evidence.error = sanitizeError(error);
    evidence.finishedAt = new Date().toISOString();
    if (writeEvidence) {
      evidence.evidencePath = await writeEvidenceFile(config, evidence);
    }
    error.evidence = evidence;
    throw error;
  }

  evidence.finishedAt = new Date().toISOString();
  evidence.ok = true;

  if (writeEvidence) {
    evidence.evidencePath = await writeEvidenceFile(config, evidence);
  }

  return { ok: true, evidence };
}

function usage() {
  return `${[
    "Usage: RUN_LIVE_CHAT_MEMBERSHIPS_SMOKE=1 GOOGLE_CHAT_TEST_SPACE=spaces/... pnpm live:chat-memberships-smoke",
    "",
    "Required:",
    "  RUN_LIVE_CHAT_MEMBERSHIPS_SMOKE=1",
    "  GOOGLE_CHAT_TEST_SPACE=spaces/...",
    "  GOOGLE_CHAT_SMOKE_METADATA=fixtures/live/chat-smoke-space.local.json",
    "  User OAuth token with chat.memberships.readonly",
    "",
    "Authorize missing scopes:",
    "  corepack pnpm chat:user-auth-smoke -- --authorize --read-memberships",
    "",
    "Options:",
    "  --dry-run                       Print planned API calls without reads.",
    "  --metadata <path>               Smoke-space metadata JSON path.",
    "  --evidence <path>               Evidence JSON output path.",
    "  --limit <n>                     Maximum memberships to read. Default: 100.",
    "  --page-size <n>                 Membership page size. Default: 100.",
    "  --filter <query>                Optional memberships.list filter.",
    "  --show-groups                   Include Google Group memberships when API allows.",
    "  --show-invited                  Include invited memberships when API allows.",
    "  --skip-app-get                  Skip spaces/{space}/members/app lookup.",
    "  --expect-min-memberships <n>    Require at least n listed memberships. Default: 1.",
    "  --expect-min-human-members <n>  Require at least n HUMAN members.",
    "  --expect-min-bot-members <n>    Require at least n BOT members.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = await loadMembershipsSmokeConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runMembershipsSmoke(config);
    process.stdout.write(`${JSON.stringify(result.evidence, null, 2)}\n`);
  } catch (error) {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
      process.stdout.write(usage());
      return;
    }
    console.error(JSON.stringify(sanitizeError(error), null, 2));
    if (error.evidence) {
      console.error(JSON.stringify(error.evidence, null, 2));
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
