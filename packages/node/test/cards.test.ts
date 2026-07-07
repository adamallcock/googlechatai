import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CARD_ACTION_STATE_PARAMETER,
  buildApprovalCard,
  buildCardNavigationResponse,
  buildCardMessage,
  buildCreateMessageResponse,
  buildDialog,
  buildErrorCard,
  buildFeedbackAccessoryMessage,
  buildFeedbackAccessoryWidgets,
  buildFeedbackCard,
  buildOpenDialogResponse,
  buildProgressCard,
  buildSourcesCard,
  buildStreamingStatusCard,
  buildThinkingCard,
  buildToolStatusCard,
  buildUpdateCardResponse,
  decodeCardActionState,
  encodeCardActionState,
  lintCardPayload,
  pushCard,
  readCardActionState,
  renderCardActionNote,
  routeCardAction,
  summarizeCardAction,
  summarizeCards,
  translateCardPayload,
  updateCard,
  validateCardMessage,
  withCardActionState,
} from "../src/index.js";

const root = path.resolve(import.meta.dirname, "../../..");

function readJson<T = unknown>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")) as T;
}

function cardLintCase(id: string): {
  input: { payload: unknown; options: Record<string, unknown> };
  expect: { fixture: string };
} {
  const cases = readJson<Array<{
    id: string;
    input: { payload: unknown; options: Record<string, unknown> };
    expect: { fixture: string };
  }>>("conformance/cases/cards.lint.json");
  const found = cases.find((item) => item.id === id);

  if (!found) {
    throw new Error(`Missing card lint conformance case ${id}`);
  }

  return found;
}

describe("card builders", () => {
  it("builds a primitive card message while preserving raw widgets", () => {
    const input = readJson("fixtures/cards/builders/custom.json");
    const expected = readJson("fixtures/expected/cards/builders/custom.message.json");

    const actual = buildCardMessage(input);

    expect(actual).toEqual(expected);
    expect(validateCardMessage(actual)).toEqual({ ok: true, errors: [] });
  });

  it("builds multiple optional sections in one card", () => {
    const input = readJson("fixtures/cards/builders/sections.json");
    const expected = readJson("fixtures/expected/cards/builders/sections.message.json");

    const actual = buildCardMessage(input);

    expect(actual).toEqual(expected);
    expect(validateCardMessage(actual)).toEqual({ ok: true, errors: [] });
  });

  it("builds the shared approval card fixture with fallback text", () => {
    const input = readJson("fixtures/cards/builders/approval.json");
    const expected = readJson("fixtures/expected/cards/builders/approval.message.json");

    const actual = buildApprovalCard(input);

    expect(actual).toEqual(expected);
    expect(validateCardMessage(actual)).toEqual({ ok: true, errors: [] });
  });

  it("builds the shared progress card fixture with fallback text", () => {
    const input = readJson("fixtures/cards/builders/progress.json");
    const expected = readJson("fixtures/expected/cards/builders/progress.message.json");

    const actual = buildProgressCard(input);

    expect(actual).toEqual(expected);
    expect(validateCardMessage(actual)).toEqual({ ok: true, errors: [] });
  });

  it("builds the shared error card fixture with fallback text", () => {
    const input = readJson("fixtures/cards/builders/error.json");
    const expected = readJson("fixtures/expected/cards/builders/error.message.json");

    const actual = buildErrorCard(input);

    expect(actual).toEqual(expected);
    expect(validateCardMessage(actual)).toEqual({ ok: true, errors: [] });
  });

  it("builds a reusable AI feedback card with thumbs up and down actions", () => {
    const actual = buildFeedbackCard({
      cardId: "feedback",
      title: "Was this helpful?",
      responseId: "resp_123",
      upAction: {
        function: "ai_feedback",
        parameters: { rating: "up", responseId: "resp_123" },
      },
      downAction: {
        function: "ai_feedback",
        parameters: { rating: "down", responseId: "resp_123" },
      },
      commentAction: {
        function: "ai_feedback_comment",
        parameters: { responseId: "resp_123" },
      },
    });

    expect(actual.fallbackText).toBe(
      "Feedback requested for response resp_123. Actions: Helpful, Not helpful, Add comment.",
    );
    expect(actual.cardsV2[0]).toMatchObject({
      cardId: "feedback",
      card: {
        header: { title: "Was this helpful?", subtitle: "Feedback" },
        sections: [
          {
            widgets: [
              {
                buttonList: {
                  buttons: [
                    {
                      text: "Helpful",
                      onClick: {
                        action: {
                          function: "ai_feedback",
                          parameters: [
                            { key: "rating", value: "up" },
                            { key: "responseId", value: "resp_123" },
                          ],
                        },
                      },
                    },
                    {
                      text: "Not helpful",
                      onClick: {
                        action: {
                          function: "ai_feedback",
                          parameters: [
                            { key: "rating", value: "down" },
                            { key: "responseId", value: "resp_123" },
                          ],
                        },
                      },
                    },
                    {
                      text: "Add comment",
                      onClick: {
                        action: {
                          function: "ai_feedback_comment",
                          parameters: [{ key: "responseId", value: "resp_123" }],
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    });
    expect(validateCardMessage(actual)).toEqual({ ok: true, errors: [] });
  });

  it("builds low-impact accessory feedback controls with borderless thumb icons", () => {
    const widgets = buildFeedbackAccessoryWidgets({
      upAction: {
        function: "ai_feedback",
        parameters: { rating: "helpful", responseId: "resp_123" },
      },
      downAction: {
        function: "ai_feedback",
        parameters: { rating: "not_helpful", responseId: "resp_123" },
      },
    });

    expect(widgets).toEqual([
      {
        buttonList: {
          buttons: [
            {
              icon: {
                materialIcon: {
                  name: "thumb_up",
                  fill: true,
                },
              },
              altText: "Mark helpful",
              type: "BORDERLESS",
              onClick: {
                action: {
                  function: "ai_feedback",
                  parameters: [
                    { key: "rating", value: "helpful" },
                    { key: "responseId", value: "resp_123" },
                  ],
                },
              },
            },
            {
              icon: {
                materialIcon: {
                  name: "thumb_down",
                  fill: true,
                },
              },
              altText: "Mark not helpful",
              type: "BORDERLESS",
              onClick: {
                action: {
                  function: "ai_feedback",
                  parameters: [
                    { key: "rating", value: "not_helpful" },
                    { key: "responseId", value: "resp_123" },
                  ],
                },
              },
            },
          ],
        },
      },
    ]);

    expect(
      buildFeedbackAccessoryMessage({
        text: "Here is the concise answer.",
        upAction: {
          function: "ai_feedback",
          parameters: { rating: "helpful", responseId: "resp_123" },
        },
        downAction: {
          function: "ai_feedback",
          parameters: { rating: "not_helpful", responseId: "resp_123" },
        },
      }),
    ).toEqual({
      fallbackText: "Here is the concise answer.",
      text: "Here is the concise answer.",
      accessoryWidgets: widgets,
    });
  });

  it("builds an AI sources card with links and confidence metadata", () => {
    const actual = buildSourcesCard({
      cardId: "sources",
      title: "Sources",
      responseId: "resp_123",
      sources: [
        {
          title: "Design brief",
          url: "https://example.com/brief",
          label: "Google Doc",
          confidence: "high",
          snippet: "The product should show status transparently.",
        },
        {
          title: "Thread context",
          resourceName: "spaces/AAA/messages/BBB",
          label: "Chat",
        },
      ],
    });

    expect(actual.fallbackText).toBe(
      "Sources for response resp_123: Design brief, Thread context.",
    );
    expect(actual.cardsV2[0]).toMatchObject({
      card: {
        header: { title: "Sources", subtitle: "2 sources" },
        sections: [
          {
            widgets: [
              {
                decoratedText: {
                  topLabel: "Google Doc - high confidence",
                  text: "Design brief",
                  bottomLabel: "The product should show status transparently.",
                  button: {
                    text: "Open",
                    onClick: { openLink: { url: "https://example.com/brief" } },
                  },
                },
              },
              {
                decoratedText: {
                  topLabel: "Chat",
                  text: "Thread context",
                  bottomLabel: "spaces/AAA/messages/BBB",
                },
              },
            ],
          },
        ],
      },
    });
    expect(validateCardMessage(actual)).toEqual({ ok: true, errors: [] });
  });

  it("builds thinking, tool status, and streaming status cards for AI workflows", () => {
    const thinking = buildThinkingCard({
      cardId: "thinking",
      title: "Working on it",
      status: "thinking",
      detail: "Reading the thread and checking sources.",
      startedAt: "2026-07-03T20:00:00Z",
    });
    const tools = buildToolStatusCard({
      cardId: "tools",
      title: "Tool calls",
      tools: [
        { name: "search_docs", status: "running", detail: "Looking up policy" },
        { name: "read_thread", status: "complete", output: "12 messages read" },
        { name: "transcribe_audio", status: "blocked", detail: "No provider key" },
      ],
    });
    const streaming = buildStreamingStatusCard({
      cardId: "stream",
      title: "Streaming response",
      mode: "create_then_patch",
      status: "streaming",
      patchCount: 7,
      throttleMs: 750,
      finalAction: {
        function: "cancel_stream",
        parameters: { responseId: "resp_123" },
      },
    });

    expect(thinking.fallbackText).toBe(
      "Thinking: Working on it. Reading the thread and checking sources. Started at 2026-07-03T20:00:00Z.",
    );
    expect(tools.fallbackText).toBe(
      "Tool status: search_docs running. read_thread complete. transcribe_audio blocked.",
    );
    expect(streaming.fallbackText).toBe(
      "Streaming response: create_then_patch mode, streaming, 7 patch(es), throttle 750ms.",
    );
    for (const card of [thinking, tools, streaming]) {
      expect(validateCardMessage(card)).toEqual({ ok: true, errors: [] });
    }
  });

  it("builds the shared dialog fixture with fallback text", () => {
    const input = readJson("fixtures/cards/builders/dialog.json");
    const expected = readJson("fixtures/expected/cards/builders/dialog.response.json");

    expect(buildDialog(input)).toEqual(expected);
  });

  it("wraps live Chat add-on card action response envelopes", () => {
    const input = readJson<{
      updateMessage: Record<string, unknown>;
      dialog: Record<string, unknown>;
      rawDialogCard: Record<string, unknown>;
    }>("fixtures/cards/builders/action-responses.json");
    const expected = readJson<Record<string, unknown>>(
      "fixtures/expected/cards/builders/action-responses.json",
    );

    expect(buildUpdateCardResponse(input.updateMessage)).toEqual(
      expected.updateCardResponse,
    );
    expect(buildCreateMessageResponse("Created from a card action.")).toEqual(
      expected.createTextMessageResponse,
    );
    expect(
      buildCreateMessageResponse({
        text: "Created from a message object.",
        thread: { name: "spaces/AAA/threads/BBB" },
      }),
    ).toEqual(expected.createMessageResponse);
    expect(buildOpenDialogResponse(input.dialog)).toEqual(expected.openDialogResponse);
    expect(buildOpenDialogResponse(input.rawDialogCard)).toEqual(
      expected.openRawDialogResponse,
    );
  });

  it("builds shared card navigation response envelopes", () => {
    const input = readJson<{
      push: Record<string, unknown>;
      update: Record<string, unknown>;
    }>("fixtures/cards/builders/navigation.json");
    const expected = readJson<Record<string, unknown>>(
      "fixtures/expected/cards/builders/navigation.response.json",
    );

    const pushStep = pushCard(input.push);
    const updateStep = updateCard(input.update);

    expect(pushStep).toEqual(expected.pushStep);
    expect(updateStep).toEqual(expected.updateStep);
    expect(buildCardNavigationResponse([pushStep, updateStep])).toEqual(
      expected.navigationResponse,
    );
  });

  it("encodes hidden card action state for dialog and button round trips", () => {
    const input = readJson<{
      action: { function: string; parameters: Record<string, string> };
      state: Record<string, unknown>;
      event: Record<string, unknown>;
    }>("fixtures/cards/builders/stateful-action.json");
    const expected = readJson<Record<string, unknown>>(
      "fixtures/expected/cards/builders/stateful-action.json",
    );

    expect(DEFAULT_CARD_ACTION_STATE_PARAMETER).toBe(expected.stateParameterName);
    expect(encodeCardActionState(input.state)).toBe(expected.encodedState);
    expect(decodeCardActionState(String(expected.encodedState))).toEqual(input.state);
    expect(withCardActionState(input.action, input.state)).toEqual(
      expected.actionWithState,
    );
    expect(readCardActionState(input.event)).toEqual(input.state);
  });

  it("routes card actions by method, action type, and unknown fallback", () => {
    const input = readJson<{
      event: Record<string, unknown>;
    }>("fixtures/cards/builders/stateful-action.json");
    const expected = readJson<{
      route: Record<string, unknown>;
      fallbackRoute: Record<string, unknown>;
      unknownRoute: Record<string, unknown>;
    }>("fixtures/expected/cards/builders/stateful-action.json");

    const routed = routeCardAction(input.event, {
      methods: {
        approve_expense: (summary) => ({
          response: "approved",
          requestId: summary.parameters.requestId,
          cursor: (readCardActionState(summary) as { cursor: string }).cursor,
        }),
      },
      cardClick: () => "card-click-fallback",
      unknown: () => "unknown-action",
    });

    expect({
      matched: routed.matched,
      route: routed.route,
      result: routed.result,
    }).toEqual(expected.route);

    const fallback = routeCardAction(input.event, {
      cardClick: () => "card-click-fallback",
      unknown: () => "unknown-action",
    });
    expect({
      matched: fallback.matched,
      route: fallback.route,
      result: fallback.result,
    }).toEqual(expected.fallbackRoute);

    const unknown = routeCardAction(input.event, {
      unknown: () => "unknown-action",
    });
    expect({
      matched: unknown.matched,
      route: unknown.route,
      result: unknown.result,
    }).toEqual(expected.unknownRoute);
  });

  it("reports actionable card JSON validation errors", () => {
    const invalid = {
      fallbackText: "",
      text: "",
      cardsV2: [
        {
          cardId: "bad",
          card: {
            sections: [
              {
                widgets: [
                  {
                    buttonList: {
                      buttons: [{ text: "Broken" }],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    };

    expect(validateCardMessage(invalid)).toEqual({
      ok: false,
      errors: [
        "fallbackText is required",
        "text fallback is required",
        "cardsV2[0].card.header.title is required",
        "cardsV2[0].card.sections[0].widgets[0].buttonList.buttons[0].onClick.action.function or onClick.openLink.url is required",
      ],
    });
  });

  it("lints valid Chat message cards by surface profile", () => {
    const testCase = cardLintCase("cards.lint.valid-chat-message");
    const expected = readJson(testCase.expect.fixture);

    expect(lintCardPayload(testCase.input.payload, testCase.input.options)).toEqual(
      expected,
    );
  });

  it("lints mixed card envelopes with actionable profile-specific findings", () => {
    const testCase = cardLintCase("cards.lint.chat-message-mixed-envelope");
    const expected = readJson(testCase.expect.fixture);

    const actual = lintCardPayload(testCase.input.payload, testCase.input.options);

    expect(actual).toEqual(expected);
    expect(actual.findings.map((finding) => finding.code)).toEqual([
      "wrong_cards_field",
      "addon_envelope_on_chat_message",
      "accessory_attachment_conflict",
      "button_missing_onclick",
    ]);
  });

  it("lints Workspace add-on cards for endpoint-routed action functions", () => {
    const testCase = cardLintCase("cards.lint.addon-named-function");
    const expected = readJson(testCase.expect.fixture);

    expect(lintCardPayload(testCase.input.payload, testCase.input.options)).toEqual(
      expected,
    );
  });

  it("translates direct Chat update responses to Workspace add-on action envelopes", () => {
    const testCase = cardLintCase("cards.translate.direct-update-to-addon");
    const expected = readJson(testCase.expect.fixture);

    expect(translateCardPayload(testCase.input.payload, testCase.input.options)).toEqual(
      expected,
    );
  });
});

describe("card parsers and AI context notes", () => {
  it("summarizes inbound card JSON for model context", () => {
    const raw = readJson<{ cardsV2: unknown[] }>("fixtures/cards/inbound/message-with-card.json");
    const expected = readJson("fixtures/expected/cards/inbound/message-with-card.summary.json");

    expect(summarizeCards(raw.cardsV2)).toEqual(expected);
  });

  it("summarizes optional section headers, fields, actions, and links", () => {
    const built = readJson<{ cardsV2: unknown[] }>(
      "fixtures/expected/cards/builders/sections.message.json",
    );
    const expected = readJson("fixtures/expected/cards/inbound/sections.summary.json");

    expect(summarizeCards(built.cardsV2)).toEqual(expected);
  });

  it("summarizes rich Cards V2 widgets for model context", () => {
    const raw = readJson<{ cardsV2: unknown[] }>("fixtures/cards/inbound/rich-widgets.json");
    const expected = readJson("fixtures/expected/cards/inbound/rich-widgets.summary.json");

    expect(summarizeCards(raw.cardsV2)).toEqual(expected);
  });

  it.each([
    ["card-click"],
    ["dialog-submit"],
    ["widget-update"],
  ])("renders deterministic AI context notes for %s", (fixtureName) => {
    const raw = readJson(`fixtures/cards/inbound/${fixtureName}.json`);
    const expected = readJson(`fixtures/expected/cards/inbound/${fixtureName}.action.json`);
    const summary = summarizeCardAction(raw);

    expect({
      summary,
      note: renderCardActionNote(summary),
    }).toEqual(expected);
  });
});
