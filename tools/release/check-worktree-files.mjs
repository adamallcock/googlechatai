import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { checkFormatFileEntries } from "./check-format.mjs";
import { scanSecretFileEntries } from "./secret-scan.mjs";

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

export function listWorktreeFiles(root = defaultRoot) {
  return runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root)
    .split("\0")
    .filter(Boolean);
}

export function readWorktreeFileEntries({ root, files }) {
  const entries = [];

  for (const entry of iterateReadableWorktreeFileEntries({ root, files })) {
    entries.push(entry);
  }

  return entries;
}

export function* iterateReadableWorktreeFileEntries({ root, files }) {
  for (const file of files) {
    const absolute = path.join(root, file);
    try {
      yield { file, buffer: fs.readFileSync(absolute) };
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
}

export function runWorktreeFileChecks(root = defaultRoot, files = listWorktreeFiles(root)) {
  let readableCount = 0;
  const formatFailures = [];
  const secretFindings = [];

  for (const entry of iterateReadableWorktreeFileEntries({ root, files })) {
    readableCount += 1;
    formatFailures.push(...checkFormatFileEntries({ entries: [entry] }));
    secretFindings.push(...scanSecretFileEntries({ entries: [entry] }));
  }

  return {
    files,
    readableCount,
    formatFailures,
    secretFindings,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { files, readableCount, formatFailures, secretFindings } = runWorktreeFileChecks();

  if (formatFailures.length > 0 || secretFindings.length > 0) {
    if (formatFailures.length > 0) {
      console.error("Format check failed:");
      formatFailures.forEach((failure) => console.error(`- ${failure}`));
    }
    if (secretFindings.length > 0) {
      console.error("Potential secrets found in tracked files:");
      secretFindings.forEach((finding) => console.error(`- ${finding}`));
    }
    process.exit(1);
  }

  console.log(
    `Worktree file checks passed for ${files.length} tracked and untracked non-ignored files (${readableCount} readable).`,
  );
}
