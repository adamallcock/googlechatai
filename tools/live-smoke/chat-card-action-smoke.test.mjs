import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCardActionMessage,
  buildCardActionPlan,
  loadCardActionSmokeConfig,
  runCardActionSmoke,
} from "./chat-card-action-smoke.mjs";

const SMOKE_SPACE_PREFIX = "Google Chat AI SDK Smoke";

async function writeMetadata(t, overrides = {}) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "chat-card-action-smoke-test-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "space.json");
  const metadata = {
    space: "spaces/AAAA-smoke",
    displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
    spaceType: "SPACE",
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
    RUN_LIVE_CHAT_CARD_ACTION_SMOKE: "1",
    GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
    GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
    GOOGLE_CHAT_CARD_ACTION_SMOKE_RUN_ID: "card-action-test",
    BASE_URL: "https://example.test/api",
    ...overrides,
  };
}

test("loadCardActionSmokeConfig refuses to run without explicit guard", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadCardActionSmokeConfig({
        argv: ["node", "chat-card-action-smoke.mjs", "--dry-run"],
        env: {
          GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
          GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
        },
      }),
    /RUN_LIVE_CHAT_CARD_ACTION_SMOKE=1/,
  );
});

test("dry-run plan includes card create and cleanup paths", async (t) => {
  const metadataPath = await writeMetadata(t);
  const createConfig = await loadCardActionSmokeConfig({
    argv: [
      "node",
      "chat-card-action-smoke.mjs",
      "--dry-run",
      "--include-state",
    ],
    env: smokeEnv(metadataPath),
  });
  const cleanupConfig = await loadCardActionSmokeConfig({
    argv: [
      "node",
      "chat-card-action-smoke.mjs",
      "--dry-run",
      "--cleanup-from-evidence",
      "fixtures/live/evidence/example.json",
    ],
    env: smokeEnv(metadataPath),
    cwd: "/repo",
  });
  const confirmationCleanupConfig = await loadCardActionSmokeConfig({
    argv: [
      "node",
      "chat-card-action-smoke.mjs",
      "--dry-run",
      "--cleanup-confirmations-from-evidence",
      "fixtures/live/evidence/example.json",
    ],
    env: smokeEnv(metadataPath),
    cwd: "/repo",
  });

  assert.deepEqual(
    buildCardActionPlan(createConfig).calls.map((call) => call.operation),
    ["spaces.get", "card-action.create"],
  );
  assert.equal(
    buildCardActionPlan(createConfig).calls[1].statefulActionParameters,
    true,
  );
  assert.deepEqual(
    buildCardActionPlan(cleanupConfig).calls.map((call) => call.operation),
    ["spaces.get", "cleanup.from-evidence"],
  );
  assert.deepEqual(
    buildCardActionPlan(confirmationCleanupConfig).calls.map(
      (call) => call.operation,
    ),
    [
      "spaces.get",
      "cleanup.confirmations.messages.list",
      "cleanup.confirmations.message.delete",
    ],
  );
  assert.equal(
    buildCardActionPlan(confirmationCleanupConfig).calls[1].authMode,
    "user",
  );
  assert.equal(
    buildCardActionPlan(confirmationCleanupConfig).calls[2].authMode,
    "app",
  );
});

test("buildCardActionMessage creates an interactive card with dialog action", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadCardActionSmokeConfig({
    argv: ["node", "chat-card-action-smoke.mjs", "--dry-run"],
    env: smokeEnv(metadataPath),
  });

  const message = buildCardActionMessage(config);
  const buttons =
    message.cardsV2[0].card.sections[0].widgets[1].buttonList.buttons;

  assert.equal(message.cardsV2[0].cardId, "card-action-smoke-card-action-test");
  assert.equal(buttons[0].text, "Mark received");
  assert.equal(
    buttons[0].onClick.action.parameters[0].value,
    "googlechatai_sdk_card_mark_received",
  );
  assert.equal(buttons[1].text, "Open dialog");
  assert.equal(buttons[1].onClick.action.interaction, "OPEN_DIALOG");
  assert.equal(buttons[2].text, "Open navigation");
  assert.equal(buttons[2].onClick.action.interaction, "OPEN_DIALOG");
  assert.equal(
    buttons[2].onClick.action.parameters[0].value,
    "googlechatai_sdk_card_navigation_next",
  );
});

test("buildCardActionMessage can add hidden encoded action state", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadCardActionSmokeConfig({
    argv: [
      "node",
      "chat-card-action-smoke.mjs",
      "--dry-run",
      "--include-state",
    ],
    env: smokeEnv(metadataPath),
  });

  const message = buildCardActionMessage(config);
  const buttons =
    message.cardsV2[0].card.sections[0].widgets[1].buttonList.buttons;
  const markState = buttons[0].onClick.action.parameters.find(
    (parameter) => parameter.key === "__googleChatAiState",
  );
  const dialogState = buttons[1].onClick.action.parameters.find(
    (parameter) => parameter.key === "__googleChatAiState",
  );
  const navigationState = buttons[2].onClick.action.parameters.find(
    (parameter) => parameter.key === "__googleChatAiState",
  );

  assert.match(markState.value, /^v1\./);
  assert.match(dialogState.value, /^v1\./);
  assert.match(navigationState.value, /^v1\./);
  assert.equal(
    JSON.stringify(message).includes("card-action-smoke-page-2"),
    false,
  );
});

test("runCardActionSmoke validates the target smoke space before writes", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadCardActionSmokeConfig({
    argv: ["node", "chat-card-action-smoke.mjs"],
    env: smokeEnv(metadataPath),
  });
  const calls = [];
  const client = {
    async getSpace() {
      calls.push("spaces.get");
      return {
        name: "spaces/AAAA-smoke",
        displayName: "Production Room",
        spaceType: "SPACE",
      };
    },
  };

  await assert.rejects(
    () => runCardActionSmoke(config, { client, writeEvidence: false }),
    /live space displayName must start with Google Chat AI SDK Smoke/,
  );
  assert.deepEqual(calls, ["spaces.get"]);
});

test("runCardActionSmoke creates one interactive card message", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadCardActionSmokeConfig({
    argv: ["node", "chat-card-action-smoke.mjs"],
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
    async createMessage(parent, body) {
      calls.push({ op: "create", parent, body });
      return {
        name: `${parent}/messages/1`,
        thread: { name: `${parent}/threads/T1` },
        cardsV2: body.cardsV2,
      };
    },
  };

  const result = await runCardActionSmoke(config, {
    client,
    writeEvidence: false,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.evidence.resourcesCreated.map((resource) => resource.label),
    ["card-action"],
  );
  assert.equal(result.evidence.manualTestSteps.length, 5);
  assert.equal(
    calls.some(
      (call) => call.op === "create" && call.body.cardsV2?.length === 1,
    ),
    true,
  );
});

test("cleanup deletes only messages from prior card-action evidence", async (t) => {
  const metadataPath = await writeMetadata(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-card-cleanup-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const evidencePath = path.join(dir, "evidence.json");
  await fs.writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        targetSpace: "spaces/AAAA-smoke",
        resourcesCreated: [
          {
            kind: "message",
            label: "card-action",
            name: "spaces/AAAA-smoke/messages/1",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const config = await loadCardActionSmokeConfig({
    argv: [
      "node",
      "chat-card-action-smoke.mjs",
      "--cleanup-from-evidence",
      evidencePath,
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

  const result = await runCardActionSmoke(config, {
    client,
    writeEvidence: false,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "spaces.get:spaces/AAAA-smoke",
    "messages.delete:spaces/AAAA-smoke/messages/1",
  ]);
});

test("confirmation cleanup discovers exact run text with user auth and deletes with app auth", async (t) => {
  const metadataPath = await writeMetadata(t);
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "chat-card-confirmation-cleanup-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const evidencePath = path.join(dir, "evidence.json");
  await fs.writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        targetSpace: "spaces/AAAA-smoke",
        runId: "card-action-confirmation-test",
        startedAt: "2026-07-01T19:00:00Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const config = await loadCardActionSmokeConfig({
    argv: [
      "node",
      "chat-card-action-smoke.mjs",
      "--cleanup-confirmations-from-evidence",
      evidencePath,
      "--cleanup-end-time=2026-07-01T20:00:00Z",
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
  const userClient = {
    async listMessages(query) {
      calls.push({
        op: "user.messages.list",
        filter: query.filter,
        pageSize: query.pageSize,
      });
      return {
        ok: true,
        status: 200,
        refreshed: false,
        replayedAfter401: false,
        json: {
          messages: [
            {
              name: "spaces/AAAA-smoke/messages/ignore",
              text: "not the confirmation",
              createTime: "2026-07-01T19:10:00Z",
            },
            {
              name: "spaces/AAAA-smoke/messages/confirmation",
              text: "[card-action-confirmation-test] Dialog smoke submitted.",
              createTime: "2026-07-01T19:11:00Z",
              thread: { name: "spaces/AAAA-smoke/threads/T1" },
              sender: { type: "BOT" },
            },
          ],
        },
      };
    },
  };

  const result = await runCardActionSmoke(config, {
    client,
    userClient,
    writeEvidence: false,
  });
  const serialized = JSON.stringify(result.evidence);

  assert.equal(result.ok, true);
  assert.equal(result.evidence.cleanup.deletedMessages, 1);
  assert.equal(result.evidence.cleanup.searchedMessages, 2);
  assert.equal(result.evidence.cleanup.expectedText.length, 55);
  assert.deepEqual(calls, [
    "spaces.get:spaces/AAAA-smoke",
    {
      op: "user.messages.list",
      filter:
        'createTime > "2026-07-01T19:00:00Z" AND createTime < "2026-07-01T20:00:00Z"',
      pageSize: 25,
    },
    "messages.delete:spaces/AAAA-smoke/messages/confirmation",
  ]);
  assert.equal(
    serialized.includes("[card-action-confirmation-test] Dialog smoke submitted."),
    false,
  );
});

test("confirmation cleanup refuses deletion outside the smoke space", async (t) => {
  const metadataPath = await writeMetadata(t);
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "chat-card-confirmation-cleanup-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const evidencePath = path.join(dir, "evidence.json");
  await fs.writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        targetSpace: "spaces/AAAA-smoke",
        runId: "card-action-confirmation-test",
        startedAt: "2026-07-01T19:00:00Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const config = await loadCardActionSmokeConfig({
    argv: [
      "node",
      "chat-card-action-smoke.mjs",
      "--cleanup-confirmations-from-evidence",
      evidencePath,
    ],
    env: smokeEnv(metadataPath),
  });
  const client = {
    async getSpace(name) {
      return {
        name,
        displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
        spaceType: "SPACE",
      };
    },
  };
  const userClient = {
    async listMessages() {
      return {
        ok: true,
        status: 200,
        refreshed: false,
        replayedAfter401: false,
        json: {
          messages: [
            {
              name: "spaces/OTHER/messages/confirmation",
              text: "[card-action-confirmation-test] Dialog smoke submitted.",
              createTime: "2026-07-01T19:11:00Z",
            },
          ],
        },
      };
    },
  };

  await assert.rejects(
    () =>
      runCardActionSmoke(config, {
        client,
        userClient,
        writeEvidence: false,
      }),
    /Refusing to delete confirmation outside smoke space/,
  );
});
