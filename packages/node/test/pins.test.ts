import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CHAT_PIN_DOCS_LISTED_NOTE,
  PIN_MESSAGES_SCOPE,
  planEnsureMessagePinned,
  planListMessagePins,
  planPinMessage,
  planUnpinMessage,
} from "../src/pins/index.js";

const root = path.resolve(import.meta.dirname, "../../..");

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")) as T;
}

const planners: Record<string, (input: Record<string, unknown>) => unknown> = {
  "pins.pin": planPinMessage,
  "pins.unpin": planUnpinMessage,
  "pins.list": planListMessagePins,
  "pins.ensurePinned": planEnsureMessagePinned,
};

describe("message pin dry-run call plans", () => {
  const cases = readJson<
    Array<{
      id: string;
      operation: string;
      input: Record<string, unknown>;
      expect: unknown;
    }>
  >("conformance/cases/pins.call-plans.json");

  for (const testCase of cases) {
    it(`matches conformance case ${testCase.id}`, () => {
      expect(planners[testCase.operation](testCase.input)).toEqual(testCase.expect);
    });
  }

  it("matches the pin-message fixture", () => {
    const fixture = readJson("fixtures/expected/pins/pin-message.json");
    expect(
      planPinMessage({
        space: "spaces/AAA",
        message: "spaces/AAA/messages/BBB",
        authMode: "app",
      }),
    ).toEqual(fixture);
  });

  it("matches the unpin-by-name fixture", () => {
    const fixture = readJson("fixtures/expected/pins/unpin-by-name.json");
    expect(
      planUnpinMessage({
        messagePin: "spaces/AAA/messagePins/CCC",
        authMode: "app",
      }),
    ).toEqual(fixture);
  });

  it("matches the unpin-by-message fixture", () => {
    const fixture = readJson("fixtures/expected/pins/unpin-by-message.json");
    expect(
      planUnpinMessage({
        space: "spaces/AAA",
        message: "spaces/AAA/messages/BBB",
        authMode: "app",
      }),
    ).toEqual(fixture);
  });

  it("matches the list-pins fixture", () => {
    const fixture = readJson("fixtures/expected/pins/list-pins.json");
    expect(
      planListMessagePins({
        space: "spaces/AAA",
        authMode: "app",
      }),
    ).toEqual(fixture);
  });

  it("matches the list-pins-paged fixture", () => {
    const fixture = readJson("fixtures/expected/pins/list-pins-paged.json");
    expect(
      planListMessagePins({
        space: "spaces/AAA",
        pageSize: 25,
        pageToken: "next-page",
        authMode: "app",
      }),
    ).toEqual(fixture);
  });

  it("matches the ensure-pinned fixture", () => {
    const fixture = readJson("fixtures/expected/pins/ensure-pinned.json");
    expect(
      planEnsureMessagePinned({
        space: "spaces/AAA",
        message: "spaces/AAA/messages/BBB",
        authMode: "app",
      }),
    ).toEqual(fixture);
  });

  it("exports the messages scope and docs-listed note constants", () => {
    expect(PIN_MESSAGES_SCOPE).toBe("https://www.googleapis.com/auth/chat.messages");
    expect(CHAT_PIN_DOCS_LISTED_NOTE).toBe(
      "spaces.messagePins.* is a docs-listed surface; verify live support before relying on it.",
    );
  });

  it("carries the docs-listed warning on every planned operation", () => {
    const plans = [
      planPinMessage({ space: "spaces/AAA", message: "spaces/AAA/messages/BBB" }),
      planUnpinMessage({ messagePin: "spaces/AAA/messagePins/CCC" }),
      planUnpinMessage({ space: "spaces/AAA", message: "spaces/AAA/messages/BBB" }),
      planListMessagePins({ space: "spaces/AAA" }),
      planEnsureMessagePinned({ space: "spaces/AAA", message: "spaces/AAA/messages/BBB" }),
    ];

    for (const plan of plans) {
      expect((plan as { warnings: string[] }).warnings).toContain(CHAT_PIN_DOCS_LISTED_NOTE);
    }
  });

  it("uses the resolvedMessagePin placeholder path for the unpin-by-message two-step plan", () => {
    const plan = planUnpinMessage({
      space: "spaces/AAA",
      message: "spaces/AAA/messages/BBB",
    }) as {
      requests: Array<{ resource: string; method: string; path: string }>;
    };

    expect(plan.requests).toHaveLength(2);
    expect(plan.requests[0]).toMatchObject({
      resource: "spaces.messagePins.list",
      method: "GET",
      path: "/v1/spaces/AAA/messagePins",
    });
    expect(plan.requests[1]).toMatchObject({
      resource: "spaces.messagePins.delete",
      method: "DELETE",
      path: "/v1/{resolvedMessagePin}",
    });
  });

  it("requires a non-empty space for planPinMessage", () => {
    expect(() => planPinMessage({ message: "spaces/AAA/messages/BBB" })).toThrow(
      "Expected space to be a non-empty string.",
    );
  });

  it("requires a non-empty message for planPinMessage", () => {
    expect(() => planPinMessage({ space: "spaces/AAA" })).toThrow(
      "Expected message to be a non-empty string.",
    );
  });

  it("requires a non-empty space for planListMessagePins", () => {
    expect(() => planListMessagePins({})).toThrow(
      "Expected space to be a non-empty string.",
    );
  });

  it("requires a non-empty space for planEnsureMessagePinned", () => {
    expect(() => planEnsureMessagePinned({ message: "spaces/AAA/messages/BBB" })).toThrow(
      "Expected space to be a non-empty string.",
    );
  });

  it("requires a non-empty message for planEnsureMessagePinned", () => {
    expect(() => planEnsureMessagePinned({ space: "spaces/AAA" })).toThrow(
      "Expected message to be a non-empty string.",
    );
  });

  it("requires messagePin or space+message for planUnpinMessage", () => {
    expect(() => planUnpinMessage({})).toThrow(
      "Expected messagePin, or both space and message, to be non-empty strings.",
    );
    expect(() => planUnpinMessage({ space: "spaces/AAA" })).toThrow(
      "Expected messagePin, or both space and message, to be non-empty strings.",
    );
    expect(() => planUnpinMessage({ message: "spaces/AAA/messages/BBB" })).toThrow(
      "Expected messagePin, or both space and message, to be non-empty strings.",
    );
  });

  it("clamps pageSize to the 1..1000 range and floors fractional values", () => {
    expect(
      (planListMessagePins({ space: "spaces/AAA", pageSize: 0 }) as {
        requests: Array<{ query: { pageSize: number } }>;
      }).requests[0]!.query.pageSize,
    ).toBe(1);
    expect(
      (planListMessagePins({ space: "spaces/AAA", pageSize: 5000 }) as {
        requests: Array<{ query: { pageSize: number } }>;
      }).requests[0]!.query.pageSize,
    ).toBe(1000);
    expect(
      (planListMessagePins({ space: "spaces/AAA", pageSize: 12.9 }) as {
        requests: Array<{ query: { pageSize: number } }>;
      }).requests[0]!.query.pageSize,
    ).toBe(12);
  });

  it("defaults pageSize to 100 when not provided", () => {
    const plan = planListMessagePins({ space: "spaces/AAA" }) as {
      requests: Array<{ query: { pageSize: number } }>;
    };
    expect(plan.requests[0]!.query.pageSize).toBe(100);
  });

  it("defaults authMode to app", () => {
    const plan = planPinMessage({
      space: "spaces/AAA",
      message: "spaces/AAA/messages/BBB",
    }) as { capability: { authMode: string } };
    expect(plan.capability.authMode).toBe("app");
  });
});
