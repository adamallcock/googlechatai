import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const intentionalNodeOnly = new Map([
  [
    "expressAdapter",
    "Node-only Express adapter; Python exposes framework-native router primitives.",
  ],
  [
    "createChatRequestVerifier",
    "Node-only fetch Request adapter; Python callers verify headers with verify_chat_request_authorization or a verifier object.",
  ],
]);

// GoogleChatAI router method surface: intentional per-language differences.
// Keep these in sync with packages/node/src/router/runtime.ts and
// packages/python/src/googlechatai/router/runtime.py.
const intentionalNodeRouterOnly = new Map([
  [
    "fetch",
    "Node-only Fetch API HTTP entrypoint; Python callers use dispatch/dispatch_async directly.",
  ],
  [
    "handlePayload",
    "Node-only raw-payload entrypoint used by fetch(); Python callers use dispatch/dispatch_async directly.",
  ],
  [
    "handleEvent",
    "Node-only normalized-event entrypoint used by fetch()/handlePayload(); Python callers use dispatch/dispatch_async directly.",
  ],
  [
    "use",
    "Node-only Express-style middleware registration; Python has no middleware chain equivalent.",
  ],
]);

const intentionalPythonRouterOnly = new Map([
  [
    "dispatch",
    "Python synchronous local-dispatch entrypoint; Node's single fetch/handlePayload/handleEvent chain is already async.",
  ],
  [
    "dispatch_async",
    "Python asyncio local-dispatch entrypoint; Node's single fetch/handlePayload/handleEvent chain is already async.",
  ],
]);

const intentionalPythonOnly = new Map([
  ["AsyncResponseQueue", "Python queue protocol; the Node interface is a type-only export."],
  ["ChatResponse", "Python router response type."],
  ["GoogleChatTokenVerifier", "Python verifier class; the Node interface is a type-only export."],
  ["TokenRecord", "Python token record dataclass; the Node interface is a type-only export."],
  ["TokenStore", "Python token store protocol; the Node interface is a type-only export."],
  ["astream_chat_reply", "Python asyncio streaming driver variant; Node's single driver is already async."],
  ["DuplicateEventGuardResult", "Python transport dataclass."],
  ["HandlerContext", "Python router context type."],
  ["IdempotencyClaim", "Python transport dataclass."],
  ["IdempotencyStore", "Python structural protocol; Node exports this as a type only."],
  ["FirestoreTransport", "Python Firestore transport type alias; Node exports this as a type only."],
  ["ReplyBuilder", "Python router helper type."],
  ["RetryDecision", "Python transport dataclass."],
  ["RetryDecisionInput", "Python transport type alias."],
  ["RetryPolicyOptions", "Python transport dataclass."],
  ["RetryingChatClient", "Python retrying client wrapper."],
  ["RetryingJsonResponse", "Python retry response type."],
]);

const explicitNodeToPython = new Map([
  ["createOpenAITranscriptionProvider", "create_openai_transcription_provider"],
  ["createPubSubPushVerifier", "create_pubsub_push_verifier"],
  ["parsePubSubPullPayload", "parse_pubsub_pull_payload"],
  ["parsePubSubPushPayload", "parse_pubsub_push_payload"],
]);

function stripComments(value) {
  return value.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

export function nodeValueExports() {
  const source = fs.readFileSync(path.join(root, "packages/node/src/index.ts"), "utf8");
  const exports = [];
  const exportBlockPattern = /export\s*\{([\s\S]*?)\}\s*from\s*["'][^"']+["'];/g;

  for (const match of source.matchAll(exportBlockPattern)) {
    const block = stripComments(match[1]);
    for (const rawName of block.split(",")) {
      const name = rawName.trim();
      if (!name) {
        continue;
      }
      const exported = name.split(/\s+as\s+/).at(-1)?.trim();
      if (exported) {
        exports.push(exported);
      }
    }
  }

  return [...new Set(exports)].sort();
}

export function pythonExports() {
  const code = `
import json
import googlechatai
print(json.dumps(sorted(googlechatai.__all__)))
`;
  return JSON.parse(
    execFileSync("python3", ["-c", code], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONPATH: path.join(root, "packages/python/src"),
      },
    }),
  );
}

export function camelToSnake(name) {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function expectedPythonExport(nodeName) {
  if (explicitNodeToPython.has(nodeName)) {
    return explicitNodeToPython.get(nodeName);
  }
  if (/^[A-Z0-9_]+$/.test(nodeName) || /^[A-Z]/.test(nodeName)) {
    return nodeName;
  }
  return camelToSnake(nodeName);
}

// Class-body member lines that are never public API surface, keyed by the
// leading token(s) node uses for non-public/non-method class members.
const NON_PUBLIC_MEMBER_PATTERN = /^(private|protected|public|static|get\s|set\s|#|readonly\s)/;
const ROUTER_EXCLUDED_MEMBER_NAMES = new Set(["constructor"]);

/**
 * Extract the `export class GoogleChatAI ... }` body from Node router
 * source text by locating the class opening brace and then walking forward
 * with brace-depth counting to find the matching close, so nested braces in
 * method bodies (control flow, object literals, etc.) don't truncate the
 * body early.
 */
export function extractNodeRouterClassBody(
  source,
  className = "GoogleChatAI",
) {
  const classPattern = new RegExp(`export class ${className}[\\s\\S]*?\\{`);
  const startMatch = source.match(classPattern);
  if (!startMatch) {
    throw new Error(`Could not find "export class ${className} ... {" in Node router source.`);
  }

  const bodyStart = startMatch.index + startMatch[0].length;
  let depth = 1;
  let i = bodyStart;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      depth--;
    }
  }

  if (depth !== 0) {
    throw new Error(`Could not find the matching closing brace for class ${className}.`);
  }

  return source.slice(bodyStart, i - 1);
}

/**
 * Parse public method names directly out of a class body's source text.
 * Matches method declaration lines at exactly 2-space (direct member)
 * indentation, e.g. `  onMention(handler: ChatHandler): this {` or
 * `  async fetch(request: Request): Promise<Response> {`. Excludes:
 *  - `private`/`protected`/`public`/`static`/`readonly` members and fields
 *  - `#`-prefixed private members
 *  - `get `/`set ` accessors
 *  - the constructor
 *  - lines indented deeper than the direct class body (method-body internals)
 * Overload signature lines (declarations ending in `;` instead of `{`) are
 * naturally deduplicated by name since they share a name with their
 * implementation line.
 */
export function parsePublicClassMethodNames(classBody) {
  const methodNames = new Set();

  for (const line of classBody.split(/\r?\n/)) {
    if (!/^ {2}\S/.test(line)) {
      // Not a direct class member line (either blank, or indented deeper as
      // part of a method body / wrapped parameter list continuation).
      continue;
    }

    let trimmed = line.trim();
    if (NON_PUBLIC_MEMBER_PATTERN.test(trimmed)) {
      continue;
    }

    // `async` is a legitimate public-method modifier (unlike the modifiers
    // above), so strip it before matching the method identifier.
    trimmed = trimmed.replace(/^async\s+/, "");

    const match = trimmed.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*[(<]/);
    if (!match) {
      continue;
    }

    const name = match[1];
    if (ROUTER_EXCLUDED_MEMBER_NAMES.has(name)) {
      continue;
    }

    methodNames.add(name);
  }

  return methodNames;
}

export function nodeRouterMethods() {
  const source = fs.readFileSync(
    path.join(root, "packages/node/src/router/runtime.ts"),
    "utf8",
  );
  const classBody = extractNodeRouterClassBody(source);
  return [...parsePublicClassMethodNames(classBody)].sort();
}

export function pythonRouterMethods() {
  const code = `
import json
import googlechatai
cls = googlechatai.GoogleChatAI
names = [name for name in dir(cls) if not name.startswith("_") and callable(getattr(cls, name))]
print(json.dumps(sorted(names)))
`;
  return JSON.parse(
    execFileSync("python3", ["-c", code], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONPATH: path.join(root, "packages/python/src"),
      },
    }),
  );
}

const explicitNodeRouterToPython = new Map();

function expectedPythonRouterMethod(nodeName) {
  if (explicitNodeRouterToPython.has(nodeName)) {
    return explicitNodeRouterToPython.get(nodeName);
  }
  return camelToSnake(nodeName);
}

/**
 * Compare the Node and Python GoogleChatAI router public method surfaces.
 * Pure function over already-collected name lists so it is unit-testable
 * without shelling out to python3 or reading real source files.
 */
export function compareRouterMethods({ nodeMethods, pythonMethods }) {
  const pythonMethodSet = new Set(pythonMethods);
  const expectedPythonMethods = new Set(
    nodeMethods
      .filter((name) => !intentionalNodeRouterOnly.has(name))
      .map(expectedPythonRouterMethod),
  );
  const routerMissingPython = [...expectedPythonMethods]
    .filter((name) => !pythonMethodSet.has(name))
    .sort();
  const routerMissingNode = [...pythonMethodSet]
    .filter((name) => !expectedPythonMethods.has(name))
    .filter((name) => !intentionalPythonRouterOnly.has(name))
    .sort();

  return { routerMissingPython, routerMissingNode };
}

export function main() {
  const asJson = process.argv.includes("--json");
  const nodeExports = nodeValueExports();
  const pythonExportSet = new Set(pythonExports());
  const expectedPythonExports = new Set(
    nodeExports
      .filter((name) => !intentionalNodeOnly.has(name))
      .map(expectedPythonExport),
  );
  const missingPython = [...expectedPythonExports]
    .filter((name) => !pythonExportSet.has(name))
    .sort();
  const missingNode = [...pythonExportSet]
    .filter((name) => !expectedPythonExports.has(name))
    .filter((name) => !intentionalPythonOnly.has(name))
    .sort();

  const { routerMissingPython, routerMissingNode } = compareRouterMethods({
    nodeMethods: nodeRouterMethods(),
    pythonMethods: pythonRouterMethods(),
  });

  const payload = {
    ok:
      missingPython.length === 0 &&
      missingNode.length === 0 &&
      routerMissingPython.length === 0 &&
      routerMissingNode.length === 0,
    missingPython,
    missingNode,
    intentionalNodeOnly: Object.fromEntries(intentionalNodeOnly),
    intentionalPythonOnly: Object.fromEntries(intentionalPythonOnly),
    routerMissingPython,
    routerMissingNode,
    intentionalNodeRouterOnly: Object.fromEntries(intentionalNodeRouterOnly),
    intentionalPythonRouterOnly: Object.fromEntries(intentionalPythonRouterOnly),
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (payload.ok) {
    console.log("SDK export parity passed.");
  } else {
    console.error(JSON.stringify(payload, null, 2));
  }

  process.exitCode = payload.ok ? 0 : 1;
  return payload;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
