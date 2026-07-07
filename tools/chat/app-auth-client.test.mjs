import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatApiUrl,
  chatRequestWithAppAuth,
} from "./app-auth-client.mjs";
import { requestJsonWithRetry } from "../../packages/node/dist/index.js";

test("buildChatApiUrl attaches only provided query values", () => {
  assert.equal(
    buildChatApiUrl("spaces/AAA/messages", {
      pageSize: 10,
      pageToken: "",
      filter: null,
    }),
    "https://chat.googleapis.com/v1/spaces/AAA/messages?pageSize=10",
  );
});

test("chatRequestWithAppAuth uses shared retry policy for silent app-token refresh", async () => {
  const tokenCalls = [];
  const authHeaders = [];
  const result = await chatRequestWithAppAuth({
    scopes: ["https://www.googleapis.com/auth/chat.bot"],
    resourcePath: "spaces?pageSize=1",
    getAccessToken: async ({ forceRefresh }) => {
      tokenCalls.push(forceRefresh);
      return {
        accessToken: forceRefresh ? "fresh-app-token" : "stale-app-token",
        refreshed: forceRefresh,
      };
    },
    requestJsonWithRetry,
    fetchImpl: async (_url, init) => {
      authHeaders.push(init.headers.authorization);
      if (authHeaders.length === 1) {
        return new Response(
          JSON.stringify({ error: { status: "UNAUTHENTICATED" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ spaces: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    sleepMs: async () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.attempts, 2);
  assert.equal(result.refreshed, true);
  assert.equal(result.replayedAfter401, true);
  assert.deepEqual(tokenCalls, [false, true]);
  assert.deepEqual(authHeaders, [
    "Bearer stale-app-token",
    "Bearer fresh-app-token",
  ]);
});

test("chatRequestWithAppAuth retries replay-safe app writes on transient status", async () => {
  let calls = 0;
  const result = await chatRequestWithAppAuth({
    scopes: ["https://www.googleapis.com/auth/chat.bot"],
    resourcePath: "spaces/AAA/messages",
    init: {
      method: "POST",
      idempotent: true,
      body: { text: "hello" },
    },
    getAccessToken: async () => ({ accessToken: "app-token" }),
    requestJsonWithRetry,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({ error: { status: "UNAVAILABLE" } }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ name: "spaces/AAA/messages/msg-1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    sleepMs: async () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
  assert.equal(result.retryDecisions[0].reason, "transient_failure");
});
