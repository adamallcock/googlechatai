import {
  buildSourcesCard,
  buildThinkingCard,
  buildToolStatusCard,
  type BuiltCardMessage,
  type SourceCardSource,
  type ToolStatusItem,
} from "../cards/index.js";

const SCHEMA_VERSION = "2026-07-06";
const MAX_SUMMARY_CHARS = 600;

type JsonRecord = Record<string, unknown>;

export interface AgentInteropOptions {
  provider?: string | null;
  sdk?: string | null;
  responseId?: string | null;
  maxSummaryChars?: number;
}

export interface AgentSource {
  id: string | null;
  title: string | null;
  url: string | null;
  sourceType: string | null;
  provider: string | null;
  referenceText: string | null;
  startIndex: number | null;
  endIndex: number | null;
}

export interface AgentToolCall {
  id: string | null;
  name: string;
  status: string;
  inputSummary: string | null;
  stepIndex: number | null;
  provider: string | null;
}

export interface AgentToolResult {
  id: string | null;
  name: string;
  status: string;
  outputSummary: string | null;
  stepIndex: number | null;
  provider: string | null;
}

export interface AgentThinkingSummary {
  text: string;
  provider: string | null;
  stepIndex: number | null;
}

export interface AgentUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  provider: string | null;
}

export interface AgentCost {
  amountUsd: number | null;
  currency: string | null;
  source: string | null;
  note: string | null;
}

export interface AgentRawShape {
  topLevelKeys: string[];
  contentTypes: string[];
  stepTypes: string[];
  itemTypes: string[];
}

export interface NormalizedAgentResponse {
  kind: "agent_response";
  schemaVersion: string;
  provider: string | null;
  sdk: string | null;
  responseId: string | null;
  finalText: string | null;
  sources: AgentSource[];
  toolCalls: AgentToolCall[];
  toolResults: AgentToolResult[];
  thinkingSummaries: AgentThinkingSummary[];
  usage: AgentUsage | null;
  cost: AgentCost | null;
  warnings: string[];
  systemNotes: string[];
  rawShape: AgentRawShape;
}

export interface AgentResponseMessagePlan {
  kind: "agent_response_message_plan";
  schemaVersion: string;
  responseId: string | null;
  text: string;
  summary: {
    provider: string | null;
    sdk: string | null;
    sourceCount: number;
    toolCallCount: number;
    toolResultCount: number;
    thinkingSummaryCount: number;
    hasCost: boolean;
  };
  cards: {
    sources: BuiltCardMessage | null;
    thinking: BuiltCardMessage | null;
    toolStatus: BuiltCardMessage | null;
  };
  messageSequence: Array<{ purpose: string; payload: JsonRecord }>;
  systemNotes: string[];
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asInteger(value: unknown): number | null {
  const valueNumber = asNumber(value);
  return valueNumber !== null ? Math.trunc(valueNumber) : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = asString(value);
    if (text !== null) {
      return text;
    }
  }
  return null;
}

function firstInteger(...values: unknown[]): number | null {
  for (const value of values) {
    const integer = asInteger(value);
    if (integer !== null) {
      return integer;
    }
  }
  return null;
}

function sortedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortedDeep(item));
  }
  const record = asRecord(value);
  if (!record) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortedDeep(record[key])]),
  );
}

function maybeParseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function truncateText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, Math.max(0, maxChars - 3))}...` : value;
}

function summarizeValue(value: unknown, maxChars = MAX_SUMMARY_CHARS): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    const parsed = maybeParseJsonString(value);
    if (parsed !== value) {
      return summarizeValue(parsed, maxChars);
    }
    return truncateText(value, maxChars);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return truncateText(JSON.stringify(sortedDeep(value)), maxChars);
}

function uniquePush(values: string[], value: unknown): void {
  const text = asString(value);
  if (text && !values.includes(text)) {
    values.push(text);
  }
}

function collectRawShape(input: unknown): AgentRawShape {
  const top = asRecord(input);
  const shape: AgentRawShape = {
    topLevelKeys: top ? Object.keys(top).sort() : [],
    contentTypes: [],
    stepTypes: [],
    itemTypes: [],
  };

  const visit = (value: unknown, parentKey: string | null): void => {
    const record = asRecord(value);
    if (record) {
      if (parentKey === "content") {
        uniquePush(shape.contentTypes, record.type);
      }
      if (parentKey === "steps") {
        uniquePush(shape.stepTypes, record.type);
      }
      if (parentKey === "newItems" || parentKey === "new_items") {
        uniquePush(shape.itemTypes, record.type);
      }
      for (const [key, child] of Object.entries(record)) {
        visit(child, key);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, parentKey));
    }
  };

  visit(input, null);
  return shape;
}

function detectProvider(input: unknown, options: AgentInteropOptions): { provider: string | null; sdk: string | null } {
  const withOverrides = (provider: string | null, sdk: string | null) => ({
    provider: options.provider ?? provider,
    sdk: options.sdk ?? sdk,
  });
  const raw = asRecord(input);
  if (!raw) {
    return withOverrides(null, null);
  }

  const contentTypes = asArray(raw.content).map((item) => asRecord(item)?.type);
  const stepTypes = asArray(raw.steps).map((item) => asRecord(item)?.type);

  if (contentTypes.includes("tool_use") || contentTypes.includes("thinking")) {
    return withOverrides("anthropic", "anthropic-sdk");
  }
  if (raw.finalOutput !== undefined || raw.final_output !== undefined || raw.newItems !== undefined || raw.new_items !== undefined) {
    return withOverrides("openai", "openai-agents-sdk");
  }
  if (raw.output_text !== undefined || stepTypes.includes("google_search_call")) {
    return withOverrides("google", "google-genai");
  }
  if (raw.toolCalls !== undefined || raw.toolResults !== undefined || raw.totalUsage !== undefined || raw.reasoningText !== undefined) {
    return withOverrides("vercel-ai", "vercel-ai-sdk");
  }

  return withOverrides(null, null);
}

function responseId(input: JsonRecord, options: AgentInteropOptions): string | null {
  return options.responseId ?? firstString(input.id, input.responseId, input.response_id);
}

function finalText(input: JsonRecord, provider: string | null): string | null {
  if (provider === "anthropic") {
    const text = asArray(input.content)
      .map((item) => {
        const block = asRecord(item);
        return block?.type === "text" ? asString(block.text) : null;
      })
      .filter((item): item is string => item !== null)
      .join("\n");
    return text || firstString(input.text, input.output_text);
  }

  const direct = firstString(input.finalOutput, input.final_output, input.output_text, input.outputText, input.text);
  if (direct !== null) {
    return direct;
  }

  const finalOutput = input.finalOutput ?? input.final_output;
  return finalOutput !== undefined && finalOutput !== null ? summarizeValue(finalOutput) : null;
}

function normalizeSource(raw: JsonRecord, provider: string | null): AgentSource | null {
  const url = firstString(raw.url, raw.uri);
  const title = firstString(raw.title, raw.document_title, raw.name, url);
  const rawSourceType = firstString(raw.sourceType, raw.source_type, raw.type);
  const sourceType = rawSourceType === "url_citation" ? "url" : rawSourceType ?? (url ? "url" : null);
  if (!url && !title) {
    return null;
  }
  return {
    id: firstString(raw.id, raw.sourceId, raw.source_id),
    title,
    url,
    sourceType,
    provider,
    referenceText: firstString(raw.referenceText, raw.reference_text, raw.cited_text, raw.snippet),
    startIndex: firstInteger(raw.startIndex, raw.start_index),
    endIndex: firstInteger(raw.endIndex, raw.end_index),
  };
}

function dedupeSources(sources: AgentSource[]): AgentSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.id ?? ""}|${source.url ?? ""}|${source.title ?? ""}|${source.startIndex ?? ""}|${source.endIndex ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function collectSources(input: JsonRecord, provider: string | null): AgentSource[] {
  const sources: AgentSource[] = [];

  for (const source of asArray(input.sources)) {
    const normalized = normalizeSource(asRecord(source) ?? {}, provider);
    if (normalized) {
      sources.push(normalized);
    }
  }

  const collectCitations = (content: unknown): void => {
    const block = asRecord(content);
    if (!block) {
      return;
    }
    for (const citation of [...asArray(block.citations), ...asArray(block.annotations)]) {
      const normalized = normalizeSource(asRecord(citation) ?? {}, provider);
      if (normalized) {
        sources.push(normalized);
      }
    }
    if (block.type === "source") {
      const normalized = normalizeSource(block, provider);
      if (normalized) {
        sources.push(normalized);
      }
    }
  };

  for (const block of asArray(input.content)) {
    collectCitations(block);
  }

  for (const step of asArray(input.steps)) {
    const stepRecord = asRecord(step);
    for (const block of asArray(stepRecord?.content)) {
      collectCitations(block);
    }
    for (const source of asArray(stepRecord?.sources)) {
      const normalized = normalizeSource(asRecord(source) ?? {}, provider);
      if (normalized) {
        sources.push(normalized);
      }
    }
  }

  return dedupeSources(sources);
}

function toolName(raw: JsonRecord, fallback: string): string {
  const functionRecord = asRecord(raw.function);
  return firstString(raw.name, raw.toolName, raw.tool_name, functionRecord?.name) ?? fallback;
}

function toolId(raw: JsonRecord): string | null {
  return firstString(raw.id, raw.toolCallId, raw.tool_call_id, raw.call_id, raw.callId);
}

function toolInput(raw: JsonRecord): unknown {
  const functionRecord = asRecord(raw.function);
  return raw.input ?? raw.args ?? raw.arguments ?? functionRecord?.arguments ?? null;
}

function collectToolCalls(input: JsonRecord, provider: string | null, maxChars: number): AgentToolCall[] {
  const calls: AgentToolCall[] = [];
  const push = (raw: JsonRecord, stepIndex: number | null, fallbackName = "tool"): void => {
    calls.push({
      id: toolId(raw),
      name: toolName(raw, fallbackName),
      status: "requested",
      inputSummary: summarizeValue(toolInput(raw), maxChars),
      stepIndex,
      provider,
    });
  };

  if (provider === "anthropic") {
    for (const block of asArray(input.content)) {
      const raw = asRecord(block);
      if (raw?.type === "tool_use") {
        push(raw, null);
      }
    }
  }

  for (const raw of asArray(input.toolCalls).map((item) => asRecord(item)).filter((item): item is JsonRecord => item !== null)) {
    push(raw, null);
  }

  for (const [index, step] of asArray(input.steps).entries()) {
    const stepRecord = asRecord(step);
    if (!stepRecord) {
      continue;
    }
    if (stepRecord.type === "google_search_call") {
      calls.push({
        id: toolId(stepRecord),
        name: "google_search",
        status: "requested",
        inputSummary: summarizeValue(stepRecord.arguments, maxChars),
        stepIndex: index,
        provider,
      });
    }
    for (const raw of asArray(stepRecord.toolCalls).map((item) => asRecord(item)).filter((item): item is JsonRecord => item !== null)) {
      push(raw, index);
    }
  }

  for (const item of [...asArray(input.newItems), ...asArray(input.new_items)]) {
    const itemRecord = asRecord(item);
    const raw = asRecord(itemRecord?.rawItem ?? itemRecord?.raw_item ?? itemRecord?.item) ?? itemRecord;
    const type = asString(itemRecord?.type) ?? "";
    if (raw && ((type.includes("tool_call") && !type.includes("output")) || raw.type === "function_call")) {
      push(raw, null);
    }
  }

  return calls;
}

function collectToolResults(input: JsonRecord, provider: string | null, maxChars: number): AgentToolResult[] {
  const results: AgentToolResult[] = [];
  const push = (raw: JsonRecord, stepIndex: number | null, fallbackName = "tool"): void => {
    results.push({
      id: toolId(raw),
      name: toolName(raw, fallbackName),
      status: "completed",
      outputSummary: summarizeValue(raw.output ?? raw.result ?? raw.content ?? raw.response, maxChars),
      stepIndex,
      provider,
    });
  };

  for (const raw of asArray(input.toolResults).map((item) => asRecord(item)).filter((item): item is JsonRecord => item !== null)) {
    push(raw, null);
  }

  if (provider === "anthropic") {
    for (const block of asArray(input.content)) {
      const raw = asRecord(block);
      if (raw?.type === "tool_result") {
        push(raw, null);
      }
    }
  }

  for (const [index, step] of asArray(input.steps).entries()) {
    const stepRecord = asRecord(step);
    if (!stepRecord) {
      continue;
    }
    if (stepRecord.type === "google_search_result") {
      results.push({
        id: toolId(stepRecord),
        name: "google_search",
        status: "completed",
        outputSummary: asArray(stepRecord.result).some((item) => asRecord(item)?.search_suggestions)
          ? "Search suggestions available."
          : summarizeValue(stepRecord.result, maxChars),
        stepIndex: index,
        provider,
      });
    }
    for (const raw of asArray(stepRecord.toolResults).map((item) => asRecord(item)).filter((item): item is JsonRecord => item !== null)) {
      push(raw, index);
    }
  }

  for (const item of [...asArray(input.newItems), ...asArray(input.new_items)]) {
    const itemRecord = asRecord(item);
    const raw = asRecord(itemRecord?.rawItem ?? itemRecord?.raw_item ?? itemRecord?.item) ?? itemRecord;
    const type = asString(itemRecord?.type) ?? "";
    if (raw && (type.includes("tool_call_output") || type.includes("tool_result") || raw.type === "function_call_output")) {
      push(raw, null);
    }
  }

  return results;
}

function reconcileToolResultNames(
  calls: AgentToolCall[],
  results: AgentToolResult[],
): AgentToolResult[] {
  const namesById = new Map(
    calls
      .filter((call) => call.id)
      .map((call) => [call.id as string, call.name] as const),
  );
  return results.map((result) => {
    const name = result.id ? namesById.get(result.id) : undefined;
    return name && result.name === "tool" ? { ...result, name } : result;
  });
}

function summaryText(value: unknown): string | null {
  const direct = asString(value);
  if (direct) {
    return direct;
  }
  const raw = asRecord(value);
  return raw ? firstString(raw.text, raw.summary, raw.thinking) : null;
}

function collectThinking(input: JsonRecord, provider: string | null): AgentThinkingSummary[] {
  const summaries: AgentThinkingSummary[] = [];
  const push = (text: string | null, stepIndex: number | null): void => {
    if (text) {
      summaries.push({ text, provider, stepIndex });
    }
  };

  for (const block of asArray(input.content)) {
    const raw = asRecord(block);
    if (raw?.type === "thinking") {
      push(firstString(raw.thinking, raw.summary, raw.text), null);
    }
  }

  push(firstString(input.reasoningText, input.reasoning_text), null);
  for (const item of asArray(input.reasoning)) {
    push(summaryText(item), null);
  }

  for (const [index, step] of asArray(input.steps).entries()) {
    const raw = asRecord(step);
    if (raw?.type === "thought") {
      const parts = asArray(raw.summary).map(summaryText).filter((item): item is string => item !== null);
      push(parts.join("\n") || firstString(raw.text), index);
    }
  }

  for (const item of [...asArray(input.newItems), ...asArray(input.new_items)]) {
    const itemRecord = asRecord(item);
    const raw = asRecord(itemRecord?.rawItem ?? itemRecord?.raw_item ?? itemRecord?.item) ?? itemRecord;
    const type = asString(itemRecord?.type) ?? "";
    if (raw && type.includes("reasoning")) {
      const parts = asArray(raw.summary).map(summaryText).filter((entry): entry is string => entry !== null);
      push(parts.join("\n") || firstString(raw.text, raw.summary), null);
    }
  }

  return summaries;
}

function usageTokens(raw: JsonRecord, provider: string | null): AgentUsage | null {
  const details = asRecord(raw.output_tokens_details ?? raw.outputTokensDetails);
  const inputTokens = firstInteger(raw.inputTokens, raw.input_tokens, raw.prompt_token_count, raw.promptTokenCount);
  const outputTokens = firstInteger(raw.outputTokens, raw.output_tokens, raw.candidates_token_count, raw.candidatesTokenCount);
  const totalTokens =
    firstInteger(raw.totalTokens, raw.total_tokens, raw.total_token_count, raw.totalTokenCount) ??
    (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  const cachedInputTokens = firstInteger(
    raw.cachedInputTokens,
    raw.cached_input_tokens,
    raw.cache_read_input_tokens,
    raw.cacheReadInputTokens,
  );
  const reasoningTokens = firstInteger(raw.reasoningTokens, raw.reasoning_tokens, details?.reasoning_tokens, details?.reasoningTokens);

  if ([inputTokens, outputTokens, totalTokens, cachedInputTokens, reasoningTokens].every((value) => value === null)) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningTokens,
    provider,
  };
}

function collectUsage(input: JsonRecord, provider: string | null): AgentUsage | null {
  const directCandidates = [
    asRecord(input.totalUsage),
    asRecord(input.total_usage),
    asRecord(input.usage),
    asRecord(input.usage_metadata),
    asRecord(input.usageMetadata),
  ].filter((item): item is JsonRecord => item !== null);

  for (const candidate of directCandidates) {
    const usage = usageTokens(candidate, provider);
    if (usage) {
      return usage;
    }
  }

  for (const response of [...asArray(input.rawResponses), ...asArray(input.raw_responses)]) {
    const raw = asRecord(response);
    const usage = usageTokens(asRecord(raw?.usage) ?? {}, provider);
    if (usage) {
      return usage;
    }
  }

  return null;
}

function normalizeCostCandidate(value: unknown): AgentCost | null {
  const numeric = asNumber(value);
  if (numeric !== null) {
    return { amountUsd: numeric, currency: "USD", source: "cost-metadata", note: null };
  }
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  const amountUsd = asNumber(raw.amountUsd) ?? asNumber(raw.totalCostUsd) ?? asNumber(raw.costUsd) ?? asNumber(raw.costUSD);
  if (amountUsd === null) {
    return null;
  }
  return {
    amountUsd,
    currency: firstString(raw.currency) ?? "USD",
    source: firstString(raw.source) ?? "cost-metadata",
    note: firstString(raw.note),
  };
}

function collectCost(input: JsonRecord): AgentCost | null {
  const providerMetadata = asRecord(input.providerMetadata ?? input.provider_metadata);
  const candidates = [
    input.cost,
    input.estimatedCost,
    input.estimated_cost,
    providerMetadata?.aicost,
    providerMetadata?.aiCost,
    providerMetadata?.cost,
  ];
  for (const candidate of candidates) {
    const cost = normalizeCostCandidate(candidate);
    if (cost) {
      return cost;
    }
  }
  return null;
}

function collectWarnings(input: JsonRecord): string[] {
  return asArray(input.warnings)
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      const raw = asRecord(item);
      if (!raw) {
        return null;
      }
      const message = firstString(raw.message, raw.text, raw.warning);
      const type = firstString(raw.type, raw.code);
      return message ? (type ? `${type}: ${message}` : message) : summarizeValue(raw);
    })
    .filter((item): item is string => item !== null);
}

function providerNote(provider: string | null, sdk: string | null): string {
  if (provider === "anthropic") {
    return "Agent response normalized from Anthropic SDK content blocks.";
  }
  if (sdk === "openai-agents-sdk") {
    return "Agent response normalized from OpenAI Agents SDK run result.";
  }
  if (sdk === "vercel-ai-sdk") {
    return "Agent response normalized from Vercel AI SDK result.";
  }
  if (sdk === "google-genai") {
    return "Agent response normalized from Google GenAI Interactions response.";
  }
  return "Agent response normalized from a generic agent SDK result.";
}

export function normalizeAgentResponse(
  input: unknown,
  options: AgentInteropOptions = {},
): NormalizedAgentResponse {
  const raw = asRecord(input) ?? {};
  const { provider, sdk } = detectProvider(raw, options);
  const maxChars = options.maxSummaryChars ?? MAX_SUMMARY_CHARS;
  const thinkingSummaries = collectThinking(raw, provider);
  const toolCalls = collectToolCalls(raw, provider, maxChars);
  const toolResults = reconcileToolResultNames(
    toolCalls,
    collectToolResults(raw, provider, maxChars),
  );
  const systemNotes = [providerNote(provider, sdk)];

  if (thinkingSummaries.length > 0) {
    systemNotes.push(
      "Thinking summaries are provider-provided summaries only; hidden chain-of-thought is not inferred.",
    );
  }

  return {
    kind: "agent_response",
    schemaVersion: SCHEMA_VERSION,
    provider,
    sdk,
    responseId: responseId(raw, options),
    finalText: finalText(raw, provider),
    sources: collectSources(raw, provider),
    toolCalls,
    toolResults,
    thinkingSummaries,
    usage: collectUsage(raw, provider),
    cost: collectCost(raw),
    warnings: collectWarnings(raw),
    systemNotes,
    rawShape: collectRawShape(raw),
  };
}

function sourceCardSource(source: AgentSource): SourceCardSource {
  return {
    title: source.title ?? source.url ?? "Untitled source",
    ...(source.url ? { url: source.url } : {}),
    ...(source.sourceType ? { label: source.sourceType.toUpperCase() } : {}),
    ...(source.referenceText ? { snippet: source.referenceText } : {}),
  };
}

function toolStatusItems(response: NormalizedAgentResponse): ToolStatusItem[] {
  const byKey = new Map<string, ToolStatusItem>();
  for (const call of response.toolCalls) {
    const key = call.id ?? call.name;
    byKey.set(key, {
      name: call.name,
      status: call.status,
      ...(call.inputSummary ? { detail: call.inputSummary } : {}),
    });
  }
  for (const result of response.toolResults) {
    const key = result.id ?? result.name;
    const existing = byKey.get(key);
    byKey.set(key, {
      name: existing?.name ?? result.name,
      status: result.status,
      ...(existing?.detail ? { detail: existing.detail } : {}),
      ...(result.outputSummary ? { output: result.outputSummary } : {}),
    });
  }
  return [...byKey.values()];
}

export function planAgentResponseMessage(
  input: unknown,
  options: AgentInteropOptions = {},
): AgentResponseMessagePlan {
  const response = normalizeAgentResponse(input, options);
  const responseIdValue = options.responseId ?? response.responseId;
  const text = response.finalText ?? "Agent response did not include final text.";
  const sources =
    response.sources.length > 0
      ? buildSourcesCard({
          cardId: "agent-sources",
          responseId: responseIdValue ?? undefined,
          sources: response.sources.map(sourceCardSource),
        })
      : null;
  const thinking =
    response.thinkingSummaries.length > 0
      ? buildThinkingCard({
          cardId: "agent-thinking",
          status: "available",
          detail: response.thinkingSummaries.map((item) => item.text).join("\n"),
        })
      : null;
  const tools = toolStatusItems(response);
  const toolStatus =
    tools.length > 0
      ? buildToolStatusCard({
          cardId: "agent-tool-status",
          tools,
        })
      : null;
  const messageSequence: Array<{ purpose: string; payload: JsonRecord }> = [
    { purpose: "final_text", payload: { text } },
  ];

  if (sources) {
    messageSequence.push({ purpose: "sources", payload: sources as unknown as JsonRecord });
  }
  if (thinking) {
    messageSequence.push({ purpose: "thinking", payload: thinking as unknown as JsonRecord });
  }
  if (toolStatus) {
    messageSequence.push({ purpose: "tool_status", payload: toolStatus as unknown as JsonRecord });
  }

  return {
    kind: "agent_response_message_plan",
    schemaVersion: SCHEMA_VERSION,
    responseId: responseIdValue ?? null,
    text,
    summary: {
      provider: response.provider,
      sdk: response.sdk,
      sourceCount: response.sources.length,
      toolCallCount: response.toolCalls.length,
      toolResultCount: response.toolResults.length,
      thinkingSummaryCount: response.thinkingSummaries.length,
      hasCost: response.cost !== null,
    },
    cards: {
      sources,
      thinking,
      toolStatus,
    },
    messageSequence,
    systemNotes: response.systemNotes,
  };
}
