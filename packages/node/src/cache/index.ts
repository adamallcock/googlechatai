import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { withFileStateLock, writeFileAtomically } from "../internal/file-state.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ArtifactProcessorDescriptor {
  name: string;
  version?: string | null;
  options?: Record<string, JsonValue | undefined>;
}

export interface ArtifactCacheKeyInput {
  namespace: string;
  sourceId: string;
  bytes: string | Uint8Array | ArrayBuffer;
  processor?: ArtifactProcessorDescriptor | null;
}

export interface ArtifactCacheKey {
  namespace: string;
  key: string;
  contentSha256: string;
  processorHash: string | null;
  sizeBytes: number;
}

export interface ArtifactCachePutInput {
  key: string;
  bytes: string | Uint8Array | ArrayBuffer;
  metadata?: Record<string, unknown>;
  nowMs?: number;
  ttlMs?: number;
}

export interface ArtifactCacheHit {
  hit: true;
  negative?: false;
  key: string;
  metadata: Record<string, unknown>;
  bytes: Uint8Array;
  text: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface ArtifactCacheMiss {
  hit: false;
  key: string;
  reason: "missing" | "expired";
}

export interface NegativeCacheEntry {
  hit: true;
  negative: true;
  key: string;
  reason: string;
  sourceId: string | null;
  createdAt: string;
  expiresAt: string;
}

export type ArtifactCacheGetResult =
  | ArtifactCacheHit
  | ArtifactCacheMiss
  | NegativeCacheEntry;

export interface ArtifactCache {
  get(
    key: string,
    options?: { nowMs?: number },
  ): Promise<ArtifactCacheGetResult>;
  put(input: ArtifactCachePutInput): Promise<ArtifactCacheHit>;
  putNegative(entry: NegativeCacheEntry): Promise<NegativeCacheEntry>;
}

interface StoredArtifact {
  kind: "artifact";
  key: string;
  metadata: Record<string, unknown>;
  bytes: Uint8Array;
  createdAtMs: number;
  expiresAtMs: number | null;
}

interface SerializedMetadata {
  version: 1;
  kind: "artifact" | "negative";
  key: string;
  metadata?: Record<string, unknown>;
  blob?: string;
  reason?: string;
  sourceId?: string | null;
  createdAt: string;
  expiresAt?: string | null;
}

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function bytesFrom(value: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return value;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseIso(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nowOrDefault(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : Date.now();
}

function ttlOrDefault(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : DEFAULT_CACHE_TTL_MS;
}

function sanitizeKey(key: string): string {
  if (typeof key !== "string" || !key.trim()) {
    throw new TypeError("Cache key must be a non-empty string.");
  }
  return key;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function hashString(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function hashBytes(input: string | Uint8Array | ArrayBuffer): string {
  return crypto.createHash("sha256").update(bytesFrom(input)).digest("hex");
}

export function buildArtifactCacheKey(
  input: ArtifactCacheKeyInput,
): ArtifactCacheKey {
  const namespace = sanitizeKey(input.namespace);
  const sourceId = sanitizeKey(input.sourceId);
  const contentSha256 = hashBytes(input.bytes);
  const bytes = bytesFrom(input.bytes);
  const processorHash = input.processor
    ? hashString(stableJson(input.processor))
    : null;
  const keyMaterial = stableJson({
    namespace,
    sourceId,
    contentSha256,
    processorHash,
  });

  return {
    namespace,
    key: `${namespace}:${hashString(keyMaterial)}`,
    contentSha256,
    processorHash,
    sizeBytes: bytes.byteLength,
  };
}

export function buildNegativeCacheEntry(input: {
  key: string;
  reason: string;
  sourceId?: string | null;
  nowMs?: number;
  ttlMs?: number;
}): NegativeCacheEntry {
  const nowMs = nowOrDefault(input.nowMs);
  const ttlMs = ttlOrDefault(input.ttlMs);
  return {
    hit: true,
    negative: true,
    key: sanitizeKey(input.key),
    reason: sanitizeKey(input.reason),
    sourceId: input.sourceId ?? null,
    createdAt: iso(nowMs),
    expiresAt: iso(nowMs + ttlMs),
  };
}

function hitFromStored(key: string, stored: StoredArtifact): ArtifactCacheHit {
  const text = new TextDecoder().decode(stored.bytes);
  return {
    hit: true,
    negative: false,
    key,
    metadata: stored.metadata,
    bytes: stored.bytes,
    text,
    createdAt: iso(stored.createdAtMs),
    expiresAt: stored.expiresAtMs === null ? null : iso(stored.expiresAtMs),
  };
}

function isExpired(expiresAtMs: number | null, nowMs: number): boolean {
  return expiresAtMs !== null && expiresAtMs <= nowMs;
}

export class InMemoryArtifactCache implements ArtifactCache {
  readonly #artifacts = new Map<string, StoredArtifact>();
  readonly #negative = new Map<string, NegativeCacheEntry>();

  async get(
    key: string,
    options: { nowMs?: number } = {},
  ): Promise<ArtifactCacheGetResult> {
    const normalizedKey = sanitizeKey(key);
    const nowMs = nowOrDefault(options.nowMs);
    const negative = this.#negative.get(normalizedKey);
    if (negative) {
      if (isExpired(parseIso(negative.expiresAt), nowMs)) {
        this.#negative.delete(normalizedKey);
        return { hit: false, key: normalizedKey, reason: "expired" };
      }
      return negative;
    }

    const artifact = this.#artifacts.get(normalizedKey);
    if (!artifact) {
      return { hit: false, key: normalizedKey, reason: "missing" };
    }
    if (isExpired(artifact.expiresAtMs, nowMs)) {
      this.#artifacts.delete(normalizedKey);
      return { hit: false, key: normalizedKey, reason: "expired" };
    }
    return hitFromStored(normalizedKey, artifact);
  }

  async put(input: ArtifactCachePutInput): Promise<ArtifactCacheHit> {
    const key = sanitizeKey(input.key);
    const bytes = bytesFrom(input.bytes);
    const nowMs = nowOrDefault(input.nowMs);
    const ttlMs = ttlOrDefault(input.ttlMs);
    const stored: StoredArtifact = {
      kind: "artifact",
      key,
      metadata: input.metadata ?? {},
      bytes,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    };
    this.#negative.delete(key);
    this.#artifacts.set(key, stored);
    return hitFromStored(key, stored);
  }

  async putNegative(entry: NegativeCacheEntry): Promise<NegativeCacheEntry> {
    const key = sanitizeKey(entry.key);
    this.#artifacts.delete(key);
    this.#negative.set(key, entry);
    return entry;
  }
}

export class FileArtifactCache implements ArtifactCache {
  readonly #directory: string;

  constructor(options: { directory: string }) {
    if (!options.directory) {
      throw new TypeError("FileArtifactCache requires directory.");
    }
    this.#directory = options.directory;
  }

  async get(
    key: string,
    options: { nowMs?: number } = {},
  ): Promise<ArtifactCacheGetResult> {
    const normalizedKey = sanitizeKey(key);
    const nowMs = nowOrDefault(options.nowMs);
    const metadata = await this.#readMetadata(normalizedKey);
    if (!metadata) {
      return { hit: false, key: normalizedKey, reason: "missing" };
    }

    const expiresAtMs = parseIso(metadata.expiresAt);
    if (isExpired(expiresAtMs, nowMs)) {
      return { hit: false, key: normalizedKey, reason: "expired" };
    }

    if (metadata.kind === "negative") {
      return {
        hit: true,
        negative: true,
        key: normalizedKey,
        reason: metadata.reason ?? "negative_cache",
        sourceId: metadata.sourceId ?? null,
        createdAt: metadata.createdAt,
        expiresAt: metadata.expiresAt ?? iso(nowMs),
      };
    }

    if (!metadata.blob) {
      return { hit: false, key: normalizedKey, reason: "missing" };
    }
    const bytes = await fs.readFile(path.join(this.#directory, "blobs", metadata.blob));
    return {
      hit: true,
      negative: false,
      key: normalizedKey,
      metadata: metadata.metadata ?? {},
      bytes,
      text: new TextDecoder().decode(bytes),
      createdAt: metadata.createdAt,
      expiresAt: metadata.expiresAt ?? null,
    };
  }

  async put(input: ArtifactCachePutInput): Promise<ArtifactCacheHit> {
    const key = sanitizeKey(input.key);
    return withFileStateLock(this.#metadataPath(key), async () => {
      const bytes = bytesFrom(input.bytes);
      const nowMs = nowOrDefault(input.nowMs);
      const ttlMs = ttlOrDefault(input.ttlMs);
      const blob = `${hashBytes(bytes)}.bin`;
      await writeFileAtomically(path.join(this.#directory, "blobs", blob), bytes);
      await this.#writeMetadata(key, {
        version: 1,
        kind: "artifact",
        key,
        metadata: input.metadata ?? {},
        blob,
        createdAt: iso(nowMs),
        expiresAt: iso(nowMs + ttlMs),
      });
      return (await this.get(key, { nowMs })) as ArtifactCacheHit;
    });
  }

  async putNegative(entry: NegativeCacheEntry): Promise<NegativeCacheEntry> {
    const key = sanitizeKey(entry.key);
    return withFileStateLock(this.#metadataPath(key), async () => {
      await this.#writeMetadata(key, {
        version: 1,
        kind: "negative",
        key,
        reason: entry.reason,
        sourceId: entry.sourceId,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
      });
      return entry;
    });
  }

  async #readMetadata(key: string): Promise<SerializedMetadata | null> {
    try {
      return JSON.parse(await fs.readFile(this.#metadataPath(key), "utf8")) as
        | SerializedMetadata
        | null;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }

  async #writeMetadata(key: string, metadata: SerializedMetadata): Promise<void> {
    await writeFileAtomically(
      this.#metadataPath(key),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
  }

  #metadataPath(key: string): string {
    return path.join(this.#directory, "metadata", `${hashString(key)}.json`);
  }
}
