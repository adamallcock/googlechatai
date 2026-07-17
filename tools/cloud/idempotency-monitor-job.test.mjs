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
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EXPECTED_EVENTS_PER_MINUTE: "10",
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_RETENTION_MINUTES: "10",
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
    plan.commands.map((command) => command.operation),
    [
      "projects.addIamPolicyBinding.datastoreViewer",
      "projects.addIamPolicyBinding.loggingWriter",
      "run.jobs.deploy",
    ],
  );
  assert.ok(deploy);
  assert.equal(deploy.args.includes("--source"), true);
  assert.equal(deploy.args.includes("--service-account"), true);
  assert.equal(deployCommand.includes("GOOGLE_CHAT_IDEMPOTENCY_MONITOR_AUTH=metadata"), true);
  assert.equal(deployCommand.includes("GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION=googleChatEventIdempotency"), true);
  assert.equal(deployCommand.includes("GOOGLE_CHAT_IDEMPOTENCY_MONITOR_CLOUD_LOG_NAME=googlechatai-sdk-idempotency-monitor"), true);
  assert.equal(deployCommand.includes("GOOGLE_APPLICATION_CREDENTIALS"), false);
  assert.equal(deploy.args.includes("--command"), true);
  assert.equal(deploy.args.includes("node"), true);
  assert.equal(
    plan.commands.some((command) => command.operation === "iam.serviceAccounts.ensure.scheduler"),
    false,
  );
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
      "https://run.googleapis.com/v2/projects/example-chat-project/locations/us-central1/jobs/chat-ai-sdk-idempotency-monitor:run",
    ),
    true,
  );
  assert.equal(
    scheduler.args.includes(
      "chat-ai-sdk-monitor-scheduler@example-chat-project.iam.gserviceaccount.com",
    ),
    true,
  );
  assert.equal(scheduler.args.includes("*/15 * * * *"), true);
});

test("monitor job propagates an explicit monitor target and grants its scheduler identity only job invocation", () => {
  const config = loadIdempotencyMonitorJobConfig({
    argv: [
      "node",
      "idempotency-monitor-job.mjs",
      "--dry-run",
      "--scheduler-service-account",
      "monitor-scheduler@example-chat-project.iam.gserviceaccount.com",
      "--database",
      "tenant-db",
      "--collection",
      "apps/tenant/claims",
      "--ttl-field",
      "expiry",
      "--cloud-log-name",
      "tenant-monitor-log",
      "--upsert-scheduler",
      "--warn-docs",
      "400",
      "--fail-docs",
      "800",
    ],
    env: env(),
  });
  const plan = buildIdempotencyMonitorJobPlan(config);
  const deploy = plan.commands.find((command) => command.operation === "run.jobs.deploy");
  const invoker = plan.commands.find(
    (command) => command.operation === "run.jobs.addIamPolicyBinding.invoker",
  );

  assert.equal(plan.scheduler.oauthServiceAccount, "monitor-scheduler@example-chat-project.iam.gserviceaccount.com");
  assert.equal(plan.scheduler.serviceAccountManaged, false);
  assert.match(deploy.args.join(" "), /GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_DATABASE=tenant-db/);
  assert.match(deploy.args.join(" "), /GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION=apps\/tenant\/claims/);
  assert.match(deploy.args.join(" "), /GOOGLE_CHAT_IDEMPOTENCY_TTL_FIELD=expiry/);
  assert.match(deploy.args.join(" "), /GOOGLE_CHAT_IDEMPOTENCY_MONITOR_CLOUD_LOG_NAME=tenant-monitor-log/);
  assert.equal(invoker.args.includes("roles/run.invoker"), true);
  assert.equal(invoker.args.includes("serviceAccount:monitor-scheduler@example-chat-project.iam.gserviceaccount.com"), true);
});

test("buildIdempotencyMonitorJobPlan can upsert an existing scheduler", async () => {
  const config = loadIdempotencyMonitorJobConfig({
    argv: [
      "node",
      "idempotency-monitor-job.mjs",
      "--dry-run",
      "--upsert-scheduler",
    ],
    env: env(),
  });
  const plan = buildIdempotencyMonitorJobPlan(config);
  const scheduler = plan.commands.find(
    (command) => command.operation === "scheduler.jobs.upsert.http",
  );

  assert.equal(plan.scheduler.enabled, true);
  assert.equal(plan.scheduler.mode, "upsert");
  assert.ok(scheduler);

  const calls = [];
  const result = await runIdempotencyMonitorJobSetup(
    { ...config, dryRun: false },
    {
      runCommand: (args) => {
        calls.push(args);
        if (args.slice(0, 3).join(" ") === "scheduler jobs describe") {
          return JSON.stringify({ name: "existing" });
        }
        return JSON.stringify({ ok: true });
      },
      writeEvidence: false,
    },
  );

  assert.equal(
    calls.some((args) => args.slice(0, 4).join(" ") === "scheduler jobs update http"),
    true,
  );
  assert.equal(
    result.results.some((entry) => entry.operation === "scheduler.jobs.update.http"),
    true,
  );
});

test("idempotency monitor job rejects ambiguous scheduler modes", () => {
  assert.throws(
    () =>
      loadIdempotencyMonitorJobConfig({
        argv: [
          "node",
          "idempotency-monitor-job.mjs",
          "--dry-run",
          "--create-scheduler",
          "--upsert-scheduler",
        ],
        env: env(),
      }),
    /either --create-scheduler or --upsert-scheduler/,
  );
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
      "run jobs deploy",
      "iam service-accounts describe",
      "run jobs add-iam-policy-binding",
      "run jobs execute",
      "services enable cloudscheduler.googleapis.com",
      "scheduler jobs create",
    ],
  );
});

test("monitor job creates its default dedicated scheduler identity before binding job invocation", async () => {
  const config = loadIdempotencyMonitorJobConfig({
    argv: ["node", "idempotency-monitor-job.mjs", "--upsert-scheduler"],
    env: env(),
  });
  const calls = [];
  const result = await runIdempotencyMonitorJobSetup(config, {
    runCommand: (args) => {
      calls.push(args);
      if (args.slice(0, 3).join(" ") === "iam service-accounts describe") {
        throw new Error("not found");
      }
      return JSON.stringify({ ok: true });
    },
    writeEvidence: false,
  });

  assert.equal(
    result.results.some((entry) => entry.operation === "iam.serviceAccounts.create.scheduler"),
    true,
  );
  assert.equal(
    calls.some((args) => args.slice(0, 3).join(" ") === "iam service-accounts create"),
    true,
  );
  const invoker = calls.find((args) => args.slice(0, 3).join(" ") === "run jobs add-iam-policy-binding");
  assert.equal(
    invoker.includes("serviceAccount:chat-ai-sdk-monitor-scheduler@example-chat-project.iam.gserviceaccount.com"),
    true,
  );
});
