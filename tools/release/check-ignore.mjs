import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

const requiredIgnoredPaths = [
  ".env.local",
  ".secrets/chat-ai-sdk-service-account.json",
  ".tokens/google-oauth-token.json",
  "access-token.json",
  "refresh-token.json",
  "packages/node/dist/index.js",
  "node_modules/.pnpm/metadata.json",
  "packages/python/src/googlechatai/__pycache__/events.cpython-312.pyc",
  "artifacts/live/chat-smoke.json",
  "worktrees/w1/tmp.txt",
];

const result = spawnSync("git", ["check-ignore", "-v", "--stdin"], {
  cwd: root,
  input: `${requiredIgnoredPaths.join("\n")}\n`,
  encoding: "utf8",
});

if (result.status !== 0 && result.status !== 1) {
  console.error(result.stderr.trim() || "git check-ignore failed");
  process.exit(result.status ?? 1);
}

const ignored = new Set(
  result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t").at(-1))
    .filter(Boolean),
);

const missing = requiredIgnoredPaths.filter((filePath) => !ignored.has(filePath));

if (missing.length > 0) {
  console.error("Generated or sensitive ignore coverage is missing:");
  missing.forEach((filePath) => console.error(`- ${filePath}`));
  process.exit(1);
}

console.log("Representative generated and sensitive paths are ignored:");
for (const filePath of requiredIgnoredPaths) {
  console.log(`- ${filePath}`);
}
