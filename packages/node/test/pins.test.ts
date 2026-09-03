import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CHAT_PIN_DOCS_LISTED_NOTE,
  CHAT_SPACES_PINS_READONLY_SCOPE,
  CHAT_SPACES_PINS_SCOPE,
  MESSAGE_PINS_DEVELOPER_PREVIEW_NOTE,
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
        authMode: "user",
      }),
    ).toEqual(fixture);
  });

  it("matches the unpin-by-name fixture", () => {
    const fixture = readJson("fixtures/expected/pins/unpin-by-name.json");
    expect(
      planUnpinMessage({
        messagePin: "spaces/AAA/messagePins/CCC",
        authMode: "user",
      }),
    ).toEqual(fixture);
  });

  it("matches the unpin-by-message fixture", () => {
    const fixture = readJson("fixtures/expected/pins/unpin-by-message.json");
    expect(
      planUnpinMessage({
        space: "spaces/AAA",
        message: "spaces/AAA/messages/BBB",
        authMode: "user",
      }),
    ).toEqual(fixture);
  });

  it("matches the list-pins fixture", () => {
    const fixture = readJson("fixtures/expected/pins/list-pins.json");
    expect(
      planListMessagePins({
        space: "spaces/AAA",
        authMode: "user",
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
        authMode: "user",
      }),
    ).toEqual(fixture);
  });

  it("matches the ensure-pinned fixture", () => {
    const fixture = readJson("fixtures/expected/pins/ensure-pinned.json");
    expect(
      planEnsureMessagePinned({
        space: "spaces/AAA",
        message: "spaces/AAA/messages/BBB",
        authMode: "user",
      }),
    ).toEqual(fixture);
  });

  it("exports least-privilege pin scopes and backwards-compatible aliases", () => {
    expect(CHAT_SPACES_PINS_SCOPE).toBe(
      "https://www.googleapis.com/auth/chat.spaces.pins",
    );
    expect(CHAT_SPACES_PINS_READONLY_SCOPE).toBe(
      "https://www.googleapis.com/auth/chat.spaces.pins.readonly",
    );
    expect(PIN_MESSAGES_SCOPE).toBe(CHAT_SPACES_PINS_SCOPE);
    expect(CHAT_PIN_DOCS_LISTED_NOTE).toBe(MESSAGE_PINS_DEVELOPER_PREVIEW_NOTE);
  });

  it("carries the Developer Preview warning on every planned operation", () => {
    const plans = [
      planPinMessage({ space: "spaces/AAA", message: "spaces/AAA/messages/BBB" }),
      planUnpinMessage({ messagePin: "spaces/AAA/messagePins/CCC" }),
      planUnpinMessage({ space: "spaces/AAA", message: "spaces/AAA/messages/BBB" }),
      planListMessagePins({ space: "spaces/AAA" }),
      planEnsureMessagePinned({ space: "spaces/AAA", message: "spaces/AAA/messages/BBB" }),
    ];

    for (const plan of plans) {
      expect((plan as { warnings: string[] }).warnings).toContain(
        MESSAGE_PINS_DEVELOPER_PREVIEW_NOTE,
      );
    }
  });

  it("derives a direct message-pin delete path from a message resource name", () => {
    const plan = planUnpinMessage({
      space: "spaces/AAA",
      message: "spaces/AAA/messages/BBB",
    }) as {
      requests: Array<{ resource: string; method: string; path: string }>;
      pin: { strategy: string; name: string };
    };

    expect(plan.requests).toEqual([
      {
        resource: "spaces.messagePins.delete",
        method: "DELETE",
        path: "/v1/spaces/AAA/messagePins/BBB",
        query: {},
        body: null,
      },
    ]);
    expect(plan.pin).toMatchObject({
      strategy: "derived-from-message",
      name: "spaces/AAA/messagePins/BBB",
    });
  });

  it("blocks plans with app auth without silently changing their principal", () => {
    const plan = planPinMessage({
      space: "spaces/AAA",
      message: "spaces/AAA/messages/BBB",
      authMode: "app",
    }) as {
      capability: { ok: boolean; authMode: string; reasons: string[] };
    };
    expect(plan.capability).toEqual({
      ok: false,
      authMode: "app",
      requiredScopes: [CHAT_SPACES_PINS_SCOPE],
      reasons: [
        "Google Chat message pins require user authentication; app authentication is not supported.",
      ],
    });
  });

  it("requires well-formed, same-space message and pin resource names", () => {
    expect(() =>
      planPinMessage({
        space: "spaces/AAA",
        message: "spaces/BBB/messages/CCC",
      }),
    ).toThrow("Expected message to belong to the supplied space.");
    expect(() =>
      planPinMessage({ space: "spaces/AAA", message: "not-a-message" }),
    ).toThrow("Expected message to use the resource name format");
    expect(() => planUnpinMessage({ messagePin: "spaces/AAA/messages/BBB" })).toThrow(
      "Expected messagePin to use the resource name format",
    );
  });

  it("requires the basic planner inputs", () => {
    expect(() => planPinMessage({ message: "spaces/AAA/messages/BBB" })).toThrow(
      "Expected space to be a non-empty string.",
    );
    expect(() => planPinMessage({ space: "spaces/AAA" })).toThrow(
      "Expected message to be a non-empty string.",
    );
    expect(() => planListMessagePins({})).toThrow(
      "Expected space to be a non-empty string.",
    );
    expect(() => planEnsureMessagePinned({ message: "spaces/AAA/messages/BBB" })).toThrow(
      "Expected space to be a non-empty string.",
    );
    expect(() => planEnsureMessagePinned({ space: "spaces/AAA" })).toThrow(
      "Expected message to be a non-empty string.",
    );
    expect(() => planUnpinMessage({})).toThrow(
      "Expected messagePin, or both space and message, to be non-empty strings.",
    );
  });

  it("clamps list pageSize to the documented 1..100 range and floors fractional values", () => {
    expect(
      (planListMessagePins({ space: "spaces/AAA", pageSize: 0 }) as {
        requests: Array<{ query: { pageSize: number } }>;
      }).requests[0]!.query.pageSize,
    ).toBe(1);
    expect(
      (planListMessagePins({ space: "spaces/AAA", pageSize: 5000 }) as {
        requests: Array<{ query: { pageSize: number } }>;
      }).requests[0]!.query.pageSize,
    ).toBe(100);
    expect(
      (planListMessagePins({ space: "spaces/AAA", pageSize: 12.9 }) as {
        requests: Array<{ query: { pageSize: number } }>;
      }).requests[0]!.query.pageSize,
    ).toBe(12);
    expect(
      (planListMessagePins({ space: "spaces/AAA", pageSize: Number.NaN }) as {
        requests: Array<{ query: { pageSize: number } }>;
      }).requests[0]!.query.pageSize,
    ).toBe(100);
  });

  it("requires a complete first page for ensure-pinned", () => {
    expect(() =>
      planEnsureMessagePinned({
        space: "spaces/AAA",
        message: "spaces/AAA/messages/BBB",
        pageSize: 99,
      }),
    ).toThrow("requires pageSize 100");
    expect(() =>
      planEnsureMessagePinned({
        space: "spaces/AAA",
        message: "spaces/AAA/messages/BBB",
        pageToken: "next-page",
      }),
    ).toThrow("does not accept pageToken");
  });

  it("defaults pin planners to installed-user authentication", () => {
    const plan = planPinMessage({
      space: "spaces/AAA",
      message: "spaces/AAA/messages/BBB",
    }) as { capability: { authMode: string; ok: boolean } };
    expect(plan.capability).toMatchObject({ authMode: "user", ok: true });
  });
});
