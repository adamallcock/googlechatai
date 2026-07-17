import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { runCli } from "../../packages/node/cli/index.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const packageVersion = JSON.parse(
  await fs.readFile(path.join(root, "packages/node/package.json"), "utf8"),
).version;

function collectWrites() {
  const chunks = [];
  return {
    chunks,
    stream: {
      write(chunk) {
        chunks.push(String(chunk));
      },
    },
    text() {
      return chunks.join("");
    },
  };
}

async function tempDirectory(t, prefix = "googlechatai-public-cli-") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function run(args, overrides = {}) {
  const stdout = collectWrites();
  const stderr = collectWrites();
  const exitCode = await runCli({
    argv: args,
    stdout: stdout.stream,
    stderr: stderr.stream,
    ...overrides,
  });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

test("public CLI help exposes the complete beta workflow", async () => {
  const result = await run(["--help"]);
  assert.equal(result.exitCode, 0);
  for (const command of [
    "init",
    "doctor",
    "inspect",
    "replay",
    "plan",
    "card lint",
    "smoke",
  ]) {
    assert.match(result.stdout, new RegExp(command.replace(" ", "\\s+")));
  }
  assert.match(result.stdout, /offline or read-only by default/);
});

test("init creates a complete Node scaffold and protects non-empty targets", async (t) => {
  const directory = await tempDirectory(t);
  const target = path.join(directory, "node-bot");
  const result = await run(["init", target, "--language", "node"], {
    cwd: directory,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  for (const file of [
    "package.json",
    ".env.example",
    ".gitignore",
    "README.md",
    "src/app.mjs",
    "src/server.mjs",
    "fixtures/card.json",
    "fixtures/mention.json",
    "smoke-space.example.json",
    "test/app.test.mjs",
  ]) {
    assert.equal(await fs.stat(path.join(target, file)).then(() => true), true);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf8"));
  assert.equal(manifest.name, "node-bot");
  assert.equal(manifest.dependencies.googlechatai, packageVersion);

  const refused = await run(["init", target, "--language", "node"], {
    cwd: directory,
  });
  assert.equal(refused.exitCode, 2);
  assert.match(refused.stderr, /not empty/);
});

test("init creates a Python scaffold with verified-server and fixture boundaries", async (t) => {
  const directory = await tempDirectory(t);
  const target = path.join(directory, "python-bot");
  const result = await run(["init", target, "--language", "python"], {
    cwd: directory,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  const requirements = await fs.readFile(path.join(target, "requirements.txt"), "utf8");
  const server = await fs.readFile(path.join(target, "server.py"), "utf8");
  assert.equal(requirements.trim(), `googlechatai==${packageVersion}`);
  assert.match(server, /create_google_chat_token_verifier/);
  assert.match(server, /GOOGLE_CHAT_PROJECT_NUMBER is required/);
  assert.equal(
    await fs.stat(path.join(target, "smoke-space.example.json")).then(() => true),
    true,
  );
  assert.equal(
    await fs.stat(path.join(target, "fixtures/card.json")).then(() => true),
    true,
  );
});

test("init preflights template destinations and refuses symbolic-link traversal", async (t) => {
  const directory = await tempDirectory(t);
  const target = path.join(directory, "target");
  const outside = path.join(directory, "outside");
  await fs.mkdir(target);
  await fs.mkdir(outside);
  try {
    await fs.symlink(outside, path.join(target, "src"), "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip(`Symbolic links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const result = await run([
    "init",
    target,
    "--language",
    "node",
    "--force",
  ], { cwd: directory });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /symbolic link/i);
  await assert.rejects(fs.stat(path.join(outside, "app.mjs")), {
    code: "ENOENT",
  });
  await assert.rejects(fs.stat(path.join(target, "README.md")), {
    code: "ENOENT",
  });
});

test("Python init forwards the selected interpreter and environment to installation", async (t) => {
  const directory = await tempDirectory(t);
  const target = path.join(directory, "python-install");
  const calls = [];
  const env = {
    ...process.env,
    GOOGLECHATAI_PYTHON: "selected-python",
    GOOGLECHATAI_TEST_MARKER: "present",
  };
  const result = await run([
    "init",
    target,
    "--language",
    "python",
    "--install",
  ], {
    cwd: directory,
    env,
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(calls[0].command, "selected-python");
  assert.deepEqual(calls[0].args, ["-m", "venv", ".venv"]);
  assert.equal(calls[0].options.env.GOOGLECHATAI_TEST_MARKER, "present");
  assert.match(calls[1].command, /\.venv[/\\].*python(?:\.exe)?$/);
});

test("inspect reports normalized event, reply routing, and model context without raw payloads", async () => {
  const result = await run([
    "inspect",
    "fixtures/events/message-created/mentioned-app.json",
    "--format",
    "json",
  ], { cwd: root });

  assert.equal(result.exitCode, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.event.kind, "message.mentioned_app");
  assert.equal(parsed.replyTarget.route, "thread");
  assert.equal(parsed.modelContext.kind, "chat.model_context");
  assert.equal("raw" in parsed.event, false);
});

test("inspect rejects malformed JSON with a concise usage failure", async (t) => {
  const directory = await tempDirectory(t);
  const file = path.join(directory, "bad.json");
  await fs.writeFile(file, "{not-json", "utf8");
  const result = await run(["inspect", file], { cwd: directory });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /not valid JSON/);
});

test("replay executes a Node handler and enforces the response assertion", async (t) => {
  const directory = await tempDirectory(t);
  const handler = path.join(directory, "app.mjs");
  const sdk = pathToFileURL(path.join(root, "packages/node/dist/index.js")).href;
  await fs.writeFile(
    handler,
    [
      `import { GoogleChatAI } from ${JSON.stringify(sdk)};`,
      "export const chat = new GoogleChatAI({ source: 'fixture' });",
      "chat.onMention((_event, ctx) => ctx.reply.text('node replay ok'));",
      "",
    ].join("\n"),
    "utf8",
  );
  const result = await run([
    "replay",
    path.join(root, "fixtures/events/message-created/mentioned-app.json"),
    "--handler",
    handler,
    "--expect-text",
    "replay ok",
    "--format",
    "json",
  ], { cwd: directory });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).response, { text: "node replay ok" });

  const mismatch = await run([
    "replay",
    path.join(root, "fixtures/events/message-created/mentioned-app.json"),
    "--handler",
    handler,
    "--expect-text",
    "missing",
  ], { cwd: directory });
  assert.equal(mismatch.exitCode, 1);
});

test("replay executes a Python handler through the selected interpreter", async (t) => {
  const directory = await tempDirectory(t);
  const sourceDirectory = path.join(directory, "source files");
  await fs.mkdir(sourceDirectory);
  const handler = path.join(sourceDirectory, "app.py");
  await fs.writeFile(
    path.join(sourceDirectory, "reply_helper.py"),
    "REPLY_TEXT = 'python replay ok'\n",
    "utf8",
  );
  await fs.writeFile(
    handler,
    [
      "from googlechatai import GoogleChatAI",
      "from reply_helper import REPLY_TEXT",
      "chat = GoogleChatAI()",
      "@chat.on_mention",
      "def mention(ctx):",
      "    return {'text': REPLY_TEXT}",
      "",
    ].join("\n"),
    "utf8",
  );
  const pythonPath = path.join(root, "packages/python/src");
  const env = {
    ...process.env,
    PYTHONPATH: [pythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  };
  const result = await run([
    "replay",
    path.join(root, "fixtures/events/message-created/mentioned-app.json"),
    "--language",
    "python",
    "--handler",
    handler,
    "--expect-text",
    "python replay ok",
    "--format",
    "json",
  ], { cwd: directory, env });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).response, { text: "python replay ok" });
});

test("plan prints exact reply requests and rejects unknown intents", async () => {
  const planned = await run([
    "plan",
    "reply-to-event",
    "--event",
    "fixtures/events/message-created/mentioned-app.json",
    "--text",
    "Working on it",
    "--format",
    "json",
  ], { cwd: root });
  assert.equal(planned.exitCode, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.operation, "messages.replyToEvent");
  assert.equal(plan.requests[0].method, "POST");
  assert.equal(plan.safety.liveAllowed, false);

  const permission = await run([
    "plan",
    "permission",
    "messages.list",
    "--principal",
    "app",
    "--format",
    "json",
  ]);
  assert.equal(permission.exitCode, 0);
  assert.equal(JSON.parse(permission.stdout).kind, "chat.permission_plan");

  const unknown = await run(["plan", "invent-api", "--input", "x.json"]);
  assert.equal(unknown.exitCode, 2);
  assert.match(unknown.stderr, /Unknown plan intent/);
});

test("card lint exposes valid and invalid payload outcomes", async (t) => {
  const valid = await run([
    "card",
    "lint",
    "fixtures/expected/cards/builders/custom.message.json",
    "--format",
    "json",
  ], { cwd: root });
  assert.equal(valid.exitCode, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).ok, true);

  const directory = await tempDirectory(t);
  const invalidFile = path.join(directory, "invalid-card.json");
  await fs.writeFile(
    invalidFile,
    JSON.stringify({ cardsV2: [{ card: { sections: [{ widgets: [{ buttonList: {} }] }] } }] }),
    "utf8",
  );
  const invalid = await run(["card-lint", invalidFile, "--format", "json"], {
    cwd: directory,
  });
  assert.equal(invalid.exitCode, 1);
  assert.equal(JSON.parse(invalid.stdout).ok, false);
});

test("doctor reports actionable warnings, validates credentials without printing secrets, and fails malformed configuration", async (t) => {
  const directory = await tempDirectory(t);
  await fs.writeFile(path.join(directory, "package.json"), '{"private":true}\n', "utf8");
  const credential = path.join(directory, "service-account.json");
  const privateKey = "PRIVATE SECRET MATERIAL";
  await fs.writeFile(
    credential,
    JSON.stringify({
      type: "service_account",
      project_id: "example",
      client_email: "app@example.invalid",
      private_key: privateKey,
    }),
    "utf8",
  );
  const env = {
    ...process.env,
    GOOGLE_CHAT_PROJECT_NUMBER: "123456789",
    GOOGLE_CHAT_APP_USER: "users/app",
    GOOGLE_APPLICATION_CREDENTIALS: credential,
    GOOGLE_CHAT_ENDPOINT_URL: "https://example.invalid/chat/events",
    GOOGLE_CHAT_ENDPOINT_CONFIGURED: "1",
  };
  const result = await run(["doctor", "--format", "json"], {
    cwd: directory,
    env,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "warn");
  assert.doesNotMatch(result.stdout, new RegExp(privateKey));

  const invalid = await run(["doctor"], {
    cwd: directory,
    env: { ...env, GOOGLE_CHAT_PROJECT_NUMBER: "project-id" },
  });
  assert.equal(invalid.exitCode, 1);
  assert.match(invalid.stdout, /project number/i);
});

test("smoke is a redacted dry run by default and refuses unguarded live writes", async () => {
  const dryRun = await run([
    "smoke",
    "--metadata",
    "fixtures/live/chat-smoke-space.example.json",
    "--format",
    "json",
  ], { cwd: root });
  assert.equal(dryRun.exitCode, 0, dryRun.stderr);
  const plan = JSON.parse(dryRun.stdout);
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.privacy.messageTextPrinted, false);
  assert.equal(
    plan.requiredScopes.includes(
      "https://www.googleapis.com/auth/chat.spaces.readonly",
    ),
    true,
  );

  const refused = await run([
    "smoke",
    "--metadata",
    "fixtures/live/chat-smoke-space.example.json",
    "--live",
    "--app-user",
    "users/app",
  ], {
    cwd: root,
    env: {
      ...process.env,
      GOOGLE_CHAT_USER_ACCESS_TOKEN: "not-printed",
    },
  });
  assert.equal(refused.exitCode, 2);
  assert.match(refused.stderr, /RUN_LIVE_GOOGLECHATAI_SMOKE/);
  assert.doesNotMatch(refused.stderr, /not-printed/);
});

test("live smoke verifies the dedicated space, mention delivery, thread routing, and prompt cleanup", async () => {
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ?? null });
    if (calls.length === 1) {
      return jsonResponse({
        name: "spaces/EXAMPLE_SMOKE_SPACE",
        displayName: "Google Chat AI SDK Smoke Example",
        spaceType: "SPACE",
      });
    }
    if (calls.length === 2) {
      return jsonResponse({
        name: "spaces/EXAMPLE_SMOKE_SPACE/messages/prompt",
        thread: { name: "spaces/EXAMPLE_SMOKE_SPACE/threads/thread-1" },
      });
    }
    if (calls.length === 3) {
      return jsonResponse({
        messages: [
          {
            name: "spaces/EXAMPLE_SMOKE_SPACE/messages/reply",
            sender: { name: "users/app" },
            thread: { name: "spaces/EXAMPLE_SMOKE_SPACE/threads/thread-1" },
          },
        ],
      });
    }
    return new Response(null, { status: 204 });
  };
  const token = "super-secret-token";
  const result = await run([
    "smoke",
    "--metadata",
    "fixtures/live/chat-smoke-space.example.json",
    "--live",
    "--app-user",
    "users/app",
    "--format",
    "json",
  ], {
    cwd: root,
    env: {
      ...process.env,
      RUN_LIVE_GOOGLECHATAI_SMOKE: "1",
      GOOGLE_CHAT_USER_ACCESS_TOKEN: token,
      GOOGLE_CHAT_SMOKE_RUN_ID: "public-cli-test",
    },
    fetchImpl: fakeFetch,
    now: () => Date.parse("2026-07-16T12:00:00Z"),
    sleep: async () => {},
  });

  assert.equal(result.exitCode, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.correctThreadReply, true);
  assert.equal(parsed.promptCleanedUp, true);
  const listUrl = new URL(calls[2].url);
  assert.equal(listUrl.searchParams.get("orderBy"), "DESC");
  assert.match(
    listUrl.searchParams.get("filter"),
    /thread\.name = spaces\/EXAMPLE_SMOKE_SPACE\/threads\/thread-1/,
  );
  assert.equal(calls.at(-1).method, "DELETE");
  assert.doesNotMatch(result.stdout, new RegExp(token));
});

test("unknown public commands return a usage error", async () => {
  const result = await run(["does-not-exist"]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Unknown command/);
});
