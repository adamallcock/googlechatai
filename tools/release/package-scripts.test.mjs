import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function packageScripts() {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;
}

test("release:check enforces parity validation before release hygiene", () => {
  const scripts = packageScripts();

  assert.equal(
    scripts["release:check"],
    "pnpm validate && pnpm release:hygiene",
  );
  assert.equal(
    scripts.validate,
    "pnpm conformance && pnpm parity:exports && pnpm python:static && pnpm python:typecheck && pnpm test && pnpm test:coverage && pnpm build",
  );
  assert.match(scripts["release:hygiene"], /pnpm format:check/);
  assert.match(scripts["release:hygiene"], /pnpm docs:check/);
  assert.match(scripts["release:hygiene"], /pnpm hygiene:secrets/);
  assert.match(scripts["release:hygiene"], /pnpm cloud:source-upload-check -- --allow-missing-gcloud/);
  assert.match(scripts["release:hygiene"], /pnpm package:check/);
  assert.match(scripts["release:hygiene"], /pnpm publish:check/);
  assert.match(scripts["publish:live-check"], /--require-local-version-published/);
});
