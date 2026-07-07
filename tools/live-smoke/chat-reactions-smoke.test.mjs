import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildReactionsSmokePlan,
  loadReactionsSmokeConfig,
  runReactionsSmoke,
} from "./chat-reactions-smoke.mjs";
import { SMOKE_SPACE_PREFIX } from "./chat-smoke.mjs";

async function writeMetadata(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-reactions-smoke-test-"));
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
    RUN_LIVE_CHAT_REACTIONS_SMOKE: "1",
    GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
    GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
    GOOGLE_CHAT_REACTIONS_SMOKE_RUN_ID: "reactions-test",
    GOOGLE_CHAT_AI_ENABLE_LIVE_REACTION_WRITES: "1",
    GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS: "/tmp/oauth-client.json",
    GOOGLE_CHAT_USER_TOKEN_STORE: "/tmp/user-token.json",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/app-service-account.json",
    ...overrides,
  };
}

function fakeAppClient(calls) {
  return {
    async getSpace(name) {
      calls.push(`app.getSpace:${name}`);
      return {
        name,
        displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
        spaceType: "SPACE",
      };
    },
    async createMessage(parent, body) {
      calls.push(`app.createMessage:${parent}:${body.text}`);
      return {
        name: `${parent}/messages/private-message-id`,
      };
    },
    async deleteMessage(name) {
      calls.push(`app.deleteMessage:${name}`);
      return {};
    },
  };
}

function fakeUserClient(calls) {
  let deleted = false;
  const reaction = {
    name: "spaces/AAAA-smoke/messages/private-message-id/reactions/private-reaction-id",
    emoji: { unicode: "\u{1F44D}" },
    user: {
      name: "users/private-user-id",
      displayName: "Private User",
      email: "private.user@example.com",
      type: "HUMAN",
    },
  };

  return {
    async createReaction(parent, emoji) {
      calls.push(`user.createReaction:${parent}:${emoji}`);
      deleted = false;
      return {
        ok: true,
        status: 200,
        refreshed: false,
        replayedAfter401: false,
        json: reaction,
      };
    },
    async listReactions(parent, query) {
      calls.push(`user.listReactions:${parent}:${query.filter ?? ""}`);
      return {
        ok: true,
        status: 200,
        refreshed: false,
        replayedAfter401: false,
        json: {
          reactions: deleted ? [] : [reaction],
        },
      };
    },
    async deleteReaction(name) {
      calls.push(`user.deleteReaction:${name}`);
      deleted = true;
      return {
        ok: true,
        status: 200,
        refreshed: false,
        replayedAfter401: false,
        json: {},
      };
    },
  };
}

test("loadReactionsSmokeConfig refuses to run without explicit guard", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadReactionsSmokeConfig({
        argv: ["node", "chat-reactions-smoke.mjs", "--dry-run"],
        env: {
          GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
          GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
        },
      }),
    /RUN_LIVE_CHAT_REACTIONS_SMOKE=1/,
  );
});

test("dry-run lifecycle plan records reaction write gates", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadReactionsSmokeConfig({
    argv: ["node", "chat-reactions-smoke.mjs", "--dry-run"],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_AI_ENABLE_LIVE_REACTION_WRITES: undefined,
    }),
  });
  const plan = buildReactionsSmokePlan(config);

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.lifecycle, true);
  assert.deepEqual(
    plan.calls.map((call) => call.operation),
    [
      "spaces.get",
      "spaces.messages.create",
      "spaces.messages.reactions.create",
      "spaces.messages.reactions.list",
      "spaces.messages.reactions.list.filtered",
      "spaces.messages.reactions.delete",
      "spaces.messages.reactions.list.after-delete",
      "spaces.messages.delete",
    ],
  );
  assert.deepEqual(plan.calls[2].requiredScopes, [
    "https://www.googleapis.com/auth/chat.messages.reactions",
  ]);
});

test("list-only plan is read-only and requires an in-space message", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadReactionsSmokeConfig({
        argv: ["node", "chat-reactions-smoke.mjs", "--list-only"],
        env: smokeEnv(metadataPath),
      }),
    /--list-only requires --message-name/,
  );

  const config = await loadReactionsSmokeConfig({
    argv: [
      "node",
      "chat-reactions-smoke.mjs",
      "--dry-run",
      "--list-only",
      "--message-name=spaces/AAAA-smoke/messages/msg-1",
    ],
    env: smokeEnv(metadataPath),
  });
  const plan = buildReactionsSmokePlan(config);

  assert.equal(plan.lifecycle, false);
  assert.deepEqual(
    plan.calls.map((call) => call.operation),
    [
      "spaces.messages.reactions.list",
      "spaces.messages.reactions.list.filtered",
    ],
  );
  assert.deepEqual(plan.calls[0].requiredScopes, [
    "https://www.googleapis.com/auth/chat.messages.reactions.readonly",
  ]);
});

test("runReactionsSmoke creates, lists, filters, deletes, and cleans up", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadReactionsSmokeConfig({
    argv: ["node", "chat-reactions-smoke.mjs"],
    env: smokeEnv(metadataPath),
  });
  const calls = [];

  const result = await runReactionsSmoke(config, {
    appClient: fakeAppClient(calls),
    userClient: fakeUserClient(calls),
    writeEvidence: false,
  });
  const serialized = JSON.stringify(result.evidence);

  assert.equal(result.ok, true);
  assert.equal(result.evidence.assertions.targetMessageCreated, true);
  assert.equal(result.evidence.assertions.reactionCreated, true);
  assert.equal(result.evidence.assertions.listSawCreatedReaction, true);
  assert.equal(result.evidence.assertions.filteredListSawCreatedReaction, true);
  assert.equal(result.evidence.assertions.reactionDeleted, true);
  assert.equal(result.evidence.assertions.afterDeleteCreatedReactionAbsent, true);
  assert.equal(result.evidence.assertions.messageDeleted, true);
  assert.deepEqual(calls, [
    "app.getSpace:spaces/AAAA-smoke",
    "app.createMessage:spaces/AAAA-smoke:Google Chat AI SDK Smoke reaction smoke reactions-test",
    "user.createReaction:spaces/AAAA-smoke/messages/private-message-id:\u{1F44D}",
    "user.listReactions:spaces/AAAA-smoke/messages/private-message-id:",
    'user.listReactions:spaces/AAAA-smoke/messages/private-message-id:emoji.unicode = "\u{1F44D}"',
    "user.deleteReaction:spaces/AAAA-smoke/messages/private-message-id/reactions/private-reaction-id",
    'user.listReactions:spaces/AAAA-smoke/messages/private-message-id:emoji.unicode = "\u{1F44D}"',
    "app.deleteMessage:spaces/AAAA-smoke/messages/private-message-id",
  ]);
  assert.equal(serialized.includes("private-message-id"), false);
  assert.equal(serialized.includes("private-reaction-id"), false);
  assert.equal(serialized.includes("Private User"), false);
  assert.equal(serialized.includes("private.user@example.com"), false);
});

test("runReactionsSmoke refuses lifecycle writes when the write gate is missing", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadReactionsSmokeConfig({
    argv: ["node", "chat-reactions-smoke.mjs"],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_AI_ENABLE_LIVE_REACTION_WRITES: undefined,
    }),
  });
  const calls = [];

  await assert.rejects(
    () =>
      runReactionsSmoke(config, {
        appClient: fakeAppClient(calls),
        userClient: fakeUserClient(calls),
        writeEvidence: false,
      }),
    /GOOGLE_CHAT_AI_ENABLE_LIVE_REACTION_WRITES=1/,
  );
  assert.deepEqual(calls, []);
});
