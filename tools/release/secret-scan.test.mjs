import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanSecretFiles } from "./secret-scan.mjs";

test("scanSecretFiles ignores deleted worktree paths listed by git", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-secret-scan-"));
  await fs.writeFile(path.join(root, "present.txt"), "ordinary text\n", "utf8");

  assert.deepEqual(
    scanSecretFiles({
      root,
      files: ["present.txt", "deleted-plan.md"],
    }),
    [],
  );
});

test("scanSecretFiles still reports secret patterns for existing files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-secret-scan-"));
  const fakeKey = `sk-${"proj-"}${"123456789012345678901234567890"}`;
  await fs.writeFile(
    path.join(root, "secret.txt"),
    `${fakeKey}\n`,
    "utf8",
  );

  assert.deepEqual(scanSecretFiles({ root, files: ["secret.txt"] }), [
    "secret.txt: OpenAI API key",
  ]);
});
