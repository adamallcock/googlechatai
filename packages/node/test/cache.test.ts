import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  FileArtifactCache,
  InMemoryArtifactCache,
  buildArtifactCacheKey,
  buildNegativeCacheEntry,
  hashBytes,
} from "../src/index.js";

describe("artifact cache helpers", () => {
  it("builds stable cache keys for bytes, parsers, providers, and options", () => {
    const bytes = new TextEncoder().encode("hello");

    expect(hashBytes(bytes)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(
      buildArtifactCacheKey({
        namespace: "transcription",
        sourceId: "spaces/AAA/messages/one/attachments/audio",
        bytes,
        processor: {
          name: "openai",
          version: "gpt-4o-transcribe",
          options: { language: "en" },
        },
      }),
    ).toEqual({
      namespace: "transcription",
      key: "transcription:efca25bff89fe5098d67c3f65f71a1d8a9e6334203f3d1f7df3cc154e5d8ebe7",
      contentSha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      processorHash:
        "640f3cd1034aa40b1b633626f8529deaba96cdca1cd9fa4470deaa8def8d751b",
      sizeBytes: 5,
    });
  });

  it("stores metadata and bytes in memory and on disk", async () => {
    const memory = new InMemoryArtifactCache();
    const key = buildArtifactCacheKey({
      namespace: "attachment",
      sourceId: "spaces/AAA/messages/one/attachments/report",
      bytes: "report text",
    });

    await memory.put({
      key: key.key,
      bytes: "report text",
      metadata: {
        contentType: "text/plain",
        sourceId: "spaces/AAA/messages/one/attachments/report",
      },
      nowMs: 1_000,
      ttlMs: 60_000,
    });
    await expect(memory.get(key.key, { nowMs: 2_000 })).resolves.toMatchObject({
      hit: true,
      metadata: { contentType: "text/plain" },
      text: "report text",
    });

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-artifact-cache-"));
    try {
      const disk = new FileArtifactCache({ directory: dir });
      await disk.put({
        key: key.key,
        bytes: "report text",
        metadata: { contentType: "text/plain" },
        nowMs: 1_000,
        ttlMs: 60_000,
      });

      await expect(
        new FileArtifactCache({ directory: dir }).get(key.key, { nowMs: 2_000 }),
      ).resolves.toMatchObject({
        hit: true,
        metadata: { contentType: "text/plain" },
        text: "report text",
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("stores negative cache entries for inaccessible resources", async () => {
    const cache = new InMemoryArtifactCache();
    const negative = buildNegativeCacheEntry({
      key: "identity:users/999",
      reason: "permission_denied",
      sourceId: "users/999",
      nowMs: 1_000,
      ttlMs: 5_000,
    });

    await cache.putNegative(negative);

    await expect(cache.get("identity:users/999", { nowMs: 2_000 })).resolves.toEqual({
      hit: true,
      negative: true,
      key: "identity:users/999",
      reason: "permission_denied",
      sourceId: "users/999",
      createdAt: "1970-01-01T00:00:01.000Z",
      expiresAt: "1970-01-01T00:00:06.000Z",
    });
    await expect(cache.get("identity:users/999", { nowMs: 7_000 })).resolves.toEqual({
      hit: false,
      key: "identity:users/999",
      reason: "expired",
    });
  });
});
