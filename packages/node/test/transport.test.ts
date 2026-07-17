import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FileIdempotencyStore,
  InMemoryIdempotencyStore,
  buildRetryDecision,
  createRetryingChatClient,
  guardDuplicateEventDelivery,
  isReplaySafe,
  parseRetryAfterMs,
  requestJsonWithRetry,
} from "../src/index.js";

describe("transport retry policy", () => {
  it("classifies expired user auth as a refresh-auth retry", () => {
    expect(
      buildRetryDecision({
        attempt: 1,
        method: "GET",
        status: 401,
        principal: "user",
      }),
    ).toEqual({
      action: "refresh_auth",
      retryable: true,
      refreshAuth: true,
      replaySafe: true,
      reason: "access_token_expired_or_invalid",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 0,
      status: 401,
      principal: "user",
    });
  });

  it("honors Retry-After for rate limits", () => {
    expect(
      buildRetryDecision({
        attempt: 1,
        method: "GET",
        status: 429,
        retryAfter: "2",
      }).delayMs,
    ).toBe(2_000);
  });

  it("retries transient read failures with bounded backoff", () => {
    expect(
      buildRetryDecision(
        {
          attempt: 2,
          method: "GET",
          status: 503,
        },
        { baseDelayMs: 100, maxDelayMs: 150 },
      ),
    ).toMatchObject({
      action: "retry",
      retryable: true,
      reason: "transient_failure",
      delayMs: 150,
    });
  });

  it("does not replay unsafe writes after transient failures", () => {
    expect(
      buildRetryDecision({
        attempt: 1,
        method: "POST",
        status: 503,
      }),
    ).toMatchObject({
      action: "fail",
      retryable: false,
      replaySafe: false,
      reason: "non_idempotent_request_not_replayed",
    });
  });

  it("replays idempotent writes and pre-send failures", () => {
    expect(isReplaySafe({ attempt: 1, method: "POST", idempotent: true })).toBe(
      true,
    );
    expect(
      buildRetryDecision({
        attempt: 1,
        method: "POST",
        status: 500,
        idempotent: true,
      }),
    ).toMatchObject({
      action: "retry",
      retryable: true,
      replaySafe: true,
    });
    expect(
      buildRetryDecision({
        attempt: 1,
        method: "POST",
        networkError: true,
        preSendFailure: true,
      }),
    ).toMatchObject({
      action: "retry",
      retryable: true,
      replaySafe: true,
    });
  });

  it("fails after max attempts and ignores invalid Retry-After values", () => {
    expect(
      buildRetryDecision({
        attempt: 3,
        method: "GET",
        status: 503,
      }),
    ).toMatchObject({
      action: "fail",
      reason: "max_attempts_exhausted",
    });
    expect(parseRetryAfterMs("not a date")).toBeNull();
  });

  it("claims idempotency keys once, marks duplicates, and expires old claims", async () => {
    const store = new InMemoryIdempotencyStore({ maxEntries: 10 });

    const first = await store.claim({
      key: "event-id-hash-1",
      ttlMs: 1_000,
      nowMs: 1_000,
    });
    const duplicate = await store.claim({
      key: "event-id-hash-1",
      ttlMs: 1_000,
      nowMs: 1_100,
    });
    const afterExpiry = await store.claim({
      key: "event-id-hash-1",
      ttlMs: 1_000,
      nowMs: 2_001,
    });

    expect(first).toMatchObject({
      claimed: true,
      duplicate: false,
      seenCount: 1,
    });
    expect(duplicate).toMatchObject({
      claimed: false,
      duplicate: true,
      seenCount: 2,
    });
    expect(afterExpiry).toMatchObject({
      claimed: true,
      duplicate: false,
      seenCount: 1,
    });
  });

  it("persists duplicate idempotency claims across file store instances", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-idempotency-"));
    const filePath = path.join(dir, "claims.json");
    try {
      const firstStore = new FileIdempotencyStore({ filePath });
      const secondStore = new FileIdempotencyStore({ filePath });

      await expect(
        firstStore.claim({ key: "event-id-hash-2", ttlMs: 60_000, nowMs: 1_000 }),
      ).resolves.toMatchObject({ claimed: true, duplicate: false });
      await expect(
        secondStore.claim({ key: "event-id-hash-2", ttlMs: 60_000, nowMs: 2_000 }),
      ).resolves.toMatchObject({
        claimed: false,
        duplicate: true,
        seenCount: 2,
      });

      const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
      expect(saved.entries["event-id-hash-2"]).toMatchObject({ seenCount: 2 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent file claims without losing duplicate observations", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-idempotency-"));
    const filePath = path.join(dir, "claims.json");
    try {
      const claims = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          new FileIdempotencyStore({ filePath }).claim({
            key: "same-event",
            ttlMs: 60_000,
            nowMs: 1_000 + index,
          }),
        ),
      );
      expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
      expect(claims.filter((claim) => claim.duplicate)).toHaveLength(11);

      const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
      expect(saved.entries["same-event"]).toMatchObject({ seenCount: 12 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refreshes user auth and replays after a 401 without caller-side retry code", async () => {
    const tokenCalls: boolean[] = [];
    const authorizations: string[] = [];
    const result = await requestJsonWithRetry(
      {
        url: "https://chat.googleapis.com/v1/spaces?pageSize=1",
        method: "GET",
        principal: "user",
      },
      {
        getAccessToken: async ({ forceRefresh }) => {
          tokenCalls.push(forceRefresh);
          return {
            accessToken: forceRefresh ? "fresh-token" : "stale-token",
            refreshed: forceRefresh,
          };
        },
        fetch: async (_url, init) => {
          authorizations.push(String(init?.headers?.authorization ?? ""));
          if (authorizations.length === 1) {
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

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ spaces: [] });
    expect(result.attempts).toBe(2);
    expect(result.refreshed).toBe(true);
    expect(result.replayedAfter401).toBe(true);
    expect(tokenCalls).toEqual([false, true]);
    expect(authorizations).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
  });

  it("does not replay unsafe non-idempotent writes after transient failures", async () => {
    let calls = 0;
    const result = await requestJsonWithRetry(
      {
        url: "https://chat.googleapis.com/v1/spaces/AAA/messages",
        method: "POST",
        principal: "app",
        body: { text: "hello" },
      },
      {
        getAccessToken: async () => ({ accessToken: "app-token" }),
        fetch: async () => {
          calls += 1;
          return new Response(
            JSON.stringify({ error: { status: "UNAVAILABLE" } }),
            { status: 503, headers: { "content-type": "application/json" } },
          );
        },
        sleepMs: async () => {},
      },
    );

    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.retryDecisions).toHaveLength(1);
    expect(result.retryDecisions[0]).toMatchObject({
      action: "fail",
      reason: "non_idempotent_request_not_replayed",
    });
  });

  it("creates principal-scoped Chat clients that hide retry and refresh handling", async () => {
    const calls: Array<{
      url: string;
      method: string | undefined;
      principal: string | null | undefined;
      idempotent: boolean | undefined;
    }> = [];
    const client = createRetryingChatClient({
      principal: "user",
      getAccessToken: async ({ forceRefresh }) => ({
        accessToken: forceRefresh ? "fresh-token" : "cached-token",
      }),
      requestJsonWithRetry: async (input) => {
        calls.push({
          url: input.url,
          method: input.method,
          principal: input.principal,
          idempotent: input.idempotent,
        });
        return {
          ok: true,
          status: 200,
          json: { spaces: [] },
          headers: {},
          attempts: 1,
          refreshed: false,
          replayedAfter401: false,
          retryDecisions: [],
          error: null,
        };
      },
    });

    await expect(
      client.get("spaces", { query: { pageSize: 10, filter: "spaceType = \"SPACE\"" } }),
    ).resolves.toMatchObject({ ok: true, json: { spaces: [] } });

    expect(calls).toEqual([
      {
        url: "https://chat.googleapis.com/v1/spaces?pageSize=10&filter=spaceType+%3D+%22SPACE%22",
        method: "GET",
        principal: "user",
        idempotent: true,
      },
    ]);
  });

  it("guards duplicate Chat event deliveries with a durable idempotency claim", async () => {
    const store = new InMemoryIdempotencyStore();
    const event = {
      idempotencyKey: "chat-http:spaces/AAA/messages/one:2026-07-03T12:00:00Z",
      kind: "message.created",
      source: { kind: "chat_http" },
    };

    const first = await guardDuplicateEventDelivery(event, {
      store,
      ttlMs: 60_000,
      nowMs: 1_000,
    });
    const duplicate = await guardDuplicateEventDelivery(event, {
      store,
      ttlMs: 60_000,
      nowMs: 2_000,
    });

    expect(first).toMatchObject({
      duplicate: false,
      responseBody: null,
      claim: { claimed: true, seenCount: 1 },
    });
    expect(duplicate).toMatchObject({
      duplicate: true,
      responseBody: {},
      claim: {
        claimed: false,
        duplicate: true,
        seenCount: 2,
        metadata: {
          eventKind: "message.created",
          sourceKind: "chat_http",
        },
      },
    });
  });
});
