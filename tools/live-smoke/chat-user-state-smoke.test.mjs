import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { UserAuthRequiredError } from "../chat/user-auth-smoke.mjs";
import {
  loadUserStateSmokeConfig,
  runUserStateSmoke,
} from "./chat-user-state-smoke.mjs";

const SMOKE_SPACE_PREFIX = "Google Chat AI SDK Smoke";

async function writeMetadata(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-user-state-test-"));
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
    RUN_LIVE_CHAT_USER_STATE_SMOKE: "1",
    GOOGLE_CLOUD_PROJECT: "unit-project",
    GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
    GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
    GOOGLE_CHAT_USER_STATE_SMOKE_RUN_ID: "user-state-test",
    GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS: "/tmp/oauth-client.json",
    GOOGLE_CHAT_USER_TOKEN_STORE: "/tmp/user-token.json",
    ...overrides,
  };
}

test("loadUserStateSmokeConfig refuses live run without explicit guard", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadUserStateSmokeConfig({
        argv: ["node", "chat-user-state-smoke.mjs"],
        env: {
          GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
          GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
        },
      }),
    /RUN_LIVE_CHAT_USER_STATE_SMOKE=1/,
  );
});

test("dry-run plan is read-only user-auth and redacted", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadUserStateSmokeConfig({
    argv: ["node", "chat-user-state-smoke.mjs", "--dry-run"],
    env: smokeEnv(metadataPath, {
      RUN_LIVE_CHAT_USER_STATE_SMOKE: undefined,
    }),
  });
  const result = await runUserStateSmoke(config);
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.status, "dry_run");
  assert.equal(result.plan.length, 2);
  assert.equal(result.plan.every((surface) => surface.write === false), true);
  assert.equal(
    result.plan.every((surface) => surface.authPrincipal === "user"),
    true,
  );
  assert.ok(
    result.plan.some((surface) => surface.docsStatus === "developer_preview"),
  );
  assert.equal(serialized.includes("spaces/AAAA-smoke"), false);
  assert.equal(serialized.includes(`${SMOKE_SPACE_PREFIX} Unit Test`), false);
});

test("notification patch mutation refuses live run without explicit write gate", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadUserStateSmokeConfig({
        argv: [
          "node",
          "chat-user-state-smoke.mjs",
          "--exercise-notification-patch",
        ],
        env: smokeEnv(metadataPath, {
          GOOGLE_CHAT_AI_ENABLE_LIVE_USER_SETTINGS_WRITE: undefined,
        }),
      }),
    /GOOGLE_CHAT_AI_ENABLE_LIVE_USER_SETTINGS_WRITE=1/,
  );
});

test("space read-state update refuses live run without explicit write gate", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadUserStateSmokeConfig({
        argv: [
          "node",
          "chat-user-state-smoke.mjs",
          "--exercise-space-read-state-update",
        ],
        env: smokeEnv(metadataPath, {
          GOOGLE_CHAT_AI_ENABLE_LIVE_USER_READ_STATE_WRITE: undefined,
        }),
      }),
    /GOOGLE_CHAT_AI_ENABLE_LIVE_USER_READ_STATE_WRITE=1/,
  );
});

test("notification patch dry-run exposes reversible user-write plan", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadUserStateSmokeConfig({
    argv: [
      "node",
      "chat-user-state-smoke.mjs",
      "--dry-run",
      "--exercise-notification-patch",
    ],
    env: smokeEnv(metadataPath, {
      RUN_LIVE_CHAT_USER_STATE_SMOKE: undefined,
    }),
  });
  const result = await runUserStateSmoke(config);
  const writePlan = result.plan.filter((surface) => surface.write);

  assert.equal(result.ok, true);
  assert.equal(writePlan.length, 1);
  assert.equal(writePlan[0].surface, "users.spaces.spaceNotificationSetting.patch");
  assert.equal(writePlan[0].reversible, true);
  assert.equal(
    writePlan[0].explicitWriteGate,
    "GOOGLE_CHAT_AI_ENABLE_LIVE_USER_SETTINGS_WRITE",
  );
});

test("space read-state update dry-run exposes idempotent user-write plan", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadUserStateSmokeConfig({
    argv: [
      "node",
      "chat-user-state-smoke.mjs",
      "--dry-run",
      "--exercise-space-read-state-update",
    ],
    env: smokeEnv(metadataPath, {
      RUN_LIVE_CHAT_USER_STATE_SMOKE: undefined,
    }),
  });
  const result = await runUserStateSmoke(config);
  const writePlan = result.plan.filter((surface) => surface.write);

  assert.equal(result.ok, true);
  assert.equal(writePlan.length, 1);
  assert.equal(writePlan[0].surface, "users.spaces.updateSpaceReadState");
  assert.equal(writePlan[0].idempotentNoOp, true);
  assert.equal(
    writePlan[0].explicitWriteGate,
    "GOOGLE_CHAT_AI_ENABLE_LIVE_USER_READ_STATE_WRITE",
  );
});

test("thread read-state surface requires a thread resource", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadUserStateSmokeConfig({
        argv: [
          "node",
          "chat-user-state-smoke.mjs",
          "--dry-run",
          "--surface=threadReadState",
        ],
        env: smokeEnv(metadataPath, {
          RUN_LIVE_CHAT_USER_STATE_SMOKE: undefined,
        }),
      }),
    /requires --thread/,
  );
});

test("thread resource must belong to the smoke space", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadUserStateSmokeConfig({
        argv: [
          "node",
          "chat-user-state-smoke.mjs",
          "--dry-run",
          "--thread=spaces/OTHER/threads/thread-1",
        ],
        env: smokeEnv(metadataPath, {
          RUN_LIVE_CHAT_USER_STATE_SMOKE: undefined,
        }),
      }),
    /belong to the configured smoke space/,
  );
});

test("runUserStateSmoke patches notification setting and restores original", async (t) => {
  const metadataPath = await writeMetadata(t);
  const calls = [];
  const config = await loadUserStateSmokeConfig({
    argv: [
      "node",
      "chat-user-state-smoke.mjs",
      "--surface=spaceNotificationSetting",
      "--exercise-notification-patch",
    ],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_AI_ENABLE_LIVE_USER_SETTINGS_WRITE: "1",
    }),
  });
  const result = await runUserStateSmoke(config, {
    readFile: async () => JSON.stringify({ installed: { client_id: "id" } }),
    readOAuthClientConfigImpl: () => ({ clientId: "id" }),
    mkdir: async () => {},
    writeFile: async () => {},
    chatRequestWithUserAuthImpl: async ({ url, init }) => {
      calls.push({ url, init });
      if (init.method === "PATCH") {
        const body = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          attempts: 1,
          refreshed: false,
          replayedAfter401: false,
          retryDecisions: [],
          headers: {},
          json: {
            name: "users/me/spaces/AAAA-smoke/spaceNotificationSetting",
            notificationSetting: body.notificationSetting,
            muteSetting: "UNMUTED",
          },
        };
      }
      return {
        ok: true,
        status: 200,
        attempts: 1,
        refreshed: false,
        replayedAfter401: false,
        retryDecisions: [],
        headers: {},
        json: {
          name: "users/me/spaces/AAAA-smoke/spaceNotificationSetting",
          notificationSetting: "MAIN_CONVERSATIONS",
          muteSetting: "UNMUTED",
        },
      };
    },
  });
  const patchBodies = calls
    .filter((call) => call.init.method === "PATCH")
    .map((call) => JSON.parse(call.init.body));
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.status, "verified");
  assert.equal(result.mutations.length, 1);
  assert.equal(result.mutations[0].targetNotificationSetting, "FOR_YOU");
  assert.equal(result.mutations[0].changedAwayFromOriginal, true);
  assert.equal(result.mutations[0].restoredOriginal, true);
  assert.deepEqual(
    patchBodies.map((body) => body.notificationSetting),
    ["FOR_YOU", "MAIN_CONVERSATIONS"],
  );
  assert.ok(
    calls
      .filter((call) => call.init.method === "PATCH")
      .every((call) => call.url.includes("updateMask=notificationSetting")),
  );
  assert.equal(serialized.includes("users/me/spaces/AAAA-smoke"), false);
});

test("runUserStateSmoke updates space read-state idempotently", async (t) => {
  const metadataPath = await writeMetadata(t);
  const calls = [];
  const lastReadTime = "2026-07-03T05:59:59Z";
  const config = await loadUserStateSmokeConfig({
    argv: [
      "node",
      "chat-user-state-smoke.mjs",
      "--surface=spaceReadState",
      "--exercise-space-read-state-update",
    ],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_AI_ENABLE_LIVE_USER_READ_STATE_WRITE: "1",
    }),
  });
  const result = await runUserStateSmoke(config, {
    readFile: async () => JSON.stringify({ installed: { client_id: "id" } }),
    readOAuthClientConfigImpl: () => ({ clientId: "id" }),
    mkdir: async () => {},
    writeFile: async () => {},
    chatRequestWithUserAuthImpl: async ({ url, init, scopes }) => {
      calls.push({ url, init, scopes });
      if (init.method === "PATCH") {
        const body = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          attempts: 1,
          refreshed: false,
          replayedAfter401: false,
          retryDecisions: [],
          headers: {},
          json: {
            name: "users/me/spaces/AAAA-smoke/spaceReadState",
            lastReadTime: body.lastReadTime,
          },
        };
      }
      return {
        ok: true,
        status: 200,
        attempts: 1,
        refreshed: false,
        replayedAfter401: false,
        retryDecisions: [],
        headers: {},
        json: {
          name: "users/me/spaces/AAAA-smoke/spaceReadState",
          lastReadTime,
        },
      };
    },
  });
  const patchCall = calls.find((call) => call.init.method === "PATCH");
  const patchBody = JSON.parse(patchCall.init.body);
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.status, "verified");
  assert.equal(result.mutations.length, 1);
  assert.equal(result.mutations[0].surface, "users.spaces.updateSpaceReadState");
  assert.equal(result.mutations[0].preservedLastReadTime, true);
  assert.equal(patchBody.lastReadTime, lastReadTime);
  assert.ok(patchCall.url.includes("updateMask=lastReadTime"));
  assert.ok(
    patchCall.scopes.includes("https://www.googleapis.com/auth/chat.users.readstate"),
  );
  assert.equal(serialized.includes(lastReadTime), false);
  assert.equal(serialized.includes("users/me/spaces/AAAA-smoke"), false);
});

test("runUserStateSmoke records allowed auth-required surfaces", async (t) => {
  const metadataPath = await writeMetadata(t);
  const writes = [];
  const config = await loadUserStateSmokeConfig({
    argv: [
      "node",
      "chat-user-state-smoke.mjs",
      "--allow-blocked",
      "--surface=spaceNotificationSetting",
    ],
    env: smokeEnv(metadataPath),
  });
  const result = await runUserStateSmoke(config, {
    readFile: async () => JSON.stringify({ installed: { client_id: "id" } }),
    readOAuthClientConfigImpl: () => ({ clientId: "id" }),
    mkdir: async () => {},
    writeFile: async (_path, data) => {
      writes.push(data);
    },
    chatRequestWithUserAuthImpl: async () => {
      throw new UserAuthRequiredError("missing scope secret", {
        reason: "missing_requested_scopes",
        scopes: ["https://www.googleapis.com/auth/chat.users.spacesettings"],
      });
    },
    now: () => new Date("2026-07-03T06:00:00Z"),
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.status, "blocked");
  assert.equal(result.surfaces.length, 1);
  assert.equal(result.surfaces[0].allowedBlocked, true);
  assert.equal(result.surfaces[0].blockedReason, "missing_requested_scopes");
  assert.equal(writes.length, 1);
  assert.equal(serialized.includes("missing scope secret"), false);
  assert.equal(serialized.includes("spaces/AAAA-smoke"), false);
});

test("runUserStateSmoke summarizes successful responses without raw names", async (t) => {
  const metadataPath = await writeMetadata(t);
  const requestedUrls = [];
  const config = await loadUserStateSmokeConfig({
    argv: [
      "node",
      "chat-user-state-smoke.mjs",
      "--thread=spaces/AAAA-smoke/threads/thread-1",
    ],
    env: smokeEnv(metadataPath),
  });
  const result = await runUserStateSmoke(config, {
    readFile: async () => JSON.stringify({ installed: { client_id: "id" } }),
    readOAuthClientConfigImpl: () => ({ clientId: "id" }),
    mkdir: async () => {},
    writeFile: async () => {},
    chatRequestWithUserAuthImpl: async ({ url }) => {
      requestedUrls.push(url);
      if (url.includes("spaceNotificationSetting")) {
        return {
          ok: true,
          status: 200,
          attempts: 1,
          refreshed: false,
          replayedAfter401: false,
          retryDecisions: [],
          headers: {},
          json: {
            name: "users/me/spaces/AAAA-smoke/spaceNotificationSetting",
            notificationSetting: "ALL",
            muteSetting: "UNMUTED",
          },
        };
      }
      return {
        ok: true,
        status: 200,
        attempts: 1,
        refreshed: true,
        replayedAfter401: false,
        retryDecisions: [],
        headers: {},
        json: {
          name: url.includes("threadReadState")
            ? "users/me/spaces/AAAA-smoke/threads/thread-1/threadReadState"
            : "users/me/spaces/AAAA-smoke/spaceReadState",
          lastReadTime: "2026-07-03T05:59:59Z",
        },
      };
    },
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.status, "verified");
  assert.equal(result.surfaces.length, 3);
  assert.ok(requestedUrls.every((url) => url.includes("users/me/spaces/AAAA-smoke")));
  assert.equal(
    result.surfaces.find((surface) =>
      surface.surface.includes("spaceNotificationSetting"),
    ).response.notificationSetting,
    "ALL",
  );
  assert.equal(serialized.includes("users/me/spaces/AAAA-smoke"), false);
  assert.equal(serialized.includes("thread-1/threadReadState"), false);
});
