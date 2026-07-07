"""Google Chat Cards v2 builders, parsers, and AI context notes."""

from __future__ import annotations

import base64
import json
from collections.abc import Mapping
from typing import Any


RawMapping = Mapping[str, Any]
DEFAULT_CARD_ACTION_STATE_PARAMETER = "__googleChatAiState"


def _as_mapping(value: Any) -> RawMapping | None:
    return value if isinstance(value, Mapping) else None


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _required_string(raw: RawMapping | None, key: str, fallback: str = "") -> str:
    return _as_string(raw.get(key)) if raw and isinstance(raw.get(key), str) else fallback


def _as_number(value: Any) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _clean_record(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if item is not None}


def _sorted_parameters(parameters: Any) -> list[dict[str, str]]:
    raw = _as_mapping(parameters)

    if not raw:
        return []

    return [
        {"key": key, "value": str(value)}
        for key, value in sorted(raw.items())
        if value is not None
    ]


def _sort_object(value: dict[str, str]) -> dict[str, str]:
    return {key: value[key] for key in sorted(value)}


def _parameters_object_from_array(parameters: Any) -> dict[str, str]:
    output: dict[str, str] = {}

    for item in _as_list(parameters):
        raw = _as_mapping(item)
        key = _as_string(raw.get("key")) if raw else None
        value = _as_string(raw.get("value")) if raw else None

        if key and value is not None:
            output[key] = value

    return _sort_object(output)


def _action_button(text: str, action: Any) -> dict[str, Any]:
    raw = _as_mapping(action)
    function_name = _required_string(raw, "function")

    return {
        "text": text,
        "onClick": {
            "action": {
                "function": function_name,
                "parameters": _sorted_parameters(raw.get("parameters") if raw else None),
            }
        },
    }


def _icon_action_button(
    icon_name: str,
    alt_text: str,
    action: Any,
    *,
    button_type: str,
    icon_fill: bool,
) -> dict[str, Any]:
    raw = _as_mapping(action)
    function_name = _required_string(raw, "function")

    return {
        "icon": {
            "materialIcon": {
                "name": icon_name,
                "fill": icon_fill,
            }
        },
        "altText": alt_text,
        "type": button_type,
        "onClick": {
            "action": {
                "function": function_name,
                "parameters": _sorted_parameters(raw.get("parameters") if raw else None),
            }
        },
    }


def _link_button(text: str, url: str) -> dict[str, Any]:
    return {
        "text": text,
        "onClick": {
            "openLink": {
                "url": url,
            }
        },
    }


def _button_from_option(button: Any) -> dict[str, Any] | None:
    raw = _as_mapping(button)
    text = _required_string(raw, "text")
    open_link = _as_string(raw.get("openLink")) if raw else None

    if not raw or not text:
        return None

    if open_link:
        return _link_button(text, open_link)

    return _action_button(text, raw.get("action"))


def _message_with_single_card(
    fallback_text: str,
    card_id: str,
    card: dict[str, Any],
) -> dict[str, Any]:
    return {
        "fallbackText": fallback_text,
        "text": fallback_text,
        "cardsV2": [
            {
                "cardId": card_id,
                "card": card,
            }
        ],
    }


def _section_text_items(value: Any) -> list[str]:
    direct = _as_string(value)

    if direct is not None:
        return [direct]

    return [item for item in _as_list(value) if isinstance(item, str)]


def _section_from_option(section: Any) -> dict[str, Any]:
    raw = _as_mapping(section)
    widgets: list[Any] = []

    for text in _section_text_items(raw.get("text") if raw else None):
        widgets.append({"textParagraph": {"text": text}})

    for field in _as_list(raw.get("fields") if raw else None):
        raw_field = _as_mapping(field)
        widgets.append(
            {
                "decoratedText": _clean_record(
                    {
                        "topLabel": _as_string(raw_field.get("label")) if raw_field else None,
                        "text": _as_string(raw_field.get("text")) if raw_field else None,
                    }
                )
            }
        )

    widgets.extend(_as_list(raw.get("widgets") if raw else None))

    buttons = [
        item
        for item in (_button_from_option(button) for button in _as_list(raw.get("buttons") if raw else None))
        if item is not None
    ]

    if buttons:
        widgets.append({"buttonList": {"buttons": buttons}})

    return _clean_record(
        {
            "header": _as_string(raw.get("header")) if raw else None,
            "collapsible": raw.get("collapsible")
            if raw and isinstance(raw.get("collapsible"), bool)
            else None,
            "uncollapsibleWidgetsCount": raw.get("uncollapsibleWidgetsCount")
            if raw and isinstance(raw.get("uncollapsibleWidgetsCount"), int)
            else None,
            "widgets": widgets,
        }
    )


def build_card_message(options: Any) -> dict[str, Any]:
    raw = _as_mapping(options)
    title = _required_string(raw, "title")
    subtitle = _as_string(raw.get("subtitle")) if raw else None
    card_id = _required_string(raw, "cardId", "card")
    fallback_text = _required_string(raw, "fallbackText") or f"{title or card_id} card."
    raw_card = _as_mapping(raw.get("card")) if raw else None

    if raw_card:
        return _message_with_single_card(fallback_text, card_id, dict(raw_card))

    raw_sections = _as_list(raw.get("sections") if raw else None)
    sections = (
        [_section_from_option(section) for section in raw_sections]
        if raw_sections
        else [_section_from_option({"widgets": _as_list(raw.get("widgets") if raw else None)})]
    )

    return _message_with_single_card(
        fallback_text,
        card_id,
        {
            "header": _clean_record({"title": title, "subtitle": subtitle}),
            "sections": sections,
        },
    )


def build_approval_card(options: Any) -> dict[str, Any]:
    raw = _as_mapping(options)
    title = _required_string(raw, "title")
    subtitle = _as_string(raw.get("subtitle")) if raw else None
    body = _required_string(raw, "body")
    approve_label = _required_string(raw, "approveLabel", "Approve")
    reject_label = _required_string(raw, "rejectLabel", "Reject")
    card_id = _required_string(raw, "cardId", "approval")
    fallback_text = (
        f"Approval requested: {title} {body} "
        f"Actions: {approve_label}, {reject_label}."
    )

    return _message_with_single_card(
        fallback_text,
        card_id,
        {
            "header": _clean_record({"title": title, "subtitle": subtitle}),
            "sections": [
                {
                    "widgets": [
                        {"textParagraph": {"text": body}},
                        {
                            "buttonList": {
                                "buttons": [
                                    _action_button(
                                        approve_label,
                                        raw.get("approveAction") if raw else None,
                                    ),
                                    _action_button(
                                        reject_label,
                                        raw.get("rejectAction") if raw else None,
                                    ),
                                ]
                            }
                        },
                    ]
                }
            ],
        },
    )


def _step_status_label(status: str) -> str:
    if status == "complete":
        return "Completed"
    if status == "active":
        return "In progress"
    return "Pending"


def build_progress_card(options: Any) -> dict[str, Any]:
    raw = _as_mapping(options)
    title = _required_string(raw, "title")
    subtitle = _as_string(raw.get("subtitle")) if raw else None
    detail = _as_string(raw.get("detail")) if raw else None
    card_id = _required_string(raw, "cardId", "progress")
    percent = raw.get("percent") if raw and isinstance(raw.get("percent"), int | float) else None
    steps = [
        item
        for item in (_as_mapping(step) for step in _as_list(raw.get("steps") if raw else None))
        if item is not None
    ]
    fallback_parts = [f"Progress: {title}."]

    if percent is not None:
        fallback_parts.append(f"{percent}% complete.")

    for step in steps:
        status = _required_string(step, "status", "pending")
        fallback_parts.append(f"{_step_status_label(status)}: {_required_string(step, 'label')}.")

    widgets: list[dict[str, Any]] = []

    if detail:
        widgets.append({"textParagraph": {"text": detail}})

    if percent is not None:
        widgets.append(
            {
                "decoratedText": {
                    "topLabel": "PROGRESS",
                    "text": f"{percent}% complete",
                }
            }
        )

    for step in steps:
        status = _required_string(step, "status", "pending")
        widgets.append(
            {
                "decoratedText": {
                    "topLabel": status.upper(),
                    "text": _required_string(step, "label"),
                }
            }
        )

    cancel_action = raw.get("cancelAction") if raw else None
    if _as_mapping(cancel_action):
        widgets.append(
            {
                "buttonList": {
                    "buttons": [_action_button("Cancel", cancel_action)],
                }
            }
        )

    return _message_with_single_card(
        " ".join(fallback_parts),
        card_id,
        {
            "header": _clean_record({"title": title, "subtitle": subtitle}),
            "sections": [{"widgets": widgets}],
        },
    )


def build_error_card(options: Any) -> dict[str, Any]:
    raw = _as_mapping(options)
    title = _required_string(raw, "title")
    message = _required_string(raw, "message")
    details = _as_string(raw.get("details")) if raw else None
    card_id = _required_string(raw, "cardId", "error")
    fallback_parts = [f"Error: {title}.", message]
    widgets: list[dict[str, Any]] = [{"textParagraph": {"text": message}}]

    if details:
        fallback_parts.append(f"Details: {details}")
        widgets.append({"decoratedText": {"topLabel": "DETAILS", "text": details}})

    retry_action = raw.get("retryAction") if raw else None
    if _as_mapping(retry_action):
        fallback_parts.append("Action: Retry.")
        widgets.append(
            {
                "buttonList": {
                    "buttons": [_action_button("Retry", retry_action)],
                }
            }
        )

    return _message_with_single_card(
        " ".join(fallback_parts),
        card_id,
        {
            "header": {"title": title, "subtitle": "Error"},
            "sections": [{"widgets": widgets}],
        },
    )


def build_feedback_card(options: Any) -> dict[str, Any]:
    raw = _as_mapping(options)
    title = _required_string(raw, "title", "Was this helpful?")
    subtitle = _as_string(raw.get("subtitle")) if raw else None
    card_id = _required_string(raw, "cardId", "feedback")
    response_id = _as_string(raw.get("responseId")) if raw else None
    helpful_label = _required_string(raw, "helpfulLabel", "Helpful")
    not_helpful_label = _required_string(raw, "notHelpfulLabel", "Not helpful")
    comment_label = _required_string(raw, "commentLabel", "Add comment")
    buttons = [
        _action_button(helpful_label, raw.get("upAction") if raw else None),
        _action_button(not_helpful_label, raw.get("downAction") if raw else None),
    ]
    actions = [helpful_label, not_helpful_label]

    comment_action = raw.get("commentAction") if raw else None
    if _as_mapping(comment_action):
        buttons.append(_action_button(comment_label, comment_action))
        actions.append(comment_label)

    subject = f"response {response_id}" if response_id else "this response"
    return _message_with_single_card(
        f"Feedback requested for {subject}. Actions: {', '.join(actions)}.",
        card_id,
        {
            "header": _clean_record(
                {
                    "title": title,
                    "subtitle": subtitle or "Feedback",
                }
            ),
            "sections": [
                {
                    "widgets": [
                        {
                            "buttonList": {
                                "buttons": buttons,
                            }
                        }
                    ]
                }
            ],
        },
    )


def build_feedback_accessory_widgets(options: Any) -> list[dict[str, Any]]:
    raw = _as_mapping(options)
    button_type = _required_string(raw, "buttonType", "BORDERLESS")
    icon_fill = raw.get("iconFill") if raw and isinstance(raw.get("iconFill"), bool) else True
    buttons = [
        _icon_action_button(
            "thumb_up",
            _required_string(raw, "helpfulAltText", "Mark helpful"),
            raw.get("upAction") if raw else None,
            button_type=button_type,
            icon_fill=icon_fill,
        ),
        _icon_action_button(
            "thumb_down",
            _required_string(raw, "notHelpfulAltText", "Mark not helpful"),
            raw.get("downAction") if raw else None,
            button_type=button_type,
            icon_fill=icon_fill,
        ),
    ]

    comment_action = raw.get("commentAction") if raw else None
    if _as_mapping(comment_action):
        buttons.append(
            _icon_action_button(
                "rate_review",
                _required_string(raw, "commentAltText", "Add feedback comment"),
                comment_action,
                button_type=button_type,
                icon_fill=icon_fill,
            )
        )

    return [{"buttonList": {"buttons": buttons}}]


def build_feedback_accessory_message(options: Any) -> dict[str, Any]:
    raw = _as_mapping(options)
    text = _required_string(raw, "text")

    return {
        "fallbackText": (_as_string(raw.get("fallbackText")) if raw else None) or text,
        "text": text,
        "accessoryWidgets": build_feedback_accessory_widgets(options),
    }


def _source_top_label(source: RawMapping) -> str | None:
    parts = [
        item
        for item in [
            _as_string(source.get("label")),
            f"{source['confidence']} confidence"
            if isinstance(source.get("confidence"), str)
            else None,
        ]
        if item
    ]
    return " - ".join(parts) if parts else None


def _source_widget(source: RawMapping) -> dict[str, Any]:
    url = _as_string(source.get("url"))
    return {
        "decoratedText": _clean_record(
            {
                "topLabel": _source_top_label(source),
                "text": _required_string(source, "title", "Untitled source"),
                "bottomLabel": _as_string(source.get("snippet"))
                or _as_string(source.get("resourceName")),
                "button": _link_button("Open", url) if url else None,
            }
        )
    }


def build_sources_card(options: Any) -> dict[str, Any]:
    raw = _as_mapping(options)
    title = _required_string(raw, "title", "Sources")
    card_id = _required_string(raw, "cardId", "sources")
    response_id = _as_string(raw.get("responseId")) if raw else None
    sources = [
        source
        for source in (
            _as_mapping(source) for source in _as_list(raw.get("sources") if raw else None)
        )
        if source is not None
    ]
    names = [_required_string(source, "title", "Untitled source") for source in sources]
    subject = f"response {response_id}" if response_id else "response"

    return _message_with_single_card(
        f"Sources for {subject}: {', '.join(names)}.",
        card_id,
        {
            "header": {
                "title": title,
                "subtitle": f"{len(sources)} source{'' if len(sources) == 1 else 's'}",
            },
            "sections": [
                {
                    "widgets": [_source_widget(source) for source in sources],
                }
            ],
        },
    )


def build_thinking_card(options: Any) -> dict[str, Any]:
    raw = _as_mapping(options)
    title = _required_string(raw, "title", "Thinking")
    card_id = _required_string(raw, "cardId", "thinking")
    status = _required_string(raw, "status", "thinking")
    detail = _as_string(raw.get("detail")) if raw else None
    started_at = _as_string(raw.get("startedAt")) if raw else None
    fallback_parts = [f"Thinking: {title}."]
    widgets: list[dict[str, Any]] = [
        {
            "decoratedText": {
                "topLabel": "STATUS",
                "text": status,
            }
        }
    ]

    if detail:
        fallback_parts.append(detail)
        widgets.append({"textParagraph": {"text": detail}})
    if started_at:
        fallback_parts.append(f"Started at {started_at}.")
        widgets.append(
            {
                "decoratedText": {
                    "topLabel": "STARTED",
                    "text": started_at,
                }
            }
        )

    return _message_with_single_card(
        " ".join(fallback_parts),
        card_id,
        {
            "header": {"title": title, "subtitle": "Thinking"},
            "sections": [{"widgets": widgets}],
        },
    )


def build_tool_status_card(options: Any) -> dict[str, Any]:
    raw = _as_mapping(options)
    title = _required_string(raw, "title", "Tool calls")
    card_id = _required_string(raw, "cardId", "tool-status")
    tools = [
        tool
        for tool in (
            _as_mapping(tool) for tool in _as_list(raw.get("tools") if raw else None)
        )
        if tool is not None
    ]
    fallback = " ".join(
        f"{_required_string(tool, 'name')} {_required_string(tool, 'status')}."
        for tool in tools
    )

    return _message_with_single_card(
        f"Tool status: {fallback}",
        card_id,
        {
            "header": {
                "title": title,
                "subtitle": f"{len(tools)} tool call{'' if len(tools) == 1 else 's'}",
            },
            "sections": [
                {
                    "widgets": [
                        {
                            "decoratedText": _clean_record(
                                {
                                    "topLabel": _required_string(
                                        tool, "status", "unknown"
                                    ).upper(),
                                    "text": _required_string(tool, "name", "unknown_tool"),
                                    "bottomLabel": _as_string(tool.get("output"))
                                    or _as_string(tool.get("detail")),
                                }
                            )
                        }
                        for tool in tools
                    ],
                }
            ],
        },
    )


def build_streaming_status_card(options: Any) -> dict[str, Any]:
    raw = _as_mapping(options)
    title = _required_string(raw, "title", "Streaming response")
    card_id = _required_string(raw, "cardId", "streaming-status")
    mode = _required_string(raw, "mode", "create_then_patch")
    status = _required_string(raw, "status", "streaming")
    patch_count = _as_number(raw.get("patchCount")) if raw else None
    throttle_ms = _as_number(raw.get("throttleMs")) if raw else None
    effective_patch_count = patch_count if patch_count is not None else 0
    widgets: list[dict[str, Any]] = [
        {"decoratedText": {"topLabel": "MODE", "text": mode}},
        {"decoratedText": {"topLabel": "STATUS", "text": status}},
        {"decoratedText": {"topLabel": "PATCHES", "text": str(effective_patch_count)}},
    ]
    fallback_parts = [
        f"Streaming response: {mode} mode, {status}, {effective_patch_count} patch(es)"
    ]

    if throttle_ms is not None:
        fallback_parts.append(f"throttle {throttle_ms}ms")
        widgets.append(
            {"decoratedText": {"topLabel": "THROTTLE", "text": f"{throttle_ms}ms"}}
        )
    final_action = raw.get("finalAction") if raw else None
    if _as_mapping(final_action):
        widgets.append(
            {
                "buttonList": {
                    "buttons": [_action_button("Cancel", final_action)],
                }
            }
        )

    return _message_with_single_card(
        f"{', '.join(fallback_parts)}.",
        card_id,
        {
            "header": {"title": title, "subtitle": "Streaming"},
            "sections": [{"widgets": widgets}],
        },
    )


def _dialog_field_to_widget(field: RawMapping) -> dict[str, Any]:
    field_type = _required_string(field, "type")
    name = _required_string(field, "name")
    label = _required_string(field, "label")

    if field_type == "text":
        return {
            "textInput": _clean_record(
                {
                    "name": name,
                    "label": label,
                    "type": "MULTIPLE_LINE" if field.get("multiline") is True else "SINGLE_LINE",
                    "value": _as_string(field.get("value")),
                }
            )
        }

    if field_type == "selection":
        return {
            "selectionInput": {
                "name": name,
                "label": label,
                "type": _required_string(field, "selectionType", "DROPDOWN"),
                "items": [
                    _clean_record(
                        {
                            "text": _required_string(_as_mapping(item), "text"),
                            "value": _required_string(_as_mapping(item), "value"),
                            "selected": True
                            if (_as_mapping(item) or {}).get("selected") is True
                            else None,
                        }
                    )
                    for item in _as_list(field.get("items"))
                ],
            }
        }

    if field_type == "switch":
        return {
            "decoratedText": {
                "text": label,
                "switchControl": {
                    "name": name,
                    "selected": field.get("selected") is True,
                    "controlType": "SWITCH",
                },
            }
        }

    return _clean_record({"rawWidget": field.get("rawWidget")})


def build_dialog(options: Any) -> dict[str, Any]:
    raw = _as_mapping(options)
    title = _required_string(raw, "title")
    submit_label = _required_string(raw, "submitLabel", "Submit")
    fields = [
        item
        for item in (_as_mapping(field) for field in _as_list(raw.get("fields") if raw else None))
        if item is not None
    ]
    widgets = [_dialog_field_to_widget(field) for field in fields]
    widgets.append(
        {
            "buttonList": {
                "buttons": [_action_button(submit_label, raw.get("submitAction") if raw else None)]
            }
        }
    )

    return {
        "fallbackText": (
            f"Dialog requested: {title}. "
            f"Fields: {', '.join(_required_string(field, 'label') for field in fields)}."
        ),
        "actionResponse": {
            "type": "DIALOG",
            "dialogAction": {
                "dialog": {
                    "body": {
                        "sections": [
                            {
                                "widgets": widgets,
                            }
                        ]
                    }
                }
            },
        },
    }


def _message_response_body(input_payload: Any) -> dict[str, Any]:
    if isinstance(input_payload, str):
        return {"text": input_payload}

    raw = _as_mapping(input_payload)
    return dict(raw) if raw else {}


def _dialog_card_from_options(input_payload: Any) -> dict[str, Any]:
    raw = _as_mapping(input_payload)

    if not raw:
        return {"sections": []}

    if _as_mapping(raw.get("header")) or isinstance(raw.get("sections"), list):
        return dict(raw)

    title = _required_string(raw, "title")
    submit_label = _required_string(raw, "submitLabel", "Submit")
    fields = [
        item
        for item in (_as_mapping(field) for field in _as_list(raw.get("fields")))
        if item is not None
    ]
    widgets = [_dialog_field_to_widget(field) for field in fields]
    widgets.append(
        {
            "buttonList": {
                "buttons": [_action_button(submit_label, raw.get("submitAction"))]
            }
        }
    )

    return {
        "header": _clean_record({"title": title}),
        "sections": [
            {
                "widgets": widgets,
            }
        ],
    }


def build_update_card_response(message: Any) -> dict[str, Any]:
    return {
        "hostAppDataAction": {
            "chatDataAction": {
                "updateMessageAction": {
                    "message": _message_response_body(message),
                }
            }
        }
    }


def build_create_message_response(message: Any) -> dict[str, Any]:
    return {
        "hostAppDataAction": {
            "chatDataAction": {
                "createMessageAction": {
                    "message": _message_response_body(message),
                }
            }
        }
    }


def build_open_dialog_response(dialog: Any) -> dict[str, Any]:
    return build_card_navigation_response(push_card(dialog))


def push_card(card: Any) -> dict[str, Any]:
    return {
        "type": "push",
        "card": card,
    }


def update_card(card: Any) -> dict[str, Any]:
    return {
        "type": "update",
        "card": card,
    }


def _navigation_from_step(step: Any) -> dict[str, Any]:
    raw = _as_mapping(step)
    kind = _required_string(raw, "type", "push")
    card = _dialog_card_from_options(raw.get("card") if raw else None)

    if kind == "update":
        return {"updateCard": card}

    return {"pushCard": card}


def build_card_navigation_response(steps: Any) -> dict[str, Any]:
    step_list = steps if isinstance(steps, list) else [steps]

    return {
        "action": {
            "navigations": [_navigation_from_step(step) for step in step_list],
        }
    }


def _compact_json_bytes(value: Any) -> int:
    return len(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def _empty_lint_stats(value: Any) -> dict[str, int]:
    return {
        "cards": 0,
        "sections": 0,
        "widgets": 0,
        "buttons": 0,
        "images": 0,
        "bytes": _compact_json_bytes(value),
    }


def _lint_finding(
    severity: str,
    code: str,
    path: str,
    message: str,
    remediation: str,
) -> dict[str, str]:
    return {
        "severity": severity,
        "code": code,
        "path": path,
        "message": message,
        "remediation": remediation,
    }


def _plural(count: int, singular: str) -> str:
    return f"{count} {singular}{'' if count == 1 else 's'}"


def _lint_summary(findings: list[dict[str, str]]) -> str:
    errors = sum(1 for finding in findings if finding["severity"] == "error")
    warnings = sum(1 for finding in findings if finding["severity"] == "warning")
    return f"{_plural(errors, 'error')}, {_plural(warnings, 'warning')}"


def _is_url_like(value: str) -> bool:
    return value.lower().startswith(("http://", "https://"))


def _button_has_click(button: RawMapping | None) -> bool:
    on_click = _as_mapping(button.get("onClick")) if button else None
    action = _as_mapping(on_click.get("action")) if on_click else None
    open_link = _as_mapping(on_click.get("openLink")) if on_click else None
    return bool(
        ((_as_string(action.get("function")) if action else "") or "").strip()
        or ((_as_string(open_link.get("url")) if open_link else "") or "").strip()
    )


def _visit_buttons_for_lint(
    buttons: list[Any],
    path: str,
    surface: str,
    options: RawMapping,
    findings: list[dict[str, str]],
) -> None:
    for button_index, button in enumerate(buttons):
        button_path = f"{path}.buttons[{button_index}]"
        button_record = _as_mapping(button)

        if not _button_has_click(button_record):
            findings.append(
                _lint_finding(
                    "error",
                    "button_missing_onclick",
                    button_path,
                    "Button must define onClick.action.function or onClick.openLink.url.",
                    "Add an action function or openLink URL to the button.",
                )
            )

        if button_record and _as_mapping(button_record.get("icon")):
            if not ((_as_string(button_record.get("altText")) or "").strip()):
                findings.append(
                    _lint_finding(
                        "warning",
                        "button_missing_alt_text",
                        f"{button_path}.altText",
                        "Icon buttons should include altText for accessibility.",
                        "Add concise altText that describes the button action.",
                    )
                )

        on_click = _as_mapping(button_record.get("onClick")) if button_record else None
        action = _as_mapping(on_click.get("action")) if on_click else None
        action_function = _as_string(action.get("function")) if action else None
        if (
            surface == "workspace-addon-action-response"
            and action_function
            and not _is_url_like(action_function)
            and options.get("allowNamedFunctions") is not True
        ):
            findings.append(
                _lint_finding(
                    "error",
                    "addon_action_function_not_url",
                    f"{button_path}.onClick.action.function",
                    "Workspace add-on card actions must use a full HTTP URL as action.function.",
                    "Use the deployed card-action endpoint URL as the function and pass the logical action name in parameters.",
                )
            )


def _visit_widgets_for_lint(
    widgets: list[Any],
    path: str,
    surface: str,
    options: RawMapping,
    stats: dict[str, int],
    findings: list[dict[str, str]],
) -> None:
    stats["widgets"] += len(widgets)

    for widget_index, widget in enumerate(widgets):
        widget_path = f"{path}[{widget_index}]"
        widget_record = _as_mapping(widget)
        button_list = _as_mapping(widget_record.get("buttonList")) if widget_record else None
        buttons = _as_list(button_list.get("buttons")) if button_list else []

        if button_list:
            stats["buttons"] += len(buttons)
            _visit_buttons_for_lint(
                buttons,
                f"{widget_path}.buttonList",
                surface,
                options,
                findings,
            )

        image = _as_mapping(widget_record.get("image")) if widget_record else None
        if image:
            stats["images"] += 1
            if not ((_as_string(image.get("altText")) or "").strip()):
                findings.append(
                    _lint_finding(
                        "warning",
                        "image_missing_alt_text",
                        f"{widget_path}.image.altText",
                        "Image widgets should include altText for accessibility.",
                        "Add altText that describes the image content or purpose.",
                    )
                )


def _visit_card_for_lint(
    card: Any,
    path: str,
    surface: str,
    options: RawMapping,
    stats: dict[str, int],
    findings: list[dict[str, str]],
    *,
    require_title: bool = True,
) -> None:
    card_record = _as_mapping(card)
    header = _as_mapping(card_record.get("header")) if card_record else None

    if require_title and not ((_as_string(header.get("title")) if header else "") or "").strip():
        findings.append(
            _lint_finding(
                "error",
                "card_header_title_required",
                f"{path}.header.title",
                f"{path}.header.title is required",
                "Add a concise card header title.",
            )
        )

    if header and ((_as_string(header.get("imageUrl")) or "").strip()):
        if not ((_as_string(header.get("imageAltText")) or "").strip()):
            findings.append(
                _lint_finding(
                    "warning",
                    "header_image_missing_alt_text",
                    f"{path}.header.imageAltText",
                    "Card header images should include imageAltText for accessibility.",
                    "Add imageAltText that describes the header image.",
                )
            )

    sections = _as_list(card_record.get("sections") if card_record else None)
    stats["sections"] += len(sections)
    widget_count_for_card = 0
    warned_widget_limit = False

    for section_index, section in enumerate(sections):
        section_path = f"{path}.sections[{section_index}]"
        section_record = _as_mapping(section)
        widgets_value = section_record.get("widgets") if section_record else None

        if not isinstance(widgets_value, list):
            findings.append(
                _lint_finding(
                    "error",
                    "section_widgets_required",
                    f"{section_path}.widgets",
                    "Card sections must define a widgets array.",
                    "Add widgets: [] or remove the empty section.",
                )
            )
            continue

        if not warned_widget_limit and widget_count_for_card + len(widgets_value) > 100:
            warned_widget_limit = True
            findings.append(
                _lint_finding(
                    "warning",
                    "card_widget_limit_exceeded",
                    section_path,
                    "This section pushes the card over Google Chat's 100-widget limit and can be ignored with following sections.",
                    "Split the content across multiple cards or messages before this section.",
                )
            )

        widget_count_for_card += len(widgets_value)
        _visit_widgets_for_lint(
            widgets_value,
            f"{section_path}.widgets",
            surface,
            options,
            stats,
            findings,
        )


def _visit_message_body_for_lint(
    message: RawMapping,
    path: str,
    surface: str,
    options: RawMapping,
    stats: dict[str, int],
    findings: list[dict[str, str]],
) -> None:
    cards = _as_list(message.get("cardsV2"))
    accessory_widgets = _as_list(message.get("accessoryWidgets"))

    if (
        surface == "chat-message"
        and accessory_widgets
        and (isinstance(message.get("attachment"), list) or isinstance(message.get("attachments"), list))
    ):
        findings.append(
            _lint_finding(
                "error",
                "accessory_attachment_conflict",
                f"{path}.accessoryWidgets",
                "Accessory widgets are not supported on messages that contain attachments.",
                "Send the attachment and accessory controls as separate messages.",
            )
        )

    action_response = _as_mapping(message.get("actionResponse"))
    if (
        accessory_widgets
        and action_response
        and _as_string(action_response.get("type")) == "DIALOG"
    ):
        findings.append(
            _lint_finding(
                "error",
                "accessory_dialog_conflict",
                f"{path}.accessoryWidgets",
                "Accessory widgets are not supported for messages that contain dialogs.",
                "Return the dialog response without accessoryWidgets.",
            )
        )

    if (
        surface == "chat-message"
        and options.get("principal") == "user"
        and options.get("allowDeveloperPreviewUserCards") is not True
        and (cards or accessory_widgets)
    ):
        findings.append(
            _lint_finding(
                "warning",
                "user_auth_card_preview_required",
                path,
                "User-auth card and accessory-widget sends require Developer Preview support.",
                "Use app auth for rich Chat messages unless the tenant and app are in the Developer Preview path.",
            )
        )

    if cards and surface == "chat-message":
        if not ((_as_string(message.get("fallbackText")) or "").strip()):
            findings.append(
                _lint_finding(
                    "error",
                    "fallback_text_required",
                    f"{path}.fallbackText",
                    "fallbackText is required",
                    "Add a plain-text description of the card for notifications and clients that can't render cards.",
                )
            )
        if not ((_as_string(message.get("text")) or "").strip()):
            findings.append(
                _lint_finding(
                    "error",
                    "text_fallback_required",
                    f"{path}.text",
                    "text fallback is required",
                    "Add a short text fallback alongside the card payload.",
                )
            )

    for card_index, entry in enumerate(cards):
        stats["cards"] += 1
        entry_record = _as_mapping(entry)
        _visit_card_for_lint(
            entry_record.get("card") if entry_record else None,
            f"{path}.cardsV2[{card_index}].card",
            surface,
            options,
            stats,
            findings,
        )

    _visit_widgets_for_lint(
        accessory_widgets,
        f"{path}.accessoryWidgets",
        surface,
        options,
        stats,
        findings,
    )


def _chat_data_action_for_lint(raw: RawMapping) -> RawMapping | None:
    host = _as_mapping(raw.get("hostAppDataAction"))
    return _as_mapping(host.get("chatDataAction")) if host else None


def _lint_workspace_addon_response(
    raw: RawMapping,
    surface: str,
    options: RawMapping,
    stats: dict[str, int],
    findings: list[dict[str, str]],
) -> None:
    chat_data = _chat_data_action_for_lint(raw)
    action = _as_mapping(raw.get("action"))
    navigations = _as_list(action.get("navigations")) if action else []
    create_action = _as_mapping(chat_data.get("createMessageAction")) if chat_data else None
    update_action = _as_mapping(chat_data.get("updateMessageAction")) if chat_data else None
    message_actions = [
        (
            "createMessageAction",
            _as_mapping(create_action.get("message")) if create_action else None,
        ),
        (
            "updateMessageAction",
            _as_mapping(update_action.get("message")) if update_action else None,
        ),
        (
            "updateInlinePreviewAction",
            _as_mapping(chat_data.get("updateInlinePreviewAction")) if chat_data else None,
        ),
    ]
    present_action_count = sum(1 for _name, message in message_actions if message) + (1 if navigations else 0)

    if present_action_count == 0:
        findings.append(
            _lint_finding(
                "error",
                "addon_action_missing",
                "$",
                "Workspace add-on responses must include hostAppDataAction.chatDataAction or action.navigations.",
                "Wrap message updates in createMessageAction/updateMessageAction or card navigation in action.navigations.",
            )
        )

    if present_action_count > 1:
        findings.append(
            _lint_finding(
                "warning",
                "addon_multiple_primary_actions",
                "$",
                "Workspace add-on response contains multiple primary action paths.",
                "Return one create/update/navigation action per response unless Google explicitly documents the combination.",
            )
        )

    for action_name, message in message_actions:
        if message:
            _visit_message_body_for_lint(
                message,
                f"$.hostAppDataAction.chatDataAction.{action_name}.message",
                surface,
                options,
                stats,
                findings,
            )

    for navigation_index, navigation in enumerate(navigations):
        navigation_record = _as_mapping(navigation)
        for key in ["pushCard", "updateCard"]:
            card = _as_mapping(navigation_record.get(key)) if navigation_record else None
            if card:
                stats["cards"] += 1
                _visit_card_for_lint(
                    card,
                    f"$.action.navigations[{navigation_index}].{key}",
                    surface,
                    options,
                    stats,
                    findings,
                    require_title=False,
                )


def lint_card_payload(payload: Any, options: RawMapping | None = None) -> dict[str, Any]:
    opts: RawMapping = options or {}
    surface = _as_string(opts.get("surface")) or "chat-message"
    stats = _empty_lint_stats(payload)
    findings: list[dict[str, str]] = []
    raw = _as_mapping(payload)

    if not raw:
        findings.append(
            _lint_finding(
                "error",
                "payload_not_object",
                "$",
                "Card payload must be a JSON object.",
                "Pass the object that will be sent to Google Chat for this surface.",
            )
        )
        return {
            "kind": "chat.card_lint_result",
            "surface": surface,
            "ok": False,
            "summary": _lint_summary(findings),
            "stats": stats,
            "findings": findings,
            "translated": None,
        }

    if stats["bytes"] > 32000:
        findings.append(
            _lint_finding(
                "warning",
                "payload_size_exceeds_chat_limit",
                "$",
                "Message and card JSON exceeds Google Chat's 32 KB message/card size guidance.",
                "Split the content into smaller messages or cards.",
            )
        )
    elif stats["bytes"] > 28000:
        findings.append(
            _lint_finding(
                "warning",
                "payload_size_near_chat_limit",
                "$",
                "Message and card JSON is close to Google Chat's 32 KB message/card size guidance.",
                "Consider shortening card content before adding more widgets.",
            )
        )

    if surface != "workspace-addon-action-response":
        if isinstance(raw.get("cards_v2"), list):
            findings.append(
                _lint_finding(
                    "error",
                    "wrong_cards_field",
                    "$.cards_v2",
                    "Use cardsV2 for Google Chat REST messages.",
                    "Rename cards_v2 to cardsV2 for this profile.",
                )
            )
        if isinstance(raw.get("cards"), list):
            findings.append(
                _lint_finding(
                    "error",
                    "deprecated_cards_field",
                    "$.cards",
                    "cards is deprecated for Google Chat messages.",
                    "Use cardsV2 with CardWithId entries.",
                )
            )

    if surface == "chat-message":
        if _as_mapping(raw.get("hostAppDataAction")):
            findings.append(
                _lint_finding(
                    "error",
                    "addon_envelope_on_chat_message",
                    "$.hostAppDataAction",
                    "Workspace add-on action envelopes cannot be used as raw Chat message bodies.",
                    "Pass only the message object to spaces.messages.create, or lint this payload with the workspace-addon-action-response profile.",
                )
            )
        action = _as_mapping(raw.get("action"))
        if action and _as_list(action.get("navigations")):
            findings.append(
                _lint_finding(
                    "error",
                    "addon_envelope_on_chat_message",
                    "$.action.navigations",
                    "Workspace add-on navigation envelopes cannot be used as raw Chat message bodies.",
                    "Return this payload from an add-on card action handler instead of sending it to spaces.messages.create.",
                )
            )

    if surface == "workspace-addon-action-response":
        if isinstance(raw.get("cardsV2"), list) or _as_string(raw.get("text")) or _as_mapping(raw.get("actionResponse")):
            findings.append(
                _lint_finding(
                    "error",
                    "addon_action_envelope_required",
                    "$",
                    "Workspace add-on responses must wrap Chat messages in an action envelope.",
                    "Use hostAppDataAction.chatDataAction.createMessageAction/updateMessageAction or action.navigations.",
                )
            )
        _lint_workspace_addon_response(raw, surface, opts, stats, findings)
    else:
        _visit_message_body_for_lint(raw, "$", surface, opts, stats, findings)

    return {
        "kind": "chat.card_lint_result",
        "surface": surface,
        "ok": all(finding["severity"] != "error" for finding in findings),
        "summary": _lint_summary(findings),
        "stats": stats,
        "findings": findings,
        "translated": None,
    }


def _message_body_without_action_response(payload: RawMapping) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if key != "actionResponse"}


def _direct_chat_mode(payload: RawMapping, requested_mode: str | None) -> str:
    if requested_mode:
        return requested_mode
    action_response = _as_mapping(payload.get("actionResponse"))
    action_type = _as_string(action_response.get("type")) if action_response else None
    if action_type == "UPDATE_MESSAGE":
        return "update-message"
    if action_type == "DIALOG":
        return "open-dialog"
    return "create-message"


def _unsupported_translation(from_surface: str, to_surface: str, mode: str) -> dict[str, Any]:
    return {
        "kind": "chat.card_translation_result",
        "from": from_surface,
        "to": to_surface,
        "mode": mode,
        "ok": False,
        "findings": [
            _lint_finding(
                "error",
                "unsupported_card_translation",
                "$",
                f"Unsupported card translation from {from_surface} to {to_surface} in {mode} mode.",
                "Use direct-chat-response to workspace-addon-action-response for create-message, update-message, or open-dialog in this SDK slice.",
            )
        ],
        "payload": None,
    }


def translate_card_payload(payload: Any, options: RawMapping | None = None) -> dict[str, Any]:
    opts: RawMapping = options or {}
    from_surface = _as_string(opts.get("from")) or "direct-chat-response"
    to_surface = _as_string(opts.get("to")) or "workspace-addon-action-response"
    raw = _as_mapping(payload)
    mode = _direct_chat_mode(raw or {}, _as_string(opts.get("mode")))

    if not raw:
        return _unsupported_translation(from_surface, to_surface, mode)

    if from_surface == "direct-chat-response" and to_surface == "workspace-addon-action-response":
        if mode == "update-message":
            return {
                "kind": "chat.card_translation_result",
                "from": from_surface,
                "to": to_surface,
                "mode": mode,
                "ok": True,
                "findings": [],
                "payload": {
                    "hostAppDataAction": {
                        "chatDataAction": {
                            "updateMessageAction": {
                                "message": _message_body_without_action_response(raw),
                            }
                        }
                    }
                },
            }

        if mode == "create-message":
            return {
                "kind": "chat.card_translation_result",
                "from": from_surface,
                "to": to_surface,
                "mode": mode,
                "ok": True,
                "findings": [],
                "payload": {
                    "hostAppDataAction": {
                        "chatDataAction": {
                            "createMessageAction": {
                                "message": _message_body_without_action_response(raw),
                            }
                        }
                    }
                },
            }

        if mode == "open-dialog":
            action_response = _as_mapping(raw.get("actionResponse"))
            dialog_action = _as_mapping(action_response.get("dialogAction")) if action_response else None
            dialog = _as_mapping(dialog_action.get("dialog")) if dialog_action else None
            body = _as_mapping(dialog.get("body")) if dialog else None
            return {
                "kind": "chat.card_translation_result",
                "from": from_surface,
                "to": to_surface,
                "mode": mode,
                "ok": True,
                "findings": [],
                "payload": {
                    "action": {
                        "navigations": [{"pushCard": body or {}}],
                    }
                },
            }

    if from_surface == "chat-message" and to_surface == "direct-chat-response":
        return {
            "kind": "chat.card_translation_result",
            "from": from_surface,
            "to": to_surface,
            "mode": mode,
            "ok": True,
            "findings": [],
            "payload": dict(raw),
        }

    return _unsupported_translation(from_surface, to_surface, mode)


def validate_card_message(input_payload: Any) -> dict[str, Any]:
    raw = _as_mapping(input_payload)
    if not raw:
        return {"ok": False, "errors": ["card message must be an object"]}

    result = lint_card_payload(input_payload, {"surface": "chat-message"})
    errors: list[str] = []
    for finding in result["findings"]:
        if finding["severity"] != "error":
            continue
        if finding["code"] not in {
            "fallback_text_required",
            "text_fallback_required",
            "card_header_title_required",
            "button_missing_onclick",
        }:
            continue
        if finding["code"] == "button_missing_onclick":
            path = finding["path"][2:] if finding["path"].startswith("$.") else finding["path"]
            errors.append(
                f"{path}.onClick.action.function or onClick.openLink.url is required"
            )
        elif finding["code"] == "card_header_title_required":
            errors.append(finding["message"][2:] if finding["message"].startswith("$.") else finding["message"])
        else:
            errors.append(finding["message"])

    if not _as_list(raw.get("cardsV2")):
        errors.append("cardsV2 must include at least one card")

    return {"ok": not errors, "errors": errors}


def _summarize_button(button: Any) -> dict[str, Any] | None:
    raw = _as_mapping(button)
    on_click = _as_mapping(raw.get("onClick")) if raw else None
    action = _as_mapping(on_click.get("action")) if on_click else None
    open_link = _as_mapping(on_click.get("openLink")) if on_click else None
    text = _as_string(raw.get("text")) if raw else None
    function_name = _as_string(action.get("function")) if action else None
    open_link_url = _as_string(open_link.get("url")) if open_link else None

    if not text and not function_name and not open_link_url:
        return None

    return _clean_record(
        {
            "text": text,
            "function": function_name,
            "openLink": open_link_url,
            "parameters": _parameters_object_from_array(action.get("parameters") if action else None),
        }
    )


def _summarize_image_widget(image: Any) -> dict[str, Any] | None:
    raw = _as_mapping(image)

    if not raw:
        return None

    on_click = _as_mapping(raw.get("onClick"))
    open_link = _as_mapping(on_click.get("openLink")) if on_click else None
    action = _as_mapping(on_click.get("action")) if on_click else None

    return _clean_record(
        {
            "altText": _as_string(raw.get("altText")),
            "imageUrl": _as_string(raw.get("imageUrl")),
            "openLink": _as_string(open_link.get("url")) if open_link else None,
            "function": _as_string(action.get("function")) if action else None,
            "parameters": _parameters_object_from_array(action.get("parameters"))
            if action
            else None,
        }
    )


def _summarize_grid(grid: Any) -> dict[str, Any] | None:
    raw = _as_mapping(grid)

    if not raw:
        return None

    on_click = _as_mapping(raw.get("onClick"))
    action = _as_mapping(on_click.get("action")) if on_click else None
    items: list[dict[str, Any]] = []

    for item in _as_list(raw.get("items")):
        item_record = _as_mapping(item)
        image = _as_mapping(item_record.get("image")) if item_record else None
        summary = _clean_record(
            {
                "id": _as_string(item_record.get("id")) if item_record else None,
                "title": _as_string(item_record.get("title")) if item_record else None,
                "subtitle": _as_string(item_record.get("subtitle")) if item_record else None,
                "imageAltText": _as_string(image.get("altText")) if image else None,
            }
        )
        if summary:
            items.append(summary)

    return _clean_record(
        {
            "title": _as_string(raw.get("title")),
            "columnCount": raw.get("columnCount")
            if isinstance(raw.get("columnCount"), int)
            else None,
            "items": items,
            "function": _as_string(action.get("function")) if action else None,
            "parameters": _parameters_object_from_array(action.get("parameters"))
            if action
            else None,
        }
    )


def _summarize_columns(columns: Any) -> dict[str, Any] | None:
    raw = _as_mapping(columns)

    if not raw:
        return None

    column_items = [
        item
        for item in (
            _as_mapping(column)
            for column in _as_list(raw.get("columnItems") or raw.get("columns"))
        )
        if item is not None
    ]

    return {
        "columnCount": len(column_items),
        "columns": [_summarize_section({"widgets": column.get("widgets")}) for column in column_items],
    }


def _summarize_carousel(carousel: Any) -> dict[str, Any] | None:
    raw = _as_mapping(carousel)

    if not raw:
        return None

    cards: list[dict[str, Any]] = []
    for card in _as_list(raw.get("carouselCards")):
        raw_card = _as_mapping(card)
        if not raw_card:
            continue
        cards.append(
            _clean_record(
                {
                    "widgets": _summarize_section({"widgets": raw_card.get("widgets")}),
                    "footer": _summarize_section(
                        {"widgets": raw_card.get("footerWidgets")}
                    ),
                }
            )
        )

    return _clean_record(
        {
            "cardCount": len(cards),
            "cards": cards,
        }
    )


def _summarize_chip(chip: Any) -> dict[str, Any] | None:
    raw = _as_mapping(chip)

    if not raw:
        return None

    on_click = _as_mapping(raw.get("onClick"))
    action = _as_mapping(on_click.get("action")) if on_click else None
    open_link = _as_mapping(on_click.get("openLink")) if on_click else None

    return _clean_record(
        {
            "text": _as_string(raw.get("text")) or _as_string(raw.get("label")),
            "disabled": True if raw.get("disabled") is True else None,
            "function": _as_string(action.get("function")) if action else None,
            "openLink": _as_string(open_link.get("url")) if open_link else None,
            "parameters": _parameters_object_from_array(action.get("parameters"))
            if action
            else None,
        }
    )


def _summarize_date_time_picker(picker: Any) -> dict[str, Any] | None:
    raw = _as_mapping(picker)

    if not raw:
        return None

    value = raw.get("valueMsEpoch")

    return _clean_record(
        {
            "name": _as_string(raw.get("name")),
            "label": _as_string(raw.get("label")),
            "type": _as_string(raw.get("type")),
            "valueMsEpoch": str(value) if isinstance(value, str | int | float) else None,
        }
    )


def _selected_selection_items(selection_input: RawMapping) -> list[str]:
    selected: list[str] = []

    for item in _as_list(selection_input.get("items")):
        raw = _as_mapping(item)
        if raw and raw.get("selected") is True:
            value = _as_string(raw.get("text")) or _as_string(raw.get("value"))
            if value:
                selected.append(value)

    return selected


def _summarize_section(section: Any) -> dict[str, Any]:
    raw = _as_mapping(section)
    widgets = _as_list(raw.get("widgets") if raw else None)
    text: list[str] = []
    fields: list[dict[str, Any]] = []
    buttons: list[dict[str, Any]] = []
    images: list[dict[str, Any]] = []
    grids: list[dict[str, Any]] = []
    columns: list[dict[str, Any]] = []
    carousels: list[dict[str, Any]] = []
    chips: list[dict[str, Any]] = []
    date_time_pickers: list[dict[str, Any]] = []
    dividers = 0

    for widget in widgets:
        widget_record = _as_mapping(widget)
        image = _as_mapping(widget_record.get("image")) if widget_record else None
        text_paragraph = (
            _as_mapping(widget_record.get("textParagraph")) if widget_record else None
        )
        decorated_text = (
            _as_mapping(widget_record.get("decoratedText")) if widget_record else None
        )
        text_input = _as_mapping(widget_record.get("textInput")) if widget_record else None
        selection_input = (
            _as_mapping(widget_record.get("selectionInput")) if widget_record else None
        )
        date_time_picker = (
            _as_mapping(widget_record.get("dateTimePicker")) if widget_record else None
        )
        button_list = _as_mapping(widget_record.get("buttonList")) if widget_record else None
        divider = _as_mapping(widget_record.get("divider")) if widget_record else None
        grid = _as_mapping(widget_record.get("grid")) if widget_record else None
        column_set = _as_mapping(widget_record.get("columns")) if widget_record else None
        carousel = _as_mapping(widget_record.get("carousel")) if widget_record else None
        chip_list = _as_mapping(widget_record.get("chipList")) if widget_record else None

        paragraph_text = _as_string(text_paragraph.get("text")) if text_paragraph else None
        if paragraph_text:
            text.append(paragraph_text)

        image_summary = _summarize_image_widget(image)
        if image_summary:
            images.append(image_summary)

        if decorated_text:
            fields.append(
                _clean_record(
                    {
                        "label": _as_string(decorated_text.get("topLabel")),
                        "text": _as_string(decorated_text.get("text")),
                    }
                )
            )

        if text_input:
            fields.append(
                _clean_record(
                    {
                        "name": _as_string(text_input.get("name")),
                        "label": _as_string(text_input.get("label")),
                        "type": _as_string(text_input.get("type")),
                    }
                )
            )

        if selection_input:
            selected = _selected_selection_items(selection_input)
            fields.append(
                _clean_record(
                    {
                        "name": _as_string(selection_input.get("name")),
                        "label": _as_string(selection_input.get("label")),
                        "type": _as_string(selection_input.get("type")),
                        "selected": selected or None,
                    }
                )
            )

        picker_summary = _summarize_date_time_picker(date_time_picker)
        if picker_summary:
            date_time_pickers.append(picker_summary)

        for button in _as_list(button_list.get("buttons") if button_list else None):
            summary = _summarize_button(button)
            if summary:
                buttons.append(summary)

        if divider is not None:
            dividers += 1

        grid_summary = _summarize_grid(grid)
        if grid_summary:
            grids.append(grid_summary)

        columns_summary = _summarize_columns(column_set)
        if columns_summary:
            columns.append(columns_summary)

        carousel_summary = _summarize_carousel(carousel)
        if carousel_summary:
            carousels.append(carousel_summary)

        for chip in _as_list(chip_list.get("chips") if chip_list else None):
            summary = _summarize_chip(chip)
            if summary:
                chips.append(summary)

    return _clean_record(
        {
            "header": _as_string(raw.get("header")) if raw else None,
            "widgetCount": len(widgets),
            "text": text,
            "fields": fields,
            "buttons": buttons,
            "images": images or None,
            "dividers": dividers if dividers > 0 else None,
            "grids": grids or None,
            "columns": columns or None,
            "carousels": carousels or None,
            "dateTimePickers": date_time_pickers or None,
            "chips": chips or None,
        }
    )


def _format_pairs(parameters: Mapping[str, str]) -> str:
    return ", ".join(f"{key}={parameters[key]}" for key in sorted(parameters))


def _format_button_summary(button: RawMapping) -> str:
    text = _as_string(button.get("text")) or "Untitled"
    open_link = _as_string(button.get("openLink"))

    if open_link:
        return f"{text} -> {open_link}"

    parameters = _as_mapping(button.get("parameters")) or {}
    return f"{text} -> {button.get('function')}({_format_pairs(parameters)})"


def _field_value(field: RawMapping) -> str:
    selected = ", ".join(
        str(item) for item in _as_list(field.get("selected")) if isinstance(item, str)
    )
    return _as_string(field.get("text")) or selected


def _format_image_summary(image: RawMapping) -> str:
    label = _as_string(image.get("altText")) or _as_string(image.get("imageUrl")) or "image"
    open_link = _as_string(image.get("openLink"))
    function_name = _as_string(image.get("function"))

    if open_link:
        return f"{label} -> {open_link}"

    if function_name:
        return f"{label} -> {function_name}({_format_pairs(_as_mapping(image.get('parameters')) or {})})"

    return label


def _format_grid_summary(grid: RawMapping) -> str:
    title = _as_string(grid.get("title")) or "grid"
    items: list[str] = []

    for item in _as_list(grid.get("items")):
        raw = _as_mapping(item)
        if not raw:
            continue
        item_title = _as_string(raw.get("title")) or _as_string(raw.get("id")) or "item"
        subtitle = _as_string(raw.get("subtitle"))
        items.append(f"{item_title} ({subtitle})" if subtitle else item_title)

    return f"Grid {title}{': ' + '; '.join(items) if items else ''}"


def _format_columns_summary(columns: RawMapping) -> str:
    parts: list[str] = []

    for index, column in enumerate(_as_list(columns.get("columns")), start=1):
        column_summary = _format_section_summary(_as_mapping(column) or {})
        parts.append(f"column {index}: {column_summary}")

    return f"Columns: {'; '.join(parts)}"


def _format_carousel_summary(carousel: RawMapping) -> str:
    parts: list[str] = []

    for index, card in enumerate(_as_list(carousel.get("cards")), start=1):
        raw = _as_mapping(card) or {}
        widgets = _trim_trailing_periods(
            _format_section_summary(_as_mapping(raw.get("widgets")) or {})
        )
        footer = _trim_trailing_periods(
            _format_section_summary(_as_mapping(raw.get("footer")) or {})
        )
        parts.append(f"card {index}: {widgets}{f' Footer: {footer}' if footer else ''}")

    return f"Carousel: {'; '.join(parts)}"


def _trim_trailing_periods(value: str) -> str:
    return value.rstrip(".")


def _format_date_time_picker_summary(picker: RawMapping) -> str:
    label = _as_string(picker.get("label")) or _as_string(picker.get("name")) or "date/time"
    picker_type = _as_string(picker.get("type")) or "UNKNOWN"
    value = _as_string(picker.get("valueMsEpoch")) or ""
    return f"{label} {picker_type}={value}"


def _format_chip_summary(chip: RawMapping) -> str:
    text = _as_string(chip.get("text")) or "chip"
    open_link = _as_string(chip.get("openLink"))
    function_name = _as_string(chip.get("function"))

    if open_link:
        return f"{text} -> {open_link}"

    if function_name:
        return f"{text} -> {function_name}({_format_pairs(_as_mapping(chip.get('parameters')) or {})})"

    return text


def _format_section_summary(section: RawMapping) -> str:
    header = _as_string(section.get("header"))
    texts = [item for item in _as_list(section.get("text")) if isinstance(item, str)]
    fields = [
        item
        for item in (_as_mapping(field) for field in _as_list(section.get("fields")))
        if item is not None
    ]
    buttons = [
        item
        for item in (_as_mapping(button) for button in _as_list(section.get("buttons")))
        if item is not None
    ]
    images = [
        item
        for item in (_as_mapping(image) for image in _as_list(section.get("images")))
        if item is not None
    ]
    grids = [
        item
        for item in (_as_mapping(grid) for grid in _as_list(section.get("grids")))
        if item is not None
    ]
    columns = [
        item
        for item in (_as_mapping(column) for column in _as_list(section.get("columns")))
        if item is not None
    ]
    carousels = [
        item
        for item in (
            _as_mapping(carousel) for carousel in _as_list(section.get("carousels"))
        )
        if item is not None
    ]
    date_time_pickers = [
        item
        for item in (
            _as_mapping(picker) for picker in _as_list(section.get("dateTimePickers"))
        )
        if item is not None
    ]
    chips = [
        item
        for item in (_as_mapping(chip) for chip in _as_list(section.get("chips")))
        if item is not None
    ]
    parts: list[str] = []

    if header:
        parts.append(f"Section {header}.")

    if texts:
        parts.append(f"Text: {' '.join(texts)}")

    if fields:
        parts.append(
            "Fields: "
            + "; ".join(f"{field.get('label')}={_field_value(field)}" for field in fields)
            + "."
        )

    if buttons:
        parts.append("Buttons: " + "; ".join(_format_button_summary(button) for button in buttons) + ".")

    if images:
        parts.append("Images: " + "; ".join(_format_image_summary(image) for image in images) + ".")

    if isinstance(section.get("dividers"), int) and section["dividers"] > 0:
        parts.append(f"Dividers: {section['dividers']}.")

    if grids:
        parts.append(" ".join(_format_grid_summary(grid) for grid in grids) + ".")

    if columns:
        parts.append("; ".join(_format_columns_summary(column) for column in columns) + ".")

    if carousels:
        parts.append("; ".join(_format_carousel_summary(carousel) for carousel in carousels) + ".")

    if date_time_pickers:
        parts.append(
            "Date/time pickers: "
            + "; ".join(
                _format_date_time_picker_summary(picker) for picker in date_time_pickers
            )
            + "."
        )

    if chips:
        parts.append("Chips: " + "; ".join(_format_chip_summary(chip) for chip in chips) + ".")

    return " ".join(parts)


def summarize_cards(cards_v2: Any) -> dict[str, Any]:
    cards: list[dict[str, Any]] = []

    for entry in _as_list(cards_v2):
        raw = _as_mapping(entry)
        card = _as_mapping(raw.get("card")) if raw else None
        header = _as_mapping(card.get("header")) if card else None
        cards.append(
            {
                "cardId": _as_string(raw.get("cardId")) if raw else None,
                "title": _as_string(header.get("title")) if header else None,
                "subtitle": _as_string(header.get("subtitle")) if header else None,
                "sections": [
                    _summarize_section(section)
                    for section in _as_list(card.get("sections") if card else None)
                ],
            }
        )

    plain_text_parts: list[str] = []
    for card in cards:
        sections = card["sections"]
        title = f": {card['title']}" if card["title"] else ""
        subtitle = f" ({card['subtitle']})" if card["subtitle"] else ""
        section_part = " ".join(
            item
            for item in (
                _format_section_summary(section)
                for section in sections
                if _as_mapping(section)
            )
            if item
        )
        plain_text_parts.append(
            f"Card {card['cardId']}{title}{subtitle}{f'. {section_part}' if section_part else ''}"
        )

    return {"cards": cards, "plainText": "\n".join(plain_text_parts)}


def _normalize_actor(input_payload: Any) -> dict[str, Any] | None:
    raw = _as_mapping(input_payload)
    name = _as_string(raw.get("name")) if raw else None

    if not raw or not name:
        return None

    return {
        "name": name,
        "displayName": _as_string(raw.get("displayName")),
        "type": _as_string(raw.get("type")),
    }


def _parse_action_type(raw: RawMapping, common: RawMapping | None) -> str:
    if raw.get("dialogEventType") == "SUBMIT_DIALOG":
        return "dialog_submit"

    if common and common.get("eventType") in {"WIDGET_UPDATE", "WIDGET_UPDATED"}:
        return "widget_update"

    return "card_click"


def _parse_parameters(raw: RawMapping, common: RawMapping | None) -> dict[str, str]:
    action = _as_mapping(raw.get("action"))
    action_parameters = _parameters_object_from_array(action.get("parameters") if action else None)
    common_parameters = {
        item["key"]: item["value"]
        for item in _sorted_parameters(common.get("parameters") if common else None)
    }

    return _sort_object({**action_parameters, **common_parameters})


def _parse_form_input(input_payload: Any) -> dict[str, Any]:
    raw = _as_mapping(input_payload)
    string_inputs = _as_mapping(raw.get("stringInputs")) if raw else None
    values = [str(value) for value in _as_list(string_inputs.get("value") if string_inputs else None)]

    if values:
        return {"kind": "string", "values": values, "value": values[0]}

    date_input = _as_mapping(raw.get("dateInput")) if raw else None
    time_input = _as_mapping(raw.get("timeInput")) if raw else None
    date_time_input = _as_mapping(raw.get("dateTimeInput")) if raw else None

    if date_input:
        value = str(date_input.get("msSinceEpoch", ""))
        return {"kind": "date", "values": [value] if value else [], "value": value or None}

    if time_input:
        value = f"{int(time_input.get('hours', 0)):02d}:{int(time_input.get('minutes', 0)):02d}"
        return {"kind": "time", "values": [value], "value": value}

    if date_time_input:
        value = str(date_time_input.get("msSinceEpoch", ""))
        return {
            "kind": "date_time",
            "values": [value] if value else [],
            "value": value or None,
        }

    return {"kind": "unknown", "values": [], "value": None}


def _parse_form_inputs(input_payload: Any) -> dict[str, Any]:
    raw = _as_mapping(input_payload)

    if not raw:
        return {}

    return {key: _parse_form_input(raw[key]) for key in sorted(raw)}


def summarize_card_action(event: Any) -> dict[str, Any]:
    raw = _as_mapping(event)

    if not raw:
        raise TypeError("Expected a Google Chat card action event object.")

    common = _as_mapping(raw.get("common"))
    action = _as_mapping(raw.get("action"))
    method_name = (
        _as_string(common.get("invokedFunction")) if common else None
    ) or (
        _as_string(common.get("triggeredFunction")) if common else None
    ) or (_as_string(action.get("actionMethodName")) if action else None)

    return {
        "actionType": _parse_action_type(raw, common),
        "methodName": method_name,
        "parameters": _parse_parameters(raw, common),
        "formInputs": _parse_form_inputs(common.get("formInputs") if common else None),
        "actor": _normalize_actor(raw.get("user")),
        "eventTime": _as_string(raw.get("eventTime")),
    }


def _actor_label(actor: RawMapping | None) -> str:
    if not actor:
        return "Unknown actor"

    display_name = _as_string(actor.get("displayName"))
    name = _as_string(actor.get("name")) or "unknown user"

    if display_name:
        return f"{display_name} ({name})"

    return name


def _action_phrase(summary: RawMapping) -> str:
    method_name = _as_string(summary.get("methodName")) or "unknown action"
    action_type = summary.get("actionType")

    if action_type == "dialog_submit":
        return f"submitted dialog {method_name}"

    if action_type == "widget_update":
        return f"updated widget via {method_name}"

    return f"clicked card action {method_name}"


def _button_choice(summary: RawMapping) -> str | None:
    if summary.get("actionType") != "card_click":
        return None

    parameters = _as_mapping(summary.get("parameters")) or {}
    for key in ["decision", "choice", "button", "action"]:
        value = _as_string(parameters.get(key))
        if value:
            return f"{key}={value}"

    return None


def _form_pairs(inputs: RawMapping) -> str:
    pairs: list[str] = []

    for key in sorted(inputs):
        input_summary = _as_mapping(inputs[key]) or {}
        values = [str(value) for value in _as_list(input_summary.get("values"))]
        value = ", ".join(values) or _as_string(input_summary.get("value")) or ""
        pairs.append(f"{key}={value}")

    return "; ".join(pairs)


def render_card_action_note(summary: RawMapping) -> str:
    parts = [
        "System Note: "
        f"{_actor_label(_as_mapping(summary.get('actor')))} "
        f"{_action_phrase(summary)} at "
        f"{_as_string(summary.get('eventTime')) or 'unknown time'}."
    ]
    choice = _button_choice(summary)
    parameters = _format_pairs(_as_mapping(summary.get("parameters")) or {})
    form_values = _form_pairs(_as_mapping(summary.get("formInputs")) or {})

    if choice:
        parts.append(f"Button choice: {choice}.")

    if parameters:
        parts.append(f"Parameters: {parameters}.")

    if form_values:
        parts.append(f"Form values: {form_values}.")

    return " ".join(parts)


def encode_card_action_state(state: Any) -> str:
    try:
        encoded_json = json.dumps(state, separators=(",", ":")).encode("utf-8")
    except TypeError as exc:
        raise TypeError("Card action state must be JSON serializable.") from exc

    return (
        "v1."
        + base64.urlsafe_b64encode(encoded_json).decode("ascii").rstrip("=")
    )


def decode_card_action_state(encoded: str) -> Any:
    if not isinstance(encoded, str) or not encoded.startswith("v1."):
        raise TypeError("Card action state must use the v1. base64url format.")

    payload = encoded[3:]
    padding = "=" * ((4 - len(payload) % 4) % 4)
    try:
        decoded = base64.urlsafe_b64decode((payload + padding).encode("ascii"))
        return json.loads(decoded.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - callers need one stable decode failure.
        raise TypeError(f"Card action state could not be decoded: {exc}") from exc


def with_card_action_state(
    action: RawMapping,
    state: Any,
    parameter_name: str = DEFAULT_CARD_ACTION_STATE_PARAMETER,
) -> dict[str, Any]:
    return {
        **dict(action),
        "parameters": {
            **dict(_as_mapping(action.get("parameters")) or {}),
            parameter_name: encode_card_action_state(state),
        },
    }


def _is_card_action_summary(input_payload: Any) -> bool:
    raw = _as_mapping(input_payload)
    return bool(
        raw
        and raw.get("actionType")
        in {"card_click", "dialog_submit", "dialog_cancel", "widget_update"}
        and _as_mapping(raw.get("parameters")) is not None
        and _as_mapping(raw.get("formInputs")) is not None
    )


def _card_action_summary_from(input_payload: Any) -> dict[str, Any]:
    if _is_card_action_summary(input_payload):
        return dict(input_payload)
    return summarize_card_action(input_payload)


def read_card_action_state(
    input_payload: Any,
    parameter_name: str = DEFAULT_CARD_ACTION_STATE_PARAMETER,
) -> Any | None:
    summary = _card_action_summary_from(input_payload)
    parameters = _as_mapping(summary.get("parameters")) or {}
    encoded = _as_string(parameters.get(parameter_name))
    return None if encoded is None else decode_card_action_state(encoded)


def _route_key_for(action_type: str | None) -> str | None:
    return {
        "card_click": "cardClick",
        "dialog_submit": "dialogSubmit",
        "dialog_cancel": "dialogCancel",
        "widget_update": "widgetUpdate",
    }.get(action_type or "")


def route_card_action(
    input_payload: Any,
    handlers: Mapping[str, Any],
) -> dict[str, Any]:
    summary = _card_action_summary_from(input_payload)
    methods = _as_mapping(handlers.get("methods")) or {}
    method_name = _as_string(summary.get("methodName"))
    method_handler = methods.get(method_name) if method_name else None

    if callable(method_handler):
        return {
            "matched": True,
            "route": f"method:{method_name}",
            "summary": summary,
            "result": method_handler(summary),
        }

    route_key = _route_key_for(_as_string(summary.get("actionType")))
    type_handler = handlers.get(route_key) if route_key else None
    if callable(type_handler):
        return {
            "matched": True,
            "route": route_key,
            "summary": summary,
            "result": type_handler(summary),
        }

    unknown_handler = handlers.get("unknown")
    if callable(unknown_handler):
        return {
            "matched": True,
            "route": "unknown",
            "summary": summary,
            "result": unknown_handler(summary),
        }

    return {
        "matched": False,
        "route": None,
        "summary": summary,
        "result": None,
    }
