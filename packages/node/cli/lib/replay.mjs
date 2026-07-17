import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { normalizeEvent } from "../../dist/index.js";

import {
  CliUsageError,
  assertOnlyOptions,
  normalizedFormat,
  parseCommandArgs,
  readJsonFile,
  resolvePath,
  responseBodyContainsText,
  safeEvent,
  writeJson,
} from "./common.mjs";

async function responseJson(response) {
  if (!response || typeof response.text !== "function") {
    throw new TypeError("Node handler chat.handlePayload() must return a Response.");
  }
  const text = await response.text();
  return text === "" ? null : JSON.parse(text);
}

async function replayNode(handlerPath, payload) {
  const moduleUrl = `${pathToFileURL(handlerPath).href}?googlechatai_replay=${Date.now()}`;
  const handlerModule = await import(moduleUrl);
  const chat = handlerModule.chat;
  if (!chat || typeof chat.handlePayload !== "function") {
    throw new TypeError("Node handler module must export `chat` with handlePayload().");
  }
  return responseJson(await chat.handlePayload(payload));
}

function replayPython(handlerPath, fixturePath, options, context) {
  const python =
    options.python ??
    context.env.GOOGLECHATAI_PYTHON ??
    (process.platform === "win32" ? "python" : "python3");
  const runner = fileURLToPath(
    new URL("../runners/python-replay.py", import.meta.url),
  );
  const spawned = (context.spawnSync ?? spawnSync)(
    python,
    [runner, handlerPath, fixturePath],
    {
      cwd: context.cwd,
      encoding: "utf8",
      env: context.env,
    },
  );
  if (spawned.error) {
    throw new Error(`Unable to start ${python}: ${spawned.error.message}`);
  }
  if (spawned.status !== 0) {
    throw new Error(
      `Python replay failed with exit code ${spawned.status}: ${spawned.stderr?.trim() || "no error output"}`,
    );
  }
  try {
    return JSON.parse(spawned.stdout);
  } catch (error) {
    throw new Error(`Python replay returned invalid JSON: ${error.message}`);
  }
}

function renderSummary(result) {
  return [
    `Replay: ${result.language}`,
    `Event: ${result.event.kind}`,
    `Handler: ${result.handler ?? "normalization only"}`,
    `Response assertion: ${result.assertion?.ok === false ? "failed" : result.assertion ? "passed" : "not requested"}`,
    result.response === null
      ? "Response: none"
      : `Response: ${JSON.stringify(result.response)}`,
  ].join("\n");
}

export async function runReplayCommand(args, context) {
  const { options, positionals } = parseCommandArgs(args, {
    booleanFlags: ["include-raw", "help"],
  });
  assertOnlyOptions(options, [
    "input",
    "handler",
    "language",
    "python",
    "source",
    "format",
    "expect-text",
    "include-raw",
    "help",
  ]);

  if (options.help) {
    context.stdout.write(
      [
        "Usage: googlechatai replay <fixture.json> [--handler app.mjs|app.py]",
        "       [--language node|python] [--python /path/to/python]",
        "       [--expect-text TEXT] [--format summary|json]",
        "",
        "Without --handler, replay validates and normalizes the fixture only.",
      ].join("\n") + "\n",
    );
    return { exitCode: 0, result: null };
  }

  const inputPath = options.input ?? positionals[0];
  if (!inputPath || positionals.length > 1) {
    throw new CliUsageError("replay requires exactly one fixture JSON file.");
  }
  const language = options.language ?? "node";
  if (!["node", "python"].includes(language)) {
    throw new CliUsageError("--language must be node or python.");
  }
  if (language === "python" && !options.handler) {
    throw new CliUsageError("Python replay requires --handler.");
  }
  const format = normalizedFormat(options.format);
  const source = options.source ?? "fixture";
  const { filePath, value } = await readJsonFile(inputPath, context.cwd, "fixture");
  const event = normalizeEvent(value, { source });
  const handlerPath = resolvePath(options.handler, context.cwd);
  let response = null;

  if (handlerPath) {
    response =
      language === "node"
        ? await replayNode(handlerPath, value)
        : replayPython(handlerPath, filePath, options, context);
  }

  const expected = options["expect-text"];
  const assertion = expected
    ? {
        expectedText: expected,
        ok: responseBodyContainsText(response, expected),
      }
    : null;
  const result = {
    kind: "googlechatai.replay_result",
    language,
    fixture: filePath,
    handler: handlerPath,
    event: safeEvent(event, { includeRaw: options["include-raw"] === true }),
    response,
    assertion,
  };

  if (format === "json") {
    writeJson(context.stdout, result);
  } else {
    context.stdout.write(`${renderSummary(result)}\n`);
  }
  return { exitCode: assertion?.ok === false ? 1 : 0, result };
}
