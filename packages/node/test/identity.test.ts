import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DIRECTORY_USER_READONLY_SCOPE,
  FileIdentityCache,
  InMemoryIdentityCache,
  buildDirectoryUsersListPlan,
  renderIdentitySystemNote,
  resolveHumanIdentity,
  syncDirectoryUsersToCache,
} from "../src/index.js";

describe("identity directory enrichment", () => {
  it("plans a user-auth Directory API users.list call with domain-public fields", () => {
    expect(buildDirectoryUsersListPlan()).toEqual({
      kind: "directory.users.list",
      method: "GET",
      url: "https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer&projection=BASIC&viewType=domain_public&maxResults=500",
      auth: {
        required: true,
        mode: "user",
        scopes: [DIRECTORY_USER_READONLY_SCOPE],
        notes: [
          "Uses the Admin SDK Directory API surface, but viewType=domain_public only asks for fields visible within the domain.",
          "If the signed-in user or tenant policy cannot grant this scope, identity enrichment should stay unavailable instead of failing Chat handling.",
        ],
      },
      cache: {
        recommendedTtlMs: 24 * 60 * 60 * 1000,
        neverDeleteMissingUsers: true,
      },
    });
  });

  it("caches directory users by id, primary email, and aliases without deleting missing users", async () => {
    const cache = new InMemoryIdentityCache();
    await syncDirectoryUsersToCache(
      [
        {
          id: "123",
          primaryEmail: "ada@example.com",
          name: { fullName: "Ada Lovelace" },
          aliases: ["a.lovelace@example.com"],
        },
        {
          id: "456",
          primaryEmail: "grace@example.com",
          name: { fullName: "Grace Hopper" },
          suspended: true,
        },
      ],
      {
        cache,
        nowMs: 1_000,
        markMissingStale: true,
      },
    );
    await syncDirectoryUsersToCache(
      [
        {
          id: "123",
          primaryEmail: "ada@example.com",
          name: { fullName: "Ada Lovelace" },
        },
      ],
      {
        cache,
        nowMs: 2_000,
        markMissingStale: true,
      },
    );

    expect(await resolveHumanIdentity({ name: "users/123" }, { cache })).toMatchObject({
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      directoryStatus: "active",
      source: "directory_cache",
    });
    expect(
      await resolveHumanIdentity(
        { email: "a.lovelace@example.com" },
        { cache },
      ),
    ).toMatchObject({ displayName: "Ada Lovelace" });
    expect(await resolveHumanIdentity({ name: "users/456" }, { cache })).toMatchObject({
      displayName: "Grace Hopper",
      directoryStatus: "stale",
      stale: true,
    });
  });

  it("persists identity cache entries and renders inaccessible identity notes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-identity-"));
    const filePath = path.join(dir, "identities.json");
    try {
      const cache = new FileIdentityCache({ filePath });
      await syncDirectoryUsersToCache(
        [
          {
            id: "123",
            primaryEmail: "ada@example.com",
            name: { fullName: "Ada Lovelace" },
          },
        ],
        { cache, nowMs: 1_000 },
      );

      const fromDisk = await resolveHumanIdentity(
        { name: "users/123" },
        { cache: new FileIdentityCache({ filePath }) },
      );
      const unresolved = await resolveHumanIdentity(
        { name: "users/999" },
        { cache },
      );

      expect(fromDisk.displayName).toBe("Ada Lovelace");
      expect(unresolved).toMatchObject({
        name: "users/999",
        access: { status: "access_limited", reason: "identity_not_in_cache" },
      });
      expect(renderIdentitySystemNote(unresolved, { role: "sender" })).toBe(
        "System Note: The sender identity users/999 could not be resolved to a human-readable directory user.",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
