import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const DEFAULT_SERVICE = "chat-ai-sdk-dev-webhook";

const SECRET_KEYS = new Set([
  "access_token",
  "accesstoken",
  "authorization",
  "auth",
  "bearer",
  "client_secret",
  "clientsecret",
  "code",
  "id_token",
  "idtoken",
  "key",
  "private_key",
  "privatekey",
  "refresh_token",
  "refreshtoken",
  "secret",
  "token",
]);

const TEXT_KEYS = new Set([
  "argumenttext",
  "description",
  "displayname",
  "formattedtext",
  "label",
  "subtitle",
  "text",
  "title",
  "value",
]);

const BYTE_KEYS = new Set([
  "base64",
  "bytes",
  "contentbytes",
  "data",
  "filebytes",
  "rawbytes",
]);

const FILE_KEYS = new Set([
  "contentname",
  "filename",
  "file",
  "originalfilename",
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\//i;

function parseArgs(argv) {
  const args = {
    command: "collect",
    dryRun: false,
    evidencePath: null,
    fixturePath: null,
    inputPath: null,
    outputPath: null,
    since: null,
    until: null,
    project: null,
    service: null,
    format: "json",
    help: false,
  };

  const rest = argv.slice(2);
  let index = 0;
  if (rest[index] && !rest[index].startsWith("-")) {
    args.command = rest[index];
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
    } else if (arg === "--fixture") {
      args.fixturePath = readValue(rest, index, arg);
      index += 1;
    } else if (arg.startsWith("--fixture=")) {
      args.fixturePath = arg.slice("--fixture=".length);
    } else if (arg === "--input") {
      args.inputPath = readValue(rest, index, arg);
      index += 1;
    } else if (arg.startsWith("--input=")) {
      args.inputPath = arg.slice("--input=".length);
    } else if (arg === "--output") {
      args.outputPath = readValue(rest, index, arg);
      index += 1;
    } else if (arg.startsWith("--output=")) {
      args.outputPath = arg.slice("--output=".length);
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
    } else if (arg === "--format") {
      args.format = readValue(rest, index, arg);
      index += 1;
    } else if (arg.startsWith("--format=")) {
      args.format = arg.slice("--format=".length);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!["collect", "record", "replay"].includes(args.command)) {
    throw new Error("command must be collect, record, or replay.");
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

function resolvePath(input, cwd) {
  if (!input) {
    return null;
  }
  return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}

function makeRunId(env) {
  if (env.GOOGLE_CHAT_EVIDENCE_RUN_ID) {
    return env.GOOGLE_CHAT_EVIDENCE_RUN_ID;
  }
  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `chat-evidence-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function normalizeSince(input, now = Date.now()) {
  const value = input ?? "10m";
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (!match) {
    return value;
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

export function resolveEvidenceConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
  now = Date.now(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true, command: args.command, format: args.format };
  }

  if (args.command === "collect" && !args.dryRun && env.RUN_LIVE_CHAT_EVIDENCE !== "1") {
    throw new Error(
      "Refusing to collect live Chat evidence without RUN_LIVE_CHAT_EVIDENCE=1. Use --dry-run for a side-effect-free plan.",
    );
  }

  const runId = makeRunId(env);
  const configuredEvidencePath =
    args.evidencePath ??
    env.GOOGLE_CHAT_EVIDENCE_PATH ??
    (args.dryRun ? null : path.join(defaultEvidenceDir, `chat-evidence-${runId}.json`));

  return {
    command: args.command,
    dryRun: args.dryRun,
    mode: args.dryRun ? "dry-run" : "live",
    project: args.project ?? env.GOOGLE_CLOUD_PROJECT ?? null,
    service: args.service ?? env.GOOGLE_CHAT_CLOUD_RUN_SERVICE ?? DEFAULT_SERVICE,
    since: normalizeSince(args.since ?? env.GOOGLE_CHAT_EVIDENCE_SINCE, now),
    until: args.until ?? env.GOOGLE_CHAT_EVIDENCE_UNTIL ?? null,
    runId,
    format: args.format,
    cwd,
    evidencePath: resolvePath(configuredEvidencePath, cwd),
    fixturePath: resolvePath(args.fixturePath, cwd),
    inputPath: resolvePath(args.inputPath, cwd),
    outputPath: resolvePath(args.outputPath, cwd),
  };
}

export function evidencePrivacy() {
  return {
    rawTokensSaved: false,
    rawMessageTextSaved: false,
    rawWebhookUrlSaved: false,
    rawPrivatePayloadsSaved: false,
    senderEmailsSaved: false,
    attachmentBytesSaved: false,
    formValuesSaved: false,
  };
}

export function buildEvidenceCollectPlan(config) {
  return {
    ok: true,
    kind: "chat.evidence_collect_plan",
    mode: config.mode,
    runId: config.runId,
    project: config.project,
    service: config.service,
    since: config.since,
    until: config.until,
    commands: [
      {
        id: "chat.doctor",
        command: "corepack",
        args: [
          "pnpm",
          "chat:doctor",
          "--",
          "--setup-bundle",
          "--since",
          config.since,
          ...(config.until ? ["--until", config.until] : []),
        ],
        env: {
          RUN_LIVE_CHAT_DOCTOR: "1",
        },
        purpose: "Collect setup, endpoint, auth, interaction, and remediation evidence.",
      },
      {
        id: "chat.logs",
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
        purpose: "Correlate recent Cloud Run Chat events, HTTP posts, and errors.",
      },
    ],
    privacy: evidencePrivacy(),
  };
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function redactedText(value, label = "text") {
  const text = String(value ?? "");
  return `[redacted:${label}:${hashText(text).slice(0, 16)}:${text.length}]`;
}

function normalizeKey(key) {
  return String(key ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function makeRedactionState() {
  return {
    secretCount: 0,
    emailCount: 0,
    textCount: 0,
    urlCount: 0,
    filenameCount: 0,
    byteCount: 0,
    objectCount: 0,
  };
}

function redactString(value, key, state) {
  const keyName = normalizeKey(key);
  const text = String(value);

  if (SECRET_KEYS.has(keyName) || keyName.includes("token") || keyName.includes("secret")) {
    state.secretCount += 1;
    return "[redacted:secret]";
  }

  if (keyName.includes("email") || EMAIL_RE.test(text)) {
    state.emailCount += 1;
    return "redacted-email@example.invalid";
  }

  if (FILE_KEYS.has(keyName)) {
    state.filenameCount += 1;
    const extension = path.extname(text).slice(0, 16);
    return `[redacted:filename:${hashText(text).slice(0, 16)}${extension}]`;
  }

  if (keyName.includes("url") || URL_RE.test(text)) {
    state.urlCount += 1;
    return redactedText(text, "url");
  }

  if (TEXT_KEYS.has(keyName) || keyName.includes("text") || keyName.includes("displayname")) {
    state.textCount += 1;
    return redactedText(text, "text");
  }

  return value;
}

function redactValue(value, key, state) {
  const keyName = normalizeKey(key);
  if (typeof value === "string") {
    if (BYTE_KEYS.has(keyName)) {
      state.byteCount += 1;
      return "[redacted:bytes]";
    }
    return redactString(value, key, state);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, key, state));
  }

  if (value && typeof value === "object") {
    state.objectCount += 1;
    const output = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      output[entryKey] = redactValue(entryValue, entryKey, state);
    }
    return output;
  }

  return value;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function attachmentCount(payload) {
  const message = asObject(payload.message);
  if (Array.isArray(message.attachments)) {
    return message.attachments.length;
  }
  if (message.attachment && typeof message.attachment === "object") {
    return 1;
  }
  return 0;
}

function formInputCount(payload) {
  const sources = [
    asObject(payload.common).formInputs,
    asObject(payload.commonEventObject).formInputs,
    asObject(payload.action).formInputs,
  ];
  return sources.reduce((count, source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      return count;
    }
    return count + Object.keys(source).length;
  }, 0);
}

function actionMethod(payload) {
  const common = asObject(payload.common);
  const commonEventObject = asObject(payload.commonEventObject);
  const action = asObject(payload.action);
  const slashCommand = asObject(asObject(payload.message).slashCommand);
  return (
    common.invokedFunction ??
    commonEventObject.invokedFunction ??
    action.actionMethodName ??
    slashCommand.commandName ??
    null
  );
}

export function recordChatFixture(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Expected a Google Chat payload object to record.");
  }

  const state = makeRedactionState();
  const redactedPayload = redactValue(payload, "payload", state);
  const eventType = payload.type ?? payload.eventType ?? payload.commonEventObject?.hostApp ?? null;
  const idMaterial = JSON.stringify({
    eventType,
    eventTime: payload.eventTime ?? payload.time ?? null,
    keys: Object.keys(payload).sort(),
  });

  return {
    kind: "chat.evidence_recorded_fixture",
    fixtureId: options.fixtureId ?? `recorded-${hashText(idMaterial).slice(0, 16)}`,
    recordedAt: options.recordedAt ?? new Date(0).toISOString(),
    receivedAt: options.receivedAt ?? payload.eventTime ?? payload.time ?? null,
    payload: redactedPayload,
    structure: {
      topLevelKeys: Object.keys(payload).sort(),
      eventType,
      hasMessage: Boolean(payload.message),
      attachmentCount: attachmentCount(payload),
      formInputCount: formInputCount(payload),
      actionMethod: actionMethod(payload),
      authAvailable: Boolean(
        payload.authorization ??
          payload.auth ??
          payload.commonEventObject?.userLocale ??
          payload.common?.userLocale,
      ),
    },
    redaction: {
      strategy: "replayable_placeholders",
      counts: state,
      removedRawValues: [
        "tokens",
        "message_text",
        "sender_emails",
        "form_values",
        "private_urls",
        "attachment_bytes",
      ],
    },
    privacy: evidencePrivacy(),
  };
}

async function loadNodeSdk() {
  return import(pathToFileURL(path.join(repoRoot, "packages/node/dist/index.js")).href);
}

function normalizeSummary(normalized) {
  const message = normalized.message ?? null;
  const plainText = typeof message?.plainText === "string" ? message.plainText : "";
  return {
    eventId: normalized.eventId ?? null,
    kind: normalized.kind ?? null,
    source: normalized.source ?? null,
    receivedAt: normalized.receivedAt ?? null,
    actorAvailable: normalized.actor?.access?.status === "available",
    message: message
      ? {
          hasMessage: true,
          nameAvailable: Boolean(message.name),
          plainTextLength: plainText.length,
          plainTextHash: plainText ? hashText(plainText) : null,
          attachmentCount: Array.isArray(message.attachments) ? message.attachments.length : 0,
        }
      : { hasMessage: false },
    relationship: {
      isThreadReply: Boolean(normalized.relationship?.isThreadReply),
      isDeletion: Boolean(normalized.relationship?.isDeletion),
      systemNoteCount: Array.isArray(normalized.relationship?.systemNotes)
        ? normalized.relationship.systemNotes.length
        : 0,
    },
  };
}

function normalizeWithPython(payload, receivedAt) {
  const code = `
import json
import sys
from googlechatai import normalize_event

request = json.loads(sys.stdin.read())
options = {"source": "fixture"}
if request.get("receivedAt"):
    options["received_at"] = request["receivedAt"]
normalized = normalize_event(request["payload"], **options)
print(json.dumps(normalized, sort_keys=True))
`;
  const stdout = execFileSync("python3", ["-c", code], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONPATH: path.join(repoRoot, "packages/python/src"),
    },
    input: JSON.stringify({ payload, receivedAt }),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return JSON.parse(stdout);
}

export async function replayRecordedFixture(recorded) {
  if (!recorded || typeof recorded !== "object" || !recorded.payload) {
    throw new TypeError("Expected a recorded Chat evidence fixture.");
  }

  const sdk = await loadNodeSdk();
  const receivedAt = recorded.receivedAt ?? null;
  const node = sdk.normalizeEvent(recorded.payload, {
    source: "fixture",
    ...(receivedAt ? { receivedAt } : {}),
  });
  const python = normalizeWithPython(recorded.payload, receivedAt);
  const nodePythonEqual = isDeepStrictEqual(node, python);

  return {
    ok: nodePythonEqual,
    kind: "chat.evidence_replay_result",
    fixtureId: recorded.fixtureId ?? null,
    nodePythonEqual,
    node: normalizeSummary(node),
    python: normalizeSummary(python),
    hashes: {
      node: hashText(JSON.stringify(node)),
      python: hashText(JSON.stringify(python)),
    },
    privacy: {
      rawPayloadSaved: false,
      rawNormalizedOutputSaved: false,
    },
  };
}

function runChildCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function summarizeCommandResult(commandPlan, result) {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    id: commandPlan.id,
    command: commandPlan.command,
    status: result.status,
    signal: result.signal ?? null,
    ok: result.status === 0,
    stdout: {
      length: stdout.length,
      sha256: hashText(stdout),
    },
    stderr: {
      length: stderr.length,
      sha256: hashText(stderr),
    },
  };
}

export async function runEvidenceTool(
  config,
  {
    runCommand = runChildCommand,
    readFile = fs.readFile,
    writeFile = fs.writeFile,
    mkdir = fs.mkdir,
  } = {},
) {
  if (config.help) {
    return { ok: true, kind: "chat.evidence_help", usage: usageText() };
  }

  if (config.command === "collect") {
    const plan = buildEvidenceCollectPlan(config);
    if (config.dryRun) {
      return plan;
    }

    const commandResults = [];
    for (const commandPlan of plan.commands) {
      const result = await runCommand(commandPlan.command, commandPlan.args, {
        cwd: config.cwd,
        env: commandPlan.env,
      });
      commandResults.push(summarizeCommandResult(commandPlan, result));
    }

    const output = {
      ok: commandResults.every((result) => result.ok),
      kind: "chat.evidence_collection",
      mode: config.mode,
      runId: config.runId,
      project: config.project,
      service: config.service,
      since: config.since,
      until: config.until,
      commands: commandResults,
      privacy: evidencePrivacy(),
    };

    if (config.evidencePath) {
      await mkdir(path.dirname(config.evidencePath), { recursive: true });
      await writeFile(config.evidencePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
      output.evidencePath = config.evidencePath;
    }

    return output;
  }

  if (config.command === "record") {
    if (!config.inputPath) {
      throw new Error("record requires --input.");
    }
    const input = JSON.parse(await readFile(config.inputPath, "utf8"));
    const recorded = recordChatFixture(input);
    if (config.outputPath) {
      await mkdir(path.dirname(config.outputPath), { recursive: true });
      await writeFile(config.outputPath, `${JSON.stringify(recorded, null, 2)}\n`, "utf8");
      recorded.outputPath = config.outputPath;
    }
    return recorded;
  }

  if (!config.fixturePath) {
    throw new Error("replay requires --fixture.");
  }
  const recorded = JSON.parse(await readFile(config.fixturePath, "utf8"));
  return replayRecordedFixture(recorded);
}

function usageText() {
  return `Usage:
  pnpm chat:evidence collect -- --dry-run --since 10m
  RUN_LIVE_CHAT_EVIDENCE=1 pnpm chat:evidence collect -- --since 2026-07-04T12:00:00Z
  pnpm chat:evidence record -- --input raw-event.local.json --output fixtures/live/evidence/event.recorded.json
  pnpm chat:evidence replay -- --fixture fixtures/live/evidence/event.recorded.json

The recorder writes redacted, replayable fixtures. It never stores raw tokens,
raw message text, sender emails, form values, private URLs, or attachment bytes.`;
}

function formatSummary(result) {
  if (result.kind === "chat.evidence_collect_plan") {
    return [
      `Evidence collection: ${result.mode}`,
      `Run id: ${result.runId}`,
      `Window: ${result.since}${result.until ? ` to ${result.until}` : ""}`,
      `Commands: ${result.commands.map((command) => command.id).join(", ")}`,
      "Privacy: raw tokens/text/emails/form values/attachment bytes are not saved.",
    ].join("\n");
  }

  if (result.kind === "chat.evidence_replay_result") {
    return [
      `Evidence replay: ${result.nodePythonEqual ? "PASS" : "FAIL"}`,
      `Fixture: ${result.fixtureId}`,
      `Kind: ${result.node.kind}`,
      `Node hash: ${result.hashes.node}`,
      `Python hash: ${result.hashes.python}`,
    ].join("\n");
  }

  return JSON.stringify(result, null, 2);
}

async function main() {
  try {
    const config = resolveEvidenceConfig();
    const result = await runEvidenceTool(config);
    if (config.format === "summary") {
      process.stdout.write(`${formatSummary(result)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    if (result.ok === false) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
