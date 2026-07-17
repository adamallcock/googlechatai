import fs from "node:fs/promises";
import crypto from "node:crypto";
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

/** Walk the resource tree while retaining each discovery method definition. */
export function walkMethodEntries(resource, prefix = "", out = {}) {
  for (const [name, method] of Object.entries(resource?.methods ?? {})) {
    out[`${prefix}${name}`] = method;
  }

  for (const [name, child] of Object.entries(resource?.resources ?? {})) {
    walkMethodEntries(child, `${prefix}${name}.`, out);
  }

  return out;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function canonicalParameter(parameter) {
  const raw = record(parameter);
  return {
    location: stringOrNull(raw.location),
    required: raw.required === true,
    type: stringOrNull(raw.type),
    format: stringOrNull(raw.format),
    repeated: raw.repeated === true,
    pattern: stringOrNull(raw.pattern),
    enum: Array.isArray(raw.enum)
      ? raw.enum.filter((value) => typeof value === "string").sort()
      : [],
    default: raw.default ?? null,
  };
}

const DISCOVERY_PROSE_KEYS = new Set([
  "annotations",
  "description",
  "documentationLink",
  "enumDescriptions",
  "id",
  "title",
]);

/**
 * Canonicalize a reachable discovery schema rather than merely hashing a
 * `$ref` name. Google can change a field's enum, requiredness, or nested type
 * without changing the method's top-level request/response reference.
 */
export function canonicalReachableSchema(value, schemas = {}, resolving = new Set()) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalReachableSchema(item, schemas, resolving));
  }
  if (!value || typeof value !== "object") {
    return value ?? null;
  }

  const raw = record(value);
  const ref = stringOrNull(raw.$ref);
  const own = Object.fromEntries(
    Object.entries(raw)
      .filter(([key]) => !DISCOVERY_PROSE_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [
        key,
        key === "$ref"
          ? item
          : canonicalReachableSchema(item, schemas, resolving),
      ]),
  );

  if (!ref) {
    return own;
  }
  if (resolving.has(ref)) {
    return { ...own, resolved: { $ref: ref, cycle: true } };
  }
  const target = record(schemas[ref]);
  if (Object.keys(target).length === 0) {
    return { ...own, resolved: null };
  }
  const nextResolving = new Set(resolving);
  nextResolving.add(ref);
  return {
    ...own,
    resolved: canonicalReachableSchema(target, schemas, nextResolving),
  };
}

/**
 * Stable subset of a discovery method's request contract. Descriptions and
 * generated prose are intentionally excluded so doc-only changes do not make
 * the release gate noisy, while HTTP/path/parameter/request/response changes
 * do.
 */
export function canonicalMethodSignature(method, schemas = {}) {
  const raw = record(method);
  const parameters = record(raw.parameters);
  return {
    id: stringOrNull(raw.id),
    httpMethod: stringOrNull(raw.httpMethod),
    path: stringOrNull(raw.path),
    flatPath: stringOrNull(raw.flatPath),
    parameterOrder: Array.isArray(raw.parameterOrder)
      ? raw.parameterOrder.filter((value) => typeof value === "string")
      : [],
    parameters: Object.fromEntries(
      Object.entries(parameters)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, parameter]) => [name, canonicalParameter(parameter)]),
    ),
    requestRef: stringOrNull(record(raw.request).$ref),
    responseRef: stringOrNull(record(raw.response).$ref),
    requestContract: canonicalReachableSchema(record(raw.request), schemas),
    responseContract: canonicalReachableSchema(record(raw.response), schemas),
    scopes: Array.isArray(raw.scopes)
      ? raw.scopes.filter((value) => typeof value === "string").sort()
      : [],
    mediaUpload: {
      accept: Array.isArray(record(raw.mediaUpload).accept)
        ? record(raw.mediaUpload).accept.filter((value) => typeof value === "string").sort()
        : [],
      maxSize: stringOrNull(record(raw.mediaUpload).maxSize),
      simplePath: stringOrNull(record(record(raw.mediaUpload).protocols).simple?.path),
      resumablePath: stringOrNull(record(record(raw.mediaUpload).protocols).resumable?.path),
    },
  };
}

export function methodSignatureHash(method, schemas = {}) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalMethodSignature(method, schemas)))
    .digest("hex");
}

export function extractMethodSignatures(discoveryDocument) {
  const schemas = record(discoveryDocument?.schemas);
  return Object.fromEntries(
    Object.entries(walkMethodEntries(discoveryDocument))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, method]) => [name, methodSignatureHash(method, schemas)]),
  );
}

/**
 * Extract the sorted method-id list from a raw discovery document, the same
 * shape stored under `methods` in the curated snapshot.
 */
export function extractSortedMethods(discoveryDocument) {
  return Object.keys(extractMethodSignatures(discoveryDocument));
}

/**
 * Pure diff between the curated snapshot and a live (or fixture) discovery
 * document. No I/O — safe to unit test with inline fixtures.
 */
export function diffDiscovery(baseline, liveDiscoveryDocument) {
  const expected = [...(baseline.methods ?? [])].sort();
  const current = extractSortedMethods(liveDiscoveryDocument);
  const currentSignatures = extractMethodSignatures(liveDiscoveryDocument);
  const baselineSignatures = record(baseline.methodSignatures);

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
  const changed = expected
    .filter((method) => current.includes(method) && baselineSignatures[method] !== undefined)
    .filter((method) => baselineSignatures[method] !== currentSignatures[method])
    .map((method) => ({
      method,
      baselineSignature: baselineSignatures[method],
      liveSignature: currentSignatures[method],
    }));
  const missingBaselineSignatures = expected.filter(
    (method) => typeof baselineSignatures[method] !== "string",
  );
  const unexpectedBaselineSignatures = Object.keys(baselineSignatures)
    .filter((method) => !expected.includes(method))
    .sort();
  const hasDrift =
    added.length > 0 ||
    removed.length > 0 ||
    changed.length > 0 ||
    missingBaselineSignatures.length > 0 ||
    unexpectedBaselineSignatures.length > 0;

  return {
    ok: !hasDrift,
    baselineRevision,
    liveRevision,
    revisionChanged,
    added,
    removed,
    changed,
    missingBaselineSignatures,
    unexpectedBaselineSignatures,
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

  if (diff.changed.length > 0) {
    lines.push(`Changed method signatures (${diff.changed.length}):`);
    for (const change of diff.changed) {
      lines.push(`  ~ ${change.method}`);
    }
  }

  if (diff.missingBaselineSignatures.length > 0) {
    lines.push(
      `Baseline methods missing signatures (${diff.missingBaselineSignatures.length}):`,
    );
    for (const method of diff.missingBaselineSignatures) {
      lines.push(`  ! ${method}`);
    }
  }

  if (diff.unexpectedBaselineSignatures.length > 0) {
    lines.push(
      `Baseline signatures without a declared method (${diff.unexpectedBaselineSignatures.length}):`,
    );
    for (const method of diff.unexpectedBaselineSignatures) {
      lines.push(`  ! ${method}`);
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
    "list and request-contract signatures against the curated snapshot in discovery/.",
    "",
    "Options:",
    "  --json   Print a machine-readable diff instead of the human report.",
    "  --help   Show this help text.",
    "",
    "Exit codes:",
    "  0  no drift",
    "  1  drift detected (added/removed methods or changed method signatures)",
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
