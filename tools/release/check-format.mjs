import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const defaultRoot = path.resolve(import.meta.dirname, "../..");

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

export function checkFormatFiles({ root, files }) {
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

  return checkFormatFileEntries({ entries });
}

export function checkFormatFileEntries({ entries }) {
  const failures = [];

  for (const { file, buffer } of entries) {
    if (buffer.includes(0)) {
      continue;
    }

    const text = buffer.toString("utf8");
    const extension = path.extname(file).toLowerCase();

    if (text.includes("\r\n")) {
      failures.push(`${file}: uses CRLF line endings`);
    }

    if (text.length > 0 && !text.endsWith("\n")) {
      failures.push(`${file}: missing final newline`);
    }

    if (extension !== ".md") {
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        if (/[ \t]+$/.test(line)) {
          failures.push(`${file}:${index + 1}: trailing whitespace`);
        }
      });
    }
  }

  return failures;
}

export function listFormatFiles(root = defaultRoot) {
  const rawFiles = runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root);
  return rawFiles.split("\0").filter(Boolean);
}

export function runFormatCheck(root = defaultRoot) {
  const files = listFormatFiles(root);
  return {
    files,
    failures: checkFormatFiles({ root, files }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { files, failures } = runFormatCheck();

  if (failures.length > 0) {
    console.error("Format check failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }

  console.log(`Format check passed for ${files.length} tracked and untracked non-ignored files.`);
}
