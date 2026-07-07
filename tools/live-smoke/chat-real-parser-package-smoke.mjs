import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const requireFromHere = createRequire(import.meta.url);

const nodePackages = [
  { id: "node.pdf", packageName: "pdf-parse", importName: "pdf-parse" },
  { id: "node.image", packageName: "sharp", importName: "sharp" },
  { id: "node.audio", packageName: "music-metadata", importName: "music-metadata" },
];
const pythonPackages = [
  { id: "python.pdf", packageName: "pypdf", importName: "pypdf" },
  { id: "python.image", packageName: "Pillow", importName: "PIL" },
  { id: "python.audio", packageName: "mutagen", importName: "mutagen" },
];

function parseArgs(argv) {
  const args = {
    dryRun: false,
    evidencePath: null,
    runId: null,
    skipNode: false,
    skipPython: false,
    allowMissing: false,
    allowBlocked: false,
    approvedPackages: [],
    nodeModuleDirs: [],
    pythonExecutable: null,
    pythonPaths: [],
    help: false,
  };
  const rest = argv.slice(2);

  const readRequiredValue = (index, option) => {
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value.`);
    }
    return value;
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--") {
      continue;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--evidence") {
      args.evidencePath = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--evidence=")) {
      args.evidencePath = arg.slice("--evidence=".length);
    } else if (arg === "--run-id") {
      args.runId = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--run-id=")) {
      args.runId = arg.slice("--run-id=".length);
    } else if (arg === "--skip-node") {
      args.skipNode = true;
    } else if (arg === "--skip-python") {
      args.skipPython = true;
    } else if (arg === "--allow-missing") {
      args.allowMissing = true;
    } else if (arg === "--allow-blocked") {
      args.allowBlocked = true;
    } else if (arg === "--approved-package") {
      args.approvedPackages.push(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--approved-package=")) {
      args.approvedPackages.push(arg.slice("--approved-package=".length));
    } else if (arg === "--node-module-dir") {
      args.nodeModuleDirs.push(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--node-module-dir=")) {
      args.nodeModuleDirs.push(arg.slice("--node-module-dir=".length));
    } else if (arg === "--python-executable") {
      args.pythonExecutable = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--python-executable=")) {
      args.pythonExecutable = arg.slice("--python-executable=".length);
    } else if (arg === "--python-path") {
      args.pythonPaths.push(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--python-path=")) {
      args.pythonPaths.push(arg.slice("--python-path=".length));
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function parsePathList(value) {
  return String(value ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseApprovedPackages(env, args) {
  const raw = [
    env.GOOGLE_CHAT_APPROVED_PARSER_PACKAGES ?? "",
    ...args.approvedPackages,
  ].join(",");
  return raw
    .split(/[,\s]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveMaybePath(input, cwd = process.cwd()) {
  if (!input) {
    return null;
  }
  if (!input.includes("/") && !input.includes("\\")) {
    return input;
  }
  return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}

function resolvePathList(inputs, cwd = process.cwd()) {
  return inputs.map((item) => resolvePath(item, cwd));
}

function resolvePath(input, cwd = process.cwd()) {
  if (!input) {
    return null;
  }
  return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `real-parser-package-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export function loadRealParserPackageSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_REAL_PARSER_PACKAGE_SMOKE !== "1" && !args.dryRun) {
    throw new Error(
      "Refusing to run real parser package smoke without RUN_REAL_PARSER_PACKAGE_SMOKE=1.",
    );
  }

  if (args.skipNode && args.skipPython) {
    throw new Error("At least one runtime must be enabled.");
  }

  return {
    dryRun: args.dryRun,
    runId: args.runId ?? env.GOOGLE_CHAT_REAL_PARSER_PACKAGE_RUN_ID ?? makeRunId(),
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_REAL_PARSER_PACKAGE_EVIDENCE,
      cwd,
    ),
    skipNode: args.skipNode,
    skipPython: args.skipPython,
    allowMissing: args.allowMissing,
    allowBlocked: args.allowBlocked,
    approvedPackages: parseApprovedPackages(env, args),
    nodeModuleDirs: resolvePathList(
      [
        ...parsePathList(env.GOOGLE_CHAT_PARSER_NODE_MODULE_DIRS),
        ...args.nodeModuleDirs,
      ],
      cwd,
    ),
    pythonExecutable: resolveMaybePath(
      args.pythonExecutable ?? env.GOOGLE_CHAT_PARSER_PYTHON ?? "python3",
      cwd,
    ),
    pythonPaths: resolvePathList(
      [
        ...parsePathList(env.GOOGLE_CHAT_PARSER_PYTHONPATH),
        ...args.pythonPaths,
      ],
      cwd,
    ),
  };
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update("googlechatai-real-parser-package-smoke")
    .update("\0")
    .update(String(value ?? ""))
    .digest("hex");
}

function textSummary(text) {
  return {
    available: typeof text === "string" && text.length > 0,
    length: typeof text === "string" ? text.length : 0,
    sha256: typeof text === "string" && text.length > 0 ? stableHash(text) : null,
  };
}

function escapePdfText(text) {
  return text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function makePdfBytes(text = "Google Chat AI SDK real parser package smoke") {
  const stream = `BT /F1 14 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let body = "%PDF-1.4\n";
  const offsets = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }

  const startXref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

function makePngBytes() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/l2fRkwAAAABJRU5ErkJggg==",
    "base64",
  );
}

function makeWavBytes() {
  const sampleRate = 8000;
  const channels = 1;
  const bitsPerSample = 16;
  const seconds = 0.1;
  const sampleCount = Math.floor(sampleRate * seconds);
  const dataSize = sampleCount * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function buildFixtureBytes() {
  return {
    pdf: makePdfBytes(),
    png: makePngBytes(),
    wav: makeWavBytes(),
  };
}

function pathSummary(value) {
  if (!value) {
    return null;
  }
  return {
    basename: path.basename(value),
    sha256: stableHash(path.resolve(String(value))),
  };
}

function nodeResolvers(nodeModuleDirs = []) {
  return nodeModuleDirs.map((dir) =>
    createRequire(path.join(dir, ".googlechatai-parser-smoke.cjs")),
  );
}

function readPackageVersion(packageJsonPath, packageName) {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(packageJsonPath, "utf8"));
    if (!parsed.name || parsed.name === packageName) {
      return parsed.version ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

function findNearestPackageVersion(resolvedPath, packageName) {
  let dir = path.dirname(resolvedPath);
  while (dir && dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "package.json");
    const version = readPackageVersion(candidate, packageName);
    if (version) {
      return version;
    }
    dir = path.dirname(dir);
  }
  return null;
}

function packageVersion(packageName, resolvers = []) {
  const activeResolvers = resolvers.length > 0 ? resolvers : [requireFromHere];
  for (const resolver of activeResolvers) {
    try {
      const packageJson = resolver.resolve(`${packageName}/package.json`);
      const version = readPackageVersion(packageJson, packageName);
      if (version) {
        return version;
      }
    } catch {
      // Some packages do not export package.json; fall back to walking up from
      // the resolved entrypoint so exact-version approvals still mean exact.
    }
    try {
      const entrypoint = resolver.resolve(packageName);
      const version = findNearestPackageVersion(entrypoint, packageName);
      if (version) {
        return version;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function makeNodeImportModule(resolvers = []) {
  if (resolvers.length === 0) {
    return (name) => import(name);
  }

  return async (name) => {
    let lastError = null;
    for (const resolver of resolvers) {
      try {
        const resolved = resolver.resolve(name);
        return import(pathToFileURL(resolved).href);
      } catch (error) {
        lastError = error;
      }
    }
    const error = new Error(
      `Cannot find package ${name} in approved parser module directories.`,
    );
    error.code = lastError?.code ?? "ERR_MODULE_NOT_FOUND";
    throw error;
  };
}

async function optionalImport(importName, importModule) {
  try {
    return { ok: true, module: await importModule(importName) };
  } catch (error) {
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" ||
      error?.code === "MODULE_NOT_FOUND"
    ) {
      return { ok: false, missing: true, message: error.message };
    }
    return { ok: false, missing: false, message: error.message ?? String(error) };
  }
}

function packageResult({ id, packageName, status, version = null, details = {}, error = null }) {
  return {
    id,
    packageName,
    version,
    status,
    details,
    error: error
      ? {
          name: error.name ?? "Error",
          messageHash: stableHash(error.message ?? String(error)),
        }
      : null,
  };
}

function packageApproval(packageName, approvedPackages = []) {
  if (approvedPackages.includes("*")) {
    return { approved: true, expectedVersion: null };
  }
  for (const spec of approvedPackages) {
    if (spec === packageName) {
      return { approved: true, expectedVersion: null };
    }
    const versionPrefix = `${packageName}@`;
    if (spec.startsWith(versionPrefix)) {
      return {
        approved: true,
        expectedVersion: spec.slice(versionPrefix.length),
      };
    }
  }
  return { approved: false, expectedVersion: null };
}

function blockedPackageResult(id, packageName, details = {}) {
  return packageResult({
    id,
    packageName,
    status: "blocked",
    details: {
      reason:
        "Package import requires GOOGLE_CHAT_APPROVED_PARSER_PACKAGES or --approved-package.",
      ...details,
    },
  });
}

function packageImportGate(id, packageName, approvedPackages, resolvers = []) {
  const approval = packageApproval(packageName, approvedPackages);
  if (!approval.approved) {
    return blockedPackageResult(id, packageName);
  }

  if (approval.expectedVersion) {
    const installedVersion = packageVersion(packageName, resolvers);
    if (!installedVersion) {
      return blockedPackageResult(id, packageName, {
        reason: "Approved parser package version could not be verified.",
        expectedVersion: approval.expectedVersion,
        installedVersion: null,
      });
    }
    if (installedVersion && installedVersion !== approval.expectedVersion) {
      return blockedPackageResult(id, packageName, {
        reason: "Approved parser package version does not match installed package.",
        expectedVersion: approval.expectedVersion,
        installedVersion,
      });
    }
  }

  return null;
}

async function parseNodePdf(bytes, importModule, approvedPackages, resolvers) {
  const gate = packageImportGate("node.pdf", "pdf-parse", approvedPackages, resolvers);
  if (gate) {
    return gate;
  }

  const dependency = await optionalImport("pdf-parse", importModule);
  if (!dependency.ok) {
    return packageResult({
      id: "node.pdf",
      packageName: "pdf-parse",
      status: dependency.missing ? "missing" : "error",
      version: packageVersion("pdf-parse", resolvers),
      details: dependency.missing ? { importName: "pdf-parse" } : {},
      error: dependency.missing ? null : new Error(dependency.message),
    });
  }

  try {
    const mod = dependency.module;
    let text = "";

    if (typeof mod.PDFParse === "function") {
      const parser = new mod.PDFParse({ data: bytes });
      const result = await parser.getText();
      await parser.destroy?.();
      text = result?.text ?? "";
    } else {
      const parse = mod.default ?? mod.pdfParse ?? mod.parse;
      const result = await parse(bytes);
      text = result?.text ?? result?.data?.text ?? "";
    }

    return packageResult({
      id: "node.pdf",
      packageName: "pdf-parse",
      version: packageVersion("pdf-parse", resolvers),
      status: text ? "complete" : "partial",
      details: {
        text: textSummary(text),
      },
    });
  } catch (error) {
    return packageResult({
      id: "node.pdf",
      packageName: "pdf-parse",
      version: packageVersion("pdf-parse", resolvers),
      status: "error",
      error,
    });
  }
}

async function parseNodeImage(bytes, importModule, approvedPackages, resolvers) {
  const gate = packageImportGate("node.image", "sharp", approvedPackages, resolvers);
  if (gate) {
    return gate;
  }

  const dependency = await optionalImport("sharp", importModule);
  if (!dependency.ok) {
    return packageResult({
      id: "node.image",
      packageName: "sharp",
      status: dependency.missing ? "missing" : "error",
      version: packageVersion("sharp", resolvers),
      details: dependency.missing ? { importName: "sharp" } : {},
      error: dependency.missing ? null : new Error(dependency.message),
    });
  }

  try {
    const sharp = dependency.module.default ?? dependency.module;
    const metadata = await sharp(bytes).metadata();
    return packageResult({
      id: "node.image",
      packageName: "sharp",
      version: packageVersion("sharp", resolvers),
      status: metadata.width && metadata.height ? "complete" : "partial",
      details: {
        width: metadata.width ?? null,
        height: metadata.height ?? null,
        format: metadata.format ?? null,
      },
    });
  } catch (error) {
    return packageResult({
      id: "node.image",
      packageName: "sharp",
      version: packageVersion("sharp", resolvers),
      status: "error",
      error,
    });
  }
}

async function parseNodeAudio(bytes, importModule, approvedPackages, resolvers) {
  const gate = packageImportGate(
    "node.audio",
    "music-metadata",
    approvedPackages,
    resolvers,
  );
  if (gate) {
    return gate;
  }

  const dependency = await optionalImport("music-metadata", importModule);
  if (!dependency.ok) {
    return packageResult({
      id: "node.audio",
      packageName: "music-metadata",
      status: dependency.missing ? "missing" : "error",
      version: packageVersion("music-metadata", resolvers),
      details: dependency.missing ? { importName: "music-metadata" } : {},
      error: dependency.missing ? null : new Error(dependency.message),
    });
  }

  try {
    const parseBuffer = dependency.module.parseBuffer ?? dependency.module.default?.parseBuffer;
    const metadata = await parseBuffer(bytes, {
      mimeType: "audio/wav",
      size: bytes.byteLength,
    });
    return packageResult({
      id: "node.audio",
      packageName: "music-metadata",
      version: packageVersion("music-metadata", resolvers),
      status: metadata?.format ? "complete" : "partial",
      details: {
        container: metadata?.format?.container ?? null,
        codec: metadata?.format?.codec ?? null,
        sampleRate: metadata?.format?.sampleRate ?? null,
        numberOfChannels: metadata?.format?.numberOfChannels ?? null,
        durationAvailable: typeof metadata?.format?.duration === "number",
      },
    });
  } catch (error) {
    return packageResult({
      id: "node.audio",
      packageName: "music-metadata",
      version: packageVersion("music-metadata", resolvers),
      status: "error",
      error,
    });
  }
}

async function runNodeParsers(
  fixtures,
  {
    importModule = (name) => import(name),
    approvedPackages = [],
    resolvers = [],
  } = {},
) {
  return {
    skipped: false,
    packages: [
      await parseNodePdf(fixtures.pdf, importModule, approvedPackages, resolvers),
      await parseNodeImage(fixtures.png, importModule, approvedPackages, resolvers),
      await parseNodeAudio(fixtures.wav, importModule, approvedPackages, resolvers),
    ],
  };
}

function pythonSmokeSource() {
  return String.raw`
import base64
import hashlib
import importlib
import importlib.metadata
import io
import json
import sys


def stable_hash(value):
    h = hashlib.sha256()
    h.update(b"googlechatai-real-parser-package-smoke")
    h.update(b"\0")
    h.update(str(value or "").encode())
    return h.hexdigest()


def text_summary(text):
    return {
        "available": isinstance(text, str) and len(text) > 0,
        "length": len(text) if isinstance(text, str) else 0,
        "sha256": stable_hash(text) if isinstance(text, str) and len(text) > 0 else None,
    }


def version(package):
    try:
        return importlib.metadata.version(package)
    except Exception:
        return None


def result(id, package_name, status, details=None, error=None):
    return {
        "id": id,
        "packageName": package_name,
        "version": version(package_name),
        "status": status,
        "details": details or {},
        "error": {
            "name": type(error).__name__,
            "messageHash": stable_hash(str(error)),
        } if error else None,
    }


def optional_import(import_name):
    try:
        return importlib.import_module(import_name), None
    except ModuleNotFoundError:
        return None, "missing"
    except Exception as exc:
        return None, exc


payload = json.loads(sys.stdin.read())
approved_packages = set(payload.get("approvedPackages", []))


def approval(package_name):
    if "*" in approved_packages:
        return True, None
    if package_name in approved_packages:
        return True, None
    prefix = f"{package_name}@"
    for spec in approved_packages:
        if spec.startswith(prefix):
            return True, spec[len(prefix):]
    return False, None


def blocked(id, package_name, details=None):
    merged = {
        "reason": "Package import requires GOOGLE_CHAT_APPROVED_PARSER_PACKAGES or --approved-package."
    }
    if details:
        merged.update(details)
    return result(
        id,
        package_name,
        "blocked",
        merged,
    )


def import_gate(id, package_name):
    is_approved, expected_version = approval(package_name)
    if not is_approved:
        return blocked(id, package_name)
    if expected_version:
        installed_version = version(package_name)
        if installed_version and installed_version != expected_version:
            return blocked(
                id,
                package_name,
                {
                    "reason": "Approved parser package version does not match installed package.",
                    "expectedVersion": expected_version,
                    "installedVersion": installed_version,
                },
            )
    return None


pdf_bytes = base64.b64decode(payload["pdf"])
png_bytes = base64.b64decode(payload["png"])
wav_bytes = base64.b64decode(payload["wav"])
packages = []

gate = import_gate("python.pdf", "pypdf")
if gate:
    packages.append(gate)
else:
    pypdf, error = optional_import("pypdf")
    if pypdf is None:
        packages.append(result("python.pdf", "pypdf", "missing" if error == "missing" else "error", {"importName": "pypdf"} if error == "missing" else {}, None if error == "missing" else error))
    else:
        try:
            reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
            text = "\n".join(page.extract_text() or "" for page in reader.pages)
            packages.append(result("python.pdf", "pypdf", "complete" if text else "partial", {"pages": len(reader.pages), "text": text_summary(text)}))
        except Exception as exc:
            packages.append(result("python.pdf", "pypdf", "error", error=exc))

gate = import_gate("python.image", "Pillow")
if gate:
    packages.append(gate)
else:
    pil_image, error = optional_import("PIL.Image")
    if pil_image is None:
        packages.append(result("python.image", "Pillow", "missing" if error == "missing" else "error", {"importName": "PIL.Image"} if error == "missing" else {}, None if error == "missing" else error))
    else:
        try:
            image = pil_image.open(io.BytesIO(png_bytes))
            packages.append(result("python.image", "Pillow", "complete", {"width": image.width, "height": image.height, "format": image.format}))
        except Exception as exc:
            packages.append(result("python.image", "Pillow", "error", error=exc))

gate = import_gate("python.audio", "mutagen")
if gate:
    packages.append(gate)
else:
    mutagen_wave, error = optional_import("mutagen.wave")
    if mutagen_wave is None:
        packages.append(result("python.audio", "mutagen", "missing" if error == "missing" else "error", {"importName": "mutagen.wave"} if error == "missing" else {}, None if error == "missing" else error))
    else:
        try:
            audio = mutagen_wave.WAVE(io.BytesIO(wav_bytes))
            info = audio.info
            packages.append(result("python.audio", "mutagen", "complete", {
                "sampleRate": getattr(info, "sample_rate", None),
                "channels": getattr(info, "channels", None),
                "bitsPerSample": getattr(info, "bits_per_sample", None),
                "lengthAvailable": isinstance(getattr(info, "length", None), float),
            }))
        except Exception as exc:
            packages.append(result("python.audio", "mutagen", "error", error=exc))

print(json.dumps({"skipped": False, "packages": packages}, sort_keys=True))
`;
}

function pythonEnv(pythonPaths = []) {
  if (pythonPaths.length === 0) {
    return undefined;
  }

  return {
    ...process.env,
    PYTHONPATH: [
      ...pythonPaths,
      process.env.PYTHONPATH,
    ]
      .filter(Boolean)
      .join(path.delimiter),
  };
}

function runPythonParsers(
  fixtures,
  {
    spawn = spawnSync,
    approvedPackages = [],
    pythonExecutable = "python3",
    pythonPaths = [],
  } = {},
) {
  const payload = JSON.stringify({
    pdf: fixtures.pdf.toString("base64"),
    png: fixtures.png.toString("base64"),
    wav: fixtures.wav.toString("base64"),
    approvedPackages,
  });
  const result = spawn(pythonExecutable, ["-c", pythonSmokeSource()], {
    cwd: repoRoot,
    encoding: "utf8",
    input: payload,
    env: pythonEnv(pythonPaths),
  });

  if (result.status !== 0) {
    throw new Error(
      `Python real parser package smoke failed: ${result.stderr || result.stdout}`,
    );
  }

  return JSON.parse(result.stdout);
}

export function buildRealParserPackageSmokePlan(config) {
  return {
    mode: config.dryRun ? "dry-run" : "live-local",
    runId: config.runId,
    packages: {
      node: config.skipNode ? [] : nodePackages,
      python: config.skipPython ? [] : pythonPackages,
    },
    approvedPackages: config.approvedPackages,
    parserEnvironment: {
      nodeModuleDirs: (config.nodeModuleDirs ?? []).map(pathSummary),
      pythonExecutable: pathSummary(config.pythonExecutable),
      pythonPaths: (config.pythonPaths ?? []).map(pathSummary),
    },
    privacy: {
      sampleMediaGeneratedLocally: true,
      rawMediaBytesSaved: false,
      rawExtractedTextSaved: false,
      externalProviderCallsMade: false,
      packagesInstalledBySmoke: false,
    },
    liveGates: config.dryRun
      ? []
      : ["RUN_REAL_PARSER_PACKAGE_SMOKE=1"],
  };
}

function collectFailures(evidence, { allowMissing, allowBlocked }) {
  const failures = [];
  for (const [runtime, result] of Object.entries(evidence.runtimes)) {
    if (result.skipped) {
      continue;
    }
    for (const item of result.packages) {
      if (item.status === "complete" || item.status === "partial") {
        continue;
      }
      if (item.status === "missing" && allowMissing) {
        continue;
      }
      if (item.status === "blocked" && allowBlocked) {
        continue;
      }
      failures.push(`${runtime}.${item.packageName}.${item.status}`);
    }
  }
  return failures;
}

async function writeEvidenceFile(config, evidence) {
  const evidencePath =
    config.evidencePath ??
    path.join(defaultEvidenceDir, `chat-real-parser-package-smoke-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

export async function runRealParserPackageSmoke(
  config,
  { writeEvidence = true, importModule, spawn } = {},
) {
  if (config.help) {
    return { ok: true, evidence: { help: true } };
  }

  if (config.dryRun) {
    return { ok: true, evidence: buildRealParserPackageSmokePlan(config) };
  }

  const startedAt = new Date().toISOString();
  const fixtures = buildFixtureBytes();
  const resolvers = nodeResolvers(config.nodeModuleDirs ?? []);
  const nodeImportModule = importModule ?? makeNodeImportModule(resolvers);
  const node = config.skipNode
    ? { skipped: true, packages: [] }
    : await runNodeParsers(fixtures, {
        importModule: nodeImportModule,
        approvedPackages: config.approvedPackages,
        resolvers,
      });
  const python = config.skipPython
    ? { skipped: true, packages: [] }
    : runPythonParsers(fixtures, {
        spawn,
        approvedPackages: config.approvedPackages,
        pythonExecutable: config.pythonExecutable,
        pythonPaths: config.pythonPaths,
      });

  const evidence = {
    ok: true,
    mode: "real-parser-package",
    runId: config.runId,
    approvedPackages: config.approvedPackages,
    startedAt,
    finishedAt: new Date().toISOString(),
    parserEnvironment: {
      nodeModuleDirs: (config.nodeModuleDirs ?? []).map(pathSummary),
      pythonExecutable: pathSummary(config.pythonExecutable),
      pythonPaths: (config.pythonPaths ?? []).map(pathSummary),
    },
    runtimes: {
      node,
      python,
    },
    privacy: {
      sampleMediaGeneratedLocally: true,
      rawMediaBytesSaved: false,
      rawExtractedTextSaved: false,
      externalProviderCallsMade: false,
      packagesInstalledBySmoke: false,
    },
  };

  evidence.failures = collectFailures(evidence, {
    allowMissing: config.allowMissing,
    allowBlocked: config.allowBlocked,
  });
  evidence.ok = evidence.failures.length === 0;
  if (writeEvidence) {
    evidence.evidencePath = await writeEvidenceFile(config, evidence);
  }

  if (evidence.failures.length > 0) {
    const error = new Error(
      `Real parser package smoke assertions failed: ${evidence.failures.join(", ")}`,
    );
    error.evidence = evidence;
    throw error;
  }

  return { ok: true, evidence };
}

function usage() {
  return `${[
    "Usage: pnpm chat:real-parser-package-smoke",
    "",
    "Runs optional local parser package checks for PDF, image, and audio fixtures.",
    "The smoke does not install packages, call transcription providers, or save raw extracted text.",
    "",
    "Required for live-local mode:",
    "  RUN_REAL_PARSER_PACKAGE_SMOKE=1",
    "  GOOGLE_CHAT_APPROVED_PARSER_PACKAGES=<comma-separated package names>",
    "  or repeated --approved-package flags for packages that may be imported.",
    "",
    "Optional packages checked when installed:",
    "  Node: pdf-parse, sharp, music-metadata",
    "  Python: pypdf, Pillow, mutagen",
    "",
    "Options:",
    "  --dry-run          Show package plan without importing parsers.",
    "  --allow-missing    Record missing parser packages as non-fatal.",
    "  --allow-blocked    Record unapproved parser packages as non-fatal.",
    "  --approved-package <name>",
    "                     Approve one parser package for import; repeatable.",
    "                     Use <name>@<version> to require an exact installed version.",
    "  --node-module-dir <path>",
    "                     Resolve Node parser packages from this node_modules directory; repeatable.",
    "  --python-executable <path>",
    "                     Python executable for parser package imports; defaults to python3.",
    "  --python-path <path>",
    "                     Extra PYTHONPATH entry for Python parser packages; repeatable.",
    "  --evidence <path>  Evidence JSON output path.",
    "  --run-id <id>      Stable run id for evidence.",
    "  --skip-node        Skip Node package checks.",
    "  --skip-python      Skip Python package checks.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = loadRealParserPackageSmokeConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runRealParserPackageSmoke(config);
    process.stdout.write(`${JSON.stringify(result.evidence, null, 2)}\n`);
  } catch (error) {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
      process.stdout.write(usage());
      return;
    }
    console.error(
      JSON.stringify(
        {
          name: error.name ?? "Error",
          message: error.message ?? String(error),
        },
        null,
        2,
      ),
    );
    if (error.evidence) {
      console.error(JSON.stringify(error.evidence, null, 2));
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
