import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIdempotencyAlertPolicy,
  loadIdempotencyAlertSmokeConfig,
  runIdempotencyAlertSmoke,
} from "./idempotency-monitor-alert-smoke.mjs";

function env(overrides = {}) {
  return {
    RUN_LIVE_IDEMPOTENCY_ALERT_SMOKE: "1",
    GOOGLE_CLOUD_PROJECT: "example-chat-project",
    GOOGLE_CHAT_IDEMPOTENCY_ALERT_RUN_ID: "idempotency-alert-test",
    ...overrides,
  };
}

test("loadIdempotencyAlertSmokeConfig refuses live run without explicit guard", () => {
  assert.throws(
    () =>
      loadIdempotencyAlertSmokeConfig({
        argv: ["node", "idempotency-monitor-alert-smoke.mjs"],
        env: {},
      }),
    /RUN_LIVE_IDEMPOTENCY_ALERT_SMOKE=1/,
  );
});

test("buildIdempotencyAlertPolicy creates disabled LogMatch policy", () => {
  const config = loadIdempotencyAlertSmokeConfig({
    argv: ["node", "idempotency-monitor-alert-smoke.mjs", "--dry-run"],
    env: env(),
  });
  const policy = buildIdempotencyAlertPolicy(config);

  assert.equal(policy.enabled, false);
  assert.equal(policy.combiner, "OR");
  assert.equal(policy.conditions.length, 1);
  assert.equal(
    policy.conditions[0].conditionMatchedLog.filter.includes(
      'jsonPayload.event="google_chat_idempotency_monitor"',
    ),
    true,
  );
  assert.equal(
    policy.conditions[0].conditionMatchedLog.filter.includes(
      "jsonPayload.warningCount>0",
    ),
    true,
  );
  assert.deepEqual(policy.alertStrategy.notificationRateLimit, {
    period: "300s",
  });
  assert.equal(policy.userLabels.component, "googlechatai_sdk");
  assert.equal(policy.userLabels.smoke, "true");
});

test("runIdempotencyAlertSmoke dry-run returns policy without gcloud calls", async () => {
  const config = loadIdempotencyAlertSmokeConfig({
    argv: ["node", "idempotency-monitor-alert-smoke.mjs", "--dry-run"],
    env: env(),
  });
  const calls = [];
  const result = await runIdempotencyAlertSmoke(config, {
    runCommand: (args) => {
      calls.push(args);
      throw new Error("dry-run should not call gcloud");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "dry-run");
  assert.equal(calls.length, 0);
  assert.equal(result.policy.enabled, false);
});

test("runIdempotencyAlertSmoke creates and deletes temporary policy", async () => {
  const config = loadIdempotencyAlertSmokeConfig({
    argv: ["node", "idempotency-monitor-alert-smoke.mjs"],
    env: env(),
  });
  const calls = [];
  const result = await runIdempotencyAlertSmoke(config, {
    runCommand: (args) => {
      calls.push(args);
      if (args.includes("create")) {
        return JSON.stringify({
          name: "projects/example-chat-project/alertPolicies/123",
          displayName: "created",
          enabled: false,
        });
      }
      return "";
    },
    writeEvidence: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.created.name, "projects/example-chat-project/alertPolicies/123");
  assert.equal(result.deleted, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "monitoring");
  assert.equal(calls[0][2], "create");
  assert.equal(calls[1][2], "delete");
  assert.equal(calls[1][3], "projects/example-chat-project/alertPolicies/123");
});
