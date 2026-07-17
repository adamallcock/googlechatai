#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { CliUsageError } from "./lib/common.mjs";
import { runInitCommand } from "./lib/init.mjs";
import { runInspectCommand } from "./lib/inspect.mjs";
import { runReplayCommand } from "./lib/replay.mjs";
import { runPlanCommand } from "./lib/plan.mjs";
import { runCardCommand } from "./lib/card.mjs";
import { runDoctorCommand } from "./lib/doctor.mjs";
import { runSmokeCommand } from "./lib/smoke.mjs";

const packageRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const packageMetadata = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);

const COMMANDS = new Map([
  ["init", runInitCommand],
  ["inspect", runInspectCommand],
  ["replay", runReplayCommand],
  ["plan", runPlanCommand],
  ["card", runCardCommand],
  ["doctor", runDoctorCommand],
  ["smoke", runSmokeCommand],
]);

function usage() {
  return [
    "googlechatai — build, inspect, test, and diagnose Google Chat apps",
    "",
    "Usage: googlechatai <command> [options]",
    "",
    "Commands:",
    "  init       Scaffold a minimal Node or Python Chat app",
    "  doctor     Diagnose local setup, auth, endpoint, and smoke configuration",
    "  inspect    Normalize an event and show reply/context decisions",
    "  replay     Run a sanitized fixture through a Node or Python handler",
    "  plan       Print an exact dry-run Chat API intent plan",
    "  card lint  Validate a Google Chat card or action response",
    "  smoke      Prove mention delivery and thread routing in a dedicated smoke space",
    "",
    "All commands are offline or read-only by default. `smoke --live` is the only",
    "write-capable command and requires explicit environment and metadata guards.",
    "",
    "Run `googlechatai <command> --help` for command-specific options.",
  ].join("\n");
}

export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  spawnSyncImpl = spawnSync,
  now = () => Date.now(),
  randomUUID,
} = {}) {
  const [commandName, ...rest] = argv;
  if (!commandName || commandName === "--help" || commandName === "-h") {
    stdout.write(`${usage()}\n`);
    return 0;
  }
  if (commandName === "--version" || commandName === "-v") {
    stdout.write(`${packageMetadata.version}\n`);
    return 0;
  }

  let effectiveCommand = commandName;
  let effectiveArgs = rest;
  if (commandName === "card-lint") {
    effectiveCommand = "card";
    effectiveArgs = ["lint", ...rest];
  }

  const command = COMMANDS.get(effectiveCommand);
  if (!command) {
    stderr.write(`Unknown command: ${commandName}\n\n${usage()}\n`);
    return 2;
  }

  try {
    const outcome = await command(effectiveArgs, {
      cwd,
      env,
      stdout,
      stderr,
      fetch: fetchImpl,
      sleep,
      spawnSync: spawnSyncImpl,
      now,
      randomUUID,
      packageRoot,
      version: packageMetadata.version,
    });
    return outcome.exitCode;
  } catch (error) {
    const prefix = error instanceof CliUsageError ? "Usage error" : "Command failed";
    stderr.write(`${prefix}: ${error.message}\n`);
    return error instanceof CliUsageError ? 2 : 1;
  }
}

function isExecutedModule(moduleUrl, argvEntry) {
  if (!argvEntry) {
    return false;
  }
  try {
    return (
      fs.realpathSync(fileURLToPath(moduleUrl)) ===
      fs.realpathSync(path.resolve(argvEntry))
    );
  } catch {
    return moduleUrl === pathToFileURL(argvEntry).href;
  }
}

if (isExecutedModule(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli();
}
