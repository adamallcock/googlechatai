import assert from "node:assert/strict";
import test from "node:test";

import { fetchWithUserAuthRetry } from "./user-auth-client.mjs";
import { buildRetryDecision } from "../../packages/node/dist/index.js";

test("fetchWithUserAuthRetry refreshes silently after a 401 and returns raw response", async () => {
  const tokenCalls = [];
  const authHeaders = [];
  const result = await fetchWithUserAuthRetry({
    oauthClient: {},
    tokenStorePath: "/tmp/token.json",
    scopes: ["https://www.googleapis.com/auth/chat.messages.readonly"],
    url: "https://chat.googleapis.com/v1/media/spaces/AAA/messages/msg/attachments/a/media?alt=media",
    getAccessTokenImpl: async ({ forceRefresh }) => {
      tokenCalls.push(forceRefresh);
      return {
        accessToken: forceRefresh ? "fresh-user-token" : "stale-user-token",
        token: { tokenType: "Bearer" },
        refreshed: forceRefresh,
      };
    },
    buildRetryDecisionImpl: buildRetryDecision,
    fetchImpl: async (_url, init) => {
      authHeaders.push(init.headers.authorization);
      if (authHeaders.length === 1) {
        return new Response("expired", { status: 401 });
      }
      return new Response("raw media bytes", { status: 200 });
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
    "Bearer stale-user-token",
    "Bearer fresh-user-token",
  ]);
  assert.equal(await result.response.text(), "raw media bytes");
});

test("fetchWithUserAuthRetry retries replay-safe binary reads after transient failures", async () => {
  let calls = 0;
  const result = await fetchWithUserAuthRetry({
    oauthClient: {},
    tokenStorePath: "/tmp/token.json",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    url: "https://www.googleapis.com/drive/v3/files/file/export?mimeType=text/plain",
    idempotent: true,
    getAccessTokenImpl: async () => ({
      accessToken: "user-token",
      token: { tokenType: "Bearer" },
      refreshed: false,
    }),
    buildRetryDecisionImpl: buildRetryDecision,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("busy", {
          status: 503,
          headers: { "retry-after": "0" },
        });
      }
      return new Response("exported file", { status: 200 });
    },
    sleepMs: async () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
  assert.equal(result.retryDecisions[0].reason, "transient_failure");
  assert.equal(await result.response.text(), "exported file");
});
