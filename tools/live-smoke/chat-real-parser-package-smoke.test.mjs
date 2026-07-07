import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRealParserPackageSmokePlan,
  loadRealParserPackageSmokeConfig,
  runRealParserPackageSmoke,
} from "./chat-real-parser-package-smoke.mjs";

function env(overrides = {}) {
  return {
    RUN_REAL_PARSER_PACKAGE_SMOKE: "1",
    GOOGLE_CHAT_REAL_PARSER_PACKAGE_RUN_ID: "real-parser-package-test",
    GOOGLE_CHAT_APPROVED_PARSER_PACKAGES:
      "pdf-parse,sharp,music-metadata,pypdf,Pillow,mutagen",
    ...overrides,
  };
}

async function fakeImport(name) {
  if (name === "pdf-parse") {
    return {
      PDFParse: class {
        async getText() {
          return { text: "Google Chat AI SDK real parser package smoke" };
        }

        async destroy() {}
      },
    };
  }
  if (name === "sharp") {
    return {
      default: () => ({
        async metadata() {
          return { width: 1, height: 1, format: "png" };
        },
      }),
    };
  }
  if (name === "music-metadata") {
    return {
      async parseBuffer() {
        return {
          format: {
            container: "WAVE",
            codec: "PCM",
            sampleRate: 8000,
            numberOfChannels: 1,
            duration: 0.1,
          },
        };
      },
    };
  }
  throw Object.assign(new Error(`Cannot find package ${name}`), {
    code: "ERR_MODULE_NOT_FOUND",
  });
}

function fakePythonSpawn() {
  return {
    status: 0,
    stdout: JSON.stringify({
      skipped: false,
      packages: [
        {
          id: "python.pdf",
          packageName: "pypdf",
          version: "fixture",
          status: "complete",
          details: {
            pages: 1,
            text: {
              available: true,
              length: 47,
              sha256: "fixture-hash",
            },
          },
          error: null,
        },
        {
          id: "python.image",
          packageName: "Pillow",
          version: "fixture",
          status: "complete",
          details: {
            width: 1,
            height: 1,
            format: "PNG",
          },
          error: null,
        },
        {
          id: "python.audio",
          packageName: "mutagen",
          version: "fixture",
          status: "complete",
          details: {
            sampleRate: 8000,
            channels: 1,
            bitsPerSample: 16,
            lengthAvailable: true,
          },
          error: null,
        },
      ],
    }),
    stderr: "",
  };
}

async function writeFakeNodeParserPackage(root, name, source) {
  const packageDir = path.join(root, "node_modules", name);
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: "9.9.9",
        type: "module",
        main: "./index.js",
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(path.join(packageDir, "index.js"), source);
}

test("loadRealParserPackageSmokeConfig refuses without explicit guard", () => {
  assert.throws(
    () =>
      loadRealParserPackageSmokeConfig({
        argv: ["node", "chat-real-parser-package-smoke.mjs"],
        env: {},
      }),
    /RUN_REAL_PARSER_PACKAGE_SMOKE=1/,
  );
});

test("dry-run plan names optional packages without requiring guard", () => {
  const config = loadRealParserPackageSmokeConfig({
    argv: [
      "node",
      "chat-real-parser-package-smoke.mjs",
      "--dry-run",
      "--run-id=real-parser-package-dry-run",
    ],
    env: {},
  });
  const plan = buildRealParserPackageSmokePlan(config);

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.packages.node.length, 3);
  assert.equal(plan.packages.python.length, 3);
  assert.equal(plan.privacy.packagesInstalledBySmoke, false);
});

test("dry-run plan redacts explicit parser environment paths", () => {
  const config = loadRealParserPackageSmokeConfig({
    argv: [
      "node",
      "chat-real-parser-package-smoke.mjs",
      "--dry-run",
      "--node-module-dir=/tmp/parser-node/node_modules",
      "--python-executable=/tmp/parser-python/bin/python",
      "--python-path=/tmp/parser-python/lib/python/site-packages",
    ],
    env: {},
  });
  const plan = buildRealParserPackageSmokePlan(config);

  assert.equal(plan.parserEnvironment.nodeModuleDirs[0].basename, "node_modules");
  assert.equal(plan.parserEnvironment.pythonExecutable.basename, "python");
  assert.equal(plan.parserEnvironment.pythonPaths[0].basename, "site-packages");
  assert.equal(
    Object.values(plan.parserEnvironment).join(" ").includes("/tmp/parser"),
    false,
  );
});

test("runRealParserPackageSmoke verifies fake real-package adapters with redacted evidence", async () => {
  const config = loadRealParserPackageSmokeConfig({
    argv: ["node", "chat-real-parser-package-smoke.mjs"],
    env: env(),
  });
  const result = await runRealParserPackageSmoke(config, {
    writeEvidence: false,
    importModule: fakeImport,
    spawn: fakePythonSpawn,
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.failures.length, 0);
  assert.equal(result.evidence.privacy.rawMediaBytesSaved, false);
  assert.equal(result.evidence.privacy.rawExtractedTextSaved, false);
  assert.equal(result.evidence.privacy.externalProviderCallsMade, false);
  assert.equal(result.evidence.runtimes.node.packages[0].status, "complete");
  assert.equal(result.evidence.runtimes.python.packages[0].status, "complete");
  assert.equal(
    result.evidence.runtimes.node.packages[0].details.text.available,
    true,
  );
  assert.equal(
    typeof result.evidence.runtimes.node.packages[0].details.text.sha256,
    "string",
  );
});

test("runRealParserPackageSmoke resolves Node parser packages from explicit module dirs", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-parser-node-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeFakeNodeParserPackage(
    root,
    "pdf-parse",
    `export class PDFParse {
      async getText() {
        return { text: "Google Chat AI SDK real parser package smoke" };
      }
      async destroy() {}
    }`,
  );
  await writeFakeNodeParserPackage(
    root,
    "sharp",
    `export default function sharp() {
      return { async metadata() { return { width: 1, height: 1, format: "png" }; } };
    }`,
  );
  await writeFakeNodeParserPackage(
    root,
    "music-metadata",
    `export async function parseBuffer() {
      return {
        format: {
          container: "WAVE",
          codec: "PCM",
          sampleRate: 8000,
          numberOfChannels: 1,
          duration: 0.1
        }
      };
    }`,
  );
  const config = loadRealParserPackageSmokeConfig({
    argv: [
      "node",
      "chat-real-parser-package-smoke.mjs",
      "--skip-python",
      `--node-module-dir=${path.join(root, "node_modules")}`,
    ],
    env: env({
      GOOGLE_CHAT_APPROVED_PARSER_PACKAGES:
        "pdf-parse@9.9.9,sharp@9.9.9,music-metadata@9.9.9",
    }),
  });

  const result = await runRealParserPackageSmoke(config, { writeEvidence: false });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.evidence.runtimes.node.packages.map((item) => item.version),
    ["9.9.9", "9.9.9", "9.9.9"],
  );
  assert.equal(result.evidence.parserEnvironment.nodeModuleDirs[0].basename, "node_modules");
  assert.equal(
    JSON.stringify(result.evidence.parserEnvironment).includes(root),
    false,
  );
});

test("runRealParserPackageSmoke blocks mismatched exact Node package versions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-parser-node-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeFakeNodeParserPackage(
    root,
    "pdf-parse",
    `export class PDFParse {
      async getText() { return { text: "parser text" }; }
      async destroy() {}
    }`,
  );
  await writeFakeNodeParserPackage(
    root,
    "sharp",
    `export default function sharp() {
      return { async metadata() { return { width: 1, height: 1, format: "png" }; } };
    }`,
  );
  await writeFakeNodeParserPackage(
    root,
    "music-metadata",
    `export async function parseBuffer() {
      return { format: { container: "WAVE" } };
    }`,
  );
  const config = loadRealParserPackageSmokeConfig({
    argv: [
      "node",
      "chat-real-parser-package-smoke.mjs",
      "--skip-python",
      "--allow-blocked",
      `--node-module-dir=${path.join(root, "node_modules")}`,
    ],
    env: env({
      GOOGLE_CHAT_APPROVED_PARSER_PACKAGES:
        "pdf-parse@1.0.0,sharp@9.9.9,music-metadata@9.9.9",
    }),
  });

  const result = await runRealParserPackageSmoke(config, { writeEvidence: false });
  const pdf = result.evidence.runtimes.node.packages[0];

  assert.equal(result.ok, true);
  assert.equal(pdf.status, "blocked");
  assert.equal(
    pdf.details.reason,
    "Approved parser package version does not match installed package.",
  );
  assert.equal(pdf.details.expectedVersion, "1.0.0");
  assert.equal(pdf.details.installedVersion, "9.9.9");
});

test("runRealParserPackageSmoke passes explicit Python executable and path", async () => {
  let observed = null;
  const config = loadRealParserPackageSmokeConfig({
    argv: [
      "node",
      "chat-real-parser-package-smoke.mjs",
      "--skip-node",
      "--python-executable=/tmp/chat-parser-python/bin/python",
      "--python-path=/tmp/chat-parser-python/site-packages",
    ],
    env: env({
      GOOGLE_CHAT_APPROVED_PARSER_PACKAGES: "pypdf,Pillow,mutagen",
    }),
  });

  const result = await runRealParserPackageSmoke(config, {
    writeEvidence: false,
    spawn(command, args, options) {
      observed = { command, args, options };
      return fakePythonSpawn();
    },
  });

  assert.equal(result.ok, true);
  assert.equal(observed.command, "/tmp/chat-parser-python/bin/python");
  assert.match(observed.options.env.PYTHONPATH, /chat-parser-python/);
  assert.equal(result.evidence.parserEnvironment.pythonExecutable.basename, "python");
  assert.equal(
    JSON.stringify(result.evidence.parserEnvironment).includes("/tmp/chat-parser-python"),
    false,
  );
});

test("runRealParserPackageSmoke fails missing packages unless explicitly allowed", async () => {
  const config = loadRealParserPackageSmokeConfig({
    argv: [
      "node",
      "chat-real-parser-package-smoke.mjs",
      "--skip-python",
    ],
    env: env(),
  });
  const missingImport = async () => {
    throw Object.assign(new Error("Cannot find package"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  };

  await assert.rejects(
    () =>
      runRealParserPackageSmoke(config, {
        writeEvidence: false,
        importModule: missingImport,
      }),
    /missing/,
  );
});

test("runRealParserPackageSmoke can record missing package readiness without failing", async () => {
  const config = loadRealParserPackageSmokeConfig({
    argv: [
      "node",
      "chat-real-parser-package-smoke.mjs",
      "--skip-python",
      "--allow-missing",
    ],
    env: env(),
  });
  const missingImport = async () => {
    throw Object.assign(new Error("Cannot find package"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  };

  const result = await runRealParserPackageSmoke(config, {
    writeEvidence: false,
    importModule: missingImport,
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.failures.length, 0);
  assert.equal(result.evidence.runtimes.node.packages[0].status, "missing");
});

test("runRealParserPackageSmoke blocks unapproved parser packages before import", async () => {
  const config = loadRealParserPackageSmokeConfig({
    argv: [
      "node",
      "chat-real-parser-package-smoke.mjs",
      "--skip-python",
      "--allow-blocked",
    ],
    env: env({ GOOGLE_CHAT_APPROVED_PARSER_PACKAGES: "" }),
  });
  let importCalled = false;

  const result = await runRealParserPackageSmoke(config, {
    writeEvidence: false,
    importModule: async () => {
      importCalled = true;
      return {};
    },
  });

  assert.equal(result.ok, true);
  assert.equal(importCalled, false);
  assert.equal(result.evidence.runtimes.node.packages[0].status, "blocked");
});
