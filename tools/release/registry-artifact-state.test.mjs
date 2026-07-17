import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkNpmArtifact,
  checkPyPIArtifacts,
} from "./registry-artifact-state.mjs";

function response(value, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return value;
    },
  };
}

function hash(value, algorithm, encoding) {
  return crypto.createHash(algorithm).update(value).digest(encoding);
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "googlechatai-registry-state-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("npm artifact state requests publication when the version is missing", async (t) => {
  const directory = await temporaryDirectory(t);
  const artifact = path.join(directory, "package.tgz");
  await fs.writeFile(artifact, "npm artifact");
  const result = await checkNpmArtifact({
    filePath: artifact,
    version: "0.1.0-beta.1",
    fetchImpl: async () => response({}, 404),
  });
  assert.deepEqual(result, {
    registry: "npm",
    version: "0.1.0-beta.1",
    state: "missing",
    publish: true,
  });
});

test("npm artifact state skips only an exact immutable artifact", async (t) => {
  const directory = await temporaryDirectory(t);
  const artifact = path.join(directory, "package.tgz");
  const contents = "npm artifact";
  await fs.writeFile(artifact, contents);
  const result = await checkNpmArtifact({
    filePath: artifact,
    version: "0.1.0-beta.1",
    fetchImpl: async () =>
      response({
        dist: {
          integrity: `sha512-${hash(contents, "sha512", "base64")}`,
        },
      }),
  });
  assert.equal(result.publish, false);
  assert.equal(result.state, "matching");

  await assert.rejects(
    checkNpmArtifact({
      filePath: artifact,
      version: "0.1.0-beta.1",
      fetchImpl: async () =>
        response({ dist: { integrity: "sha512-different" } }),
    }),
    /different artifact integrity/,
  );
});

test("PyPI artifact state uses the canonical prerelease and exact hashes", async (t) => {
  const directory = await temporaryDirectory(t);
  const wheel = "googlechatai-0.1.0b1-py3-none-any.whl";
  const sdist = "googlechatai-0.1.0b1.tar.gz";
  await fs.writeFile(path.join(directory, wheel), "wheel");
  await fs.writeFile(path.join(directory, sdist), "sdist");
  let requestedUrl = null;
  const result = await checkPyPIArtifacts({
    directory,
    version: "0.1.0-beta.1",
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return response({
        urls: [
          {
            filename: wheel,
            digests: { sha256: hash("wheel", "sha256", "hex") },
          },
          {
            filename: sdist,
            digests: { sha256: hash("sdist", "sha256", "hex") },
          },
        ],
      });
    },
  });

  assert.match(requestedUrl, /0\.1\.0b1\/json$/);
  assert.equal(result.publish, false);
  assert.equal(result.state, "matching");
});

test("PyPI artifact state fails closed on an existing mismatch", async (t) => {
  const directory = await temporaryDirectory(t);
  await fs.writeFile(
    path.join(directory, "googlechatai-0.1.0b1-py3-none-any.whl"),
    "wheel",
  );
  await fs.writeFile(
    path.join(directory, "googlechatai-0.1.0b1.tar.gz"),
    "sdist",
  );

  await assert.rejects(
    checkPyPIArtifacts({
      directory,
      version: "0.1.0-beta.1",
      fetchImpl: async () => response({ urls: [] }),
    }),
    /missing or different/,
  );
});
