import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCleanupPlan,
  discoverCleanupCandidates,
  loadCleanupSmokeConfig,
  runCleanupSmoke,
} from "./chat-cleanup-smoke.mjs";

const SMOKE_SPACE_PREFIX = "Google Chat AI SDK Smoke";
const OLD_TIME = Date.parse("2026-07-01T20:00:00Z");
const NOW = Date.parse("2026-07-01T21:00:00Z");

async function writeMetadata(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-cleanup-meta-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "space.json");
  const metadata = {
    space: "spaces/AAAA-smoke",
    displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
    spaceType: "SPACE",
    safety: {
      dedicatedSmokeSpace: true,
      noDirectMessages: true,
      noRealUsersInvited: true,
    },
    ...overrides,
  };
  await fs.writeFile(file, `${JSON.stringify(metadata, null, 2)}\n`);
  return file;
}

async function writeEvidenceDir(t, files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-cleanup-evidence-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  for (const [name, payload] of Object.entries(files)) {
    await fs.writeFile(
      path.join(dir, name),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  }

  return dir;
}

function env(metadataPath, evidenceDir, overrides = {}) {
  return {
    RUN_LIVE_CHAT_CLEANUP_SMOKE: "1",
    GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
    GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
    GOOGLE_CHAT_CLEANUP_SMOKE_RUN_ID: "cleanup-test",
    ...overrides,
  };
}

async function loadConfig(t, files, argv = ["node", "chat-cleanup-smoke.mjs"]) {
  const metadataPath = await writeMetadata(t);
  const evidenceDir = await writeEvidenceDir(t, files);
  return loadCleanupSmokeConfig({
    argv: [...argv, "--evidence-dir", evidenceDir],
    env: env(metadataPath, evidenceDir),
  });
}

test("loadCleanupSmokeConfig refuses to run without explicit guard", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadCleanupSmokeConfig({
        argv: ["node", "chat-cleanup-smoke.mjs", "--dry-run"],
        env: {
          GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
          GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
        },
      }),
    /RUN_LIVE_CHAT_CLEANUP_SMOKE=1/,
  );
});

test("discoverCleanupCandidates subtracts deleted and recent evidence", async (t) => {
  const config = await loadConfig(
    t,
    {
      "visual.json": {
        runId: "visual-old",
        targetSpace: "spaces/AAAA-smoke",
        finishedAt: "2026-07-01T20:00:00Z",
        resourcesCreated: [
          {
            kind: "message",
            label: "leftover",
            name: "spaces/AAAA-smoke/messages/leftover",
          },
          {
            kind: "message",
            label: "outside",
            name: "spaces/OTHER/messages/outside",
          },
        ],
      },
      "deleted.json": {
        runId: "visual-cleanup",
        targetSpace: "spaces/AAAA-smoke",
        operations: [
          {
            operation: "cleanup.visual.message.delete",
            ok: true,
            resourceName: "spaces/AAAA-smoke/messages/already-deleted",
            finishedAt: "2026-07-01T20:15:00Z",
          },
        ],
        resourcesCreated: [
          {
            kind: "message",
            label: "deleted",
            name: "spaces/AAAA-smoke/messages/already-deleted",
          },
        ],
      },
      "recent.json": {
        runId: "recent",
        targetSpace: "spaces/AAAA-smoke",
        finishedAt: "2026-07-01T20:59:00Z",
        resourcesCreated: [
          {
            kind: "message",
            label: "too-recent",
            name: "spaces/AAAA-smoke/messages/recent",
          },
        ],
      },
    },
    ["node", "chat-cleanup-smoke.mjs", "--dry-run", "--min-age-minutes=15"],
  );
  const discovery = await discoverCleanupCandidates(config, { now: NOW });
  const plan = buildCleanupPlan(config, discovery);

  assert.deepEqual(
    discovery.candidates.map((candidate) => candidate.messageName),
    ["spaces/AAAA-smoke/messages/leftover"],
  );
  assert.equal(
    discovery.ignored.some(
      (candidate) => candidate.reason === "local_delete_evidence_found",
    ),
    true,
  );
  assert.equal(
    discovery.ignored.some((candidate) => candidate.reason === "too_recent"),
    true,
  );
  assert.equal(plan.counts.candidates, 1);
});

test("runCleanupSmoke dry-run writes no live operations", async (t) => {
  const config = await loadConfig(
    t,
    {
      "visual.json": {
        runId: "visual-old",
        targetSpace: "spaces/AAAA-smoke",
        finishedAt: "2026-07-01T20:00:00Z",
        resourcesCreated: [
          {
            kind: "message",
            label: "leftover",
            name: "spaces/AAAA-smoke/messages/leftover",
          },
        ],
      },
    },
    ["node", "chat-cleanup-smoke.mjs", "--dry-run"],
  );
  const result = await runCleanupSmoke(config, {
    writeEvidence: false,
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.mode, "dry-run");
  assert.equal(result.evidence.candidates.length, 1);
  assert.deepEqual(result.evidence.operations, []);
});

test("runCleanupSmoke refuses live deletes without explicit live cleanup gate", async (t) => {
  const config = await loadConfig(t, {
    "visual.json": {
      runId: "visual-old",
      targetSpace: "spaces/AAAA-smoke",
      finishedAt: "2026-07-01T20:00:00Z",
      resourcesCreated: [
        {
          kind: "message",
          label: "leftover",
          name: "spaces/AAAA-smoke/messages/leftover",
        },
      ],
    },
  });

  await assert.rejects(
    () => runCleanupSmoke(config, { writeEvidence: false, now: NOW }),
    /GOOGLE_CHAT_AI_ENABLE_LIVE_CLEANUP=1/,
  );
});

test("runCleanupSmoke deletes only stale candidates in the smoke space", async (t) => {
  const metadataPath = await writeMetadata(t);
  const evidenceDir = await writeEvidenceDir(t, {
    "visual.json": {
      runId: "visual-old",
      targetSpace: "spaces/AAAA-smoke",
      finishedAt: "2026-07-01T20:00:00Z",
      resourcesCreated: [
        {
          kind: "message",
          label: "leftover",
          name: "spaces/AAAA-smoke/messages/leftover",
        },
      ],
    },
  });
  const config = await loadCleanupSmokeConfig({
    argv: ["node", "chat-cleanup-smoke.mjs", "--evidence-dir", evidenceDir],
    env: env(metadataPath, evidenceDir, {
      GOOGLE_CHAT_AI_ENABLE_LIVE_CLEANUP: "1",
    }),
  });
  const calls = [];
  const client = {
    async getSpace(name) {
      calls.push(`spaces.get:${name}`);
      return {
        name,
        displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
        spaceType: "SPACE",
      };
    },
    async deleteMessage(name) {
      calls.push(`messages.delete:${name}`);
      return {};
    },
  };

  const result = await runCleanupSmoke(config, {
    client,
    writeEvidence: false,
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "spaces.get:spaces/AAAA-smoke",
    "messages.delete:spaces/AAAA-smoke/messages/leftover",
  ]);
  assert.equal(result.evidence.operations.at(-1).deleted, true);
});
