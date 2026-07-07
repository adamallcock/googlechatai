import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkFormatFiles } from "./check-format.mjs";

test("checkFormatFiles ignores deleted worktree paths listed by git", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-format-check-"));
  await fs.writeFile(path.join(root, "present.txt"), "ok\n", "utf8");

  assert.deepEqual(
    checkFormatFiles({
      root,
      files: ["present.txt", "deleted-plan.md"],
    }),
    [],
  );
});

test("checkFormatFiles still reports format issues for existing files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-format-check-"));
  await fs.writeFile(path.join(root, "bad.js"), "const x = 1;  \n", "utf8");

  assert.deepEqual(checkFormatFiles({ root, files: ["bad.js"] }), [
    "bad.js:1: trailing whitespace",
  ]);
});
