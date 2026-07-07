"""Normalize agent SDK results into Google Chat-ready response context."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from .cards import build_sources_card, build_thinking_card, build_tool_status_card


SCHEMA_VERSION = "2026-07-06"
MAX_SUMMARY_CHARS = 600


def _as_mapping(value: Any) -> Mapping[str, Any] | None:
    return value if isinstance(value, Mapping) else None


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _as_number(value: Any) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _as_integer(value: Any) -> int | None:
    number = _as_number(value)
    return int(number) if number is not None else None


def _first_string(*values: Any) -> str | None:
    for value in values:
        text = _as_string(value)
        if text is not None:
            return text
    return None


def _first_integer(*values: Any) -> int | None:
    for value in values:
        integer = _as_integer(value)
        if integer is not None:
            return integer
    return None


def _first_number(*values: Any) -> int | float | None:
    for value in values:
        number = _as_number(value)
        if number is not None:
            return number
    return None


def _sort_deep(value: Any) -> Any:
    if isinstance(value, list):
        return [_sort_deep(item) for item in value]
    raw = _as_mapping(value)
    if raw is None:
        return value
    return {key: _sort_deep(raw[key]) for key in sorted(raw)}


def _maybe_parse_json_string(value: str) -> Any:
    stripped = value.strip()
    if not stripped.startswith(("{", "[")):
        return value
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return value


def _truncate_text(value: str, max_chars: int) -> str:
    return f"{value[: max(0, max_chars - 3)]}..." if len(value) > max_chars else value


def _summarize_value(value: Any, max_chars: int = MAX_SUMMARY_CHARS) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        parsed = _maybe_parse_json_string(value)
        if parsed is not value:
            return _summarize_value(parsed, max_chars)
        return _truncate_text(value, max_chars)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return _truncate_text(
        json.dumps(_sort_deep(value), ensure_ascii=False, separators=(",", ":")),
        max_chars,
    )


def _unique_push(values: list[str], value: Any) -> None:
    text = _as_string(value)
    if text and text not in values:
        values.append(text)


def _collect_raw_shape(input_data: Any) -> dict[str, Any]:
    top = _as_mapping(input_data)
    shape = {
        "topLevelKeys": sorted(top.keys()) if top else [],
        "contentTypes": [],
        "stepTypes": [],
        "itemTypes": [],
    }

    def visit(value: Any, parent_key: str | None) -> None:
        raw = _as_mapping(value)
        if raw is not None:
            if parent_key == "content":
                _unique_push(shape["contentTypes"], raw.get("type"))
            if parent_key == "steps":
                _unique_push(shape["stepTypes"], raw.get("type"))
            if parent_key in {"newItems", "new_items"}:
                _unique_push(shape["itemTypes"], raw.get("type"))
            for key, child in raw.items():
                visit(child, key)
            return
        if isinstance(value, list):
            for item in value:
                visit(item, parent_key)

    visit(input_data, None)
    return shape


def _detect_provider(input_data: Mapping[str, Any], options: Mapping[str, Any]) -> tuple[str | None, str | None]:
    def with_overrides(provider: str | None, sdk: str | None) -> tuple[str | None, str | None]:
        return _as_string(options.get("provider")) or provider, _as_string(options.get("sdk")) or sdk

    content_types = [_as_mapping(item).get("type") for item in _as_list(input_data.get("content")) if _as_mapping(item)]
    step_types = [_as_mapping(item).get("type") for item in _as_list(input_data.get("steps")) if _as_mapping(item)]

    if "tool_use" in content_types or "thinking" in content_types:
        return with_overrides("anthropic", "anthropic-sdk")
    if any(key in input_data for key in ["finalOutput", "final_output", "newItems", "new_items"]):
        return with_overrides("openai", "openai-agents-sdk")
    if "output_text" in input_data or "google_search_call" in step_types:
        return with_overrides("google", "google-genai")
    if any(key in input_data for key in ["toolCalls", "toolResults", "totalUsage", "reasoningText"]):
        return with_overrides("vercel-ai", "vercel-ai-sdk")
    return with_overrides(None, None)


def _response_id(input_data: Mapping[str, Any], options: Mapping[str, Any]) -> str | None:
    return _as_string(options.get("responseId")) or _first_string(
        input_data.get("id"), input_data.get("responseId"), input_data.get("response_id")
    )


def _final_text(input_data: Mapping[str, Any], provider: str | None) -> str | None:
    if provider == "anthropic":
        text = "\n".join(
            block.get("text")
            for block in (_as_mapping(item) for item in _as_list(input_data.get("content")))
            if block and block.get("type") == "text" and isinstance(block.get("text"), str)
        )
        return text or _first_string(input_data.get("text"), input_data.get("output_text"))

    direct = _first_string(
        input_data.get("finalOutput"),
        input_data.get("final_output"),
        input_data.get("output_text"),
        input_data.get("outputText"),
        input_data.get("text"),
    )
    if direct is not None:
        return direct

    final_output = input_data.get("finalOutput", input_data.get("final_output"))
    return _summarize_value(final_output) if final_output is not None else None


def _normalize_source(raw: Mapping[str, Any], provider: str | None) -> dict[str, Any] | None:
    url = _first_string(raw.get("url"), raw.get("uri"))
    title = _first_string(raw.get("title"), raw.get("document_title"), raw.get("name"), url)
    raw_source_type = _first_string(raw.get("sourceType"), raw.get("source_type"), raw.get("type"))
    source_type = "url" if raw_source_type == "url_citation" else raw_source_type or ("url" if url else None)
    if not url and not title:
        return None
    return {
        "id": _first_string(raw.get("id"), raw.get("sourceId"), raw.get("source_id")),
        "title": title,
        "url": url,
        "sourceType": source_type,
        "provider": provider,
        "referenceText": _first_string(
            raw.get("referenceText"),
            raw.get("reference_text"),
            raw.get("cited_text"),
            raw.get("snippet"),
        ),
        "startIndex": _first_integer(raw.get("startIndex"), raw.get("start_index")),
        "endIndex": _first_integer(raw.get("endIndex"), raw.get("end_index")),
    }


def _dedupe_sources(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    output: list[dict[str, Any]] = []
    for source in sources:
        key = "|".join(
            "" if source.get(field) is None else str(source.get(field))
            for field in ["id", "url", "title", "startIndex", "endIndex"]
        )
        if key not in seen:
            seen.add(key)
            output.append(source)
    return output


def _collect_sources(input_data: Mapping[str, Any], provider: str | None) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []

    def add_source(value: Any) -> None:
        raw = _as_mapping(value) or {}
        normalized = _normalize_source(raw, provider)
        if normalized:
            sources.append(normalized)

    def collect_citations(value: Any) -> None:
        block = _as_mapping(value)
        if not block:
            return
        for citation in [*_as_list(block.get("citations")), *_as_list(block.get("annotations"))]:
            add_source(citation)
        if block.get("type") == "source":
            add_source(block)

    for source in _as_list(input_data.get("sources")):
        add_source(source)
    for block in _as_list(input_data.get("content")):
        collect_citations(block)
    for step in _as_list(input_data.get("steps")):
        step_raw = _as_mapping(step)
        for block in _as_list(step_raw.get("content") if step_raw else None):
            collect_citations(block)
        for source in _as_list(step_raw.get("sources") if step_raw else None):
            add_source(source)

    return _dedupe_sources(sources)


def _tool_name(raw: Mapping[str, Any], fallback: str) -> str:
    function_record = _as_mapping(raw.get("function"))
    return _first_string(raw.get("name"), raw.get("toolName"), raw.get("tool_name"), function_record.get("name") if function_record else None) or fallback


def _tool_id(raw: Mapping[str, Any]) -> str | None:
    return _first_string(raw.get("id"), raw.get("toolCallId"), raw.get("tool_call_id"), raw.get("call_id"), raw.get("callId"))


def _tool_input(raw: Mapping[str, Any]) -> Any:
    function_record = _as_mapping(raw.get("function"))
    return raw.get("input", raw.get("args", raw.get("arguments", function_record.get("arguments") if function_record else None)))


def _collect_tool_calls(input_data: Mapping[str, Any], provider: str | None, max_chars: int) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    def push(raw: Mapping[str, Any], step_index: int | None, fallback_name: str = "tool") -> None:
        calls.append(
            {
                "id": _tool_id(raw),
                "name": _tool_name(raw, fallback_name),
                "status": "requested",
                "inputSummary": _summarize_value(_tool_input(raw), max_chars),
                "stepIndex": step_index,
                "provider": provider,
            }
        )

    if provider == "anthropic":
        for block in _as_list(input_data.get("content")):
            raw = _as_mapping(block)
            if raw and raw.get("type") == "tool_use":
                push(raw, None)

    for item in _as_list(input_data.get("toolCalls")):
        raw = _as_mapping(item)
        if raw:
            push(raw, None)

    for index, step in enumerate(_as_list(input_data.get("steps"))):
        step_raw = _as_mapping(step)
        if not step_raw:
            continue
        if step_raw.get("type") == "google_search_call":
            calls.append(
                {
                    "id": _tool_id(step_raw),
                    "name": "google_search",
                    "status": "requested",
                    "inputSummary": _summarize_value(step_raw.get("arguments"), max_chars),
                    "stepIndex": index,
                    "provider": provider,
                }
            )
        for item in _as_list(step_raw.get("toolCalls")):
            raw = _as_mapping(item)
            if raw:
                push(raw, index)

    for item in [*_as_list(input_data.get("newItems")), *_as_list(input_data.get("new_items"))]:
        item_raw = _as_mapping(item)
        raw = _as_mapping(item_raw.get("rawItem") if item_raw else None) or _as_mapping(item_raw.get("raw_item") if item_raw else None) or _as_mapping(item_raw.get("item") if item_raw else None) or item_raw
        item_type = _as_string(item_raw.get("type") if item_raw else None) or ""
        if raw and (("tool_call" in item_type and "output" not in item_type) or raw.get("type") == "function_call"):
            push(raw, None)

    return calls


def _collect_tool_results(input_data: Mapping[str, Any], provider: str | None, max_chars: int) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []

    def push(raw: Mapping[str, Any], step_index: int | None, fallback_name: str = "tool") -> None:
        results.append(
            {
                "id": _tool_id(raw),
                "name": _tool_name(raw, fallback_name),
                "status": "completed",
                "outputSummary": _summarize_value(
                    raw.get("output", raw.get("result", raw.get("content", raw.get("response")))),
                    max_chars,
                ),
                "stepIndex": step_index,
                "provider": provider,
            }
        )

    for item in _as_list(input_data.get("toolResults")):
        raw = _as_mapping(item)
        if raw:
            push(raw, None)

    if provider == "anthropic":
        for block in _as_list(input_data.get("content")):
            raw = _as_mapping(block)
            if raw and raw.get("type") == "tool_result":
                push(raw, None)

    for index, step in enumerate(_as_list(input_data.get("steps"))):
        step_raw = _as_mapping(step)
        if not step_raw:
            continue
        if step_raw.get("type") == "google_search_result":
            result_items = _as_list(step_raw.get("result"))
            has_suggestions = any(_as_mapping(item) and _as_mapping(item).get("search_suggestions") for item in result_items)
            results.append(
                {
                    "id": _tool_id(step_raw),
                    "name": "google_search",
                    "status": "completed",
                    "outputSummary": "Search suggestions available."
                    if has_suggestions
                    else _summarize_value(step_raw.get("result"), max_chars),
                    "stepIndex": index,
                    "provider": provider,
                }
            )
        for item in _as_list(step_raw.get("toolResults")):
            raw = _as_mapping(item)
            if raw:
                push(raw, index)

    for item in [*_as_list(input_data.get("newItems")), *_as_list(input_data.get("new_items"))]:
        item_raw = _as_mapping(item)
        raw = _as_mapping(item_raw.get("rawItem") if item_raw else None) or _as_mapping(item_raw.get("raw_item") if item_raw else None) or _as_mapping(item_raw.get("item") if item_raw else None) or item_raw
        item_type = _as_string(item_raw.get("type") if item_raw else None) or ""
        if raw and ("tool_call_output" in item_type or "tool_result" in item_type or raw.get("type") == "function_call_output"):
            push(raw, None)

    return results


def _reconcile_tool_result_names(
    calls: list[dict[str, Any]],
    results: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    names_by_id = {call["id"]: call["name"] for call in calls if call.get("id")}
    output: list[dict[str, Any]] = []
    for result in results:
        name = names_by_id.get(result.get("id"))
        output.append({**result, "name": name} if name and result["name"] == "tool" else result)
    return output


def _summary_text(value: Any) -> str | None:
    direct = _as_string(value)
    if direct:
        return direct
    raw = _as_mapping(value)
    return _first_string(raw.get("text"), raw.get("summary"), raw.get("thinking")) if raw else None


def _collect_thinking(input_data: Mapping[str, Any], provider: str | None) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []

    def push(text: str | None, step_index: int | None) -> None:
        if text:
            summaries.append({"text": text, "provider": provider, "stepIndex": step_index})

    for block in _as_list(input_data.get("content")):
        raw = _as_mapping(block)
        if raw and raw.get("type") == "thinking":
            push(_first_string(raw.get("thinking"), raw.get("summary"), raw.get("text")), None)

    push(_first_string(input_data.get("reasoningText"), input_data.get("reasoning_text")), None)
    for item in _as_list(input_data.get("reasoning")):
        push(_summary_text(item), None)

    for index, step in enumerate(_as_list(input_data.get("steps"))):
        raw = _as_mapping(step)
        if raw and raw.get("type") == "thought":
            parts = [part for part in (_summary_text(item) for item in _as_list(raw.get("summary"))) if part]
            push("\n".join(parts) or _first_string(raw.get("text")), index)

    for item in [*_as_list(input_data.get("newItems")), *_as_list(input_data.get("new_items"))]:
        item_raw = _as_mapping(item)
        raw = _as_mapping(item_raw.get("rawItem") if item_raw else None) or _as_mapping(item_raw.get("raw_item") if item_raw else None) or _as_mapping(item_raw.get("item") if item_raw else None) or item_raw
        item_type = _as_string(item_raw.get("type") if item_raw else None) or ""
        if raw and "reasoning" in item_type:
            parts = [part for part in (_summary_text(entry) for entry in _as_list(raw.get("summary"))) if part]
            push("\n".join(parts) or _first_string(raw.get("text"), raw.get("summary")), None)

    return summaries


def _usage_tokens(raw: Mapping[str, Any], provider: str | None) -> dict[str, Any] | None:
    details = _as_mapping(raw.get("output_tokens_details")) or _as_mapping(raw.get("outputTokensDetails"))
    input_tokens = _first_integer(raw.get("inputTokens"), raw.get("input_tokens"), raw.get("prompt_token_count"), raw.get("promptTokenCount"))
    output_tokens = _first_integer(raw.get("outputTokens"), raw.get("output_tokens"), raw.get("candidates_token_count"), raw.get("candidatesTokenCount"))
    total_tokens = _first_integer(raw.get("totalTokens"), raw.get("total_tokens"), raw.get("total_token_count"), raw.get("totalTokenCount"))
    if total_tokens is None and input_tokens is not None and output_tokens is not None:
        total_tokens = input_tokens + output_tokens
    cached_input_tokens = _first_integer(
        raw.get("cachedInputTokens"),
        raw.get("cached_input_tokens"),
        raw.get("cache_read_input_tokens"),
        raw.get("cacheReadInputTokens"),
    )
    reasoning_tokens = _first_integer(
        raw.get("reasoningTokens"),
        raw.get("reasoning_tokens"),
        details.get("reasoning_tokens") if details else None,
        details.get("reasoningTokens") if details else None,
    )
    if all(value is None for value in [input_tokens, output_tokens, total_tokens, cached_input_tokens, reasoning_tokens]):
        return None
    return {
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "totalTokens": total_tokens,
        "cachedInputTokens": cached_input_tokens,
        "reasoningTokens": reasoning_tokens,
        "provider": provider,
    }


def _collect_usage(input_data: Mapping[str, Any], provider: str | None) -> dict[str, Any] | None:
    for candidate in [
        _as_mapping(input_data.get("totalUsage")),
        _as_mapping(input_data.get("total_usage")),
        _as_mapping(input_data.get("usage")),
        _as_mapping(input_data.get("usage_metadata")),
        _as_mapping(input_data.get("usageMetadata")),
    ]:
        usage = _usage_tokens(candidate or {}, provider)
        if usage:
            return usage

    for response in [*_as_list(input_data.get("rawResponses")), *_as_list(input_data.get("raw_responses"))]:
        raw = _as_mapping(response)
        usage = _usage_tokens(_as_mapping(raw.get("usage") if raw else None) or {}, provider)
        if usage:
            return usage

    return None


def _normalize_cost_candidate(value: Any) -> dict[str, Any] | None:
    numeric = _as_number(value)
    if numeric is not None:
        return {"amountUsd": numeric, "currency": "USD", "source": "cost-metadata", "note": None}
    raw = _as_mapping(value)
    if raw is None:
        return None
    amount_usd = _first_number(
        raw.get("amountUsd"),
        raw.get("totalCostUsd"),
        raw.get("costUsd"),
        raw.get("costUSD"),
    )
    if amount_usd is None:
        return None
    return {
        "amountUsd": amount_usd,
        "currency": _first_string(raw.get("currency")) or "USD",
        "source": _first_string(raw.get("source")) or "cost-metadata",
        "note": _first_string(raw.get("note")),
    }


def _collect_cost(input_data: Mapping[str, Any]) -> dict[str, Any] | None:
    provider_metadata = _as_mapping(input_data.get("providerMetadata")) or _as_mapping(input_data.get("provider_metadata"))
    for candidate in [
        input_data.get("cost"),
        input_data.get("estimatedCost"),
        input_data.get("estimated_cost"),
        provider_metadata.get("aicost") if provider_metadata else None,
        provider_metadata.get("aiCost") if provider_metadata else None,
        provider_metadata.get("cost") if provider_metadata else None,
    ]:
        cost = _normalize_cost_candidate(candidate)
        if cost:
            return cost
    return None


def _collect_warnings(input_data: Mapping[str, Any]) -> list[str]:
    warnings: list[str] = []
    for item in _as_list(input_data.get("warnings")):
        if isinstance(item, str):
            warnings.append(item)
            continue
        raw = _as_mapping(item)
        if not raw:
            continue
        message = _first_string(raw.get("message"), raw.get("text"), raw.get("warning"))
        warning_type = _first_string(raw.get("type"), raw.get("code"))
        warning = f"{warning_type}: {message}" if warning_type and message else message or _summarize_value(raw)
        if warning:
            warnings.append(warning)
    return warnings


def _provider_note(provider: str | None, sdk: str | None) -> str:
    if provider == "anthropic":
        return "Agent response normalized from Anthropic SDK content blocks."
    if sdk == "openai-agents-sdk":
        return "Agent response normalized from OpenAI Agents SDK run result."
    if sdk == "vercel-ai-sdk":
        return "Agent response normalized from Vercel AI SDK result."
    if sdk == "google-genai":
        return "Agent response normalized from Google GenAI Interactions response."
    return "Agent response normalized from a generic agent SDK result."


def normalize_agent_response(input_data: Any, options: Mapping[str, Any] | None = None) -> dict[str, Any]:
    raw = _as_mapping(input_data) or {}
    raw_options = options or {}
    provider, sdk = _detect_provider(raw, raw_options)
    max_chars = _as_integer(raw_options.get("maxSummaryChars")) or MAX_SUMMARY_CHARS
    thinking_summaries = _collect_thinking(raw, provider)
    tool_calls = _collect_tool_calls(raw, provider, max_chars)
    tool_results = _reconcile_tool_result_names(
        tool_calls,
        _collect_tool_results(raw, provider, max_chars),
    )
    system_notes = [_provider_note(provider, sdk)]
    if thinking_summaries:
        system_notes.append(
            "Thinking summaries are provider-provided summaries only; hidden chain-of-thought is not inferred."
        )

    return {
        "kind": "agent_response",
        "schemaVersion": SCHEMA_VERSION,
        "provider": provider,
        "sdk": sdk,
        "responseId": _response_id(raw, raw_options),
        "finalText": _final_text(raw, provider),
        "sources": _collect_sources(raw, provider),
        "toolCalls": tool_calls,
        "toolResults": tool_results,
        "thinkingSummaries": thinking_summaries,
        "usage": _collect_usage(raw, provider),
        "cost": _collect_cost(raw),
        "warnings": _collect_warnings(raw),
        "systemNotes": system_notes,
        "rawShape": _collect_raw_shape(raw),
    }


def _source_card_source(source: Mapping[str, Any]) -> dict[str, Any]:
    output: dict[str, Any] = {
        "title": source.get("title") or source.get("url") or "Untitled source"
    }
    if source.get("url"):
        output["url"] = source["url"]
    if source.get("sourceType"):
        output["label"] = str(source["sourceType"]).upper()
    if source.get("referenceText"):
        output["snippet"] = source["referenceText"]
    return output


def _tool_status_items(response: Mapping[str, Any]) -> list[dict[str, Any]]:
    by_key: dict[str, dict[str, Any]] = {}
    for call in response["toolCalls"]:
        key = call.get("id") or call["name"]
        item = {"name": call["name"], "status": call["status"]}
        if call.get("inputSummary"):
            item["detail"] = call["inputSummary"]
        by_key[key] = item
    for result in response["toolResults"]:
        key = result.get("id") or result["name"]
        existing = by_key.get(key, {})
        item = {
            "name": existing.get("name") or result["name"],
            "status": result["status"],
        }
        if existing.get("detail"):
            item["detail"] = existing["detail"]
        if result.get("outputSummary"):
            item["output"] = result["outputSummary"]
        by_key[key] = item
    return list(by_key.values())


def plan_agent_response_message(input_data: Any, options: Mapping[str, Any] | None = None) -> dict[str, Any]:
    raw_options = options or {}
    response = normalize_agent_response(input_data, raw_options)
    response_id = _as_string(raw_options.get("responseId")) or response["responseId"]
    text = response["finalText"] or "Agent response did not include final text."
    sources = (
        build_sources_card(
            {
                "cardId": "agent-sources",
                "responseId": response_id,
                "sources": [_source_card_source(source) for source in response["sources"]],
            }
        )
        if response["sources"]
        else None
    )
    thinking = (
        build_thinking_card(
            {
                "cardId": "agent-thinking",
                "status": "available",
                "detail": "\n".join(item["text"] for item in response["thinkingSummaries"]),
            }
        )
        if response["thinkingSummaries"]
        else None
    )
    tools = _tool_status_items(response)
    tool_status = (
        build_tool_status_card({"cardId": "agent-tool-status", "tools": tools})
        if tools
        else None
    )
    message_sequence: list[dict[str, Any]] = [
        {"purpose": "final_text", "payload": {"text": text}}
    ]
    if sources:
        message_sequence.append({"purpose": "sources", "payload": sources})
    if thinking:
        message_sequence.append({"purpose": "thinking", "payload": thinking})
    if tool_status:
        message_sequence.append({"purpose": "tool_status", "payload": tool_status})

    return {
        "kind": "agent_response_message_plan",
        "schemaVersion": SCHEMA_VERSION,
        "responseId": response_id,
        "text": text,
        "summary": {
            "provider": response["provider"],
            "sdk": response["sdk"],
            "sourceCount": len(response["sources"]),
            "toolCallCount": len(response["toolCalls"]),
            "toolResultCount": len(response["toolResults"]),
            "thinkingSummaryCount": len(response["thinkingSummaries"]),
            "hasCost": response["cost"] is not None,
        },
        "cards": {
            "sources": sources,
            "thinking": thinking,
            "toolStatus": tool_status,
        },
        "messageSequence": message_sequence,
        "systemNotes": response["systemNotes"],
    }
