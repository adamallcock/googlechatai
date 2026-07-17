import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoProtectedUploadPaths,
  checkCloudBuildSourceUpload,
  parseSourceUploadCheckArgs,
  validateGcloudIgnore,
} from "./source-upload-check.mjs";

test("source upload check accepts pnpm's argument separator", () => {
  const result = parseSourceUploadCheckArgs([
    "node",
    "source-upload-check.mjs",
    "--",
    "--allow-missing-gcloud",
  ]);
  assert.equal(result.allowMissingGcloud, true);
});

test("source upload check requires private-ledger and live-fixture ignore rules", () => {
  const result = validateGcloudIgnore(process.cwd());
  assert.equal(result.missingRules.length, 0);
});

test("source upload check rejects protected local-only paths", () => {
  assert.throws(
    () => assertNoProtectedUploadPaths(["package.json", "docs/private/tenant-ledger.md"]),
    /protected local-only paths/,
  );
  assert.throws(
    () => assertNoProtectedUploadPaths(["fixtures/live/chat-smoke-space.local.json"]),
    /protected local-only paths/,
  );
});

test("source upload check uses the gcloud upload list when available", () => {
  const result = checkCloudBuildSourceUpload({
    source: process.cwd(),
    available: () => true,
    listFiles: () => ["package.json", "examples/cloud-run-node-sdk/Dockerfile"],
  });
  assert.deepEqual(result, {
    ok: true,
    gcloudVerified: true,
    source: process.cwd(),
    fileCount: 2,
  });
});
