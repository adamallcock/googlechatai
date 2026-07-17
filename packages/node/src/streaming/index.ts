import fs from "node:fs/promises";

import { withFileStateLock, writeFileAtomically } from "../internal/file-state.js";
import {
  createRetryingChatClient,
  type AccessTokenLease,
  type GetAccessTokenInput,
  type RequestJsonWithRetryOptions,
  type RetryPolicyOptions,
} from "../transport/index.js";

type JsonObject = Record<string, unknown>;

const STATE_KIND = "chat.stream_scheduler_state";
const REPLAY_KIND = "chat.stream_scheduler_replay";
const REPORT_KIND = "chat.stream_report";
const PLACEHOLDER_HANDLE_KIND = "chat.placeholder_response_handle";

const DEFAULT_MIN_PATCH_CHARS = 120;
const DEFAULT_MIN_INTERVAL_MS = 1000;
const DEFAULT_MAX_PATCHES = 20;
const DEFAULT_MAX_MESSAGE_CHARS = 4000;
const DEFAULT_TRUNCATION_NOTE =
  "\n\n[Output truncated: Google Chat message size limit reached.]";
const DEFAULT_CONTINUATION_PREFIX = "(continued)\n";
const DEFAULT_CONTINUATION_PLACEHOLDER = "…";
const DEFAULT_CANCEL_NOTE = "\n\n[Stopped at user request.]";
const DEFAULT_ERROR_NOTE = "\n\n[Response interrupted by an error.]";
const DEFAULT_EMPTY_FINAL_TEXT = "No response was generated.";
const DEFAULT_MAX_CONSECUTIVE_PATCH_FAILURES = 3;

export interface StreamSchedulerConfig {
  minPatchChars?: number;
  minIntervalMs?: number;
  /** Back-compat alias for minIntervalMs, matching buildBufferedStreamPatches. */
  throttleMs?: number;
  maxPatches?: number;
  maxMessageChars?: number;
  overflow?: "truncate" | "split";
  prefix?: string;
  suffix?: string;
  typingIndicator?: string;
  truncationNote?: string;
  continuationPrefix?: string;
  cancelNote?: string;
  errorNote?: string;
  emptyFinalText?: string;
  maxConsecutivePatchFailures?: number;
}

export type StreamSchedulerEvent =
  | { type: "chunk"; text: string; atMs: number }
  | { type: "flush"; atMs: number }
  | { type: "finish"; atMs: number; finalText?: string }
  | { type: "cancel"; atMs: number; reason?: string }
  | { type: "error"; atMs: number; message?: string }
  | { type: "patch_result"; ok: boolean; atMs: number };

export interface StreamSchedulerAction {
  action: "patch" | "finalize" | "start_continuation";
  segmentIndex: number;
  text: string;
  updateMask: string;
  final: boolean;
  truncated?: boolean;
  cancelled?: boolean;
  errored?: boolean;
}

export interface StreamSchedulerAdvanceResult {
  state: JsonObject;
  actions: StreamSchedulerAction[];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveNumber(value: unknown, fallback: number): number {
  const number = asNumber(value);
  return number !== null && number > 0 ? number : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const number = asNumber(value);
  return number !== null && number >= 0 ? number : fallback;
}

function resolvedConfig(config: StreamSchedulerConfig = {}): JsonObject {
  const overflow = config.overflow ?? "truncate";
  if (overflow !== "truncate" && overflow !== "split") {
    throw new TypeError("Expected overflow to be either truncate or split.");
  }
  return {
    minPatchChars: positiveNumber(config.minPatchChars, DEFAULT_MIN_PATCH_CHARS),
    minIntervalMs: nonNegativeNumber(
      config.minIntervalMs ?? config.throttleMs,
      DEFAULT_MIN_INTERVAL_MS,
    ),
    maxPatches: Math.max(
      1,
      Math.floor(positiveNumber(config.maxPatches, DEFAULT_MAX_PATCHES)),
    ),
    maxMessageChars: Math.max(
      80,
      Math.floor(
        positiveNumber(config.maxMessageChars, DEFAULT_MAX_MESSAGE_CHARS),
      ),
    ),
    overflow,
    prefix: config.prefix ?? "",
    suffix: config.suffix ?? "",
    typingIndicator: config.typingIndicator ?? "",
    truncationNote: config.truncationNote ?? DEFAULT_TRUNCATION_NOTE,
    continuationPrefix: config.continuationPrefix ?? DEFAULT_CONTINUATION_PREFIX,
    cancelNote: config.cancelNote ?? DEFAULT_CANCEL_NOTE,
    errorNote: config.errorNote ?? DEFAULT_ERROR_NOTE,
    emptyFinalText: config.emptyFinalText ?? DEFAULT_EMPTY_FINAL_TEXT,
    maxConsecutivePatchFailures: Math.max(
      1,
      Math.floor(
        positiveNumber(
          config.maxConsecutivePatchFailures,
          DEFAULT_MAX_CONSECUTIVE_PATCH_FAILURES,
        ),
      ),
    ),
  };
}

export function createStreamSchedulerState(
  config: StreamSchedulerConfig = {},
): JsonObject {
  return {
    kind: STATE_KIND,
    config: resolvedConfig(config),
    content: "",
    pendingChars: 0,
    lastPatchAtMs: null,
    patchesUsed: 0,
    segmentIndex: 0,
    totalChunks: 0,
    truncated: false,
    finished: false,
    cancelled: false,
    errored: false,
    consecutivePatchFailures: 0,
    degradedToFinalOnly: false,
    warnings: [],
  };
}

interface MutableState {
  state: JsonObject;
  config: JsonObject;
  warnings: string[];
}

function cloneState(state: unknown): MutableState {
  const record = asRecord(state);
  if (!record || record.kind !== STATE_KIND) {
    throw new TypeError(`Expected state.kind to equal ${STATE_KIND}.`);
  }
  const config = asRecord(record.config);
  if (!config) {
    throw new TypeError("Expected state.config to be an object.");
  }
  const warnings = asArray(record.warnings).map((item) => String(item));
  return {
    state: { ...record, warnings },
    config,
    warnings,
  };
}

function segmentPrefix(config: JsonObject, segmentIndex: number): string {
  return segmentIndex === 0
    ? String(config.prefix)
    : String(config.continuationPrefix);
}

function renderSegment(
  config: JsonObject,
  content: string,
  segmentIndex: number,
  options: { final: boolean; note?: string } = { final: true },
): string {
  const note = options.note ?? "";
  const indicator = options.final ? "" : String(config.typingIndicator);
  return `${segmentPrefix(config, segmentIndex)}${content}${note}${String(config.suffix)}${indicator}`;
}

function segmentCapacity(
  config: JsonObject,
  segmentIndex: number,
  note = "",
): number {
  const overhead =
    segmentPrefix(config, segmentIndex).length +
    String(config.suffix).length +
    note.length;
  return Math.max(1, Number(config.maxMessageChars) - overhead);
}

function warnOnce(mutable: MutableState, warning: string): void {
  if (!mutable.warnings.includes(warning)) {
    mutable.warnings.push(warning);
  }
}

function splitPoint(content: string, capacity: number): number {
  if (content.length <= capacity) {
    return content.length;
  }
  const window = content.slice(0, capacity);
  let best = -1;
  for (let index = window.length - 1; index >= 0; index -= 1) {
    const char = window[index]!;
    if (char === " " || char === "\n" || char === "\t") {
      best = index;
      break;
    }
  }
  return best > 0 ? best : capacity;
}

function handleOverflow(
  mutable: MutableState,
  actions: StreamSchedulerAction[],
): void {
  const { state, config } = mutable;
  if (state.truncated === true) {
    return;
  }
  const overflow = String(config.overflow);
  let content = String(state.content);
  let segmentIndex = Number(state.segmentIndex);

  while (
    renderSegment(config, content, segmentIndex).length >
    Number(config.maxMessageChars)
  ) {
    if (overflow === "truncate") {
      state.truncated = true;
      warnOnce(mutable, "truncated_at_message_size_limit");
      break;
    }
    const capacity = segmentCapacity(config, segmentIndex);
    const cut = splitPoint(content, capacity);
    const head = content.slice(0, cut);
    let rest = content.slice(cut);
    if (rest.startsWith(" ") || rest.startsWith("\n") || rest.startsWith("\t")) {
      rest = rest.slice(1);
    }
    actions.push({
      action: "finalize",
      segmentIndex,
      text: renderSegment(config, head, segmentIndex, { final: true }),
      updateMask: "text",
      final: true,
      truncated: false,
    });
    segmentIndex += 1;
    actions.push({
      action: "start_continuation",
      segmentIndex,
      text: `${segmentPrefix(config, segmentIndex)}${DEFAULT_CONTINUATION_PLACEHOLDER}`,
      updateMask: "text",
      final: false,
    });
    warnOnce(mutable, "split_into_continuation_messages");
    content = rest;
    state.segmentIndex = segmentIndex;
    state.content = content;
    state.pendingChars = content.length;
    state.patchesUsed = 0;
    state.lastPatchAtMs = null;
  }
}

function maybePatch(
  mutable: MutableState,
  actions: StreamSchedulerAction[],
  atMs: number,
  force: boolean,
): void {
  const { state, config } = mutable;
  if (
    state.truncated === true ||
    state.degradedToFinalOnly === true ||
    state.finished === true ||
    state.cancelled === true
  ) {
    return;
  }
  const pending = Number(state.pendingChars);
  if (pending <= 0) {
    return;
  }
  if (Number(state.patchesUsed) >= Number(config.maxPatches) - 1) {
    warnOnce(mutable, "patch_budget_reserved_for_final_text");
    return;
  }
  if (!force && pending < Number(config.minPatchChars)) {
    return;
  }
  const lastPatchAtMs = state.lastPatchAtMs;
  if (
    lastPatchAtMs !== null &&
    atMs - Number(lastPatchAtMs) < Number(config.minIntervalMs)
  ) {
    return;
  }
  actions.push({
    action: "patch",
    segmentIndex: Number(state.segmentIndex),
    text: renderSegment(config, String(state.content), Number(state.segmentIndex), {
      final: false,
    }),
    updateMask: "text",
    final: false,
  });
  state.patchesUsed = Number(state.patchesUsed) + 1;
  state.lastPatchAtMs = atMs;
  state.pendingChars = 0;
}

function finalize(
  mutable: MutableState,
  actions: StreamSchedulerAction[],
  options: { note?: string; cancelled?: boolean; errored?: boolean } = {},
): void {
  const { state, config } = mutable;
  const note = options.note ?? "";
  let content = String(state.content);
  let truncated = state.truncated === true;

  const capacity = segmentCapacity(
    config,
    Number(state.segmentIndex),
    truncated ? String(config.truncationNote) : note,
  );
  if (content.length > capacity) {
    if (String(config.overflow) === "truncate" || truncated) {
      truncated = true;
      content = content.slice(
        0,
        segmentCapacity(config, Number(state.segmentIndex), String(config.truncationNote)),
      );
    }
  }

  let renderedNote = note;
  if (truncated) {
    renderedNote = `${String(config.truncationNote)}${note}`;
    state.truncated = true;
    warnOnce(mutable, "truncated_at_message_size_limit");
  }
  let text = renderSegment(config, content, Number(state.segmentIndex), {
    final: true,
    note: renderedNote,
  });
  if (text.length === 0) {
    text = String(config.emptyFinalText);
  }
  actions.push({
    action: "finalize",
    segmentIndex: Number(state.segmentIndex),
    text,
    updateMask: "text",
    final: true,
    truncated,
    ...(options.cancelled ? { cancelled: true } : {}),
    ...(options.errored ? { errored: true } : {}),
  });
  state.finished = true;
  if (options.cancelled) {
    state.cancelled = true;
  }
  if (options.errored) {
    state.errored = true;
  }
}

export function advanceStreamScheduler(
  state: unknown,
  event: StreamSchedulerEvent,
): StreamSchedulerAdvanceResult {
  const mutable = cloneState(state);
  const actions: StreamSchedulerAction[] = [];
  const record = asRecord(event);
  const type = asString(record?.type);
  if (!record || !type) {
    throw new TypeError("Expected event.type to be a non-empty string.");
  }
  const atMs = nonNegativeNumber(record.atMs, 0);

  switch (type) {
    case "chunk": {
      if (mutable.state.finished === true || mutable.state.cancelled === true) {
        warnOnce(mutable, "chunk_received_after_finish");
        break;
      }
      const text = asString(record.text) ?? "";
      if (text.length === 0) {
        break;
      }
      mutable.state.content = `${String(mutable.state.content)}${text}`;
      mutable.state.pendingChars = Number(mutable.state.pendingChars) + text.length;
      mutable.state.totalChunks = Number(mutable.state.totalChunks) + 1;
      handleOverflow(mutable, actions);
      maybePatch(mutable, actions, atMs, false);
      break;
    }
    case "flush": {
      if (mutable.state.finished !== true && mutable.state.cancelled !== true) {
        maybePatch(mutable, actions, atMs, true);
      }
      break;
    }
    case "finish": {
      if (mutable.state.finished === true) {
        warnOnce(mutable, "finish_received_after_finish");
        break;
      }
      const finalText = asString(record.finalText);
      if (finalText !== null) {
        mutable.state.content = finalText;
        mutable.state.pendingChars = finalText.length;
        mutable.state.truncated = false;
      }
      handleOverflow(mutable, actions);
      finalize(mutable, actions);
      break;
    }
    case "cancel": {
      if (mutable.state.finished === true) {
        warnOnce(mutable, "cancel_received_after_finish");
        break;
      }
      finalize(mutable, actions, {
        note: String(mutable.config.cancelNote),
        cancelled: true,
      });
      break;
    }
    case "error": {
      if (mutable.state.finished === true) {
        warnOnce(mutable, "error_received_after_finish");
        break;
      }
      finalize(mutable, actions, {
        note: String(mutable.config.errorNote),
        errored: true,
      });
      break;
    }
    case "patch_result": {
      if (record.ok === true) {
        mutable.state.consecutivePatchFailures = 0;
      } else {
        const failures = Number(mutable.state.consecutivePatchFailures) + 1;
        mutable.state.consecutivePatchFailures = failures;
        if (
          failures >= Number(mutable.config.maxConsecutivePatchFailures) &&
          mutable.state.degradedToFinalOnly !== true
        ) {
          mutable.state.degradedToFinalOnly = true;
          warnOnce(mutable, "degraded_to_final_only_after_patch_failures");
        }
      }
      break;
    }
    default:
      throw new TypeError(`Unsupported stream scheduler event type: ${type}.`);
  }

  return { state: mutable.state, actions };
}

export interface ReplayStreamSchedulerInput {
  config?: StreamSchedulerConfig;
  events: StreamSchedulerEvent[];
}

export function replayStreamScheduler(
  input: ReplayStreamSchedulerInput,
): JsonObject {
  const record = asRecord(input) ?? {};
  const events = asArray(record.events) as StreamSchedulerEvent[];
  let state = createStreamSchedulerState(
    (asRecord(record.config) ?? {}) as StreamSchedulerConfig,
  );
  const actions: Array<JsonObject> = [];
  for (const [index, event] of events.entries()) {
    const advanced = advanceStreamScheduler(state, event);
    state = advanced.state;
    for (const action of advanced.actions) {
      actions.push({ eventIndex: index, ...action });
    }
  }
  return {
    kind: REPLAY_KIND,
    actions,
    state,
  };
}

export interface StreamCancellationRegistry {
  cancel(streamId: string, reason?: string): Promise<void> | void;
  isCancelled(streamId: string): Promise<boolean> | boolean;
  reason(streamId: string): Promise<string | null> | (string | null);
  clear(streamId: string): Promise<void> | void;
}

export class InMemoryStreamCancellationRegistry
  implements StreamCancellationRegistry
{
  readonly #entries = new Map<string, string>();

  cancel(streamId: string, reason = "cancelled"): void {
    this.#entries.set(streamId, reason);
  }

  isCancelled(streamId: string): boolean {
    return this.#entries.has(streamId);
  }

  reason(streamId: string): string | null {
    return this.#entries.get(streamId) ?? null;
  }

  clear(streamId: string): void {
    this.#entries.delete(streamId);
  }
}

interface SerializedCancellationFile {
  version: 1;
  cancelled: Record<string, string>;
}

export class FileStreamCancellationRegistry
  implements StreamCancellationRegistry
{
  readonly #filePath: string;

  constructor(options: { filePath: string }) {
    const filePath = asString((options as JsonObject)?.filePath);
    if (!filePath) {
      throw new TypeError("Expected filePath to be a non-empty string.");
    }
    this.#filePath = filePath;
  }

  async #read(): Promise<SerializedCancellationFile> {
    try {
      const raw = await fs.readFile(this.#filePath, "utf8");
      const parsed = asRecord(JSON.parse(raw));
      const cancelled = asRecord(parsed?.cancelled) ?? {};
      const entries: Record<string, string> = {};
      for (const [key, value] of Object.entries(cancelled)) {
        if (typeof value === "string") {
          entries[key] = value;
        }
      }
      return { version: 1, cancelled: entries };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, cancelled: {} };
      }
      throw error;
    }
  }

  async #write(data: SerializedCancellationFile): Promise<void> {
    await writeFileAtomically(
      this.#filePath,
      `${JSON.stringify(data, null, 2)}\n`,
    );
  }

  async cancel(streamId: string, reason = "cancelled"): Promise<void> {
    await withFileStateLock(this.#filePath, async () => {
      const data = await this.#read();
      data.cancelled[streamId] = reason;
      await this.#write(data);
    });
  }

  async isCancelled(streamId: string): Promise<boolean> {
    const data = await this.#read();
    return Object.hasOwn(data.cancelled, streamId);
  }

  async reason(streamId: string): Promise<string | null> {
    const data = await this.#read();
    return data.cancelled[streamId] ?? null;
  }

  async clear(streamId: string): Promise<void> {
    await withFileStateLock(this.#filePath, async () => {
      const data = await this.#read();
      if (Object.hasOwn(data.cancelled, streamId)) {
        delete data.cancelled[streamId];
        await this.#write(data);
      }
    });
  }
}

export interface ChatStreamApplyRequest {
  kind: "patch" | "create";
  method: "PATCH" | "POST";
  path: string;
  query: JsonObject;
  body: JsonObject;
  segmentIndex: number;
  final: boolean;
}

export interface ChatStreamApplyResult {
  ok: boolean;
  status: number;
  json: unknown;
  error?: { name: string; message: string } | null;
}

export type ChatStreamApplier = (
  request: ChatStreamApplyRequest,
) => Promise<ChatStreamApplyResult>;

export interface CreateChatRequestApplierOptions {
  auth: {
    getAccessToken(
      input: GetAccessTokenInput,
    ): Promise<AccessTokenLease> | AccessTokenLease;
  };
  authMode?: string;
  fetch?: RequestJsonWithRetryOptions["fetch"];
  sleepMs?: (delayMs: number) => Promise<void>;
  retryPolicy?: RetryPolicyOptions;
  baseUrl?: string;
}

export function createChatRequestApplier(
  options: CreateChatRequestApplierOptions,
): ChatStreamApplier {
  if (typeof options?.auth?.getAccessToken !== "function") {
    throw new TypeError("Expected auth.getAccessToken to be a function.");
  }
  const client = createRetryingChatClient({
    principal: options.authMode ?? "app",
    getAccessToken: (input) => Promise.resolve(options.auth.getAccessToken(input)),
    baseUrl: options.baseUrl ?? "https://chat.googleapis.com",
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleepMs ? { sleepMs: options.sleepMs } : {}),
    ...(options.retryPolicy ? { retryPolicy: options.retryPolicy } : {}),
  });
  return async (request) => {
    const result = await client.request({
      resourcePath: request.path,
      method: request.method,
      query: request.query as Record<string, string>,
      body: request.body,
      idempotent: request.method === "PATCH",
    });
    return {
      ok: result.ok,
      status: result.status,
      json: result.json,
      error: result.error,
    };
  };
}

export interface ChatStreamTarget {
  messageName: string;
  space?: string | null;
  threadName?: string | null;
  threadKey?: string | null;
}

export interface StreamChatReplyOptions extends StreamSchedulerConfig {
  apply: ChatStreamApplier;
  clock?: () => number;
  signal?: AbortSignal;
  shouldCancel?: () => boolean | Promise<boolean>;
  cancelReason?: string;
  finalCards?: unknown[];
  resumeState?: JsonObject;
  onAction?: (action: StreamSchedulerAction) => void;
  onState?: (state: JsonObject) => void;
}

export interface ChatStreamReport {
  kind: typeof REPORT_KIND;
  ok: boolean;
  messageName: string;
  finalText: string | null;
  patches: number;
  continuations: string[];
  truncated: boolean;
  cancelled: boolean;
  errored: boolean;
  degradedToFinalOnly: boolean;
  failure: { name: string; message: string } | null;
  warnings: string[];
  state: JsonObject;
}

function normalizeStreamTarget(target: unknown): ChatStreamTarget {
  const record = asRecord(target);
  if (!record) {
    throw new TypeError("Expected a stream target object.");
  }
  if (record.kind === PLACEHOLDER_HANDLE_KIND) {
    const messageName = asString(record.messageName);
    if (!messageName || record.editable !== true) {
      throw new TypeError(
        "Expected an editable placeholder response handle with messageName. Hydrate the handle with hydratePlaceholderResponseHandle first.",
      );
    }
    return {
      messageName,
      space: asString(record.space),
      threadName: asString(record.threadName),
      threadKey: asString(record.threadKey),
    };
  }
  const messageName = asString(record.messageName);
  if (!messageName) {
    throw new TypeError("Expected target.messageName to be a non-empty string.");
  }
  return {
    messageName,
    space: asString(record.space),
    threadName: asString(record.threadName),
    threadKey: asString(record.threadKey),
  };
}

function chunkText(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  const record = asRecord(chunk);
  const text = asString(record?.text) ?? asString(record?.delta);
  return text ?? "";
}

export async function streamChatReply(
  target: unknown,
  stream:
    | AsyncIterable<unknown>
    | Iterable<unknown>,
  options: StreamChatReplyOptions,
): Promise<ChatStreamReport> {
  if (typeof options?.apply !== "function") {
    throw new TypeError(
      "Expected options.apply to be a function. Build one with createChatRequestApplier.",
    );
  }
  const normalizedTarget = normalizeStreamTarget(target);
  const clock = options.clock ?? (() => Date.now());
  const config: StreamSchedulerConfig = { ...options };
  if (!normalizedTarget.space && config.overflow === "split") {
    config.overflow = "truncate";
  }
  let state = options.resumeState
    ? cloneState(options.resumeState).state
    : createStreamSchedulerState(config);

  const continuations: string[] = [];
  let currentMessageName = normalizedTarget.messageName;
  let patches = 0;
  let finalText: string | null = null;
  let failure: { name: string; message: string } | null = null;
  let sawFinalize = false;

  const emitState = () => {
    options.onState?.(state);
  };

  async function applyAction(action: StreamSchedulerAction): Promise<boolean> {
    options.onAction?.(action);
    if (action.action === "start_continuation") {
      const space = normalizedTarget.space;
      if (!space) {
        failure = {
          name: "StreamContinuationError",
          message: "Cannot start a continuation message without target.space.",
        };
        return false;
      }
      const body: JsonObject = { text: action.text };
      if (normalizedTarget.threadName) {
        body.thread = { name: normalizedTarget.threadName };
      } else if (normalizedTarget.threadKey) {
        body.thread = { threadKey: normalizedTarget.threadKey };
      }
      const result = await options.apply({
        kind: "create",
        method: "POST",
        path: `/v1/${space}/messages`,
        query: body.thread
          ? { messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" }
          : {},
        body,
        segmentIndex: action.segmentIndex,
        final: false,
      });
      if (!result.ok) {
        failure = result.error ?? {
          name: "HttpError",
          message: `Continuation create failed with HTTP ${result.status}.`,
        };
        return false;
      }
      const created = asRecord(result.json);
      const name = asString(created?.name);
      if (!name) {
        failure = {
          name: "StreamContinuationError",
          message: "Continuation create response did not include a message name.",
        };
        return false;
      }
      continuations.push(name);
      currentMessageName = name;
      return true;
    }

    const attachCards =
      action.final &&
      action.action === "finalize" &&
      options.finalCards !== undefined &&
      asArray(options.finalCards).length > 0;
    const body: JsonObject = { text: action.text };
    let updateMask = action.updateMask;
    if (attachCards) {
      body.cardsV2 = options.finalCards;
      updateMask = `${updateMask},cardsV2`;
    }
    const result = await options.apply({
      kind: "patch",
      method: "PATCH",
      path: `/v1/${currentMessageName}`,
      query: { updateMask },
      body,
      segmentIndex: action.segmentIndex,
      final: action.final,
    });
    const advanced = advanceStreamScheduler(state, {
      type: "patch_result",
      ok: result.ok,
      atMs: clock(),
    });
    state = advanced.state;
    if (result.ok) {
      patches += 1;
      if (action.final) {
        finalText = action.text;
        sawFinalize = true;
      }
      return true;
    }
    if (action.final) {
      failure = result.error ?? {
        name: "HttpError",
        message: `Final patch failed with HTTP ${result.status}.`,
      };
      return false;
    }
    return true;
  }

  async function advanceAndApply(event: StreamSchedulerEvent): Promise<boolean> {
    const advanced = advanceStreamScheduler(state, event);
    state = advanced.state;
    for (const action of advanced.actions) {
      const okAction = await applyAction(action);
      if (!okAction) {
        return false;
      }
    }
    emitState();
    return true;
  }

  async function isCancelled(): Promise<boolean> {
    if (options.signal?.aborted) {
      return true;
    }
    if (options.shouldCancel) {
      return Boolean(await options.shouldCancel());
    }
    return false;
  }

  let aborted = false;
  try {
    for await (const chunk of stream as AsyncIterable<unknown>) {
      if (await isCancelled()) {
        aborted = true;
        break;
      }
      const text = chunkText(chunk);
      if (!text) {
        continue;
      }
      const okChunk = await advanceAndApply({
        type: "chunk",
        text,
        atMs: clock(),
      });
      if (!okChunk) {
        break;
      }
    }
  } catch (error) {
    failure = {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    };
    await advanceAndApply({ type: "error", atMs: clock() });
  }

  if (!failure) {
    if (aborted || (await isCancelled())) {
      await advanceAndApply({
        type: "cancel",
        atMs: clock(),
        ...(options.cancelReason ? { reason: options.cancelReason } : {}),
      });
    } else if (state.finished !== true) {
      await advanceAndApply({ type: "finish", atMs: clock() });
    }
  }

  const warnings = asArray(state.warnings).map((item) => String(item));
  return {
    kind: REPORT_KIND,
    ok: failure === null && sawFinalize,
    messageName: normalizedTarget.messageName,
    finalText,
    patches,
    continuations,
    truncated: state.truncated === true,
    cancelled: state.cancelled === true,
    errored: state.errored === true,
    degradedToFinalOnly: state.degradedToFinalOnly === true,
    failure,
    warnings,
    state,
  };
}
