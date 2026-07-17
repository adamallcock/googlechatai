import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const nodePackage = JSON.parse(
  fs.readFileSync(path.join(root, "packages/node/package.json"), "utf8"),
);

function digest(filePath, algorithm, encoding) {
  return crypto
    .createHash(algorithm)
    .update(fs.readFileSync(filePath))
    .digest(encoding);
}

function normalizedPyPIVersion(version) {
  const match = version.match(
    /^(\d+(?:\.\d+){2})-(alpha|a|beta|b|rc|pre|preview)[.-]?(\d+)$/i,
  );
  if (!match) {
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
  return `${match[1]}${labels[match[2].toLowerCase()]}${match[3]}`;
}

async function fetchExisting(fetchImpl, url, label) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}.`);
  }
  return response.json();
}

export async function checkNpmArtifact({
  filePath,
  packageName = nodePackage.name,
  version = nodePackage.version,
  fetchImpl = globalThis.fetch,
}) {
  if (!fs.statSync(filePath).isFile()) {
    throw new Error("The npm artifact path must be a file.");
  }
  const metadata = await fetchExisting(
    fetchImpl,
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
    "npm registry",
  );
  if (!metadata) {
    return { registry: "npm", version, state: "missing", publish: true };
  }

  const localIntegrity = `sha512-${digest(filePath, "sha512", "base64")}`;
  if (metadata?.dist?.integrity !== localIntegrity) {
    throw new Error(
      `npm ${packageName}@${version} already exists with different artifact integrity.`,
    );
  }
  return { registry: "npm", version, state: "matching", publish: false };
}

export async function checkPyPIArtifacts({
  directory,
  packageName = nodePackage.name,
  version = nodePackage.version,
  fetchImpl = globalThis.fetch,
}) {
  const artifacts = fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".whl") || file.endsWith(".tar.gz"))
    .sort();
  const wheels = artifacts.filter((file) => file.endsWith(".whl"));
  const sdists = artifacts.filter((file) => file.endsWith(".tar.gz"));
  if (wheels.length !== 1 || sdists.length !== 1) {
    throw new Error(
      `Expected one PyPI wheel and one sdist; found ${wheels.length} wheel(s) and ${sdists.length} sdist(s).`,
    );
  }

  const registryVersion = normalizedPyPIVersion(version);
  const metadata = await fetchExisting(
    fetchImpl,
    `https://pypi.org/pypi/${encodeURIComponent(packageName)}/${encodeURIComponent(registryVersion)}/json`,
    "PyPI registry",
  );
  if (!metadata) {
    return {
      registry: "pypi",
      version: registryVersion,
      state: "missing",
      publish: true,
    };
  }

  const remote = new Map(
    (Array.isArray(metadata.urls) ? metadata.urls : []).map((artifact) => [
      artifact.filename,
      artifact.digests?.sha256,
    ]),
  );
  for (const artifact of artifacts) {
    const localHash = digest(path.join(directory, artifact), "sha256", "hex");
    if (remote.get(artifact) !== localHash) {
      throw new Error(
        `PyPI ${packageName} ${registryVersion} already exists with a missing or different ${artifact}.`,
      );
    }
  }
  return {
    registry: "pypi",
    version: registryVersion,
    state: "matching",
    publish: false,
  };
}

function writeWorkflowOutput(result) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    fs.appendFileSync(outputPath, `publish=${result.publish}\n`, "utf8");
  }
}

async function main(argv) {
  const [registry, artifactPath, ...extra] = argv;
  if (
    extra.length > 0 ||
    !["npm", "pypi"].includes(registry) ||
    !artifactPath
  ) {
    throw new Error(
      "Usage: registry-artifact-state.mjs npm PACKAGE.tgz | pypi DIST_DIRECTORY",
    );
  }
  const result =
    registry === "npm"
      ? await checkNpmArtifact({ filePath: path.resolve(artifactPath) })
      : await checkPyPIArtifacts({ directory: path.resolve(artifactPath) });
  writeWorkflowOutput(result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
