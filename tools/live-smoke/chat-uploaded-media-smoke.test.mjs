import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildMultipartRelatedBody,
  buildUploadedMediaSmokePlan,
  loadUploadedMediaSmokeConfig,
  runUploadedMediaSmoke,
} from "./chat-uploaded-media-smoke.mjs";

const SMOKE_SPACE_PREFIX = "Google Chat AI SDK Smoke";
const SYNTHETIC_BODY = "fresh synthetic uploaded media body";

async function writeMetadata(t, overrides = {}) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "chat-uploaded-media-smoke-test-"),
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
    RUN_LIVE_CHAT_UPLOADED_MEDIA_SMOKE: "1",
    GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
    GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
    GOOGLE_CHAT_UPLOADED_MEDIA_SMOKE_RUN_ID: "uploaded-media-test",
    GOOGLE_CHAT_UPLOADED_MEDIA_START_TIME: "2026-07-01T00:00:00Z",
    GOOGLE_CHAT_UPLOADED_MEDIA_END_TIME: "2026-07-02T00:00:00Z",
    GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS: "/tmp/oauth-client.json",
    GOOGLE_CHAT_USER_TOKEN_STORE: "/tmp/user-token.json",
    GOOGLE_CHAT_AI_W7_MEDIA_READY: "1",
    GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA: "1",
    GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA_UPLOAD: "1",
    ...overrides,
  };
}

function fakeSdk() {
  return {
    createUploadPlan(input, options = {}) {
      const reasons = [];
      if (options.env?.GOOGLE_CHAT_AI_W7_MEDIA_READY !== "1") {
        reasons.push("w7_not_complete");
      }
      if (options.env?.GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA !== "1") {
        reasons.push("env_flag_missing");
      }
      return {
        kind: "upload",
        status: "dry_run",
        canExecuteLive: reasons.length === 0,
        liveGate: {
          allowed: reasons.length === 0,
          reasons,
        },
        safeFilename: input.filename,
        auth: {
          scopes: ["https://www.googleapis.com/auth/chat.messages.create"],
        },
      };
    },
    normalizeAttachment(raw, options = {}) {
      return {
        name: raw.name,
        contentName: raw.contentName ?? null,
        safeFilename: "fresh-upload.txt",
        contentType: raw.contentType ?? null,
        mediaKind: "text",
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
          maxUploadBytes: options.policy?.maxUploadBytes ?? 1024,
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
      const reasons = [];
      if (options.env?.GOOGLE_CHAT_AI_W7_MEDIA_READY !== "1") {
        reasons.push("w7_not_complete");
      }
      if (options.env?.GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA !== "1") {
        reasons.push("env_flag_missing");
      }
      return {
        kind: "download",
        status: attachment.mediaResourceName ? "dry_run" : "blocked",
        canExecuteLive: Boolean(attachment.mediaResourceName) && reasons.length === 0,
        liveGate: {
          allowed: reasons.length === 0,
          reasons,
        },
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
          text: `System Note: The user attached ${attachment.safeFilename} (${attachment.contentType}). Extraction status: ${attachment.processing.extraction.status}.`,
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

function uploadedAttachment() {
  return {
    attachmentDataRef: {
      attachmentUploadToken: "private-upload-token",
    },
  };
}

function createdMessage() {
  return {
    name: "spaces/AAAA-smoke/messages/private-message-id",
    text: "this raw created message text must not be saved",
    createTime: "2026-07-01T10:00:00Z",
    thread: { name: "spaces/AAAA-smoke/threads/thread-1" },
    attachment: [
      {
        name: "spaces/AAAA-smoke/messages/private-message-id/attachments/fresh-upload",
        contentName: "fresh-upload.txt",
        contentType: "text/plain",
        contentSize: SYNTHETIC_BODY.length,
        source: "UPLOADED_CONTENT",
        attachmentDataRef: {
          resourceName:
            "spaces/AAAA-smoke/messages/private-message-id/attachments/fresh-upload/media",
        },
      },
    ],
  };
}

function fakeClient() {
  const calls = [];
  return {
    calls,
    async uploadAttachment(input) {
      calls.push({ kind: "upload", input });
      return {
        ok: true,
        status: 200,
        refreshed: false,
        replayedAfter401: false,
        json: uploadedAttachment(),
      };
    },
    async createMessage(body) {
      calls.push({ kind: "create", body });
      return {
        ok: true,
        status: 200,
        refreshed: false,
        replayedAfter401: false,
        json: createdMessage(),
      };
    },
    async listMessages(query) {
      calls.push({ kind: "list", query });
      return {
        ok: true,
        status: 200,
        refreshed: true,
        replayedAfter401: false,
        json: {
          messages: [createdMessage()],
        },
      };
    },
    async downloadMedia(url) {
      calls.push({ kind: "download", url });
      return {
        ok: true,
        status: 200,
        refreshed: false,
        replayedAfter401: false,
        contentType: "text/plain; charset=utf-8",
        bytes: new TextEncoder().encode(SYNTHETIC_BODY),
      };
    },
  };
}

test("loadUploadedMediaSmokeConfig refuses to run without explicit guard", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadUploadedMediaSmokeConfig({
        argv: ["node", "chat-uploaded-media-smoke.mjs", "--dry-run"],
        env: {
          GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
          GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
        },
      }),
    /RUN_LIVE_CHAT_UPLOADED_MEDIA_SMOKE=1/,
  );
});

test("dry-run plan records upload, create, discovery, and download gates", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadUploadedMediaSmokeConfig({
    argv: [
      "node",
      "chat-uploaded-media-smoke.mjs",
      "--dry-run",
      "--filename=fresh-upload.txt",
      "--synthetic-text",
      SYNTHETIC_BODY,
    ],
    env: smokeEnv(metadataPath),
  });
  const plan = buildUploadedMediaSmokePlan(config);

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.calls[0].operation, "media.upload");
  assert.equal(plan.calls[0].writes, true);
  assert.deepEqual(plan.calls[0].requiredScopes, [
    "https://www.googleapis.com/auth/chat.messages.create",
  ]);
  assert.equal(plan.calls[1].operation, "spaces.messages.create");
  assert.equal(plan.calls[1].writes, true);
  assert.equal(plan.calls[2].operation, "spaces.messages.list");
  assert.equal(plan.calls[2].writes, false);
  assert.equal(plan.calls[3].operation, "media.download");
  assert.deepEqual(plan.calls[3].requiredScopes, [
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/chat.messages.readonly",
  ]);
});

test("buildMultipartRelatedBody includes upload metadata and bytes", () => {
  const multipart = buildMultipartRelatedBody({
    filename: "fresh-upload.txt",
    contentType: "text/plain",
    bytes: new TextEncoder().encode(SYNTHETIC_BODY),
    boundary: "boundary-test",
  });
  const body = multipart.body.toString("utf8");

  assert.equal(multipart.contentType, "multipart/related; boundary=boundary-test");
  assert.match(body, /Content-Type: application\/json/);
  assert.match(body, /"filename":"fresh-upload.txt"/);
  assert.match(body, /Content-Type: text\/plain/);
  assert.match(body, new RegExp(SYNTHETIC_BODY));
  assert.match(body, /--boundary-test--/);
});

test("runUploadedMediaSmoke uploads, creates, lists, downloads, and redacts evidence", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadUploadedMediaSmokeConfig({
    argv: [
      "node",
      "chat-uploaded-media-smoke.mjs",
      "--filename=fresh-upload.txt",
      "--synthetic-text",
      SYNTHETIC_BODY,
    ],
    env: smokeEnv(metadataPath),
  });
  const client = fakeClient();
  const result = await runUploadedMediaSmoke(config, {
    client,
    sdk: fakeSdk(),
    writeEvidence: false,
  });
  const serialized = JSON.stringify(result.evidence);

  assert.equal(result.ok, true);
  assert.deepEqual(
    client.calls.map((call) => call.kind),
    ["upload", "create", "list", "download"],
  );
  assert.equal(result.evidence.assertions.createdMessageListed, true);
  assert.equal(result.evidence.assertions.freshAttachmentFound, true);
  assert.equal(result.evidence.assertions.downloadedSha256MatchesUpload, true);
  assert.equal(result.evidence.assertions.extractionStatus, "complete");
  assert.equal(result.evidence.assertions.contextIncludesMetadataNote, true);
  assert.equal(result.evidence.assertions.contextIncludesAttachmentContent, true);
  assert.equal(serialized.includes(SYNTHETIC_BODY), false);
  assert.equal(serialized.includes("fresh-upload.txt"), false);
  assert.equal(serialized.includes("this raw created message text must not be saved"), false);
  assert.equal(serialized.includes("private-upload-token"), false);
});

test("runUploadedMediaSmoke refuses live writes when upload gate is missing", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadUploadedMediaSmokeConfig({
    argv: [
      "node",
      "chat-uploaded-media-smoke.mjs",
      "--filename=fresh-upload.txt",
      "--synthetic-text",
      SYNTHETIC_BODY,
    ],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA_UPLOAD: undefined,
    }),
  });
  const client = fakeClient();

  await assert.rejects(
    () =>
      runUploadedMediaSmoke(config, {
        client,
        sdk: fakeSdk(),
        writeEvidence: false,
      }),
    /upload_write_gate_missing/,
  );
  assert.equal(client.calls.length, 0);
});
