import { randomUUID } from "node:crypto";

type JsonObject = Record<string, unknown>;

export type ChatAuthMode = "app" | "user";
export type ReplyStrategy = "mimic" | "thread" | "topLevel";
export type ReplyRouteMode = "thread" | "topLevel";
export type MissingThreadMode = "threadKey" | "topLevel" | "fail";

export interface ChatPlanRequestThrottle {
  minDelayMs: number;
  final: boolean;
  [extra: string]: unknown;
}

export interface ChatPlanRequest {
  resource: string;
  method: string;
  path: string;
  query: JsonObject;
  body: JsonObject | null;
  throttle?: ChatPlanRequestThrottle;
  [extra: string]: unknown;
}

export interface ChatPlanCapability {
  ok: boolean;
  authMode: string;
  requiredScopes: string[];
  reasons: string[];
  [extra: string]: unknown;
}

export interface ChatPlanIdempotency {
  requestId: string | null;
  clientMessageId: string | null;
  [extra: string]: unknown;
}

export interface ChatPlanSafety {
  liveAllowed: boolean;
  directMessage: boolean;
  notes: string[];
  [extra: string]: unknown;
}

export interface ChatCallPlan {
  kind: "chat.call_plan";
  operation: string;
  dryRun: true;
  capability: ChatPlanCapability;
  requests: ChatPlanRequest[];
  idempotency: ChatPlanIdempotency;
  safety: ChatPlanSafety;
  warnings: string[];
  [extra: string]: unknown;
}

export interface ReplyRoutingPolicy {
  strategy: ReplyStrategy;
  dm: ReplyRouteMode;
  roomTopLevel: ReplyRouteMode;
  roomThreadReply: ReplyRouteMode;
  missingThread: MissingThreadMode;
  messageReplyOption: string;
  [extra: string]: unknown;
}

export interface ReplyTarget {
  kind: "chat.reply_target";
  status: string;
  source: "event" | "explicit";
  policy: ReplyRoutingPolicy;
  conversation: "dm" | "space";
  route: ReplyRouteMode;
  space: string;
  threadName: string | null;
  threadKey: string | null;
  messageReplyOption: string | null;
  reason: string;
  warnings: string[];
  systemNotes: string[];
  [extra: string]: unknown;
}

export interface PlaceholderResponseHandle {
  kind: "chat.placeholder_response_handle";
  space: string;
  messageName: string | null;
  threadName: string | null;
  threadKey: string | null;
  requestId: string | null;
  clientMessageId: string | null;
  correlationId: string | null;
  authMode: string;
  createdAt: string | null;
  editable: boolean;
  allowedUpdateMasks: string[];
  [extra: string]: unknown;
}

export interface PlaceholderTextSelection {
  kind: "chat.placeholder_text_selection";
  text: string;
  mode: string;
  index: number;
  count: number;
  source: string;
  nextCursor: number | null;
  randomSeed: string | null;
  warnings: string[];
  [extra: string]: unknown;
}

export interface StreamBufferPlan {
  kind: "chat.stream_buffer_plan";
  strategy: "buffered-text";
  inputChunkCount: number;
  initialText: string;
  finalText: string;
  patchTexts: string[];
  patchCount: number;
  cadence: { minPatchChars: number; maxPatches: number; throttleMs: number };
  warnings: string[];
  [extra: string]: unknown;
}

export interface AsyncResponsePlan {
  kind: "chat.async_response_plan";
  status: "defer" | "sync";
  strategy: string;
  deadline: JsonObject;
  idempotency: JsonObject;
  placeholderPlan: ChatCallPlan | null;
  replyHandle: PlaceholderResponseHandle | null;
  queue: JsonObject | null;
  completion: JsonObject;
  systemNotes: string[];
  [extra: string]: unknown;
}

export interface ReplyRoutingInput {
  strategy?: ReplyStrategy;
  dm?: ReplyRouteMode;
  roomTopLevel?: ReplyRouteMode;
  roomThreadReply?: ReplyRouteMode;
  missingThread?: MissingThreadMode;
  messageReplyOption?: string;
  [extra: string]: unknown;
}

export interface ResolveReplyTargetInput {
  event?: unknown;
  space?: string;
  thread?: string;
  threadKey?: string;
  spaceType?: string;
  isThreadReply?: boolean;
  messageName?: string;
  replyRouting?: ReplyRoutingInput;
  replyPolicy?: ReplyRoutingInput;
  [extra: string]: unknown;
}

export interface MessageIdempotencyInput {
  requestId?: string;
  clientMessageId?: string;
  authMode?: ChatAuthMode | string;
  [extra: string]: unknown;
}

export interface SendToSpaceInput extends MessageIdempotencyInput {
  space: string;
  text: string;
}

export interface SendToUserInput extends MessageIdempotencyInput {
  email: string;
  text: string;
}

export interface FindOrSetupDmInput extends MessageIdempotencyInput {
  email: string;
}

export interface ReplyInThreadInput extends MessageIdempotencyInput {
  space: string;
  thread: string;
  text: string;
}

export interface ReplyToEventInput
  extends MessageIdempotencyInput,
    ResolveReplyTargetInput {
  text: string;
}

export interface StartThreadInput extends MessageIdempotencyInput {
  space: string;
  threadKey: string;
  text: string;
}

export interface EditMessageInput extends MessageIdempotencyInput {
  message: string;
  text?: unknown;
  cardsV2?: unknown;
  accessoryWidgets?: unknown;
  updateMask?: string;
}

export interface DeleteAppMessageInput extends MessageIdempotencyInput {
  message: string;
  appCreated?: boolean;
}

export interface StreamMessageInput extends MessageIdempotencyInput {
  space: string;
  initialText: string;
  message?: string;
  patchTexts?: string[];
  throttleMs?: number;
}

export interface BufferedStreamPatchesInput {
  chunks: string[];
  minPatchChars?: number;
  maxPatches?: number;
  throttleMs?: number;
  prefix?: string;
  suffix?: string;
  initialText?: string;
  finalText?: string;
  [extra: string]: unknown;
}

export interface BufferedStreamMessageInput
  extends BufferedStreamPatchesInput,
    MessageIdempotencyInput {
  space: string;
  message?: string;
}

export interface PlaceholderTextInput {
  placeholderText?: string;
  placeholderTexts?: string[];
  placeholderConfig?: JsonObject | string;
  placeholderConfigJson?: string;
  placeholderConfigCsv?: string;
  placeholderMode?: "first" | "roundRobin" | "random" | string;
  placeholderCursor?: number;
  placeholderRandomSeed?: string | number;
  correlationId?: string;
  [extra: string]: unknown;
}

export interface PlaceholderResponseInput
  extends MessageIdempotencyInput,
    PlaceholderTextInput,
    ResolveReplyTargetInput {
  space?: string;
}

export interface CompletePlaceholderResponseInput extends MessageIdempotencyInput {
  handle: PlaceholderResponseHandle | JsonObject;
  text?: unknown;
  cardsV2?: unknown;
  accessoryWidgets?: unknown;
  updateMask?: string;
  onPatchFailure?: "throw" | "createNewMessage";
  fallbackRequestId?: string;
  fallbackClientMessageId?: string;
}

export interface BufferedPlaceholderCompletionInput
  extends BufferedStreamPatchesInput,
    MessageIdempotencyInput {
  handle: PlaceholderResponseHandle | JsonObject;
}

export interface AsyncResponseInput
  extends MessageIdempotencyInput,
    PlaceholderTextInput,
    ResolveReplyTargetInput {
  space?: string;
  respondWithPlaceholder?: boolean;
  syncDeadlineMs?: number;
  safetyMarginMs?: number;
  elapsedMs?: number;
  receivedAt?: string;
  now?: string;
  expectedWorkMs?: number;
  eventId?: string;
  idempotencyKey?: string;
  taskId?: string;
  payloadRef?: string;
  createdMessage?: unknown;
  queue?: { adapter?: string; target?: string; [extra: string]: unknown };
  errorText?: string;
}

export interface SearchMessagesInput extends MessageIdempotencyInput {
  space: string;
  query: string;
  pageSize?: number;
  pageToken?: string;
  orderBy?: string;
}

export interface ReplaceCardsInput extends MessageIdempotencyInput {
  message: string;
  cardsV2: unknown[];
}

const APP_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const DRY_RUN_NOTE = "Dry run only; no Google Chat API call was executed.";
const DM_DRY_RUN_NOTE = "Direct messages are planned only; W9 never executes DM operations.";
const PATCH_FIELD_ORDER = ["text", "cardsV2", "accessoryWidgets"];
const DEFAULT_STREAM_THROTTLE_MS = 1000;
const DEFAULT_STREAM_MIN_PATCH_CHARS = 120;
const DEFAULT_STREAM_MAX_PATCHES = 20;
const DEFAULT_SYNC_DEADLINE_MS = 30_000;
const DEFAULT_ASYNC_SAFETY_MARGIN_MS = 5_000;
const DEFAULT_ASYNC_ERROR_TEXT =
  "Sorry, something went wrong while preparing the response.";
const DEFAULT_PLACEHOLDER_TEXTS = [
  "Thinking...",
  "Checking the thread...",
  "Reviewing context...",
];
const PLACEHOLDER_SELECTION_MODES = ["first", "roundRobin", "random"];
const PLACEHOLDER_HANDLE_KIND = "chat.placeholder_response_handle";
const PLACEHOLDER_ALLOWED_UPDATE_MASKS = ["text", "cardsV2", "accessoryWidgets"];
const DEFAULT_REPLY_MESSAGE_OPTION = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD";
const REPLY_MESSAGE_OPTIONS = [
  "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
  "REPLY_MESSAGE_OR_FAIL",
];
const REPLY_STRATEGIES = ["mimic", "thread", "topLevel"];
const REPLY_ROUTE_MODES = ["thread", "topLevel"];
const MISSING_THREAD_MODES = ["threadKey", "topLevel", "fail"];

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function positiveNumber(value: unknown, fallback: number): number {
  const number = asNumber(value);
  return number !== null && number > 0 ? number : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const number = asNumber(value);
  return number !== null && number >= 0 ? number : fallback;
}

function requiredString(input: JsonObject, key: string): string {
  const value = asString(input[key]);
  if (!value) {
    throw new TypeError(`Expected ${key} to be a non-empty string.`);
  }
  return value;
}

function authMode(input: JsonObject): string {
  return asString(input.authMode) ?? "app";
}

function capability(
  input: JsonObject,
  ok = true,
  reasons: string[] = [],
): JsonObject {
  return {
    ok,
    authMode: authMode(input),
    requiredScopes: [APP_SCOPE],
    reasons,
  };
}

function idempotency(requestId: string | null, clientMessageId: string | null): JsonObject {
  return {
    requestId,
    clientMessageId,
  };
}

function safety(directMessage: boolean): JsonObject {
  return {
    liveAllowed: false,
    directMessage,
    notes: directMessage ? [DRY_RUN_NOTE, DM_DRY_RUN_NOTE] : [DRY_RUN_NOTE],
  };
}

function callPlan(
  operation: string,
  input: JsonObject,
  requests: JsonObject[],
  options: {
    capabilityOk?: boolean;
    capabilityReasons?: string[];
    requestId?: string | null;
    clientMessageId?: string | null;
    directMessage?: boolean;
    warnings?: string[];
    extra?: JsonObject;
  } = {},
): ChatCallPlan {
  return {
    kind: "chat.call_plan",
    operation,
    dryRun: true,
    capability: capability(
      input,
      options.capabilityOk ?? true,
      options.capabilityReasons ?? [],
    ),
    requests,
    idempotency: idempotency(
      options.requestId ?? null,
      options.clientMessageId ?? null,
    ),
    ...(options.extra ?? {}),
    safety: safety(options.directMessage ?? false),
    warnings: options.warnings ?? [],
  } as ChatCallPlan;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "id";
}

export function generateRequestId(seed?: string): string {
  return `req-${slugify(seed ?? randomUUID())}`;
}

export function generateClientMessageId(seed?: string): string {
  return `client-${slugify(seed ?? randomUUID())}`;
}

function requestIdFor(input: JsonObject, seed: string): string {
  return asString(input.requestId) ?? generateRequestId(seed);
}

function clientMessageIdFor(input: JsonObject, seed: string): string {
  return asString(input.clientMessageId) ?? generateClientMessageId(seed);
}

function chatPath(resourceName: string): string {
  return `/v1/${resourceName}`;
}

function userNameForEmail(email: string): string {
  return email.startsWith("users/") ? email : `users/${email}`;
}

function createMessageRequest(
  space: string,
  query: JsonObject,
  body: JsonObject,
): JsonObject {
  return {
    resource: "spaces.messages.create",
    method: "POST",
    path: chatPath(`${space}/messages`),
    query,
    body,
  };
}

function threadBody(input: JsonObject): JsonObject | null {
  const thread = asString(input.thread);
  const threadKey = asString(input.threadKey);

  if (thread && threadKey) {
    throw new TypeError("Expected only one of thread or threadKey.");
  }
  if (thread) {
    return { name: thread };
  }
  if (threadKey) {
    return { threadKey };
  }
  return null;
}

function threadQuery(thread: JsonObject | null): JsonObject {
  return thread === null
    ? {}
    : { messageReplyOption: DEFAULT_REPLY_MESSAGE_OPTION };
}

function nestedRecord(input: JsonObject, ...keys: string[]): JsonObject | null {
  let current: unknown = input;
  for (const key of keys) {
    current = asRecord(current)?.[key];
  }
  return asRecord(current);
}

function stringAt(input: JsonObject, ...keys: string[]): string | null {
  if (keys.length === 0) {
    return null;
  }
  const parent = nestedRecord(input, ...keys.slice(0, -1));
  return asString(parent?.[keys[keys.length - 1]!]);
}

function boolAt(input: JsonObject, ...keys: string[]): boolean | null {
  if (keys.length === 0) {
    return null;
  }
  const parent = nestedRecord(input, ...keys.slice(0, -1));
  return asBoolean(parent?.[keys[keys.length - 1]!]);
}

function replyPolicy(input: JsonObject): ReplyRoutingPolicy {
  const rawPolicy = asRecord(input.replyRouting) ?? asRecord(input.replyPolicy) ?? {};
  const strategy = asString(rawPolicy.strategy) ?? "mimic";
  const dm = asString(rawPolicy.dm) ?? "topLevel";
  const roomTopLevel = asString(rawPolicy.roomTopLevel) ?? "thread";
  const roomThreadReply = asString(rawPolicy.roomThreadReply) ?? "thread";
  const missingThread = asString(rawPolicy.missingThread) ?? "threadKey";
  const messageReplyOption =
    asString(rawPolicy.messageReplyOption) ?? DEFAULT_REPLY_MESSAGE_OPTION;

  if (!REPLY_STRATEGIES.includes(strategy)) {
    throw new TypeError(`Expected replyRouting.strategy to be one of ${REPLY_STRATEGIES.join(", ")}.`);
  }
  const routePolicyFields: Array<[string, string]> = [
    ["replyRouting.dm", dm],
    ["replyRouting.roomTopLevel", roomTopLevel],
    ["replyRouting.roomThreadReply", roomThreadReply],
  ];
  for (const [field, value] of routePolicyFields) {
    if (!REPLY_ROUTE_MODES.includes(value)) {
      throw new TypeError(`Expected ${field} to be one of ${REPLY_ROUTE_MODES.join(", ")}.`);
    }
  }
  if (!MISSING_THREAD_MODES.includes(missingThread)) {
    throw new TypeError(
      `Expected replyRouting.missingThread to be one of ${MISSING_THREAD_MODES.join(", ")}.`,
    );
  }
  if (!REPLY_MESSAGE_OPTIONS.includes(messageReplyOption)) {
    throw new TypeError(
      `Expected replyRouting.messageReplyOption to be one of ${REPLY_MESSAGE_OPTIONS.join(", ")}.`,
    );
  }

  return {
    strategy,
    dm,
    roomTopLevel,
    roomThreadReply,
    missingThread,
    messageReplyOption,
  } as ReplyRoutingPolicy;
}

function eventLike(input: JsonObject): JsonObject {
  return asRecord(input.event) ?? input;
}

function eventSpace(input: JsonObject, event: JsonObject): string {
  const space =
    asString(input.space) ??
    stringAt(event, "space", "name") ??
    stringAt(event, "message", "space", "name");
  if (!space) {
    throw new TypeError("Expected space or event.space.name to be a non-empty string.");
  }
  return space;
}

function eventThread(input: JsonObject, event: JsonObject): string | null {
  return (
    asString(input.thread) ??
    stringAt(event, "message", "thread", "name") ??
    stringAt(event, "thread", "name")
  );
}

function eventMessageName(input: JsonObject, event: JsonObject): string | null {
  return (
    asString(input.messageName) ??
    stringAt(event, "message", "ref", "name") ??
    stringAt(event, "message", "name")
  );
}

function eventIsDm(input: JsonObject, event: JsonObject): boolean {
  const spaceType =
    asString(input.spaceType) ??
    stringAt(event, "space", "type") ??
    stringAt(event, "space", "spaceType") ??
    stringAt(event, "message", "space", "type");
  return (
    boolAt(event, "message", "state", "directMessage") === true ||
    asString(event.kind) === "message.direct" ||
    spaceType === "DM" ||
    spaceType === "DIRECT_MESSAGE"
  );
}

function eventIsThreadReply(input: JsonObject, event: JsonObject, thread: string | null): boolean {
  const explicit = asBoolean(input.isThreadReply);
  if (explicit !== null) {
    return explicit;
  }
  const messageStateThreadReply = boolAt(event, "message", "state", "threadReply");
  if (messageStateThreadReply !== null) {
    return messageStateThreadReply;
  }
  return (
    asString(event.kind) === "message.thread_reply" ||
    thread !== null
  );
}

function targetThreadKey(input: JsonObject, event: JsonObject): string {
  const explicit = asString(input.threadKey);
  if (explicit) {
    return explicit;
  }
  const seed = eventMessageName(input, event) ?? `${eventSpace(input, event)}-top-level`;
  return `chat-ai-sdk-reply-${slugify(seed)}`;
}

function replyTargetResult(input: JsonObject, options: {
  conversation: "dm" | "space";
  route: "thread" | "topLevel";
  space: string;
  threadName?: string | null;
  threadKey?: string | null;
  reason: string;
  warnings?: string[];
  policy: JsonObject;
}): ReplyTarget {
  const threadName = options.threadName ?? null;
  const threadKey = options.threadKey ?? null;
  const messageReplyOption =
    options.route === "thread" ? asString(options.policy.messageReplyOption) : null;
  return {
    kind: "chat.reply_target",
    status: "ready",
    source: asRecord(input.event) ? "event" : "explicit",
    policy: options.policy,
    conversation: options.conversation,
    route: options.route,
    space: options.space,
    threadName,
    threadKey,
    messageReplyOption,
    reason: options.reason,
    warnings: options.warnings ?? [],
    systemNotes: [
      options.route === "thread"
        ? "System Note: Reply routing selected a thread reply target."
        : "System Note: Reply routing selected a top-level message target.",
    ],
  } as ReplyTarget;
}

export function resolveReplyTarget(input: ResolveReplyTargetInput): ReplyTarget {
  const event = eventLike(input);
  const policy = replyPolicy(input);
  const space = eventSpace(input, event);
  const thread = eventThread(input, event);
  const isDm = eventIsDm(input, event);
  const isThreadReply = eventIsThreadReply(input, event, thread);

  if (asString(input.thread) && asString(input.threadKey)) {
    throw new TypeError("Expected only one of thread or threadKey.");
  }

  if (asString(input.thread)) {
    return replyTargetResult(input, {
      conversation: isDm ? "dm" : "space",
      route: "thread",
      space,
      threadName: asString(input.thread),
      reason: "explicit_thread",
      policy,
    });
  }

  if (asString(input.threadKey)) {
    return replyTargetResult(input, {
      conversation: isDm ? "dm" : "space",
      route: "thread",
      space,
      threadKey: asString(input.threadKey),
      reason: "explicit_thread_key",
      policy,
    });
  }

  if (policy.strategy === "topLevel") {
    return replyTargetResult(input, {
      conversation: isDm ? "dm" : "space",
      route: "topLevel",
      space,
      reason: "forced_top_level",
      policy,
    });
  }

  if (policy.strategy === "thread") {
    return thread
      ? replyTargetResult(input, {
          conversation: isDm ? "dm" : "space",
          route: "thread",
          space,
          threadName: thread,
          reason: "forced_thread",
          policy,
        })
      : replyTargetForMissingThread(input, event, policy, isDm, space, "forced_thread");
  }

  if (isDm) {
    return policy.dm === "thread"
      ? thread
        ? replyTargetResult(input, {
            conversation: "dm",
            route: "thread",
            space,
            threadName: thread,
            reason: "dm_thread",
            policy,
          })
        : replyTargetForMissingThread(input, event, policy, true, space, "dm_thread")
      : replyTargetResult(input, {
          conversation: "dm",
          route: "topLevel",
          space,
          reason: "dm_top_level",
          policy,
        });
  }

  if (isThreadReply) {
    return policy.roomThreadReply === "thread"
      ? thread
        ? replyTargetResult(input, {
            conversation: "space",
            route: "thread",
            space,
            threadName: thread,
            reason: "room_thread_reply",
            policy,
          })
        : replyTargetForMissingThread(input, event, policy, false, space, "room_thread_reply")
      : replyTargetResult(input, {
          conversation: "space",
          route: "topLevel",
          space,
          reason: "room_thread_reply_top_level",
          policy,
        });
  }

  return policy.roomTopLevel === "thread"
    ? thread
      ? replyTargetResult(input, {
          conversation: "space",
          route: "thread",
          space,
          threadName: thread,
          reason: "room_top_level_thread",
          policy,
        })
      : replyTargetForMissingThread(input, event, policy, false, space, "room_top_level")
    : replyTargetResult(input, {
        conversation: "space",
        route: "topLevel",
        space,
        reason: "room_top_level_top_level",
        policy,
      });
}

function replyTargetForMissingThread(
  input: JsonObject,
  event: JsonObject,
  policy: JsonObject,
  isDm: boolean,
  space: string,
  reasonPrefix: string,
): ReplyTarget {
  const missingThread = asString(policy.missingThread);
  if (missingThread === "fail") {
    throw new TypeError("Reply routing selected a thread target, but the event did not include a thread name.");
  }
  if (missingThread === "topLevel") {
    return replyTargetResult(input, {
      conversation: isDm ? "dm" : "space",
      route: "topLevel",
      space,
      reason: `${reasonPrefix}_missing_thread_top_level`,
      policy,
    });
  }
  return replyTargetResult(input, {
    conversation: isDm ? "dm" : "space",
    route: "thread",
    space,
    threadKey: targetThreadKey(input, event),
    reason: `${reasonPrefix}_thread_key`,
    policy,
    warnings: [
      "Event did not include a thread name; using a stable threadKey derived from the triggering message.",
    ],
  });
}

function shouldResolveReplyTarget(input: JsonObject): boolean {
  return (
    asRecord(input.replyTarget) !== null ||
    asRecord(input.event) !== null ||
    asRecord(input.replyRouting) !== null ||
    asRecord(input.replyPolicy) !== null
  );
}

function replyTargetFromInput(input: JsonObject): JsonObject | null {
  const existing = asRecord(input.replyTarget);
  if (existing) {
    return existing;
  }
  return shouldResolveReplyTarget(input)
    ? resolveReplyTarget(input as ResolveReplyTargetInput)
    : null;
}

function threadFromReplyTarget(target: JsonObject | null): JsonObject | null {
  if (target?.route !== "thread") {
    return null;
  }
  const threadName = asString(target.threadName);
  const threadKey = asString(target.threadKey);
  if (threadName) {
    return { name: threadName };
  }
  if (threadKey) {
    return { threadKey };
  }
  throw new TypeError("Reply target selected a thread route without a thread name or thread key.");
}

function replyTargetWarnings(target: JsonObject | null): string[] {
  return target ? asArray(target.warnings).map((item) => String(item)) : [];
}

function replyTargetSystemNotes(target: JsonObject | null): string[] {
  return target ? asArray(target.systemNotes).map((item) => String(item)) : [];
}

function responseBodyFromInput(input: JsonObject): JsonObject {
  const body: JsonObject = {};

  for (const field of PATCH_FIELD_ORDER) {
    if (input[field] !== undefined) {
      body[field] = input[field];
    }
  }

  if (Object.keys(body).length === 0) {
    throw new TypeError("Expected at least one final response field to update.");
  }

  return body;
}

function placeholderAuthMode(input: JsonObject, handle?: JsonObject): string {
  return (
    asString(input.authMode) ??
    (handle ? asString(handle.authMode) : null) ??
    "app"
  );
}

function placeholderHandle(input: JsonObject, options: {
  messageName?: string | null;
  createdAt?: string | null;
  editable?: boolean;
  replyTarget?: JsonObject | null;
} = {}): JsonObject {
  const targetThread = threadFromReplyTarget(options.replyTarget ?? null);
  const thread = asString(targetThread?.name) ?? asString(input.thread);
  const threadKey = asString(targetThread?.threadKey) ?? asString(input.threadKey);

  if (thread && threadKey) {
    throw new TypeError("Expected only one of thread or threadKey.");
  }

  return {
    kind: PLACEHOLDER_HANDLE_KIND,
    space: requiredString(input, "space"),
    messageName: options.messageName ?? null,
    threadName: thread ?? null,
    threadKey: threadKey ?? null,
    requestId: asString(input.requestId) ?? null,
    clientMessageId: asString(input.clientMessageId) ?? null,
    correlationId: asString(input.correlationId) ?? null,
    authMode: placeholderAuthMode(input),
    createdAt: options.createdAt ?? null,
    editable: options.editable ?? false,
    allowedUpdateMasks: [...PLACEHOLDER_ALLOWED_UPDATE_MASKS],
    ...(options.replyTarget ? { replyTarget: options.replyTarget } : {}),
  };
}

function normalizePlaceholderHandle(value: unknown): JsonObject {
  const handle = asRecord(value);
  if (!handle || handle.kind !== PLACEHOLDER_HANDLE_KIND) {
    throw new TypeError(`Expected handle.kind to equal ${PLACEHOLDER_HANDLE_KIND}.`);
  }

  const space = requiredString(handle, "space");
  const messageName = asString(handle.messageName);
  const allowedUpdateMasks = stringArray(
    handle.allowedUpdateMasks ?? PLACEHOLDER_ALLOWED_UPDATE_MASKS,
    "allowedUpdateMasks",
  );

  return {
    kind: PLACEHOLDER_HANDLE_KIND,
    space,
    messageName,
    threadName: asString(handle.threadName),
    threadKey: asString(handle.threadKey),
    requestId: asString(handle.requestId),
    clientMessageId: asString(handle.clientMessageId),
    correlationId: asString(handle.correlationId),
    authMode: asString(handle.authMode) ?? "app",
    createdAt: asString(handle.createdAt),
    editable: asBoolean(handle.editable) ?? false,
    allowedUpdateMasks:
      allowedUpdateMasks.length > 0
        ? allowedUpdateMasks
        : [...PLACEHOLDER_ALLOWED_UPDATE_MASKS],
    ...(asRecord(handle.replyTarget) ? { replyTarget: asRecord(handle.replyTarget) } : {}),
  };
}

function assertEditablePlaceholderHandle(handle: JsonObject): void {
  if (!handle.messageName || handle.editable !== true) {
    throw new TypeError(
      "Expected an editable placeholder response handle with messageName.",
    );
  }
}

function assertUpdateMaskAllowed(updateMask: string, handle: JsonObject): void {
  const allowed = new Set(stringArray(handle.allowedUpdateMasks, "allowedUpdateMasks"));
  for (const field of updateMask.split(",").filter(Boolean)) {
    if (!allowed.has(field)) {
      throw new TypeError(
        `Placeholder response handle does not allow updating ${field}.`,
      );
    }
  }
}

function patchRequest(messageName: string, body: JsonObject, updateMask: string): JsonObject {
  return {
    resource: "spaces.messages.patch",
    method: "PATCH",
    path: chatPath(messageName),
    query: { updateMask },
    body,
  };
}

function fallbackCreateRequest(
  handle: JsonObject,
  input: JsonObject,
  body: JsonObject,
): JsonObject {
  const threadName = asString(handle.threadName);
  const threadKey = asString(handle.threadKey);
  const fallbackInput: JsonObject = {
    space: handle.space,
    text: asString(body.text) ?? "placeholder fallback",
    requestId:
      asString(input.fallbackRequestId) ??
      generateRequestId(`${handle.messageName}-fallback`),
    clientMessageId:
      asString(input.fallbackClientMessageId) ??
      generateClientMessageId(`${handle.messageName}-fallback`),
  };
  const fallbackBody = { ...body };
  const query = {
    requestId: fallbackInput.requestId,
    messageId: fallbackInput.clientMessageId,
  };

  if (threadName) {
    fallbackBody.thread = { name: threadName };
    Object.assign(query, threadQuery(fallbackBody.thread as JsonObject));
  } else if (threadKey) {
    fallbackBody.thread = { threadKey };
    Object.assign(query, threadQuery(fallbackBody.thread as JsonObject));
  }

  return createMessageRequest(asString(handle.space)!, query, fallbackBody);
}

function nonEmptyStringArray(input: unknown, field: string): string[] {
  const values = stringArray(input, field)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (values.length === 0) {
    throw new TypeError(`Expected ${field} to include at least one non-empty placeholder.`);
  }

  return values;
}

function parsePlaceholderJson(raw: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(
      `Expected placeholderConfigJson to be valid JSON: ${(error as Error).message}`,
    );
  }

  if (Array.isArray(parsed)) {
    return { texts: parsed };
  }
  const record = asRecord(parsed);
  if (!record) {
    throw new TypeError(
      "Expected placeholderConfigJson to be a JSON array or object.",
    );
  }
  return record;
}

function parsePlaceholderCsv(raw: string): string[] {
  const values: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];

    if (char === "\"") {
      if (quoted && next === "\"") {
        field += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && (char === "," || char === "\n" || char === "\r")) {
      values.push(field);
      field = "";
      if (char === "\r" && next === "\n") {
        index += 1;
      }
    } else {
      field += char;
    }
  }
  values.push(field);

  return nonEmptyStringArray(values, "placeholderConfigCsv");
}

function configTexts(record: JsonObject): unknown[] {
  if (Array.isArray(record.texts)) {
    return record.texts;
  }
  if (Array.isArray(record.placeholders)) {
    return record.placeholders;
  }
  if (Array.isArray(record.items)) {
    return record.items;
  }
  return [];
}

function placeholderSource(input: JsonObject): {
  source: string;
  texts: string[];
  config: JsonObject;
} {
  const explicitText = asString(input.placeholderText);
  if (explicitText !== null) {
    return {
      source: "placeholderText",
      texts: nonEmptyStringArray([explicitText], "placeholderText"),
      config: {},
    };
  }

  if (input.placeholderTexts !== undefined) {
    return {
      source: "placeholderTexts",
      texts: nonEmptyStringArray(input.placeholderTexts, "placeholderTexts"),
      config: {},
    };
  }

  const configJson = asString(input.placeholderConfigJson);
  if (configJson !== null) {
    const config = parsePlaceholderJson(configJson);
    return {
      source: "placeholderConfigJson",
      texts: nonEmptyStringArray(configTexts(config), "placeholderConfigJson.texts"),
      config,
    };
  }

  const configCsv = asString(input.placeholderConfigCsv);
  if (configCsv !== null) {
    return {
      source: "placeholderConfigCsv",
      texts: parsePlaceholderCsv(configCsv),
      config: {},
    };
  }

  const rawConfig = input.placeholderConfig;
  const config =
    asRecord(rawConfig) ??
    (typeof rawConfig === "string" ? parsePlaceholderJson(rawConfig) : null);
  if (config) {
    return {
      source: "placeholderConfig",
      texts: nonEmptyStringArray(configTexts(config), "placeholderConfig.texts"),
      config,
    };
  }

  return {
    source: "default",
    texts: [...DEFAULT_PLACEHOLDER_TEXTS],
    config: {},
  };
}

function finiteInteger(value: unknown, fallback: number): number {
  const number = asNumber(value);
  return number === null ? fallback : Math.max(0, Math.floor(number));
}

function seedString(value: unknown): string | null {
  const string = asString(value);
  if (string !== null) {
    return string;
  }
  const number = asNumber(value);
  return number === null ? null : String(number);
}

function seededIndex(seed: string, count: number): number {
  let total = 0;
  for (let index = 0; index < seed.length; index += 1) {
    total += seed.charCodeAt(index) * (index + 1);
  }
  return total % count;
}

export function selectPlaceholderText(input: PlaceholderTextInput): PlaceholderTextSelection {
  const { source, texts, config } = placeholderSource(input);
  const mode = asString(input.placeholderMode) ?? asString(config.mode) ?? "first";
  if (!PLACEHOLDER_SELECTION_MODES.includes(mode)) {
    throw new TypeError(
      `Expected placeholderMode to be one of ${PLACEHOLDER_SELECTION_MODES.join(", ")}.`,
    );
  }

  let index = 0;
  let nextCursor: number | null = null;
  let randomSeed: string | null = null;

  if (mode === "roundRobin") {
    const cursor = finiteInteger(input.placeholderCursor ?? config.cursor, 0);
    index = cursor % texts.length;
    nextCursor = cursor + 1;
  } else if (mode === "random") {
    randomSeed =
      seedString(input.placeholderRandomSeed) ??
      seedString(config.randomSeed) ??
      seedString(input.correlationId) ??
      null;
    index =
      randomSeed === null
        ? Math.floor(Math.random() * texts.length)
        : seededIndex(randomSeed, texts.length);
  }

  return {
    kind: "chat.placeholder_text_selection",
    text: texts[index],
    mode,
    index,
    count: texts.length,
    source,
    nextCursor,
    randomSeed,
    warnings: [],
  } as PlaceholderTextSelection;
}

export function planPlaceholderResponse(input: PlaceholderResponseInput): ChatCallPlan {
  const replyTarget = replyTargetFromInput(input);
  const space = replyTarget
    ? requiredString(replyTarget, "space")
    : requiredString(input, "space");
  const textSelection = selectPlaceholderText(input);
  const placeholderText = requiredString(textSelection, "text");
  const requestId = requestIdFor(input, `${space}-${placeholderText}`);
  const clientMessageId = clientMessageIdFor(input, `${space}-${placeholderText}`);
  const thread = replyTarget
    ? threadFromReplyTarget(replyTarget)
    : threadBody(input);
  const body: JsonObject = {
    text: placeholderText,
  };
  if (thread) {
    body.thread = thread;
  }

  const planInput = {
    ...input,
    space,
    requestId,
    clientMessageId,
    authMode: placeholderAuthMode(input),
  };

  return callPlan(
    "messages.placeholder.create",
    planInput,
    [
      createMessageRequest(
        space,
        { requestId, messageId: clientMessageId, ...threadQuery(thread) },
        body,
      ),
    ],
    {
      requestId,
      clientMessageId,
      directMessage: replyTarget?.conversation === "dm",
      warnings: replyTargetWarnings(replyTarget),
      extra: {
        placeholder: {
          strategy: "create-then-edit",
          state: "pending",
          systemNotes: [
            "System Note: A placeholder response will be posted immediately and later edited with the final answer.",
            ...replyTargetSystemNotes(replyTarget),
          ],
          textSelection,
          ...(replyTarget ? { replyTarget } : {}),
          handle: placeholderHandle(planInput, { replyTarget }),
        },
      },
    },
  );
}

export function hydratePlaceholderResponseHandle(
  handleSeed: unknown,
  createdMessage: unknown,
): PlaceholderResponseHandle {
  const seed = normalizePlaceholderHandle(handleSeed);
  const message = asRecord(createdMessage);
  if (!message) {
    throw new TypeError("Expected createdMessage to be an object.");
  }
  const thread = asRecord(message.thread);
  const messageName = asString(message.name);

  if (!messageName) {
    throw new TypeError("Expected createdMessage.name to be a non-empty string.");
  }

  return {
    ...seed,
    messageName,
    threadName: asString(thread?.name) ?? asString(seed.threadName),
    createdAt: asString(message.createTime) ?? asString(seed.createdAt),
    editable: true,
  } as PlaceholderResponseHandle;
}

export function planCompletePlaceholderResponse(input: CompletePlaceholderResponseInput): ChatCallPlan {
  const handle = normalizePlaceholderHandle(input.handle);
  assertEditablePlaceholderHandle(handle);
  const body = responseBodyFromInput(input);
  const updateMask = asString(input.updateMask) ?? buildUpdateMask(body);
  assertUpdateMaskAllowed(updateMask, handle);
  const onPatchFailure = asString(input.onPatchFailure) ?? "throw";
  if (!["throw", "createNewMessage"].includes(onPatchFailure)) {
    throw new TypeError(
      "Expected onPatchFailure to be either throw or createNewMessage.",
    );
  }
  const fallback =
    onPatchFailure === "createNewMessage"
      ? {
          onPatchFailure,
          request: fallbackCreateRequest(handle, input, body),
        }
      : {
          onPatchFailure,
          request: null,
        };

  const planInput = {
    ...input,
    authMode: placeholderAuthMode(input, handle),
  };

  return callPlan(
    "messages.placeholder.complete",
    planInput,
    [patchRequest(asString(handle.messageName)!, body, updateMask)],
    {
      requestId: asString(handle.requestId),
      clientMessageId: asString(handle.clientMessageId),
      extra: {
        placeholder: {
          strategy: "edit-placeholder",
          state: "complete",
          updateMask,
          handle,
          fallback,
          systemNotes: [
            "System Note: The final response should edit the placeholder message instead of creating a second Chat message.",
          ],
        },
      },
    },
  );
}

export function planBufferedPlaceholderCompletion(input: BufferedPlaceholderCompletionInput): ChatCallPlan {
  const handle = normalizePlaceholderHandle(input.handle);
  assertEditablePlaceholderHandle(handle);
  const buffering = buildBufferedStreamPatches(input);
  const throttleMs =
    (asRecord(buffering.cadence)?.throttleMs as number | undefined) ??
    DEFAULT_STREAM_THROTTLE_MS;
  const patchTexts = stringArray(buffering.patchTexts, "patchTexts");
  const requests = patchTexts.map((text, index) => {
    const final = index === patchTexts.length - 1;
    return {
      ...patchRequest(asString(handle.messageName)!, { text }, "text"),
      throttle: {
        minDelayMs: final ? 0 : throttleMs,
        final,
      },
    };
  });

  const planInput = {
    ...input,
    authMode: placeholderAuthMode(input, handle),
  };

  return callPlan(
    "messages.placeholder.bufferedComplete",
    planInput,
    requests,
    {
      requestId: asString(handle.requestId),
      clientMessageId: asString(handle.clientMessageId),
      extra: {
        streaming: {
          strategy: "edit-placeholder-buffered",
          patchCount: patchTexts.length,
          throttleMs,
          buffering,
        },
        placeholder: {
          strategy: "edit-placeholder",
          state: "complete",
          updateMask: "text",
          handle,
          fallback: {
            onPatchFailure: "throw",
            request: null,
          },
          systemNotes: [
            "System Note: Buffered output should edit the placeholder message instead of creating additional Chat messages.",
          ],
        },
      },
    },
  );
}

function isoMs(value: unknown): number | null {
  const string = asString(value);
  if (!string) {
    return null;
  }
  const parsed = Date.parse(string);
  return Number.isFinite(parsed) ? parsed : null;
}

function elapsedMs(input: JsonObject): number {
  const explicit = asNumber(input.elapsedMs);
  if (explicit !== null && explicit >= 0) {
    return Math.floor(explicit);
  }
  const receivedAtMs = isoMs(input.receivedAt);
  const nowMs = isoMs(input.now);
  if (receivedAtMs !== null && nowMs !== null) {
    return Math.max(0, nowMs - receivedAtMs);
  }
  return 0;
}

function nowIso(input: JsonObject): string {
  return asString(input.now) ?? new Date().toISOString();
}

function asyncId(input: JsonObject): string {
  return (
    asString(input.eventId) ??
    asString(input.correlationId) ??
    asString(input.requestId) ??
    randomUUID()
  );
}

function placeholderInput(input: JsonObject, replyTarget: JsonObject | null): JsonObject {
  const targetThread = threadFromReplyTarget(replyTarget);
  const result: JsonObject = {
    space: replyTarget
      ? requiredString(replyTarget, "space")
      : requiredString(input, "space"),
    authMode: placeholderAuthMode(input),
  };
  if (replyTarget) {
    result.replyTarget = replyTarget;
  }
  if (targetThread?.name) {
    result.thread = targetThread.name;
  } else if (targetThread?.threadKey) {
    result.threadKey = targetThread.threadKey;
  }
  for (const field of [
    "requestId",
    "clientMessageId",
    "correlationId",
    "placeholderText",
    "placeholderTexts",
    "placeholderConfig",
    "placeholderConfigJson",
    "placeholderConfigCsv",
    "placeholderMode",
    "placeholderCursor",
    "placeholderRandomSeed",
  ]) {
    if (input[field] !== undefined) {
      result[field] = input[field];
    }
  }
  if (!replyTarget) {
    for (const field of ["thread", "threadKey"]) {
      if (input[field] !== undefined) {
        result[field] = input[field];
      }
    }
  }
  return result;
}

function asyncDeadline(input: JsonObject, respondWithPlaceholder: boolean): JsonObject {
  const syncDeadlineMs = positiveNumber(
    input.syncDeadlineMs,
    DEFAULT_SYNC_DEADLINE_MS,
  );
  const safetyMarginMs = nonNegativeNumber(
    input.safetyMarginMs,
    DEFAULT_ASYNC_SAFETY_MARGIN_MS,
  );
  const elapsed = elapsedMs(input);
  const remainingMs = Math.max(0, syncDeadlineMs - elapsed);
  const workBudgetMs = Math.max(0, remainingMs - safetyMarginMs);
  const expectedWorkMs = nonNegativeNumber(input.expectedWorkMs, 0);
  const exceedsSyncBudget = expectedWorkMs > workBudgetMs;
  const shouldDefer = respondWithPlaceholder || exceedsSyncBudget;
  const reason = shouldDefer
    ? exceedsSyncBudget
      ? "expected_work_exceeds_sync_budget"
      : "placeholder_requested"
    : "within_sync_budget";

  return {
    syncDeadlineMs,
    safetyMarginMs,
    elapsedMs: elapsed,
    remainingMs,
    workBudgetMs,
    expectedWorkMs,
    shouldDefer,
    reason,
  };
}

function productionAdapters(): JsonObject[] {
  return [
    { adapter: "cloudTasks", language: "node", status: "planned" },
    { adapter: "bullmq", language: "node", status: "planned" },
    { adapter: "pubsub", language: "node-python", status: "planned" },
    { adapter: "celery", language: "python", status: "planned" },
  ];
}

function asyncFinalDelivery(
  replyHandle: JsonObject | null,
  replyTarget: JsonObject | null = null,
): JsonObject {
  if (replyHandle) {
    return {
      strategy: "edit_placeholder",
      successOperation: "messages.placeholder.complete",
      errorOperation: "messages.placeholder.complete",
      onPatchFailure: "createNewMessage",
    };
  }
  if (replyTarget) {
    return {
      strategy: "create_reply_to_event",
      successOperation: "messages.replyToEvent",
      errorOperation: "messages.replyToEvent",
      onPatchFailure: "createNewMessage",
    };
  }
  return {
    strategy: "create_message",
    successOperation: "messages.sendToSpace",
    errorOperation: "messages.sendToSpace",
    onPatchFailure: "createNewMessage",
  };
}

function asyncSystemNotes(
  strategy: string,
  replyHandle: JsonObject | null,
  replyTarget: JsonObject | null,
): string[] {
  const routingNotes = replyTargetSystemNotes(replyTarget);
  if (strategy === "placeholder_then_queue") {
    return [
      "System Note: This interaction should respond with a placeholder immediately and enqueue final AI work.",
      replyHandle?.messageName
        ? `System Note: The queued worker should edit ${replyHandle.messageName} instead of creating a second final-answer message.`
        : "System Note: The queued worker must hydrate the placeholder reply handle before editing the final answer.",
      ...routingNotes,
    ];
  }
  if (strategy === "queue_only") {
    return [
      "System Note: This interaction should enqueue final AI work and respond asynchronously because no placeholder was requested.",
      ...routingNotes,
    ];
  }
  return [
    "System Note: This interaction is expected to finish within the synchronous response budget.",
    ...routingNotes,
  ];
}

function asyncQueueTask(input: {
  input: JsonObject;
  taskId: string;
  eventId: string | null;
  idempotencyKey: string;
  space: string;
  replyTarget: JsonObject | null;
  replyHandle: JsonObject | null;
  requiresReplyHandleHydration: boolean;
  createdAt: string;
  deadlineMs: number;
}): JsonObject {
  return {
    kind: "chat.async_response_task",
    taskId: input.taskId,
    eventId: input.eventId,
    correlationId: asString(input.input.correlationId),
    idempotencyKey: input.idempotencyKey,
    authMode: placeholderAuthMode(input.input),
    space: input.space,
    payloadRef: asString(input.input.payloadRef),
    ...(input.replyTarget ? { replyTarget: input.replyTarget } : {}),
    replyHandle: input.replyHandle,
    requiresReplyHandleHydration: input.requiresReplyHandleHydration,
    createdAt: input.createdAt,
    deadlineMs: input.deadlineMs,
    finalDelivery: asyncFinalDelivery(input.replyHandle, input.replyTarget),
  };
}

export function planAsyncResponse(input: AsyncResponseInput): AsyncResponsePlan {
  const replyTarget = replyTargetFromInput(input);
  const space = replyTarget
    ? requiredString(replyTarget, "space")
    : requiredString(input, "space");
  const respondWithPlaceholder = asBoolean(input.respondWithPlaceholder) ?? true;
  const deadline = asyncDeadline(input, respondWithPlaceholder);
  const shouldDefer = deadline.shouldDefer === true;
  const strategy = respondWithPlaceholder
    ? "placeholder_then_queue"
    : shouldDefer
      ? "queue_only"
      : "sync_response";
  const eventId = asString(input.eventId);
  const idSeed = asyncId(input);
  const idempotencyKey =
    asString(input.idempotencyKey) ??
    (eventId ? `chat-event:${eventId}` : `chat-async:${slugify(idSeed)}`);
  const placeholderPlan = respondWithPlaceholder
    ? planPlaceholderResponse(placeholderInput(input, replyTarget) as PlaceholderResponseInput)
    : null;
  const placeholder = asRecord(placeholderPlan?.placeholder);
  const handleSeed = asRecord(placeholder?.handle);
  const createdMessage = input.createdMessage;
  const replyHandle =
    handleSeed && createdMessage !== undefined
      ? hydratePlaceholderResponseHandle(handleSeed, createdMessage)
      : handleSeed ?? null;
  const requiresReplyHandleHydration =
    Boolean(handleSeed) && createdMessage === undefined;
  const queueConfig = asRecord(input.queue) ?? {};
  const adapter = asString(queueConfig.adapter) ?? "localMemory";
  const target = asString(queueConfig.target);
  const taskId = asString(input.taskId) ?? `task-${slugify(idSeed)}`;
  const queue =
    shouldDefer || respondWithPlaceholder
      ? {
          adapter,
          target,
          status: "planned",
          task: asyncQueueTask({
            input,
            taskId,
            eventId,
            idempotencyKey,
            space,
            replyTarget,
            replyHandle,
            requiresReplyHandleHydration,
            createdAt: nowIso(input),
            deadlineMs: deadline.syncDeadlineMs as number,
          }),
          productionAdapters: productionAdapters(),
        }
      : null;
  const finalDelivery = asyncFinalDelivery(replyHandle, replyTarget);

  return {
    kind: "chat.async_response_plan",
    status: shouldDefer || respondWithPlaceholder ? "defer" : "sync",
    strategy,
    deadline,
    idempotency: {
      idempotencyKey,
      duplicateStrategy: "guard_before_placeholder",
      replaySafe: true,
    },
    ...(replyTarget ? { replyTarget } : {}),
    placeholderPlan,
    replyHandle,
    queue,
    completion: {
      successOperation: finalDelivery.successOperation,
      errorOperation: finalDelivery.errorOperation,
      finalDeliveryStrategy: finalDelivery.strategy,
      errorText: asString(input.errorText) ?? DEFAULT_ASYNC_ERROR_TEXT,
    },
    systemNotes: asyncSystemNotes(strategy, replyHandle, replyTarget),
  } as AsyncResponsePlan;
}

export class InMemoryAsyncResponseQueue {
  readonly #tasks: JsonObject[] = [];

  enqueue(task: JsonObject): JsonObject {
    const taskId = requiredString(task, "taskId");
    this.#tasks.push(task);
    return {
      kind: "chat.async_queue_enqueue_result",
      status: "enqueued",
      depth: this.#tasks.length,
      taskId,
    };
  }

  dequeue(): JsonObject | null {
    return this.#tasks.shift() ?? null;
  }

  list(): JsonObject[] {
    return [...this.#tasks];
  }

  drain(limit?: number): JsonObject[] {
    const count =
      limit === undefined
        ? this.#tasks.length
        : Math.max(0, Math.floor(limit));
    return this.#tasks.splice(0, count);
  }
}

export function planSendToSpace(input: SendToSpaceInput): ChatCallPlan {
  const space = requiredString(input, "space");
  const text = requiredString(input, "text");
  const requestId = requestIdFor(input, `${space}-${text}`);
  const clientMessageId = clientMessageIdFor(input, `${space}-${text}`);

  return callPlan(
    "messages.sendToSpace",
    input,
    [
      createMessageRequest(
        space,
        { requestId, messageId: clientMessageId },
        {
          text,
        },
      ),
    ],
    { requestId, clientMessageId },
  );
}

export function planSendToUser(input: SendToUserInput): ChatCallPlan {
  const email = requiredString(input, "email");
  const text = requiredString(input, "text");
  const requestId = requestIdFor(input, `${email}-${text}`);
  const clientMessageId = clientMessageIdFor(input, `${email}-${text}`);
  const userName = userNameForEmail(email);

  return callPlan(
    "messages.sendToUser",
    input,
    [
      {
        resource: "spaces.findDirectMessage",
        method: "GET",
        path: "/v1/spaces:findDirectMessage",
        query: { name: userName },
        body: null,
      },
      {
        resource: "spaces.messages.create",
        method: "POST",
        path: "/v1/{resolvedDirectMessageSpace}/messages",
        query: { requestId, messageId: clientMessageId },
        body: {
          text,
        },
      },
    ],
    {
      capabilityOk: false,
      capabilityReasons: [
        "Direct-message live sends are disabled by W9 safety policy; this plan is dry-run only.",
      ],
      requestId,
      clientMessageId,
      directMessage: true,
      warnings: ["Direct message targets must be explicitly approved in a live smoke harness."],
    },
  );
}

export function planFindOrSetupDm(input: FindOrSetupDmInput): ChatCallPlan {
  const email = requiredString(input, "email");
  const userName = userNameForEmail(email);

  return callPlan(
    "messages.findOrSetupDm",
    input,
    [
      {
        resource: "spaces.findDirectMessage",
        method: "GET",
        path: "/v1/spaces:findDirectMessage",
        query: { name: userName },
        body: null,
      },
      {
        resource: "spaces.setup",
        method: "POST",
        path: "/v1/spaces:setup",
        query: {},
        body: {
          spaceType: "DIRECT_MESSAGE",
          memberships: [
            {
              member: {
                name: userName,
                type: "HUMAN",
              },
            },
          ],
        },
      },
    ],
    {
      capabilityOk: false,
      capabilityReasons: [
        "Direct-message setup is disabled by W9 safety policy; this plan is dry-run only.",
      ],
      directMessage: true,
      warnings: ["Direct message setup must not run against real users from W9."],
    },
  );
}

export function planReplyInThread(input: ReplyInThreadInput): ChatCallPlan {
  const space = requiredString(input, "space");
  const thread = requiredString(input, "thread");
  const text = requiredString(input, "text");
  const requestId = requestIdFor(input, `${thread}-${text}`);
  const clientMessageId = clientMessageIdFor(input, `${thread}-${text}`);

  return callPlan(
    "messages.replyInThread",
    input,
    [
      createMessageRequest(
        space,
        {
          requestId,
          messageId: clientMessageId,
          messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
        },
        {
          text,
          thread: { name: thread },
        },
      ),
    ],
    { requestId, clientMessageId },
  );
}

export function planReplyToEvent(input: ReplyToEventInput): ChatCallPlan {
  const text = requiredString(input, "text");
  const target = resolveReplyTarget(input);
  const space = requiredString(target, "space");
  const requestId = requestIdFor(input, `${space}-${text}`);
  const clientMessageId = clientMessageIdFor(input, `${space}-${text}`);
  const body: JsonObject = { text };
  const query: JsonObject = { requestId, messageId: clientMessageId };
  const threadName = asString(target.threadName);
  const threadKey = asString(target.threadKey);
  const messageReplyOption = asString(target.messageReplyOption);

  if (threadName) {
    body.thread = { name: threadName };
  } else if (threadKey) {
    body.thread = { threadKey };
  }
  if (body.thread && messageReplyOption) {
    query.messageReplyOption = messageReplyOption;
  }

  return callPlan(
    "messages.replyToEvent",
    input,
    [createMessageRequest(space, query, body)],
    {
      requestId,
      clientMessageId,
      directMessage: target.conversation === "dm",
      warnings: asArray(target.warnings).map((item) => String(item)),
      extra: { replyTarget: target },
    },
  );
}

export function planStartThread(input: StartThreadInput): ChatCallPlan {
  const space = requiredString(input, "space");
  const threadKey = requiredString(input, "threadKey");
  const text = requiredString(input, "text");
  const requestId = requestIdFor(input, `${space}-${threadKey}-${text}`);
  const clientMessageId = clientMessageIdFor(input, `${space}-${threadKey}-${text}`);

  return callPlan(
    "messages.startThread",
    input,
    [
      createMessageRequest(
        space,
        {
          requestId,
          messageId: clientMessageId,
          messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
        },
        {
          text,
          thread: { threadKey },
        },
      ),
    ],
    { requestId, clientMessageId },
  );
}

export function buildUpdateMask(fields: JsonObject): string {
  const present = new Set(
    Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key),
  );
  const ordered = PATCH_FIELD_ORDER.filter((field) => present.has(field));
  const extras = [...present].filter((field) => !PATCH_FIELD_ORDER.includes(field)).sort();
  return [...ordered, ...extras].join(",");
}

export function planEditMessage(input: EditMessageInput): ChatCallPlan {
  const message = requiredString(input, "message");
  const body: JsonObject = {};

  for (const field of PATCH_FIELD_ORDER) {
    if (input[field] !== undefined) {
      body[field] = input[field];
    }
  }

  const updateMask = asString(input.updateMask) ?? buildUpdateMask(body);

  return callPlan("messages.edit", input, [
    {
      resource: "spaces.messages.patch",
      method: "PATCH",
      path: chatPath(message),
      query: { updateMask },
      body,
    },
  ]);
}

export function planDeleteAppMessage(input: DeleteAppMessageInput): ChatCallPlan {
  const message = requiredString(input, "message");
  const appCreated = input.appCreated === true;

  return callPlan(
    "messages.deleteAppMessage",
    input,
    [
      {
        resource: "spaces.messages.delete",
        method: "DELETE",
        path: chatPath(message),
        query: {},
        body: null,
      },
    ],
    {
      capabilityOk: appCreated,
      capabilityReasons: appCreated
        ? []
        : ["Only app-created messages can be deleted by this high-level primitive."],
    },
  );
}

export function planStreamMessage(input: StreamMessageInput): ChatCallPlan {
  const space = requiredString(input, "space");
  const initialText = requiredString(input, "initialText");
  const requestId = requestIdFor(input, `${space}-${initialText}`);
  const clientMessageId = clientMessageIdFor(input, `${space}-${initialText}`);
  const message = asString(input.message) ?? `${space}/messages/${clientMessageId}`;
  const patchTexts = asArray(input.patchTexts).map((item) => {
    const text = asString(item);
    if (text === null) {
      throw new TypeError("Expected every patchTexts item to be a string.");
    }
    return text;
  });
  const throttleMs = asNumber(input.throttleMs) ?? DEFAULT_STREAM_THROTTLE_MS;
  const requests: JsonObject[] = [
    createMessageRequest(
      space,
      { requestId, messageId: clientMessageId },
      {
        text: initialText,
      },
    ),
  ];

  patchTexts.forEach((text, index) => {
    const final = index === patchTexts.length - 1;
    requests.push({
      resource: "spaces.messages.patch",
      method: "PATCH",
      path: chatPath(message),
      query: { updateMask: "text" },
      body: { text },
      throttle: {
        minDelayMs: final ? 0 : throttleMs,
        final,
      },
    });
  });

  return callPlan("messages.stream", input, requests, {
    requestId,
    clientMessageId,
    extra: {
      streaming: {
        strategy: "create-then-patch",
        throttleMs,
        patchCount: patchTexts.length,
      },
    },
  });
}

function stringArray(input: unknown, field: string): string[] {
  return asArray(input).map((item) => {
    const value = asString(item);
    if (value === null) {
      throw new TypeError(`Expected every ${field} item to be a string.`);
    }
    return value;
  });
}

export function buildBufferedStreamPatches(input: BufferedStreamPatchesInput): StreamBufferPlan {
  const chunks = stringArray(input.chunks, "chunks");
  const minPatchChars = positiveNumber(
    input.minPatchChars,
    DEFAULT_STREAM_MIN_PATCH_CHARS,
  );
  const maxPatches = Math.max(
    1,
    Math.floor(positiveNumber(input.maxPatches, DEFAULT_STREAM_MAX_PATCHES)),
  );
  const throttleMs = nonNegativeNumber(
    input.throttleMs,
    DEFAULT_STREAM_THROTTLE_MS,
  );
  const prefix = asString(input.prefix) ?? "";
  const suffix = asString(input.suffix) ?? "";
  const initialText = asString(input.initialText) ?? "Thinking...";
  const warnings: string[] = [];
  const patchTexts: string[] = [];
  let content = "";
  let lastEmitted = "";

  for (const chunk of chunks) {
    content += chunk;
    const candidate = `${prefix}${content}${suffix}`;
    const hasPatchSlotBeforeFinal = patchTexts.length < maxPatches - 1;
    if (
      hasPatchSlotBeforeFinal &&
      candidate.length - lastEmitted.length >= minPatchChars
    ) {
      patchTexts.push(candidate);
      lastEmitted = candidate;
    }
  }

  const finalText = `${prefix}${asString(input.finalText) ?? content}${suffix}`;
  if (patchTexts.at(-1) !== finalText) {
    if (patchTexts.length >= maxPatches) {
      patchTexts[patchTexts.length - 1] = finalText;
      warnings.push("max_patches_replaced_last_patch_with_final_text");
    } else {
      patchTexts.push(finalText);
    }
  }

  return {
    kind: "chat.stream_buffer_plan",
    strategy: "buffered-text",
    inputChunkCount: chunks.length,
    initialText,
    finalText,
    patchTexts,
    patchCount: patchTexts.length,
    cadence: {
      minPatchChars,
      maxPatches,
      throttleMs,
    },
    warnings,
  } as StreamBufferPlan;
}

export function planBufferedStreamMessage(input: BufferedStreamMessageInput): ChatCallPlan {
  const buffering = buildBufferedStreamPatches(input);
  const streamPlan = planStreamMessage({
    ...input,
    initialText: buffering.initialText,
    patchTexts: buffering.patchTexts,
    throttleMs: (asRecord(buffering.cadence)?.throttleMs as number | undefined) ?? undefined,
  });
  const streaming = asRecord(streamPlan.streaming) ?? {};

  return {
    ...streamPlan,
    streaming: {
      ...streaming,
      buffering,
    },
  };
}

const SEARCH_DOCS_LISTED_NOTE =
  "spaces.messages.search is a docs-listed surface; verify live support before relying on it.";
const REPLACE_CARDS_DOCS_LISTED_NOTE =
  "spaces.messages.replaceCards is a docs-listed surface; verify live support before relying on it.";

export function planSearchMessages(input: SearchMessagesInput): ChatCallPlan {
  const space = requiredString(input, "space");
  const query = requiredString(input, "query");
  const pageSizeNumber = asNumber(input.pageSize);
  const pageSize =
    pageSizeNumber === null
      ? 25
      : Math.min(1000, Math.max(1, Math.floor(pageSizeNumber)));
  const requestQuery: JsonObject = { query, pageSize };
  const pageToken = asString(input.pageToken);
  if (pageToken) {
    requestQuery.pageToken = pageToken;
  }
  const orderBy = asString(input.orderBy);
  if (orderBy) {
    requestQuery.orderBy = orderBy;
  }

  return callPlan(
    "messages.search",
    input,
    [
      {
        resource: "spaces.messages.search",
        method: "GET",
        path: chatPath(`${space}/messages:search`),
        query: requestQuery,
        body: null,
      },
    ],
    {
      warnings: [SEARCH_DOCS_LISTED_NOTE],
      extra: {
        search: {
          space,
          query,
          pageSize,
          pageToken: pageToken ?? null,
          orderBy: orderBy ?? null,
        },
      },
    },
  );
}

export function planReplaceCards(input: ReplaceCardsInput): ChatCallPlan {
  const message = requiredString(input, "message");
  const cards = asArray(input.cardsV2);
  if (cards.length === 0) {
    throw new TypeError("Expected cardsV2 to include at least one card.");
  }

  return callPlan(
    "messages.replaceCards",
    input,
    [
      {
        resource: "spaces.messages.replaceCards",
        method: "POST",
        path: chatPath(`${message}:replaceCards`),
        query: {},
        body: { cardsV2: cards },
      },
    ],
    {
      warnings: [REPLACE_CARDS_DOCS_LISTED_NOTE],
      extra: {
        replaceCards: {
          message,
          cardCount: cards.length,
        },
      },
    },
  );
}
