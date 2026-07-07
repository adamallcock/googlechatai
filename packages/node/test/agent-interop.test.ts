import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  normalizeAgentResponse,
  planAgentResponseMessage,
} from "../src/index.js";

const root = path.resolve(import.meta.dirname, "../../..");

function readJson<T = unknown>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")) as T;
}

const normalizeCases = [
  [
    "Anthropic content blocks",
    "fixtures/agent-interop/anthropic-content-blocks.json",
    "fixtures/expected/agent-interop/anthropic-content-blocks.normalized.json",
  ],
  [
    "OpenAI Agents run result",
    "fixtures/agent-interop/openai-agents-run-result.json",
    "fixtures/expected/agent-interop/openai-agents-run-result.normalized.json",
  ],
  [
    "Vercel AI SDK result",
    "fixtures/agent-interop/vercel-ai-sdk-result.json",
    "fixtures/expected/agent-interop/vercel-ai-sdk-result.normalized.json",
  ],
  [
    "Google GenAI grounding",
    "fixtures/agent-interop/google-genai-grounding.json",
    "fixtures/expected/agent-interop/google-genai-grounding.normalized.json",
  ],
] as const;

describe("agent SDK interop", () => {
  it.each(normalizeCases)("normalizes %s", (_label, fixture, expectedFixture) => {
    expect(normalizeAgentResponse(readJson(fixture))).toEqual(readJson(expectedFixture));
  });

  it("plans Google Chat messages from a Vercel AI SDK result", () => {
    expect(
      planAgentResponseMessage(readJson("fixtures/agent-interop/vercel-ai-sdk-result.json"), {
        responseId: "resp_vercel_1",
      }),
    ).toEqual(
      readJson("fixtures/expected/agent-interop/vercel-ai-sdk-result.message-plan.json"),
    );
  });

  it("keeps detected SDK when only provider is overridden and preserves zero cost", () => {
    const input = readJson<Record<string, unknown>>("fixtures/agent-interop/vercel-ai-sdk-result.json");

    const actual = normalizeAgentResponse(
      {
        ...input,
        providerMetadata: {
          aicost: {
            totalCostUsd: 0,
            currency: "USD",
            source: "ai-sdk-cost",
          },
        },
      },
      { provider: "gateway-proxy" },
    );

    expect(actual.provider).toBe("gateway-proxy");
    expect(actual.sdk).toBe("vercel-ai-sdk");
    expect(actual.cost).toEqual({
      amountUsd: 0,
      currency: "USD",
      source: "ai-sdk-cost",
      note: null,
    });
  });
});
