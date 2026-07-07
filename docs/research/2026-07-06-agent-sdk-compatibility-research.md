---
title: Agent SDK Compatibility Research
date: 2026-07-06
type: research
status: draft
---

# Agent SDK Compatibility Research

## Scope

This SDK should remain a Google Chat CLI/API for agent use cases. Compatibility
work should therefore normalize already-produced agent responses into
Google Chat-ready context and cards. It should not run models, own model
configuration, replace Anthropic/OpenAI/Vercel/Google SDKs, or become a general
AI framework.

## Current SDK Surfaces

Anthropic's TypeScript SDK is a thin API client for Claude, and the response
surface is block-oriented. The useful compatibility primitives are content block
types such as text, tool use, thinking, and citation-bearing blocks. Tool use is
represented as structured tool blocks, and thinking should only be surfaced when
the provider returns a summary or explicit content block. Source:
[Anthropic TypeScript SDK docs](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript).

OpenAI Agents SDK returns an agent run result rather than only a model message.
The JavaScript docs show `result.finalOutput`; the Python result docs identify
`final_output`, `new_items`, `raw_responses`, continuation input, last agent,
and interruptions as important run surfaces. For Google Chat compatibility,
the primary extraction targets are final output, rich run items for tool and
handoff metadata, and raw response usage. Sources:
[OpenAI Agents SDK JS docs](https://openai.github.io/openai-agents-js/) and
[OpenAI Agents SDK Python results docs](https://openai.github.io/openai-agents-python/results/).

Vercel AI SDK already normalizes several providers. `generateText` results
include generated text, reasoning, files, sources, tool calls, tool results,
finish reasons, usage, total usage, warnings, response metadata, provider
metadata, steps, and structured output. Streaming exposes full stream parts for
text, reasoning, sources, files, tool calls, and tool results. Sources:
[AI SDK generating text docs](https://ai-sdk.dev/docs/ai-sdk-core/generating-text),
[AI SDK tool calling docs](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling),
and [AI SDK streamText reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text).

Google GenAI's current Gemini grounding docs recommend the Interactions API for
new features. Grounded responses include `output_text`, steps such as `thought`,
`google_search_call`, `google_search_result`, and `model_output`, plus inline
`annotations` containing URL citations. Source:
[Google Gemini grounding docs](https://ai.google.dev/gemini-api/docs/google-search).

Cost parsing is less standardized than the response primitives. The safe first
step is to parse common `cost`, `estimatedCost`, `totalCostUsd`, and
`providerMetadata.aicost` shapes when present, while treating cost as optional
metadata. No runtime dependency on a cost package should be introduced until a
specific package is evaluated against real payloads and maintenance evidence.

## Compatibility Contract

Normalize into a provider-neutral `agent_response` document with:

- `finalText`: the user-facing answer text, if present.
- `sources`: citation and source references suitable for `buildSourcesCard`.
- `toolCalls` and `toolResults`: tool lifecycle breadcrumbs suitable for
  `buildToolStatusCard`.
- `thinkingSummaries`: provider-returned summaries only, suitable for
  `buildThinkingCard`.
- `usage` and `cost`: optional accounting metadata.
- `warnings` and `systemNotes`: explicit ambiguity and provenance notes.
- `rawShape`: compact top-level shape diagnostics for debugging without
  retaining raw private payload content.

The normalizer should be pure, deterministic, dependency-free, and bounded. It
should not fetch URLs, execute tools, stream model output, or infer hidden
chain-of-thought.

