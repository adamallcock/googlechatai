import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

if (!packageJson.scripts?.conformance) {
  console.log("No root conformance script yet. Skipping until W1 lands.");
  process.exit(0);
}

const result = spawnSync("pnpm", ["conformance"], {
  cwd: root,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
