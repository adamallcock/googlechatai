import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

// The packaged public CLI will ship with the googlechatai packages (see
// AGENTS.md "Publishing Boundary"). Until then this dispatcher is only
// reachable in-repo via `corepack pnpm cli <command>`.
export const COMMAND_TABLE = [
  {
    name: "doctor",
    script: "tools/chat/doctor.mjs",
    description: "Run guarded Chat/Cloud diagnostics (see chat:doctor).",
    requiresBuild: true,
  },
  {
    name: "card-lint",
    script: "tools/chat/card-lint.mjs",
    description: "Lint or translate a Chat card/message payload.",
    requiresBuild: true,
  },
  {
    name: "evidence",
    script: "tools/chat/evidence.mjs",
    description: "Inspect or replay redacted live-smoke evidence records.",
    requiresBuild: true,
  },
  {
    name: "discovery-check",
    script: "tools/discovery/check-methods.mjs",
    description: "Diff the live Google Chat discovery document against the curated snapshot.",
    requiresBuild: false,
  },
  {
    name: "discovery-drift",
    script: "tools/discovery/check-live-drift.mjs",
    description: "Same as discovery-check, with --json and drift-only exit codes for CI.",
    requiresBuild: false,
  },
];

/**
 * Resolve a command name to its table entry. Pure lookup, no I/O — kept
 * separate from process spawning so it is easy to unit test.
 */
export function resolveCommand(name, table = COMMAND_TABLE) {
  return table.find((command) => command.name === name) ?? null;
}

/**
 * Split argv (as received by this script, i.e. after `node main.mjs`) into
 * the requested command name and the remaining args to pass through.
 */
export function splitArgv(argv) {
  const [command = null, ...rest] = argv;
  return { command, rest };
}

function usage(table = COMMAND_TABLE) {
  const commandLines = table
    .map((command) => `  ${command.name.padEnd(18)} ${command.description}`)
    .join("\n");

  return [
    "Usage: corepack pnpm cli <command> [-- <args>]",
    "",
    "Commands:",
    commandLines,
    "",
    "Note: the public googlechatai CLI ships when the packages are published;",
    "this dispatcher is an in-repo convenience entrypoint only.",
    "",
    "Run `corepack pnpm cli <command> -- --help` for a command's own options.",
  ].join("\n");
}

function spawnCommand(command, args, { cwd = repoRoot, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [command.script, ...args], {
      cwd,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        // Re-raise the same signal so shells/CI see a signal-style exit
        // rather than a misleading exit code of 0/null.
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export async function runCli({
  argv = process.argv.slice(2),
  table = COMMAND_TABLE,
  cwd = repoRoot,
  stdout = process.stdout,
  stderr = process.stderr,
  spawnImpl = spawn,
  runBuild = () => runPnpmBuild({ cwd, spawnImpl }),
} = {}) {
  const { command: commandName, rest } = splitArgv(argv);

  if (!commandName || commandName === "--help" || commandName === "-h") {
    stdout.write(`${usage(table)}\n`);
    return 0;
  }

  const command = resolveCommand(commandName, table);

  if (!command) {
    stderr.write(`Unknown command: ${commandName}\n\n${usage(table)}\n`);
    return 1;
  }

  if (command.requiresBuild) {
    const buildExitCode = await runBuild();
    if (buildExitCode !== 0) {
      return buildExitCode;
    }
  }

  return spawnCommand(command, rest, { cwd, spawnImpl });
}

function runPnpmBuild({ cwd, spawnImpl }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl("pnpm", ["build"], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
