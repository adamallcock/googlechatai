import json
import pathlib
import unittest

from googlechatai import (
    DEFAULT_CARD_ACTION_STATE_PARAMETER,
    build_approval_card,
    build_card_navigation_response,
    build_card_message,
    build_create_message_response,
    build_dialog,
    build_error_card,
    build_feedback_accessory_message,
    build_feedback_accessory_widgets,
    build_feedback_card,
    build_open_dialog_response,
    build_progress_card,
    build_sources_card,
    build_streaming_status_card,
    build_thinking_card,
    build_tool_status_card,
    build_update_card_response,
    decode_card_action_state,
    encode_card_action_state,
    lint_card_payload,
    push_card,
    read_card_action_state,
    render_card_action_note,
    route_card_action,
    summarize_card_action,
    summarize_cards,
    translate_card_payload,
    update_card,
    validate_card_message,
    with_card_action_state,
)


ROOT = pathlib.Path(__file__).resolve().parents[3]


def read_json(relative_path: str):
    return json.loads((ROOT / relative_path).read_text(encoding="utf-8"))


def card_lint_case(case_id: str):
    cases = read_json("conformance/cases/cards.lint.json")
    for item in cases:
        if item["id"] == case_id:
            return item
    raise AssertionError(f"Missing card lint conformance case {case_id}")


class CardBuilderTests(unittest.TestCase):
    def test_builds_primitive_card_message_while_preserving_raw_widgets(self) -> None:
        input_payload = read_json("fixtures/cards/builders/custom.json")
        expected = read_json("fixtures/expected/cards/builders/custom.message.json")
        actual = build_card_message(input_payload)

        self.assertEqual(actual, expected)
        self.assertEqual(validate_card_message(actual), {"ok": True, "errors": []})

    def test_builds_multiple_optional_sections_in_one_card(self) -> None:
        input_payload = read_json("fixtures/cards/builders/sections.json")
        expected = read_json("fixtures/expected/cards/builders/sections.message.json")
        actual = build_card_message(input_payload)

        self.assertEqual(actual, expected)
        self.assertEqual(validate_card_message(actual), {"ok": True, "errors": []})

    def test_builds_shared_approval_card_fixture_with_fallback_text(self) -> None:
        input_payload = read_json("fixtures/cards/builders/approval.json")
        expected = read_json("fixtures/expected/cards/builders/approval.message.json")
        actual = build_approval_card(input_payload)

        self.assertEqual(actual, expected)
        self.assertEqual(validate_card_message(actual), {"ok": True, "errors": []})

    def test_builds_shared_progress_card_fixture_with_fallback_text(self) -> None:
        input_payload = read_json("fixtures/cards/builders/progress.json")
        expected = read_json("fixtures/expected/cards/builders/progress.message.json")
        actual = build_progress_card(input_payload)

        self.assertEqual(actual, expected)
        self.assertEqual(validate_card_message(actual), {"ok": True, "errors": []})

    def test_builds_shared_error_card_fixture_with_fallback_text(self) -> None:
        input_payload = read_json("fixtures/cards/builders/error.json")
        expected = read_json("fixtures/expected/cards/builders/error.message.json")
        actual = build_error_card(input_payload)

        self.assertEqual(actual, expected)
        self.assertEqual(validate_card_message(actual), {"ok": True, "errors": []})

    def test_builds_reusable_ai_feedback_card_with_thumbs_actions(self) -> None:
        actual = build_feedback_card(
            {
                "cardId": "feedback",
                "title": "Was this helpful?",
                "responseId": "resp_123",
                "upAction": {
                    "function": "ai_feedback",
                    "parameters": {"rating": "up", "responseId": "resp_123"},
                },
                "downAction": {
                    "function": "ai_feedback",
                    "parameters": {"rating": "down", "responseId": "resp_123"},
                },
                "commentAction": {
                    "function": "ai_feedback_comment",
                    "parameters": {"responseId": "resp_123"},
                },
            }
        )

        self.assertEqual(
            actual["fallbackText"],
            "Feedback requested for response resp_123. Actions: Helpful, Not helpful, Add comment.",
        )
        self.assertEqual(
            actual["cardsV2"][0]["card"]["sections"][0]["widgets"][0]["buttonList"]["buttons"],
            [
                {
                    "text": "Helpful",
                    "onClick": {
                        "action": {
                            "function": "ai_feedback",
                            "parameters": [
                                {"key": "rating", "value": "up"},
                                {"key": "responseId", "value": "resp_123"},
                            ],
                        }
                    },
                },
                {
                    "text": "Not helpful",
                    "onClick": {
                        "action": {
                            "function": "ai_feedback",
                            "parameters": [
                                {"key": "rating", "value": "down"},
                                {"key": "responseId", "value": "resp_123"},
                            ],
                        }
                    },
                },
                {
                    "text": "Add comment",
                    "onClick": {
                        "action": {
                            "function": "ai_feedback_comment",
                            "parameters": [{"key": "responseId", "value": "resp_123"}],
                        }
                    },
                },
            ],
        )
        self.assertEqual(validate_card_message(actual), {"ok": True, "errors": []})

    def test_builds_low_impact_accessory_feedback_controls(self) -> None:
        widgets = build_feedback_accessory_widgets(
            {
                "upAction": {
                    "function": "ai_feedback",
                    "parameters": {"rating": "helpful", "responseId": "resp_123"},
                },
                "downAction": {
                    "function": "ai_feedback",
                    "parameters": {"rating": "not_helpful", "responseId": "resp_123"},
                },
            }
        )

        self.assertEqual(
            widgets,
            [
                {
                    "buttonList": {
                        "buttons": [
                            {
                                "icon": {
                                    "materialIcon": {
                                        "name": "thumb_up",
                                        "fill": True,
                                    }
                                },
                                "altText": "Mark helpful",
                                "type": "BORDERLESS",
                                "onClick": {
                                    "action": {
                                        "function": "ai_feedback",
                                        "parameters": [
                                            {"key": "rating", "value": "helpful"},
                                            {"key": "responseId", "value": "resp_123"},
                                        ],
                                    }
                                },
                            },
                            {
                                "icon": {
                                    "materialIcon": {
                                        "name": "thumb_down",
                                        "fill": True,
                                    }
                                },
                                "altText": "Mark not helpful",
                                "type": "BORDERLESS",
                                "onClick": {
                                    "action": {
                                        "function": "ai_feedback",
                                        "parameters": [
                                            {"key": "rating", "value": "not_helpful"},
                                            {"key": "responseId", "value": "resp_123"},
                                        ],
                                    }
                                },
                            },
                        ]
                    }
                }
            ],
        )
        self.assertEqual(
            build_feedback_accessory_message(
                {
                    "text": "Here is the concise answer.",
                    "upAction": {
                        "function": "ai_feedback",
                        "parameters": {"rating": "helpful", "responseId": "resp_123"},
                    },
                    "downAction": {
                        "function": "ai_feedback",
                        "parameters": {
                            "rating": "not_helpful",
                            "responseId": "resp_123",
                        },
                    },
                }
            ),
            {
                "fallbackText": "Here is the concise answer.",
                "text": "Here is the concise answer.",
                "accessoryWidgets": widgets,
            },
        )

    def test_builds_ai_sources_card_with_links_and_confidence_metadata(self) -> None:
        actual = build_sources_card(
            {
                "cardId": "sources",
                "title": "Sources",
                "responseId": "resp_123",
                "sources": [
                    {
                        "title": "Design brief",
                        "url": "https://example.com/brief",
                        "label": "Google Doc",
                        "confidence": "high",
                        "snippet": "The product should show status transparently.",
                    },
                    {
                        "title": "Thread context",
                        "resourceName": "spaces/AAA/messages/BBB",
                        "label": "Chat",
                    },
                ],
            }
        )

        self.assertEqual(
            actual["fallbackText"],
            "Sources for response resp_123: Design brief, Thread context.",
        )
        self.assertEqual(
            actual["cardsV2"][0]["card"]["sections"][0]["widgets"],
            [
                {
                    "decoratedText": {
                        "topLabel": "Google Doc - high confidence",
                        "text": "Design brief",
                        "bottomLabel": "The product should show status transparently.",
                        "button": {
                            "text": "Open",
                            "onClick": {
                                "openLink": {"url": "https://example.com/brief"}
                            },
                        },
                    }
                },
                {
                    "decoratedText": {
                        "topLabel": "Chat",
                        "text": "Thread context",
                        "bottomLabel": "spaces/AAA/messages/BBB",
                    }
                },
            ],
        )
        self.assertEqual(validate_card_message(actual), {"ok": True, "errors": []})

    def test_builds_thinking_tool_and_streaming_status_cards_for_ai_workflows(self) -> None:
        thinking = build_thinking_card(
            {
                "cardId": "thinking",
                "title": "Working on it",
                "status": "thinking",
                "detail": "Reading the thread and checking sources.",
                "startedAt": "2026-07-03T20:00:00Z",
            }
        )
        tools = build_tool_status_card(
            {
                "cardId": "tools",
                "title": "Tool calls",
                "tools": [
                    {"name": "search_docs", "status": "running", "detail": "Looking up policy"},
                    {"name": "read_thread", "status": "complete", "output": "12 messages read"},
                    {"name": "transcribe_audio", "status": "blocked", "detail": "No provider key"},
                ],
            }
        )
        streaming = build_streaming_status_card(
            {
                "cardId": "stream",
                "title": "Streaming response",
                "mode": "create_then_patch",
                "status": "streaming",
                "patchCount": 7,
                "throttleMs": 750,
                "finalAction": {
                    "function": "cancel_stream",
                    "parameters": {"responseId": "resp_123"},
                },
            }
        )

        self.assertEqual(
            thinking["fallbackText"],
            "Thinking: Working on it. Reading the thread and checking sources. Started at 2026-07-03T20:00:00Z.",
        )
        self.assertEqual(
            tools["fallbackText"],
            "Tool status: search_docs running. read_thread complete. transcribe_audio blocked.",
        )
        self.assertEqual(
            streaming["fallbackText"],
            "Streaming response: create_then_patch mode, streaming, 7 patch(es), throttle 750ms.",
        )
        for card in [thinking, tools, streaming]:
            self.assertEqual(validate_card_message(card), {"ok": True, "errors": []})

    def test_builds_shared_dialog_fixture_with_fallback_text(self) -> None:
        input_payload = read_json("fixtures/cards/builders/dialog.json")
        expected = read_json("fixtures/expected/cards/builders/dialog.response.json")

        self.assertEqual(build_dialog(input_payload), expected)

    def test_wraps_live_chat_addon_card_action_response_envelopes(self) -> None:
        input_payload = read_json("fixtures/cards/builders/action-responses.json")
        expected = read_json("fixtures/expected/cards/builders/action-responses.json")

        self.assertEqual(
            build_update_card_response(input_payload["updateMessage"]),
            expected["updateCardResponse"],
        )
        self.assertEqual(
            build_create_message_response("Created from a card action."),
            expected["createTextMessageResponse"],
        )
        self.assertEqual(
            build_create_message_response(
                {
                    "text": "Created from a message object.",
                    "thread": {"name": "spaces/AAA/threads/BBB"},
                }
            ),
            expected["createMessageResponse"],
        )
        self.assertEqual(
            build_open_dialog_response(input_payload["dialog"]),
            expected["openDialogResponse"],
        )
        self.assertEqual(
            build_open_dialog_response(input_payload["rawDialogCard"]),
            expected["openRawDialogResponse"],
        )

    def test_builds_shared_card_navigation_response_envelopes(self) -> None:
        input_payload = read_json("fixtures/cards/builders/navigation.json")
        expected = read_json("fixtures/expected/cards/builders/navigation.response.json")
        push_step = push_card(input_payload["push"])
        update_step = update_card(input_payload["update"])

        self.assertEqual(push_step, expected["pushStep"])
        self.assertEqual(update_step, expected["updateStep"])
        self.assertEqual(
            build_card_navigation_response([push_step, update_step]),
            expected["navigationResponse"],
        )

    def test_encodes_hidden_card_action_state_for_dialog_and_button_round_trips(self) -> None:
        input_payload = read_json("fixtures/cards/builders/stateful-action.json")
        expected = read_json("fixtures/expected/cards/builders/stateful-action.json")

        self.assertEqual(
            DEFAULT_CARD_ACTION_STATE_PARAMETER,
            expected["stateParameterName"],
        )
        self.assertEqual(
            encode_card_action_state(input_payload["state"]),
            expected["encodedState"],
        )
        self.assertEqual(
            decode_card_action_state(expected["encodedState"]),
            input_payload["state"],
        )
        self.assertEqual(
            with_card_action_state(input_payload["action"], input_payload["state"]),
            expected["actionWithState"],
        )
        self.assertEqual(
            read_card_action_state(input_payload["event"]),
            input_payload["state"],
        )

    def test_routes_card_actions_by_method_action_type_and_unknown_fallback(self) -> None:
        input_payload = read_json("fixtures/cards/builders/stateful-action.json")
        expected = read_json("fixtures/expected/cards/builders/stateful-action.json")

        routed = route_card_action(
            input_payload["event"],
            {
                "methods": {
                    "approve_expense": lambda summary: {
                        "response": "approved",
                        "requestId": summary["parameters"]["requestId"],
                        "cursor": read_card_action_state(summary)["cursor"],
                    }
                },
                "cardClick": lambda _summary: "card-click-fallback",
                "unknown": lambda _summary: "unknown-action",
            },
        )
        self.assertEqual(
            {
                "matched": routed["matched"],
                "route": routed["route"],
                "result": routed["result"],
            },
            expected["route"],
        )

        fallback = route_card_action(
            input_payload["event"],
            {
                "cardClick": lambda _summary: "card-click-fallback",
                "unknown": lambda _summary: "unknown-action",
            },
        )
        self.assertEqual(
            {
                "matched": fallback["matched"],
                "route": fallback["route"],
                "result": fallback["result"],
            },
            expected["fallbackRoute"],
        )

        unknown = route_card_action(
            input_payload["event"],
            {"unknown": lambda _summary: "unknown-action"},
        )
        self.assertEqual(
            {
                "matched": unknown["matched"],
                "route": unknown["route"],
                "result": unknown["result"],
            },
            expected["unknownRoute"],
        )

    def test_reports_actionable_card_json_validation_errors(self) -> None:
        invalid = {
            "fallbackText": "",
            "text": "",
            "cardsV2": [
                {
                    "cardId": "bad",
                    "card": {
                        "sections": [
                            {
                                "widgets": [
                                    {
                                        "buttonList": {
                                            "buttons": [{"text": "Broken"}],
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                },
            ],
        }

        self.assertEqual(
            validate_card_message(invalid),
            {
                "ok": False,
                "errors": [
                    "fallbackText is required",
                    "text fallback is required",
                    "cardsV2[0].card.header.title is required",
                    "cardsV2[0].card.sections[0].widgets[0].buttonList.buttons[0].onClick.action.function or onClick.openLink.url is required",
                ],
            },
        )

    def test_lints_valid_chat_message_cards_by_surface_profile(self) -> None:
        case = card_lint_case("cards.lint.valid-chat-message")
        expected = read_json(case["expect"]["fixture"])

        self.assertEqual(
            lint_card_payload(case["input"]["payload"], case["input"]["options"]),
            expected,
        )

    def test_lints_mixed_card_envelopes_with_actionable_findings(self) -> None:
        case = card_lint_case("cards.lint.chat-message-mixed-envelope")
        expected = read_json(case["expect"]["fixture"])

        actual = lint_card_payload(case["input"]["payload"], case["input"]["options"])

        self.assertEqual(actual, expected)
        self.assertEqual(
            [finding["code"] for finding in actual["findings"]],
            [
                "wrong_cards_field",
                "addon_envelope_on_chat_message",
                "accessory_attachment_conflict",
                "button_missing_onclick",
            ],
        )

    def test_lints_workspace_addon_cards_for_endpoint_routed_actions(self) -> None:
        case = card_lint_case("cards.lint.addon-named-function")
        expected = read_json(case["expect"]["fixture"])

        self.assertEqual(
            lint_card_payload(case["input"]["payload"], case["input"]["options"]),
            expected,
        )

    def test_translates_direct_chat_update_response_to_addon_action_envelope(self) -> None:
        case = card_lint_case("cards.translate.direct-update-to-addon")
        expected = read_json(case["expect"]["fixture"])

        self.assertEqual(
            translate_card_payload(case["input"]["payload"], case["input"]["options"]),
            expected,
        )


class CardParserTests(unittest.TestCase):
    def test_summarizes_inbound_card_json_for_model_context(self) -> None:
        raw = read_json("fixtures/cards/inbound/message-with-card.json")
        expected = read_json("fixtures/expected/cards/inbound/message-with-card.summary.json")

        self.assertEqual(summarize_cards(raw["cardsV2"]), expected)

    def test_summarizes_optional_section_headers_fields_actions_and_links(self) -> None:
        built = read_json("fixtures/expected/cards/builders/sections.message.json")
        expected = read_json("fixtures/expected/cards/inbound/sections.summary.json")

        self.assertEqual(summarize_cards(built["cardsV2"]), expected)

    def test_summarizes_rich_cards_v2_widgets_for_model_context(self) -> None:
        raw = read_json("fixtures/cards/inbound/rich-widgets.json")
        expected = read_json("fixtures/expected/cards/inbound/rich-widgets.summary.json")

        self.assertEqual(summarize_cards(raw["cardsV2"]), expected)

    def test_renders_deterministic_ai_context_notes_for_card_actions(self) -> None:
        for fixture_name in ["card-click", "dialog-submit", "widget-update"]:
            with self.subTest(fixture_name=fixture_name):
                raw = read_json(f"fixtures/cards/inbound/{fixture_name}.json")
                expected = read_json(
                    f"fixtures/expected/cards/inbound/{fixture_name}.action.json"
                )
                summary = summarize_card_action(raw)

                self.assertEqual(
                    {
                        "summary": summary,
                        "note": render_card_action_note(summary),
                    },
                    expected,
                )


if __name__ == "__main__":
    unittest.main()
