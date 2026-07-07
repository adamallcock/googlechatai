---
title: Feedback Reactions
date: 2026-07-03
type: guide
status: draft
---

# Feedback Reactions

The recommended low-impact feedback UI is an accessory widget attached to the
answer message: two borderless icon buttons, thumbs up and thumbs down, with no
extra card title or visible text labels. The reactions helper completes the
loop: after a feedback action is received and recorded, the app can add a
visible thumbs-up or thumbs-down reaction to the target answer message using the
submitting user's OAuth token.

Accessory buttons do not automatically change state after a user clicks them.
For visible completion, the app must handle the click and either return an
interaction update response or patch the message afterward. The live Cloud Run
webhook now handles `ai_feedback` and `ai_visual_feedback` actions by preserving
the original answer text and returning an update where the selected thumb button
is tinted.

This keeps two signals separate:

- Structured feedback for storage, analytics, and moderation workflows.
- Visible Chat feedback for everyone in the space.

## Visual Shape

Recommended answer message with accessory feedback controls:

```text
GoogleChatAISDK App
Answer text...

    [thumb_up icon] [thumb_down icon]
```

After the user chooses `Helpful`, the target answer message should also show the
standard Chat reaction chip:

```text
GoogleChatAISDK App
Answer text...

👍 1
```

For `Not helpful`, the chip is:

```text
GoogleChatAISDK App
Answer text...

👎 1
```

The existing live visual card smoke evidence showed the feedback buttons in
Google Chat at
`fixtures/live/evidence/chat-ui-ai-card-components-middle-20260704T0026Z.png`.
That older smoke used the heavier text-card version. Current visual smoke uses
`accessoryWidgets` with `BORDERLESS` Material icon buttons.

Live routing note: in this Cloud Run HTTP app, previously-created feedback
buttons that used only `function: "ai_visual_feedback"` rendered correctly but
did not produce a Cloud Run `/api/chat/events` request when clicked. The
recommended live shape is to point the action function at the deployed webhook
URL and pass the logical action name as a parameter:

```ts
const feedbackAction = {
  function: `${baseUrl}/chat/events`,
  parameters: {
    actionName: "ai_visual_feedback",
    responseId: "resp_123",
    targetMessage,
  },
};
```

The dev webhook accepts both direct Chat and Workspace add-on envelopes and
normalizes `commonEventObject.parameters.actionName` back into the SDK action
name.

## Node

```ts
import {
  buildFeedbackAccessoryMessage,
  planFeedbackReaction,
  summarizeCardAction,
} from "googlechatai";

const targetMessage = "spaces/AAA/messages/answer_123";
const baseUrl = "https://your-cloud-run-service.example.com/api";
const feedbackFunction = `${baseUrl}/chat/events`;

const answer = buildFeedbackAccessoryMessage({
  text: "Here is the concise answer.",
  responseId: "resp_123",
  upAction: {
    function: feedbackFunction,
    parameters: {
      actionName: "ai_feedback",
      responseId: "resp_123",
      targetMessage,
      rating: "helpful",
    },
  },
  downAction: {
    function: feedbackFunction,
    parameters: {
      actionName: "ai_feedback",
      responseId: "resp_123",
      targetMessage,
      rating: "not_helpful",
    },
  },
});

const action = summarizeCardAction(rawChatEvent);

await feedbackStore.record({
  responseId: action.parameters.responseId,
  targetMessage: action.parameters.targetMessage,
  rating: action.parameters.rating,
  actor: action.actor,
  eventTime: action.eventTime,
});

const reactionPlan = planFeedbackReaction({
  message: action.parameters.targetMessage,
  rating: action.parameters.rating,
  responseId: action.parameters.responseId,
  authMode: "user",
});

// Execute reactionPlan.requests[0] through the central user-auth Chat client.
// It should inherit token refresh, retries, rate-limit handling, and duplicate
// delivery guards from the transport layer.
```

## Python

```python
from googlechatai import (
    build_feedback_accessory_message,
    plan_feedback_reaction,
    summarize_card_action,
)

target_message = "spaces/AAA/messages/answer_123"
base_url = "https://your-cloud-run-service.example.com/api"
feedback_function = f"{base_url}/chat/events"

answer = build_feedback_accessory_message(
    {
        "text": "Here is the concise answer.",
        "responseId": "resp_123",
        "upAction": {
            "function": feedback_function,
            "parameters": {
                "actionName": "ai_feedback",
                "responseId": "resp_123",
                "targetMessage": target_message,
                "rating": "helpful",
            },
        },
        "downAction": {
            "function": feedback_function,
            "parameters": {
                "actionName": "ai_feedback",
                "responseId": "resp_123",
                "targetMessage": target_message,
                "rating": "not_helpful",
            },
        },
    }
)

action = summarize_card_action(raw_chat_event)

feedback_store.record(
    {
        "responseId": action["parameters"]["responseId"],
        "targetMessage": action["parameters"]["targetMessage"],
        "rating": action["parameters"]["rating"],
        "actor": action["actor"],
        "eventTime": action["eventTime"],
    }
)

reaction_plan = plan_feedback_reaction(
    {
        "message": action["parameters"]["targetMessage"],
        "rating": action["parameters"]["rating"],
        "responseId": action["parameters"]["responseId"],
        "authMode": "user",
    }
)
```

## Reaction Primitives

The reaction module exposes lower-level planners for callers that want to add,
list, or delete reactions directly:

```ts
import {
  buildReactionFilterForEmoji,
  planAddReaction,
  planDeleteReaction,
  planListReactions,
} from "googlechatai";

const add = planAddReaction({
  message: "spaces/AAA/messages/BBB",
  emoji: "👍",
  authMode: "user",
});

const list = planListReactions({
  message: "spaces/AAA/messages/BBB",
  filter: buildReactionFilterForEmoji("👍"),
  pageSize: 50,
  authMode: "user",
});

const remove = planDeleteReaction({
  reaction: "spaces/AAA/messages/BBB/reactions/CCC",
  authMode: "user",
});
```

The planners are dry-run descriptions. Live execution should stay behind the
same guarded user-auth HTTP client used by other Chat operations, so refresh,
retry, backoff, and idempotency behavior remains centralized.

## Heavier Card Variant

`buildFeedbackCard` / `build_feedback_card` remains available for workflows that
need visible text labels or a comment action. For ordinary AI answers, prefer
the accessory-widget builder because Google Chat documents accessory widgets as
the bottom-of-message surface for rating message accuracy or satisfaction.

## Auth Boundary

Use user auth for feedback reactions. Google Chat returns these reactions as
actions taken by the authenticated user, which is exactly what the visible
feedback signal needs. App auth is reported as unavailable in the plan so a bot
does not silently create feedback on behalf of a human.

Relevant Google Chat API surfaces:

- `spaces.messages.reactions.create`
- `spaces.messages.reactions.list`
- `spaces.messages.reactions.delete`

The SDK uses the already live-tested project scopes:

- `https://www.googleapis.com/auth/chat.messages.reactions`
- `https://www.googleapis.com/auth/chat.messages.reactions.readonly`
