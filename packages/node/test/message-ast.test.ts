import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeMessage } from "../src/index.js";

const root = path.resolve(import.meta.dirname, "../../..");

const cases = [
  ["annotations.mentions-custom-emoji", "fixtures/messages/annotations/mentions-custom-emoji.json"],
  ["commands.slash-command", "fixtures/messages/commands/slash-command.json"],
  ["links.matched-url-rich-link", "fixtures/messages/links/matched-url-rich-link.json"],
  ["attachments.uploaded-file", "fixtures/messages/attachments/uploaded-file.json"],
  ["quotes.nested-content", "fixtures/messages/quotes/nested-content.json"],
  ["deleted.user-deleted", "fixtures/messages/deleted/user-deleted.json"],
  ["private.thread-reply", "fixtures/messages/private/thread-reply.json"],
  ["gifs.attached-gif", "fixtures/messages/gifs/attached-gif.json"],
] as const;

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

describe("normalizeMessage", () => {
  it.each(cases)("normalizes %s", (id, rawFixture) => {
    const expected = readJson(`fixtures/expected/messages/${id}.json`);

    expect(normalizeMessage(readJson(rawFixture))).toEqual(expected);
  });

  it("emits the nested quote context fixture", () => {
    const raw = readJson("fixtures/messages/quotes/nested-content.json");
    const expected = readJson("fixtures/expected/context/messages.quoted-nested.context.json");

    expect(normalizeMessage(raw).contextNode).toEqual(expected);
  });
});
