import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildReactionFilterForEmoji,
  feedbackRatingToEmoji,
  planAddReaction,
  planDeleteReaction,
  planFeedbackReaction,
  planListReactions,
} from "../src/index.js";

const root = path.resolve(import.meta.dirname, "../../..");

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")) as T;
}

const planners: Record<string, (input: Record<string, unknown>) => unknown> = {
  "reactions.add": planAddReaction,
  "reactions.delete": planDeleteReaction,
  "reactions.feedback": planFeedbackReaction,
  "reactions.list": planListReactions,
};

describe("reaction dry-run call plans", () => {
  const cases = readJson<
    Array<{
      id: string;
      operation: string;
      input: Record<string, unknown>;
      expect: unknown;
    }>
  >("conformance/cases/reactions.call-plans.json");

  for (const testCase of cases) {
    it(`matches conformance case ${testCase.id}`, () => {
      expect(planners[testCase.operation](testCase.input)).toEqual(testCase.expect);
    });
  }

  it("maps feedback ratings to visible thumbs reactions", () => {
    expect(feedbackRatingToEmoji("helpful")).toEqual({ unicode: "\u{1F44D}" });
    expect(feedbackRatingToEmoji("thumbsUp")).toEqual({ unicode: "\u{1F44D}" });
    expect(feedbackRatingToEmoji("not_helpful")).toEqual({ unicode: "\u{1F44E}" });
    expect(feedbackRatingToEmoji("Not helpful")).toEqual({ unicode: "\u{1F44E}" });
    expect(() => feedbackRatingToEmoji("meh")).toThrow(/feedback rating/);
  });

  it("builds Google Chat reaction filters for unicode and custom emoji uid values", () => {
    expect(buildReactionFilterForEmoji("\u{1F44D}")).toBe(
      'emoji.unicode = "\u{1F44D}"',
    );
    expect(
      buildReactionFilterForEmoji({
        customEmoji: { uid: "custom-emoji-123" },
      }),
    ).toBe('emoji.custom_emoji.uid = "custom-emoji-123"');
  });

  it("marks app-auth reaction writes unavailable so visible feedback stays user-owned", () => {
    expect(
      planFeedbackReaction({
        message: "spaces/AAA/messages/BBB",
        rating: "up",
        authMode: "app",
      }),
    ).toMatchObject({
      capability: {
        ok: false,
        authMode: "app",
      },
      warnings: [
        "Feedback reactions should use the submitting user's credentials so Chat shows the human's reaction.",
      ],
    });
  });
});
