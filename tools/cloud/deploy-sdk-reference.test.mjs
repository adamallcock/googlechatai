import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSdkReferenceDeployCommands,
  buildSdkReferenceDeployPlan,
  deploySdkReference,
  loadSdkReferenceDeployConfig,
} from "./deploy-sdk-reference.mjs";

function env(overrides = {}) {
  return {
    RUN_LIVE_SDK_REFERENCE_DEPLOY: "1",
    GOOGLE_CLOUD_PROJECT: "example-chat-project",
    GOOGLE_CLOUD_LOCATION: "us-central1",
    GOOGLE_CHAT_ARTIFACT_REPOSITORY: "example-images",
    GOOGLE_CHAT_CLOUD_RUN_SERVICE_ACCOUNT:
      "chat-ai-sdk-runtime@example-chat-project.iam.gserviceaccount.com",
    GOOGLE_CHAT_SDK_REFERENCE_AUDIENCE: "https://staging.example.test",
    ...overrides,
  };
}

test("SDK reference deployment refuses cloud mutation without its explicit guard", () => {
  assert.throws(
    () =>
      loadSdkReferenceDeployConfig({
        argv: ["node", "deploy-sdk-reference.mjs"],
        env: {},
      }),
    /RUN_LIVE_SDK_REFERENCE_DEPLOY=1/,
  );
  assert.throws(
    () =>
      loadSdkReferenceDeployConfig({
        argv: ["node", "deploy-sdk-reference.mjs", "--collection=apps/tenant"],
        env: env(),
      }),
    /odd-segment Firestore collection path/,
  );
});

test("SDK reference deployment dry run is safe without a configured audience", () => {
  const config = loadSdkReferenceDeployConfig({
    argv: ["node", "deploy-sdk-reference.mjs", "--dry-run"],
    env: env({ GOOGLE_CHAT_SDK_REFERENCE_AUDIENCE: undefined }),
  });
  const plan = buildSdkReferenceDeployPlan(config);

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.audienceConfigured, false);
  assert.deepEqual(plan.commands.map((entry) => entry.operation), [
    "cloudbuild.submit.sdk-reference",
    "run.deploy.sdk-reference",
  ]);
  assert.equal(plan.chatBoundary.chatAppConfigurationChanged, false);
  assert.equal(plan.chatBoundary.liveChatWritePerformed, false);
});

test("SDK reference deployment builds an isolated Cloud Build and Cloud Run plan", () => {
  const config = loadSdkReferenceDeployConfig({
    argv: ["node", "deploy-sdk-reference.mjs"],
    env: env({ GOOGLE_CHAT_SDK_REFERENCE_RUN_ID: "stable-run" }),
  });
  const commands = buildSdkReferenceDeployCommands(config);
  const build = commands[0].args.join(" ");
  const deploy = commands[1].args.join(" ");

  assert.equal(build.includes("builds submit"), true);
  assert.equal(build.includes("examples/cloud-run-node-sdk/cloudbuild.yaml"), true);
  assert.equal(deploy.includes("run deploy googlechatai-sdk-staging"), true);
  assert.equal(deploy.includes("GOOGLE_CHAT_AUDIENCE=https://staging.example.test"), true);
  assert.equal(deploy.includes("GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION"), true);
  assert.equal(deploy.includes("GOOGLE_CHAT_LOCAL_FIXTURES"), false);
  assert.equal(deploy.includes("--allow-unauthenticated"), true);
  assert.equal(deploy.includes("--concurrency 20"), true);
  assert.equal(deploy.includes("--memory 512Mi"), true);
  assert.deepEqual(buildSdkReferenceDeployPlan(config).capacity, {
    concurrency: 20,
    memory: "512Mi",
    maxRequestBodyBytes: 1_048_576,
  });
});

test("SDK reference deployment rejects an implicit or malformed capacity setting", () => {
  assert.throws(
    () =>
      loadSdkReferenceDeployConfig({
        argv: ["node", "deploy-sdk-reference.mjs", "--concurrency=0"],
        env: env(),
      }),
    /--concurrency must be a positive integer/,
  );
  assert.throws(
    () =>
      loadSdkReferenceDeployConfig({
        argv: ["node", "deploy-sdk-reference.mjs", "--memory=512MB"],
        env: env(),
      }),
    /--memory must use an explicit Cloud Run quantity/,
  );
});

test("SDK reference deployment records only a redacted deployment summary", async () => {
  const config = loadSdkReferenceDeployConfig({
    argv: ["node", "deploy-sdk-reference.mjs", "--run-id", "deploy-test"],
    env: env(),
  });
  const calls = [];
  const result = await deploySdkReference(config, {
    runCommand: (args) => {
      calls.push(args);
      if (args.includes("describe")) {
        return JSON.stringify({
          status: {
            url: "https://staging.example.test",
            latestReadyRevisionName: "googlechatai-sdk-staging-00001-a",
            traffic: [{ percent: 100, latestRevision: true }],
          },
        });
      }
      return "";
    },
    writeEvidence: false,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(result.deployment.healthUrl, "https://staging.example.test/healthz");
  assert.equal(result.idempotency.metadataServerAuthentication, true);
  assert.equal(JSON.stringify(result).includes("https://staging.example.test"), true);
  assert.equal(JSON.stringify(result).includes("GOOGLE_CHAT_SDK_REFERENCE_AUDIENCE"), false);
});
