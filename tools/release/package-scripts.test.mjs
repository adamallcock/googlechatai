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
  assert.match(scripts.validate, /pnpm parity:exports/);
  assert.match(scripts.validate, /pnpm python:static/);
  assert.match(scripts.validate, /pnpm conformance/);
  assert.match(scripts.validate, /pnpm test/);
  assert.match(scripts["release:hygiene"], /pnpm format:check/);
  assert.match(scripts["release:hygiene"], /pnpm docs:check/);
  assert.match(scripts["release:hygiene"], /pnpm hygiene:secrets/);
  assert.match(scripts["release:hygiene"], /pnpm package:check/);
});
