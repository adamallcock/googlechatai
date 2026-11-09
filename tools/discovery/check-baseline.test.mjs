import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { baselinePath, diffDiscovery, canonicalReachableSchema } from "./check-live-drift.mjs";
import { main, validateBaseline } from "./check-baseline.mjs";

const root = new URL("../../", import.meta.url);
const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
const sourceBytes = await fs.readFile(new URL(baseline.sourceFile, root));

test("reviewed baseline reproduces pinned source signatures without network access", async () => {
  assert.equal(validateBaseline(baseline, sourceBytes).ok, true);
  assert.equal(await main({ stdout: { write() {} } }), 0);
});

test("baseline integrity rejects altered hashes, provenance, revisions, or methods", () => {
  for (const changes of [
    { sourceSha256: "0".repeat(64) },
    { source: "https://chat.googleapis.com/$discovery/rest?version=v1" },
    { revision: "20260920" },
    { signatureVersion: 1 },
    { methods: [...baseline.methods, baseline.methods[0]] },
    { methods: [] },
    { methodSignatures: {} },
    { methodSignatures: { ...baseline.methodSignatures, unexpected: "0".repeat(64) } },
  ]) {
    assert.equal(validateBaseline({ ...baseline, ...changes }, sourceBytes).ok, false);
  }
  assert.equal(validateBaseline(baseline, Buffer.concat([sourceBytes, Buffer.from("\n")])).ok, false);
});

test("ordinary CI checks local evidence while weekly/manual drift still fails on live changes", async () => {
  const ci = await fs.readFile(new URL(".github/workflows/ci.yml", root), "utf8");
  assert.match(ci, /run: node tools\/discovery\/check-baseline\.mjs/);
  assert.doesNotMatch(ci, /discovery:check|check-live-drift\.mjs|check-methods\.mjs/);
  const weekly = await fs.readFile(new URL(".github/workflows/discovery-drift.yml", root), "utf8");
  assert.match(weekly, /schedule:/);
  assert.match(weekly, /workflow_dispatch:/);
  assert.match(weekly, /node tools\/discovery\/check-live-drift\.mjs/);
  assert.match(weekly, /elif \[ "\$\{exit_code\}" -eq 1 \]; then[\s\S]*?exit 1/);
  assert.doesNotMatch(weekly, /continue-on-error:/);
  const document = JSON.parse(sourceBytes);
  document.schemas.Citation.properties.id.type = "integer";
  assert.equal(diffDiscovery(baseline, document).ok, false);
});

test("schema prose filtering preserves actual properties named id, title, and annotations", () => {
  const schemas = {
    Message: {
      id: "Message",
      description: "Prose",
      type: "object",
      properties: {
        id: { type: "string", description: "Prose" },
        title: { type: "string" },
        annotations: { type: "array", items: { $ref: "Annotation" } },
        description: { type: "string" },
      },
    },
    Annotation: { type: "object", properties: { type: { type: "string" } } },
  };
  const canonical = canonicalReachableSchema({ $ref: "Message" }, schemas);
  assert.equal(canonical.resolved.id, undefined);
  assert.equal(canonical.resolved.description, undefined);
  assert.equal(canonical.resolved.properties.id.type, "string");
  assert.equal(canonical.resolved.properties.id.description, undefined);
  assert.equal(canonical.resolved.properties.title.type, "string");
  assert.equal(canonical.resolved.properties.description.type, "string");
  assert.equal(canonical.resolved.properties.annotations.items.resolved.type, "object");
  const changed = structuredClone(schemas);
  changed.Annotation.properties.type.type = "integer";
  assert.notDeepEqual(canonical, canonicalReachableSchema({ $ref: "Message" }, changed));
});
