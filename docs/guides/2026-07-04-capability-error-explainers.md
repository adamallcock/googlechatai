---
title: Capability And Error Explainers
date: 2026-07-04
type: guide
status: implemented
---

# Capability And Error Explainers

Use the capability explainers before attempting live Google Chat work. They
turn auth, scope, membership, retry, and idempotency rules into plain data for
developers, tools, and AI agents.

## Node

```ts
import {
  explainChatCapability,
  explainGoogleChatError,
  planChatPermission,
} from "googlechatai";

const reply = explainChatCapability("messages.reply", { principal: "app" });

const reaction = planChatPermission("reactions.add", { principal: "app" });

const error = explainGoogleChatError(
  {
    httpStatus: 403,
    body: {
      error: {
        status: "PERMISSION_DENIED",
        message: "Request had insufficient authentication scopes.",
      },
    },
  },
  {
    intent: "messages.read_context",
    principal: "user",
    requiredScopes: [
      "https://www.googleapis.com/auth/chat.messages.readonly",
    ],
  },
);
```

## Python

```python
from googlechatai import (
    explain_chat_capability,
    explain_google_chat_error,
    plan_chat_permission,
)

reply = explain_chat_capability("messages.reply", {"principal": "app"})
reaction = plan_chat_permission("reactions.add", {"principal": "app"})
error = explain_google_chat_error(
    {
        "httpStatus": 403,
        "body": {
            "error": {
                "status": "PERMISSION_DENIED",
                "message": "Request had insufficient authentication scopes.",
            }
        },
    },
    {
        "intent": "messages.read_context",
        "principal": "user",
        "requiredScopes": [
            "https://www.googleapis.com/auth/chat.messages.readonly"
        ],
    },
)
```

## What The Explainers Return

Capability records include:

- principal and supported principals;
- required scopes;
- admin/user-consent posture;
- membership requirements;
- read/write risk;
- idempotency and retry policy;
- live-safety posture;
- known limitations and remediation.

Error explanations classify common Google Chat failures such as missing scopes,
auth required, rate limits, not found, conflicts, invalid request shapes, and
retryable Google 5xx errors.

The default product path remains installed-user and user-authorized for
user-agency operations. Domain-wide delegation is not a generic fix.
