import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { baselinePath, diffDiscovery } from "./check-live-drift.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Validate reviewed local evidence without fetching a moving upstream target. */
export function validateBaseline(baseline, sourceBytes) {
  const document = JSON.parse(sourceBytes.toString());
  const errors = [];
  const sha256 = crypto.createHash("sha256").update(sourceBytes).digest("hex");
  if (baseline.sourceSha256 !== sha256) errors.push("Source SHA-256 mismatch.");
  if (baseline.signatureVersion !== 2) errors.push("Unsupported signature version.");
  if (baseline.api !== "google-chat" || baseline.version !== "v1" || document.id !== "chat:v1") {
    errors.push("Expected a Google Chat v1 baseline and discovery document.");
  }
  if (baseline.revision !== document.revision) errors.push("Source revision mismatch.");
  if (!/^https:\/\/raw\.githubusercontent\.com\/googleapis\/discovery-artifact-manager\/[a-f0-9]{40}\/discoveries\/chat\.v1\.json$/.test(baseline.source ?? "")) {
    errors.push("Source must identify an immutable upstream commit.");
  }
  const methods = baseline.methods ?? [];
  if (methods.length === 0 || JSON.stringify(methods) !== JSON.stringify([...new Set(methods)].sort())) {
    errors.push("Baseline methods must be nonempty, sorted, and unique.");
  }
  const diff = diffDiscovery(baseline, document);
  if (!diff.ok) errors.push("Method signatures do not match the reviewed source.");
  return { ok: errors.length === 0, errors, diff };
}

export async function main({ readFile = fs.readFile, stdout = process.stdout } = {}) {
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const sourceBytes = await readFile(path.join(repoRoot, baseline.sourceFile));
  const review = await readFile(path.join(repoRoot, baseline.review), "utf8");
  const result = validateBaseline(baseline, sourceBytes);
  if (!review.startsWith("---\n")) {
    result.errors.push("Review must include YAML frontmatter.");
    result.ok = false;
  }
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (exitCode) => { process.exitCode = exitCode; },
    (error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
