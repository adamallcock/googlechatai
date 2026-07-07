import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Python static checker compiles package and protects public keyword style", () => {
  const result = spawnSync("python3", ["tools/release/python_static_check.py"], {
    cwd: new URL("../..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Python static check passed/);
});
