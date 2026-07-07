import assert from "node:assert/strict";
import test from "node:test";

import {
  billingGatedServices,
  buildBootstrapPlan,
  parseBootstrapArgs,
  resolveBootstrapConfig,
  splitServicesByBillingRequirement,
} from "./bootstrap-project.mjs";
import {
  buildDeployArgs,
  buildRuntimeEnvVars,
  buildDisableInvokerIamArgs,
  resolveDeployConfig,
} from "./deploy-webhook.mjs";

test("parseBootstrapArgs accepts dry-run and partial flags", () => {
  assert.deepEqual(
    parseBootstrapArgs(["node", "bootstrap-project.mjs", "--", "--dry-run"]),
    { dryRun: true, allowPartial: false },
  );
  assert.deepEqual(
    parseBootstrapArgs([
      "node",
      "bootstrap-project.mjs",
      "--allow-partial",
    ]),
    { dryRun: false, allowPartial: true },
  );
});

test("resolveBootstrapConfig derives new-project resource names", () => {
  const config = resolveBootstrapConfig({
    GOOGLE_CLOUD_PROJECT: "example-chat-project",
    GOOGLE_CLOUD_LOCATION: "europe-west2",
    GOOGLE_APPLICATION_CREDENTIALS: "/safe/local/key.json",
  });

  assert.equal(config.project, "example-chat-project");
  assert.equal(config.location, "europe-west2");
  assert.equal(
    config.runtimeServiceAccountEmail,
    "chat-ai-sdk-runtime@example-chat-project.iam.gserviceaccount.com",
  );
  assert.equal(config.credentialsPath, "/safe/local/key.json");
});

test("splitServicesByBillingRequirement keeps billing-gated services explicit", () => {
  const services = [
    "chat.googleapis.com",
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
  ];

  assert.deepEqual(splitServicesByBillingRequirement(services), {
    normal: ["chat.googleapis.com"],
    billingGated: ["run.googleapis.com", "cloudbuild.googleapis.com"],
  });
  assert.ok(billingGatedServices.includes("artifactregistry.googleapis.com"));
});

test("buildBootstrapPlan names expected resources without credentials", () => {
  const config = resolveBootstrapConfig({
    GOOGLE_CLOUD_PROJECT: "example-chat-project",
  });
  const plan = buildBootstrapPlan(config);

  assert.equal(plan.project, "example-chat-project");
  assert.equal(
    plan.resources.runtimeServiceAccount,
    "chat-ai-sdk-runtime@example-chat-project.iam.gserviceaccount.com",
  );
  assert.deepEqual(plan.resources.topics, [
    "chat-ai-sdk-workspace-events",
    "chat-ai-sdk-smoke-tests",
  ]);
  assert.deepEqual(plan.resources.runtimeProjectRoles, ["roles/datastore.user"]);
});

test("resolveDeployConfig and buildDeployArgs are env-driven", () => {
  const config = resolveDeployConfig({
    GOOGLE_CLOUD_PROJECT: "example-chat-project",
    GOOGLE_CLOUD_LOCATION: "us-central1",
    GOOGLE_CHAT_CLOUD_RUN_SERVICE: "example-chat-webhook",
    GOOGLE_CHAT_CLOUD_RUN_SERVICE_ACCOUNT:
      "runtime@example-project.iam.gserviceaccount.com",
    GOOGLE_CHAT_CLOUD_RUN_SOURCE: "examples/cloud-run-node",
  });
  const args = buildDeployArgs(config);

  assert.equal(config.project, "example-chat-project");
  assert.equal(config.service, "example-chat-webhook");
  assert.ok(args.includes("example-chat-webhook"));
  assert.ok(args.includes("runtime@example-project.iam.gserviceaccount.com"));
  assert.ok(
    args.includes("GOOGLE_CLOUD_PROJECT=example-chat-project,NODE_ENV=production"),
  );
  assert.deepEqual(buildDisableInvokerIamArgs(config), [
    "run",
    "services",
    "update",
    "example-chat-webhook",
    "--project",
    "example-chat-project",
    "--region",
    "us-central1",
    "--no-invoker-iam-check",
    "--quiet",
  ]);
});

test("buildRuntimeEnvVars carries durable idempotency settings only when explicit", () => {
  assert.deepEqual(
    buildRuntimeEnvVars(
      {
        GOOGLE_CHAT_IDEMPOTENCY_STORE: "firestore",
        GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION: "chatEventClaims",
        GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_TOKEN: "local-test-token",
      },
      "example-chat-project",
    ),
    {
      GOOGLE_CLOUD_PROJECT: "example-chat-project",
      NODE_ENV: "production",
      GOOGLE_CHAT_IDEMPOTENCY_STORE: "firestore",
      GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION: "chatEventClaims",
    },
  );
});
