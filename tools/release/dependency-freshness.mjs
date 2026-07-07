import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const releaseRunbook = path.join(root, "tools/release/2026-06-29-release-hygiene.md");
const rootPackagePath = path.join(root, "package.json");
const packageJsonPaths = [
  rootPackagePath,
  path.join(root, "packages/node/package.json"),
  path.join(root, "examples/cloud-run-node/package.json"),
];
const pythonPyprojectPath = path.join(root, "packages/python/pyproject.toml");
const dockerfilePath = path.join(root, "examples/cloud-run-node/Dockerfile");

const expectedRootVersions = new Map([
  ["packageManager", "pnpm@11.9.0"],
  ["@types/node", "26.0.1"],
  ["typescript", "6.0.3"],
  ["vitest", "4.1.9"],
]);
const expectedPythonBuildFrontendVersion = "build==1.5.0";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

const rootPackage = JSON.parse(readText(rootPackagePath));
const runbook = readText(releaseRunbook);
const pyproject = readText(pythonPyprojectPath);
const dockerfile = readText(dockerfilePath);
const failures = [];

if (rootPackage.packageManager !== expectedRootVersions.get("packageManager")) {
  failures.push(
    `packageManager must stay ${expectedRootVersions.get("packageManager")} until a newer registry check is documented`,
  );
}

for (const [name, expectedVersion] of expectedRootVersions) {
  if (name === "packageManager") {
    continue;
  }

  const actual = rootPackage.devDependencies?.[name] ?? rootPackage.dependencies?.[name];
  if (actual !== expectedVersion) {
    failures.push(`${name} must be ${expectedVersion}; found ${actual ?? "missing"}`);
  }
}

for (const packageJsonPath of packageJsonPaths) {
  const packageJson = JSON.parse(readText(packageJsonPath));
  const relativePackageJson = path.relative(root, packageJsonPath);

  for (const dependencyType of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const name of Object.keys(packageJson[dependencyType] ?? {})) {
      if (packageJsonPath === rootPackagePath && expectedRootVersions.has(name)) {
        continue;
      }

      if (!runbook.includes(`\`${name}\``) && !runbook.includes(name)) {
        failures.push(
          `${relativePackageJson} ${dependencyType} entry ${name} needs freshness evidence in ${path.relative(root, releaseRunbook)}`,
        );
      }
    }
  }
}

if (!pyproject.includes("hatchling>=1.30.1")) {
  failures.push("packages/python/pyproject.toml must keep hatchling>=1.30.1 or document a newer PyPI check");
}

if (!runbook.includes(`\`${expectedPythonBuildFrontendVersion}\``)) {
  failures.push(
    `release runbook must document the pinned PyPI build frontend ${expectedPythonBuildFrontendVersion}`,
  );
}

const pythonDependencyBlock = pyproject.match(/dependencies\s*=\s*\[(?<body>[\s\S]*?)\]/m)?.groups?.body ?? "";
const pythonDependencies = [...pythonDependencyBlock.matchAll(/"(?<name>[A-Za-z0-9_.-]+)/g)].map(
  (match) => match.groups?.name,
).filter(Boolean);

for (const name of pythonDependencies) {
  if (!runbook.includes(`\`${name}\``) && !runbook.includes(name)) {
    failures.push(
      `packages/python/pyproject.toml dependency ${name} needs freshness evidence in ${path.relative(root, releaseRunbook)}`,
    );
  }
}

if (!/^FROM node:22-slim$/m.test(dockerfile)) {
  failures.push("examples/cloud-run-node/Dockerfile must use a reviewed Node base image");
}

for (const requiredText of [
  "docker buildx imagetools inspect node:22-slim",
  "npm view openai",
  "npm view @google/genai",
  "npm view pdf-parse",
  "npm view sharp",
  "npm view music-metadata",
  "python3 -m pip index versions openai",
  "python3 -m pip index versions google-genai",
  "python3 -m pip index versions pypdf",
  "python3 -m pip index versions Pillow",
  "python3 -m pip index versions mutagen",
]) {
  if (!runbook.includes(requiredText)) {
    failures.push(`release runbook is missing freshness workflow: ${requiredText}`);
  }
}

if (failures.length > 0) {
  console.error("Dependency freshness policy check failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("Dependency freshness policy check passed for pinned npm, PyPI, Docker, and optional provider/parser workflows.");

if (process.env.RUN_LIVE_REGISTRY_CHECKS !== "1") {
  console.log("Live registry checks skipped. Set RUN_LIVE_REGISTRY_CHECKS=1 for release handoff verification.");
  process.exit(0);
}

const liveChecks = [
  ["npm", ["view", "pnpm", "version"]],
  ["npm", ["view", "typescript", "version"]],
  ["npm", ["view", "vitest", "version"]],
  ["npm", ["view", "@types/node", "version"]],
  ["npm", ["view", "openai", "version"]],
  ["npm", ["view", "@google/genai", "version"]],
  ["npm", ["view", "pdf-parse", "version"]],
  ["npm", ["view", "sharp", "version"]],
  ["npm", ["view", "music-metadata", "version"]],
  ["python3", ["-m", "pip", "index", "versions", "hatchling"]],
  ["python3", ["-m", "pip", "index", "versions", "build"]],
  ["python3", ["-m", "pip", "index", "versions", "openai"]],
  ["python3", ["-m", "pip", "index", "versions", "google-genai"]],
  ["python3", ["-m", "pip", "index", "versions", "pypdf"]],
  ["python3", ["-m", "pip", "index", "versions", "Pillow"]],
  ["python3", ["-m", "pip", "index", "versions", "mutagen"]],
  ["docker", ["buildx", "imagetools", "inspect", "node:22-slim"]],
];

for (const [command, args] of liveChecks) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.status !== 0) {
    fail(`Live registry check failed: ${command} ${args.join(" ")}\n${result.stderr.trim()}`);
  }

  const firstLine = result.stdout.split("\n").find((line) => line.trim()) ?? "ok";
  console.log(`${command} ${args.join(" ")}: ${firstLine.trim()}`);
}
