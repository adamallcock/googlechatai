import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIdempotencyMonitorJobPlan,
  loadIdempotencyMonitorJobConfig,
  runIdempotencyMonitorJobSetup,
} from "./idempotency-monitor-job.mjs";

function env(overrides = {}) {
  return {
    RUN_LIVE_IDEMPOTENCY_MONITOR_JOB: "1",
    GOOGLE_CLOUD_PROJECT: "example-chat-project",
    GOOGLE_CLOUD_LOCATION: "us-central1",
    GOOGLE_CHAT_CLOUD_RUN_SERVICE_ACCOUNT:
      "chat-ai-sdk-runtime@example-chat-project.iam.gserviceaccount.com",
    ...overrides,
  };
}

test("loadIdempotencyMonitorJobConfig refuses live setup without explicit guard", () => {
  assert.throws(
    () =>
      loadIdempotencyMonitorJobConfig({
        argv: ["node", "idempotency-monitor-job.mjs"],
        env: {},
      }),
    /RUN_LIVE_IDEMPOTENCY_MONITOR_JOB=1/,
  );
});

test("buildIdempotencyMonitorJobPlan deploys a metadata-auth Cloud Run job", () => {
  const config = loadIdempotencyMonitorJobConfig({
    argv: ["node", "idempotency-monitor-job.mjs", "--dry-run"],
    env: env(),
  });
  const plan = buildIdempotencyMonitorJobPlan(config);
  const deploy = plan.commands.find((command) => command.operation === "run.jobs.deploy");
  const deployCommand = deploy.args.join(" ");

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.scheduler.enabled, false);
  assert.deepEqual(
    plan.commands.slice(0, 3).map((command) => command.operation),
    [
      "projects.addIamPolicyBinding.datastoreUser",
      "projects.addIamPolicyBinding.datastoreIndexAdmin",
      "projects.addIamPolicyBinding.loggingWriter",
    ],
  );
  assert.ok(deploy);
  assert.equal(deploy.args.includes("--source"), true);
  assert.equal(deploy.args.includes("--service-account"), true);
  assert.equal(deployCommand.includes("GOOGLE_CHAT_IDEMPOTENCY_MONITOR_AUTH=metadata"), true);
  assert.equal(deployCommand.includes("GOOGLE_APPLICATION_CREDENTIALS"), false);
  assert.equal(deploy.args.includes("--command"), true);
  assert.equal(deploy.args.includes("node"), true);
});

test("buildIdempotencyMonitorJobPlan can add scheduler command explicitly", () => {
  const config = loadIdempotencyMonitorJobConfig({
    argv: [
      "node",
      "idempotency-monitor-job.mjs",
      "--dry-run",
      "--create-scheduler",
      "--schedule=*/15 * * * *",
    ],
    env: env(),
  });
  const plan = buildIdempotencyMonitorJobPlan(config);
  const scheduler = plan.commands.find(
    (command) => command.operation === "scheduler.jobs.create.http",
  );

  assert.equal(plan.scheduler.enabled, true);
  assert.ok(scheduler);
  assert.equal(
    scheduler.args.includes(
      "https://us-central1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/example-chat-project/jobs/chat-ai-sdk-idempotency-monitor:run",
    ),
    true,
  );
  assert.equal(
    scheduler.args.includes(
      "chat-ai-sdk-runtime@example-chat-project.iam.gserviceaccount.com",
    ),
    true,
  );
  assert.equal(scheduler.args.includes("*/15 * * * *"), true);
});

test("runIdempotencyMonitorJobSetup dry-run does not call gcloud", async () => {
  const config = loadIdempotencyMonitorJobConfig({
    argv: ["node", "idempotency-monitor-job.mjs", "--dry-run", "--execute-now"],
    env: env(),
  });
  const calls = [];
  const result = await runIdempotencyMonitorJobSetup(config, {
    runCommand: (args) => {
      calls.push(args);
      throw new Error("dry-run should not call gcloud");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "dry-run");
  assert.equal(calls.length, 0);
  assert.equal(
    result.commands.some((command) => command.operation === "run.jobs.execute"),
    true,
  );
});

test("runIdempotencyMonitorJobSetup executes deploy, optional run, and scheduler", async () => {
  const config = loadIdempotencyMonitorJobConfig({
    argv: [
      "node",
      "idempotency-monitor-job.mjs",
      "--execute-now",
      "--create-scheduler",
    ],
    env: env(),
  });
  const calls = [];
  const result = await runIdempotencyMonitorJobSetup(config, {
    runCommand: (args) => {
      calls.push(args);
      return JSON.stringify({ ok: true, args });
    },
    writeEvidence: false,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.map((args) => args.slice(0, 3).join(" ")),
    [
      "projects add-iam-policy-binding example-chat-project",
      "projects add-iam-policy-binding example-chat-project",
      "projects add-iam-policy-binding example-chat-project",
      "run jobs deploy",
      "run jobs execute",
      "services enable cloudscheduler.googleapis.com",
      "scheduler jobs create",
    ],
  );
});
