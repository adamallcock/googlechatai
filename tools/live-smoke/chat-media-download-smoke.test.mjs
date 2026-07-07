import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildMediaDownloadPlan,
  loadMediaDownloadSmokeConfig,
  runMediaDownloadSmoke,
} from "./chat-media-download-smoke.mjs";

const SMOKE_SPACE_PREFIX = "Google Chat AI SDK Smoke";

async function writeMetadata(t, overrides = {}) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "chat-media-download-smoke-test-"),
  );
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
  await fs.writeFile(file, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return file;
}

function smokeEnv(metadataPath, overrides = {}) {
  return {
    RUN_LIVE_CHAT_MEDIA_DOWNLOAD_SMOKE: "1",
    GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
    GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
    GOOGLE_CHAT_MEDIA_DOWNLOAD_SMOKE_RUN_ID: "media-download-test",
    GOOGLE_CHAT_MEDIA_DOWNLOAD_START_TIME: "2026-07-01T00:00:00Z",
    GOOGLE_CHAT_MEDIA_DOWNLOAD_END_TIME: "2026-07-02T00:00:00Z",
    GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS: "/tmp/oauth-client.json",
    GOOGLE_CHAT_USER_TOKEN_STORE: "/tmp/user-token.json",
    GOOGLE_CHAT_AI_W7_MEDIA_READY: "1",
    GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA: "1",
    ...overrides,
  };
}

function fakeSdk() {
  return {
    normalizeAttachment(raw, options = {}) {
      return {
        name: raw.name,
        contentName: raw.contentName ?? null,
        safeFilename: "private-note.txt",
        contentType: raw.contentType ?? null,
        mediaKind: raw.contentType === "application/json" ? "json" : "text",
        source: raw.source ?? null,
        contentSizeBytes: raw.contentSize ?? null,
        mediaResourceName: raw.attachmentDataRef?.resourceName ?? null,
        attachmentDataRef: raw.attachmentDataRef ?? null,
        driveDataRef: null,
        thumbnailUri: null,
        downloadUri: null,
        context: {
          messageName: options.context?.messageName ?? null,
          relationship: options.context?.relationship ?? "message",
          path: options.context?.path ?? [],
        },
        policy: {
          status: raw.attachmentDataRef?.resourceName ? "allowed" : "blocked",
          reasons: raw.attachmentDataRef?.resourceName ? [] : ["media_resource_missing"],
          maxDownloadBytes: options.policy?.maxDownloadBytes ?? 1024,
          maxUploadBytes: 209715200,
        },
        processing: {
          extraction: {
            status: "skipped",
            parser: null,
            text: null,
            reason: "No parser has run.",
          },
          transcription: {
            status: "skipped",
            provider: null,
            text: null,
            reason: "Attachment is not audio.",
          },
        },
      };
    },
    createDownloadPlan(attachment, options = {}) {
      const gate = {
        allowed:
          options.env?.GOOGLE_CHAT_AI_W7_MEDIA_READY === "1" &&
          options.env?.GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA === "1",
        reasons: [],
      };
      if (options.env?.GOOGLE_CHAT_AI_W7_MEDIA_READY !== "1") {
        gate.reasons.push("w7_not_complete");
      }
      if (options.env?.GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA !== "1") {
        gate.reasons.push("env_flag_missing");
      }
      return {
        kind: "download",
        status: attachment.mediaResourceName ? "dry_run" : "blocked",
        canExecuteLive: Boolean(attachment.mediaResourceName) && gate.allowed,
        liveGate: gate,
        blockedReasons: attachment.mediaResourceName ? [] : ["media_resource_missing"],
        url: `https://chat.googleapis.com/v1/media/${attachment.mediaResourceName}?alt=media`,
        auth: {
          scopes: ["https://www.googleapis.com/auth/chat.messages.readonly"],
        },
      };
    },
    async parseAttachmentContent(attachment, data, options = {}) {
      const result = await options.parsers.text({ attachment, data });
      return {
        ...attachment,
        processing: {
          ...attachment.processing,
          extraction: {
            status: result.status,
            parser: result.parser,
            text: result.text,
            reason: result.reason,
          },
        },
      };
    },
    renderAttachmentContextParts(attachment) {
      return [
        {
          type: "system_note",
          text: `System Note: The user attached ${attachment.safeFilename} (${attachment.contentType}, ${attachment.contentSizeBytes} bytes). Extraction status: ${attachment.processing.extraction.status}.`,
        },
        {
          type: "attachment_content",
          status: attachment.processing.extraction.status,
          text: attachment.processing.extraction.text,
          note: attachment.processing.extraction.reason,
        },
      ];
    },
  };
}

function fakeClient() {
  const calls = [];
  return {
    calls,
    async listMessages(query) {
      calls.push({ kind: "list", query });
      return {
        ok: true,
        status: 200,
        refreshed: false,
        replayedAfter401: false,
        json: {
          messages: [
            {
              name: "spaces/AAAA-smoke/messages/secret-message",
              text: "this raw message text must not be saved",
              createTime: "2026-07-01T10:00:00Z",
              thread: { name: "spaces/AAAA-smoke/threads/thread-1" },
              attachment: [
                {
                  name: "spaces/AAAA-smoke/messages/secret-message/attachments/private-note",
                  contentName: "private-note.txt",
                  contentType: "text/plain",
                  contentSize: 27,
                  source: "UPLOADED_CONTENT",
                  attachmentDataRef: {
                    resourceName:
                      "spaces/AAAA-smoke/messages/secret-message/attachments/private-note/media",
                  },
                },
              ],
            },
          ],
        },
      };
    },
    async downloadMedia(url) {
      calls.push({ kind: "download", url });
      return {
        ok: true,
        status: 200,
        refreshed: true,
        replayedAfter401: false,
        contentType: "text/plain; charset=utf-8",
        bytes: new TextEncoder().encode("private downloaded file body"),
      };
    },
  };
}

test("loadMediaDownloadSmokeConfig refuses to run without explicit guard", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadMediaDownloadSmokeConfig({
        argv: ["node", "chat-media-download-smoke.mjs", "--dry-run"],
        env: {
          GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
          GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
        },
      }),
    /RUN_LIVE_CHAT_MEDIA_DOWNLOAD_SMOKE=1/,
  );
});

test("dry-run plan records read-only discovery and gated media download", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadMediaDownloadSmokeConfig({
    argv: [
      "node",
      "chat-media-download-smoke.mjs",
      "--dry-run",
      "--limit=8",
      "--page-size=4",
      "--content-type=text/plain",
    ],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_AI_W7_MEDIA_READY: undefined,
      GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA: undefined,
    }),
  });
  const plan = buildMediaDownloadPlan(config);

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.calls[0].writes, false);
  assert.equal(plan.calls[0].authMode, "user");
  assert.equal(plan.calls[1].operation, "media.download");
  assert.deepEqual(plan.calls[1].requiredScopes, [
    "https://www.googleapis.com/auth/chat.messages.readonly",
  ]);
  assert.equal(plan.discovery.limit, 8);
  assert.equal(plan.discovery.pageSize, 4);
});

test("runMediaDownloadSmoke downloads and parses redacted attachment evidence", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadMediaDownloadSmokeConfig({
    argv: [
      "node",
      "chat-media-download-smoke.mjs",
      "--limit=2",
      "--page-size=1",
      "--filename-contains=private-note",
    ],
    env: smokeEnv(metadataPath),
  });
  const client = fakeClient();
  const result = await runMediaDownloadSmoke(config, {
    client,
    sdk: fakeSdk(),
    writeEvidence: false,
  });
  const serialized = JSON.stringify(result.evidence);

  assert.equal(result.ok, true);
  assert.equal(result.evidence.assertions.attachmentFound, true);
  assert.equal(result.evidence.assertions.downloadedBytes, 28);
  assert.equal(result.evidence.assertions.extractionStatus, "complete");
  assert.equal(result.evidence.assertions.contextIncludesMetadataNote, true);
  assert.equal(result.evidence.assertions.contextIncludesAttachmentContent, true);
  assert.equal(client.calls.some((call) => call.kind === "download"), true);
  assert.equal(serialized.includes("this raw message text must not be saved"), false);
  assert.equal(serialized.includes("private downloaded file body"), false);
  assert.equal(serialized.includes("private-note.txt"), false);
});

test("runMediaDownloadSmoke refuses live download when media gates are missing", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadMediaDownloadSmokeConfig({
    argv: [
      "node",
      "chat-media-download-smoke.mjs",
      "--limit=2",
      "--page-size=1",
    ],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_AI_W7_MEDIA_READY: undefined,
      GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA: undefined,
    }),
  });
  const client = fakeClient();

  await assert.rejects(
    () =>
      runMediaDownloadSmoke(config, {
        client,
        sdk: fakeSdk(),
        writeEvidence: false,
      }),
    /Live media download gates are not satisfied/,
  );
  assert.equal(client.calls.some((call) => call.kind === "download"), false);
});
