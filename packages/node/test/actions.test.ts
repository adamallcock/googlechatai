import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeAction, normalizeEvent } from "../src/index.js";

const root = path.resolve(import.meta.dirname, "../../..");

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

const actionCases = [
  {
    raw: "fixtures/actions/card-click/approve-basic.json",
    expected: "fixtures/expected/actions/card-click.approve-basic.json",
    eventKind: "card.clicked",
  },
  {
    raw: "fixtures/actions/dialog-submit/complex-form.json",
    expected: "fixtures/expected/actions/dialog-submit.complex-form.json",
    eventKind: "dialog.submitted",
  },
  {
    raw: "fixtures/actions/widget-update/autocomplete-users.json",
    expected: "fixtures/expected/actions/widget-update.autocomplete-users.json",
    eventKind: "widget.updated",
  },
  {
    raw: "fixtures/actions/slash-command/deploy.json",
    expected: "fixtures/expected/actions/slash-command.deploy.json",
    eventKind: "message.slash_command",
  },
  {
    raw: "fixtures/actions/app-command/search-docs.json",
    expected: "fixtures/expected/actions/app-command.search-docs.json",
    eventKind: "message.app_command",
  },
  {
    raw: "fixtures/actions/card-click/invalid-and-unknown-fields.json",
    expected: "fixtures/expected/actions/card-click.invalid-and-unknown-fields.json",
    eventKind: "card.clicked",
  },
];

describe("normalizeAction", () => {
  for (const actionCase of actionCases) {
    it(`normalizes ${actionCase.raw}`, () => {
      const raw = readJson(actionCase.raw);
      const expected = readJson(actionCase.expected);

      expect(normalizeAction(raw, { source: "fixture" })).toEqual(expected);
    });

    it(`surfaces ${actionCase.raw} through event normalization`, () => {
      const raw = readJson(actionCase.raw);
      const expected = readJson(actionCase.expected);
      const event = normalizeEvent(raw, { source: "fixture" });

      expect(event.kind).toBe(actionCase.eventKind);
      expect(event.action).toEqual(expected);
    });
  }

  it("surfaces the same normalized action shape through event normalization", () => {
    const raw = readJson("fixtures/actions/dialog-submit/complex-form.json");
    const expected = readJson(
      "fixtures/expected/actions/dialog-submit.complex-form.json",
    );
    const event = normalizeEvent(raw, { source: "fixture" });

    expect(event.kind).toBe("dialog.submitted");
    expect(event.action).toEqual(expected);
  });
});
