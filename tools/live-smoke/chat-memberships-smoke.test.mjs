import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildMembershipsSmokePlan,
  loadMembershipsSmokeConfig,
  runMembershipsSmoke,
} from "./chat-memberships-smoke.mjs";
import { SMOKE_SPACE_PREFIX } from "./chat-smoke.mjs";

async function writeMetadata(t, overrides = {}) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "chat-memberships-smoke-test-"),
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
    RUN_LIVE_CHAT_MEMBERSHIPS_SMOKE: "1",
    GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
    GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
    GOOGLE_CHAT_MEMBERSHIPS_SMOKE_RUN_ID: "memberships-test",
    GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS: "/tmp/oauth-client.json",
    GOOGLE_CHAT_USER_TOKEN_STORE: "/tmp/user-token.json",
    ...overrides,
  };
}

function fakeClient(calls) {
  return {
    async listMemberships(query) {
      calls.push(`list:${query.pageSize}:${query.pageToken ?? ""}:${query.filter ?? ""}`);
      const human = {
        name: "spaces/AAAA-smoke/members/users/private-human",
        state: "JOINED",
        role: "ROLE_MEMBER",
        createTime: "2026-07-01T10:00:00Z",
        member: {
          name: "users/private-human",
          displayName: "Private Human",
          email: "human@example.com",
          type: "HUMAN",
        },
      };
      const bot = {
        name: "spaces/AAAA-smoke/members/app",
        state: "JOINED",
        role: "ROLE_MEMBER",
        createTime: "2026-07-01T10:01:00Z",
        member: {
          name: "users/app",
          displayName: "Private App",
          type: "BOT",
        },
      };

      if (query.pageToken === "next-page") {
        return {
          ok: true,
          status: 200,
          refreshed: false,
          replayedAfter401: false,
          json: { memberships: [bot] },
        };
      }

      return {
        ok: true,
        status: 200,
        refreshed: true,
        replayedAfter401: false,
        json: { memberships: [human], nextPageToken: "next-page" },
      };
    },

    async getMembership(name) {
      calls.push(`get:${name}`);
      return {
        ok: true,
        status: 200,
        refreshed: false,
        replayedAfter401: false,
        json: {
          name: "spaces/AAAA-smoke/members/app",
          state: "JOINED",
          role: "ROLE_MEMBER",
          member: {
            name: "users/app",
            displayName: "Private App",
            type: "BOT",
          },
        },
      };
    },
  };
}

test("loadMembershipsSmokeConfig refuses to run without explicit guard", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadMembershipsSmokeConfig({
        argv: ["node", "chat-memberships-smoke.mjs", "--dry-run"],
        env: {
          GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
          GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
        },
      }),
    /RUN_LIVE_CHAT_MEMBERSHIPS_SMOKE=1/,
  );
});

test("dry-run plan records read-only list and app membership lookup", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadMembershipsSmokeConfig({
    argv: [
      "node",
      "chat-memberships-smoke.mjs",
      "--dry-run",
      "--filter=member.type = \"HUMAN\"",
      "--show-groups",
      "--expect-min-human-members=1",
    ],
    env: smokeEnv(metadataPath),
  });
  const plan = buildMembershipsSmokePlan(config);

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.calls.every((call) => call.writes === false), true);
  assert.deepEqual(
    plan.calls.map((call) => call.operation),
    ["spaces.members.list", "spaces.members.get.app"],
  );
  assert.deepEqual(plan.calls[0].requiredScopes, [
    "https://www.googleapis.com/auth/chat.memberships.readonly",
  ]);
  assert.equal(plan.calls[0].query.showGroups, true);
  assert.equal(plan.calls[0].query.showInvited, undefined);
});

test("runMembershipsSmoke paginates, resolves app membership, and redacts identities", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadMembershipsSmokeConfig({
    argv: [
      "node",
      "chat-memberships-smoke.mjs",
      "--page-size=1",
      "--limit=5",
      "--expect-min-memberships=2",
      "--expect-min-human-members=1",
      "--expect-min-bot-members=1",
    ],
    env: smokeEnv(metadataPath),
  });
  const calls = [];

  const result = await runMembershipsSmoke(config, {
    client: fakeClient(calls),
    writeEvidence: false,
  });
  const serialized = JSON.stringify(result.evidence);

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "list:1::",
    "list:1:next-page:",
    "get:spaces/AAAA-smoke/members/app",
  ]);
  assert.equal(result.evidence.memberships.summary.totalMemberships, 2);
  assert.equal(result.evidence.memberships.summary.byMemberType.HUMAN, 1);
  assert.equal(result.evidence.memberships.summary.byMemberType.BOT, 1);
  assert.equal(result.evidence.assertions.minMemberships, true);
  assert.equal(result.evidence.assertions.minHumanMembers, true);
  assert.equal(result.evidence.assertions.minBotMembers, true);
  assert.equal(result.evidence.assertions.appMembershipResolved, true);
  assert.equal(serialized.includes("private-human"), false);
  assert.equal(serialized.includes("Private Human"), false);
  assert.equal(serialized.includes("human@example.com"), false);
  assert.equal(serialized.includes("spaces/AAAA-smoke/members/app"), false);
});

test("runMembershipsSmoke can skip app membership lookup", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadMembershipsSmokeConfig({
    argv: ["node", "chat-memberships-smoke.mjs", "--skip-app-get"],
    env: smokeEnv(metadataPath),
  });
  const calls = [];

  const result = await runMembershipsSmoke(config, {
    client: fakeClient(calls),
    writeEvidence: false,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.some((call) => call.startsWith("get:")), false);
  assert.equal(result.evidence.assertions.appMembershipResolved, null);
});

test("runMembershipsSmoke fails assertions with redacted evidence", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadMembershipsSmokeConfig({
    argv: [
      "node",
      "chat-memberships-smoke.mjs",
      "--skip-app-get",
      "--expect-min-human-members=3",
    ],
    env: smokeEnv(metadataPath),
  });

  await assert.rejects(
    () =>
      runMembershipsSmoke(config, {
        client: fakeClient([]),
        writeEvidence: false,
      }),
    /minHumanMembers/,
  );
});
