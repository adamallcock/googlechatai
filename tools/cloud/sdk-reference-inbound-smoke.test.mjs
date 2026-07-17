import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSdkReferenceInboundSmokePlan,
  loadSdkReferenceInboundSmokeConfig,
  runSdkReferenceInboundSmoke,
  smokeCorrelation,
} from "./sdk-reference-inbound-smoke.mjs";

function env(overrides = {}) {
  return {
    RUN_LIVE_CHAT_SMOKE: "1",
    RUN_LIVE_CHAT_INBOUND_SMOKE: "1",
    RUN_LIVE_SDK_REFERENCE_INBOUND_SMOKE: "1",
    GOOGLE_CHAT_SDK_REFERENCE_CHAT_ENDPOINT_CONFIGURED: "1",
    GOOGLE_CLOUD_PROJECT: "example-chat-project",
    GOOGLE_CHAT_SDK_REFERENCE_SERVICE: "googlechatai-sdk-staging",
    ...overrides,
  };
}

function config(argv = [], overrides = {}) {
  return loadSdkReferenceInboundSmokeConfig({
    argv: [
      "node",
      "sdk-reference-inbound-smoke.mjs",
      "--run-id",
      "staging-smoke-12345678",
      "--since",
      "2026-07-10T12:00:00Z",
      ...argv,
    ],
    env: env(overrides),
  });
}

function handlerEntry(correlation) {
  return {
    timestamp: "2026-07-10T12:00:02Z",
    severity: "INFO",
    resource: { labels: { revision_name: "googlechatai-sdk-staging-00003-a" } },
    jsonPayload: {
      message: "cloud_run_reference.inbound_smoke_handled",
      smokeCorrelation: correlation,
      eventKind: "message",
      source: "chat_http",
      responseStatus: 200,
      privateMessageText: "must never enter evidence",
    },
  };
}

function httpEntry() {
  return {
    timestamp: "2026-07-10T12:00:02Z",
    resource: { labels: { revision_name: "googlechatai-sdk-staging-00003-a" } },
    httpRequest: {
      requestMethod: "POST",
      requestUrl: "https://staging.example.test/chat/events?private=true",
      status: 200,
    },
  };
}

test("reference inbound smoke dry run describes a correlated no-send flow", async () => {
  const smoke = config(["--dry-run"], {
    RUN_LIVE_CHAT_SMOKE: undefined,
    RUN_LIVE_CHAT_INBOUND_SMOKE: undefined,
    RUN_LIVE_SDK_REFERENCE_INBOUND_SMOKE: undefined,
    GOOGLE_CHAT_SDK_REFERENCE_CHAT_ENDPOINT_CONFIGURED: undefined,
  });
  const result = await runSdkReferenceInboundSmoke(smoke, {
    readLogs() {
      throw new Error("dry run must not read logs");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.privacy.writesChatMessages, false);
  assert.match(result.evidence.filters.correlatedHandler, /smokeCorrelation/);
  assert.match(result.evidence.manualAction.instruction, /googlechatai-smoke:staging-smoke-12345678/);
});

test("reference inbound smoke requires its complete guarded boundary", () => {
  assert.throws(
    () => config([], { RUN_LIVE_SDK_REFERENCE_INBOUND_SMOKE: undefined }),
    /RUN_LIVE_SDK_REFERENCE_INBOUND_SMOKE=1/,
  );
});

test("reference inbound smoke accepts only the hash-correlated handler contract", async () => {
  const smoke = config();
  const result = await runSdkReferenceInboundSmoke(smoke, {
    writeEvidence: false,
    readLogs(filter) {
      if (filter.includes("severity>=ERROR")) {
        return [];
      }
      if (filter.includes("smokeCorrelation")) {
        return [handlerEntry(smoke.correlation)];
      }
      return [httpEntry()];
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.assertions.exactlyOneCorrelatedHandler, true);
  assert.equal(result.evidence.assertions.exactlyOneHttpPost, true);
  assert.equal(JSON.stringify(result.evidence).includes("privateMessageText"), false);
  assert.equal(JSON.stringify(result.evidence).includes("private=true"), false);
});

test("reference inbound smoke rejects a same-service event with another correlation", async () => {
  const smoke = config(["--wait-seconds=0"]);
  await assert.rejects(
    () =>
      runSdkReferenceInboundSmoke(smoke, {
        writeEvidence: false,
        readLogs(filter) {
          if (filter.includes("severity>=ERROR")) {
            return [];
          }
          if (filter.includes("smokeCorrelation")) {
            return [handlerEntry(smokeCorrelation("unrelated-smoke-12345678"))];
          }
          return [httpEntry()];
        },
      }),
    (error) => {
      assert.deepEqual(error.evidence.failures, ["exactlyOneCorrelatedHandler"]);
      return true;
    },
  );
});

test("reference inbound smoke plan binds only the configured service and correlation hash", () => {
  const plan = buildSdkReferenceInboundSmokePlan(config());
  assert.match(plan.filters.correlatedHandler, /service_name="googlechatai-sdk-staging"/);
  assert.match(plan.filters.correlatedHandler, new RegExp(smokeCorrelation("staging-smoke-12345678")));
});
