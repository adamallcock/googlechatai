import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SMOKE_SPACE_PREFIX,
  buildLiveScopes,
  buildPlannedCalls,
  loadSmokeConfig,
  runChatSmoke,
} from "./chat-smoke.mjs";

async function writeMetadata(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-smoke-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "space.json");
  const metadata = {
    space: "spaces/AAAA-smoke",
    displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
    spaceType: "SPACE",
    customer: "customers/C01234567",
    safety: {
      dedicatedSmokeSpace: true,
      noDirectMessages: true,
      noRealUsersInvited: true,
    },
    ...overrides,
  };
  await fs.writeFile(file, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return file;
}

function smokeEnv(metadataPath, overrides = {}) {
  return {
    RUN_LIVE_CHAT_SMOKE: "1",
    GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
    GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
    GOOGLE_CHAT_SMOKE_RUN_ID: "smoke-test",
    ...overrides,
  };
}

test("loadSmokeConfig refuses to run without the explicit live-smoke guard", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadSmokeConfig({
        argv: ["node", "chat-smoke.mjs", "--dry-run"],
        env: {
          GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
          GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
        },
      }),
    /RUN_LIVE_CHAT_SMOKE=1/,
  );
});

test("loadSmokeConfig refuses non-space resource names before any API call", async (t) => {
  const metadataPath = await writeMetadata(t, { space: "users/ada" });

  await assert.rejects(
    () =>
      loadSmokeConfig({
        argv: ["node", "chat-smoke.mjs", "--dry-run"],
        env: smokeEnv(metadataPath, { GOOGLE_CHAT_TEST_SPACE: "users/ada" }),
      }),
    /GOOGLE_CHAT_TEST_SPACE must start with spaces\//,
  );
});

test("loadSmokeConfig requires metadata that documents a dedicated smoke space", async (t) => {
  const metadataPath = await writeMetadata(t, {
    displayName: "Production Team Room",
  });

  await assert.rejects(
    () =>
      loadSmokeConfig({
        argv: ["node", "chat-smoke.mjs", "--dry-run"],
        env: smokeEnv(metadataPath),
      }),
    /metadata displayName must start with Google Chat AI SDK Smoke/,
  );
});

test("dry-run planning names API calls without printing message bodies", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadSmokeConfig({
    argv: ["node", "chat-smoke.mjs", "--dry-run"],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_SMOKE_MESSAGE_TEXT: "secret payload that must not be printed",
    }),
  });

  const plan = buildPlannedCalls(config);
  const serialized = JSON.stringify(plan);

  assert.equal(config.dryRun, true);
  assert.match(serialized, /spaces\.get/);
  assert.match(serialized, /spaces\.messages\.create/);
  assert.doesNotMatch(serialized, /secret payload/);
});

test("loadSmokeConfig accepts the pnpm argument separator before dry-run flags", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadSmokeConfig({
    argv: ["node", "chat-smoke.mjs", "--", "--dry-run"],
    env: smokeEnv(metadataPath),
  });

  assert.equal(config.dryRun, true);
});

test("buildLiveScopes avoids app space lifecycle scopes by default", async (t) => {
  const metadataPath = await writeMetadata(t);
  const defaultConfig = await loadSmokeConfig({
    argv: ["node", "chat-smoke.mjs"],
    env: smokeEnv(metadataPath),
  });
  const lifecycleConfig = await loadSmokeConfig({
    argv: ["node", "chat-smoke.mjs", "--include-space-lifecycle"],
    env: smokeEnv(metadataPath),
  });

  assert.deepEqual(buildLiveScopes(defaultConfig), [
    "https://www.googleapis.com/auth/chat.bot",
  ]);
  assert.deepEqual(buildLiveScopes(lifecycleConfig), [
    "https://www.googleapis.com/auth/chat.bot",
    "https://www.googleapis.com/auth/chat.app.spaces.create",
    "https://www.googleapis.com/auth/chat.app.delete",
  ]);
});

test("runChatSmoke validates live space metadata before creating messages", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadSmokeConfig({
    argv: ["node", "chat-smoke.mjs"],
    env: smokeEnv(metadataPath),
  });
  const calls = [];
  const client = {
    async listSpaces() {
      calls.push("spaces.list");
      return { spaces: [] };
    },
    async getSpace() {
      calls.push("spaces.get");
      return {
        name: "spaces/AAAA-smoke",
        displayName: "Production Team Room",
        spaceType: "SPACE",
      };
    },
  };

  await assert.rejects(
    () => runChatSmoke(config, { client, writeEvidence: false }),
    /live space displayName must start with Google Chat AI SDK Smoke/,
  );
  assert.deepEqual(calls, ["spaces.list", "spaces.get"]);
});

test("runChatSmoke creates, edits, deletes, and records evidence without message text", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadSmokeConfig({
    argv: ["node", "chat-smoke.mjs", "--include-space-lifecycle"],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_SMOKE_MESSAGE_TEXT: "secret payload that must not be saved",
    }),
  });
  const calls = [];
  const client = {
    async listSpaces() {
      calls.push("spaces.list");
      return { spaces: [{ name: "spaces/AAAA-smoke" }] };
    },
    async getSpace(name) {
      calls.push(`spaces.get:${name}`);
      return {
        name,
        displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
        spaceType: "SPACE",
      };
    },
    async createSpace(body) {
      calls.push(`spaces.create:${body.displayName}`);
      return {
        name: "spaces/LIFECYCLE",
        displayName: body.displayName,
        spaceType: "SPACE",
      };
    },
    async deleteSpace(name) {
      calls.push(`spaces.delete:${name}`);
      return {};
    },
    async createMessage(parent, body) {
      calls.push(`messages.create:${parent}:${body.text}`);
      return { name: `${parent}/messages/smoke-message` };
    },
    async patchMessage(name, body) {
      calls.push(`messages.patch:${name}:${body.text}`);
      return { name };
    },
    async deleteMessage(name) {
      calls.push(`messages.delete:${name}`);
      return {};
    },
  };

  const result = await runChatSmoke(config, { client, writeEvidence: false });
  const evidence = JSON.stringify(result.evidence);

  assert.equal(result.ok, true);
  assert.deepEqual(calls.slice(0, 4), [
    "spaces.list",
    "spaces.get:spaces/AAAA-smoke",
    "spaces.create:Google Chat AI SDK Smoke W7 Lifecycle smoke-test",
    "spaces.get:spaces/LIFECYCLE",
  ]);
  assert.match(calls.join("\n"), /messages\.delete:spaces\/AAAA-smoke\/messages\/smoke-message/);
  assert.match(calls.join("\n"), /spaces\.delete:spaces\/LIFECYCLE/);
  assert.doesNotMatch(evidence, /secret payload/);
  assert.match(evidence, /spaces\/AAAA-smoke\/messages\/smoke-message/);
});

test("runChatSmoke can exercise a smoke thread root and reply chain", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadSmokeConfig({
    argv: ["node", "chat-smoke.mjs", "--include-thread-replies"],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_SMOKE_MESSAGE_TEXT: "secret thread payload",
    }),
  });
  const calls = [];
  const client = {
    async listSpaces() {
      calls.push("spaces.list");
      return { spaces: [{ name: "spaces/AAAA-smoke" }] };
    },
    async getSpace(name) {
      calls.push(`spaces.get:${name}`);
      return {
        name,
        displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
        spaceType: "SPACE",
      };
    },
    async createMessage(parent, body, options) {
      calls.push({
        operation: "messages.create",
        parent,
        body,
        options,
      });
      if (body.thread?.threadKey) {
        return {
          name: `${parent}/messages/thread-root`,
          thread: { name: `${parent}/threads/thread-smoke` },
        };
      }
      if (body.thread?.name) {
        return {
          name: `${parent}/messages/thread-reply`,
          thread: { name: body.thread.name },
        };
      }
      return { name: `${parent}/messages/smoke-message` };
    },
    async patchMessage(name, body) {
      calls.push({ operation: "messages.patch", name, body });
      return { name, thread: { name: "spaces/AAAA-smoke/threads/thread-smoke" } };
    },
    async deleteMessage(name) {
      calls.push({ operation: "messages.delete", name });
      return {};
    },
  };

  const result = await runChatSmoke(config, { client, writeEvidence: false });
  const evidence = JSON.stringify(result.evidence);
  const created = calls.filter((call) => call.operation === "messages.create");
  const deleted = calls.filter((call) => call.operation === "messages.delete");

  assert.equal(result.ok, true);
  assert.equal(config.threadReplyCount, 1);
  assert.equal(created.length, 3);
  assert.deepEqual(created[1].body.thread, { threadKey: "smoke-thread-smoke-test" });
  assert.equal(
    created[1].options.messageReplyOption,
    "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
  );
  assert.deepEqual(created[2].body.thread, {
    name: "spaces/AAAA-smoke/threads/thread-smoke",
  });
  assert.equal(deleted.at(0).name, "spaces/AAAA-smoke/messages/thread-reply");
  assert.equal(deleted.at(1).name, "spaces/AAAA-smoke/messages/thread-root");
  assert.equal(evidence.includes("secret thread payload"), false);
  assert.match(evidence, /spaces\.messages\.create\.threadRoot/);
  assert.match(evidence, /spaces\.messages\.create\.threadReply/);
});

test("runChatSmoke can exercise multiple replies in one smoke thread", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadSmokeConfig({
    argv: ["node", "chat-smoke.mjs", "--thread-reply-count=3"],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_SMOKE_MESSAGE_TEXT: "secret multi reply payload",
    }),
  });
  const plan = buildPlannedCalls(config);
  const calls = [];
  const client = {
    async listSpaces() {
      calls.push("spaces.list");
      return { spaces: [{ name: "spaces/AAAA-smoke" }] };
    },
    async getSpace(name) {
      calls.push(`spaces.get:${name}`);
      return {
        name,
        displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
        spaceType: "SPACE",
      };
    },
    async createMessage(parent, body, options) {
      calls.push({
        operation: "messages.create",
        parent,
        body,
        options,
      });
      if (body.thread?.threadKey) {
        return {
          name: `${parent}/messages/thread-root`,
          thread: { name: `${parent}/threads/thread-smoke` },
        };
      }
      if (body.thread?.name) {
        return {
          name: `${parent}/messages/${options.messageId}`,
          thread: { name: body.thread.name },
        };
      }
      return { name: `${parent}/messages/smoke-message` };
    },
    async patchMessage(name, body) {
      calls.push({ operation: "messages.patch", name, body });
      return { name, thread: { name: "spaces/AAAA-smoke/threads/thread-smoke" } };
    },
    async deleteMessage(name) {
      calls.push({ operation: "messages.delete", name });
      return {};
    },
  };

  const result = await runChatSmoke(config, { client, writeEvidence: false });
  const evidence = JSON.stringify(result.evidence);
  const created = calls.filter((call) => call.operation === "messages.create");
  const patched = calls.filter((call) => call.operation === "messages.patch");
  const deleted = calls.filter((call) => call.operation === "messages.delete");

  assert.equal(result.ok, true);
  assert.equal(config.includeThreadReplies, true);
  assert.equal(config.threadReplyCount, 3);
  assert.equal(
    plan.calls.find((call) => call.operation === "spaces.messages.create.threadReply")
      .repeat,
    3,
  );
  assert.equal(created.length, 5);
  assert.deepEqual(created.slice(2).map((call) => call.body.thread), [
    { name: "spaces/AAAA-smoke/threads/thread-smoke" },
    { name: "spaces/AAAA-smoke/threads/thread-smoke" },
    { name: "spaces/AAAA-smoke/threads/thread-smoke" },
  ]);
  assert.equal(
    patched.at(-1).name,
    "spaces/AAAA-smoke/messages/client-smoke-test-thread-reply-3",
  );
  assert.deepEqual(deleted.slice(0, 4).map((call) => call.name), [
    "spaces/AAAA-smoke/messages/client-smoke-test-thread-reply-3",
    "spaces/AAAA-smoke/messages/client-smoke-test-thread-reply-2",
    "spaces/AAAA-smoke/messages/client-smoke-test-thread-reply-1",
    "spaces/AAAA-smoke/messages/thread-root",
  ]);
  assert.equal(evidence.includes("secret multi reply payload"), false);
  assert.match(evidence, /spaces\.messages\.create\.threadReply\.3/);
});

test("loadSmokeConfig rejects existing-thread replies outside the smoke space", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadSmokeConfig({
        argv: [
          "node",
          "chat-smoke.mjs",
          "--reply-to-existing-thread=spaces/OTHER/threads/not-smoke",
        ],
        env: smokeEnv(metadataPath),
      }),
    /--reply-to-existing-thread must be a thread in GOOGLE_CHAT_TEST_SPACE/,
  );
});

test("runChatSmoke can reply to, edit, and clean up an existing smoke thread", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadSmokeConfig({
    argv: [
      "node",
      "chat-smoke.mjs",
      "--skip-messages",
      "--reply-to-existing-thread=spaces/AAAA-smoke/threads/human-thread",
      "--pause-before-cleanup-ms=1234",
    ],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_SMOKE_MESSAGE_TEXT: "secret existing thread payload",
    }),
  });
  const plan = buildPlannedCalls(config);
  const calls = [];
  const client = {
    async listSpaces() {
      calls.push("spaces.list");
      return { spaces: [{ name: "spaces/AAAA-smoke" }] };
    },
    async getSpace(name) {
      calls.push(`spaces.get:${name}`);
      return {
        name,
        displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
        spaceType: "SPACE",
      };
    },
    async createMessage(parent, body, options) {
      calls.push({
        operation: "messages.create",
        parent,
        body,
        options,
      });
      return {
        name: `${parent}/messages/existing-thread-reply`,
        thread: { name: body.thread.name },
      };
    },
    async patchMessage(name, body) {
      calls.push({ operation: "messages.patch", name, body });
      return { name, thread: { name: "spaces/AAAA-smoke/threads/human-thread" } };
    },
    async deleteMessage(name) {
      calls.push({ operation: "messages.delete", name });
      return {};
    },
  };

  const result = await runChatSmoke(config, {
    client,
    writeEvidence: false,
    sleepMs: async (delayMs) => {
      calls.push({ operation: "sleep", delayMs });
    },
  });
  const evidence = JSON.stringify(result.evidence);
  const created = calls.filter((call) => call.operation === "messages.create");
  const deleted = calls.filter((call) => call.operation === "messages.delete");
  const sleep = calls.find((call) => call.operation === "sleep");

  assert.equal(result.ok, true);
  assert.equal(plan.replyToExistingThread, "spaces/AAAA-smoke/threads/human-thread");
  assert.equal(plan.pauseBeforeCleanupMs, 1234);
  assert.equal(
    plan.calls.some(
      (call) => call.operation === "spaces.messages.create.existingThreadReply",
    ),
    true,
  );
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].body.thread, {
    name: "spaces/AAAA-smoke/threads/human-thread",
  });
  assert.equal(
    created[0].options.messageReplyOption,
    "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
  );
  assert.equal(sleep.delayMs, 1234);
  assert.ok(calls.indexOf(sleep) < calls.indexOf(deleted[0]));
  assert.equal(deleted[0].name, "spaces/AAAA-smoke/messages/existing-thread-reply");
  assert.equal(evidence.includes("secret existing thread payload"), false);
  assert.match(evidence, /pause\.beforeCleanup/);
  assert.match(evidence, /spaces\.messages\.create\.existingThreadReply/);
  assert.match(evidence, /spaces\.messages\.patch\.existingThreadReply/);
});

test("loadSmokeConfig bounds pause-before-cleanup duration", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadSmokeConfig({
        argv: [
          "node",
          "chat-smoke.mjs",
          "--pause-before-cleanup-ms=120001",
        ],
        env: smokeEnv(metadataPath),
      }),
    /--pause-before-cleanup-ms must be 120000 or less/,
  );
  await assert.rejects(
    () =>
      loadSmokeConfig({
        argv: [
          "node",
          "chat-smoke.mjs",
          "--pause-before-cleanup-ms=1.5",
        ],
        env: smokeEnv(metadataPath),
      }),
    /--pause-before-cleanup-ms must be a non-negative integer/,
  );
});

test("loadSmokeConfig bounds thread reply count", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadSmokeConfig({
        argv: ["node", "chat-smoke.mjs", "--thread-reply-count=0"],
        env: smokeEnv(metadataPath),
      }),
    /--thread-reply-count must be a positive integer/,
  );
  await assert.rejects(
    () =>
      loadSmokeConfig({
        argv: ["node", "chat-smoke.mjs", "--thread-reply-count=6"],
        env: smokeEnv(metadataPath),
      }),
    /--thread-reply-count must be 5 or less/,
  );
});

test("cleanup-only mode deletes only smoke-run resources after validating the target space", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadSmokeConfig({
    argv: [
      "node",
      "chat-smoke.mjs",
      "--cleanup-resource",
      "spaces/AAAA-smoke/messages/smoke-message",
    ],
    env: smokeEnv(metadataPath),
  });
  const calls = [];
  const client = {
    async getSpace(name) {
      calls.push(`spaces.get:${name}`);
      return {
        name,
        displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
        spaceType: "SPACE",
      };
    },
    async deleteMessage(name) {
      calls.push(`messages.delete:${name}`);
      return {};
    },
  };

  const result = await runChatSmoke(config, { client, writeEvidence: false });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "spaces.get:spaces/AAAA-smoke",
    "messages.delete:spaces/AAAA-smoke/messages/smoke-message",
  ]);
});
