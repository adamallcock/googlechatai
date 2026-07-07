import {
  createRetryingChatClient,
  type AccessTokenLease,
  type GetAccessTokenInput,
  type IdempotencyStore,
  type RequestJsonWithRetryOptions,
  type RequestJsonWithRetryResult,
  type RetryPolicyOptions,
} from "../transport/index.js";

type JsonObject = Record<string, unknown>;

export const CHAT_API_BASE_URL = "https://chat.googleapis.com";

const PLACEHOLDER_PATTERN = /\{([a-zA-Z0-9_]+)\}/g;

export interface ChatPlanTokenSource {
  getAccessToken(
    input: GetAccessTokenInput,
  ): Promise<AccessTokenLease> | AccessTokenLease;
}

export interface ChatPlanAuth {
  app?: ChatPlanTokenSource;
  user?: ChatPlanTokenSource;
}

export interface PlaceholderResolverContext {
  plan: JsonObject;
  request: JsonObject;
  steps: ChatPlanExecutionStep[];
  responses: unknown[];
}

export type PlaceholderResolver = (
  context: PlaceholderResolverContext,
) => string | null;

export interface ExecuteChatPlanOptions {
  mode?: "dryRun" | "live";
  auth?: ChatPlanTokenSource | ChatPlanAuth;
  fetch?: RequestJsonWithRetryOptions["fetch"];
  sleepMs?: (delayMs: number) => Promise<void>;
  retryPolicy?: RetryPolicyOptions;
  baseUrl?: string;
  allowDirectMessages?: boolean;
  overrideCapability?: boolean;
  idempotencyStore?: IdempotencyStore;
  placeholderValues?: Record<string, string>;
  placeholderResolvers?: Record<string, PlaceholderResolver>;
  onStep?: (step: ChatPlanExecutionStep) => void;
}

export type ChatPlanStepStatus =
  | "planned"
  | "executed"
  | "skipped"
  | "failed"
  | "not_reached";

export interface ChatPlanExecutionStep {
  index: number;
  resource: string | null;
  method: string;
  path: string;
  url: string | null;
  query: JsonObject;
  status: ChatPlanStepStatus;
  httpStatus: number | null;
  attempts: number;
  throttleAppliedMs: number;
  response: unknown;
  error: { name: string; message: string } | null;
  skippedReason: string | null;
  fallback: ChatPlanExecutionStep | null;
}

export interface ChatPlanExecutionBlock {
  reason: "capability" | "direct_message_policy" | "missing_auth";
  details: string[];
}

export interface ChatPlanExecution {
  kind: "chat.plan_execution";
  operation: string | null;
  planKind: string | null;
  mode: "dryRun" | "live";
  ok: boolean;
  authMode: string;
  blocked: ChatPlanExecutionBlock | null;
  steps: ChatPlanExecutionStep[];
  resolvedPlaceholders: Record<string, string>;
  createdMessages: JsonObject[];
  warnings: string[];
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

function stringList(value: unknown): string[] {
  return asArray(value)
    .map((item) => asString(item))
    .filter((item): item is string => item !== null);
}

function findDirectMessageResolver(
  context: PlaceholderResolverContext,
): string | null {
  for (let index = context.responses.length - 1; index >= 0; index -= 1) {
    const record = asRecord(context.responses[index]);
    const name = asString(record?.name);
    if (name && name.startsWith("spaces/")) {
      return name;
    }
  }
  return null;
}

function messagePinResolver(
  context: PlaceholderResolverContext,
): string | null {
  const targetMessage = asString(asRecord(context.plan.pin)?.message);
  for (let index = context.responses.length - 1; index >= 0; index -= 1) {
    const record = asRecord(context.responses[index]);
    const pins = asArray(record?.messagePins);
    for (const rawPin of pins) {
      const pin = asRecord(rawPin);
      if (!pin) {
        continue;
      }
      const pinMessage =
        asString(pin.message) ?? asString(asRecord(pin.message)?.name);
      const pinName = asString(pin.name);
      if (pinName && (targetMessage === null || pinMessage === targetMessage)) {
        return pinName;
      }
    }
  }
  return null;
}

export const DEFAULT_PLACEHOLDER_RESOLVERS: Record<string, PlaceholderResolver> = {
  resolvedDirectMessageSpace: findDirectMessageResolver,
  resolvedMessagePin: messagePinResolver,
};

function placeholderNames(path: string): string[] {
  const names: string[] = [];
  for (const match of path.matchAll(PLACEHOLDER_PATTERN)) {
    names.push(match[1]!);
  }
  return names;
}

function buildQueryString(query: JsonObject): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) {
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

function tokenSourceForAuthMode(
  auth: ExecuteChatPlanOptions["auth"],
  authMode: string,
): ChatPlanTokenSource | null {
  if (!auth) {
    return null;
  }
  if (typeof (auth as ChatPlanTokenSource).getAccessToken === "function") {
    return auth as ChatPlanTokenSource;
  }
  const byMode = auth as ChatPlanAuth;
  const source = authMode === "user" ? byMode.user : byMode.app;
  return source && typeof source.getAccessToken === "function" ? source : null;
}

function baseStep(index: number, request: JsonObject): ChatPlanExecutionStep {
  return {
    index,
    resource: asString(request.resource),
    method: asString(request.method) ?? "GET",
    path: asString(request.path) ?? "",
    url: null,
    query: asRecord(request.query) ?? {},
    status: "not_reached",
    httpStatus: null,
    attempts: 0,
    throttleAppliedMs: 0,
    response: null,
    error: null,
    skippedReason: null,
    fallback: null,
  };
}

function isMessageCreate(step: ChatPlanExecutionStep): boolean {
  return step.resource === "spaces.messages.create";
}

function computeBlock(
  plan: JsonObject,
  options: ExecuteChatPlanOptions,
  authMode: string,
): ChatPlanExecutionBlock | null {
  const capability = asRecord(plan.capability);
  if (capability && capability.ok === false && options.overrideCapability !== true) {
    return {
      reason: "capability",
      details: stringList(capability.reasons),
    };
  }
  const safety = asRecord(plan.safety);
  if (
    safety?.directMessage === true &&
    options.allowDirectMessages !== true
  ) {
    return {
      reason: "direct_message_policy",
      details: [
        "The plan targets a direct message; pass allowDirectMessages: true to execute it.",
      ],
    };
  }
  if ((options.mode ?? "dryRun") === "live") {
    const source = tokenSourceForAuthMode(options.auth, authMode);
    if (!source) {
      return {
        reason: "missing_auth",
        details: [
          `No token source is configured for authMode ${authMode}. Provide auth.${authMode === "user" ? "user" : "app"} or a single token source.`,
        ],
      };
    }
  }
  return null;
}

export function executeChatPlan(
  plan: unknown,
  options: ExecuteChatPlanOptions = {},
): Promise<ChatPlanExecution> {
  return executePlanInternal(plan, options);
}

async function executePlanInternal(
  rawPlan: unknown,
  options: ExecuteChatPlanOptions,
): Promise<ChatPlanExecution> {
  const planOrNull = asRecord(rawPlan);
  if (!planOrNull) {
    throw new TypeError("Expected plan to be an object.");
  }
  const plan: JsonObject = planOrNull;
  const requests = asArray(plan.requests)
    .map((item) => asRecord(item))
    .filter((item): item is JsonObject => item !== null);
  if (requests.length === 0) {
    throw new TypeError(
      "Expected plan.requests to include at least one planned request. Async response plans must be executed through their placeholder and queue sub-plans.",
    );
  }

  const mode = options.mode ?? "dryRun";
  if (mode !== "dryRun" && mode !== "live") {
    throw new TypeError("Expected mode to be either dryRun or live.");
  }
  const capability = asRecord(plan.capability);
  const authMode = asString(capability?.authMode) ?? "app";
  const baseUrl = options.baseUrl ?? CHAT_API_BASE_URL;
  const warnings = stringList(plan.warnings);
  const blocked = computeBlock(plan, options, authMode);
  const resolvedPlaceholders: Record<string, string> = {
    ...(options.placeholderValues ?? {}),
  };
  const resolvers = {
    ...DEFAULT_PLACEHOLDER_RESOLVERS,
    ...(options.placeholderResolvers ?? {}),
  };
  const steps = requests.map((request, index) => baseStep(index, request));
  const responses: unknown[] = [];
  const createdMessages: JsonObject[] = [];

  const execution: ChatPlanExecution = {
    kind: "chat.plan_execution",
    operation: asString(plan.operation),
    planKind: asString(plan.kind),
    mode,
    ok: false,
    authMode,
    blocked,
    steps,
    resolvedPlaceholders,
    createdMessages,
    warnings,
  };

  function resolvePath(
    step: ChatPlanExecutionStep,
    request: JsonObject,
  ): string | null {
    let resolved = step.path;
    for (const name of placeholderNames(step.path)) {
      let value: string | null = resolvedPlaceholders[name] ?? null;
      if (value === null) {
        const resolver = resolvers[name];
        value = resolver
          ? resolver({ plan, request, steps, responses })
          : null;
        if (value !== null) {
          resolvedPlaceholders[name] = value;
        }
      }
      if (value === null) {
        return null;
      }
      resolved = resolved.split(`{${name}}`).join(value);
    }
    return resolved;
  }

  if (mode === "dryRun") {
    for (const [index, request] of requests.entries()) {
      const step = steps[index]!;
      const resolved = resolvePath(step, request);
      const path = resolved ?? step.path;
      step.url = `${baseUrl}/${path.replace(/^\//, "")}${buildQueryString(step.query)}`;
      step.status = "planned";
      if (resolved === null) {
        step.skippedReason = "unresolved_placeholder";
      }
      options.onStep?.(step);
    }
    execution.ok = blocked === null;
    return execution;
  }

  if (blocked) {
    for (const step of steps) {
      step.status = "skipped";
      step.skippedReason = `blocked_${blocked.reason}`;
    }
    return execution;
  }

  const tokenSource = tokenSourceForAuthMode(options.auth, authMode)!;
  const client = createRetryingChatClient({
    principal: authMode,
    getAccessToken: (input) => Promise.resolve(tokenSource.getAccessToken(input)),
    baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleepMs ? { sleepMs: options.sleepMs } : {}),
    ...(options.retryPolicy ? { retryPolicy: options.retryPolicy } : {}),
  });
  const sleepMs =
    options.sleepMs ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  async function performRequest(
    step: ChatPlanExecutionStep,
    request: JsonObject,
    path: string,
  ): Promise<RequestJsonWithRetryResult> {
    const method = step.method.toUpperCase();
    const query = step.query as Record<
      string,
      string | number | boolean | null | undefined
    >;
    const requestId = asString(step.query.requestId);
    const idempotent =
      method === "GET" ||
      method === "DELETE" ||
      method === "PATCH" ||
      method === "PUT" ||
      requestId !== null;
    step.url = `${baseUrl}/${path.replace(/^\//, "")}${buildQueryString(step.query)}`;
    return client.request({
      resourcePath: path,
      method,
      query,
      body: request.body ?? undefined,
      idempotent,
    });
  }

  let failed = false;
  for (const [index, request] of requests.entries()) {
    const step = steps[index]!;
    if (failed) {
      break;
    }

    const path = resolvePath(step, request);
    if (path === null) {
      step.status = "failed";
      step.error = {
        name: "UnresolvedPlaceholderError",
        message: `Could not resolve path placeholder in ${step.path}.`,
      };
      failed = true;
      options.onStep?.(step);
      break;
    }

    const requestId = asString(step.query.requestId);
    if (requestId && options.idempotencyStore) {
      const claim = await options.idempotencyStore.claim({
        key: `chat-plan-request:${requestId}`,
      });
      if (claim.duplicate) {
        step.status = "skipped";
        step.skippedReason = "duplicate_request_id";
        execution.warnings = [
          ...execution.warnings,
          `Request ${requestId} was already claimed; skipping duplicate send.`,
        ];
        options.onStep?.(step);
        continue;
      }
    }

    const throttle = asRecord(request.throttle);
    const minDelayMs = Number(throttle?.minDelayMs ?? 0);
    if (Number.isFinite(minDelayMs) && minDelayMs > 0) {
      step.throttleAppliedMs = minDelayMs;
      await sleepMs(minDelayMs);
    }

    const result = await performRequest(step, request, path);
    step.httpStatus = result.status;
    step.attempts = result.attempts;
    if (result.ok) {
      step.status = "executed";
      step.response = result.json;
      responses.push(result.json);
      const record = asRecord(result.json);
      if (record && isMessageCreate(step)) {
        createdMessages.push(record);
      }
    } else {
      step.status = "failed";
      step.error =
        result.error ?? {
          name: "HttpError",
          message: `Request failed with HTTP ${result.status}.`,
        };
      const fallback = asRecord(asRecord(plan.placeholder)?.fallback);
      const fallbackRequest = asRecord(fallback?.request);
      if (
        step.method.toUpperCase() === "PATCH" &&
        fallback?.onPatchFailure === "createNewMessage" &&
        fallbackRequest
      ) {
        const fallbackStep = baseStep(step.index, fallbackRequest);
        const fallbackPath = resolvePath(fallbackStep, fallbackRequest);
        if (fallbackPath !== null) {
          const fallbackResult = await performRequest(
            fallbackStep,
            fallbackRequest,
            fallbackPath,
          );
          fallbackStep.httpStatus = fallbackResult.status;
          fallbackStep.attempts = fallbackResult.attempts;
          if (fallbackResult.ok) {
            fallbackStep.status = "executed";
            fallbackStep.response = fallbackResult.json;
            responses.push(fallbackResult.json);
            const record = asRecord(fallbackResult.json);
            if (record && isMessageCreate(fallbackStep)) {
              createdMessages.push(record);
            }
          } else {
            fallbackStep.status = "failed";
            fallbackStep.error =
              fallbackResult.error ?? {
                name: "HttpError",
                message: `Fallback request failed with HTTP ${fallbackResult.status}.`,
              };
          }
          step.fallback = fallbackStep;
          if (fallbackResult.ok) {
            options.onStep?.(step);
            continue;
          }
        }
      }
      failed = true;
    }
    options.onStep?.(step);
  }

  execution.ok = !failed;
  return execution;
}
