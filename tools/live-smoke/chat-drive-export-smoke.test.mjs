import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDriveExportSmokePlan,
  loadDriveExportSmokeConfig,
  runDriveExportSmoke,
} from "./chat-drive-export-smoke.mjs";

const SMOKE_SPACE_PREFIX = "Google Chat AI SDK Smoke";

async function writeMetadata(t, overrides = {}) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "chat-drive-export-smoke-test-"),
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
    RUN_LIVE_CHAT_DRIVE_EXPORT_SMOKE: "1",
    GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
    GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
    GOOGLE_CHAT_DRIVE_EXPORT_SMOKE_RUN_ID: "drive-export-test",
    GOOGLE_CHAT_DRIVE_EXPORT_FILE_ID: "private-drive-file-id",
    GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS: "/tmp/oauth-client.json",
    GOOGLE_CHAT_USER_TOKEN_STORE: "/tmp/user-token.json",
    GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE: "1",
    ...overrides,
  };
}

function fakeSdk() {
  return {
    normalizeAttachment(raw, options = {}) {
      const contentType = raw.contentType ?? null;
      return {
        name: raw.name,
        contentName: raw.contentName ?? null,
        safeFilename: "private-drive-doc",
        contentType,
        mediaKind: contentType?.startsWith("text/") ? "text" : "unknown",
        source: raw.source ?? null,
        contentSizeBytes: raw.contentSizeBytes ?? null,
        mediaResourceName: null,
        attachmentDataRef: null,
        driveDataRef: raw.driveDataRef ?? null,
        thumbnailUri: null,
        downloadUri: null,
        context: {
          messageName: options.context?.messageName ?? null,
          relationship: options.context?.relationship ?? "message",
          path: options.context?.path ?? [],
        },
        policy: {
          status: "allowed",
          reasons: [],
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
    createDriveExportPlan(attachment, options = {}) {
      const isWorkspaceFile = attachment.contentType?.startsWith(
        "application/vnd.google-apps.",
      );
      const exportMimeType = isWorkspaceFile
        ? options.exportMimeType ?? "text/plain"
        : null;
      const gate = {
        allowed: options.env?.GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE === "1",
        reasons:
          options.env?.GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE === "1"
            ? []
            : ["env_flag_missing"],
      };
      return {
        kind: "drive_export",
        status: attachment.driveDataRef?.driveFileId ? "dry_run" : "blocked",
        canExecuteLive: Boolean(attachment.driveDataRef?.driveFileId) && gate.allowed,
        liveGate: gate,
        blockedReasons: attachment.driveDataRef?.driveFileId
          ? []
          : ["drive_file_id_missing"],
        contentApi: isWorkspaceFile ? "drive.files.export" : "drive.files.get_media",
        method: "GET",
        url: isWorkspaceFile
          ? `https://www.googleapis.com/drive/v3/files/${attachment.driveDataRef?.driveFileId}/export?mimeType=${encodeURIComponent(exportMimeType)}`
          : `https://www.googleapis.com/drive/v3/files/${attachment.driveDataRef?.driveFileId}?alt=media`,
        driveFileIdAvailable: Boolean(attachment.driveDataRef?.driveFileId),
        sourceContentType: attachment.contentType,
        exportMimeType,
        maxExportBytes: 10485760,
        auth: {
          scopes: ["https://www.googleapis.com/auth/drive.readonly"],
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

function fakeClient(overrides = {}) {
  const calls = [];
  const createdFileId = overrides.createdFileId ?? "created-private-drive-file-id";
  const metadataMimeType =
    overrides.metadataMimeType ?? "application/vnd.google-apps.document";
  const exportBytes =
    overrides.exportBytes ??
    new TextEncoder().encode("private exported document body");
  return {
    calls,
    async createSyntheticFile() {
      calls.push({ kind: "createSyntheticFile" });
      return {
        ok: true,
        status: 200,
        refreshed: false,
        replayedAfter401: false,
        json: {
          id: createdFileId,
          name: "private-created-drive-file",
          mimeType: metadataMimeType,
          size: String(exportBytes.byteLength),
          modifiedTime: "2026-07-01T22:58:00Z",
          trashed: false,
        },
      };
    },
    async getMetadata(fileId) {
      calls.push({ kind: "metadata", fileId });
      return {
        ok: true,
        status: 200,
        refreshed: false,
        replayedAfter401: false,
        json: {
          id: fileId,
          name: "private-drive-doc",
          mimeType: metadataMimeType,
          size: String(exportBytes.byteLength),
          modifiedTime: "2026-07-01T21:58:00Z",
          capabilities: { canDownload: true },
        },
      };
    },
    async exportContent(url) {
      calls.push({ kind: "export", url });
      return {
        ok: true,
        status: 200,
        refreshed: true,
        replayedAfter401: false,
        contentType: overrides.exportContentType ?? "text/plain; charset=utf-8",
        bytes: exportBytes,
      };
    },
    async trashFile(fileId) {
      calls.push({ kind: "trash", fileId });
      return {
        ok: true,
        status: 200,
        refreshed: false,
        replayedAfter401: false,
        json: {
          id: fileId,
          trashed: true,
        },
      };
    },
  };
}

test("loadDriveExportSmokeConfig refuses to run without explicit guard", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadDriveExportSmokeConfig({
        argv: ["node", "chat-drive-export-smoke.mjs", "--dry-run"],
        env: {
          GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
          GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
          GOOGLE_CHAT_DRIVE_EXPORT_FILE_ID: "private-drive-file-id",
        },
      }),
    /RUN_LIVE_CHAT_DRIVE_EXPORT_SMOKE=1/,
  );
});

test("dry-run plan records user-auth Drive calls", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadDriveExportSmokeConfig({
    argv: [
      "node",
      "chat-drive-export-smoke.mjs",
      "--dry-run",
      "--source-content-type=application/vnd.google-apps.document",
      "--export-mime-type=text/plain",
    ],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE: undefined,
    }),
  });
  const plan = buildDriveExportSmokePlan(config);

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.calls[0].writes, false);
  assert.equal(plan.calls[0].authMode, "user");
  assert.deepEqual(plan.calls[1].requiredScopes, [
    "https://www.googleapis.com/auth/drive.readonly",
  ]);
  assert.equal(plan.driveFileIdProvided, true);
  assert.equal(plan.driveFileIdHash.length, 64);
});

test("dry-run plan records synthetic Drive write gates", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadDriveExportSmokeConfig({
    argv: [
      "node",
      "chat-drive-export-smoke.mjs",
      "--dry-run",
      "--create-synthetic=sheet",
      "--synthetic-text=private synthetic sheet body",
    ],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_DRIVE_EXPORT_FILE_ID: undefined,
      GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE_WRITE: undefined,
    }),
  });
  const plan = buildDriveExportSmokePlan(config);

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.driveFileIdProvided, false);
  assert.equal(plan.createSynthetic.kind, "sheet");
  assert.equal(plan.createSynthetic.sourceContentType, "application/vnd.google-apps.spreadsheet");
  assert.equal(plan.createSynthetic.textHash.length, 64);
  assert.deepEqual(
    plan.calls.map((call) => call.operation),
    [
      "drive.files.create.synthetic",
      "drive.files.get.metadata",
      "drive.files.export-or-download",
      "drive.files.update.trash",
    ],
  );
  assert.deepEqual(plan.calls[0].requiredScopes, [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
  ]);
});

test("runDriveExportSmoke exports and parses redacted evidence", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadDriveExportSmokeConfig({
    argv: [
      "node",
      "chat-drive-export-smoke.mjs",
      "--expect-text=exported document",
    ],
    env: smokeEnv(metadataPath),
  });
  const client = fakeClient();
  const result = await runDriveExportSmoke(config, {
    client,
    sdk: fakeSdk(),
    writeEvidence: false,
  });
  const serialized = JSON.stringify(result.evidence);

  assert.equal(result.ok, true);
  assert.equal(result.evidence.assertions.metadataRead, true);
  assert.equal(result.evidence.assertions.exportedBytes, 30);
  assert.equal(result.evidence.assertions.expectedTextFound, true);
  assert.equal(result.evidence.assertions.extractionStatus, "complete");
  assert.equal(result.evidence.assertions.contextIncludesMetadataNote, true);
  assert.equal(client.calls.some((call) => call.kind === "export"), true);
  assert.equal(serialized.includes("private-drive-file-id"), false);
  assert.equal(serialized.includes("private-drive-doc"), false);
  assert.equal(serialized.includes("private exported document body"), false);
  assert.equal(serialized.includes("exported document"), false);
});

test("runDriveExportSmoke creates, downloads, and cleans up synthetic blob files", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadDriveExportSmokeConfig({
    argv: [
      "node",
      "chat-drive-export-smoke.mjs",
      "--create-synthetic=blob-text",
      "--synthetic-text=private synthetic blob body",
    ],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_DRIVE_EXPORT_FILE_ID: undefined,
      GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE_WRITE: "1",
    }),
  });
  const client = fakeClient({
    metadataMimeType: "text/plain",
    exportBytes: new TextEncoder().encode("private synthetic blob body\n"),
  });
  const result = await runDriveExportSmoke(config, {
    client,
    sdk: fakeSdk(),
    writeEvidence: false,
  });
  const serialized = JSON.stringify(result.evidence);

  assert.equal(result.ok, true);
  assert.equal(result.evidence.drive.attachment.driveExportPlan.contentApi, "drive.files.get_media");
  assert.equal(result.evidence.assertions.expectedTextFound, true);
  assert.equal(result.evidence.drive.synthetic.cleanup.trashed, true);
  assert.deepEqual(
    client.calls.map((call) => call.kind),
    ["createSyntheticFile", "metadata", "export", "trash"],
  );
  assert.equal(serialized.includes("created-private-drive-file-id"), false);
  assert.equal(serialized.includes("private synthetic blob body"), false);
});

test("runDriveExportSmoke refuses synthetic creation when write gate is missing", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadDriveExportSmokeConfig({
    argv: [
      "node",
      "chat-drive-export-smoke.mjs",
      "--create-synthetic=blob-text",
    ],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_DRIVE_EXPORT_FILE_ID: undefined,
      GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE_WRITE: undefined,
    }),
  });
  const client = fakeClient({ metadataMimeType: "text/plain" });

  await assert.rejects(
    () =>
      runDriveExportSmoke(config, {
        client,
        sdk: fakeSdk(),
        writeEvidence: false,
      }),
    /GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE_WRITE=1/,
  );
  assert.equal(client.calls.length, 0);
});

test("runDriveExportSmoke refuses live export when Drive gate is missing", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadDriveExportSmokeConfig({
    argv: ["node", "chat-drive-export-smoke.mjs"],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE: undefined,
    }),
  });
  const client = fakeClient();

  await assert.rejects(
    () =>
      runDriveExportSmoke(config, {
        client,
        sdk: fakeSdk(),
        writeEvidence: false,
      }),
    /Live Drive export gates are not satisfied/,
  );
  assert.equal(client.calls.some((call) => call.kind === "export"), false);
});

test("runDriveExportSmoke fails when expected exported text is absent", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadDriveExportSmokeConfig({
    argv: [
      "node",
      "chat-drive-export-smoke.mjs",
      "--expect-text=not present",
    ],
    env: smokeEnv(metadataPath),
  });

  await assert.rejects(
    () =>
      runDriveExportSmoke(config, {
        client: fakeClient(),
        sdk: fakeSdk(),
        writeEvidence: false,
      }),
    /expected_text_missing/,
  );
});
