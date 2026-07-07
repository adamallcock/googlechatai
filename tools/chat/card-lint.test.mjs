import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCardLintCli } from "./card-lint.mjs";

async function writeJson(dir, name, value) {
  const target = path.join(dir, name);
  await fs.writeFile(target, JSON.stringify(value), "utf8");
  return target;
}

test("card-lint summary exits cleanly for valid payloads", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-card-lint-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = await writeJson(dir, "valid.json", { text: "Hello" });
  const writes = [];

  const result = await runCardLintCli({
    argv: ["node", "card-lint.mjs", "--input", input, "--surface", "chat-message"],
    cwd: dir,
    stdout: { write: (chunk) => writes.push(String(chunk)) },
    stderr: { write: (chunk) => writes.push(String(chunk)) },
    sdk: {
      lintCardPayload(payload, options) {
        assert.deepEqual(payload, { text: "Hello" });
        assert.deepEqual(options, { surface: "chat-message" });
        return {
          kind: "chat.card_lint_result",
          surface: "chat-message",
          ok: true,
          summary: "0 errors, 0 warnings",
          stats: { cards: 0, sections: 0, widgets: 0, buttons: 0, images: 0, bytes: 16 },
          findings: [],
          translated: null,
        };
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(writes.join(""), /0 errors, 0 warnings/);
  assert.match(writes.join(""), /cards=0 sections=0 widgets=0 buttons=0 bytes=16/);
});

test("card-lint json exits with lint failure when errors are present", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-card-lint-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = await writeJson(dir, "invalid.json", { cards_v2: [] });
  const writes = [];

  const result = await runCardLintCli({
    argv: [
      "node",
      "card-lint.mjs",
      "--input",
      input,
      "--surface",
      "chat-message",
      "--format",
      "json",
    ],
    cwd: dir,
    stdout: { write: (chunk) => writes.push(String(chunk)) },
    stderr: { write: (chunk) => writes.push(String(chunk)) },
    sdk: {
      lintCardPayload() {
        return {
          kind: "chat.card_lint_result",
          surface: "chat-message",
          ok: false,
          summary: "1 error, 0 warnings",
          stats: { cards: 0, sections: 0, widgets: 0, buttons: 0, images: 0, bytes: 15 },
          findings: [
            {
              severity: "error",
              code: "wrong_cards_field",
              path: "$.cards_v2",
              message: "Use cardsV2 for Google Chat REST messages.",
              remediation: "Rename cards_v2 to cardsV2 for this profile.",
            },
          ],
          translated: null,
        };
      },
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(writes.join("")).findings[0].code, "wrong_cards_field");
});

test("card-lint can translate payloads from direct Chat to add-on responses", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-card-lint-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = await writeJson(dir, "direct.json", { text: "Done" });
  const writes = [];

  const result = await runCardLintCli({
    argv: [
      "node",
      "card-lint.mjs",
      "--input",
      input,
      "--surface",
      "direct-chat-response",
      "--translate-to",
      "workspace-addon-action-response",
      "--translation-mode",
      "update-message",
      "--format",
      "json",
    ],
    cwd: dir,
    stdout: { write: (chunk) => writes.push(String(chunk)) },
    stderr: { write: (chunk) => writes.push(String(chunk)) },
    sdk: {
      translateCardPayload(payload, options) {
        assert.deepEqual(payload, { text: "Done" });
        assert.deepEqual(options, {
          from: "direct-chat-response",
          to: "workspace-addon-action-response",
          mode: "update-message",
        });
        return {
          kind: "chat.card_translation_result",
          from: "direct-chat-response",
          to: "workspace-addon-action-response",
          mode: "update-message",
          ok: true,
          findings: [],
          payload: {
            hostAppDataAction: {
              chatDataAction: {
                updateMessageAction: { message: { text: "Done" } },
              },
            },
          },
        };
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(
    JSON.parse(writes.join("")).payload.hostAppDataAction.chatDataAction
      .updateMessageAction.message.text,
    "Done",
  );
});
