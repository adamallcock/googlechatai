import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const DEFAULT_SERVICE = "chat-ai-sdk-dev-webhook";

const CHECK_DEFINITIONS = [
  {
    id: "setup.cloudProjectApis",
    group: "setup",
    principal: "operator",
    readOnly: true,
    command: () => ({
      command: "corepack",
      args: ["pnpm", "cloud:doctor"],
    }),
    plannedSummary: "Plan Cloud project, API enablement, and core resource check.",
    passSummary: "Cloud project APIs and core resources are configured.",
  },
  {
    id: "setup.smokeMetadata",
    group: "setup",
    principal: "none",
    readOnly: true,
    fileCheck: true,
    plannedSummary: "Plan dedicated smoke-space metadata check.",
    passSummary: "Dedicated smoke-space metadata is present.",
  },
  {
    id: "endpoint.health",
    group: "endpoint",
    principal: "none",
    readOnly: true,
    command: () => ({
      command: "corepack",
      args: ["pnpm", "cloud:health-smoke"],
    }),
    plannedSummary: "Plan /api/healthz reachability check.",
    passSummary: "Cloud Run health endpoint responded successfully.",
  },
  {
    id: "cloudRun.revision",
    group: "endpoint",
    principal: "none",
    readOnly: true,
    command: () => ({
      command: "corepack",
      args: ["pnpm", "cloud:health-smoke"],
    }),
    plannedSummary: "Plan Cloud Run revision and traffic check.",
    passSummary: "Cloud Run revision evidence is available.",
  },
  {
    id: "auth.app",
    group: "auth",
    principal: "app",
    readOnly: true,
    command: () => ({
      command: "corepack",
      args: ["pnpm", "chat:app-auth-smoke"],
    }),
    plannedSummary: "Plan app-auth list-spaces diagnostic.",
    passSummary: "App-auth Chat diagnostic passed.",
  },
  {
    id: "auth.user",
    group: "auth",
    principal: "user",
    readOnly: true,
    command: () => ({
      command: "corepack",
      args: ["pnpm", "chat:user-auth-smoke"],
    }),
    plannedSummary: "Plan installed-user auth diagnostic.",
    passSummary: "User-auth Chat diagnostic passed.",
  },
  {
    id: "logs.recent",
    group: "logs",
    principal: "operator",
    readOnly: true,
    command: (config) => ({
      command: "corepack",
      args: [
        "pnpm",
        "live:chat-log-smoke",
        "--",
        "--since",
        config.since,
        ...(config.until ? ["--until", config.until] : []),
      ],
      env: {
        RUN_LIVE_CHAT_LOG_SMOKE: "1",
      },
    }),
    plannedSummary: "Plan recent Cloud Logging correlation check.",
    passSummary: "Recent Cloud Logging check passed.",
  },
  {
    id: "endpoint.chatEvents",
    group: "interactions",
    principal: "none",
    readOnly: true,
    command: (config) => ({
      command: "corepack",
      args: [
        "pnpm",
        "live:chat-card-action-webhook-smoke",
        "--",
        "--variant",
        "unknown_action",
        "--run-id",
        `${config.runId}-endpoint`,
      ],
      env: {
        RUN_LIVE_CHAT_CARD_ACTION_WEBHOOK_SMOKE: "1",
      },
    }),
    plannedSummary: "Plan /api/chat/events direct webhook reachability check.",
    passSummary: "Chat events webhook accepted a synthetic interaction.",
  },
  {
    id: "interactions.addOnEnvelope",
    group: "interactions",
    principal: "none",
    readOnly: true,
    command: (config) => ({
      command: "corepack",
      args: [
        "pnpm",
        "live:chat-card-action-webhook-smoke",
        "--",
        "--variant",
        "mark_received",
        "--variant",
        "open_dialog",
        "--variant",
        "feedback_helpful",
        "--run-id",
        `${config.runId}-addon`,
      ],
      env: {
        RUN_LIVE_CHAT_CARD_ACTION_WEBHOOK_SMOKE: "1",
      },
    }),
    plannedSummary: "Plan Workspace add-on card action envelope replay.",
    passSummary: "Workspace add-on card action envelope replay passed.",
  },
  {
    id: "interactions.directEnvelope",
    group: "interactions",
    principal: "none",
    readOnly: true,
    scaffolded: true,
    plannedSummary: "Plan direct Chat HTTP envelope replay.",
    passSummary: "Direct Chat HTTP envelope replay is not executed in this slice.",
  },
];

const INTERACTION_CHECK_IDS = new Set([
  "endpoint.chatEvents",
  "interactions.addOnEnvelope",
  "interactions.directEnvelope",
]);

function parseArgs(argv) {
  const args = {
    scope: "all",
    dryRun: false,
    evidencePath: null,
    format: "json",
    since: null,
    until: null,
    project: null,
    service: null,
    setupBundle: false,
    help: false,
  };
  const rest = argv.slice(2);
  let index = 0;

  if (rest[index] === "interactions" || rest[index] === "setup") {
    args.scope = rest[index];
    index += 1;
  }

  for (; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--") {
      continue;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--evidence") {
      args.evidencePath = readValue(rest, index, arg);
      index += 1;
    } else if (arg.startsWith("--evidence=")) {
      args.evidencePath = arg.slice("--evidence=".length);
    } else if (arg === "--format") {
      args.format = readValue(rest, index, arg);
      index += 1;
    } else if (arg.startsWith("--format=")) {
      args.format = arg.slice("--format=".length);
    } else if (arg === "--since") {
      args.since = readValue(rest, index, arg);
      index += 1;
    } else if (arg.startsWith("--since=")) {
      args.since = arg.slice("--since=".length);
    } else if (arg === "--until") {
      args.until = readValue(rest, index, arg);
      index += 1;
    } else if (arg.startsWith("--until=")) {
      args.until = arg.slice("--until=".length);
    } else if (arg === "--project") {
      args.project = readValue(rest, index, arg);
      index += 1;
    } else if (arg.startsWith("--project=")) {
      args.project = arg.slice("--project=".length);
    } else if (arg === "--service") {
      args.service = readValue(rest, index, arg);
      index += 1;
    } else if (arg.startsWith("--service=")) {
      args.service = arg.slice("--service=".length);
    } else if (arg === "--setup-bundle") {
      args.setupBundle = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!["json", "summary"].includes(args.format)) {
    throw new Error("--format must be json or summary.");
  }

  return args;
}

function readValue(values, index, option) {
  const value = values[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function makeRunId(env) {
  if (env.GOOGLE_CHAT_DOCTOR_RUN_ID) {
    return env.GOOGLE_CHAT_DOCTOR_RUN_ID;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `chat-doctor-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function resolvePath(input, cwd) {
  if (!input) {
    return null;
  }
  return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}

function defaultSince(now = Date.now()) {
  return new Date(now - 10 * 60 * 1000).toISOString();
}

function normalizeSince(input, now = Date.now()) {
  if (!input) {
    return defaultSince(now);
  }
  const match = /^(\d+)(s|m|h|d)$/.exec(input);
  if (!match) {
    return input;
  }
  const amount = Number(match[1]);
  const multiplier = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  }[match[2]];
  return new Date(now - amount * multiplier).toISOString();
}

export function resolveChatDoctorConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
  now = Date.now(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true, format: args.format };
  }

  if (!args.dryRun && env.RUN_LIVE_CHAT_DOCTOR !== "1") {
    throw new Error(
      "Refusing to run live Chat doctor without RUN_LIVE_CHAT_DOCTOR=1. Use --dry-run for a side-effect-free plan.",
    );
  }

  const runId = makeRunId(env);
  const configuredEvidencePath =
    args.evidencePath ??
    env.GOOGLE_CHAT_DOCTOR_EVIDENCE ??
    (args.dryRun ? null : path.join(defaultEvidenceDir, `chat-doctor-${runId}.json`));

  return {
    dryRun: args.dryRun,
    mode: args.dryRun ? "dry-run" : "live",
    scope: args.scope,
    format: args.format,
    project: args.project ?? env.GOOGLE_CLOUD_PROJECT ?? "chat-ai-sdk",
    service:
      args.service ?? env.GOOGLE_CHAT_CLOUD_RUN_SERVICE ?? DEFAULT_SERVICE,
    setupBundle: args.setupBundle || args.scope === "setup",
    since: normalizeSince(args.since ?? env.GOOGLE_CHAT_DOCTOR_SINCE, now),
    until: args.until ?? env.GOOGLE_CHAT_DOCTOR_UNTIL ?? null,
    runId,
    cwd,
    webhookUrl: env.GOOGLE_CHAT_WEBHOOK_URL ?? env.BASE_URL ?? null,
    oauthClientPath: resolvePath(env.GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS, cwd),
    userTokenStorePath: resolvePath(
      env.GOOGLE_CHAT_USER_TOKEN_STORE ??
        ".tokens/google-chat-user-oauth-token.json",
      cwd,
    ),
    smokeMetadataPath: resolvePath(
      env.GOOGLE_CHAT_SMOKE_METADATA ??
        "fixtures/live/chat-smoke-space.local.json",
      cwd,
    ),
    evidencePath: resolvePath(configuredEvidencePath, cwd),
  };
}

function selectChecks(scope) {
  if (scope === "interactions") {
    return CHECK_DEFINITIONS.filter((check) => INTERACTION_CHECK_IDS.has(check.id));
  }

  if (scope === "setup") {
    return CHECK_DEFINITIONS.filter((check) =>
      ["setup", "endpoint", "auth"].includes(check.group),
    );
  }

  return CHECK_DEFINITIONS;
}

function baseCheck(definition, { status, severity, summary, live, evidence, remediation, errorCode }) {
  return {
    id: definition.id,
    status,
    severity,
    summary,
    principal: definition.principal,
    readOnly: definition.readOnly,
    live,
    redacted: true,
    evidence: evidence ?? {},
    remediation: remediation ?? null,
    errorCode: errorCode ?? null,
  };
}

function plannedCheck(definition) {
  return baseCheck(definition, {
    status: "planned",
    severity: "info",
    summary: definition.plannedSummary,
    live: false,
    evidence: {
      planned: true,
      command: plannedCommand(definition),
    },
  });
}

function plannedCommand(definition) {
  if (definition.fileCheck) {
    return "read smoke metadata file";
  }
  if (definition.scaffolded) {
    return "scaffolded direct-envelope replay";
  }
  return "delegated smoke command";
}

export async function runChatDoctor(
  config,
  {
    runCommand = runChildCommand,
    readFile = fs.readFile,
    writeFile = fs.writeFile,
    mkdir = fs.mkdir,
    explainGoogleChatError = explainWithBuiltSdk,
  } = {},
) {
  if (config.help) {
    return { ok: true, mode: "help", checks: [], summary: ["Help requested."] };
  }

  const definitions = selectChecks(config.scope);
  let checks;

  if (config.dryRun) {
    checks = definitions.map(plannedCheck);
  } else {
    checks = [];
    for (const definition of definitions) {
      checks.push(
        await runOneCheck(definition, config, {
          runCommand,
          readFile,
          explainGoogleChatError,
        }),
      );
    }
  }

  const result = {
    ok: checks.every((check) => check.status !== "fail"),
    mode: config.mode,
    scope: config.scope,
    runId: config.runId,
    project: config.project,
    service: config.service,
    since: config.since,
    until: config.until,
    summary: buildSummaryLines(checks),
    checks,
    privacy: {
      rawTokensSaved: false,
      rawMessageTextSaved: false,
      rawWebhookUrlSaved: false,
      rawPrivatePayloadsSaved: false,
      senderEmailsSaved: false,
    },
  };

  if (config.setupBundle) {
    result.setupBundle = buildSetupBundleReport(config, checks);
  }

  if (!config.dryRun && config.evidencePath) {
    await mkdir(path.dirname(config.evidencePath), { recursive: true });
    await writeFile(config.evidencePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    result.evidencePath = config.evidencePath;
  }

  return result;
}

export function buildSetupBundleReport(config, checks) {
  const passing = checks.filter((check) => check.status === "pass").map((check) => check.id);
  const blocking = checks.filter((check) => check.status === "fail").map((check) => check.id);
  const planned = checks.filter((check) => check.status === "planned").map((check) => check.id);
  const skipped = checks.filter((check) => check.status === "skipped").map((check) => check.id);
  const status =
    blocking.length > 0 ? "blocked" : planned.length > 0 ? "planned" : "ready";

  return {
    kind: "chat.setup_bundle",
    status,
    mode: config.mode,
    scope: config.scope,
    project: {
      id: config.project,
      cloudRunService: config.service,
      checks: {
        cloudProjectApis: "setup.cloudProjectApis",
        health: "endpoint.health",
        revision: "cloudRun.revision",
      },
      billing: {
        status: "checked_by_cloud_doctor",
        note: "Billing-gated APIs are diagnosed by cloud:doctor/cloud:bootstrap.",
      },
      serviceAccountProjectMatch: {
        status: "checked_by_cloud_doctor",
        note: "Service-account project alignment is checked by cloud diagnostics.",
      },
    },
    endpoint: {
      baseUrl: summarizeText(config.webhookUrl),
      expectedRoutes: ["/api/healthz", "/api/avatar.png", "/api/chat/events"],
      publicInvoker: {
        status: "checked_by_endpoint_health",
        note: "A public or otherwise Chat-reachable Cloud Run endpoint is required.",
      },
    },
    oauth: {
      clientFile: {
        path: summarizeText(config.oauthClientPath),
        env: "GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS",
        required: true,
      },
      tokenStore: {
        path: summarizeText(config.userTokenStorePath),
        env: "GOOGLE_CHAT_USER_TOKEN_STORE",
        required: true,
      },
      consentAndBranding: {
        status: "operator_check_required",
        note: "Verify OAuth consent screen branding, internal audience, test users, and requested scopes in Google Cloud Console.",
      },
    },
    marketplace: {
      visibility: "internal_or_unlisted",
      status: "operator_check_required",
      requiredConsoleChecks: [
        "Google Chat API app name, avatar URL, and interaction endpoint",
        "Google Workspace Marketplace SDK app configuration and internal visibility",
        "Workspace app authorization or admin approval where the tenant requires it",
      ],
    },
    chatApp: {
      defaultInstallModel: "user_installed_user_authorized",
      appAuthVisibilityCheck: "auth.app",
      userAuthVisibilityCheck: "auth.user",
      smokeMetadataCheck: "setup.smokeMetadata",
      appMembershipCheck: "auth.app",
      endpointCheck: "endpoint.chatEvents",
    },
    trustModel: {
      installedUser: true,
      userAuthorized: true,
      domainWideDelegation: false,
      note: "Do not switch to domain-wide delegation unless the operator explicitly widens the trust model.",
    },
    checks: {
      passing,
      blocking,
      planned,
      skipped,
    },
    adminPacket: {
      redacted: true,
      shareableWithWorkspaceAdmin: true,
      summary:
        status === "blocked"
          ? "Setup is blocked by one or more diagnostic checks."
          : status === "planned"
            ? "Setup checks are planned; run guarded live doctor for current evidence."
            : "Setup checks passed for the selected scope.",
      requiredActions: setupRequiredActions(checks),
    },
    privacy: {
      rawTokensSaved: false,
      rawMessageTextSaved: false,
      rawWebhookUrlSaved: false,
      rawPrivatePayloadsSaved: false,
      senderEmailsSaved: false,
    },
  };
}

function setupRequiredActions(checks) {
  const failed = new Set(checks.filter((check) => check.status === "fail").map((check) => check.id));
  const planned = checks.some((check) => check.status === "planned");
  const actions = [];

  if (planned) {
    actions.push(
      "Run guarded live setup doctor to replace planned dry-run checks with current evidence.",
    );
  }
  if (failed.has("setup.cloudProjectApis")) {
    actions.push("Enable missing Google Cloud APIs and repair Cloud project resources.");
  }
  if (failed.has("setup.smokeMetadata")) {
    actions.push("Create dedicated smoke-space metadata and install the Chat app there.");
  }
  if (failed.has("endpoint.health") || failed.has("cloudRun.revision")) {
    actions.push(
      "Deploy the Cloud Run webhook, verify public reachability, and confirm /api/healthz and /api/avatar.png.",
    );
  }
  if (failed.has("auth.app")) {
    actions.push(
      "Install or authorize the Chat app in the dedicated smoke space and verify app-auth visibility.",
    );
  }
  if (failed.has("auth.user")) {
    actions.push(
      "Authorize the installing user with the required OAuth scopes using chat:user-auth-smoke.",
    );
  }

  actions.push(
    "Verify OAuth consent branding, internal audience or test-user access, and requested Chat scopes.",
  );
  actions.push(
    "Verify Google Chat API app endpoint, avatar URL, app visibility, and Marketplace/internal listing configuration.",
  );

  return [...new Set(actions)];
}

async function runOneCheck(
  definition,
  config,
  { runCommand, readFile, explainGoogleChatError },
) {
  if (definition.fileCheck) {
    return runSmokeMetadataCheck(definition, config, readFile);
  }

  if (definition.scaffolded) {
    return baseCheck(definition, {
      status: "skipped",
      severity: "info",
      summary: definition.passSummary,
      live: false,
      evidence: {
        scaffolded: true,
        reason:
          "Direct Chat HTTP replay is planned for the fixture recorder/replayer slice.",
      },
      remediation:
        "Use the guarded Chat UI inbound smoke for direct-event proof until recorded direct fixtures are available.",
    });
  }

  const commandSpec = definition.command(config);
  const child = await runCommand({
    id: definition.id,
    command: commandSpec.command,
    args: commandSpec.args,
    env: commandSpec.env ?? {},
    cwd: config.cwd,
  });
  const parsed = parseJson(child.stdout);
  const ok = child.status === 0 && parsed?.ok !== false;

  if (ok) {
    return baseCheck(definition, {
      status: "pass",
      severity: "info",
      summary: definition.passSummary,
      live: true,
      evidence: {
        command: commandDisplay(commandSpec),
        exitStatus: child.status,
        response: redactValue(parsed ?? {}),
      },
    });
  }

  const classification = await classifyFailure(
    definition.id,
    child,
    parsed,
    explainGoogleChatError,
  );
  return baseCheck(definition, {
    status: "fail",
    severity: classification.severity,
    summary: classification.summary,
    live: true,
    evidence: {
      command: commandDisplay(commandSpec),
      exitStatus: child.status,
      stderr: summarizeText(child.stderr),
      response: redactValue(parsed ?? {}),
    },
    remediation: classification.remediation,
    errorCode: classification.errorCode,
  });
}

async function runSmokeMetadataCheck(definition, config, readFile) {
  try {
    const raw = await readFile(config.smokeMetadataPath, "utf8");
    const parsed = JSON.parse(raw);
    const dedicatedSmokeSpace =
      parsed?.safety?.dedicatedSmokeSpace === true ||
      /^Google Chat AI SDK Smoke/.test(parsed?.displayName ?? "");
    const hasSpace = typeof parsed?.space === "string" && parsed.space.startsWith("spaces/");

    if (hasSpace && dedicatedSmokeSpace) {
      return baseCheck(definition, {
        status: "pass",
        severity: "info",
        summary: definition.passSummary,
        live: true,
        evidence: {
          path: config.smokeMetadataPath,
          spaceConfigured: true,
          displayName: summarizeText(parsed.displayName),
          dedicatedSmokeSpace,
        },
      });
    }

    return baseCheck(definition, {
      status: "fail",
      severity: "error",
      summary: "Smoke metadata exists but does not describe a dedicated smoke space.",
      live: true,
      evidence: {
        path: config.smokeMetadataPath,
        spaceConfigured: hasSpace,
        dedicatedSmokeSpace,
      },
      remediation:
        "Point GOOGLE_CHAT_SMOKE_METADATA at a dedicated Google Chat AI SDK Smoke metadata file before live writes.",
      errorCode: "missing_smoke_metadata",
    });
  } catch (error) {
    return baseCheck(definition, {
      status: "fail",
      severity: "error",
      summary: "Dedicated smoke-space metadata is missing or unreadable.",
      live: true,
      evidence: {
        path: config.smokeMetadataPath,
        errorName: error.name ?? "Error",
      },
      remediation:
        "Create or configure fixtures/live/chat-smoke-space.local.json for a dedicated Google Chat AI SDK Smoke space.",
      errorCode: "missing_smoke_metadata",
    });
  }
}

function runChildCommand({ command, args, env, cwd }) {
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr || result.error?.message || "",
  };
}

function commandDisplay(commandSpec) {
  return [commandSpec.command, ...commandSpec.args].join(" ");
}

function parseJson(raw) {
  if (!raw || !raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function classifyFailure(id, child, parsed, explainGoogleChatError) {
  const rendered = `${child.stderr ?? ""}\n${JSON.stringify(parsed ?? {})}`;
  const shared = await sharedFailureExplanation(
    id,
    child,
    parsed,
    explainGoogleChatError,
  );

  if (shared) {
    return shared;
  }

  if (id === "endpoint.health" || id === "cloudRun.revision") {
    return {
      errorCode: "endpoint_unreachable",
      severity: "error",
      summary: "Cloud Run endpoint is not reachable or did not return healthy.",
      remediation:
        "Verify the Cloud Run URL, service revision, public invoker setting, and /api/healthz route.",
    };
  }

  if (id === "logs.recent") {
    return {
      errorCode: rendered.includes("expectedHttpPostCountMatches")
        ? "no_request_received"
        : "logs_unavailable",
      severity: "error",
      summary: "Cloud Logging correlation check failed.",
      remediation:
        "Check the Chat app configuration, /api/chat/events endpoint URL, Cloud Run request logs, and logging IAM access.",
    };
  }

  if (id === "auth.user") {
    return {
      errorCode:
        rendered.includes("authRequired") || rendered.includes("User OAuth")
          ? "auth_required"
          : "wrong_principal",
      severity: "error",
      summary: "Installed-user auth diagnostic failed.",
      remediation:
        "Run chat:user-auth-smoke -- --authorize with the required user scopes. Keep this on the installed-user path; do not switch to domain-wide delegation by default.",
    };
  }

  if (id === "auth.app") {
    return {
      errorCode: rendered.includes("404")
        ? "app_not_configured"
        : rendered.includes("403")
          ? "app_not_installed"
          : "wrong_principal",
      severity: "error",
      summary: "App-auth Chat diagnostic failed.",
      remediation:
        "Verify the Chat app is configured for this Cloud project, installed in the smoke space, and using app-supported scopes.",
    };
  }

  if (id.startsWith("interactions.") || id === "endpoint.chatEvents") {
    let errorCode = "invalid_response_envelope";
    if (/timeout|deadline|late/i.test(rendered)) {
      errorCode = "late_response";
    } else if (/ECONNREFUSED|ENOTFOUND|fetch failed|404/i.test(rendered)) {
      errorCode = "endpoint_unreachable";
    }

    return {
      errorCode,
      severity: "error",
      summary: "Interaction replay failed.",
      remediation:
        "Verify the Chat app interaction endpoint, card action function URL/actionName, response envelope shape, and 30-second response deadline.",
    };
  }

  if (id === "setup.cloudProjectApis") {
    return {
      errorCode: "cloud_project_incomplete",
      severity: "error",
      summary: "Cloud project setup diagnostic failed.",
      remediation:
        "Run cloud:doctor directly for the missing API/resource list, then enable the missing APIs or recreate the documented resources.",
    };
  }

  return {
    errorCode: /429|5\d\d/.test(rendered) ? "retryable_transient" : "unknown",
    severity: "error",
    summary: "Diagnostic check failed.",
    remediation:
      "Inspect the redacted child command response and rerun the underlying smoke command for details.",
  };
}

async function sharedFailureExplanation(id, child, parsed, explainGoogleChatError) {
  if (!["auth.app", "auth.user", "endpoint.chatEvents"].includes(id)) {
    return null;
  }
  if (typeof explainGoogleChatError !== "function") {
    return null;
  }

  const status = statusFromFailure(child, parsed);
  const context = {
    intent: id,
    principal:
      id === "auth.app" ? "app" : id === "auth.user" ? "user" : "none",
  };
  const explanation = await explainGoogleChatError(
    {
      httpStatus: status,
      body: parsed?.body ?? parsed?.response ?? parsed ?? {},
      message: child.stderr,
    },
    context,
  );

  if (!explanation || typeof explanation !== "object") {
    return null;
  }

  return {
    errorCode:
      typeof explanation.code === "string" ? explanation.code : "unknown",
    severity: explanation.retryable ? "warning" : "error",
    summary:
      typeof explanation.summary === "string"
        ? explanation.summary
        : "Diagnostic check failed.",
    remediation: Array.isArray(explanation.remediation)
      ? explanation.remediation
      : typeof explanation.remediation === "string"
        ? explanation.remediation
        : "Inspect the redacted child command response and rerun the underlying smoke command for details.",
  };
}

function statusFromFailure(child, parsed) {
  const direct = parsed?.status ?? parsed?.httpStatus;
  if (typeof direct === "number") {
    return direct;
  }
  const responseStatus = parsed?.response?.status;
  if (typeof responseStatus === "number") {
    return responseStatus;
  }
  return child.status === 0 ? null : child.status;
}

async function explainWithBuiltSdk(error, context) {
  try {
    const sdk = await import(
      pathToFileURL(path.join(repoRoot, "packages/node/dist/index.js")).href
    );
    if (typeof sdk.explainGoogleChatError === "function") {
      return sdk.explainGoogleChatError(error, context);
    }
  } catch {
    return null;
  }
  return null;
}

function buildSummaryLines(checks) {
  const counts = {
    pass: checks.filter((check) => check.status === "pass").length,
    fail: checks.filter((check) => check.status === "fail").length,
    warn: checks.filter((check) => check.status === "warn").length,
    skipped: checks.filter((check) => check.status === "skipped").length,
    planned: checks.filter((check) => check.status === "planned").length,
  };

  return [
    `${counts.fail === 0 ? "PASS" : "FAIL"}: ${counts.pass} passed, ${counts.fail} failed, ${counts.skipped} skipped, ${counts.planned} planned.`,
    ...checks
      .filter((check) => check.status === "fail")
      .map((check) => `${check.id}: ${check.summary}`),
  ];
}

export function formatDoctorSummary(result) {
  const label = result.ok ? "PASS" : "FAIL";
  const lines = [`Chat doctor: ${label} (${result.scope}, ${result.mode})`];

  for (const check of result.checks) {
    const prefix = check.status.toUpperCase().padEnd(7);
    lines.push(`${prefix} ${check.id} - ${check.summary}`);
    if (check.status === "fail" && check.remediation) {
      lines.push(`        Fix: ${check.remediation}`);
    }
  }

  if (result.evidencePath) {
    lines.push(`Evidence: ${result.evidencePath}`);
  }
  if (result.setupBundle) {
    lines.push(`Setup bundle: ${String(result.setupBundle.status).toUpperCase()}`);
  }

  return `${lines.join("\n")}\n`;
}

function summarizeText(value) {
  const text = typeof value === "string" ? value : "";
  return {
    available: text.length > 0,
    length: text.length,
    sha256: text.length ? stableHash(text) : null,
  };
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update("googlechatai-doctor")
    .update("\0")
    .update(String(value ?? ""))
    .digest("hex");
}

function redactValue(value, key = "") {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, key));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey),
      ]),
    );
  }

  if (typeof value !== "string") {
    return value;
  }

  const lowered = key.toLowerCase();
  if (
    /^https?:\/\//.test(value) ||
    lowered.includes("token") ||
    lowered.includes("secret") ||
    lowered.includes("private") ||
    lowered.includes("email") ||
    lowered.includes("url")
  ) {
    return summarizeText(value);
  }

  return value;
}

function usage() {
  return `${[
    "Usage: pnpm chat:doctor -- [interactions|setup] [options]",
    "",
    "Options:",
    "  --dry-run              Print a side-effect-free diagnostic plan.",
    "  --format json|summary  Output format. Default: json.",
    "  --since <time|10m>     Lower log window bound for live checks.",
    "  --until <time>         Optional upper log window bound.",
    "  --evidence <path>      Write redacted evidence JSON.",
    "  --project <id>         Google Cloud project override.",
    "  --service <name>       Cloud Run service override.",
    "  --setup-bundle         Attach a redacted setup bundle to the report.",
    "",
    "Live mode requires RUN_LIVE_CHAT_DOCTOR=1.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = resolveChatDoctorConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runChatDoctor(config);

    if (config.format === "summary") {
      process.stdout.write(formatDoctorSummary(result));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }

    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    const payload = {
      ok: false,
      error: {
        name: error.name ?? "Error",
        message: error.message ?? String(error),
      },
    };

    if (process.argv.includes("--format=summary") || process.argv.includes("--format")) {
      process.stderr.write(`${payload.error.name}: ${payload.error.message}\n`);
    } else {
      console.error(JSON.stringify(payload, null, 2));
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
