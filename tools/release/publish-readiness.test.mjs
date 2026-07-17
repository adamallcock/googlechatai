import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePublicationPolicy,
  loadPublicationPolicyInput,
  runPublishReadiness,
} from "./publish-readiness.mjs";

function goodInput() {
  return {
    workspacePackage: { private: true },
    nodePackage: {
      name: "googlechatai",
      version: "0.0.2",
      license: "Apache-2.0",
      publishConfig: { access: "public" },
    },
    pythonProject: {
      name: "googlechatai",
      version: "0.0.2",
      license: "Apache-2.0",
      publicBetaClassifier: true,
    },
    hasLicense: true,
    hasNotice: true,
    workflow: [
      "on:\n  workflow_dispatch:",
      "build-artifacts:",
      "needs: build-artifacts",
      "npm publish ./node-package/googlechatai.tgz --access public",
      "pypa/gh-action-pypi-publish@release/v1",
      "registry-artifact-state.mjs npm",
      "registry-artifact-state.mjs pypi",
      "if: steps.npm-state.outputs.publish == 'true'",
      "if: steps.pypi-state.outputs.publish == 'true'",
      "SOURCE_DATE_EPOCH",
      "publish:\n  environment: release\n  permissions:\n    id-token: write",
    ].join("\n"),
    runbook: [
      "googlechatai",
      ".github/workflows/publish.yml",
      "Trusted Publisher",
    ].join("\n"),
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

test("current repository publication policy is internally coherent", () => {
  const result = evaluatePublicationPolicy(loadPublicationPolicyInput());
  assert.equal(result.ok, true);
  assert.equal(result.localVersion, "0.1.0-beta.1");
});

test("publication policy rejects an unpublished Node package configuration", () => {
  const input = goodInput();
  input.nodePackage.publishConfig.access = "restricted";
  const result = evaluatePublicationPolicy(input);
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((entry) => entry.id === "node-public-access")?.ok, false);
});

test("publication policy rejects automatic publication triggers and non-beta Python metadata", () => {
  const input = goodInput();
  input.workflow = `${input.workflow}\npush:\n  branches: [main]`;
  input.pythonProject.publicBetaClassifier = false;
  const result = evaluatePublicationPolicy(input);

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((entry) => entry.id === "manual-only-publish-trigger")?.ok, false);
  assert.equal(result.checks.find((entry) => entry.id === "python-public-beta-classifier")?.ok, false);
});

test("publication policy requires an explicit local npm tarball path", () => {
  const input = goodInput();
  input.workflow = input.workflow.replace(
    "npm publish ./node-package/googlechatai.tgz",
    "npm publish node-package/googlechatai.tgz",
  );
  const result = evaluatePublicationPolicy(input);

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((entry) => entry.id === "trusted-publish-workflow")?.ok, false);
});

test("live readiness verifies both public registries without credentials", async () => {
  const result = await runPublishReadiness({
    input: goodInput(),
    live: true,
    requireLocalVersionPublished: true,
    fetchImpl: async (url) => {
      if (String(url).includes("registry.npmjs.org")) {
        return jsonResponse({
          "dist-tags": { latest: "0.0.2" },
          versions: { "0.0.2": {} },
        });
      }
      return jsonResponse({
        info: { version: "0.0.2" },
        releases: { "0.0.2": [{}] },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.registries, {
    npm: { latest: "0.0.2", localVersionPublished: true },
    pypi: {
      latest: "0.0.2",
      localVersion: "0.0.2",
      localVersionPublished: true,
    },
  });
});

test("live readiness recognizes PyPI's normalized prerelease version", async () => {
  const input = goodInput();
  input.nodePackage.version = "0.1.0-beta.1";
  input.pythonProject.version = "0.1.0-beta.1";
  const result = await runPublishReadiness({
    input,
    live: true,
    requireLocalVersionPublished: true,
    fetchImpl: async (url) => {
      if (String(url).includes("registry.npmjs.org")) {
        return jsonResponse({
          "dist-tags": { latest: "0.0.2", next: "0.1.0-beta.1" },
          versions: { "0.0.2": {}, "0.1.0-beta.1": {} },
        });
      }
      return jsonResponse({
        info: { version: "0.0.2" },
        releases: { "0.0.2": [{}], "0.1.0b1": [{}] },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.registries.pypi.localVersion, "0.1.0b1");
  assert.equal(result.registries.pypi.localVersionPublished, true);
});

test("live readiness fails when only one registry contains the local version", async () => {
  const result = await runPublishReadiness({
    input: goodInput(),
    live: true,
    requireLocalVersionPublished: true,
    fetchImpl: async (url) => {
      if (String(url).includes("registry.npmjs.org")) {
        return jsonResponse({
          "dist-tags": { latest: "0.0.2" },
          versions: { "0.0.2": {} },
        });
      }
      return jsonResponse({
        info: { version: "0.0.1" },
        releases: { "0.0.1": [{}] },
      });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((entry) => entry.id === "pypi-local-version-published")?.ok, false);
});
