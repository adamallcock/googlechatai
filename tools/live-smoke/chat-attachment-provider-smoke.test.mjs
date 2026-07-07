import assert from "node:assert/strict";
import test from "node:test";

import {
  loadAttachmentProviderSmokeConfig,
  runAttachmentProviderSmoke,
} from "./chat-attachment-provider-smoke.mjs";

test("loadAttachmentProviderSmokeConfig supports stable run ids and skip-python", () => {
  const config = loadAttachmentProviderSmokeConfig({
    argv: [
      "node",
      "chat-attachment-provider-smoke.mjs",
      "--run-id=attachment-provider-test",
      "--skip-python",
    ],
    env: {},
  });

  assert.equal(config.runId, "attachment-provider-test");
  assert.equal(config.skipPython, true);
  assert.equal(config.fixturePath.endsWith("fixtures/attachments/context-tree.json"), true);
});

test("loadAttachmentProviderSmokeConfig rejects missing option values", () => {
  assert.throws(
    () =>
      loadAttachmentProviderSmokeConfig({
        argv: ["node", "chat-attachment-provider-smoke.mjs", "--fixture"],
        env: {},
      }),
    /--fixture requires a value/,
  );
});

test("runAttachmentProviderSmoke verifies Node provider hooks with redacted evidence", async () => {
  const config = loadAttachmentProviderSmokeConfig({
    argv: [
      "node",
      "chat-attachment-provider-smoke.mjs",
      "--run-id=attachment-provider-test",
      "--skip-python",
    ],
    env: {},
  });

  const result = await runAttachmentProviderSmoke(config, { writeEvidence: false });
  const serialized = JSON.stringify(result.evidence);

  assert.equal(result.ok, true);
  assert.equal(result.evidence.assertions.node.pdfParserPartial, true);
  assert.equal(result.evidence.assertions.node.imageParserComplete, true);
  assert.equal(result.evidence.assertions.node.transcriptionDisabledByDefault, true);
  assert.equal(result.evidence.assertions.node.noProviderBlocked, true);
  assert.equal(result.evidence.assertions.node.openaiComplete, true);
  assert.equal(result.evidence.assertions.node.geminiComplete, true);
  assert.equal(result.evidence.assertions.node.contextSystemNotesFirst, true);
  assert.equal(
    result.evidence.assertions.node.providerClientsCalledWithExplicitKeys,
    true,
  );
  assert.equal(result.evidence.privacy.externalProviderCallsMade, false);
  assert.equal(result.evidence.privacy.rawApiKeysSaved, false);
  assert.equal(result.evidence.privacy.rawTranscriptionTextSaved, false);
  assert.equal(serialized.includes("fixture-openai-key"), false);
  assert.equal(serialized.includes("fixture-gemini-key"), false);
  assert.equal(serialized.includes("fixture transcript"), false);
  assert.equal(serialized.includes("PDF fixture bytes"), false);
});
