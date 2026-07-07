import fs from "node:fs/promises";
import path from "node:path";

const root = new URL("../../", import.meta.url);
const baselinePath = path.join(
  root.pathname,
  "discovery/google-chat-v1-20260705.methods.json",
);

function walkMethods(resource, prefix = "", out = []) {
  for (const method of Object.keys(resource.methods ?? {})) {
    out.push(`${prefix}${method}`);
  }

  for (const [name, child] of Object.entries(resource.resources ?? {})) {
    walkMethods(child, `${prefix}${name}.`, out);
  }

  return out;
}

const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
const response = await fetch("https://chat.googleapis.com/$discovery/rest?version=v1");

if (!response.ok) {
  throw new Error(`Failed to fetch discovery document: ${response.status}`);
}

const discovery = await response.json();
const current = walkMethods(discovery).sort();
const expected = [...baseline.methods].sort();

const missing = expected.filter((method) => !current.includes(method));
const added = current.filter((method) => !expected.includes(method));

if (missing.length || added.length) {
  console.error("Google Chat discovery method drift detected.");
  console.error(JSON.stringify({ revision: discovery.revision, missing, added }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      revision: discovery.revision,
      methods: current.length,
    },
    null,
    2,
  ),
);
