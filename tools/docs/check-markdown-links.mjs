import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const ignoredDirectories = new Set([
  ".git",
  "dist",
  "node_modules",
  "__pycache__",
]);

function walk(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...walk(path.join(directory, entry.name)));
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path.join(directory, entry.name));
    }
  }

  return files;
}

function isExternalTarget(target) {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(target) ||
    target.startsWith("#") ||
    target.length === 0
  );
}

function normalizedTarget(target) {
  const withoutAnchor = target.split("#", 1)[0];
  const withoutQuery = withoutAnchor.split("?", 1)[0];
  return withoutQuery.replace(/^<|>$/g, "");
}

function lineNumberFor(content, index) {
  return content.slice(0, index).split("\n").length;
}

const markdownLinkPattern = /!?\[[^\]]*]\(([^)\n]+)\)/g;
const errors = [];

for (const file of walk(root)) {
  const content = fs.readFileSync(file, "utf8");
  const relativeFile = path.relative(root, file);

  for (const match of content.matchAll(markdownLinkPattern)) {
    const rawTarget = match[1].trim();

    if (isExternalTarget(rawTarget)) {
      continue;
    }

    const target = normalizedTarget(rawTarget);
    if (!target) {
      continue;
    }

    const resolved = path.resolve(path.dirname(file), target);
    if (!fs.existsSync(resolved)) {
      errors.push(
        `${relativeFile}:${lineNumberFor(content, match.index)} missing ${rawTarget}`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log("Markdown links ok");
