import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const nodePackage = JSON.parse(
  fs.readFileSync(path.join(root, "packages/node/package.json"), "utf8"),
);

function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("GOOGLE_CHAT_") ||
      key.startsWith("RUN_LIVE_") ||
      key === "GOOGLE_APPLICATION_CREDENTIALS" ||
      key === "PYTHONPATH"
    ) {
      delete env[key];
    }
  }
  return {
    ...env,
    CI: "1",
    NO_COLOR: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
  };
}

function run(label, command, args, { cwd = root, env = cleanEnvironment() } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      [
        `${label} failed: ${command} ${args.join(" ")}`,
        result.error?.message,
        result.stdout?.trim(),
        result.stderr?.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  process.stdout.write(`ok ${label}\n`);
  return result.stdout.trim();
}

function pythonExecutable(venvDirectory) {
  return process.platform === "win32"
    ? path.join(venvDirectory, "Scripts", "python.exe")
    : path.join(venvDirectory, "bin", "python");
}

function normalizedPythonVersion(version) {
  const match = version.match(/^(\d+(?:\.\d+){2})-(?:beta|b)[.-]?(\d+)$/i);
  return match ? `${match[1]}b${match[2]}` : version;
}

async function onlyArtifact(directory, suffix) {
  const files = (await fsp.readdir(directory))
    .filter((file) => file.endsWith(suffix))
    .map((file) => path.join(directory, file));
  assert.equal(
    files.length,
    1,
    `Expected one ${suffix} artifact in ${directory}; found ${files.length}.`,
  );
  return files[0];
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function smokeGeneratedServer(label, command, args, { cwd }) {
  const port = await freePort();
  const output = [];
  const child = spawn(command, args, {
    cwd,
    env: {
      ...cleanEnvironment(),
      HOST: "127.0.0.1",
      PORT: String(port),
      GOOGLE_CHAT_PROJECT_NUMBER: "123456789",
      GOOGLE_CHAT_APP_USER: "users/app",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    const healthUrl = `http://127.0.0.1:${port}/healthz`;
    let health = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (child.exitCode !== null) {
        break;
      }
      try {
        health = await fetch(healthUrl);
        if (health.ok) {
          break;
        }
      } catch {
        // The generated server is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!health?.ok) {
      throw new Error(`${label} did not become healthy.\n${output.join("")}`);
    }
    assert.equal((await health.json()).ok, true);

    const unauthorized = await fetch(
      `http://127.0.0.1:${port}/chat/events`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(
      unauthorized.status,
      401,
      `${label} must reject an unverified callback.`,
    );
    process.stdout.write(`ok ${label} health and verification boundary\n`);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
}

function buildPythonArtifacts(tempDirectory) {
  const output = path.join(tempDirectory, "python-dist");
  fs.mkdirSync(output, { recursive: true });
  const uv = spawnSync("uv", ["--version"], {
    encoding: "utf8",
    env: cleanEnvironment(),
  });
  if (!uv.error && uv.status === 0) {
    run(
      "build Python wheel and sdist",
      "uv",
      [
        "build",
        "--sdist",
        "--wheel",
        "--clear",
        "--no-progress",
        "--out-dir",
        output,
        path.join(root, "packages/python"),
      ],
    );
    return output;
  }

  const buildVenv = path.join(tempDirectory, "python-build-venv");
  run("create Python build environment", "python3", ["-m", "venv", buildVenv]);
  const python = pythonExecutable(buildVenv);
  run("install pinned Python build frontend", python, [
    "-m",
    "pip",
    "install",
    "build==1.5.0",
  ]);
  run("build Python wheel and sdist", python, [
    "-m",
    "build",
    "--sdist",
    "--wheel",
    "--outdir",
    output,
    path.join(root, "packages/python"),
  ]);
  return output;
}

export async function runGoldenPath() {
  const tempDirectory = await fsp.mkdtemp(
    path.join(os.tmpdir(), "googlechatai-public-beta-"),
  );
  const keep = process.env.KEEP_GOOGLECHATAI_GOLDEN_PATH === "1";

  try {
    run("build Node package", "corepack", ["pnpm", "build"]);

    const nodeDist = path.join(tempDirectory, "node-dist");
    await fsp.mkdir(nodeDist, { recursive: true });
    run(
      "pack npm artifact",
      "npm",
      ["pack", "--pack-destination", nodeDist],
      { cwd: path.join(root, "packages/node") },
    );
    const tarball = await onlyArtifact(nodeDist, ".tgz");

    const pythonDist = buildPythonArtifacts(tempDirectory);
    const wheel = await onlyArtifact(pythonDist, ".whl");
    await onlyArtifact(pythonDist, ".tar.gz");

    const cliSandbox = path.join(tempDirectory, "cli-sandbox");
    await fsp.mkdir(cliSandbox, { recursive: true });
    await fsp.writeFile(
      path.join(cliSandbox, "package.json"),
      '{"name":"googlechatai-golden-path","private":true}\n',
      "utf8",
    );
    run("install packed CLI", "npm", [
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      tarball,
    ], { cwd: cliSandbox });
    const cli = path.join(
      cliSandbox,
      "node_modules/googlechatai/cli/index.mjs",
    );
    assert.equal(
      run("read installed CLI version", process.execPath, [cli, "--version"], {
        cwd: cliSandbox,
      }),
      nodePackage.version,
    );

    const nodeApp = path.join(tempDirectory, "node-app");
    run("generate Node app from packed CLI", process.execPath, [
      cli,
      "init",
      nodeApp,
      "--language",
      "node",
    ]);
    run("install packed SDK into generated Node app", "npm", [
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      tarball,
    ], { cwd: nodeApp });
    run("generated Node unit test", "npm", ["test"], { cwd: nodeApp });
    run("generated Node fixture replay", "npm", ["run", "fixture"], {
      cwd: nodeApp,
    });
    run("generated Node event inspection", "npm", ["run", "inspect"], {
      cwd: nodeApp,
    });
    run("generated Node card lint", "npm", ["run", "card"], {
      cwd: nodeApp,
    });
    run("generated Node doctor", "npm", ["run", "doctor"], { cwd: nodeApp });
    run("generated Node dry-run smoke", process.execPath, [
      cli,
      "smoke",
      "--metadata",
      "smoke-space.example.json",
    ], { cwd: nodeApp });
    await smokeGeneratedServer(
      "generated Node server",
      process.execPath,
      ["src/server.mjs"],
      { cwd: nodeApp },
    );

    const pythonApp = path.join(tempDirectory, "python-app");
    run("generate Python app from packed CLI", process.execPath, [
      cli,
      "init",
      pythonApp,
      "--language",
      "python",
    ]);
    const pythonVenv = path.join(pythonApp, ".venv");
    run("create generated Python environment", "python3", [
      "-m",
      "venv",
      pythonVenv,
    ], { cwd: pythonApp });
    const python = pythonExecutable(pythonVenv);
    run("install packed Python wheel", python, [
      "-m",
      "pip",
      "install",
      wheel,
    ], { cwd: pythonApp });
    assert.equal(
      run("read installed Python version", python, [
        "-c",
        "import importlib.metadata; print(importlib.metadata.version('googlechatai'))",
      ], { cwd: pythonApp }),
      normalizedPythonVersion(nodePackage.version),
    );
    run("generated Python unit test", python, ["-m", "unittest"], {
      cwd: pythonApp,
    });
    run("generated Python fixture replay", process.execPath, [
      cli,
      "replay",
      "fixtures/mention.json",
      "--language",
      "python",
      "--python",
      python,
      "--handler",
      "app.py",
      "--expect-text",
      "You said",
    ], { cwd: pythonApp });
    run("generated Python event inspection", process.execPath, [
      cli,
      "inspect",
      "fixtures/mention.json",
    ], { cwd: pythonApp });
    run("generated Python card lint", process.execPath, [
      cli,
      "card",
      "lint",
      "fixtures/card.json",
    ], { cwd: pythonApp });
    run("generated Python doctor", process.execPath, [cli, "doctor"], {
      cwd: pythonApp,
    });
    run("generated Python dry-run smoke", process.execPath, [
      cli,
      "smoke",
      "--metadata",
      "smoke-space.example.json",
    ], { cwd: pythonApp });
    await smokeGeneratedServer(
      "generated Python server",
      python,
      ["server.py"],
      { cwd: pythonApp },
    );

    process.stdout.write(
      `Public-beta golden path passed for Node and Python ${nodePackage.version}.\n`,
    );
    return { version: nodePackage.version, tempDirectory, kept: keep };
  } finally {
    if (!keep) {
      await fsp.rm(tempDirectory, { recursive: true, force: true });
    } else {
      process.stdout.write(`Kept golden-path workspace: ${tempDirectory}\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runGoldenPath();
}
