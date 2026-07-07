import assert from "node:assert/strict";
import test from "node:test";

import { COMMAND_TABLE, resolveCommand, runCli, splitArgv } from "./main.mjs";

test("COMMAND_TABLE maps every documented command to an existing script path", () => {
  const names = COMMAND_TABLE.map((command) => command.name).sort();

  assert.deepEqual(names, [
    "card-lint",
    "discovery-check",
    "discovery-drift",
    "doctor",
    "evidence",
  ]);

  for (const command of COMMAND_TABLE) {
    assert.equal(typeof command.script, "string");
    assert.equal(typeof command.description, "string");
    assert.equal(typeof command.requiresBuild, "boolean");
  }
});

test("resolveCommand finds a command by name", () => {
  const command = resolveCommand("doctor");
  assert.ok(command);
  assert.equal(command.script, "tools/chat/doctor.mjs");
  assert.equal(command.requiresBuild, true);
});

test("resolveCommand returns null for an unknown name", () => {
  assert.equal(resolveCommand("does-not-exist"), null);
});

test("resolveCommand looks up against a custom table", () => {
  const table = [{ name: "custom", script: "tools/x.mjs", description: "", requiresBuild: false }];
  assert.equal(resolveCommand("doctor", table), null);
  assert.equal(resolveCommand("custom", table)?.script, "tools/x.mjs");
});

test("splitArgv separates the command name from passthrough args", () => {
  assert.deepEqual(splitArgv(["doctor", "--dry-run", "--format", "summary"]), {
    command: "doctor",
    rest: ["--dry-run", "--format", "summary"],
  });
});

test("splitArgv handles an empty argv", () => {
  assert.deepEqual(splitArgv([]), { command: null, rest: [] });
});

test("splitArgv handles a command with no trailing args", () => {
  assert.deepEqual(splitArgv(["discovery-check"]), {
    command: "discovery-check",
    rest: [],
  });
});

function collectWrites() {
  const chunks = [];
  return {
    chunks,
    stream: { write: (chunk) => chunks.push(String(chunk)) },
  };
}

test("runCli prints the command list and descriptions for --help", async () => {
  const stdout = collectWrites();
  const stderr = collectWrites();

  const exitCode = await runCli({
    argv: ["--help"],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 0);
  const text = stdout.chunks.join("");
  assert.match(text, /doctor/);
  assert.match(text, /card-lint/);
  assert.match(text, /evidence/);
  assert.match(text, /discovery-check/);
  assert.match(text, /discovery-drift/);
  assert.match(text, /googlechatai CLI ships when the packages are published/);
  assert.deepEqual(stderr.chunks, []);
});

test("runCli prints the command list for empty argv (no-arg invocation)", async () => {
  const stdout = collectWrites();

  const exitCode = await runCli({ argv: [], stdout: stdout.stream, stderr: collectWrites().stream });

  assert.equal(exitCode, 0);
  assert.match(stdout.chunks.join(""), /Usage: corepack pnpm cli/);
});

test("runCli reports an error and exits 1 for an unknown command", async () => {
  const stdout = collectWrites();
  const stderr = collectWrites();

  const exitCode = await runCli({
    argv: ["not-a-real-command"],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.chunks.join(""), /Unknown command: not-a-real-command/);
});

test("runCli spawns the resolved script with passthrough args and propagates exit code", async () => {
  const spawnCalls = [];
  const stdout = collectWrites();

  function fakeSpawn(command, args, options) {
    spawnCalls.push({ command, args, options });
    return {
      on(event, handler) {
        if (event === "exit") {
          queueMicrotask(() => handler(0, null));
        }
      },
    };
  }

  const exitCode = await runCli({
    argv: ["discovery-check", "--json"],
    stdout: stdout.stream,
    stderr: collectWrites().stream,
    spawnImpl: fakeSpawn,
  });

  assert.equal(exitCode, 0);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].args[0], "tools/discovery/check-methods.mjs");
  assert.deepEqual(spawnCalls[0].args.slice(1), ["--json"]);
});

test("runCli propagates a non-zero exit code from the spawned script", async () => {
  function fakeSpawn() {
    return {
      on(event, handler) {
        if (event === "exit") {
          queueMicrotask(() => handler(1, null));
        }
      },
    };
  }

  const exitCode = await runCli({
    argv: ["discovery-drift"],
    stdout: collectWrites().stream,
    stderr: collectWrites().stream,
    spawnImpl: fakeSpawn,
  });

  assert.equal(exitCode, 1);
});

test("runCli runs the build step before spawning a requiresBuild command, and skips the script on build failure", async () => {
  const spawnCalls = [];
  let buildCalls = 0;

  function fakeSpawn(command, args) {
    spawnCalls.push({ command, args });
    return {
      on(event, handler) {
        if (event === "exit") {
          queueMicrotask(() => handler(0, null));
        }
      },
    };
  }

  const exitCode = await runCli({
    argv: ["doctor", "--dry-run"],
    stdout: collectWrites().stream,
    stderr: collectWrites().stream,
    spawnImpl: fakeSpawn,
    runBuild: async () => {
      buildCalls += 1;
      return 1;
    },
  });

  assert.equal(buildCalls, 1);
  assert.equal(exitCode, 1);
  assert.equal(spawnCalls.length, 0, "the target script should not run when the build fails");
});

test("runCli does not invoke the build step for commands that do not require it", async () => {
  let buildCalls = 0;

  function fakeSpawn() {
    return {
      on(event, handler) {
        if (event === "exit") {
          queueMicrotask(() => handler(0, null));
        }
      },
    };
  }

  await runCli({
    argv: ["discovery-check"],
    stdout: collectWrites().stream,
    stderr: collectWrites().stream,
    spawnImpl: fakeSpawn,
    runBuild: async () => {
      buildCalls += 1;
      return 0;
    },
  });

  assert.equal(buildCalls, 0);
});
