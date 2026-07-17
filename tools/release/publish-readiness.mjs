import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const PACKAGE_NAME = "googlechatai";
const PUBLIC_BETA_WORKFLOW = ".github/workflows/publish.yml";
const PUBLICATION_RUNBOOK = "docs/runbooks/2026-07-10-publication-handoff.md";

function requiredTomlField(source, field) {
  const match = source.match(new RegExp(`^${field}\\s*=\\s*"([^"\\n]+)"`, "m"));
  return match?.[1] ?? null;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function check(id, ok, detail) {
  return { id, ok, detail };
}

export function loadPublicationPolicyInput({ cwd = root } = {}) {
  const packagePath = path.join(cwd, "package.json");
  const nodePackagePath = path.join(cwd, "packages/node/package.json");
  const pyprojectPath = path.join(cwd, "packages/python/pyproject.toml");
  const workflowPath = path.join(cwd, PUBLIC_BETA_WORKFLOW);
  const runbookPath = path.join(cwd, PUBLICATION_RUNBOOK);
  const pyproject = fs.readFileSync(pyprojectPath, "utf8");

  return {
    workspacePackage: readJson(packagePath),
    nodePackage: readJson(nodePackagePath),
    pythonProject: {
      name: requiredTomlField(pyproject, "name"),
      version: requiredTomlField(pyproject, "version"),
      license: requiredTomlField(pyproject, "license"),
      publicBetaClassifier: pyproject.includes('"Development Status :: 4 - Beta"'),
    },
    hasLicense: fs.existsSync(path.join(cwd, "LICENSE")),
    hasNotice: fs.existsSync(path.join(cwd, "NOTICE")),
    workflow: fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, "utf8") : "",
    runbook: fs.existsSync(runbookPath) ? fs.readFileSync(runbookPath, "utf8") : "",
  };
}

/**
 * Verify only repository-controlled publication policy. Registry ownership,
 * 2FA, and trusted-publisher configuration remain deliberately external
 * account controls and are recorded in the publication runbook.
 */
export function evaluatePublicationPolicy(input) {
  const { workspacePackage, nodePackage, pythonProject, hasLicense, hasNotice, workflow, runbook } = input;
  const checks = [
    check(
      "workspace-private",
      workspacePackage?.private === true,
      "The root workspace must remain private; only language packages publish.",
    ),
    check(
      "node-package-name",
      nodePackage?.name === PACKAGE_NAME,
      `Node package name must be ${PACKAGE_NAME}.`,
    ),
    check(
      "python-package-name",
      pythonProject?.name === PACKAGE_NAME,
      `Python package name must be ${PACKAGE_NAME}.`,
    ),
    check(
      "matching-package-version",
      typeof nodePackage?.version === "string" && nodePackage.version === pythonProject?.version,
      "Node and Python package versions must match exactly.",
    ),
    check(
      "apache-license-metadata",
      nodePackage?.license === "Apache-2.0" && pythonProject?.license === "Apache-2.0",
      "Node and Python package metadata must declare Apache-2.0.",
    ),
    check(
      "python-public-beta-classifier",
      pythonProject?.publicBetaClassifier === true,
      "The published Python metadata must match the documented public-beta posture.",
    ),
    check(
      "node-public-access",
      nodePackage?.private !== true && nodePackage?.publishConfig?.access === "public",
      "The Node package must be publishable as a public npm package.",
    ),
    check(
      "license-and-notice-files",
      hasLicense && hasNotice,
      "Both LICENSE and NOTICE must be present before publication.",
    ),
    check(
      "manual-only-publish-trigger",
      /^\s*workflow_dispatch:/m.test(workflow) &&
        !/^\s*(?:push|pull_request|pull_request_target|schedule):/m.test(workflow),
      "The publication workflow must be manual-only, not triggered by push or pull-request events.",
    ),
    check(
      "trusted-publish-workflow",
        workflow.includes("build-artifacts:") &&
        workflow.includes("needs: build-artifacts") &&
        workflow.includes("id-token: write") &&
        /npm publish\s+\.\/node-package\/[^\s\n]*\.tgz\s+--access public/.test(workflow) &&
        workflow.includes("pypa/gh-action-pypi-publish@release/v1") &&
        workflow.includes("registry-artifact-state.mjs npm") &&
        workflow.includes("registry-artifact-state.mjs pypi") &&
        workflow.includes("steps.npm-state.outputs.publish == 'true'") &&
        workflow.includes("steps.pypi-state.outputs.publish == 'true'") &&
        workflow.includes("SOURCE_DATE_EPOCH") &&
        /publish:\s*[\s\S]*?environment:\s*release[\s\S]*?id-token:\s*write/.test(workflow),
      "The prevalidated, idempotent artifact workflow must use release-environment OIDC for npm and PyPI.",
    ),
    check(
      "publication-runbook",
      runbook.includes(PACKAGE_NAME) &&
        runbook.includes(PUBLIC_BETA_WORKFLOW) &&
        runbook.includes("Trusted Publisher"),
      "The publication runbook must name the package, workflow, and external trust setup.",
    ),
  ];

  return {
    ok: checks.every((entry) => entry.ok),
    localVersion: typeof nodePackage?.version === "string" ? nodePackage.version : null,
    checks,
  };
}

async function fetchJson(fetchImpl, url, label) {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${label} registry returned HTTP ${response.status}.`);
  }
  return response.json();
}

function publishedVersionsFromNpm(payload) {
  return payload && typeof payload === "object" && !Array.isArray(payload) &&
    payload.versions && typeof payload.versions === "object" && !Array.isArray(payload.versions)
    ? Object.keys(payload.versions)
    : [];
}

function publishedVersionsFromPyPI(payload) {
  return payload && typeof payload === "object" && !Array.isArray(payload) &&
    payload.releases && typeof payload.releases === "object" && !Array.isArray(payload.releases)
    ? Object.keys(payload.releases)
    : [];
}

function normalizedPyPIVersion(version) {
  if (typeof version !== "string") {
    return null;
  }
  const prerelease = version.match(
    /^(\d+(?:\.\d+){2})-(alpha|a|beta|b|rc|pre|preview)[.-]?(\d+)$/i,
  );
  if (!prerelease) {
    return version;
  }
  const labels = {
    alpha: "a",
    a: "a",
    beta: "b",
    b: "b",
    rc: "rc",
    pre: "rc",
    preview: "rc",
  };
  return `${prerelease[1]}${labels[prerelease[2].toLowerCase()]}${prerelease[3]}`;
}

/**
 * Optionally verify public registry metadata without authenticating or
 * publishing. This proves availability and immutable-version visibility, not
 * account ownership or trusted-publisher setup.
 */
export async function runPublishReadiness({
  input = loadPublicationPolicyInput(),
  live = false,
  requireLocalVersionPublished = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  const result = evaluatePublicationPolicy(input);
  if (!live) {
    return result;
  }
  if (typeof fetchImpl !== "function") {
    return {
      ...result,
      ok: false,
      checks: [...result.checks, check("registry-fetch", false, "A fetch implementation is required for live checks.")],
    };
  }

  const localVersion = result.localVersion;
  const checks = [...result.checks];
  const registries = {};
  try {
    const npm = await fetchJson(
      fetchImpl,
      `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}`,
      "npm",
    );
    const latest = npm?.["dist-tags"]?.latest;
    const versions = publishedVersionsFromNpm(npm);
    const localVersionPublished = typeof localVersion === "string" && versions.includes(localVersion);
    registries.npm = {
      latest: typeof latest === "string" ? latest : null,
      localVersionPublished,
    };
    checks.push(check("npm-public-registry", typeof latest === "string", "npm must expose a latest public version."));
    if (requireLocalVersionPublished) {
      checks.push(check("npm-local-version-published", localVersionPublished, "npm must expose the local immutable version."));
    }
  } catch (error) {
    checks.push(check("npm-public-registry", false, error instanceof Error ? error.message : String(error)));
  }

  try {
    const pypi = await fetchJson(
      fetchImpl,
      `https://pypi.org/pypi/${encodeURIComponent(PACKAGE_NAME)}/json`,
      "PyPI",
    );
    const latest = pypi?.info?.version;
    const versions = publishedVersionsFromPyPI(pypi);
    const normalizedLocalVersion = normalizedPyPIVersion(localVersion);
    const localVersionPublished =
      typeof normalizedLocalVersion === "string" &&
      versions.includes(normalizedLocalVersion);
    registries.pypi = {
      latest: typeof latest === "string" ? latest : null,
      localVersion: normalizedLocalVersion,
      localVersionPublished,
    };
    checks.push(check("pypi-public-registry", typeof latest === "string", "PyPI must expose a latest public version."));
    if (requireLocalVersionPublished) {
      checks.push(check("pypi-local-version-published", localVersionPublished, "PyPI must expose the local immutable version."));
    }
  } catch (error) {
    checks.push(check("pypi-public-registry", false, error instanceof Error ? error.message : String(error)));
  }

  return {
    ...result,
    ok: checks.every((entry) => entry.ok),
    checks,
    registries,
  };
}

function parseArgs(argv) {
  const args = {
    live: false,
    requireLocalVersionPublished: false,
    json: false,
    help: false,
  };
  for (const value of argv.slice(2)) {
    if (value === "--live") {
      args.live = true;
    } else if (value === "--require-local-version-published") {
      args.requireLocalVersionPublished = true;
    } else if (value === "--json") {
      args.json = true;
    } else if (value === "--help" || value === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

function usage() {
  return `${[
    "Usage: node tools/release/publish-readiness.mjs [--live] [--require-local-version-published] [--json]",
    "",
    "Checks repository-controlled public-beta policy. --live performs unauthenticated npm/PyPI metadata reads.",
    "--require-local-version-published makes the live check fail until both registries expose the local version.",
  ].join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await runPublishReadiness(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const entry of result.checks) {
      process.stdout.write(`${entry.ok ? "ok" : "not ok"} ${entry.id}: ${entry.detail}\n`);
    }
    if (result.registries) {
      process.stdout.write(`npm latest: ${result.registries.npm?.latest ?? "unavailable"}\n`);
      process.stdout.write(`PyPI latest: ${result.registries.pypi?.latest ?? "unavailable"}\n`);
    }
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
