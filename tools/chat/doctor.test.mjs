import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDoctorSummary,
  resolveChatDoctorConfig,
  runChatDoctor,
} from "./doctor.mjs";

function doctorEnv(overrides = {}) {
  return {
    GOOGLE_CLOUD_PROJECT: "doctor-test-project",
    GOOGLE_CHAT_CLOUD_RUN_SERVICE: "doctor-test-service",
    GOOGLE_CHAT_WEBHOOK_URL: "https://example.test/api",
    GOOGLE_CHAT_DOCTOR_RUN_ID: "doctor-test-run",
    ...overrides,
  };
}

test("dry-run returns a complete diagnostic plan without command or file side effects", async () => {
  const config = resolveChatDoctorConfig({
    argv: ["node", "doctor.mjs", "--dry-run"],
    env: doctorEnv(),
    cwd: "/repo",
  });
  const effects = [];

  const result = await runChatDoctor(config, {
    runCommand() {
      effects.push("command");
      throw new Error("dry-run should not execute commands");
    },
    readFile() {
      effects.push("readFile");
      throw new Error("dry-run should not read files");
    },
    writeFile() {
      effects.push("writeFile");
      throw new Error("dry-run should not write evidence");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.scope, "all");
  assert.deepEqual(effects, []);
  assert.equal(result.privacy.rawTokensSaved, false);
  assert.equal(result.privacy.rawMessageTextSaved, false);
  assert.equal(result.privacy.rawWebhookUrlSaved, false);

  const checkIds = result.checks.map((check) => check.id);
  assert.deepEqual(checkIds, [
    "setup.cloudProjectApis",
    "setup.smokeMetadata",
    "endpoint.health",
    "cloudRun.revision",
    "auth.app",
    "auth.user",
    "logs.recent",
    "endpoint.chatEvents",
    "interactions.addOnEnvelope",
    "interactions.directEnvelope",
  ]);
  assert.ok(result.checks.every((check) => check.status === "planned"));
  assert.ok(result.checks.every((check) => check.redacted === true));
});

test("live doctor refuses to run without the explicit live guard", () => {
  assert.throws(
    () =>
      resolveChatDoctorConfig({
        argv: ["node", "doctor.mjs"],
        env: doctorEnv({ RUN_LIVE_CHAT_DOCTOR: undefined }),
      }),
    /RUN_LIVE_CHAT_DOCTOR=1/,
  );
});

test("interactions scope dry-run plans add-on and direct envelope replay checks", async () => {
  const config = resolveChatDoctorConfig({
    argv: ["node", "doctor.mjs", "interactions", "--dry-run"],
    env: doctorEnv(),
  });
  const result = await runChatDoctor(config);

  assert.equal(result.scope, "interactions");
  assert.deepEqual(
    result.checks.map((check) => check.id),
    ["endpoint.chatEvents", "interactions.addOnEnvelope", "interactions.directEnvelope"],
  );
  assert.equal(
    result.checks.find((check) => check.id === "endpoint.chatEvents").principal,
    "none",
  );
});

test("setup scope dry-run includes an admin-safe setup bundle without side effects", async () => {
  const config = resolveChatDoctorConfig({
    argv: ["node", "doctor.mjs", "setup", "--dry-run"],
    env: doctorEnv(),
    cwd: "/repo",
  });
  const effects = [];

  const result = await runChatDoctor(config, {
    runCommand() {
      effects.push("command");
      throw new Error("dry-run should not execute commands");
    },
    readFile() {
      effects.push("readFile");
      throw new Error("dry-run should not read files");
    },
  });

  assert.deepEqual(effects, []);
  assert.equal(result.setupBundle.kind, "chat.setup_bundle");
  assert.equal(result.setupBundle.status, "planned");
  assert.equal(result.setupBundle.trustModel.domainWideDelegation, false);
  assert.equal(result.setupBundle.privacy.rawTokensSaved, false);
  assert.equal(result.setupBundle.privacy.rawWebhookUrlSaved, false);
  assert.deepEqual(result.setupBundle.checks.planned, [
    "setup.cloudProjectApis",
    "setup.smokeMetadata",
    "endpoint.health",
    "cloudRun.revision",
    "auth.app",
    "auth.user",
  ]);
  assert.match(
    result.setupBundle.adminPacket.requiredActions.join("\n"),
    /OAuth consent/,
  );
});

test("live doctor classifies endpoint and log failures with actionable remediation", async () => {
  const config = resolveChatDoctorConfig({
    argv: ["node", "doctor.mjs", "--since", "2026-07-04T12:00:00Z"],
    env: doctorEnv({ RUN_LIVE_CHAT_DOCTOR: "1" }),
    cwd: "/repo",
  });

  const result = await runChatDoctor(config, {
    async readFile(filePath) {
      assert.equal(filePath, "/repo/fixtures/live/chat-smoke-space.local.json");
      return JSON.stringify({
        space: "spaces/SMOKE",
        displayName: "Google Chat AI SDK Smoke 2026-07-04",
        safety: { dedicatedSmokeSpace: true },
      });
    },
    runCommand({ id }) {
      if (id === "endpoint.health") {
        return {
          status: 1,
          stdout: "",
          stderr: "fetch failed: connect ECONNREFUSED",
        };
      }
      if (id === "logs.recent") {
        return {
          status: 1,
          stdout: JSON.stringify({
            ok: false,
            failures: ["expectedHttpPostCountMatches"],
            counts: { errors: 0, events: 0, httpPosts: 0 },
          }),
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, status: 200 }),
        stderr: "",
      };
    },
  });

  assert.equal(result.ok, false);

  const health = result.checks.find((check) => check.id === "endpoint.health");
  assert.equal(health.status, "fail");
  assert.equal(health.errorCode, "endpoint_unreachable");
  assert.match(health.remediation, /Cloud Run URL/);

  const logs = result.checks.find((check) => check.id === "logs.recent");
  assert.equal(logs.status, "fail");
  assert.equal(logs.errorCode, "no_request_received");
  assert.match(logs.remediation, /Chat app configuration/);
});

test("doctor writes redacted evidence when requested and renders concise summary", async () => {
  const writes = [];
  const config = resolveChatDoctorConfig({
    argv: [
      "node",
      "doctor.mjs",
      "interactions",
      "--evidence",
      "fixtures/live/evidence/chat-doctor-test.local.json",
    ],
    env: doctorEnv({ RUN_LIVE_CHAT_DOCTOR: "1" }),
    cwd: "/repo",
  });

  const result = await runChatDoctor(config, {
    runCommand() {
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, status: 200 }),
        stderr: "",
      };
    },
    async writeFile(filePath, body) {
      writes.push({ filePath, body });
    },
    async mkdir() {},
  });

  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(
    writes[0].filePath,
    "/repo/fixtures/live/evidence/chat-doctor-test.local.json",
  );
  assert.match(writes[0].body, /"rawTokensSaved": false/);
  assert.doesNotMatch(writes[0].body, /https:\/\/example\.test/);

  const summary = formatDoctorSummary(result);
  assert.match(summary, /Chat doctor: PASS/);
  assert.match(summary, /interactions.addOnEnvelope/);
});

test("doctor can consume the shared Google Chat error explainer for tool remediation", async () => {
  const explained = [];
  const config = resolveChatDoctorConfig({
    argv: ["node", "doctor.mjs"],
    env: doctorEnv({ RUN_LIVE_CHAT_DOCTOR: "1" }),
    cwd: "/repo",
  });

  const result = await runChatDoctor(config, {
    async readFile() {
      return JSON.stringify({
        space: "spaces/SMOKE",
        displayName: "Google Chat AI SDK Smoke 2026-07-04",
        safety: { dedicatedSmokeSpace: true },
      });
    },
    runCommand({ id }) {
      if (["auth.app", "auth.user", "endpoint.chatEvents"].includes(id)) {
        return {
          status: 1,
          stdout: JSON.stringify({
            ok: false,
            status: id === "endpoint.chatEvents" ? 400 : 403,
            error: { message: `${id} shared explainer failure` },
          }),
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, status: 200 }),
        stderr: "",
      };
    },
    async explainGoogleChatError(error, context) {
      explained.push({ error, context });
      return {
        code: `shared_${context.intent}`,
        category: "permission",
        retryable: false,
        summary: `Shared explanation for ${context.intent}.`,
        remediation: [`Shared remediation for ${context.intent}.`],
      };
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    explained.map((item) => item.context.intent),
    ["auth.app", "auth.user", "endpoint.chatEvents"],
  );

  const app = result.checks.find((check) => check.id === "auth.app");
  assert.equal(app.errorCode, "shared_auth.app");
  assert.equal(app.summary, "Shared explanation for auth.app.");
  assert.deepEqual(app.remediation, ["Shared remediation for auth.app."]);
});

test("setup bundle records blocking checks and redacted admin remediation", async () => {
  const config = resolveChatDoctorConfig({
    argv: ["node", "doctor.mjs", "setup", "--format", "summary"],
    env: doctorEnv({ RUN_LIVE_CHAT_DOCTOR: "1" }),
    cwd: "/repo",
  });

  const result = await runChatDoctor(config, {
    async readFile() {
      return JSON.stringify({
        space: "spaces/SMOKE",
        displayName: "Google Chat AI SDK Smoke 2026-07-04",
        safety: { dedicatedSmokeSpace: true },
      });
    },
    runCommand({ id }) {
      if (id === "auth.app") {
        return {
          status: 1,
          stdout: JSON.stringify({
            ok: false,
            status: 403,
            error: { message: "app is not a member of this space" },
          }),
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, url: "https://example.test/api/healthz" }),
        stderr: "",
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.setupBundle.status, "blocked");
  assert.deepEqual(result.setupBundle.checks.blocking, ["auth.app"]);
  assert.match(
    result.setupBundle.adminPacket.requiredActions.join("\n"),
    /Install or authorize the Chat app/,
  );
  assert.doesNotMatch(JSON.stringify(result.setupBundle), /https:\/\/example\.test/);

  const summary = formatDoctorSummary(result);
  assert.match(summary, /Setup bundle: BLOCKED/);
});
