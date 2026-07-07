---
title: AI Card Components
date: 2026-07-03
type: guide
status: draft
---

# AI Card Components

The SDK includes reusable Cards V2 builders for common AI assistant UI patterns
so applications do not have to hand-author Google Chat card JSON for every
response loop.

Implemented in Node and Python:

- Low-impact feedback accessory widgets with borderless thumbs-up/down buttons.
- Feedback cards with helpful, not-helpful, and optional comment actions for
  heavier workflows that need visible text labels.
- Sources cards with linked or resource-only citations.
- Thinking status cards.
- Tool-call status cards.
- Streaming status cards for create-then-patch response flows.

These helpers only build card messages. Sending, patching, idempotency,
auth-refresh, and retry behavior remain owned by the message/transport helpers.
For answer-level feedback buttons that should also show a visible thumbs-up or
thumbs-down reaction on the target post, prefer `buildFeedbackAccessoryMessage`
and pair it with the reaction planners in
[Feedback Reactions](2026-07-03-feedback-reactions.md).
For ordinary AI-agent turns, prefer the lighter placeholder-response pattern:
post a short `Thinking...` message and edit that same message with the final
answer. Use thinking, tool-status, and streaming-status cards only when the
card itself is part of the product experience.

## Node

```ts
import {
  buildFeedbackCard,
  buildFeedbackAccessoryMessage,
  buildSourcesCard,
  buildStreamingStatusCard,
  buildThinkingCard,
  buildToolStatusCard,
} from "googlechatai";

const baseUrl = "https://your-cloud-run-service.example.com/api";
const feedbackFunction = `${baseUrl}/chat/events`;

const answerWithFeedback = buildFeedbackAccessoryMessage({
  text: "Here is the concise answer.",
  responseId: "resp_123",
  upAction: {
    function: feedbackFunction,
    parameters: {
      actionName: "ai_feedback",
      responseId: "resp_123",
      rating: "helpful",
    },
  },
  downAction: {
    function: feedbackFunction,
    parameters: {
      actionName: "ai_feedback",
      responseId: "resp_123",
      rating: "not_helpful",
    },
  },
});

const feedback = buildFeedbackCard({
  responseId: "resp_123",
  upAction: {
    function: "ai_feedback",
    parameters: { responseId: "resp_123", rating: "up" },
  },
  downAction: {
    function: "ai_feedback",
    parameters: { responseId: "resp_123", rating: "down" },
  },
});

const sources = buildSourcesCard({
  responseId: "resp_123",
  sources: [
    {
      title: "Thread context",
      label: "Chat",
      resourceName: "spaces/AAA/messages/BBB",
    },
  ],
});

const thinking = buildThinkingCard({
  title: "Working on it",
  status: "thinking",
  detail: "Reading the thread and checking sources.",
});

const tools = buildToolStatusCard({
  tools: [
    { name: "read_thread", status: "complete", output: "12 messages read" },
  ],
});

const streaming = buildStreamingStatusCard({
  mode: "create_then_patch",
  status: "streaming",
  patchCount: 7,
  throttleMs: 750,
});
```

## Python

```python
from googlechatai import (
    build_feedback_card,
    build_feedback_accessory_message,
    build_sources_card,
    build_streaming_status_card,
    build_thinking_card,
    build_tool_status_card,
)

base_url = "https://your-cloud-run-service.example.com/api"
feedback_function = f"{base_url}/chat/events"

answer_with_feedback = build_feedback_accessory_message(
    {
        "text": "Here is the concise answer.",
        "responseId": "resp_123",
        "upAction": {
            "function": feedback_function,
            "parameters": {
                "actionName": "ai_feedback",
                "responseId": "resp_123",
                "rating": "helpful",
            },
        },
        "downAction": {
            "function": feedback_function,
            "parameters": {
                "actionName": "ai_feedback",
                "responseId": "resp_123",
                "rating": "not_helpful",
            },
        },
    }
)

feedback = build_feedback_card(
    {
        "responseId": "resp_123",
        "upAction": {
            "function": "ai_feedback",
            "parameters": {"responseId": "resp_123", "rating": "up"},
        },
        "downAction": {
            "function": "ai_feedback",
            "parameters": {"responseId": "resp_123", "rating": "down"},
        },
    }
)

sources = build_sources_card(
    {
        "responseId": "resp_123",
        "sources": [
            {
                "title": "Thread context",
                "label": "Chat",
                "resourceName": "spaces/AAA/messages/BBB",
            }
        ],
    }
)

thinking = build_thinking_card(
    {
        "title": "Working on it",
        "status": "thinking",
        "detail": "Reading the thread and checking sources.",
    }
)

tools = build_tool_status_card(
    {
        "tools": [
            {
                "name": "read_thread",
                "status": "complete",
                "output": "12 messages read",
            }
        ]
    }
)

streaming = build_streaming_status_card(
    {
        "mode": "create_then_patch",
        "status": "streaming",
        "patchCount": 7,
        "throttleMs": 750,
    }
)
```

## Verification Boundary

The component JSON is unit-verified in both languages and validated with the
shared `validateCardMessage` / `validate_card_message` helpers. For live Chat
rendering, use the guarded smoke-space harness:

```bash
RUN_LIVE_CHAT_VISUAL_SMOKE=1 pnpm live:chat-visual-smoke -- \
  --include-ai-card-components
```

The live harness posts the five builder-generated card messages into the
dedicated smoke space, records redacted evidence for cleanup, and leaves the
messages in Chat until they have been inspected visually.

For HTTP Cloud Run Chat apps, route accessory feedback clicks to the deployed
`/chat/events` endpoint and include the logical action name in
`parameters.actionName`. A named-only action can render in Chat but may not
reach the HTTP webhook unless the app framework explicitly maps that function
name. The live smoke harness uses the explicit endpoint form.
