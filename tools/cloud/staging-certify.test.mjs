import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStagingCertificationPlan,
  certifyStagingReference,
  loadStagingCertificationConfig,
} from "./staging-certify.mjs";

function env(overrides = {}) {
  return {
    GOOGLE_CLOUD_PROJECT: "example-chat-project",
    GOOGLE_CLOUD_LOCATION: "us-central1",
    GOOGLE_CHAT_SDK_REFERENCE_SERVICE: "googlechatai-sdk-staging",
    GOOGLE_CHAT_SDK_REFERENCE_EXPECTED_REVISION: "googlechatai-sdk-staging-00001-a",
    ...overrides,
  };
}

function serviceDescription({ localFixtures = false } = {}) {
  return {
    status: {
      url: "https://staging.example.test",
      latestReadyRevisionName: "googlechatai-sdk-staging-00001-a",
      traffic: [{ percent: 100, latestRevision: true }],
    },
    spec: {
      template: {
        spec: {
          containers: [
            {
              env: [
                { name: "GOOGLE_CLOUD_PROJECT" },
                { name: "GOOGLE_CHAT_AUDIENCE" },
                { name: "GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION" },
                ...(localFixtures ? [{ name: "GOOGLE_CHAT_LOCAL_FIXTURES" }] : []),
              ],
            },
          ],
        },
      },
    },
  };
}

function healthResponse() {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        service: "googlechatai-cloud-run-reference",
        verification: "google-chat-jwt",
        idempotency: "firestore",
      });
    },
  };
}

test("staging certification dry run makes no Cloud or Chat calls", async () => {
  const config = loadStagingCertificationConfig({
    argv: ["node", "staging-certify.mjs", "--dry-run"],
    env: env(),
  });
  const calls = [];
  const result = await certifyStagingReference(config, {
    runCommand: () => {
      calls.push("gcloud");
      throw new Error("dry run must not call gcloud");
    },
  });

  assert.equal(result.mode, "dry-run");
  assert.equal(calls.length, 0);
  assert.equal(buildStagingCertificationPlan(config).chatSmoke.writesChatMessages, false);
});

test("staging certification verifies normal mode without sending a Chat message", async () => {
  const config = loadStagingCertificationConfig({
    argv: ["node", "staging-certify.mjs", "--run-id", "certify-test"],
    env: env(),
  });
  let chatSmokeCalls = 0;
  const result = await certifyStagingReference(config, {
    runCommand: () => JSON.stringify(serviceDescription()),
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, "error");
      return healthResponse();
    },
    runChatSmoke: () => {
      chatSmokeCalls += 1;
    },
    writeEvidence: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.chatSmoke.executed, false);
  assert.equal(chatSmokeCalls, 0);
  assert.equal(result.checks.every((entry) => entry.ok), true);
  assert.equal(JSON.stringify(result).includes("https://staging.example.test"), false);
});

test("staging certification refuses a service with the local-fixture bypass configured", async () => {
  const config = loadStagingCertificationConfig({
    argv: ["node", "staging-certify.mjs"],
    env: env(),
  });
  const result = await certifyStagingReference(config, {
    runCommand: () => JSON.stringify(serviceDescription({ localFixtures: true })),
    fetchImpl: async () => healthResponse(),
    writeEvidence: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((entry) => entry.id === "local-fixtures-disabled")?.ok, false);
});

test("staging certification refuses an unrelated expected revision or non-latest traffic", async () => {
  const config = loadStagingCertificationConfig({
    argv: ["node", "staging-certify.mjs"],
    env: env({ GOOGLE_CHAT_SDK_REFERENCE_EXPECTED_REVISION: "googlechatai-sdk-staging-00002-b" }),
  });
  const result = await certifyStagingReference(config, {
    runCommand: () => JSON.stringify(serviceDescription()),
    fetchImpl: async () => healthResponse(),
    writeEvidence: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((entry) => entry.id === "expected-ready-revision")?.ok, false);
});

test("staging certification rejects obsolete base-url overrides", () => {
  assert.throws(
    () =>
      loadStagingCertificationConfig({
        argv: ["node", "staging-certify.mjs", "--base-url", "https://unrelated.example.test"],
        env: env(),
      }),
    /Unknown argument: --base-url/,
  );
});

test("staging Chat smoke requires both the staging and standard live guards", () => {
  assert.throws(
    () =>
      loadStagingCertificationConfig({
        argv: ["node", "staging-certify.mjs", "--chat-smoke"],
        env: env(),
      }),
    /RUN_LIVE_SDK_REFERENCE_CHAT_SMOKE=1/,
  );
});

test("staging Chat smoke requires prepared manual correlation details and delegates them", async () => {
  assert.throws(
    () =>
      loadStagingCertificationConfig({
        argv: ["node", "staging-certify.mjs", "--chat-smoke"],
        env: env({
          RUN_LIVE_SDK_REFERENCE_CHAT_SMOKE: "1",
          GOOGLE_CHAT_SDK_REFERENCE_CHAT_ENDPOINT_CONFIGURED: "1",
          RUN_LIVE_CHAT_SMOKE: "1",
          RUN_LIVE_CHAT_INBOUND_SMOKE: "1",
          RUN_LIVE_SDK_REFERENCE_INBOUND_SMOKE: "1",
        }),
      }),
    /explicit --run-id/,
  );

  const config = loadStagingCertificationConfig({
    argv: [
      "node",
      "staging-certify.mjs",
      "--chat-smoke",
      "--run-id",
      "prepared-smoke-12345678",
      "--chat-smoke-since",
      "2026-07-10T12:00:00Z",
    ],
    env: env({
      RUN_LIVE_SDK_REFERENCE_CHAT_SMOKE: "1",
      GOOGLE_CHAT_SDK_REFERENCE_CHAT_ENDPOINT_CONFIGURED: "1",
      RUN_LIVE_CHAT_SMOKE: "1",
      RUN_LIVE_CHAT_INBOUND_SMOKE: "1",
      RUN_LIVE_SDK_REFERENCE_INBOUND_SMOKE: "1",
    }),
  });
  let smokeConfig = null;
  const result = await certifyStagingReference(config, {
    runCommand: () => JSON.stringify(serviceDescription()),
    fetchImpl: async () => healthResponse(),
    runChatSmoke(value) {
      smokeConfig = value;
    },
    writeEvidence: false,
  });

  assert.equal(result.chatSmoke.executed, true);
  assert.equal(smokeConfig.runId, "prepared-smoke-12345678");
  assert.equal(smokeConfig.chatSmokeSince, "2026-07-10T12:00:00Z");
});
