import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runWorktreeFileChecks } from "./check-worktree-files.mjs";

test("runWorktreeFileChecks reuses one readable file snapshot for format and secret checks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-worktree-check-"));
  const fakeKey = `sk-${"proj-"}${"123456789012345678901234567890"}`;
  await fs.writeFile(path.join(root, "bad.js"), "const x = 1;  \n", "utf8");
  await fs.writeFile(path.join(root, "secret.txt"), `${fakeKey}\n`, "utf8");

  const result = runWorktreeFileChecks(root, [
    "bad.js",
    "secret.txt",
    "deleted-plan.md",
  ]);

  assert.equal(result.files.length, 3);
  assert.equal(result.readableCount, 2);
  assert.equal(Object.hasOwn(result, "entries"), false);
  assert.deepEqual(result.formatFailures, ["bad.js:1: trailing whitespace"]);
  assert.deepEqual(result.secretFindings, ["secret.txt: OpenAI API key"]);
});
