import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCustomEmojisSmokePlan,
  loadCustomEmojisSmokeConfig,
  runCustomEmojisSmoke,
} from "./chat-custom-emojis-smoke.mjs";
import { UserAuthRequiredError } from "../chat/user-auth-smoke.mjs";

const SMOKE_SPACE_PREFIX = "Google Chat AI SDK Smoke";

async function writeMetadata(t, overrides = {}) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "chat-custom-emojis-smoke-test-"),
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
    RUN_LIVE_CHAT_CUSTOM_EMOJIS_SMOKE: "1",
    GOOGLE_CLOUD_PROJECT: "unit-project",
    GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
    GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
    GOOGLE_CHAT_CUSTOM_EMOJIS_SMOKE_RUN_ID: "custom-emojis-test",
    GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS: "/tmp/oauth-client.json",
    GOOGLE_CHAT_USER_TOKEN_STORE: "/tmp/user-token.json",
    ...overrides,
  };
}

test("loadCustomEmojisSmokeConfig refuses live run without explicit guard", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadCustomEmojisSmokeConfig({
        argv: ["node", "chat-custom-emojis-smoke.mjs"],
        env: {
          GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
          GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
        },
      }),
    /RUN_LIVE_CHAT_CUSTOM_EMOJIS_SMOKE=1/,
  );
});

test("dry-run plan is read-only and uses custom emoji readonly scope", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadCustomEmojisSmokeConfig({
    argv: [
      "node",
      "chat-custom-emojis-smoke.mjs",
      "--dry-run",
      "--created-by-me",
    ],
    env: smokeEnv(metadataPath, {
      RUN_LIVE_CHAT_CUSTOM_EMOJIS_SMOKE: undefined,
    }),
  });
  const plan = buildCustomEmojisSmokePlan(config);
  const result = await runCustomEmojisSmoke(config);
  const serialized = JSON.stringify(result);

  assert.equal(plan.writes, false);
  assert.equal(plan.authPrincipal, "user");
  assert.deepEqual(plan.requiredScopes, [
    "https://www.googleapis.com/auth/chat.customemojis.readonly",
  ]);
  assert.equal(plan.query.filter, 'creator("users/me")');
  assert.equal(result.ok, true);
  assert.equal(result.status, "dry_run");
  assert.equal(serialized.includes("spaces/AAAA-smoke"), false);
  assert.equal(serialized.includes(`${SMOKE_SPACE_PREFIX} Unit Test`), false);
});

test("runCustomEmojisSmoke saves redacted custom emoji summaries", async (t) => {
  const metadataPath = await writeMetadata(t);
  const writes = [];
  const config = await loadCustomEmojisSmokeConfig({
    argv: [
      "node",
      "chat-custom-emojis-smoke.mjs",
      "--expect-min-custom-emojis=1",
      "--page-size=5",
    ],
    env: smokeEnv(metadataPath),
  });
  const result = await runCustomEmojisSmoke(config, {
    readFile: async () => JSON.stringify({ installed: { client_id: "id" } }),
    readOAuthClientConfigImpl: () => ({ clientId: "id" }),
    mkdir: async () => {},
    writeFile: async (_path, data) => {
      writes.push(data);
    },
    chatRequestWithUserAuthImpl: async ({ scopes, url }) => {
      assert.deepEqual(scopes, [
        "https://www.googleapis.com/auth/chat.customemojis.readonly",
      ]);
      assert.equal(url.includes("pageSize=5"), true);
      return {
        ok: true,
        status: 200,
        attempts: 1,
        refreshed: false,
        replayedAfter401: false,
        retryDecisions: [],
        json: {
          customEmojis: [
            {
              name: "customEmojis/secret-party",
              uid: "secret-uid",
              emojiName: ":party_secret:",
              temporaryImageUri: "https://example.com/secret.png",
              creator: {
                name: "users/123",
                displayName: "Ada Lovelace",
                email: "ada@example.com",
                type: "HUMAN",
              },
            },
          ],
        },
      };
    },
    now: () => new Date("2026-07-02T18:45:00Z"),
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.status, "verified");
  assert.equal(result.response.customEmojiCount, 1);
  assert.equal(result.response.customEmojiSummaries[0].hasTemporaryImageUri, true);
  assert.equal(
    result.assertions.expectedMinCustomEmojisMatches,
    true,
  );
  assert.equal(writes.length, 1);
  assert.equal(serialized.includes("secret-party"), false);
  assert.equal(serialized.includes("secret-uid"), false);
  assert.equal(serialized.includes(":party_secret:"), false);
  assert.equal(serialized.includes("example.com"), false);
  assert.equal(serialized.includes("Ada Lovelace"), false);
  assert.equal(serialized.includes("ada@example.com"), false);
});

test("runCustomEmojisSmoke can get a listed custom emoji by expected emoji name", async (t) => {
  const metadataPath = await writeMetadata(t);
  const requests = [];
  const config = await loadCustomEmojisSmokeConfig({
    argv: [
      "node",
      "chat-custom-emojis-smoke.mjs",
      "--exercise-get",
      "--expect-emoji-name=test",
      "--expect-min-custom-emojis=1",
    ],
    env: smokeEnv(metadataPath),
  });
  const result = await runCustomEmojisSmoke(config, {
    readFile: async () => JSON.stringify({ installed: { client_id: "id" } }),
    readOAuthClientConfigImpl: () => ({ clientId: "id" }),
    mkdir: async () => {},
    writeFile: async () => {},
    chatRequestWithUserAuthImpl: async ({ url }) => {
      requests.push(url);
      if (url.endsWith("/v1/customEmojis?pageSize=25")) {
        return {
          ok: true,
          status: 200,
          attempts: 1,
          refreshed: false,
          replayedAfter401: false,
          retryDecisions: [],
          json: {
            customEmojis: [
              {
                name: "customEmojis/test-resource",
                uid: "test-uid",
                emojiName: ":test:",
                temporaryImageUri: "https://example.com/test.png",
                creator: {
                  name: "users/123",
                  displayName: "Ada Lovelace",
                  email: "ada@example.com",
                  type: "HUMAN",
                },
              },
            ],
          },
        };
      }
      assert.equal(url.endsWith("/v1/customEmojis/test-resource"), true);
      return {
        ok: true,
        status: 200,
        attempts: 1,
        refreshed: false,
        replayedAfter401: false,
        retryDecisions: [],
        json: {
          name: "customEmojis/test-resource",
          uid: "test-uid",
          emojiName: ":test:",
          temporaryImageUri: "https://example.com/test.png",
          creator: {
            name: "users/123",
            displayName: "Ada Lovelace",
            email: "ada@example.com",
            type: "HUMAN",
          },
        },
      };
    },
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(result.request.exerciseGet, true);
  assert.equal(result.assertions.expectedEmojiNameMatches, true);
  assert.equal(result.assertions.selectedGetTargetAvailable, true);
  assert.equal(result.assertions.getVerified, true);
  assert.equal(result.assertions.getNameMatchesList, true);
  assert.equal(result.assertions.getEmojiNameMatchesList, true);
  assert.equal(result.response.get.status, 200);
  assert.equal(result.response.get.selectedFromList, true);
  assert.equal(result.response.get.nameMatchesList, true);
  assert.equal(result.response.get.emojiNameMatchesList, true);
  assert.equal(serialized.includes("customEmojis/test-resource"), false);
  assert.equal(serialized.includes("test-uid"), false);
  assert.equal(serialized.includes(":test:"), false);
  assert.equal(serialized.includes("example.com"), false);
  assert.equal(serialized.includes("Ada Lovelace"), false);
  assert.equal(serialized.includes("ada@example.com"), false);
});

test("runCustomEmojisSmoke fails get when expected emoji name is missing", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadCustomEmojisSmokeConfig({
    argv: [
      "node",
      "chat-custom-emojis-smoke.mjs",
      "--exercise-get",
      "--expect-emoji-name=:test:",
      "--expect-min-custom-emojis=1",
    ],
    env: smokeEnv(metadataPath),
  });
  const result = await runCustomEmojisSmoke(config, {
    readFile: async () => JSON.stringify({ installed: { client_id: "id" } }),
    readOAuthClientConfigImpl: () => ({ clientId: "id" }),
    mkdir: async () => {},
    writeFile: async () => {},
    chatRequestWithUserAuthImpl: async () => ({
      ok: true,
      status: 200,
      attempts: 1,
      refreshed: false,
      replayedAfter401: false,
      retryDecisions: [],
      json: {
        customEmojis: [
          {
            name: "customEmojis/other-resource",
            uid: "other-uid",
            emojiName: ":other:",
          },
        ],
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.assertions.expectedEmojiNameMatches, false);
  assert.equal(result.assertions.selectedGetTargetAvailable, false);
  assert.equal(result.assertions.getVerified, false);
  assert.equal(result.response.get.selectedFromList, false);
});

test("runCustomEmojisSmoke records disabled or unavailable API responses as allowed blocked", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadCustomEmojisSmokeConfig({
    argv: ["node", "chat-custom-emojis-smoke.mjs", "--allow-blocked"],
    env: smokeEnv(metadataPath),
  });
  const result = await runCustomEmojisSmoke(config, {
    readFile: async () => JSON.stringify({ installed: { client_id: "id" } }),
    readOAuthClientConfigImpl: () => ({ clientId: "id" }),
    mkdir: async () => {},
    writeFile: async () => {},
    chatRequestWithUserAuthImpl: async () => ({
      ok: false,
      status: 403,
      attempts: 1,
      refreshed: false,
      replayedAfter401: false,
      retryDecisions: [],
      json: { error: { status: "PERMISSION_DENIED" } },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "blocked");
  assert.equal(result.response.allowedBlocked, true);
  assert.equal(result.response.blockedReason, "permission_or_custom_emoji_disabled");
});

test("runCustomEmojisSmoke records missing user scope as allowed blocked evidence", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadCustomEmojisSmokeConfig({
    argv: ["node", "chat-custom-emojis-smoke.mjs", "--allow-blocked"],
    env: smokeEnv(metadataPath),
  });
  const result = await runCustomEmojisSmoke(config, {
    readFile: async () => JSON.stringify({ installed: { client_id: "id" } }),
    readOAuthClientConfigImpl: () => ({ clientId: "id" }),
    mkdir: async () => {},
    writeFile: async () => {},
    chatRequestWithUserAuthImpl: async () => {
      throw new UserAuthRequiredError("scope needed", {
        reason: "missing_requested_scopes",
        scopes: ["https://www.googleapis.com/auth/chat.customemojis.readonly"],
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "blocked");
  assert.equal(result.response.status, null);
  assert.equal(result.response.attempts, 0);
  assert.equal(result.response.allowedBlocked, true);
  assert.equal(result.response.blockedReason, "missing_requested_scopes");
  assert.deepEqual(result.response.authRequired.scopes, [
    "https://www.googleapis.com/auth/chat.customemojis.readonly",
  ]);
});

test("runCustomEmojisSmoke fails expected minimum mismatches", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadCustomEmojisSmokeConfig({
    argv: ["node", "chat-custom-emojis-smoke.mjs", "--expect-min-custom-emojis=1"],
    env: smokeEnv(metadataPath),
  });
  const result = await runCustomEmojisSmoke(config, {
    readFile: async () => JSON.stringify({ installed: { client_id: "id" } }),
    readOAuthClientConfigImpl: () => ({ clientId: "id" }),
    mkdir: async () => {},
    writeFile: async () => {},
    chatRequestWithUserAuthImpl: async () => ({
      ok: true,
      status: 200,
      attempts: 1,
      refreshed: false,
      replayedAfter401: false,
      retryDecisions: [],
      json: { customEmojis: [] },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "verified");
  assert.equal(result.assertions.expectedMinCustomEmojisMatches, false);
});
