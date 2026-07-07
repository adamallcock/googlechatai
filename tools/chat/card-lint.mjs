import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

function parseArgs(argv) {
  const args = {
    input: null,
    surface: null,
    principal: null,
    format: "summary",
    translateTo: null,
    translationMode: null,
    baseUrl: null,
    allowNamedFunctions: false,
    help: false,
  };
  const rest = argv.slice(2);

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--") {
      continue;
    } else if (arg === "--input") {
      args.input = rest[++index];
    } else if (arg.startsWith("--input=")) {
      args.input = arg.slice("--input=".length);
    } else if (arg === "--surface") {
      args.surface = rest[++index];
    } else if (arg.startsWith("--surface=")) {
      args.surface = arg.slice("--surface=".length);
    } else if (arg === "--principal") {
      args.principal = rest[++index];
    } else if (arg.startsWith("--principal=")) {
      args.principal = arg.slice("--principal=".length);
    } else if (arg === "--format") {
      args.format = rest[++index];
    } else if (arg.startsWith("--format=")) {
      args.format = arg.slice("--format=".length);
    } else if (arg === "--translate-to") {
      args.translateTo = rest[++index];
    } else if (arg.startsWith("--translate-to=")) {
      args.translateTo = arg.slice("--translate-to=".length);
    } else if (arg === "--translation-mode") {
      args.translationMode = rest[++index];
    } else if (arg.startsWith("--translation-mode=")) {
      args.translationMode = arg.slice("--translation-mode=".length);
    } else if (arg === "--base-url") {
      args.baseUrl = rest[++index];
    } else if (arg.startsWith("--base-url=")) {
      args.baseUrl = arg.slice("--base-url=".length);
    } else if (arg === "--allow-named-functions") {
      args.allowNamedFunctions = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function cleanObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null),
  );
}

function resolveInputPath(input, cwd) {
  if (!input) {
    throw new Error("--input is required.");
  }
  return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}

async function loadDefaultSdk() {
  return import(pathToFileURL(path.join(repoRoot, "packages/node/dist/index.js")).href);
}

function renderSummary(result) {
  if (result.kind === "chat.card_translation_result") {
    const status = result.ok ? "ok" : "failed";
    return [
      `Card translation ${status}: ${result.from} -> ${result.to} (${result.mode})`,
      ...result.findings.map(
        (finding) =>
          `${finding.severity.toUpperCase()} ${finding.code} ${finding.path}: ${finding.message}`,
      ),
    ].join("\n");
  }

  const stats = result.stats ?? {};
  return [
    `Card lint ${result.ok ? "passed" : "failed"} for ${result.surface}: ${result.summary}`,
    `stats: cards=${stats.cards ?? 0} sections=${stats.sections ?? 0} widgets=${stats.widgets ?? 0} buttons=${stats.buttons ?? 0} bytes=${stats.bytes ?? 0}`,
    ...result.findings.map(
      (finding) =>
        `${finding.severity.toUpperCase()} ${finding.code} ${finding.path}: ${finding.message}`,
    ),
  ].join("\n");
}

export async function runCardLintCli({
  argv = process.argv,
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  sdk = null,
} = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return { exitCode: 2, result: null };
  }

  if (args.help) {
    stdout.write(
      [
        "Usage: pnpm chat:card-lint -- --input <json> --surface <profile>",
        "",
        "Profiles: chat-message, direct-chat-response, chat-dialog-response, workspace-addon-action-response, dialogflow-custom-payload",
        "Options:",
        "  --format summary|json",
        "  --translate-to <profile>",
        "  --translation-mode create-message|update-message|open-dialog",
        "  --principal app|user",
        "  --base-url <url>",
        "  --allow-named-functions",
      ].join("\n") + "\n",
    );
    return { exitCode: 0, result: null };
  }

  if (!args.surface) {
    stderr.write("--surface is required.\n");
    return { exitCode: 2, result: null };
  }
  if (!["summary", "json"].includes(args.format)) {
    stderr.write("--format must be summary or json.\n");
    return { exitCode: 2, result: null };
  }

  let payload;
  try {
    payload = JSON.parse(
      await fs.readFile(resolveInputPath(args.input, cwd), "utf8"),
    );
  } catch (error) {
    stderr.write(`Unable to read JSON input: ${error.message}\n`);
    return { exitCode: 2, result: null };
  }

  const activeSdk = sdk ?? (await loadDefaultSdk());
  const result = args.translateTo
    ? activeSdk.translateCardPayload(
        payload,
        cleanObject({
          from: args.surface,
          to: args.translateTo,
          mode: args.translationMode,
          baseUrl: args.baseUrl,
        }),
      )
    : activeSdk.lintCardPayload(
        payload,
        cleanObject({
          surface: args.surface,
          principal: args.principal,
          baseUrl: args.baseUrl,
          allowNamedFunctions: args.allowNamedFunctions ? true : undefined,
        }),
      );

  if (args.format === "json") {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    stdout.write(`${renderSummary(result)}\n`);
  }

  return { exitCode: result.ok ? 0 : 1, result };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { exitCode } = await runCardLintCli();
  process.exitCode = exitCode;
}
