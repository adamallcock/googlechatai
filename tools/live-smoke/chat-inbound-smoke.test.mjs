import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInboundSmokePlan,
  resolveInboundSmokeConfig,
  runInboundSmoke,
} from "./chat-inbound-smoke.mjs";

function env(overrides = {}) {
  return {
    RUN_LIVE_CHAT_INBOUND_SMOKE: "1",
    GOOGLE_CLOUD_PROJECT: "example-chat-project",
    GOOGLE_CHAT_CLOUD_RUN_SERVICE: "chat-ai-sdk-dev-webhook",
    GOOGLE_CHAT_TEST_SPACE: "spaces/EXAMPLESPACE",
    GOOGLE_CHAT_INBOUND_SMOKE_RUN_ID: "inbound-test-run",
    ...overrides,
  };
}

function logEvidence(overrides = {}) {
  return {
    ok: true,
    mode: "live",
    runId: "log-inbound-test-run",
    project: "example-chat-project",
    service: "chat-ai-sdk-dev-webhook",
    since: "2026-07-01T20:50:00Z",
    until: null,
    counts: {
      errors: 0,
      events: 1,
      httpPosts: 1,
    },
    assertions: {
      noCloudRunErrors: true,
      allHttpPostsSucceeded: true,
      expectedEventCountMatches: true,
      expectedHttpPostCountMatches: true,
      expectedEventTypeMatches: true,
      expectedMentionCountMatches: true,
      expectedAttachmentCountMatches: true,
    },
    logs: {
      errors: [],
      events: [],
      httpPosts: [],
    },
    privacy: {
      rawLogEntriesSaved: false,
      rawMessageTextSaved: false,
      rawFormValuesSaved: false,
      rawAccessTokensSaved: false,
      senderEmailsSaved: false,
    },
    ...overrides,
  };
}

test("resolveInboundSmokeConfig refuses to run without explicit guard", () => {
  assert.throws(
    () =>
      resolveInboundSmokeConfig({
        argv: [
          "node",
          "chat-inbound-smoke.mjs",
          "--since=2026-07-01T20:50:00Z",
        ],
        env: {
          GOOGLE_CLOUD_PROJECT: "example-chat-project",
        },
      }),
    /RUN_LIVE_CHAT_INBOUND_SMOKE=1/,
  );
});

test("dry-run plan names the manual mention action and log assertions", () => {
  const config = resolveInboundSmokeConfig({
    argv: [
      "node",
      "chat-inbound-smoke.mjs",
      "--dry-run",
      "--since=2026-07-01T20:50:00Z",
    ],
    env: env(),
  });
  const plan = buildInboundSmokePlan(config);

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.runId, "inbound-test-run");
  assert.equal(plan.manualAction.smokeSpace, "spaces/EXAMPLESPACE");
  assert.match(plan.manualAction.instruction, /autocomplete/);
  assert.equal(plan.logSmokePlan.expectations.events, 1);
  assert.equal(plan.logSmokePlan.expectations.httpPosts, 1);
  assert.equal(plan.logSmokePlan.expectations.eventType, "message");
  assert.equal(plan.logSmokePlan.expectations.mentionCount, 1);
  assert.equal(plan.logSmokePlan.expectations.attachmentCount, 0);
});

test("dry-run plan can assert richer inbound attachment and quote variants", () => {
  const config = resolveInboundSmokeConfig({
    argv: [
      "node",
      "chat-inbound-smoke.mjs",
      "--dry-run",
      "--since=2026-07-01T20:50:00Z",
      "--expect-attachment-count=2",
      "--expect-attachment-data-ref-count=1",
      "--expect-drive-attachment-count=1",
      "--expect-quoted-message",
      "--expect-quote-depth=1",
      "--expect-event-identity",
      "--expect-action-method=googlechatai_sdk_card_mark_received",
    ],
    env: env(),
  });
  const plan = buildInboundSmokePlan(config);

  assert.equal(plan.logSmokePlan.expectations.attachmentCount, 2);
  assert.equal(plan.logSmokePlan.expectations.attachmentDataRefCount, 1);
  assert.equal(plan.logSmokePlan.expectations.driveAttachmentCount, 1);
  assert.equal(plan.logSmokePlan.expectations.quotedMessage, true);
  assert.equal(plan.logSmokePlan.expectations.quoteDepth, 1);
  assert.equal(plan.logSmokePlan.expectations.eventIdentity, true);
  assert.equal(
    plan.logSmokePlan.expectations.actionMethod,
    "googlechatai_sdk_card_mark_received",
  );
  assert.match(plan.manualAction.instruction, /attach 2 file/);
  assert.match(plan.manualAction.instruction, /Drive picker/);
  assert.match(plan.manualAction.instruction, /quote\/reply/);
  assert.match(plan.manualAction.instruction, /googlechatai_sdk_card_mark_received/);
});

test("runInboundSmoke polls until the log smoke assertions pass", async () => {
  const config = resolveInboundSmokeConfig({
    argv: [
      "node",
      "chat-inbound-smoke.mjs",
      "--since=2026-07-01T20:50:00Z",
      "--wait-seconds=10",
      "--poll-interval-ms=1000",
    ],
    env: env(),
  });
  let calls = 0;
  let fakeNow = 0;
  const result = await runInboundSmoke(config, {
    writeEvidence: false,
    now: () => fakeNow,
    wait: async (ms) => {
      fakeNow += ms;
    },
    async runLogSmokeImpl() {
      calls += 1;
      if (calls === 1) {
        const error = new Error("not yet");
        error.evidence = {
          failures: ["expectedEventCountMatches"],
          counts: {
            errors: 0,
            events: 0,
            httpPosts: 0,
          },
        };
        throw error;
      }
      return {
        ok: true,
        evidence: logEvidence(),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.attempts.length, 2);
  assert.equal(result.evidence.attempts[0].ok, false);
  assert.equal(result.evidence.attempts[1].ok, true);
  assert.equal(result.evidence.logEvidence.counts.events, 1);
});

test("runInboundSmoke fails with redacted evidence after timeout", async () => {
  const config = resolveInboundSmokeConfig({
    argv: [
      "node",
      "chat-inbound-smoke.mjs",
      "--since=2026-07-01T20:50:00Z",
      "--wait-seconds=0",
      "--poll-interval-ms=1000",
    ],
    env: env(),
  });

  await assert.rejects(
    () =>
      runInboundSmoke(config, {
        writeEvidence: false,
        async runLogSmokeImpl() {
          const error = new Error("not found");
          error.evidence = {
            failures: ["expectedEventCountMatches"],
            counts: {
              errors: 0,
              events: 0,
              httpPosts: 0,
            },
          };
          throw error;
        },
      }),
    /did not observe the expected event/,
  );
});
