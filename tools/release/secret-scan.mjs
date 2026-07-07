import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const defaultRoot = path.resolve(import.meta.dirname, "../..");
const privateKeyBlockPattern = ["-----BEGIN ", "(?:RSA |EC |OPENSSH )?", "PRIVATE KEY-----"].join("");
const serviceAccountPrivateKeyPattern = [
  '"private_key"\\s*:\\s*"',
  "-----BEGIN ",
  "PRIVATE KEY-----",
].join("");

const patterns = [
  {
    name: "private key block",
    regex: new RegExp(privateKeyBlockPattern),
  },
  {
    name: "Google service account private key",
    regex: new RegExp(serviceAccountPrivateKeyPattern),
  },
  {
    name: "Google API key",
    regex: /AIza[0-9A-Za-z_-]{35}/,
  },
  {
    name: "Google OAuth access token",
    regex: /ya29\.[0-9A-Za-z_-]+/,
  },
  {
    name: "OpenAI API key",
    regex: /sk-(?:proj-)?[0-9A-Za-z_-]{20,}/,
  },
  {
    name: "GitHub token",
    regex: /gh[pousr]_[0-9A-Za-z_]{30,}/,
  },
];

function runGit(args, root = defaultRoot) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }

  return result.stdout;
}

export function scanSecretFiles({ root, files }) {
  const entries = [];

  for (const file of files) {
    const absolute = path.join(root, file);
    let buffer;
    try {
      buffer = fs.readFileSync(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    entries.push({ file, buffer });
  }

  return scanSecretFileEntries({ entries });
}

export function scanSecretFileEntries({ entries }) {
  const findings = [];

  for (const { file, buffer } of entries) {
    if (buffer.includes(0)) {
      continue;
    }

    const text = buffer.toString("utf8");
    for (const pattern of patterns) {
      if (pattern.regex.test(text)) {
        findings.push(`${file}: ${pattern.name}`);
      }
    }
  }

  return findings;
}

export function listSecretScanFiles(root = defaultRoot) {
  return runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root)
    .split("\0")
    .filter(Boolean);
}

export function runSecretScan(root = defaultRoot) {
  const files = listSecretScanFiles(root);
  return {
    files,
    findings: scanSecretFiles({ root, files }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { files, findings } = runSecretScan();

  if (findings.length > 0) {
    console.error("Potential secrets found in tracked files:");
    findings.forEach((finding) => console.error(`- ${finding}`));
    process.exit(1);
  }

  console.log(`Secret scan passed for ${files.length} tracked and untracked non-ignored files.`);
}
