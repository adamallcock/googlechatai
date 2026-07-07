import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildVisualPlan,
  loadVisualSmokeConfig,
  runVisualSmoke,
} from "./chat-visual-smoke.mjs";

const SMOKE_SPACE_PREFIX = "Google Chat AI SDK Smoke";

async function writeMetadata(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-visual-smoke-test-"));
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

async function writePlaceholderConfig(t, body, extension = "json") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-placeholder-config-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, `placeholders.${extension}`);
  await fs.writeFile(
    file,
    typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`,
    "utf8",
  );
  return file;
}

function smokeEnv(metadataPath, overrides = {}) {
  return {
    RUN_LIVE_CHAT_VISUAL_SMOKE: "1",
    GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
    GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
    GOOGLE_CHAT_VISUAL_SMOKE_RUN_ID: "visual-test",
    BASE_URL: "https://example.test/api",
    ...overrides,
  };
}

test("loadVisualSmokeConfig refuses to run without explicit visual guard", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadVisualSmokeConfig({
        argv: ["node", "chat-visual-smoke.mjs", "--dry-run"],
        env: {
          GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
          GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
        },
      }),
    /RUN_LIVE_CHAT_VISUAL_SMOKE=1/,
  );
});

test("dry-run plan includes visual create and cleanup paths", async (t) => {
  const metadataPath = await writeMetadata(t);
  const createConfig = await loadVisualSmokeConfig({
    argv: ["node", "chat-visual-smoke.mjs", "--dry-run"],
    env: smokeEnv(metadataPath),
  });
  const richCardConfig = await loadVisualSmokeConfig({
    argv: ["node", "chat-visual-smoke.mjs", "--dry-run", "--include-rich-card"],
    env: smokeEnv(metadataPath),
  });
  const carouselCardConfig = await loadVisualSmokeConfig({
    argv: [
      "node",
      "chat-visual-smoke.mjs",
      "--dry-run",
      "--include-carousel-card",
    ],
    env: smokeEnv(metadataPath),
  });
  const aiCardComponentsConfig = await loadVisualSmokeConfig({
    argv: [
      "node",
      "chat-visual-smoke.mjs",
      "--dry-run",
      "--include-ai-card-components",
    ],
    env: smokeEnv(metadataPath),
  });
  const bufferedConfig = await loadVisualSmokeConfig({
    argv: [
      "node",
      "chat-visual-smoke.mjs",
      "--dry-run",
      "--use-buffered-stream",
      "--stream-patch-count=4",
      "--stream-min-patch-chars=24",
    ],
    env: smokeEnv(metadataPath),
  });
  const placeholderConfig = await loadVisualSmokeConfig({
    argv: [
      "node",
      "chat-visual-smoke.mjs",
      "--dry-run",
      "--use-placeholder-response",
    ],
    env: smokeEnv(metadataPath),
  });
  const cleanupConfig = await loadVisualSmokeConfig({
    argv: [
      "node",
      "chat-visual-smoke.mjs",
      "--dry-run",
      "--cleanup-from-evidence",
      "fixtures/live/evidence/example.json",
    ],
    env: smokeEnv(metadataPath),
    cwd: "/repo",
  });

  assert.deepEqual(
    buildVisualPlan(createConfig).calls.map((call) => call.operation),
    [
      "spaces.get",
      "visual.text.create",
      "visual.card.create",
      "visual.thread.parent.create",
      "visual.thread.reply.create",
      "visual.stream.create",
      "visual.stream.patch",
    ],
  );
  assert.deepEqual(
    buildVisualPlan(richCardConfig).calls.map((call) => call.operation),
    [
      "spaces.get",
      "visual.text.create",
      "visual.card.create",
      "visual.rich-card.create",
      "visual.thread.parent.create",
      "visual.thread.reply.create",
      "visual.stream.create",
      "visual.stream.patch",
    ],
  );
  assert.deepEqual(
    buildVisualPlan(carouselCardConfig).calls.map((call) => call.operation),
    [
      "spaces.get",
      "visual.text.create",
      "visual.card.create",
      "visual.carousel-card.create",
      "visual.thread.parent.create",
      "visual.thread.reply.create",
      "visual.stream.create",
      "visual.stream.patch",
    ],
  );
  assert.deepEqual(
    buildVisualPlan(aiCardComponentsConfig).calls.map((call) => call.operation),
    [
      "spaces.get",
      "visual.text.create",
      "visual.card.create",
      "visual.ai.feedback-card.create",
      "visual.ai.sources-card.create",
      "visual.ai.thinking-card.create",
      "visual.ai.tool-status-card.create",
      "visual.ai.streaming-status-card.create",
      "visual.thread.parent.create",
      "visual.thread.reply.create",
      "visual.stream.create",
      "visual.stream.patch",
    ],
  );
  assert.deepEqual(
    buildVisualPlan(bufferedConfig).calls.map((call) => call.operation),
    [
      "spaces.get",
      "visual.text.create",
      "visual.card.create",
      "visual.thread.parent.create",
      "visual.thread.reply.create",
      "visual.stream.create",
      "visual.stream.buffered-plan",
      "visual.stream.patch",
    ],
  );
  assert.deepEqual(
    buildVisualPlan(placeholderConfig).calls.map((call) => call.operation),
    [
      "spaces.get",
      "visual.text.create",
      "visual.card.create",
      "visual.thread.parent.create",
      "visual.thread.reply.create",
      "visual.placeholder.create",
      "visual.placeholder.complete",
      "visual.stream.create",
      "visual.stream.patch",
    ],
  );
  assert.deepEqual(
    buildVisualPlan(cleanupConfig).calls.map((call) => call.operation),
    ["spaces.get", "cleanup.from-evidence"],
  );
  assert.equal(
    buildVisualPlan(createConfig).calls.find(
      (call) => call.operation === "visual.stream.patch",
    ).repeat,
    3,
  );
  assert.equal(
    buildVisualPlan(bufferedConfig).calls.find(
      (call) => call.operation === "visual.stream.patch",
    ).repeat <= 4,
    true,
  );
});

test("runVisualSmoke can create opt-in AI card component messages", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadVisualSmokeConfig({
    argv: ["node", "chat-visual-smoke.mjs", "--include-ai-card-components"],
    env: smokeEnv(metadataPath),
  });
  const calls = [];
  let count = 0;
  const client = {
    async getSpace(name) {
      return {
        name,
        displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
        spaceType: "SPACE",
      };
    },
    async createMessage(parent, body, query = {}) {
      count += 1;
      calls.push({
        op: "create",
        parent,
        body,
        query,
      });
      return {
        name: `${parent}/messages/${count}`,
        thread: { name: `${parent}/threads/T${count}` },
        cardsV2: body.cardsV2,
        accessoryWidgets: body.accessoryWidgets,
      };
    },
    async patchMessage(name, body) {
      calls.push({ op: "patch", name, body });
      return { name };
    },
  };

  const result = await runVisualSmoke(config, { client, writeEvidence: false });
  const labels = result.evidence.resourcesCreated.map(
    (resource) => resource.label,
  );
  const cardIds = calls
    .filter((call) => call.op === "create")
    .map((call) => call.body.cardsV2?.[0]?.cardId)
    .filter(Boolean);

  assert.equal(result.ok, true);
  assert.equal(result.evidence.includeAiCardComponents, true);
  assert.deepEqual(labels.slice(2, 7), [
    "ai-feedback-accessory-message",
    "ai-sources-card",
    "ai-thinking-card",
    "ai-tool-status-card",
    "ai-streaming-status-card",
  ]);
  assert.equal(result.evidence.resourcesCreated.length, 10);
  assert.deepEqual(cardIds.slice(1, 5), [
    "ai-sources-visual-test",
    "ai-thinking-visual-test",
    "ai-tool-status-visual-test",
    "ai-streaming-status-visual-test",
  ]);
  assert.equal(
    calls.some((call) =>
      call.body.accessoryWidgets?.[0]?.buttonList?.buttons?.[0]?.icon
        ?.materialIcon?.name === "thumb_up" &&
      call.body.accessoryWidgets?.[0]?.buttonList?.buttons?.[0]?.type ===
        "BORDERLESS" &&
      call.body.accessoryWidgets?.[0]?.buttonList?.buttons?.[0]?.onClick?.action
        ?.function === "https://example.test/api/chat/events" &&
      call.body.accessoryWidgets?.[0]?.buttonList?.buttons?.[0]?.onClick?.action
        ?.parameters?.some(
          (parameter) =>
            parameter.key === "actionName" &&
            parameter.value === "ai_visual_feedback",
        ),
    ),
    true,
  );
  assert.equal(
    calls.some((call) =>
      call.body.cardsV2?.[0]?.card?.header?.title === "Sources",
    ),
    true,
  );
  assert.equal(
    calls.some((call) =>
      call.body.cardsV2?.[0]?.card?.header?.title === "Working on it",
    ),
    true,
  );
  assert.equal(
    calls.some((call) =>
      call.body.cardsV2?.[0]?.card?.header?.title === "Tool calls",
    ),
    true,
  );
  assert.equal(
    calls.some((call) =>
      call.body.cardsV2?.[0]?.card?.header?.title === "Streaming response",
    ),
    true,
  );
  assert.equal(
    result.evidence.visualExpectations.some(
      (expectation) => expectation.label === "ai-card-components",
    ),
    true,
  );
});

test("runVisualSmoke validates the target smoke space before writes", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadVisualSmokeConfig({
    argv: ["node", "chat-visual-smoke.mjs"],
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
    () => runVisualSmoke(config, { client, writeEvidence: false }),
    /live space displayName must start with Google Chat AI SDK Smoke/,
  );
  assert.deepEqual(calls, ["spaces.get"]);
});

test("runVisualSmoke creates text, card, thread, and stream messages", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadVisualSmokeConfig({
    argv: ["node", "chat-visual-smoke.mjs"],
    env: smokeEnv(metadataPath),
  });
  const calls = [];
  let count = 0;
  const client = {
    async getSpace(name) {
      calls.push(`spaces.get:${name}`);
      return {
        name,
        displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
        spaceType: "SPACE",
      };
    },
    async createMessage(parent, body, query = {}) {
      count += 1;
      calls.push({
        op: "create",
        parent,
        body,
        query,
      });
      return {
        name: `${parent}/messages/${count}`,
        thread: { name: `${parent}/threads/T${count}` },
        cardsV2: body.cardsV2,
        accessoryWidgets: body.accessoryWidgets,
      };
    },
    async patchMessage(name, body) {
      calls.push({ op: "patch", name, body });
      return { name };
    },
  };

  const result = await runVisualSmoke(config, { client, writeEvidence: false });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.resourcesCreated.length, 5);
  assert.deepEqual(
    result.evidence.resourcesCreated.map((resource) => resource.label),
    ["text", "card", "thread-parent", "thread-reply", "stream"],
  );
  assert.equal(
    calls.some((call) => call.op === "create" && call.body.cardsV2?.length === 1),
    true,
  );
  assert.equal(
    calls.filter((call) => call.op === "patch").length,
    3,
  );
});

test("runVisualSmoke can exercise a longer edit stream", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadVisualSmokeConfig({
    argv: [
      "node",
      "chat-visual-smoke.mjs",
      "--stream-patch-count=8",
    ],
    env: smokeEnv(metadataPath),
  });
  const calls = [];
  let count = 0;
  const client = {
    async getSpace(name) {
      return {
        name,
        displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
        spaceType: "SPACE",
      };
    },
    async createMessage(parent, body) {
      count += 1;
      return {
        name: `${parent}/messages/${count}`,
        thread: { name: `${parent}/threads/T${count}` },
        cardsV2: body.cardsV2,
        accessoryWidgets: body.accessoryWidgets,
      };
    },
    async patchMessage(name, body) {
      calls.push({ op: "patch", name, body });
      return { name };
    },
  };

  const result = await runVisualSmoke(config, { client, writeEvidence: false });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.streamPatchCount, 8);
  assert.equal(calls.length, 8);
  assert.equal(
    calls.at(-1).body.text,
    "[visual-test] Stream smoke: final edited message after 8 patch(es).",
  );
});

test("runVisualSmoke can exercise the SDK buffered stream planner", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadVisualSmokeConfig({
    argv: [
      "node",
      "chat-visual-smoke.mjs",
      "--use-buffered-stream",
      "--stream-patch-count=4",
      "--stream-min-patch-chars=24",
    ],
    env: smokeEnv(metadataPath),
  });
  const calls = [];
  let count = 0;
  const client = {
    async getSpace(name) {
      return {
        name,
        displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
        spaceType: "SPACE",
      };
    },
    async createMessage(parent, body, query = {}) {
      count += 1;
      calls.push({ op: "create", parent, body, query });
      return {
        name: `${parent}/messages/${count}`,
        thread: { name: `${parent}/threads/T${count}` },
        cardsV2: body.cardsV2,
        accessoryWidgets: body.accessoryWidgets,
      };
    },
    async patchMessage(name, body) {
      calls.push({ op: "patch", name, body });
      return { name };
    },
  };

  const result = await runVisualSmoke(config, { client, writeEvidence: false });
  const streamCreate = calls.find(
    (call) =>
      call.op === "create" &&
      call.body.text === "[visual-test] Buffered stream smoke: starting...",
  );
  const patchCalls = calls.filter((call) => call.op === "patch");

  assert.equal(result.ok, true);
  assert.equal(result.evidence.bufferedStream.enabled, true);
  assert.equal(result.evidence.bufferedStream.patchCount <= 4, true);
  assert.equal(
    result.evidence.streamPatchExecutedCount,
    result.evidence.bufferedStream.patchCount,
  );
  assert.equal(streamCreate.query.requestId.startsWith("req-visual-test"), true);
  assert.equal(streamCreate.query.messageId, "client-visual-test-buffered-stream");
  assert.equal(patchCalls.length, result.evidence.bufferedStream.patchCount);
  assert.match(patchCalls.at(-1).body.text, /bounded Chat edits\.$/);
});

test("runVisualSmoke can exercise placeholder response create then edit", async (t) => {
  const metadataPath = await writeMetadata(t);
  const placeholderConfigPath = await writePlaceholderConfig(t, {
    texts: [
      "Thinking...",
      "Checking the smoke thread...",
      "Reviewing smoke attachments...",
    ],
    mode: "roundRobin",
    cursor: 1,
  });
  const config = await loadVisualSmokeConfig({
    argv: [
      "node",
      "chat-visual-smoke.mjs",
      "--use-placeholder-response",
      "--placeholder-config",
      placeholderConfigPath,
    ],
    env: smokeEnv(metadataPath),
  });
  const calls = [];
  let count = 0;
  const client = {
    async getSpace(name) {
      return {
        name,
        displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
        spaceType: "SPACE",
      };
    },
    async createMessage(parent, body, query = {}) {
      count += 1;
      calls.push({ op: "create", parent, body, query });
      return {
        name: `${parent}/messages/${count}`,
        thread: { name: `${parent}/threads/T${count}` },
        cardsV2: body.cardsV2,
        accessoryWidgets: body.accessoryWidgets,
        createTime: "2026-07-04T00:00:00Z",
      };
    },
    async patchMessage(name, body) {
      calls.push({ op: "patch", name, body });
      return { name, text: body.text };
    },
  };

  const result = await runVisualSmoke(config, { client, writeEvidence: false });
  const placeholderCreate = calls.find(
    (call) =>
      call.op === "create" &&
      call.body.text === "[visual-test] Placeholder response smoke: Checking the smoke thread...",
  );
  const placeholderPatch = calls.find(
    (call) =>
      call.op === "patch" &&
      call.body.text ===
        "[visual-test] Placeholder response smoke: final answer edited into the original message.",
  );

  assert.equal(result.ok, true);
  assert.equal(result.evidence.placeholderResponse.enabled, true);
  assert.equal(result.evidence.placeholderResponse.strategy, "create-then-edit");
  assert.equal(result.evidence.placeholderResponse.textSelection.mode, "roundRobin");
  assert.equal(result.evidence.placeholderResponse.textSelection.index, 1);
  assert.equal(result.evidence.placeholderResponse.textSelection.nextCursor, 2);
  assert.equal(result.evidence.resourcesCreated.some((resource) => resource.label === "placeholder-response"), true);
  assert.equal(placeholderCreate.query.requestId, "req-visual-test-placeholder-response");
  assert.equal(placeholderCreate.query.messageId, "client-visual-test-placeholder-response");
  assert.equal(placeholderPatch.name, placeholderCreate.parent + "/messages/5");
  assert.equal(
    calls.filter(
      (call) =>
        call.op === "create" &&
        call.body.text?.includes("Placeholder response smoke: final answer"),
    ).length,
    0,
  );
});

test("loadVisualSmokeConfig bounds stream patch options", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadVisualSmokeConfig({
        argv: ["node", "chat-visual-smoke.mjs", "--stream-patch-count=0"],
        env: smokeEnv(metadataPath),
      }),
    /--stream-patch-count must be a positive integer/,
  );
  await assert.rejects(
    () =>
      loadVisualSmokeConfig({
        argv: ["node", "chat-visual-smoke.mjs", "--stream-patch-count=21"],
        env: smokeEnv(metadataPath),
      }),
    /--stream-patch-count must be 20 or less/,
  );
  await assert.rejects(
    () =>
      loadVisualSmokeConfig({
        argv: ["node", "chat-visual-smoke.mjs", "--stream-patch-delay-ms=-1"],
        env: smokeEnv(metadataPath),
      }),
    /--stream-patch-delay-ms must be a non-negative integer/,
  );
  await assert.rejects(
    () =>
      loadVisualSmokeConfig({
        argv: ["node", "chat-visual-smoke.mjs", "--stream-patch-delay-ms=5001"],
        env: smokeEnv(metadataPath),
      }),
    /--stream-patch-delay-ms must be 5000 or less/,
  );
  await assert.rejects(
    () =>
      loadVisualSmokeConfig({
        argv: ["node", "chat-visual-smoke.mjs", "--stream-min-patch-chars=0"],
        env: smokeEnv(metadataPath),
      }),
    /--stream-min-patch-chars must be a positive integer/,
  );
  await assert.rejects(
    () =>
      loadVisualSmokeConfig({
        argv: ["node", "chat-visual-smoke.mjs", "--stream-min-patch-chars=1001"],
        env: smokeEnv(metadataPath),
      }),
    /--stream-min-patch-chars must be 1000 or less/,
  );
});

test("runVisualSmoke can create an opt-in rich Cards V2 message", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadVisualSmokeConfig({
    argv: ["node", "chat-visual-smoke.mjs", "--include-rich-card"],
    env: smokeEnv(metadataPath),
  });
  const calls = [];
  let count = 0;
  const client = {
    async getSpace(name) {
      return {
        name,
        displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
        spaceType: "SPACE",
      };
    },
    async createMessage(parent, body, query = {}) {
      count += 1;
      calls.push({
        op: "create",
        parent,
        body,
        query,
      });
      return {
        name: `${parent}/messages/${count}`,
        thread: { name: `${parent}/threads/T${count}` },
        cardsV2: body.cardsV2,
        accessoryWidgets: body.accessoryWidgets,
      };
    },
    async patchMessage(name, body) {
      calls.push({ op: "patch", name, body });
      return { name };
    },
  };

  const result = await runVisualSmoke(config, { client, writeEvidence: false });
  const richCardCreate = calls.find((call) =>
    call.body.cardsV2?.[0]?.cardId?.startsWith("visual-rich-card-"),
  );

  assert.equal(result.ok, true);
  assert.equal(result.evidence.resourcesCreated.length, 6);
  assert.equal(result.evidence.resourcesCreated[2].label, "rich-card");
  assert.ok(richCardCreate);
  assert.equal(
    richCardCreate.body.cardsV2[0].card.sections[0].widgets.some(
      (widget) => widget.grid,
    ),
    true,
  );
  assert.equal(
    richCardCreate.body.cardsV2[0].card.sections[1].widgets.some(
      (widget) => widget.chipList,
    ),
    true,
  );
});

test("runVisualSmoke can create an opt-in carousel Cards V2 message", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadVisualSmokeConfig({
    argv: ["node", "chat-visual-smoke.mjs", "--include-carousel-card"],
    env: smokeEnv(metadataPath),
  });
  const calls = [];
  let count = 0;
  const client = {
    async getSpace(name) {
      return {
        name,
        displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
        spaceType: "SPACE",
      };
    },
    async createMessage(parent, body, query = {}) {
      count += 1;
      calls.push({
        op: "create",
        parent,
        body,
        query,
      });
      return {
        name: `${parent}/messages/${count}`,
        thread: { name: `${parent}/threads/T${count}` },
        cardsV2: body.cardsV2,
        accessoryWidgets: body.accessoryWidgets,
      };
    },
    async patchMessage(name, body) {
      calls.push({ op: "patch", name, body });
      return { name };
    },
  };

  const result = await runVisualSmoke(config, { client, writeEvidence: false });
  const carouselCreate = calls.find((call) =>
    call.body.cardsV2?.[0]?.cardId?.startsWith("visual-carousel-card-"),
  );

  assert.equal(result.ok, true);
  assert.equal(result.evidence.resourcesCreated.length, 6);
  assert.equal(result.evidence.resourcesCreated[2].label, "carousel-card");
  assert.ok(carouselCreate);
  assert.equal(
    carouselCreate.body.cardsV2[0].card.sections[0].widgets[0].carousel
      .carouselCards.length,
    2,
  );
});

test("cleanup deletes only messages from prior visual-smoke evidence", async (t) => {
  const metadataPath = await writeMetadata(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-visual-cleanup-"));
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
            label: "text",
            name: "spaces/AAAA-smoke/messages/1",
          },
          {
            kind: "message",
            label: "card",
            name: "spaces/AAAA-smoke/messages/2",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const config = await loadVisualSmokeConfig({
    argv: [
      "node",
      "chat-visual-smoke.mjs",
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

  const result = await runVisualSmoke(config, { client, writeEvidence: false });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "spaces.get:spaces/AAAA-smoke",
    "messages.delete:spaces/AAAA-smoke/messages/2",
    "messages.delete:spaces/AAAA-smoke/messages/1",
  ]);
});
