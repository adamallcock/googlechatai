import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadPreviewSurfacesSmokeConfig,
  runPreviewSurfacesSmoke,
} from "./chat-preview-surfaces-smoke.mjs";

const SMOKE_SPACE_PREFIX = "Google Chat AI SDK Smoke";

async function writeMetadata(t, overrides = {}) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "chat-preview-surfaces-smoke-test-"),
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
    RUN_LIVE_CHAT_PREVIEW_SURFACES_SMOKE: "1",
    GOOGLE_CLOUD_PROJECT: "unit-project",
    GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
    GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
    GOOGLE_CHAT_PREVIEW_SURFACES_SMOKE_RUN_ID: "preview-surfaces-test",
    GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS: "/tmp/oauth-client.json",
    GOOGLE_CHAT_USER_TOKEN_STORE: "/tmp/user-token.json",
    ...overrides,
  };
}

test("loadPreviewSurfacesSmokeConfig refuses live run without explicit guard", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadPreviewSurfacesSmokeConfig({
        argv: ["node", "chat-preview-surfaces-smoke.mjs"],
        env: {
          GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
          GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
        },
      }),
    /RUN_LIVE_CHAT_PREVIEW_SURFACES_SMOKE=1/,
  );
});

test("dry-run plan is read-only and redacted", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadPreviewSurfacesSmokeConfig({
    argv: ["node", "chat-preview-surfaces-smoke.mjs", "--dry-run"],
    env: smokeEnv(metadataPath, {
      RUN_LIVE_CHAT_PREVIEW_SURFACES_SMOKE: undefined,
    }),
  });
  const result = await runPreviewSurfacesSmoke(config);
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.status, "dry_run");
  assert.equal(result.plan.length, 2);
  assert.equal(result.plan.every((surface) => surface.write === false), true);
  assert.equal(
    result.plan.every((surface) => surface.authPrincipal === "user"),
    true,
  );
  assert.equal(serialized.includes("spaces/AAAA-smoke"), false);
  assert.equal(serialized.includes(`${SMOKE_SPACE_PREFIX} Unit Test`), false);
});

test("runPreviewSurfacesSmoke records allowed blocked surfaces without raw payloads", async (t) => {
  const metadataPath = await writeMetadata(t);
  const writes = [];
  const config = await loadPreviewSurfacesSmokeConfig({
    argv: [
      "node",
      "chat-preview-surfaces-smoke.mjs",
      "--allow-blocked",
      "--page-size=2",
    ],
    env: smokeEnv(metadataPath),
  });
  const result = await runPreviewSurfacesSmoke(config, {
    readFile: async () => JSON.stringify({ installed: { client_id: "id" } }),
    readOAuthClientConfigImpl: () => ({ clientId: "id" }),
    mkdir: async () => {},
    writeFile: async (_path, data) => {
      writes.push(data);
    },
    chatRequestWithUserAuthImpl: async ({ url, init }) => ({
      ok: false,
      status: 404,
      attempts: 1,
      refreshed: false,
      replayedAfter401: false,
      retryDecisions: [],
      headers: {},
      json: {
        error: {
          status: "NOT_FOUND",
          message: `missing ${url} ${init.body ?? ""} secret text`,
        },
      },
    }),
    now: () => new Date("2026-07-02T18:30:00Z"),
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.status, "blocked");
  assert.equal(result.surfaces.length, 2);
  assert.equal(
    result.surfaces.every((surface) => surface.allowedBlocked === true),
    true,
  );
  assert.equal(writes.length, 1);
  assert.equal(serialized.includes("secret text"), false);
  assert.equal(serialized.includes("spaces/AAAA-smoke"), false);
  assert.equal(serialized.includes("missing https://"), false);
});

test("runPreviewSurfacesSmoke fails blocked surfaces unless explicitly allowed", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadPreviewSurfacesSmokeConfig({
    argv: ["node", "chat-preview-surfaces-smoke.mjs", "--surface=messagesSearch"],
    env: smokeEnv(metadataPath),
  });
  const result = await runPreviewSurfacesSmoke(config, {
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
      headers: {},
      json: { error: { status: "PERMISSION_DENIED" } },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.surfaces[0].allowedBlocked, false);
});
