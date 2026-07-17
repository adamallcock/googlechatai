import crypto from "node:crypto";

import type {
  IdempotencyClaim,
  IdempotencyClaimInput,
  IdempotencyStore,
} from "../transport/index.js";

type JsonObject = Record<string, unknown>;

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_BASE_URL = "https://firestore.googleapis.com/v1";
const MAX_CAS_ATTEMPTS = 5;
const DEFAULT_CAS_RETRY_BASE_DELAY_MS = 5;
const DEFAULT_CAS_RETRY_MAX_DELAY_MS = 100;

export interface FirestoreTransportRequest {
  method: "POST" | "GET" | "PATCH" | "DELETE";
  url: string;
  body?: JsonObject;
}

export interface FirestoreTransportResponse {
  status: number;
  json?: unknown;
}

/**
 * An application-owned authenticated Firestore REST transport. Keeping it
 * injected means the SDK never persists or logs bearer tokens, and lets apps
 * use their existing Google auth stack or the official Firestore client.
 */
export type FirestoreTransport = (
  request: FirestoreTransportRequest,
) => Promise<FirestoreTransportResponse>;

export interface FirestoreIdempotencyStoreOptions {
  projectId: string;
  /** A Firestore collection path, such as `chatIdempotency` or `apps/x/claims`. */
  collectionPath: string;
  request: FirestoreTransport;
  databaseId?: string;
  baseUrl?: string;
  defaultTtlMs?: number;
  /** Bound retries for stale Firestore update-time preconditions. */
  maxCasAttempts?: number;
  /** Base delay for retrying a stale update-time precondition. Set 0 in deterministic tests. */
  casRetryBaseDelayMs?: number;
  /** Maximum delay for retrying a stale update-time precondition. */
  casRetryMaxDelayMs?: number;
  /** Injectable sleep hook for runtimes that own their scheduling policy. */
  sleep?: (delayMs: number) => Promise<void>;
  /** Injectable jitter source; must return a number in [0, 1]. */
  random?: () => number;
  /**
   * Retain duplicate-delivery counters with a CAS write. Disable this on a
   * high-throughput ingress path when the duplicate decision matters but
   * per-delivery statistics do not.
   */
  recordDuplicateDeliveries?: boolean;
}

interface StoredDocument {
  key: string;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  expiresAtMs: number;
  seenCount: number;
  metadata?: JsonObject;
  updateTime: string;
}

export class FirestoreIdempotencyStoreError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "FirestoreIdempotencyStoreError";
    this.status = status;
  }
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(message);
  }
  return value;
}

function idempotencyKey(value: unknown): string {
  return requiredString(value, "Idempotency key must be a non-empty string.");
}

function positiveMs(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function nonNegativeOptionMs(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function nonNegativeMs(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : Date.now();
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function asRecord(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stringField(fields: JsonObject, name: string): string | null {
  const field = asRecord(fields[name]);
  const value = field?.stringValue ?? field?.timestampValue;
  return typeof value === "string" ? value : null;
}

function integerField(fields: JsonObject, name: string): number | null {
  const field = asRecord(fields[name]);
  const value = field?.integerValue;
  const parsed = typeof value === "string" || typeof value === "number"
    ? Number(value)
    : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseMetadata(fields: JsonObject): JsonObject | undefined {
  const raw = stringField(fields, "metadataJson");
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = asRecord(JSON.parse(raw));
    return parsed ?? undefined;
  } catch {
    throw new TypeError("Firestore idempotency metadataJson must contain an object.");
  }
}

function documentFromResponse(value: unknown): StoredDocument {
  const document = asRecord(value);
  const fields = asRecord(document?.fields);
  const updateTime = typeof document?.updateTime === "string" ? document.updateTime : null;
  if (!fields || !updateTime) {
    throw new TypeError("Firestore idempotency document is missing fields or updateTime.");
  }
  const key = stringField(fields, "key");
  const firstSeenAt = stringField(fields, "firstSeenAt");
  const lastSeenAt = stringField(fields, "lastSeenAt");
  const expiresAt = stringField(fields, "expiresAt");
  const seenCount = integerField(fields, "seenCount");
  const firstSeenAtMs = firstSeenAt ? Date.parse(firstSeenAt) : Number.NaN;
  const lastSeenAtMs = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (
    !key ||
    !Number.isFinite(firstSeenAtMs) ||
    !Number.isFinite(lastSeenAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    !seenCount
  ) {
    throw new TypeError("Firestore idempotency document has invalid claim fields.");
  }
  return {
    key,
    firstSeenAtMs,
    lastSeenAtMs,
    expiresAtMs,
    seenCount,
    metadata: parseMetadata(fields),
    updateTime,
  };
}

function claimFromDocument(
  document: StoredDocument,
  options: { claimed: boolean; duplicate: boolean },
): IdempotencyClaim {
  return {
    key: document.key,
    claimed: options.claimed,
    duplicate: options.duplicate,
    firstSeenAt: iso(document.firstSeenAtMs),
    lastSeenAt: iso(document.lastSeenAtMs),
    expiresAt: iso(document.expiresAtMs),
    seenCount: document.seenCount,
    metadata: document.metadata ?? null,
  };
}

function fieldsForDocument(document: Omit<StoredDocument, "updateTime">): JsonObject {
  const fields: JsonObject = {
    key: { stringValue: document.key },
    firstSeenAt: { timestampValue: iso(document.firstSeenAtMs) },
    lastSeenAt: { timestampValue: iso(document.lastSeenAtMs) },
    expiresAt: { timestampValue: iso(document.expiresAtMs) },
    seenCount: { integerValue: String(document.seenCount) },
  };
  if (document.metadata) {
    fields.metadataJson = { stringValue: JSON.stringify(document.metadata) };
  }
  return fields;
}

function updateFieldsForDocument(document: StoredDocument): JsonObject {
  return {
    lastSeenAt: { timestampValue: iso(document.lastSeenAtMs) },
    seenCount: { integerValue: String(document.seenCount) },
  };
}

function normalizedCollectionPath(value: unknown): string {
  const path = requiredString(value, "Firestore collectionPath must be non-empty.");
  const segments = path.split("/");
  if (
    segments.some((segment) => segment.trim() === "") ||
    segments.length % 2 === 0
  ) {
    throw new TypeError(
      "Firestore collectionPath must contain an odd number of non-empty path segments.",
    );
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function documentIdFor(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function query(url: string, values: Record<string, string | string[]>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      search.append(key, item);
    }
  }
  return `${url}?${search.toString()}`;
}

function responseOk(response: FirestoreTransportResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

function isFailedPrecondition(response: FirestoreTransportResponse): boolean {
  if (response.status === 409) {
    return true;
  }
  if (response.status !== 400) {
    return false;
  }
  const payload = asRecord(response.json);
  const error = asRecord(payload?.error) ?? payload;
  return error?.status === "FAILED_PRECONDITION";
}

/**
 * Durable idempotency store backed by Firestore's conditional document
 * creation and update-time preconditions. It is intentionally transport
 * injected, so callers retain control of OAuth, service-account, or emulator
 * authentication and the SDK never owns credentials.
 */
export class FirestoreIdempotencyStore implements IdempotencyStore {
  readonly #projectId: string;
  readonly #collectionPath: string;
  readonly #request: FirestoreTransport;
  readonly #databaseId: string;
  readonly #baseUrl: string;
  readonly #defaultTtlMs: number;
  readonly #maxCasAttempts: number;
  readonly #casRetryBaseDelayMs: number;
  readonly #casRetryMaxDelayMs: number;
  readonly #sleep: (delayMs: number) => Promise<void>;
  readonly #random: () => number;
  readonly #recordDuplicateDeliveries: boolean;

  constructor(options: FirestoreIdempotencyStoreOptions) {
    this.#projectId = requiredString(options?.projectId, "Firestore projectId must be non-empty.");
    this.#collectionPath = normalizedCollectionPath(options?.collectionPath);
    if (typeof options?.request !== "function") {
      throw new TypeError("FirestoreIdempotencyStore requires an injected request transport.");
    }
    this.#request = options.request;
    this.#databaseId = requiredString(options.databaseId ?? "(default)", "Firestore databaseId must be non-empty.");
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#defaultTtlMs = positiveMs(options.defaultTtlMs, DEFAULT_TTL_MS);
    this.#maxCasAttempts = positiveMs(options.maxCasAttempts, MAX_CAS_ATTEMPTS);
    this.#casRetryBaseDelayMs = nonNegativeOptionMs(
      options.casRetryBaseDelayMs,
      DEFAULT_CAS_RETRY_BASE_DELAY_MS,
    );
    this.#casRetryMaxDelayMs = nonNegativeOptionMs(
      options.casRetryMaxDelayMs,
      DEFAULT_CAS_RETRY_MAX_DELAY_MS,
    );
    if (this.#casRetryMaxDelayMs < this.#casRetryBaseDelayMs) {
      throw new TypeError("casRetryMaxDelayMs must be greater than or equal to casRetryBaseDelayMs.");
    }
    this.#sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.#random = options.random ?? Math.random;
    this.#recordDuplicateDeliveries = options.recordDuplicateDeliveries !== false;
  }

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaim> {
    const key = idempotencyKey(input.key);
    const nowMs = nonNegativeMs(input.nowMs);
    const documentId = documentIdFor(key);
    const documentUrl = this.#documentUrl(documentId);
    const collectionUrl = this.#collectionUrl();
    const initial: Omit<StoredDocument, "updateTime"> = {
      key,
      firstSeenAtMs: nowMs,
      lastSeenAtMs: nowMs,
      expiresAtMs: nowMs + positiveMs(input.ttlMs, this.#defaultTtlMs),
      seenCount: 1,
      metadata: input.metadata,
    };

    for (let attempt = 0; attempt < this.#maxCasAttempts; attempt += 1) {
      const create = await this.#request({
        method: "POST",
        url: query(collectionUrl, { documentId }),
        body: { fields: fieldsForDocument(initial) },
      });
      if (responseOk(create)) {
        return claimFromDocument({ ...initial, updateTime: "created" }, {
          claimed: true,
          duplicate: false,
        });
      }
      if (create.status !== 409) {
        throw new FirestoreIdempotencyStoreError(
          "Firestore idempotency create request failed.",
          create.status,
        );
      }

      const existingResponse = await this.#request({ method: "GET", url: documentUrl });
      if (existingResponse.status === 404) {
        await this.#retryAfterConflict(attempt);
        continue;
      }
      if (!responseOk(existingResponse)) {
        throw new FirestoreIdempotencyStoreError(
          "Firestore idempotency read request failed.",
          existingResponse.status,
        );
      }
      const existing = documentFromResponse(existingResponse.json);
      if (existing.key !== key) {
        throw new FirestoreIdempotencyStoreError(
          "Firestore idempotency document key did not match its document ID.",
          existingResponse.status,
        );
      }

      if (existing.expiresAtMs <= nowMs) {
        const remove = await this.#request({
          method: "DELETE",
          url: query(documentUrl, { "currentDocument.updateTime": existing.updateTime }),
        });
        if (responseOk(remove) || remove.status === 404 || isFailedPrecondition(remove)) {
          await this.#retryAfterConflict(attempt);
          continue;
        }
        throw new FirestoreIdempotencyStoreError(
          "Firestore idempotency expiry cleanup failed.",
          remove.status,
        );
      }

      if (!this.#recordDuplicateDeliveries) {
        return claimFromDocument(existing, { claimed: false, duplicate: true });
      }

      const updated: StoredDocument = {
        ...existing,
        lastSeenAtMs: nowMs,
        seenCount: existing.seenCount + 1,
      };
      const update = await this.#request({
        method: "PATCH",
        url: query(documentUrl, {
          "currentDocument.updateTime": existing.updateTime,
          "updateMask.fieldPaths": ["lastSeenAt", "seenCount"],
        }),
        body: { fields: updateFieldsForDocument(updated) },
      });
      if (responseOk(update)) {
        return claimFromDocument(updated, { claimed: false, duplicate: true });
      }
      if (isFailedPrecondition(update)) {
        await this.#retryAfterConflict(attempt);
        continue;
      }
      throw new FirestoreIdempotencyStoreError(
        "Firestore idempotency compare-and-set update failed.",
        update.status,
      );
    }

    throw new FirestoreIdempotencyStoreError(
      "Firestore idempotency claim conflicted repeatedly; retry the delivery.",
      409,
    );
  }

  #collectionUrl(): string {
    return `${this.#baseUrl}/projects/${encodeURIComponent(this.#projectId)}` +
      `/databases/${encodeURIComponent(this.#databaseId)}/documents/${this.#collectionPath}`;
  }

  #documentUrl(documentId: string): string {
    return `${this.#collectionUrl()}/${documentId}`;
  }

  async #retryAfterConflict(attempt: number): Promise<void> {
    if (attempt + 1 >= this.#maxCasAttempts || this.#casRetryBaseDelayMs === 0) {
      return;
    }
    const exponential = Math.min(
      this.#casRetryMaxDelayMs,
      this.#casRetryBaseDelayMs * 2 ** attempt,
    );
    const random = this.#random();
    const jitter = Number.isFinite(random)
      ? Math.min(1, Math.max(0, random))
      : 0.5;
    await this.#sleep(Math.round(exponential * (0.5 + jitter * 0.5)));
  }
}
