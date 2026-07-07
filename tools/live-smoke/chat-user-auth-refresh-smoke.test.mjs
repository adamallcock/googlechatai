import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildUserAuthRefreshSmokePlan,
  loadUserAuthRefreshSmokeConfig,
  runUserAuthRefreshSmoke,
} from "./chat-user-auth-refresh-smoke.mjs";

async function makeTempDir(t) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "chat-user-auth-refresh-smoke-test-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function smokeEnv(overrides = {}) {
  return {
    RUN_LIVE_CHAT_USER_AUTH_REFRESH_SMOKE: "1",
    GOOGLE_CLOUD_PROJECT: "unit-project",
    GOOGLE_CHAT_USER_AUTH_REFRESH_SMOKE_RUN_ID: "user-auth-refresh-test",
    ...overrides,
  };
}

function sourceToken() {
  return {
    tokenType: "Bearer",
    accessToken: "source-access-token-secret",
    refreshToken: "source-refresh-token-secret",
    expiryDate: Date.now() + 60 * 60 * 1000,
    scope: "https://www.googleapis.com/auth/chat.spaces.readonly",
    scopes: ["https://www.googleapis.com/auth/chat.spaces.readonly"],
    principal: {
      kind: "user",
      email: "private-user@example.com",
    },
  };
}

async function writeCredentials(filePath) {
  await writeJson(filePath, {
    installed: {
      client_id: "unit-client.apps.googleusercontent.com",
      client_secret: "unit-secret",
      auth_uri: "https://accounts.google.com/o/oauth2/v2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      redirect_uris: ["http://127.0.0.1"],
    },
  });
}

test("loadUserAuthRefreshSmokeConfig refuses to run without explicit guard", async () => {
  await assert.rejects(
    () =>
      loadUserAuthRefreshSmokeConfig({
        argv: ["node", "chat-user-auth-refresh-smoke.mjs"],
        env: {},
      }),
    /RUN_LIVE_CHAT_USER_AUTH_REFRESH_SMOKE=1/,
  );
});

test("loadUserAuthRefreshSmokeConfig rejects scratch token paths outside .tokens", async (t) => {
  const dir = await makeTempDir(t);

  await assert.rejects(
    () =>
      loadUserAuthRefreshSmokeConfig({
        argv: [
          "node",
          "chat-user-auth-refresh-smoke.mjs",
          "--scratch-token-store",
          path.join(dir, "scratch-token.json"),
        ],
        env: smokeEnv(),
      }),
    /Scratch token store must be under/,
  );
});

test("dry-run plan records read-only user-auth refresh calls", async (t) => {
  const dir = await makeTempDir(t);
  const config = await loadUserAuthRefreshSmokeConfig({
    argv: [
      "node",
      "chat-user-auth-refresh-smoke.mjs",
      "--dry-run",
      "--source-token-store",
      path.join(dir, "source-token.json"),
      "--scratch-token-store",
      path.join(dir, "scratch-token.json"),
    ],
    env: smokeEnv(),
    allowExternalScratch: true,
  });
  const plan = buildUserAuthRefreshSmokePlan(config);

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.calls.length, 2);
  assert.equal(plan.calls.every((call) => call.writes === false), true);
  assert.equal(plan.calls.every((call) => call.authMode === "user"), true);
  assert.deepEqual(plan.calls.map((call) => call.operation), [
    "expired-token-refresh",
    "stale-token-401-replay",
  ]);
  assert.equal(plan.privacy.rawAccessTokensSaved, false);
  assert.equal(plan.privacy.refreshTokensSaved, false);
});

test("runUserAuthRefreshSmoke verifies refresh/replay without saving token secrets", async (t) => {
  const dir = await makeTempDir(t);
  const sourceTokenPath = path.join(dir, "source-token.json");
  const scratchTokenPath = path.join(dir, "scratch-token.json");
  const credentialsPath = path.join(dir, "oauth-client.json");
  await writeJson(sourceTokenPath, sourceToken());
  await writeCredentials(credentialsPath);
  const config = await loadUserAuthRefreshSmokeConfig({
    argv: [
      "node",
      "chat-user-auth-refresh-smoke.mjs",
      "--source-token-store",
      sourceTokenPath,
      "--scratch-token-store",
      scratchTokenPath,
    ],
    env: smokeEnv({
      GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS: credentialsPath,
    }),
    allowExternalScratch: true,
  });
  const calls = [];
  const result = await runUserAuthRefreshSmoke(config, {
    writeEvidence: false,
    async requestWithUserAuth(request) {
      const token = JSON.parse(await fs.readFile(request.tokenStorePath, "utf8"));
      calls.push({
        operation: request.operation,
        accessToken: token.accessToken,
        expiryDate: token.expiryDate,
      });
      return {
        ok: true,
        status: 200,
        json: { spaces: [{ name: "spaces/unit" }] },
        refreshed: true,
        replayedAfter401: request.operation === "stale-token-401-replay",
      };
    },
  });
  const serialized = JSON.stringify(result.evidence);

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.operation), [
    "expired-token-refresh",
    "stale-token-401-replay",
  ]);
  assert.equal(result.evidence.assertions.expiredTokenRefreshedBeforeCall, true);
  assert.equal(result.evidence.assertions.expiredTokenDidNotReplayAfter401, true);
  assert.equal(result.evidence.assertions.staleTokenRefreshedAfter401, true);
  assert.equal(result.evidence.assertions.staleTokenReplayedAfter401, true);
  assert.equal(result.evidence.scratchTokenStoreRemoved, true);
  await assert.rejects(() => fs.stat(scratchTokenPath), /ENOENT/);
  assert.equal(serialized.includes("source-access-token-secret"), false);
  assert.equal(serialized.includes("source-refresh-token-secret"), false);
  assert.equal(serialized.includes("private-user@example.com"), false);
  assert.equal(
    serialized.includes("invalid-user-auth-refresh-smoke-bearer"),
    false,
  );
});

test("runUserAuthRefreshSmoke removes scratch token store after failed operation", async (t) => {
  const dir = await makeTempDir(t);
  const sourceTokenPath = path.join(dir, "source-token.json");
  const scratchTokenPath = path.join(dir, "scratch-token.json");
  const credentialsPath = path.join(dir, "oauth-client.json");
  await writeJson(sourceTokenPath, sourceToken());
  await writeCredentials(credentialsPath);
  const config = await loadUserAuthRefreshSmokeConfig({
    argv: [
      "node",
      "chat-user-auth-refresh-smoke.mjs",
      "--source-token-store",
      sourceTokenPath,
      "--scratch-token-store",
      scratchTokenPath,
    ],
    env: smokeEnv({
      GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS: credentialsPath,
    }),
    allowExternalScratch: true,
  });

  await assert.rejects(
    () =>
      runUserAuthRefreshSmoke(config, {
        writeEvidence: false,
        async requestWithUserAuth(request) {
          return {
            ok: true,
            status: 200,
            json: { spaces: [] },
            refreshed: true,
            replayedAfter401: request.operation !== "stale-token-401-replay",
          };
        },
      }),
    /User-auth refresh smoke operation failed/,
  );
  await assert.rejects(() => fs.stat(scratchTokenPath), /ENOENT/);
});
