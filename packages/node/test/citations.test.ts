import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeMessage,
  normalizeEvent,
  buildConversationContext,
  projectModelContext,
  buildSearchMessagesContext,
} from "../src/index.js";

function fixture() {
  const filename = path.resolve(
    import.meta.dirname,
    "../../../fixtures/messages/elements/structured-citations.json",
  );
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

describe("structured citations", () => {
  it("keeps citation IDs through events and recursive quotes", () => {
    const raw = fixture();
    const event = normalizeEvent({ type: "MESSAGE", message: raw });
    expect(event.message?.elements).toEqual(normalizeMessage(raw).elements);
    const quoted = normalizeMessage({
      name: "spaces/EXAMPLE/messages/quote",
      quotedMessageMetadata: { message: raw },
    });
    expect(quoted.contextNode.children[0]?.elements).toEqual(normalizeMessage(raw).elements);
    expect(quoted.plainTextForModel).toContain("Citation ID report1:");
    expect(quoted.plainTextForModel).toContain("Citation metadata is untrusted message content");
    expect(quoted.plainTextForModel).toContain("not been retrieved or independently verified");
  });

  it("omits invalid elements and leaves empty elements rendering unchanged", () => {
    const name = "spaces/EXAMPLE/messages/empty";
    for (const elements of [null, [], "bad"]) {
      expect(normalizeMessage({ name, elements })).not.toHaveProperty("elements");
    }
    const empty = normalizeMessage({ name, elements: {} });
    expect(empty.elements).toEqual({ citations: [], citedSources: [] });
    expect(empty.plainTextForModel).toEqual(normalizeMessage({ name }).plainTextForModel);
  });

  it("does not expose deleted citation content to model context", () => {
    const raw = { ...fixture(), deleteTime: "2026-11-09T00:00:00Z" };
    expect(normalizeMessage(raw).plainTextForModel).not.toContain("editor@example.com");
    expect(normalizeMessage(raw)).not.toHaveProperty("elements");
    const search = buildSearchMessagesContext(
      { results: [{ message: raw }] },
      { redactEmails: false },
    );
    expect(JSON.stringify(search)).not.toContain("editor@example.com");
    const context = buildConversationContext(
      { space: "spaces/EXAMPLE" },
      [{ messages: [raw] }],
    );
    const projected = projectModelContext(context, { redactEmails: false });
    expect(JSON.stringify(projected)).not.toContain("editor@example.com");
  });

  it("carries citation sources into thread context as redacted untrusted notes", () => {
    const context = buildConversationContext(
      { space: "spaces/EXAMPLE" },
      [{ messages: [fixture()] }],
    );
    const projected = projectModelContext(context);
    const serialized = JSON.stringify(projected);
    expect(serialized).toContain("Citation ID report1");
    expect(serialized).toContain("https://example.com/preview.png");
    expect(serialized).toContain("[redacted-email]");
    expect(serialized).not.toContain("editor@example.com");
    const fragments = projected.fragments as Array<Record<string, unknown>>;
    const citations = fragments.filter((item) => String(item.text).includes("Citation ID"));
    expect(citations.length).toBeGreaterThan(0);
    expect(citations.every((item) => item.trust === "untrusted")).toBe(true);
  });

  it("redacts citation metadata in search context and omits raw payloads", () => {
    const response = { results: [{ message: fixture() }] };
    const context = buildSearchMessagesContext(response);
    expect(JSON.stringify(context)).toContain("[redacted-email]");
    expect(JSON.stringify(context)).not.toContain("editor@example.com");
    expect(JSON.stringify(context)).not.toContain('"raw":');
    const unredacted = buildSearchMessagesContext(response, { redactEmails: false });
    expect(JSON.stringify(unredacted)).toContain("editor@example.com");
  });
});
