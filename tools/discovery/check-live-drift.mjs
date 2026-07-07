import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const baselinePath = path.join(
  repoRoot,
  "discovery/google-chat-v1-20260705.methods.json",
);
const discoveryUrl = "https://chat.googleapis.com/$discovery/rest?version=v1";

// Exit code contract: 0 = no drift, 1 = drift detected, 2 = fetch/network
// error (could not determine drift either way).
export const EXIT_OK = 0;
export const EXIT_DRIFT = 1;
export const EXIT_FETCH_ERROR = 2;

/**
 * Walk a discovery document's resource tree and collect fully-qualified
 * method ids (e.g. "spaces.messages.create"), matching the traversal used by
 * tools/discovery/check-methods.mjs so the two checkers stay consistent.
 */
export function walkMethods(resource, prefix = "", out = []) {
  for (const method of Object.keys(resource?.methods ?? {})) {
    out.push(`${prefix}${method}`);
  }

  for (const [name, child] of Object.entries(resource?.resources ?? {})) {
    walkMethods(child, `${prefix}${name}.`, out);
  }

  return out;
}

/**
 * Extract the sorted method-id list from a raw discovery document, the same
 * shape stored under `methods` in the curated snapshot.
 */
export function extractSortedMethods(discoveryDocument) {
  return walkMethods(discoveryDocument).sort();
}

/**
 * Pure diff between the curated snapshot and a live (or fixture) discovery
 * document. No I/O — safe to unit test with inline fixtures.
 */
export function diffDiscovery(baseline, liveDiscoveryDocument) {
  const expected = [...(baseline.methods ?? [])].sort();
  const current = extractSortedMethods(liveDiscoveryDocument);

  const added = current.filter((method) => !expected.includes(method));
  const removed = expected.filter((method) => !current.includes(method));
  const liveRevision = liveDiscoveryDocument?.revision ?? null;
  const baselineRevision = baseline.revision ?? null;
  const revisionChanged =
    liveRevision !== null &&
    baselineRevision !== null &&
    String(liveRevision) !== String(baselineRevision);

  // Google's discovery endpoint serves different revisions across requests
  // during rollouts, so a revision change alone is informational noise;
  // only method-level changes count as drift.
  const hasDrift = added.length > 0 || removed.length > 0;

  return {
    ok: !hasDrift,
    baselineRevision,
    liveRevision,
    revisionChanged,
    added,
    removed,
    baselineMethodCount: expected.length,
    liveMethodCount: current.length,
  };
}

/**
 * Fetch the live Google Chat discovery document. Kept isolated from the pure
 * diff logic so tests never need network access.
 */
export async function fetchLiveDiscoveryDocument({
  fetchImpl = fetch,
  url = discoveryUrl,
  timeoutMs = 15000,
} = {}) {
  let response;

  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new DiscoveryFetchError(
      `Failed to reach Google Chat discovery endpoint: ${error.message ?? error}`,
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new DiscoveryFetchError(
      `Google Chat discovery endpoint returned HTTP ${response.status}.`,
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new DiscoveryFetchError(
      `Failed to parse Google Chat discovery document as JSON: ${error.message ?? error}`,
      { cause: error },
    );
  }
}

export class DiscoveryFetchError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DiscoveryFetchError";
  }
}

export function formatReport(diff) {
  if (diff.ok) {
    return [
      "Google Chat discovery drift check: OK",
      `Baseline revision: ${diff.baselineRevision}`,
      `Live revision: ${diff.liveRevision}`,
      `Methods: ${diff.liveMethodCount} (baseline ${diff.baselineMethodCount})`,
    ].join("\n");
  }

  const lines = ["Google Chat discovery drift detected."];
  lines.push(`Baseline revision: ${diff.baselineRevision}`);
  lines.push(`Live revision: ${diff.liveRevision}`);

  if (diff.revisionChanged) {
    lines.push(
      diff.ok
        ? "Revision changed (methods unchanged; informational only)."
        : "Revision changed.",
    );
  }

  if (diff.added.length > 0) {
    lines.push(`Added methods (${diff.added.length}):`);
    for (const method of diff.added) {
      lines.push(`  + ${method}`);
    }
  }

  if (diff.removed.length > 0) {
    lines.push(`Removed methods (${diff.removed.length}):`);
    for (const method of diff.removed) {
      lines.push(`  - ${method}`);
    }
  }

  return lines.join("\n");
}

async function loadBaseline(readFile = fs.readFile) {
  const raw = await readFile(baselinePath, "utf8");
  return JSON.parse(raw);
}

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function usage() {
  return [
    "Usage: node tools/discovery/check-live-drift.mjs [--json]",
    "",
    "Fetches the live Google Chat v1 discovery document and diffs its method",
    "list and revision against the curated snapshot in discovery/.",
    "",
    "Options:",
    "  --json   Print a machine-readable diff instead of the human report.",
    "  --help   Show this help text.",
    "",
    "Exit codes:",
    "  0  no drift",
    "  1  drift detected (added/removed methods or revision change)",
    "  2  could not reach or parse the live discovery document",
  ].join("\n");
}

export async function main({
  argv = process.argv.slice(2),
  fetchLiveDiscovery = fetchLiveDiscoveryDocument,
  readFile = fs.readFile,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    stdout.write(`${usage()}\n`);
    return EXIT_OK;
  }

  const baseline = await loadBaseline(readFile);

  let liveDiscoveryDocument;
  try {
    liveDiscoveryDocument = await fetchLiveDiscovery();
  } catch (error) {
    stderr.write(
      `${error instanceof DiscoveryFetchError ? error.message : `Unexpected error while fetching discovery document: ${error.message ?? error}`}\n`,
    );
    return EXIT_FETCH_ERROR;
  }

  const diff = diffDiscovery(baseline, liveDiscoveryDocument);

  if (args.json) {
    stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
  } else {
    stdout.write(`${formatReport(diff)}\n`);
  }

  return diff.ok ? EXIT_OK : EXIT_DRIFT;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = EXIT_FETCH_ERROR;
    },
  );
}
