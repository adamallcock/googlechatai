import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  CliUsageError,
  assertOnlyOptions,
  parseCommandArgs,
  resolvePath,
} from "./common.mjs";

const TEMPLATE_TARGET_NAMES = new Map([
  ["env.example.tmpl", ".env.example"],
  ["gitignore.tmpl", ".gitignore"],
]);

function safeProjectName(targetPath) {
  const name = path.basename(targetPath)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return name || "google-chat-app";
}

async function directoryEntries(directory) {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function pathStatus(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function validateTemplateDestinations(source, destination) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, targetName(entry.name));
    const existing = await pathStatus(destinationPath);
    if (existing?.isSymbolicLink()) {
      throw new CliUsageError(
        `Refusing to overwrite symbolic link: ${destinationPath}`,
      );
    }
    if (entry.isDirectory()) {
      if (existing && !existing.isDirectory()) {
        throw new CliUsageError(
          `Template directory conflicts with an existing file: ${destinationPath}`,
        );
      }
      await validateTemplateDestinations(sourcePath, destinationPath);
    } else if (existing && !existing.isFile()) {
      throw new CliUsageError(
        `Template file conflicts with an existing non-file: ${destinationPath}`,
      );
    }
  }
}

function targetName(name) {
  if (TEMPLATE_TARGET_NAMES.has(name)) {
    return TEMPLATE_TARGET_NAMES.get(name);
  }
  return name.endsWith(".tmpl") ? name.slice(0, -".tmpl".length) : name;
}

async function copyTemplateTree(source, destination, replacements) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, targetName(entry.name));
    if (entry.isDirectory()) {
      await copyTemplateTree(sourcePath, destinationPath, replacements);
      continue;
    }

    let content = await fs.readFile(sourcePath, "utf8");
    for (const [token, replacement] of Object.entries(replacements)) {
      content = content.split(token).join(replacement);
    }
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, content, "utf8");
  }
}

function runInstall(language, target, env, spawn = spawnSync) {
  if (language === "node") {
    return spawn("npm", ["install"], {
      cwd: target,
      env,
      stdio: "inherit",
    });
  }

  const python =
    env.GOOGLECHATAI_PYTHON ??
    (process.platform === "win32" ? "python" : "python3");
  const create = spawn(python, ["-m", "venv", ".venv"], {
    cwd: target,
    env,
    stdio: "inherit",
  });
  if (create.status !== 0) {
    return create;
  }
  const executable =
    process.platform === "win32"
      ? path.join(target, ".venv", "Scripts", "python.exe")
      : path.join(target, ".venv", "bin", "python");
  return spawn(executable, ["-m", "pip", "install", "-r", "requirements.txt"], {
    cwd: target,
    env,
    stdio: "inherit",
  });
}

export async function runInitCommand(args, context) {
  const { options, positionals } = parseCommandArgs(args, {
    booleanFlags: ["force", "install", "help"],
  });
  assertOnlyOptions(options, ["language", "force", "install", "help"]);

  if (options.help) {
    context.stdout.write(
      [
        "Usage: googlechatai init <directory> --language node|python [--install] [--force]",
        "",
        "Creates a minimal verified Google Chat app, sanitized fixture, local test,",
        "environment template, and setup instructions.",
      ].join("\n") + "\n",
    );
    return { exitCode: 0, result: null };
  }

  const targetInput = positionals[0];
  if (!targetInput || positionals.length > 1) {
    throw new CliUsageError("init requires exactly one target directory.");
  }
  const language = options.language ?? "node";
  if (!["node", "python"].includes(language)) {
    throw new CliUsageError("--language must be node or python.");
  }

  const target = resolvePath(targetInput, context.cwd);
  const targetStatus = await pathStatus(target);
  if (targetStatus?.isSymbolicLink()) {
    throw new CliUsageError(`Target directory must not be a symbolic link: ${target}`);
  }
  if (targetStatus && !targetStatus.isDirectory()) {
    throw new CliUsageError(`Target path is not a directory: ${target}`);
  }
  const existing = await directoryEntries(target);
  if (existing.length > 0 && options.force !== true) {
    throw new CliUsageError(
      `Target directory is not empty: ${target}. Use --force to overwrite template files.`,
    );
  }

  const templateRoot = path.join(context.packageRoot, "templates", language);
  const templateEntries = await directoryEntries(templateRoot);
  if (templateEntries.length === 0) {
    throw new Error(`Packaged ${language} scaffold templates are missing.`);
  }
  await validateTemplateDestinations(templateRoot, target);

  const projectName = safeProjectName(target);
  await copyTemplateTree(templateRoot, target, {
    __PROJECT_NAME__: projectName,
    __GOOGLECHATAI_VERSION__: context.version,
  });

  if (options.install === true) {
    const installed = runInstall(
      language,
      target,
      context.env,
      context.spawnSync ?? spawnSync,
    );
    if (installed.status !== 0) {
      throw new Error(`${language} dependency installation failed with exit code ${installed.status}.`);
    }
  }

  const pythonCommand =
    context.env.GOOGLECHATAI_PYTHON ??
    (process.platform === "win32" ? "python" : "python3");
  const next =
    language === "node"
      ? options.install
        ? ["npm test", "npm run fixture", "npm run doctor"]
        : ["npm install", "npm test", "npm run fixture", "npm run doctor"]
      : options.install
        ? [
            process.platform === "win32" ? ".venv\\Scripts\\python -m unittest" : ".venv/bin/python -m unittest",
            "npx googlechatai replay fixtures/mention.json --language python --handler app.py",
          ]
        : [
            `${pythonCommand} -m venv .venv`,
            process.platform === "win32"
              ? ".venv\\Scripts\\python -m pip install -r requirements.txt"
              : ".venv/bin/python -m pip install -r requirements.txt",
            process.platform === "win32" ? ".venv\\Scripts\\python -m unittest" : ".venv/bin/python -m unittest",
          ];

  const result = {
    kind: "googlechatai.scaffold",
    language,
    directory: target,
    projectName,
    installed: options.install === true,
    next,
  };
  context.stdout.write(
    [
      `Created ${language} Google Chat app in ${target}`,
      "",
      "Next:",
      ...next.map((command) => `  ${command}`),
    ].join("\n") + "\n",
  );
  return { exitCode: 0, result };
}
