import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FileIdempotencyStore,
  requestJsonWithRetry,
} from "../../packages/node/dist/index.js";

class ExampleTokenBroker {
  #tokens = new Map();

  constructor() {
    this.#tokens.set("user:adam@example.com", {
      stale: "stale-user-token",
      fresh: "fresh-user-token",
    });
  }

  async getAccessToken({ principalId, forceRefresh = false }) {
    const token = this.#tokens.get(principalId);
    if (!token) {
      throw new Error(`No token lease is available for ${principalId}.`);
    }

    return {
      accessToken: forceRefresh ? token.fresh : token.stale,
      refreshed: forceRefresh,
    };
  }
}

class CompareAndSetBackend {
  #records = new Map();

  async createIfAbsent(key, value) {
    if (this.#records.has(key)) {
      return false;
    }
    this.#records.set(key, value);
    return true;
  }

  async get(key) {
    return this.#records.get(key) ?? null;
  }

  async update(key, updateRecord) {
    const current = this.#records.get(key);
    if (!current) {
      return null;
    }
    const next = updateRecord(current);
    this.#records.set(key, next);
    return next;
  }

  async replace(key, value) {
    this.#records.set(key, value);
  }
}

class ExternalIdempotencyStore {
  constructor({ backend, defaultTtlMs = 10 * 60 * 1000 }) {
    this.backend = backend;
    this.defaultTtlMs = defaultTtlMs;
  }

  async claim({ key, ttlMs = this.defaultTtlMs, nowMs = Date.now(), metadata }) {
    const existing = await this.backend.get(key);
    const expired = existing && existing.expiresAtMs <= nowMs;

    if (existing && !expired) {
      const updated = await this.backend.update(key, (record) => ({
        ...record,
        lastSeenAtMs: nowMs,
        seenCount: record.seenCount + 1,
      }));
      return claimFromRecord(key, updated, {
        claimed: false,
        duplicate: true,
      });
    }

    const record = {
      firstSeenAtMs: nowMs,
      lastSeenAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
      seenCount: 1,
      metadata,
    };

    if (expired) {
      await this.backend.replace(key, record);
      return claimFromRecord(key, record, {
        claimed: true,
        duplicate: false,
      });
    }

    const inserted = await this.backend.createIfAbsent(key, record);

    if (!inserted) {
      const updated = await this.backend.update(key, (current) => ({
        ...current,
        lastSeenAtMs: nowMs,
        seenCount: current.seenCount + 1,
      }));
      return claimFromRecord(key, updated, {
        claimed: false,
        duplicate: true,
      });
    }

    return claimFromRecord(key, record, {
      claimed: true,
      duplicate: false,
    });
  }
}

function claimFromRecord(key, record, { claimed, duplicate }) {
  return {
    key,
    claimed,
    duplicate,
    firstSeenAt: new Date(record.firstSeenAtMs).toISOString(),
    lastSeenAt: new Date(record.lastSeenAtMs).toISOString(),
    expiresAt: new Date(record.expiresAtMs).toISOString(),
    seenCount: record.seenCount,
    metadata: record.metadata ?? null,
  };
}

async function demoRetryingUserRead() {
  const tokenBroker = new ExampleTokenBroker();
  const authHeaders = [];

  const result = await requestJsonWithRetry(
    {
      url: "https://chat.googleapis.com/v1/spaces?pageSize=1",
      method: "GET",
      principal: "user",
    },
    {
      getAccessToken: ({ forceRefresh }) =>
        tokenBroker.getAccessToken({
          principalId: "user:adam@example.com",
          forceRefresh,
        }),
      fetch: async (_url, init) => {
        authHeaders.push(init.headers.authorization);

        if (authHeaders.length === 1) {
          return new Response(
            JSON.stringify({ error: { status: "UNAUTHENTICATED" } }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(JSON.stringify({ spaces: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      sleepMs: async () => {},
    },
  );

  return {
    ok: result.ok,
    status: result.status,
    attempts: result.attempts,
    refreshed: result.refreshed,
    replayedAfter401: result.replayedAfter401,
    rawTokensPrinted: false,
  };
}

async function demoIdempotencyStores() {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "googlechatai-sdk-example-"),
  );
  const localStore = new FileIdempotencyStore({
    filePath: path.join(tempDir, "idempotency.json"),
    defaultTtlMs: 60_000,
  });
  const externalStore = new ExternalIdempotencyStore({
    backend: new CompareAndSetBackend(),
    defaultTtlMs: 60_000,
  });

  try {
    const localFirst = await localStore.claim({
      key: "event-id-hash-local",
      nowMs: 1_000,
    });
    const localDuplicate = await localStore.claim({
      key: "event-id-hash-local",
      nowMs: 2_000,
    });
    const localAfterExpiry = await localStore.claim({
      key: "event-id-hash-local",
      nowMs: 62_000,
    });
    const externalFirst = await externalStore.claim({
      key: "event-id-hash-external",
      nowMs: 1_000,
      metadata: { source: "direct_chat_event" },
    });
    const externalDuplicate = await externalStore.claim({
      key: "event-id-hash-external",
      nowMs: 2_000,
    });
    const externalAfterExpiry = await externalStore.claim({
      key: "event-id-hash-external",
      nowMs: 62_000,
    });

    return {
      localFileStore: {
        firstClaimed: localFirst.claimed,
        duplicateSuppressed: localDuplicate.duplicate,
        seenCount: localDuplicate.seenCount,
        afterExpiryClaimed: localAfterExpiry.claimed,
      },
      externalCompareAndSetStore: {
        firstClaimed: externalFirst.claimed,
        duplicateSuppressed: externalDuplicate.duplicate,
        seenCount: externalDuplicate.seenCount,
        afterExpiryClaimed: externalAfterExpiry.claimed,
      },
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const output = {
  retryingUserRead: await demoRetryingUserRead(),
  idempotency: await demoIdempotencyStores(),
};

console.log(JSON.stringify(output, null, 2));
