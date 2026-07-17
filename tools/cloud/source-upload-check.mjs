import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const requiredIgnoreRules = ["#!include:.gitignore", "docs/private/", "fixtures/live/"];
const protectedPathPrefixes = [
  "docs/private/",
  "fixtures/live/",
  "artifacts/live/",
  ".tokens/",
  "tokens/",
  ".secrets/",
  "secrets/",
];

export function parseSourceUploadCheckArgs(argv) {
  const args = { source: repoRoot, allowMissingGcloud: false, help: false };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") {
      continue;
    } else if (value === "--allow-missing-gcloud") {
      args.allowMissingGcloud = true;
    } else if (value === "--source") {
      args.source = argv[++index];
    } else if (value.startsWith("--source=")) {
      args.source = value.slice("--source=".length);
    } else if (value === "--help" || value === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  args.source = path.resolve(args.source);
  return args;
}

export function validateGcloudIgnore(source) {
  const filePath = path.join(source, ".gcloudignore");
  const contents = fs.readFileSync(filePath, "utf8");
  const missingRules = requiredIgnoreRules.filter((rule) => !contents.includes(rule));
  if (missingRules.length > 0) {
    throw new Error(`.gcloudignore is missing required local-only rules: ${missingRules.join(", ")}.`);
  }
  return { filePath, missingRules };
}

export function assertNoProtectedUploadPaths(paths) {
  const leaked = paths.filter((value) =>
    protectedPathPrefixes.some((prefix) => value === prefix.slice(0, -1) || value.startsWith(prefix)),
  );
  if (leaked.length > 0) {
    throw new Error(
      `Cloud Build source upload would include protected local-only paths: ${leaked.slice(0, 5).join(", ")}.`,
    );
  }
}

function gcloudAvailable() {
  try {
    execFileSync("gcloud", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function listFilesForUpload(source, { runCommand = execFileSync } = {}) {
  const output = runCommand("gcloud", ["meta", "list-files-for-upload", source], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return String(output)
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function checkCloudBuildSourceUpload({
  source = repoRoot,
  allowMissingGcloud = false,
  available = gcloudAvailable,
  listFiles = listFilesForUpload,
} = {}) {
  validateGcloudIgnore(source);
  if (!available()) {
    if (!allowMissingGcloud) {
      throw new Error("gcloud is required to verify the Cloud Build source upload list.");
    }
    return { ok: true, gcloudVerified: false, source: path.resolve(source) };
  }
  const files = listFiles(source);
  assertNoProtectedUploadPaths(files);
  return { ok: true, gcloudVerified: true, source: path.resolve(source), fileCount: files.length };
}

function usage() {
  return `${[
    "Usage: pnpm cloud:source-upload-check [--allow-missing-gcloud] [--source <path>]",
    "",
    "Uses gcloud meta list-files-for-upload to ensure Cloud Build will not receive local live evidence or private ledgers.",
  ].join("\n")}\n`;
}

function main() {
  const args = parseSourceUploadCheckArgs(process.argv);
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  const result = checkCloudBuildSourceUpload(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ name: error.name ?? "Error", message: error.message ?? String(error) }));
    process.exitCode = 1;
  }
}
