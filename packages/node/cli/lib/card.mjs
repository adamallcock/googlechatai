import { lintCardPayload } from "../../dist/index.js";

import {
  CliUsageError,
  assertOnlyOptions,
  normalizedFormat,
  parseCommandArgs,
  readJsonFile,
  writeJson,
} from "./common.mjs";

function renderSummary(result) {
  return [
    `Card lint ${result.ok ? "passed" : "failed"} for ${result.surface}`,
    result.summary,
    ...(result.findings ?? []).map(
      (finding) =>
        `${String(finding.severity).toUpperCase()} ${finding.code} ${finding.path}: ${finding.message}`,
    ),
  ].join("\n");
}

export async function runCardCommand(args, context) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    context.stdout.write(
      [
        "Usage: googlechatai card lint <payload.json> [--surface chat-message]",
        "       [--principal app|user] [--format summary|json]",
      ].join("\n") + "\n",
    );
    return { exitCode: 0, result: null };
  }
  if (subcommand !== "lint") {
    throw new CliUsageError(`Unknown card command: ${subcommand}`);
  }

  const { options, positionals } = parseCommandArgs(rest, {
    booleanFlags: ["allow-named-functions", "help"],
  });
  assertOnlyOptions(options, [
    "input",
    "surface",
    "principal",
    "base-url",
    "allow-named-functions",
    "format",
    "help",
  ]);
  if (options.help) {
    context.stdout.write(
      "Usage: googlechatai card lint <payload.json> [--surface chat-message]\n",
    );
    return { exitCode: 0, result: null };
  }
  const inputPath = options.input ?? positionals[0];
  if (!inputPath || positionals.length > 1) {
    throw new CliUsageError("card lint requires exactly one JSON payload.");
  }
  const format = normalizedFormat(options.format);
  const { value } = await readJsonFile(inputPath, context.cwd, "card payload");
  const result = lintCardPayload(value, {
    surface: options.surface ?? "chat-message",
    ...(options.principal ? { principal: options.principal } : {}),
    ...(options["base-url"] ? { baseUrl: options["base-url"] } : {}),
    ...(options["allow-named-functions"] === true
      ? { allowNamedFunctions: true }
      : {}),
  });

  if (format === "json") {
    writeJson(context.stdout, result);
  } else {
    context.stdout.write(`${renderSummary(result)}\n`);
  }
  return { exitCode: result.ok ? 0 : 1, result };
}
