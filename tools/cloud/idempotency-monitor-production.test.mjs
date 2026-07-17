import assert from "node:assert/strict";
import test from "node:test";

import {
  applyProductionMonitor,
  buildProductionAlertPolicy,
  buildProductionMonitorPlan,
  loadProductionMonitorConfig,
} from "./idempotency-monitor-production.mjs";

const notificationChannel =
  "projects/example-chat-project/notificationChannels/123456789012345";

function env(overrides = {}) {
  return {
    RUN_LIVE_IDEMPOTENCY_MONITOR_PRODUCTION: "1",
    GOOGLE_CLOUD_PROJECT: "example-chat-project",
    GOOGLE_CLOUD_LOCATION: "us-central1",
    GOOGLE_CHAT_CLOUD_RUN_SERVICE_ACCOUNT:
      "chat-ai-sdk-runtime@example-chat-project.iam.gserviceaccount.com",
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_NOTIFICATION_CHANNEL: notificationChannel,
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EXPECTED_EVENTS_PER_MINUTE: "10",
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_RETENTION_MINUTES: "10",
    ...overrides,
  };
}

test("production monitor apply refuses live mutation without its explicit guard", () => {
  assert.throws(
    () =>
      loadProductionMonitorConfig({
        argv: ["node", "idempotency-monitor-production.mjs"],
        env: {},
      }),
    /RUN_LIVE_IDEMPOTENCY_MONITOR_PRODUCTION=1/,
  );
});

test("production monitor dry run exposes missing notification-channel configuration", () => {
  const config = loadProductionMonitorConfig({
    argv: ["node", "idempotency-monitor-production.mjs", "--dry-run"],
    env: env({ GOOGLE_CHAT_IDEMPOTENCY_MONITOR_NOTIFICATION_CHANNEL: undefined }),
  });
  const plan = buildProductionMonitorPlan(config);

  assert.equal(plan.ok, false);
  assert.equal(plan.alert.notificationChannelConfigured, false);
  assert.equal(plan.monitor.schedulerMode, "upsert");
  assert.equal(plan.privacy.savesNotificationChannel, false);
});

test("production monitor requires a capacity budget before live scheduling", () => {
  assert.throws(
    () =>
      loadProductionMonitorConfig({
        argv: ["node", "idempotency-monitor-production.mjs"],
        env: env({
          GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EXPECTED_EVENTS_PER_MINUTE: undefined,
          GOOGLE_CHAT_IDEMPOTENCY_MONITOR_RETENTION_MINUTES: undefined,
        }),
      }),
    /Production monitoring requires/,
  );
  const dryConfig = loadProductionMonitorConfig({
    argv: ["node", "idempotency-monitor-production.mjs", "--dry-run"],
    env: env({
      GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EXPECTED_EVENTS_PER_MINUTE: undefined,
      GOOGLE_CHAT_IDEMPOTENCY_MONITOR_RETENTION_MINUTES: undefined,
    }),
  });
  assert.equal(buildProductionMonitorPlan(dryConfig).ok, false);
  assert.equal(buildProductionMonitorPlan(dryConfig).monitor.capacityBudgetConfigured, false);
});

test("production monitor alert policy is enabled and routes only through the supplied channel", () => {
  const config = loadProductionMonitorConfig({
    argv: ["node", "idempotency-monitor-production.mjs", "--dry-run"],
    env: env(),
  });
  const policy = buildProductionAlertPolicy(config);

  assert.equal(policy.enabled, true);
  assert.deepEqual(policy.notificationChannels, [notificationChannel]);
  assert.equal(policy.userLabels.production, "true");
  assert.equal(
    policy.conditions[0].conditionMatchedLog.filter.includes(
      'jsonPayload.event="google_chat_idempotency_monitor"',
    ),
    true,
  );
  assert.equal(
    policy.conditions[1].conditionMatchedLog.filter.includes('resource.type="cloud_run_job"'),
    true,
  );
});

test("production monitor binds a custom Firestore target and log name through job and alert plans", () => {
  const config = loadProductionMonitorConfig({
    argv: [
      "node",
      "idempotency-monitor-production.mjs",
      "--dry-run",
      "--database",
      "tenant-db",
      "--collection",
      "apps/tenant/claims",
      "--ttl-field",
      "expiry",
      "--cloud-log-name",
      "tenant-monitor-log",
      "--warn-docs",
      "400",
      "--fail-docs",
      "800",
    ],
    env: env(),
  });
  const plan = buildProductionMonitorPlan(config);
  const policy = buildProductionAlertPolicy(config);

  assert.deepEqual(plan.monitor.target, {
    database: "tenant-db",
    collection: "apps/tenant/claims",
    ttlField: "expiry",
    cloudLogName: "tenant-monitor-log",
  });
  assert.match(policy.conditions[0].conditionMatchedLog.filter, /tenant-monitor-log/);
});

test("production monitor apply upserts the scheduler and creates a persistent alert", async () => {
  const config = loadProductionMonitorConfig({
    argv: ["node", "idempotency-monitor-production.mjs", "--run-id", "production-test"],
    env: env(),
  });
  const calls = [];
  const result = await applyProductionMonitor(config, {
    runCommand: (args) => {
      calls.push(args);
      if (args.slice(0, 3).join(" ") === "scheduler jobs describe") {
        throw new Error("not found");
      }
      if (args.slice(0, 3).join(" ") === "monitoring policies list") {
        return "[]";
      }
      if (args.slice(0, 3).join(" ") === "monitoring policies create") {
        return JSON.stringify({
          name: "projects/example-chat-project/alertPolicies/123",
          displayName: "created",
          enabled: true,
        });
      }
      return JSON.stringify({ ok: true });
    },
    writeEvidence: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.monitor.jobApplied, true);
  assert.equal(result.alert.operation, "created");
  assert.equal(result.alert.enabled, true);
  assert.equal(
    calls.some((args) => args.slice(0, 4).join(" ") === "scheduler jobs create http"),
    true,
  );
  assert.equal(
    calls.findIndex((args) => args.slice(0, 3).join(" ") === "monitoring policies create") <
      calls.findIndex((args) => args.slice(0, 4).join(" ") === "scheduler jobs create http"),
    true,
  );
  assert.equal(
    calls.some((args) => args.slice(0, 3).join(" ") === "monitoring policies create"),
    true,
  );
  assert.equal(JSON.stringify(result).includes(notificationChannel), false);
});

test("production monitor refuses a disabled or unnamed alert-policy response before scheduling", async () => {
  for (const response of [
    { name: "projects/example-chat-project/alertPolicies/123", enabled: false },
    { enabled: true },
  ]) {
    const config = loadProductionMonitorConfig({
      argv: ["node", "idempotency-monitor-production.mjs"],
      env: env(),
    });
    const calls = [];
    await assert.rejects(
      () =>
        applyProductionMonitor(config, {
          runCommand: (args) => {
            calls.push(args);
            if (args.slice(0, 3).join(" ") === "monitoring policies list") {
              return "[]";
            }
            if (args.slice(0, 3).join(" ") === "monitoring policies create") {
              return JSON.stringify(response);
            }
            return JSON.stringify({ ok: true });
          },
          writeEvidence: false,
        }),
      /did not confirm an enabled managed alert policy/,
    );
    assert.equal(
      calls.some((args) => args.slice(0, 4).join(" ") === "scheduler jobs create http"),
      false,
    );
  }
});

test("production monitor apply updates its existing managed alert", async () => {
  const config = loadProductionMonitorConfig({
    argv: ["node", "idempotency-monitor-production.mjs"],
    env: env(),
  });
  const calls = [];
  const result = await applyProductionMonitor(config, {
    runCommand: (args) => {
      calls.push(args);
      if (args.slice(0, 3).join(" ") === "scheduler jobs describe") {
        return JSON.stringify({ name: "existing" });
      }
      if (args.slice(0, 3).join(" ") === "monitoring policies list") {
        return JSON.stringify([
          {
            name: "projects/example-chat-project/alertPolicies/123",
            displayName: "Google Chat AI SDK idempotency monitor warning/failure",
            userLabels: { component: "googlechatai_sdk", production: "true" },
          },
        ]);
      }
      if (args.slice(0, 3).join(" ") === "monitoring policies update") {
        return JSON.stringify({
          name: "projects/example-chat-project/alertPolicies/123",
          enabled: true,
        });
      }
      return JSON.stringify({ ok: true });
    },
    writeEvidence: false,
  });

  assert.equal(result.alert.operation, "updated");
  assert.equal(
    calls.some((args) => args.slice(0, 3).join(" ") === "monitoring policies update"),
    true,
  );
});
