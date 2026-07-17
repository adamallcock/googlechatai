import fs from "node:fs/promises";
import { withFileStateLock, writeFileAtomically } from "../internal/file-state.js";

import type { AccessTokenLease, GetAccessTokenInput } from "../transport/index.js";

export interface TokenRecord {
  principalId: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: string | null;
  scopes?: string[];
  tokenType?: string;
  metadata?: Record<string, unknown>;
}

export interface TokenStore {
  load(principalId: string): Promise<TokenRecord | null>;
  save(record: TokenRecord): Promise<void>;
  delete(principalId: string): Promise<void>;
  list(): Promise<string[]>;
}

interface SerializedTokenStoreFile {
  version: 1;
  records: Record<string, TokenRecord>;
}

export interface FileTokenStoreOptions {
  filePath: string;
}

export interface SecretManagerTokenStoreOptions {
  projectId: string;
  fetch: (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
    },
  ) => Promise<Response>;
  getAccessToken: (input: GetAccessTokenInput) => Promise<AccessTokenLease>;
  secretPrefix?: string;
  baseUrl?: string;
}

export interface GetAccessTokenFromStoreOptions {
  store: TokenStore;
  principalId: string;
  refresh: (record: TokenRecord) => Promise<TokenRecord>;
}

const DEFAULT_SECRET_PREFIX = "chat-token-";
const DEFAULT_SECRET_MANAGER_BASE_URL = "https://secretmanager.googleapis.com";
const FRESHNESS_MARGIN_MS = 60_000;
const MAX_SLUG_LENGTH = 200;

function requiredNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(message);
  }
  return value;
}

function cloneRecord(record: TokenRecord): TokenRecord {
  return {
    ...record,
    scopes: record.scopes ? [...record.scopes] : undefined,
    metadata: record.metadata ? { ...record.metadata } : undefined,
  };
}

/**
 * Slugify a principal id into a Secret Manager compatible secret-id
 * fragment: lowercase, non [a-z0-9-] characters become "-", leading and
 * trailing dashes are trimmed, and the result is capped at 200 characters.
 */
export function slug(principalId: string): string {
  const lowered = requiredNonEmptyString(
    principalId,
    "Expected principalId to be a non-empty string.",
  ).toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9-]/g, "-");
  const trimmed = replaced.replace(/^-+|-+$/g, "");
  return trimmed.slice(0, MAX_SLUG_LENGTH);
}

export class InMemoryTokenStore implements TokenStore {
  readonly #records = new Map<string, TokenRecord>();

  async load(principalId: string): Promise<TokenRecord | null> {
    const key = requiredNonEmptyString(
      principalId,
      "Expected principalId to be a non-empty string.",
    );
    const found = this.#records.get(key);
    return found ? cloneRecord(found) : null;
  }

  async save(record: TokenRecord): Promise<void> {
    const key = requiredNonEmptyString(
      record?.principalId,
      "Expected record.principalId to be a non-empty string.",
    );
    this.#records.set(key, cloneRecord(record));
  }

  async delete(principalId: string): Promise<void> {
    const key = requiredNonEmptyString(
      principalId,
      "Expected principalId to be a non-empty string.",
    );
    this.#records.delete(key);
  }

  async list(): Promise<string[]> {
    return [...this.#records.keys()];
  }
}

export class FileTokenStore implements TokenStore {
  readonly #filePath: string;

  constructor(options: FileTokenStoreOptions) {
    if (!options?.filePath) {
      throw new TypeError("FileTokenStore requires filePath.");
    }
    this.#filePath = options.filePath;
  }

  async load(principalId: string): Promise<TokenRecord | null> {
    const key = requiredNonEmptyString(
      principalId,
      "Expected principalId to be a non-empty string.",
    );
    const records = await this.#readRecords();
    const found = records.get(key);
    return found ? cloneRecord(found) : null;
  }

  async save(record: TokenRecord): Promise<void> {
    const key = requiredNonEmptyString(
      record?.principalId,
      "Expected record.principalId to be a non-empty string.",
    );
    await withFileStateLock(this.#filePath, async () => {
      const records = await this.#readRecords();
      records.set(key, cloneRecord(record));
      await this.#writeRecords(records);
    });
  }

  async delete(principalId: string): Promise<void> {
    const key = requiredNonEmptyString(
      principalId,
      "Expected principalId to be a non-empty string.",
    );
    await withFileStateLock(this.#filePath, async () => {
      const records = await this.#readRecords();
      if (records.delete(key)) {
        await this.#writeRecords(records);
      }
    });
  }

  async list(): Promise<string[]> {
    const records = await this.#readRecords();
    return [...records.keys()];
  }

  async #readRecords(): Promise<Map<string, TokenRecord>> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.#filePath, "utf8")) as
        | SerializedTokenStoreFile
        | undefined;
      return new Map(Object.entries(parsed?.records ?? {}));
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

  async #writeRecords(records: Map<string, TokenRecord>): Promise<void> {
    const payload: SerializedTokenStoreFile = {
      version: 1,
      records: Object.fromEntries(records.entries()),
    };
    await writeFileAtomically(
      this.#filePath,
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  }
}

function secretManagerBaseUrl(baseUrl: string | undefined): string {
  const trimmed = (baseUrl ?? DEFAULT_SECRET_MANAGER_BASE_URL).replace(/\/+$/, "");
  return trimmed;
}

function bytesToBase64(bytes: string): string {
  return Buffer.from(bytes, "utf8").toString("base64");
}

function base64ToBytes(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

async function parseJsonBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class SecretManagerTokenStore implements TokenStore {
  readonly #projectId: string;
  readonly #fetch: SecretManagerTokenStoreOptions["fetch"];
  readonly #getAccessToken: SecretManagerTokenStoreOptions["getAccessToken"];
  readonly #secretPrefix: string;
  readonly #baseUrl: string;

  constructor(options: SecretManagerTokenStoreOptions) {
    if (!options?.projectId) {
      throw new TypeError("SecretManagerTokenStore requires projectId.");
    }
    if (typeof options.fetch !== "function") {
      throw new TypeError("SecretManagerTokenStore requires an injected fetch function.");
    }
    if (typeof options.getAccessToken !== "function") {
      throw new TypeError("SecretManagerTokenStore requires an injected getAccessToken function.");
    }
    this.#projectId = options.projectId;
    this.#fetch = options.fetch;
    this.#getAccessToken = options.getAccessToken;
    this.#secretPrefix = options.secretPrefix ?? DEFAULT_SECRET_PREFIX;
    this.#baseUrl = secretManagerBaseUrl(options.baseUrl);
  }

  async load(principalId: string): Promise<TokenRecord | null> {
    const secretName = this.#secretName(principalId);
    const response = await this.#request(
      "GET",
      `${this.#baseUrl}/v1/projects/${encodeURIComponent(this.#projectId)}/secrets/${encodeURIComponent(secretName)}/versions/latest:access`,
      secretName,
      { allow404: true },
    );
    if (response === null) {
      return null;
    }
    const body = await parseJsonBody(response);
    const payload = body.payload as { data?: string } | undefined;
    if (!payload?.data) {
      return null;
    }
    const decoded = base64ToBytes(payload.data);
    return JSON.parse(decoded) as TokenRecord;
  }

  async save(record: TokenRecord): Promise<void> {
    const principalId = requiredNonEmptyString(
      record?.principalId,
      "Expected record.principalId to be a non-empty string.",
    );
    const secretName = this.#secretName(principalId);
    const encodedPayload = bytesToBase64(JSON.stringify(record));

    const addVersionResponse = await this.#request(
      "POST",
      `${this.#baseUrl}/v1/projects/${encodeURIComponent(this.#projectId)}/secrets/${encodeURIComponent(secretName)}:addVersion`,
      secretName,
      {
        allow404: true,
        body: JSON.stringify({ payload: { data: encodedPayload } }),
      },
    );

    if (addVersionResponse !== null) {
      return;
    }

    await this.#request(
      "POST",
      `${this.#baseUrl}/v1/projects/${encodeURIComponent(this.#projectId)}/secrets?secretId=${encodeURIComponent(secretName)}`,
      secretName,
      {
        body: JSON.stringify({
          replication: { automatic: {} },
          labels: { principal: slug(principalId) },
        }),
      },
    );

    await this.#request(
      "POST",
      `${this.#baseUrl}/v1/projects/${encodeURIComponent(this.#projectId)}/secrets/${encodeURIComponent(secretName)}:addVersion`,
      secretName,
      { body: JSON.stringify({ payload: { data: encodedPayload } }) },
    );
  }

  async delete(principalId: string): Promise<void> {
    const secretName = this.#secretName(principalId);
    await this.#request(
      "DELETE",
      `${this.#baseUrl}/v1/projects/${encodeURIComponent(this.#projectId)}/secrets/${encodeURIComponent(secretName)}`,
      secretName,
      { allow404: true },
    );
  }

  async list(): Promise<string[]> {
    const principalIds: string[] = [];
    let pageToken: string | undefined;
    const filter = `name:${this.#secretPrefix}`;

    do {
      const query = new URLSearchParams({ filter });
      if (pageToken) {
        query.set("pageToken", pageToken);
      }
      const response = await this.#request(
        "GET",
        `${this.#baseUrl}/v1/projects/${encodeURIComponent(this.#projectId)}/secrets?${query.toString()}`,
        "list",
      );
      if (response === null) {
        break;
      }
      const body = await parseJsonBody(response);
      const secrets = Array.isArray(body.secrets) ? (body.secrets as Array<Record<string, unknown>>) : [];
      for (const secret of secrets) {
        const name = typeof secret.name === "string" ? secret.name : "";
        const shortName = name.split("/").pop() ?? "";
        if (shortName.startsWith(this.#secretPrefix)) {
          principalIds.push(shortName.slice(this.#secretPrefix.length));
        }
      }
      pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
    } while (pageToken);

    return principalIds;
  }

  #secretName(principalId: string): string {
    const validated = requiredNonEmptyString(
      principalId,
      "Expected principalId to be a non-empty string.",
    );
    return `${this.#secretPrefix}${slug(validated)}`;
  }

  async #request(
    method: string,
    url: string,
    secretName: string,
    options: { allow404?: boolean; body?: string } = {},
  ): Promise<Response | null> {
    const lease = await this.#getAccessToken({ forceRefresh: false });
    const response = await this.#fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `${lease.tokenType ?? "Bearer"} ${lease.accessToken}`,
      },
      body: options.body,
    });

    if (response.ok) {
      return response;
    }
    if (options.allow404 && response.status === 404) {
      return null;
    }
    throw new Error(`Secret Manager ${method} ${response.status} for ${secretName}`);
  }
}

function isFresh(record: TokenRecord, nowMs: number): boolean {
  if (!record.accessToken) {
    return false;
  }
  if (!record.expiresAt) {
    return true;
  }
  const expiresAtMs = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return true;
  }
  return expiresAtMs > nowMs + FRESHNESS_MARGIN_MS;
}

/**
 * Builds a transport-compatible getAccessToken callable backed by a
 * TokenStore. On each call it loads the stored record for principalId; if
 * the stored access token is fresh (expiresAt missing or more than 60s in
 * the future) and forceRefresh was not requested, it returns the cached
 * token. Otherwise it calls the injected refresh callback, persists the
 * refreshed record back to the store, and returns the new lease.
 */
export function getAccessTokenFromStore(
  options: GetAccessTokenFromStoreOptions,
): (input: GetAccessTokenInput) => Promise<AccessTokenLease> {
  if (!options?.store) {
    throw new TypeError("getAccessTokenFromStore requires store.");
  }
  const principalId = requiredNonEmptyString(
    options.principalId,
    "Expected principalId to be a non-empty string.",
  );
  if (typeof options.refresh !== "function") {
    throw new TypeError("getAccessTokenFromStore requires refresh.");
  }

  return async function getAccessToken(
    input: GetAccessTokenInput,
  ): Promise<AccessTokenLease> {
    const record = await options.store.load(principalId);
    if (!record) {
      throw new Error(`No token record found for principal ${principalId}.`);
    }

    if (!input.forceRefresh && isFresh(record, Date.now())) {
      return {
        accessToken: record.accessToken as string,
        refreshed: false,
        tokenType: record.tokenType,
      };
    }

    const refreshedRecord = await options.refresh(record);
    await options.store.save(refreshedRecord);
    return {
      accessToken: refreshedRecord.accessToken as string,
      refreshed: true,
      tokenType: refreshedRecord.tokenType,
    };
  };
}
