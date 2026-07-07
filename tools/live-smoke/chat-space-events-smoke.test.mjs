import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSpaceEventsSmokePlan,
  loadSpaceEventsSmokeConfig,
  runSpaceEventsSmoke,
} from "./chat-space-events-smoke.mjs";

const SMOKE_SPACE_PREFIX = "Google Chat AI SDK Smoke";

async function writeMetadata(t, overrides = {}) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "chat-space-events-smoke-test-"),
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
    RUN_LIVE_CHAT_SPACE_EVENTS_SMOKE: "1",
    GOOGLE_CLOUD_PROJECT: "unit-project",
    GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
    GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
    GOOGLE_CHAT_SPACE_EVENTS_SMOKE_RUN_ID: "space-events-test",
    GOOGLE_CHAT_SPACE_EVENTS_START_TIME: "2026-07-01T00:00:00Z",
    GOOGLE_CHAT_SPACE_EVENTS_END_TIME: "2026-07-02T00:00:00Z",
    GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS: "/tmp/oauth-client.json",
    GOOGLE_CHAT_USER_TOKEN_STORE: "/tmp/user-token.json",
    ...overrides,
  };
}

function fakeClient() {
  const calls = [];
  return {
    calls,
    async listSpaceEvents(query) {
      calls.push(query);
      const isSecondPage = query.pageToken === "next-page";

      if (isSecondPage) {
        return {
          ok: true,
          status: 200,
          refreshed: false,
          replayedAfter401: false,
          json: {
            spaceEvents: [
              {
                name: "spaces/AAAA-smoke/spaceEvents/reaction-deleted-1",
                eventTime: "2026-07-01T10:03:00Z",
                eventType: "google.workspace.chat.reaction.v1.deleted",
                payload: {
                  reaction: {
                    name: "spaces/AAAA-smoke/messages/msg-1/reactions/reaction-1",
                    emoji: { unicode: "thumbs up", type: "UNICODE" },
                    user: {
                      name: "users/123",
                      displayName: "Ada Lovelace",
                      email: "ada@example.com",
                      type: "HUMAN",
                    },
                  },
                },
              },
            ],
          },
        };
      }

      return {
        ok: true,
        status: 200,
        refreshed: true,
        replayedAfter401: false,
        json: {
          spaceEvents: [
            {
              name: "spaces/AAAA-smoke/spaceEvents/message-created-1",
              eventTime: "2026-07-01T10:01:00Z",
              eventType: "google.workspace.chat.message.v1.created",
              payload: {
                message: {
                  name: "spaces/AAAA-smoke/messages/msg-1",
                  text: "secret run text",
                  formattedText: "<users/123> secret run text",
                  createTime: "2026-07-01T10:01:00Z",
                  thread: { name: "spaces/AAAA-smoke/threads/thread-1" },
                  sender: {
                    name: "users/123",
                    displayName: "Ada Lovelace",
                    email: "ada@example.com",
                    type: "HUMAN",
                  },
                  emojiReactionSummaries: [{ reactionCount: 1 }],
                },
              },
            },
            {
              name: "spaces/AAAA-smoke/spaceEvents/reaction-created-1",
              eventTime: "2026-07-01T10:02:00Z",
              eventType: "google.workspace.chat.reaction.v1.created",
              payload: {
                reaction: {
                  name: "spaces/AAAA-smoke/messages/msg-1/reactions/reaction-1",
                  emoji: { unicode: "thumbs up", type: "UNICODE" },
                  user: {
                    name: "users/123",
                    displayName: "Ada Lovelace",
                    email: "ada@example.com",
                    type: "HUMAN",
                  },
                },
              },
            },
          ],
          nextPageToken: "next-page",
        },
      };
    },
  };
}

test("loadSpaceEventsSmokeConfig refuses to run without explicit guard", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadSpaceEventsSmokeConfig({
        argv: ["node", "chat-space-events-smoke.mjs", "--dry-run"],
        env: {
          GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
          GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
        },
      }),
    /RUN_LIVE_CHAT_SPACE_EVENTS_SMOKE=1/,
  );
});

test("dry-run plan is read-only and uses reaction scope for reaction events", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadSpaceEventsSmokeConfig({
    argv: [
      "node",
      "chat-space-events-smoke.mjs",
      "--dry-run",
      "--event-type=google.workspace.chat.reaction.v1.created",
      "--limit=5",
      "--page-size=2",
    ],
    env: smokeEnv(metadataPath),
  });
  const plan = buildSpaceEventsSmokePlan(config);

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.calls[0].writes, false);
  assert.equal(plan.calls[0].authMode, "user");
  assert.deepEqual(plan.calls[0].requiredScopes, [
    "https://www.googleapis.com/auth/chat.messages.reactions.readonly",
  ]);
  assert.equal(
    plan.calls[0].query.filter,
    'eventTypes:"google.workspace.chat.reaction.v1.created" AND startTime="2026-07-01T00:00:00Z" AND endTime="2026-07-02T00:00:00Z"',
  );
});

test("runSpaceEventsSmoke builds redacted paginated evidence", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadSpaceEventsSmokeConfig({
    argv: [
      "node",
      "chat-space-events-smoke.mjs",
      "--event-type=google.workspace.chat.message.v1.created",
      "--event-type=google.workspace.chat.reaction.v1.created",
      "--event-type=google.workspace.chat.reaction.v1.deleted",
      "--expect-event-type=google.workspace.chat.reaction.v1.created",
      "--expect-min-events=3",
      "--expect-message-created=1",
      "--expect-reaction-created=1",
      "--expect-reaction-deleted=1",
      "--limit=3",
      "--page-size=2",
    ],
    env: smokeEnv(metadataPath),
  });
  const client = fakeClient();
  const result = await runSpaceEventsSmoke(config, {
    client,
    writeEvidence: false,
  });
  const serialized = JSON.stringify(result.evidence);

  assert.equal(result.ok, true);
  assert.equal(result.evidence.rawApi.pages, 2);
  assert.equal(result.evidence.assertions.eventCount, 3);
  assert.equal(result.evidence.assertions.expectedEventTypesPresent, true);
  assert.equal(result.evidence.assertions.expectedReactionCreatedMatches, true);
  assert.equal(result.evidence.assertions.expectedReactionDeletedMatches, true);
  assert.equal(client.calls.some((query) => query.pageToken === "next-page"), true);
  assert.equal(serialized.includes("secret run text"), false);
  assert.equal(serialized.includes("ada@example.com"), false);
  assert.equal(serialized.includes("Ada Lovelace"), false);
  assert.equal(serialized.includes("spaces/AAAA-smoke/messages/msg-1"), false);
});

test("runSpaceEventsSmoke preserves redacted evidence on API failure", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadSpaceEventsSmokeConfig({
    argv: [
      "node",
      "chat-space-events-smoke.mjs",
      "--event-type=google.workspace.chat.message.v1.created",
      "--limit=1",
      "--page-size=1",
    ],
    env: smokeEnv(metadataPath),
  });
  const failingClient = {
    async listSpaceEvents() {
      throw new Error("spaces.spaceEvents.list failed with HTTP 500");
    },
  };

  await assert.rejects(
    () =>
      runSpaceEventsSmoke(config, {
        client: failingClient,
        writeEvidence: false,
      }),
    (error) => {
      assert.equal(error.evidence.ok, false);
      assert.deepEqual(error.evidence.failures, ["spaceEvents.list"]);
      assert.equal(error.evidence.operations[0].ok, false);
      assert.equal(JSON.stringify(error.evidence).includes("accessToken"), false);
      return true;
    },
  );
});

test("runSpaceEventsSmoke retries transient failures before succeeding", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadSpaceEventsSmokeConfig({
    argv: [
      "node",
      "chat-space-events-smoke.mjs",
      "--event-type=google.workspace.chat.message.v1.created",
      "--expect-min-events=1",
      "--limit=1",
      "--page-size=1",
      "--max-attempts=2",
      "--retry-delay-ms=0",
    ],
    env: smokeEnv(metadataPath),
  });
  let calls = 0;
  const flakyClient = {
    async listSpaceEvents() {
      calls += 1;
      if (calls === 1) {
        const error = new Error("spaces.spaceEvents.list failed with HTTP 503");
        error.status = 503;
        error.response = { error: { status: "UNAVAILABLE" } };
        error.responseHeaders = { "x-goog-request-id": "unit-request-1" };
        throw error;
      }
      return {
        ok: true,
        status: 200,
        refreshed: false,
        replayedAfter401: false,
        headers: { "x-goog-request-id": "unit-request-2" },
        json: {
          spaceEvents: [
            {
              name: "spaces/AAAA-smoke/spaceEvents/message-created-1",
              eventTime: "2026-07-01T10:01:00Z",
              eventType: "google.workspace.chat.message.v1.created",
              payload: {
                message: {
                  name: "spaces/AAAA-smoke/messages/msg-1",
                  text: "secret run text",
                  createTime: "2026-07-01T10:01:00Z",
                },
              },
            },
          ],
        },
      };
    },
  };

  const result = await runSpaceEventsSmoke(config, {
    client: flakyClient,
    writeEvidence: false,
    sleep: async () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(result.evidence.status, "verified");
  assert.equal(result.evidence.operations[0].attempts.length, 2);
  assert.equal(result.evidence.operations[0].attempts[0].retryable, true);
  assert.equal(result.evidence.operations[0].attempts[0].willRetry, true);
  assert.equal(
    result.evidence.operations[0].attempts[1].responseHeaders["x-goog-request-id"],
    "unit-request-2",
  );
});

test("runSpaceEventsSmoke can record repeated Google 500 as allowed blocked evidence", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadSpaceEventsSmokeConfig({
    argv: [
      "node",
      "chat-space-events-smoke.mjs",
      "--event-type=google.workspace.chat.message.v1.created",
      "--limit=1",
      "--page-size=1",
      "--max-attempts=2",
      "--retry-delay-ms=0",
      "--allow-blocked",
    ],
    env: smokeEnv(metadataPath),
  });
  const failingClient = {
    async listSpaceEvents() {
      const error = new Error("spaces.spaceEvents.list failed with HTTP 500");
      error.name = "ChatSpaceEventsReadError";
      error.operation = "spaces.spaceEvents.list";
      error.status = 500;
      error.response = { error: { status: "INTERNAL" } };
      error.responseHeaders = { "x-goog-request-id": "unit-request-500" };
      throw error;
    },
  };

  const result = await runSpaceEventsSmoke(config, {
    client: failingClient,
    writeEvidence: false,
    sleep: async () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.ok, true);
  assert.equal(result.evidence.status, "blocked");
  assert.equal(result.evidence.failures.length, 0);
  assert.equal(result.evidence.blocked.reason, "google_internal_error");
  assert.equal(result.evidence.blocked.attempts.length, 2);
  assert.equal(result.evidence.operations[0].ok, false);
  assert.equal(result.evidence.operations[0].error.status, 500);
  assert.equal(JSON.stringify(result.evidence).includes("accessToken"), false);
});
