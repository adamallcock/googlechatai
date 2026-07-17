import fs from "node:fs/promises";
import { withFileStateLock, writeFileAtomically } from "../internal/file-state.js";

export type RetryAction = "retry" | "refresh_auth" | "fail";

type JsonObject = Record<string, unknown>;

export interface RetryPolicyOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface RetryDecisionInput {
  attempt: number;
  method?: string | null;
  status?: number | null;
  retryAfter?: string | null;
  networkError?: boolean;
  idempotent?: boolean;
  preSendFailure?: boolean;
  principal?: string | null;
}

export interface RetryDecision {
  action: RetryAction;
  retryable: boolean;
  refreshAuth: boolean;
  replaySafe: boolean;
  reason: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  status: number | null;
  principal: string | null;
}

export interface IdempotencyClaimInput {
  key: string;
  ttlMs?: number;
  nowMs?: number;
  metadata?: JsonObject;
}

export interface IdempotencyClaim {
  key: string;
  claimed: boolean;
  duplicate: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  expiresAt: string;
  seenCount: number;
  metadata: JsonObject | null;
}

export interface IdempotencyStore {
  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaim>;
}

interface StoredIdempotencyEntry {
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  expiresAtMs: number;
  seenCount: number;
  metadata?: JsonObject;
}

interface SerializedIdempotencyEntry {
  firstSeenAt: string;
  lastSeenAt: string;
  expiresAt: string;
  seenCount: number;
  metadata?: JsonObject;
}

interface SerializedIdempotencyStore {
  version: 1;
  entries: Record<string, SerializedIdempotencyEntry>;
}

export interface InMemoryIdempotencyStoreOptions {
  maxEntries?: number;
  defaultTtlMs?: number;
}

export interface FileIdempotencyStoreOptions extends InMemoryIdempotencyStoreOptions {
  filePath: string;
}

export interface AccessTokenLease {
  accessToken: string;
  refreshed?: boolean;
  tokenType?: string;
}

export interface GetAccessTokenInput {
  forceRefresh: boolean;
}

export interface RequestJsonWithRetryInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  idempotent?: boolean;
  preSendFailure?: boolean;
  principal?: string | null;
}

export interface RequestJsonWithRetryOptions {
  getAccessToken: (input: GetAccessTokenInput) => Promise<AccessTokenLease>;
  fetch?: (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
    },
  ) => Promise<Response>;
  sleepMs?: (delayMs: number) => Promise<void>;
  retryPolicy?: RetryPolicyOptions;
}

export interface RequestJsonWithRetryResult {
  ok: boolean;
  status: number;
  json: unknown;
  headers: Record<string, string>;
  attempts: number;
  refreshed: boolean;
  replayedAfter401: boolean;
  retryDecisions: RetryDecision[];
  error: { name: string; message: string } | null;
}

export interface RetryingChatClientRequestInput {
  resourcePath?: string;
  url?: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  idempotent?: boolean;
  preSendFailure?: boolean;
}

export interface RetryingChatClientOptions
  extends Omit<RequestJsonWithRetryOptions, "getAccessToken"> {
  principal: string;
  getAccessToken: RequestJsonWithRetryOptions["getAccessToken"];
  baseUrl?: string;
  requestJsonWithRetry?: typeof requestJsonWithRetry;
}

export interface RetryingChatClient {
  request(input: RetryingChatClientRequestInput): Promise<RequestJsonWithRetryResult>;
  get(
    resourcePath: string,
    input?: Omit<
      RetryingChatClientRequestInput,
      "resourcePath" | "url" | "method" | "idempotent"
    >,
  ): Promise<RequestJsonWithRetryResult>;
  post(
    resourcePath: string,
    body?: unknown,
    input?: Omit<RetryingChatClientRequestInput, "resourcePath" | "url" | "method" | "body">,
  ): Promise<RequestJsonWithRetryResult>;
  patch(
    resourcePath: string,
    body?: unknown,
    input?: Omit<RetryingChatClientRequestInput, "resourcePath" | "url" | "method" | "body">,
  ): Promise<RequestJsonWithRetryResult>;
  delete(
    resourcePath: string,
    input?: Omit<RetryingChatClientRequestInput, "resourcePath" | "url" | "method">,
  ): Promise<RequestJsonWithRetryResult>;
}

export interface DuplicateEventGuardResult {
  duplicate: boolean;
  responseBody: Record<string, never> | null;
  claim: IdempotencyClaim;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 5_000;
const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 500;
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function clampPolicy(options: RetryPolicyOptions = {}) {
  return {
    maxAttempts: positiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS),
    baseDelayMs: nonNegativeInteger(
      options.baseDelayMs,
      DEFAULT_BASE_DELAY_MS,
    ),
    maxDelayMs: nonNegativeInteger(options.maxDelayMs, DEFAULT_MAX_DELAY_MS),
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function normalizeMethod(method: string | null | undefined): string {
  return (method ?? "GET").toUpperCase();
}

export function parseRetryAfterMs(
  retryAfter: string | null | undefined,
  now = new Date(),
): number | null {
  if (!retryAfter) {
    return null;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const dateMs = Date.parse(retryAfter);
  if (!Number.isFinite(dateMs)) {
    return null;
  }

  return Math.max(0, dateMs - now.getTime());
}

export function isReplaySafe(input: RetryDecisionInput): boolean {
  const method = normalizeMethod(input.method);

  if (input.preSendFailure === true) {
    return true;
  }
  if (IDEMPOTENT_METHODS.has(method)) {
    return true;
  }
  if (input.idempotent === true) {
    return true;
  }
  return false;
}

function backoffDelayMs(
  attempt: number,
  retryAfter: string | null | undefined,
  policy: ReturnType<typeof clampPolicy>,
): number {
  const retryAfterMs = parseRetryAfterMs(retryAfter);
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, policy.maxDelayMs);
  }
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, policy.maxDelayMs);
}

function failDecision(
  input: RetryDecisionInput,
  policy: ReturnType<typeof clampPolicy>,
  reason: string,
): RetryDecision {
  return {
    action: "fail",
    retryable: false,
    refreshAuth: false,
    replaySafe: isReplaySafe(input),
    reason,
    attempt: input.attempt,
    maxAttempts: policy.maxAttempts,
    delayMs: 0,
    status: input.status ?? null,
    principal: input.principal ?? null,
  };
}

export function buildRetryDecision(
  input: RetryDecisionInput,
  options: RetryPolicyOptions = {},
): RetryDecision {
  const policy = clampPolicy(options);
  const replaySafe = isReplaySafe(input);
  const status = input.status ?? null;
  const attemptsRemaining = input.attempt < policy.maxAttempts;

  if (!Number.isInteger(input.attempt) || input.attempt <= 0) {
    return failDecision(input, policy, "invalid_attempt");
  }
  if (!attemptsRemaining) {
    return failDecision(input, policy, "max_attempts_exhausted");
  }

  if (status === 401) {
    return {
      action: "refresh_auth",
      retryable: true,
      refreshAuth: true,
      replaySafe,
      reason: "access_token_expired_or_invalid",
      attempt: input.attempt,
      maxAttempts: policy.maxAttempts,
      delayMs: 0,
      status,
      principal: input.principal ?? null,
    };
  }

  if (input.networkError === true || RETRYABLE_STATUSES.has(status ?? 0)) {
    if (!replaySafe) {
      return failDecision(input, policy, "non_idempotent_request_not_replayed");
    }
    return {
      action: "retry",
      retryable: true,
      refreshAuth: false,
      replaySafe,
      reason: status === 429 ? "rate_limited" : "transient_failure",
      attempt: input.attempt,
      maxAttempts: policy.maxAttempts,
      delayMs: backoffDelayMs(input.attempt, input.retryAfter, policy),
      status,
      principal: input.principal ?? null,
    };
  }

  return failDecision(input, policy, "non_retryable_status");
}

function normalizeIdempotencyKey(key: unknown): string {
  if (typeof key !== "string" || key.trim() === "") {
    throw new TypeError("Idempotency key must be a non-empty string.");
  }
  return key;
}

function ttlMsOrDefault(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function claimFromStored(
  key: string,
  entry: StoredIdempotencyEntry,
  { claimed, duplicate }: { claimed: boolean; duplicate: boolean },
): IdempotencyClaim {
  return {
    key,
    claimed,
    duplicate,
    firstSeenAt: iso(entry.firstSeenAtMs),
    lastSeenAt: iso(entry.lastSeenAtMs),
    expiresAt: iso(entry.expiresAtMs),
    seenCount: entry.seenCount,
    metadata: entry.metadata ?? null,
  };
}

function deserializeEntry(entry: SerializedIdempotencyEntry): StoredIdempotencyEntry {
  return {
    firstSeenAtMs: Date.parse(entry.firstSeenAt),
    lastSeenAtMs: Date.parse(entry.lastSeenAt),
    expiresAtMs: Date.parse(entry.expiresAt),
    seenCount: positiveInteger(entry.seenCount, 1),
    metadata: entry.metadata,
  };
}

function serializeEntry(entry: StoredIdempotencyEntry): SerializedIdempotencyEntry {
  return {
    firstSeenAt: iso(entry.firstSeenAtMs),
    lastSeenAt: iso(entry.lastSeenAtMs),
    expiresAt: iso(entry.expiresAtMs),
    seenCount: entry.seenCount,
    ...(entry.metadata ? { metadata: entry.metadata } : {}),
  };
}

function purgeExpired(entries: Map<string, StoredIdempotencyEntry>, nowMs: number) {
  for (const [key, entry] of entries) {
    if (entry.expiresAtMs <= nowMs) {
      entries.delete(key);
    }
  }
}

function enforceMaxEntries(
  entries: Map<string, StoredIdempotencyEntry>,
  maxEntries: number,
) {
  while (entries.size > maxEntries) {
    const oldest = [...entries.entries()].sort(
      ([, left], [, right]) => left.expiresAtMs - right.expiresAtMs,
    )[0];
    if (!oldest) {
      return;
    }
    entries.delete(oldest[0]);
  }
}

function claimInMap(
  entries: Map<string, StoredIdempotencyEntry>,
  input: IdempotencyClaimInput,
  options: Required<InMemoryIdempotencyStoreOptions>,
): IdempotencyClaim {
  const key = normalizeIdempotencyKey(input.key);
  const ttlMs = ttlMsOrDefault(input.ttlMs, options.defaultTtlMs);
  const nowMs = nonNegativeInteger(input.nowMs, Date.now());
  purgeExpired(entries, nowMs);

  const existing = entries.get(key);
  if (existing) {
    existing.lastSeenAtMs = nowMs;
    existing.seenCount += 1;
    return claimFromStored(key, existing, {
      claimed: false,
      duplicate: true,
    });
  }

  const entry: StoredIdempotencyEntry = {
    firstSeenAtMs: nowMs,
    lastSeenAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    seenCount: 1,
    metadata: input.metadata,
  };
  entries.set(key, entry);
  enforceMaxEntries(entries, options.maxEntries);
  return claimFromStored(key, entry, { claimed: true, duplicate: false });
}

function normalizeStoreOptions(
  options: InMemoryIdempotencyStoreOptions = {},
): Required<InMemoryIdempotencyStoreOptions> {
  return {
    maxEntries: positiveInteger(
      options.maxEntries,
      DEFAULT_IDEMPOTENCY_MAX_ENTRIES,
    ),
    defaultTtlMs: ttlMsOrDefault(
      options.defaultTtlMs,
      DEFAULT_IDEMPOTENCY_TTL_MS,
    ),
  };
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #entries = new Map<string, StoredIdempotencyEntry>();
  readonly #options: Required<InMemoryIdempotencyStoreOptions>;

  constructor(options: InMemoryIdempotencyStoreOptions = {}) {
    this.#options = normalizeStoreOptions(options);
  }

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaim> {
    return claimInMap(this.#entries, input, this.#options);
  }
}

export class FileIdempotencyStore implements IdempotencyStore {
  readonly #filePath: string;
  readonly #options: Required<InMemoryIdempotencyStoreOptions>;

  constructor(options: FileIdempotencyStoreOptions) {
    if (!options.filePath) {
      throw new TypeError("FileIdempotencyStore requires filePath.");
    }
    this.#filePath = options.filePath;
    this.#options = normalizeStoreOptions(options);
  }

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaim> {
    return withFileStateLock(this.#filePath, async () => {
      const entries = await this.#readEntries();
      const claim = claimInMap(entries, input, this.#options);
      await this.#writeEntries(entries);
      return claim;
    });
  }

  async #readEntries(): Promise<Map<string, StoredIdempotencyEntry>> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.#filePath, "utf8")) as
        | SerializedIdempotencyStore
        | undefined;
      return new Map(
        Object.entries(parsed?.entries ?? {}).map(([key, entry]) => [
          key,
          deserializeEntry(entry),
        ]),
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return new Map();
      }
      throw error;
    }
  }

  async #writeEntries(entries: Map<string, StoredIdempotencyEntry>) {
    const payload: SerializedIdempotencyStore = {
      version: 1,
      entries: Object.fromEntries(
        [...entries.entries()].map(([key, entry]) => [
          key,
          serializeEntry(entry),
        ]),
      ),
    };
    await writeFileAtomically(
      this.#filePath,
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  }
}

function headerMap(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function tokenHeader(lease: AccessTokenLease): string {
  return `${lease.tokenType ?? "Bearer"} ${lease.accessToken}`;
}

function requestBody(body: unknown): string | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  return typeof body === "string" ? body : JSON.stringify(body);
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function requestJsonWithRetry(
  input: RequestJsonWithRetryInput,
  options: RequestJsonWithRetryOptions,
): Promise<RequestJsonWithRetryResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleepMs = options.sleepMs ?? defaultSleep;
  const method = normalizeMethod(input.method);
  const retryDecisions: RetryDecision[] = [];
  let lease = await options.getAccessToken({ forceRefresh: false });
  let refreshed = Boolean(lease.refreshed);
  let replayedAfter401 = false;
  let attempts = 0;

  while (true) {
    attempts += 1;
    try {
      const response = await fetchImpl(input.url, {
        method,
        headers: {
          "content-type": "application/json",
          ...(input.headers ?? {}),
          authorization: tokenHeader(lease),
        },
        body: requestBody(input.body),
      });
      const json = await parseJson(response);
      const headers = headerMap(response.headers);

      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          json,
          headers,
          attempts,
          refreshed,
          replayedAfter401,
          retryDecisions,
          error: null,
        };
      }

      const decision = buildRetryDecision(
        {
          attempt: attempts,
          method,
          status: response.status,
          retryAfter: response.headers.get("retry-after"),
          idempotent: input.idempotent,
          preSendFailure: input.preSendFailure,
          principal: input.principal,
        },
        options.retryPolicy,
      );
      retryDecisions.push(decision);

      if (decision.action === "refresh_auth") {
        lease = await options.getAccessToken({ forceRefresh: true });
        refreshed = true;
        replayedAfter401 = true;
        continue;
      }

      if (decision.action === "retry") {
        await sleepMs(decision.delayMs);
        continue;
      }

      return {
        ok: false,
        status: response.status,
        json,
        headers,
        attempts,
        refreshed,
        replayedAfter401,
        retryDecisions,
        error: null,
      };
    } catch (error) {
      const decision = buildRetryDecision(
        {
          attempt: attempts,
          method,
          status: null,
          networkError: true,
          idempotent: input.idempotent,
          preSendFailure: input.preSendFailure,
          principal: input.principal,
        },
        options.retryPolicy,
      );
      retryDecisions.push(decision);

      if (decision.action === "retry") {
        await sleepMs(decision.delayMs);
        continue;
      }

      return {
        ok: false,
        status: 0,
        json: {},
        headers: {},
        attempts,
        refreshed,
        replayedAfter401,
        retryDecisions,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}

function buildUrl(
  baseUrl: string,
  resourcePath: string | undefined,
  query: RetryingChatClientRequestInput["query"],
): string {
  if (!resourcePath) {
    throw new TypeError("Retrying Chat client request requires resourcePath or url.");
  }
  const trimmedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const trimmedPath = resourcePath.startsWith("/")
    ? resourcePath.slice(1)
    : resourcePath;
  const url = new URL(`${trimmedBase}/${trimmedPath}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function createRetryingChatClient(
  options: RetryingChatClientOptions,
): RetryingChatClient {
  const principal = options.principal;
  const baseUrl = options.baseUrl ?? "https://chat.googleapis.com/v1";
  const requestWithRetry = options.requestJsonWithRetry ?? requestJsonWithRetry;

  async function request(
    input: RetryingChatClientRequestInput,
  ): Promise<RequestJsonWithRetryResult> {
    return requestWithRetry(
      {
        url: input.url ?? buildUrl(baseUrl, input.resourcePath, input.query),
        method: input.method ?? "GET",
        headers: input.headers,
        body: input.body,
        idempotent: input.idempotent,
        preSendFailure: input.preSendFailure,
        principal,
      },
      {
        getAccessToken: options.getAccessToken,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.sleepMs ? { sleepMs: options.sleepMs } : {}),
        ...(options.retryPolicy ? { retryPolicy: options.retryPolicy } : {}),
      },
    );
  }

  return {
    request,
    get(resourcePath, input = {}) {
      return request({
        ...input,
        resourcePath,
        method: "GET",
        idempotent: true,
      });
    },
    post(resourcePath, body, input = {}) {
      return request({ ...input, resourcePath, method: "POST", body });
    },
    patch(resourcePath, body, input = {}) {
      return request({ ...input, resourcePath, method: "PATCH", body });
    },
    delete(resourcePath, input = {}) {
      return request({ ...input, resourcePath, method: "DELETE" });
    },
  };
}

function eventIdempotencyKey(event: unknown): string {
  const raw = event && typeof event === "object" ? (event as JsonObject) : null;
  const key = raw?.idempotencyKey ?? raw?.eventId;
  if (typeof key !== "string" || !key.trim()) {
    throw new TypeError("Chat event is missing idempotencyKey.");
  }
  return key;
}

function eventMetadata(event: unknown): JsonObject {
  const raw = event && typeof event === "object" ? (event as JsonObject) : {};
  const source = raw.source && typeof raw.source === "object"
    ? (raw.source as JsonObject)
    : {};
  return {
    eventKind: typeof raw.kind === "string" ? raw.kind : null,
    sourceKind: typeof source.kind === "string" ? source.kind : null,
  };
}

export async function guardDuplicateEventDelivery(
  event: unknown,
  options: {
    store: IdempotencyStore;
    ttlMs?: number;
    nowMs?: number;
    metadata?: JsonObject;
  },
): Promise<DuplicateEventGuardResult> {
  const claim = await options.store.claim({
    key: eventIdempotencyKey(event),
    ttlMs: options.ttlMs,
    nowMs: options.nowMs,
    metadata: options.metadata ?? eventMetadata(event),
  });
  return {
    duplicate: claim.duplicate,
    responseBody: claim.duplicate ? {} : null,
    claim,
  };
}
