import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCardActionWebhookPlan,
  loadCardActionWebhookSmokeConfig,
  runCardActionWebhookSmoke,
} from "./chat-card-action-webhook-smoke.mjs";

function smokeEnv(overrides = {}) {
  return {
    RUN_LIVE_CHAT_CARD_ACTION_WEBHOOK_SMOKE: "1",
    GOOGLE_CHAT_CARD_ACTION_WEBHOOK_SMOKE_RUN_ID: "card-action-webhook-test",
    GOOGLE_CHAT_WEBHOOK_URL: "https://example.test/api",
    ...overrides,
  };
}

function jsonResponse(json, status = 200) {
  return {
    status,
    async json() {
      return json;
    },
  };
}

function actionNameFromBody(body) {
  const payload = JSON.parse(body);
  return (
    payload.chat?.buttonClickedPayload?.action?.actionMethodName ??
    payload.commonEventObject?.parameters?.actionName
  );
}

function hasStateFromBody(body) {
  const payload = JSON.parse(body);
  return Boolean(
    payload.chat?.buttonClickedPayload?.action?.parameters?.some(
      (parameter) => parameter.key === "__googleChatAiState",
    ) || payload.commonEventObject?.parameters?.__googleChatAiState,
  );
}

function feedbackRatingFromBody(body) {
  const payload = JSON.parse(body);
  const parameter = payload.chat?.buttonClickedPayload?.action?.parameters?.find(
    (item) => item.key === "rating",
  );
  return parameter?.value ?? payload.commonEventObject?.parameters?.rating ?? null;
}

function responseForAction(actionName, { stateful = false, rating = null } = {}) {
  if (actionName === "googlechatai_sdk_card_mark_received") {
    return {
      hostAppDataAction: {
        chatDataAction: {
          updateMessageAction: {
            message: {
              cardsV2: [
                {
                  card: {
                    sections: [
                      {
                        widgets: [
                          {
                            decoratedText: {
                              text: stateful
                                ? "Button action received by the dev webhook. State decoded."
                                : "Button action received by the dev webhook.",
                            },
                          },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    };
  }

  if (actionName === "ai_visual_feedback") {
    const selectedIcon = rating === "not_helpful" ? "thumb_down" : "thumb_up";
    return {
      hostAppDataAction: {
        chatDataAction: {
          updateMessageAction: {
            message: {
              text: "[card-action-webhook-test] Answer smoke with low-impact accessory feedback controls.",
              accessoryWidgets: [
                {
                  buttonList: {
                    buttons: [
                      {
                        icon: { materialIcon: { name: "thumb_up", fill: true } },
                        type: "BORDERLESS",
                        ...(selectedIcon === "thumb_up"
                          ? {
                              color: {
                                red: 0.2,
                                green: 0.55,
                                blue: 0.25,
                                alpha: 1,
                              },
                            }
                          : {}),
                      },
                      {
                        icon: { materialIcon: { name: "thumb_down", fill: true } },
                        type: "BORDERLESS",
                        ...(selectedIcon === "thumb_down"
                          ? {
                              color: {
                                red: 0.75,
                                green: 0.25,
                                blue: 0.2,
                                alpha: 1,
                              },
                            }
                          : {}),
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    };
  }

  if (actionName === "googlechatai_sdk_card_open_dialog") {
    return {
      action: {
        navigations: [
          {
            pushCard: {
              header: { title: "Google Chat AI SDK Dialog Smoke" },
              sections: [{ widgets: [] }],
            },
          },
        ],
      },
    };
  }

  if (actionName === "googlechatai_sdk_card_navigation_next") {
    return {
      action: {
        navigations: [
          {
            pushCard: {
              header: { title: "Google Chat AI SDK Navigation Smoke" },
              sections: [{ widgets: [] }],
            },
          },
        ],
      },
    };
  }

  if (actionName === "googlechatai_sdk_card_navigation_update") {
    return {
      action: {
        navigations: [
          {
            updateCard: {
              header: { title: "Google Chat AI SDK Navigation Update Smoke" },
              sections: [{ widgets: [] }],
            },
          },
        ],
      },
    };
  }

  if (actionName === "googlechatai_sdk_card_submit_dialog") {
    return {
      hostAppDataAction: {
        chatDataAction: {
          createMessageAction: {
            message: {
              text: "[card-action-webhook-test] Dialog smoke submitted.",
            },
          },
        },
      },
    };
  }

  return {};
}

test("loadCardActionWebhookSmokeConfig refuses live run without explicit guard", () => {
  assert.throws(
    () =>
      loadCardActionWebhookSmokeConfig({
        argv: ["node", "chat-card-action-webhook-smoke.mjs"],
        env: { GOOGLE_CHAT_WEBHOOK_URL: "https://example.test/api" },
      }),
    /RUN_LIVE_CHAT_CARD_ACTION_WEBHOOK_SMOKE=1/,
  );
});

test("dry-run is allowed without guard and plans all action variants", () => {
  const config = loadCardActionWebhookSmokeConfig({
    argv: ["node", "chat-card-action-webhook-smoke.mjs", "--dry-run"],
    env: { GOOGLE_CHAT_WEBHOOK_URL: "https://example.test/api" },
  });
  const plan = buildCardActionWebhookPlan(config);

  assert.equal(config.webhookUrl, "https://example.test/api/chat/events");
  assert.deepEqual(plan.variants, [
    "mark_received",
    "stateful_mark_received",
    "open_dialog",
    "card_navigation_next",
    "card_navigation_update",
    "submit_dialog",
    "feedback_helpful",
    "feedback_not_helpful",
    "unknown_action",
    "cancel_dialog",
  ]);
  assert.deepEqual(
    plan.calls.map((call) => [call.operation, call.writes, call.responseShape]),
    [
      ["card-action-webhook.mark_received", false, "updateMessageAction"],
      [
        "card-action-webhook.stateful_mark_received",
        false,
        "updateMessageAction",
      ],
      ["card-action-webhook.open_dialog", false, "pushCard"],
      ["card-action-webhook.card_navigation_next", false, "pushCard"],
      ["card-action-webhook.card_navigation_update", false, "updateCard"],
      ["card-action-webhook.submit_dialog", false, "createMessageAction"],
      ["card-action-webhook.feedback_helpful", false, "updateMessageAction"],
      ["card-action-webhook.feedback_not_helpful", false, "updateMessageAction"],
      ["card-action-webhook.unknown_action", false, "emptyObject"],
      ["card-action-webhook.cancel_dialog", false, "emptyObject"],
    ],
  );
  assert.equal(plan.privacy.rawPayloadsSaved, false);
  assert.equal(plan.privacy.rawFormValuesSaved, false);
  assert.equal(plan.privacy.rawWebhookUrlSaved, false);
});

test("unknown variant is rejected before network access", () => {
  assert.throws(
    () =>
      loadCardActionWebhookSmokeConfig({
        argv: [
          "node",
          "chat-card-action-webhook-smoke.mjs",
          "--variant",
          "surprise",
        ],
        env: smokeEnv(),
      }),
    /Unknown variant: surprise/,
  );
});

test("runCardActionWebhookSmoke validates all response shapes and redacts evidence", async () => {
  const config = loadCardActionWebhookSmokeConfig({
    argv: ["node", "chat-card-action-webhook-smoke.mjs"],
    env: smokeEnv(),
  });
  const calls = [];
  const result = await runCardActionWebhookSmoke(config, {
    writeEvidence: false,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      return jsonResponse(
        responseForAction(actionNameFromBody(init.body), {
          stateful: hasStateFromBody(init.body),
          rating: feedbackRatingFromBody(init.body),
        }),
      );
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.evidence.responses.map((entry) => [
      entry.variant,
      entry.response.shape,
      entry.response.status,
    ]),
    [
      ["mark_received", "updateMessageAction", 200],
      ["stateful_mark_received", "updateMessageAction", 200],
      ["open_dialog", "pushCard", 200],
      ["card_navigation_next", "pushCard", 200],
      ["card_navigation_update", "updateCard", 200],
      ["submit_dialog", "createMessageAction", 200],
      ["feedback_helpful", "updateMessageAction", 200],
      ["feedback_not_helpful", "updateMessageAction", 200],
      ["unknown_action", "emptyObject", 200],
      ["cancel_dialog", "emptyObject", 200],
    ],
  );
  assert.equal(calls.length, 10);
  assert.equal(calls.every((call) => call.url.endsWith("/chat/events")), true);
  assert.equal(result.evidence.privacy.rawPayloadsSaved, false);
  assert.equal(result.evidence.privacy.rawFormValuesSaved, false);
  assert.equal(result.evidence.privacy.rawActionStateSaved, false);
  assert.equal(result.evidence.privacy.rawWebhookUrlSaved, false);
  assert.equal(result.evidence.privacy.chatMessagesSent, false);
  assert.equal(result.evidence.privacy.directMessagesSent, false);
  assert.equal(
    JSON.stringify(result.evidence).includes("redacted-direct-webhook-smoke"),
    false,
  );
  assert.equal(
    result.evidence.responses.find(
      (entry) => entry.variant === "stateful_mark_received",
    ).response.assertions.stateDecodedAcknowledged,
    true,
  );
  assert.equal(
    result.evidence.responses.find(
      (entry) => entry.variant === "card_navigation_next",
    ).response.assertions.navigationTitleMatches,
    true,
  );
  assert.equal(
    result.evidence.responses.find(
      (entry) => entry.variant === "card_navigation_update",
    ).response.assertions.updateCardHasCard,
    true,
  );
  assert.equal(
    result.evidence.responses.find(
      (entry) => entry.variant === "card_navigation_update",
    ).response.assertions.navigationTitleMatches,
    true,
  );
  assert.equal(
    result.evidence.responses.find((entry) => entry.variant === "feedback_helpful")
      .response.assertions.feedbackSelectedIconTinted,
    true,
  );
  assert.deepEqual(
    result.evidence.responses.find(
      (entry) => entry.variant === "feedback_not_helpful",
    ).response.accessoryWidgetSummary.selectedIconNames,
    ["thumb_down"],
  );
});

test("runCardActionWebhookSmoke fails on mismatched known response shape", async () => {
  const config = loadCardActionWebhookSmokeConfig({
    argv: [
      "node",
      "chat-card-action-webhook-smoke.mjs",
      "--variant",
      "open_dialog",
    ],
    env: smokeEnv(),
  });

  await assert.rejects(
    () =>
      runCardActionWebhookSmoke(config, {
        writeEvidence: false,
        async fetchImpl() {
          return jsonResponse({});
        },
      }),
    /open_dialog.expectedShape/,
  );
});

test("runCardActionWebhookSmoke fails on non-200 response", async () => {
  const config = loadCardActionWebhookSmokeConfig({
    argv: [
      "node",
      "chat-card-action-webhook-smoke.mjs",
      "--variant",
      "unknown_action",
    ],
    env: smokeEnv(),
  });

  await assert.rejects(
    () =>
      runCardActionWebhookSmoke(config, {
        writeEvidence: false,
        async fetchImpl() {
          return jsonResponse({}, 503);
        },
      }),
    /unknown_action.http-503/,
  );
});
