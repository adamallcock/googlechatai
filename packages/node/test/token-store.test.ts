import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { AccessTokenLease } from "../src/transport/index.js";
import {
  FileTokenStore,
  InMemoryTokenStore,
  SecretManagerTokenStore,
  getAccessTokenFromStore,
  slug,
  type TokenRecord,
} from "../src/token-store/index.js";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "token-store-test-"));
}

describe("slug", () => {
  it("lowercases, replaces disallowed characters, trims dashes, and caps length", () => {
    expect(slug("Users/Alice@Example.com")).toBe("users-alice-example-com");
    expect(slug("--leading-and-trailing--")).toBe("leading-and-trailing");
    expect(slug("a".repeat(250))).toBe("a".repeat(200));
  });

  it("throws TypeError for empty input", () => {
    expect(() => slug("")).toThrow(TypeError);
    expect(() => slug("   ")).toThrow(TypeError);
  });
});

describe("InMemoryTokenStore", () => {
  it("round-trips records and deep-copies on load/save so callers cannot mutate internal state", async () => {
    const store = new InMemoryTokenStore();
    const record: TokenRecord = {
      principalId: "users/alice",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: "2026-07-06T12:00:00.000Z",
      scopes: ["scope-a"],
      tokenType: "Bearer",
      metadata: { note: "original" },
    };

    await store.save(record);
    record.scopes?.push("mutated-after-save");
    if (record.metadata) {
      record.metadata.note = "mutated-after-save";
    }

    const loaded = await store.load("users/alice");
    expect(loaded).toEqual({
      principalId: "users/alice",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: "2026-07-06T12:00:00.000Z",
      scopes: ["scope-a"],
      tokenType: "Bearer",
      metadata: { note: "original" },
    });

    loaded?.scopes?.push("mutated-after-load");
    if (loaded?.metadata) {
      loaded.metadata.note = "mutated-after-load";
    }
    const loadedAgain = await store.load("users/alice");
    expect(loadedAgain?.scopes).toEqual(["scope-a"]);
    expect(loadedAgain?.metadata).toEqual({ note: "original" });
  });

  it("returns null for unknown principals and supports delete/list", async () => {
    const store = new InMemoryTokenStore();
    expect(await store.load("missing")).toBeNull();

    await store.save({ principalId: "users/alice", accessToken: "a" });
    await store.save({ principalId: "users/bob", accessToken: "b" });
    expect((await store.list()).sort()).toEqual(["users/alice", "users/bob"]);

    await store.delete("users/alice");
    expect(await store.list()).toEqual(["users/bob"]);
    expect(await store.load("users/alice")).toBeNull();
  });

  it("throws TypeError for empty principalId", async () => {
    const store = new InMemoryTokenStore();
    await expect(store.load("")).rejects.toThrow(TypeError);
    await expect(store.save({ principalId: "" })).rejects.toThrow(TypeError);
    await expect(store.delete("")).rejects.toThrow(TypeError);
  });
});

describe("FileTokenStore", () => {
  it("returns null/[] for a missing file without error", async () => {
    const dir = await makeTempDir();
    const store = new FileTokenStore({ filePath: path.join(dir, "tokens.json") });

    expect(await store.load("users/alice")).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it("creates the file on first save, persists across instances, and writes the documented JSON shape", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "nested", "tokens.json");
    const store = new FileTokenStore({ filePath });

    await store.save({
      principalId: "users/alice",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: "2026-07-06T12:00:00.000Z",
      scopes: ["scope-a"],
      tokenType: "Bearer",
      metadata: { note: "hi" },
    });

    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(raw).toEqual({
      version: 1,
      records: {
        "users/alice": {
          principalId: "users/alice",
          accessToken: "access-1",
          refreshToken: "refresh-1",
          expiresAt: "2026-07-06T12:00:00.000Z",
          scopes: ["scope-a"],
          tokenType: "Bearer",
          metadata: { note: "hi" },
        },
      },
    });

    const secondStore = new FileTokenStore({ filePath });
    const loaded = await secondStore.load("users/alice");
    expect(loaded?.accessToken).toBe("access-1");
  });

  it("chmods the file to 0o600 after write", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "tokens.json");
    const store = new FileTokenStore({ filePath });

    await store.save({ principalId: "users/alice", accessToken: "a" });

    if (process.platform !== "win32") {
      const stat = await fs.stat(filePath);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("supports delete and list across multiple principals", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "tokens.json");
    const store = new FileTokenStore({ filePath });

    await store.save({ principalId: "users/alice", accessToken: "a" });
    await store.save({ principalId: "users/bob", accessToken: "b" });
    expect((await store.list()).sort()).toEqual(["users/alice", "users/bob"]);

    await store.delete("users/alice");
    expect(await store.list()).toEqual(["users/bob"]);
    expect(await store.load("users/alice")).toBeNull();
  });

  it("writes atomically via a temp file and rename (no leftover temp files)", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "tokens.json");
    const store = new FileTokenStore({ filePath });

    await store.save({ principalId: "users/alice", accessToken: "a" });

    const entries = await fs.readdir(dir);
    expect(entries).toEqual(["tokens.json"]);
  });
});

interface CapturedRequest {
  url: string;
  method: string;
  authorization: string;
  body: string | undefined;
}

function makeFakeFetch(
  handler: (request: CapturedRequest) => Response,
): {
  fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => Promise<Response>;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<Response> => {
    const captured: CapturedRequest = {
      url,
      method: init.method,
      authorization: init.headers.authorization ?? "",
      body: init.body,
    };
    requests.push(captured);
    return handler(captured);
  };
  return { fetch: fetchImpl, requests };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

const fixedLease: AccessTokenLease = { accessToken: "lease-token-1", tokenType: "Bearer" };

describe("SecretManagerTokenStore", () => {
  it("loads a token record via GET .../versions/latest:access and decodes base64 payload", async () => {
    const record: TokenRecord = {
      principalId: "users/alice",
      accessToken: "access-1",
      refreshToken: "refresh-1",
    };
    const { fetch, requests } = makeFakeFetch((request) => {
      expect(request.url).toBe(
        "https://secretmanager.googleapis.com/v1/projects/my-project/secrets/chat-token-users-alice/versions/latest:access",
      );
      expect(request.method).toBe("GET");
      expect(request.authorization).toBe("Bearer lease-token-1");
      return jsonResponse(200, {
        name: "projects/my-project/secrets/chat-token-users-alice/versions/1",
        payload: { data: base64Json(record) },
      });
    });

    const store = new SecretManagerTokenStore({
      projectId: "my-project",
      fetch,
      getAccessToken: async () => fixedLease,
    });

    const loaded = await store.load("users/alice");
    expect(loaded).toEqual(record);
    expect(requests).toHaveLength(1);
  });

  it("returns null on 404 when loading", async () => {
    const { fetch } = makeFakeFetch(() => jsonResponse(404, { error: { code: 404 } }));
    const store = new SecretManagerTokenStore({
      projectId: "my-project",
      fetch,
      getAccessToken: async () => fixedLease,
    });

    expect(await store.load("users/missing")).toBeNull();
  });

  it("saves via addVersion using the lease token for auth and base64-encoded payload", async () => {
    const { fetch, requests } = makeFakeFetch((request) => {
      expect(request.authorization).toBe("Bearer lease-token-1");
      expect(request.method).toBe("POST");
      expect(request.url).toBe(
        "https://secretmanager.googleapis.com/v1/projects/my-project/secrets/chat-token-users-alice:addVersion",
      );
      const body = JSON.parse(request.body ?? "{}");
      const decoded = JSON.parse(Buffer.from(body.payload.data, "base64").toString("utf8"));
      expect(decoded).toEqual({ principalId: "users/alice", accessToken: "access-1" });
      return jsonResponse(200, { name: "projects/my-project/secrets/chat-token-users-alice/versions/2" });
    });

    const store = new SecretManagerTokenStore({
      projectId: "my-project",
      fetch,
      getAccessToken: async () => fixedLease,
    });

    await store.save({ principalId: "users/alice", accessToken: "access-1" });
    expect(requests).toHaveLength(1);
  });

  it("creates the secret then retries addVersion when addVersion first 404s", async () => {
    const { fetch, requests } = makeFakeFetch((request) => {
      if (requests.length === 1) {
        expect(request.method).toBe("POST");
        expect(request.url).toBe(
          "https://secretmanager.googleapis.com/v1/projects/my-project/secrets/chat-token-users-alice:addVersion",
        );
        return jsonResponse(404, { error: { code: 404 } });
      }
      if (requests.length === 2) {
        expect(request.method).toBe("POST");
        expect(request.url).toBe(
          "https://secretmanager.googleapis.com/v1/projects/my-project/secrets?secretId=chat-token-users-alice",
        );
        const body = JSON.parse(request.body ?? "{}");
        expect(body).toEqual({
          replication: { automatic: {} },
          labels: { principal: "users-alice" },
        });
        return jsonResponse(200, { name: "projects/my-project/secrets/chat-token-users-alice" });
      }
      expect(request.method).toBe("POST");
      expect(request.url).toBe(
        "https://secretmanager.googleapis.com/v1/projects/my-project/secrets/chat-token-users-alice:addVersion",
      );
      return jsonResponse(200, { name: "projects/my-project/secrets/chat-token-users-alice/versions/1" });
    });

    const store = new SecretManagerTokenStore({
      projectId: "my-project",
      fetch,
      getAccessToken: async () => fixedLease,
    });

    await store.save({ principalId: "users/alice", accessToken: "access-1" });
    expect(requests).toHaveLength(3);
  });

  it("deletes the secret", async () => {
    const { fetch, requests } = makeFakeFetch((request) => {
      expect(request.method).toBe("DELETE");
      expect(request.url).toBe(
        "https://secretmanager.googleapis.com/v1/projects/my-project/secrets/chat-token-users-alice",
      );
      return jsonResponse(200, {});
    });

    const store = new SecretManagerTokenStore({
      projectId: "my-project",
      fetch,
      getAccessToken: async () => fixedLease,
    });

    await store.delete("users/alice");
    expect(requests).toHaveLength(1);
  });

  it("lists principal ids handling pageToken pagination", async () => {
    const { fetch, requests } = makeFakeFetch((request) => {
      expect(request.method).toBe("GET");
      if (!request.url.includes("pageToken")) {
        expect(request.url).toBe(
          "https://secretmanager.googleapis.com/v1/projects/my-project/secrets?filter=name%3Achat-token-",
        );
        return jsonResponse(200, {
          secrets: [
            { name: "projects/my-project/secrets/chat-token-users-alice" },
            { name: "projects/my-project/secrets/chat-token-users-bob" },
          ],
          nextPageToken: "page-2",
        });
      }
      expect(request.url).toBe(
        "https://secretmanager.googleapis.com/v1/projects/my-project/secrets?filter=name%3Achat-token-&pageToken=page-2",
      );
      return jsonResponse(200, {
        secrets: [{ name: "projects/my-project/secrets/chat-token-users-carol" }],
      });
    });

    const store = new SecretManagerTokenStore({
      projectId: "my-project",
      fetch,
      getAccessToken: async () => fixedLease,
    });

    const principals = await store.list();
    expect(principals.sort()).toEqual(["users-alice", "users-bob", "users-carol"]);
    expect(requests).toHaveLength(2);
  });

  it("throws a status-only error with no body contents on non-OK, non-404 responses", async () => {
    const { fetch } = makeFakeFetch(() =>
      jsonResponse(500, { error: { message: "super secret token leaked in error" } }),
    );
    const store = new SecretManagerTokenStore({
      projectId: "my-project",
      fetch,
      getAccessToken: async () => fixedLease,
    });

    await expect(store.save({ principalId: "users/alice", accessToken: "a" })).rejects.toThrow(
      "Secret Manager POST 500 for chat-token-users-alice",
    );
    await expect(
      store.save({ principalId: "users/alice", accessToken: "a" }),
    ).rejects.not.toThrow(/leaked/);
  });

  it("throws TypeError when fetch or getAccessToken are missing", () => {
    expect(
      () =>
        new SecretManagerTokenStore({
          projectId: "my-project",
          // @ts-expect-error intentionally omitting fetch
          fetch: undefined,
          getAccessToken: async () => fixedLease,
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new SecretManagerTokenStore({
          projectId: "my-project",
          fetch: async () => jsonResponse(200, {}),
          // @ts-expect-error intentionally omitting getAccessToken
          getAccessToken: undefined,
        }),
    ).toThrow(TypeError);
  });
});

describe("getAccessTokenFromStore", () => {
  it("returns the cached lease when the token is fresh and forceRefresh is false", async () => {
    const store = new InMemoryTokenStore();
    const nowMs = Date.parse("2026-07-06T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    await store.save({
      principalId: "users/alice",
      accessToken: "still-fresh",
      expiresAt: new Date(nowMs + 10 * 60 * 1000).toISOString(),
      tokenType: "Bearer",
    });

    const refresh = vi.fn();
    const getAccessToken = getAccessTokenFromStore({
      store,
      principalId: "users/alice",
      refresh,
    });

    const lease = await getAccessToken({ forceRefresh: false });
    expect(lease).toEqual({ accessToken: "still-fresh", refreshed: false, tokenType: "Bearer" });
    expect(refresh).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("treats a record with no expiresAt as fresh when an accessToken is present", async () => {
    const store = new InMemoryTokenStore();
    await store.save({ principalId: "users/alice", accessToken: "no-expiry-token" });

    const refresh = vi.fn();
    const getAccessToken = getAccessTokenFromStore({ store, principalId: "users/alice", refresh });

    const lease = await getAccessToken({ forceRefresh: false });
    expect(lease).toEqual({ accessToken: "no-expiry-token", refreshed: false, tokenType: undefined });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes when the token has expired, saving the new record back to the store", async () => {
    const store = new InMemoryTokenStore();
    const nowMs = Date.parse("2026-07-06T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    await store.save({
      principalId: "users/alice",
      accessToken: "expired-token",
      expiresAt: new Date(nowMs - 1_000).toISOString(),
      tokenType: "Bearer",
    });

    const refresh = vi.fn(async (record: TokenRecord) => ({
      ...record,
      accessToken: "refreshed-token",
      expiresAt: new Date(nowMs + 3_600_000).toISOString(),
    }));
    const getAccessToken = getAccessTokenFromStore({ store, principalId: "users/alice", refresh });

    const lease = await getAccessToken({ forceRefresh: false });
    expect(lease).toEqual({ accessToken: "refreshed-token", refreshed: true, tokenType: "Bearer" });
    expect(refresh).toHaveBeenCalledTimes(1);

    const saved = await store.load("users/alice");
    expect(saved?.accessToken).toBe("refreshed-token");
    vi.restoreAllMocks();
  });

  it("refreshes within the 60s freshness margin even though the token has not technically expired", async () => {
    const store = new InMemoryTokenStore();
    const nowMs = Date.parse("2026-07-06T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    await store.save({
      principalId: "users/alice",
      accessToken: "about-to-expire",
      expiresAt: new Date(nowMs + 30_000).toISOString(),
    });

    const refresh = vi.fn(async (record: TokenRecord) => ({
      ...record,
      accessToken: "refreshed-token",
      expiresAt: new Date(nowMs + 3_600_000).toISOString(),
    }));
    const getAccessToken = getAccessTokenFromStore({ store, principalId: "users/alice", refresh });

    const lease = await getAccessToken({ forceRefresh: false });
    expect(lease.refreshed).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("forces a refresh when forceRefresh is true even if the token is fresh", async () => {
    const store = new InMemoryTokenStore();
    const nowMs = Date.parse("2026-07-06T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    await store.save({
      principalId: "users/alice",
      accessToken: "still-fresh",
      expiresAt: new Date(nowMs + 10 * 60 * 1000).toISOString(),
    });

    const refresh = vi.fn(async (record: TokenRecord) => ({
      ...record,
      accessToken: "force-refreshed-token",
    }));
    const getAccessToken = getAccessTokenFromStore({ store, principalId: "users/alice", refresh });

    const lease = await getAccessToken({ forceRefresh: true });
    expect(lease).toEqual({ accessToken: "force-refreshed-token", refreshed: true, tokenType: undefined });
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("throws when no record exists for the principal", async () => {
    const store = new InMemoryTokenStore();
    const getAccessToken = getAccessTokenFromStore({
      store,
      principalId: "users/missing",
      refresh: vi.fn(),
    });

    await expect(getAccessToken({ forceRefresh: false })).rejects.toThrow(
      "No token record found for principal users/missing.",
    );
  });

  it("throws TypeError when required options are missing", () => {
    expect(() =>
      getAccessTokenFromStore({
        // @ts-expect-error intentionally omitting store
        store: undefined,
        principalId: "users/alice",
        refresh: vi.fn(),
      }),
    ).toThrow(TypeError);
    expect(() =>
      getAccessTokenFromStore({
        store: new InMemoryTokenStore(),
        principalId: "",
        refresh: vi.fn(),
      }),
    ).toThrow(TypeError);
    expect(() =>
      getAccessTokenFromStore({
        store: new InMemoryTokenStore(),
        principalId: "users/alice",
        // @ts-expect-error intentionally omitting refresh
        refresh: undefined,
      }),
    ).toThrow(TypeError);
  });
});
