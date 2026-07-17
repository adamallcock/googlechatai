import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectAttachmentsFromContext,
  collectDriveLinkCandidates,
  createDriveExportPlan,
  createDriveLinkRetrievalPlan,
  createDownloadPlan,
  createGeminiTranscriptionProvider,
  createOpenAITranscriptionProvider,
  createUploadPlan,
  normalizeAttachment,
  normalizeMessage,
  planAttachmentPipeline,
  parseAttachmentContent,
  renderAttachmentContextParts,
  summarizeTranscriptionEvidence,
  transcribeAudio,
} from "../src/index.js";

const root = path.resolve(import.meta.dirname, "../../..");

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

describe("attachments", () => {
  it("normalizes shared attachment fixtures with safe filenames and recursive context", () => {
    const raw = readJson("fixtures/attachments/context-tree.json");
    const expected = readJson("fixtures/expected/attachments/normalized.context-tree.json");

    expect(collectAttachmentsFromContext(raw)).toEqual(expected);
  });

  it("preserves known zero-byte attachment sizes", () => {
    expect(
      normalizeAttachment({
        name: "spaces/AAA/messages/root/attachments/empty-1",
        contentName: "empty.txt",
        contentType: "text/plain",
        contentSize: 0,
      })?.contentSizeBytes,
    ).toBe(0);
  });

  it("creates download and upload dry-run plans without live media execution", () => {
    const attachments = collectAttachmentsFromContext(
      readJson("fixtures/attachments/context-tree.json"),
    );
    const pdf = attachments[0]!;
    const blocked = attachments[1]!;
    const driveImage = attachments[3]!;

    expect(createDownloadPlan(pdf, { targetDirectory: "/tmp/chat-ai-sdk" })).toEqual({
      kind: "download",
      status: "dry_run",
      dryRun: true,
      canExecuteLive: false,
      liveGate: {
        allowed: false,
        reasons: ["w7_not_complete", "env_flag_missing"],
      },
      attachmentName: "spaces/AAA/messages/root/attachments/pdf-1",
      mediaResourceName: "spaces/AAA/messages/root/attachments/pdf-1/media",
      method: "GET",
      url: "https://chat.googleapis.com/v1/media/spaces/AAA/messages/root/attachments/pdf-1/media?alt=media",
      destinationPath: "/tmp/chat-ai-sdk/Q2_Final_.pdf",
      policy: {
        status: "allowed",
        reasons: [],
      },
      auth: {
        required: true,
        modes: ["app", "user"],
        scopes: [
          "https://www.googleapis.com/auth/chat.bot",
          "https://www.googleapis.com/auth/chat.messages",
          "https://www.googleapis.com/auth/chat.messages.readonly",
        ],
      },
      alternateContentApi: null,
    });

    expect(createDownloadPlan(blocked).status).toBe("blocked");
    expect(createDownloadPlan(driveImage).blockedReasons).toEqual(["drive_api_required"]);
    expect(createDownloadPlan(driveImage).alternateContentApi).toEqual({
      kind: "drive",
      required: true,
      driveFileIdAvailable: true,
      method: "GET",
      reason:
        "Drive-backed Google Chat attachments must be read with the Google Drive API.",
      auth: {
        required: true,
        modes: ["user"],
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      },
    });
    const sourceOnlyDrive = normalizeAttachment({
      name: "spaces/AAA/messages/root/attachments/drive-doc",
      contentName: "roadmap",
      contentType: "application/vnd.google-apps.document",
      source: "DRIVE_FILE",
    })!;
    expect(createDownloadPlan(sourceOnlyDrive).blockedReasons).toEqual([
      "drive_api_required",
    ]);
    expect(createDownloadPlan(sourceOnlyDrive).alternateContentApi).toMatchObject({
      kind: "drive",
      driveFileIdAvailable: false,
      auth: {
        modes: ["user"],
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      },
    });
    expect(
      createDownloadPlan(pdf, {
        env: {
          GOOGLE_CHAT_AI_W7_MEDIA_READY: "1",
          GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA: "1",
        },
      }).canExecuteLive,
    ).toBe(true);

    expect(
      createUploadPlan({
        parent: "spaces/AAA",
        filename: "../assistant summary.txt",
        contentType: "text/plain",
        sizeBytes: 3000,
      }),
    ).toEqual({
      kind: "upload",
      status: "dry_run",
      dryRun: true,
      canExecuteLive: false,
      liveGate: {
        allowed: false,
        reasons: ["w7_not_complete", "env_flag_missing"],
      },
      parent: "spaces/AAA",
      safeFilename: "assistant_summary.txt",
      contentType: "text/plain",
      sizeBytes: 3000,
      method: "POST",
      url: "https://chat.googleapis.com/upload/v1/spaces/AAA/attachments:upload?uploadType=multipart",
      uploadProtocol: "simple",
      maxBytes: 209715200,
      policy: {
        status: "allowed",
        reasons: [],
      },
      auth: {
        required: true,
        mode: "user",
        scopes: [
          "https://www.googleapis.com/auth/chat.messages.create",
          "https://www.googleapis.com/auth/chat.messages",
          "https://www.googleapis.com/auth/chat.import",
        ],
      },
    });
    expect(
      createUploadPlan(
        {
          parent: "spaces/AAA",
          filename: "assistant summary.txt",
          contentType: "text/plain",
          sizeBytes: 3000,
        },
        {
          env: {
            GOOGLE_CHAT_AI_W7_MEDIA_READY: "1",
            GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA: "1",
          },
        },
      ).canExecuteLive,
    ).toBe(true);
  });

  it("creates Drive export plans for Drive-backed attachments", () => {
    const driveDoc = normalizeAttachment({
      name: "spaces/AAA/messages/root/attachments/drive-doc",
      contentName: "roadmap",
      contentType: "application/vnd.google-apps.document",
      source: "DRIVE_FILE",
      driveDataRef: {
        driveFileId: "drive-file-123",
      },
    })!;

    expect(createDriveExportPlan(driveDoc, { targetDirectory: "/tmp/chat-ai-sdk" })).toEqual({
      kind: "drive_export",
      status: "dry_run",
      dryRun: true,
      canExecuteLive: false,
      liveGate: {
        allowed: false,
        reasons: ["env_flag_missing"],
      },
      attachmentName: "spaces/AAA/messages/root/attachments/drive-doc",
      contentApi: "drive.files.export",
      method: "GET",
      url: "https://www.googleapis.com/drive/v3/files/drive-file-123/export?mimeType=text%2Fplain",
      driveFileIdAvailable: true,
      sourceContentType: "application/vnd.google-apps.document",
      exportMimeType: "text/plain",
      destinationPath: "/tmp/chat-ai-sdk/roadmap.txt",
      maxExportBytes: 10485760,
      policy: {
        status: "allowed",
        reasons: [],
      },
      auth: {
        required: true,
        mode: "user",
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      },
    });

    expect(
      createDriveExportPlan(driveDoc, {
        env: { GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE: "1" },
      }).canExecuteLive,
    ).toBe(true);

    const sourceOnlyDrive = normalizeAttachment({
      name: "spaces/AAA/messages/root/attachments/drive-doc",
      contentName: "roadmap",
      contentType: "application/vnd.google-apps.document",
      source: "DRIVE_FILE",
    })!;
    expect(createDriveExportPlan(sourceOnlyDrive).blockedReasons).toEqual([
      "drive_file_id_missing",
    ]);

    const uploaded = normalizeAttachment({
      name: "spaces/AAA/messages/root/attachments/uploaded",
      contentName: "note.txt",
      contentType: "text/plain",
      source: "UPLOADED_CONTENT",
    })!;
    expect(createDriveExportPlan(uploaded).blockedReasons).toEqual([
      "not_drive_backed",
      "drive_file_id_missing",
    ]);
  });

  it("promotes Drive rich links and pasted Drive URLs into retrieval plans", () => {
    const input = readJson("fixtures/attachments/drive-link-retrieval.json") as {
      message: unknown;
    };
    const expected = readJson("fixtures/expected/attachments/drive-link-retrieval.json");

    const candidates = collectDriveLinkCandidates(input.message);
    expect(
      candidates.map((candidate) => ({
        source: candidate.source,
        url: candidate.url,
        title: candidate.title,
        driveFileId: candidate.driveFileId,
        driveFileKind: candidate.driveFileKind,
        retrievable: candidate.retrievable,
        blockedReasons: candidate.blockedReasons,
      })),
    ).toEqual([
      {
        source: "rich_link",
        url: "https://docs.google.com/document/d/doc123/edit",
        title: "Launch Plan",
        driveFileId: "doc123",
        driveFileKind: "document",
        retrievable: true,
        blockedReasons: [],
      },
      {
        source: "matched_url",
        url: "https://docs.google.com/spreadsheets/d/sheet456/edit#gid=0",
        title: null,
        driveFileId: "sheet456",
        driveFileKind: "spreadsheet",
        retrievable: true,
        blockedReasons: [],
      },
      {
        source: "matched_url",
        url: "https://drive.google.com/drive/folders/folder789",
        title: null,
        driveFileId: "folder789",
        driveFileKind: "folder",
        retrievable: false,
        blockedReasons: ["drive_folder_not_file"],
      },
    ]);
    expect(createDriveLinkRetrievalPlan(input)).toEqual(expected);
  });

  it("handles raw annotations, plain link arrays, Drive blob URLs, and cached unavailable links", () => {
    const rawMessage = {
      name: "spaces/AAA/messages/RAW",
      text: "Review https://docs.google.com/presentation/d/slide999/edit",
      annotations: [
        {
          type: "RICH_LINK",
          richLinkMetadata: {
            richLinkType: "DRIVE_FILE",
            uri: "https://docs.google.com/presentation/d/slide999/edit",
            mimeType: "application/vnd.google-apps.presentation",
            driveLinkData: {
              title: "Launch Deck",
            },
          },
        },
      ],
    };

    const rawPlan = createDriveLinkRetrievalPlan({ message: rawMessage });
    expect(rawPlan.links).toHaveLength(1);
    expect(rawPlan.links[0]).toMatchObject({
      candidate: {
        source: "rich_link",
        title: "Launch Deck",
        driveFileId: "slide999",
        driveFileKind: "presentation",
      },
      driveExportPlan: {
        contentApi: "drive.files.export",
        exportMimeType: "text/plain",
        destinationPath: "./Launch_Deck.txt",
      },
      fallback: {
        status: "ready",
        action: "drive_export",
      },
    });

    const linkPlan = createDriveLinkRetrievalPlan({
      links: [
        {
          kind: "plain_url",
          url: "https://drive.google.com/file/d/blob123/view",
        },
        {
          kind: "plain_url",
          url: "https://drive.google.com/open?id=open456",
        },
        {
          kind: "plain_url",
          url: "https://docs.google.com/document/d/doc-denied/edit",
        },
        {
          kind: "plain_url",
          url: "https://docs.google.com/document/u/0/",
        },
      ],
      options: {
        cache: {
          entriesByFileId: {
            "doc-denied": {
              negative: true,
              key: "drive-link:doc-denied",
              reason: "permission_denied",
            },
          },
        },
      },
    });

    expect(
      linkPlan.links.map((item) => ({
        fileId: item.candidate.driveFileId,
        kind: item.candidate.driveFileKind,
        contentApi: item.driveExportPlan?.contentApi ?? null,
        fallback: item.fallback.action,
      })),
    ).toEqual([
      {
        fileId: "blob123",
        kind: "blob",
        contentApi: "drive.files.get_media",
        fallback: "drive_export",
      },
      {
        fileId: "open456",
        kind: "blob",
        contentApi: "drive.files.get_media",
        fallback: "drive_export",
      },
      {
        fileId: "doc-denied",
        kind: "document",
        contentApi: null,
        fallback: "cached_unavailable",
      },
      {
        fileId: null,
        kind: "document",
        contentApi: null,
        fallback: "metadata_only",
      },
    ]);
    expect(linkPlan.links[2]!.cache).toMatchObject({
      status: "negative_hit",
      reason: "permission_denied",
    });
    expect(linkPlan.links[2]!.driveExportPlan).toBeNull();
    expect(linkPlan.counts).toMatchObject({
      candidates: 4,
      driveExports: 2,
      blocked: 2,
      fallbacks: 2,
    });
  });

  it("collects Drive links from context relationships and normalized context nodes", () => {
    const input = readJson("fixtures/attachments/drive-link-context.json");
    const expected = readJson("fixtures/expected/attachments/drive-link-context.json");

    expect(createDriveLinkRetrievalPlan(input)).toEqual(expected);

    const normalized = normalizeMessage({
      name: "spaces/AAA/messages/NORMALIZED",
      text: "Root message",
      quotedMessageMetadata: {
        message: {
          name: "spaces/AAA/messages/NORMALIZED_QUOTE",
          text: "Quoted doc https://docs.google.com/document/d/normalizedQuote123/edit",
        },
      },
    });
    const normalizedPlan = createDriveLinkRetrievalPlan({ message: normalized });
    expect(
      normalizedPlan.links.map((item) => ({
        fileId: item.candidate.driveFileId,
        relationship: item.candidate.context.relationship,
        path: item.candidate.context.path,
      })),
    ).toEqual([
      {
        fileId: "normalizedQuote123",
        relationship: "quoted_message",
        path: [
          "message:spaces/AAA/messages/NORMALIZED",
          "quoted_message:spaces/AAA/messages/NORMALIZED_QUOTE",
        ],
      },
    ]);

    const relationshipWrapperPlan = createDriveLinkRetrievalPlan({
      context: {
        children: [
          {
            relationship: "quoted_message",
            links: [
              {
                kind: "plain_url",
                url: "https://docs.google.com/document/d/wrapperLink123/edit",
              },
            ],
            message: {
              name: "spaces/AAA/messages/WRAPPER",
              text: "Wrapper message",
            },
          },
        ],
      },
    });
    expect(relationshipWrapperPlan.links[0]!.candidate.context).toMatchObject({
      messageName: "spaces/AAA/messages/WRAPPER",
      relationship: "quoted_message",
      path: [
        "message:node-1",
        "quoted_message:spaces/AAA/messages/WRAPPER",
      ],
    });

    const namelessDuplicatePlan = createDriveLinkRetrievalPlan({
      context: {
        message: {
          text: "Root https://docs.google.com/document/d/duplicateDoc123/edit",
        },
        children: [
          {
            relationship: "quoted_message",
            message: {
              text: "Quote https://docs.google.com/document/d/duplicateDoc123/edit",
            },
          },
        ],
      },
    });
    expect(
      namelessDuplicatePlan.links.map((item) => item.candidate.context.path),
    ).toEqual([
      ["message:node-1"],
      ["message:node-1", "quoted_message:node-2"],
    ]);

    const cyclic: Record<string, unknown> = {
      relationship: "quoted_message",
      message: {
        text: "Cycle https://docs.google.com/document/d/cycleDoc123/edit",
      },
    };
    cyclic.children = [cyclic];
    const cyclicPlan = createDriveLinkRetrievalPlan({ context: cyclic });
    expect(cyclicPlan.status).toBe("partial");
    expect(cyclicPlan.links.map((item) => item.candidate.driveFileId)).toEqual([
      "cycleDoc123",
    ]);
    expect(cyclicPlan.traversal).toMatchObject({
      status: "truncated",
      truncatedBranches: 1,
      cappedDriveLinks: 0,
      cappedPlainTextUrls: 0,
    });

    let deep: Record<string, unknown> = {
      message: {
        text: "Deep https://docs.google.com/document/d/deepDoc123/edit",
      },
    };
    for (let index = 0; index < 1_200; index += 1) {
      deep = {
        message: {
          text: "",
        },
        children: [deep],
      };
    }
    const deepPlan = createDriveLinkRetrievalPlan({ context: deep });
    expect(deepPlan.status).toBe("partial");
    expect(deepPlan.links).toHaveLength(0);
    expect(deepPlan.traversal).toMatchObject({
      status: "truncated",
      maxTraversalDepth: 256,
      maxTraversalNodes: 5000,
      maxLinkScanItems: 5000,
      maxDriveLinks: 200,
      maxPlainTextUrls: 200,
      truncatedBranches: 1,
      cappedTraversalNodes: 0,
      cappedLinkScanItems: 0,
      cappedDriveLinks: 0,
      cappedPlainTextUrls: 0,
    });
    expect(deepPlan.systemNotes).toEqual([
      "System Note: Drive link traversal was capped; skipped 1 deep or cyclic branch(es), 0 traversal node(s), 0 link scan item(s), 0 link candidate(s), and 0 plain-text URL(s).",
    ]);
  });

  it("surfaces Drive link and plain-text URL caps in retrieval plans", () => {
    const linkCapPlan = createDriveLinkRetrievalPlan({
      links: [
        {
          kind: "plain_url",
          url: "https://docs.google.com/document/d/capDoc1/edit",
        },
        {
          kind: "plain_url",
          url: "https://docs.google.com/document/d/capDoc2/edit",
        },
        {
          kind: "plain_url",
          url: "https://docs.google.com/document/d/capDoc3/edit",
        },
      ],
      options: {
        maxDriveLinks: 2,
      },
    });
    expect(linkCapPlan.status).toBe("partial");
    expect(linkCapPlan.links.map((item) => item.candidate.driveFileId)).toEqual([
      "capDoc1",
      "capDoc2",
    ]);
    expect(linkCapPlan.traversal).toMatchObject({
      status: "truncated",
      maxDriveLinks: 2,
      cappedDriveLinks: 1,
      cappedPlainTextUrls: 0,
      truncatedBranches: 0,
    });
    expect(linkCapPlan.systemNotes.at(-1)).toBe(
      "System Note: Drive link traversal was capped; skipped 0 deep or cyclic branch(es), 0 traversal node(s), 0 link scan item(s), 1 link candidate(s), and 0 plain-text URL(s).",
    );

    const textCapPlan = createDriveLinkRetrievalPlan({
      message: {
        text:
          "One https://docs.google.com/document/d/textDoc1/edit two https://docs.google.com/document/d/textDoc2/edit",
      },
      options: {
        maxPlainTextUrls: 1,
      },
    });
    expect(textCapPlan.status).toBe("partial");
    expect(textCapPlan.links.map((item) => item.candidate.driveFileId)).toEqual([
      "textDoc1",
    ]);
    expect(textCapPlan.traversal).toMatchObject({
      status: "truncated",
      maxPlainTextUrls: 1,
      cappedDriveLinks: 0,
      cappedPlainTextUrls: 1,
      truncatedBranches: 0,
    });
  });

  it("bounds wide Drive link scans and shallow context traversal", () => {
    const wideLinkPlan = createDriveLinkRetrievalPlan({
      links: Array.from({ length: 5 }, (_, index) => ({
        kind: "plain_url",
        url: `https://docs.google.com/document/d/scanDoc${index}/edit`,
      })),
      options: {
        maxLinkScanItems: 2,
      },
    });
    expect(wideLinkPlan.status).toBe("partial");
    expect(wideLinkPlan.links.map((item) => item.candidate.driveFileId)).toEqual([
      "scanDoc0",
      "scanDoc1",
    ]);
    expect(wideLinkPlan.traversal).toMatchObject({
      status: "truncated",
      maxLinkScanItems: 2,
      cappedLinkScanItems: 3,
      cappedTraversalNodes: 0,
      cappedDriveLinks: 0,
    });

    const wideContextPlan = createDriveLinkRetrievalPlan({
      context: {
        message: {
          name: "spaces/AAA/messages/WIDE_ROOT",
          text: "Root",
        },
        children: Array.from({ length: 4 }, (_, index) => ({
          message: {
            name: `spaces/AAA/messages/WIDE_${index}`,
            text: `Child https://docs.google.com/document/d/wideDoc${index}/edit`,
          },
        })),
      },
      options: {
        maxTraversalNodes: 3,
      },
    });
    expect(wideContextPlan.status).toBe("partial");
    expect(wideContextPlan.links.map((item) => item.candidate.driveFileId)).toEqual([
      "wideDoc0",
    ]);
    expect(wideContextPlan.traversal).toMatchObject({
      status: "truncated",
      maxTraversalNodes: 3,
      cappedTraversalNodes: 3,
      cappedLinkScanItems: 0,
      cappedDriveLinks: 0,
    });
  });

  it("honors Drive link source toggles and blocks published Docs URLs", () => {
    const input = {
      message: {
        name: "spaces/AAA/messages/TOGGLES",
        text: "Plain https://docs.google.com/document/d/plain123/edit",
        links: [
          {
            kind: "matchedUrl",
            url: "https://docs.google.com/spreadsheets/d/matched456/edit",
          },
          {
            kind: "plain_url",
            url: "https://docs.google.com/presentation/d/plainLink789/edit",
          },
          {
            kind: "plain_url",
            url: "https://docs.google.com/document/d/e/PUBLISHED_DOC_ID/pub",
          },
        ],
      },
    };

    expect(
      collectDriveLinkCandidates(input.message, { includeMatchedUrls: false }).map(
        (candidate) => candidate.driveFileId,
      ),
    ).toEqual(["plainLink789", null, "plain123"]);
    expect(
      collectDriveLinkCandidates(input.message, { includePlainTextUrls: false }).map(
        (candidate) => candidate.driveFileId,
      ),
    ).toEqual(["matched456"]);

    const published = createDriveLinkRetrievalPlan(input).links[2]!;
    expect(published).toMatchObject({
      candidate: {
        driveFileId: null,
        retrievable: false,
        blockedReasons: [
          "published_docs_url_unsupported",
          "drive_file_id_missing",
        ],
      },
      driveExportPlan: null,
      fallback: {
        status: "blocked",
        action: "metadata_only",
        reason:
          "Published Docs URLs do not expose a Drive file ID that can be exported by this planner.",
      },
    });

    const edgePlan = createDriveLinkRetrievalPlan({
      links: [
        {
          kind: "plain_url",
          url: "http://[bad",
        },
        {
          kind: "plain_url",
          url: "https://docs.google.com/forms/d/form123/edit",
        },
      ],
    });
    expect(edgePlan.ignoredLinks).toEqual([
      {
        source: "plain_url",
        url: "http://[bad",
        reason: "not_google_drive_url",
        context: {
          messageName: null,
          relationship: "message",
          path: [],
        },
      },
    ]);
    expect(edgePlan.links[0]).toMatchObject({
      candidate: {
        driveFileId: "form123",
        driveFileKind: "unknown",
        retrievable: false,
        blockedReasons: ["unsupported_docs_file_kind"],
      },
      driveExportPlan: null,
      fallback: {
        action: "metadata_only",
        reason: "Drive link points to an unsupported Google Docs editor file kind.",
      },
    });
  });

  it("plans the high-level attachment pipeline across downloads, Drive exports, cache, parsers, transcription, and upload fallbacks", () => {
    const plan = planAttachmentPipeline({
      context: readJson("fixtures/attachments/context-tree.json"),
      uploads: [
        {
          parent: "spaces/AAA",
          filename: "answer.txt",
          contentType: "text/plain",
          sizeBytes: 42,
          sendOptions: { hasAccessoryWidgets: true },
        },
        {
          parent: "spaces/AAA",
          filename: "blocked.exe",
          contentType: "application/x-msdownload",
          sizeBytes: 10,
        },
      ],
      options: {
        targetDirectory: "/tmp/chat-ai-sdk",
        driveExportDirectory: "/tmp/chat-ai-sdk/drive",
        cache: {
          entriesByAttachmentName: {
            "spaces/AAA/messages/root/attachments/pdf-1": {
              hit: true,
              negative: false,
              key: "attachment:pdf-hit",
              metadata: { contentSha256: "pdf-sha" },
            },
          },
        },
        parsers: { pdf: "pdf-parse" },
        transcription: { enabled: false },
      },
    });

    expect(plan.kind).toBe("chat.attachment_pipeline_plan");
    expect(plan.status).toBe("partial");
    expect(plan.counts).toEqual({
      attachments: 4,
      uploads: 2,
      downloads: 2,
      driveExports: 1,
      blocked: 2,
      cacheHits: 1,
      parserReady: 1,
      transcriptionReady: 0,
      fallbacks: 5,
    });

    expect(plan.attachments.map((item) => item.fallback.action)).toEqual([
      "download_chat_media",
      "metadata_only",
      "transcription_disabled",
      "drive_export_required",
    ]);
    expect(plan.attachments[0]!.cache).toMatchObject({
      status: "hit",
      key: "attachment:pdf-hit",
    });
    expect(plan.attachments[0]!.parsePlan).toEqual({
      status: "ready",
      mediaKind: "pdf",
      parser: "pdf-parse",
      reason: null,
    });
    expect(plan.attachments[2]!.transcriptionPlan).toEqual({
      status: "disabled",
      provider: null,
      model: null,
      reason: "Audio transcription is disabled by default.",
    });
    expect(plan.attachments[3]!.driveExportPlan).toMatchObject({
      kind: "drive_export",
      contentApi: "drive.files.get_media",
      destinationPath: "/tmp/chat-ai-sdk/drive/sketch.png",
      auth: {
        mode: "user",
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      },
    });
    expect(plan.uploads.map((item) => item.sendStrategy.kind)).toEqual([
      "separate_attachment_message",
      "drive_link_card_fallback",
    ]);
    expect(plan.systemNotes).toContain(
      "System Note: Upload answer.txt requires a separate attachment message because Google Chat attachment messages cannot include accessory widgets.",
    );
  });

  it("applies caller policy options while collecting attachments from recursive context", () => {
    const plan = planAttachmentPipeline({
      context: readJson("fixtures/attachments/context-tree.json"),
      options: {
        policy: { maxDownloadBytes: 1024 },
      },
    });

    expect(plan.attachments[0]!.attachment.policy).toMatchObject({
      status: "blocked",
      reasons: ["size_exceeds_download_limit"],
    });
    expect(plan.attachments[0]!.fallback).toMatchObject({
      status: "blocked",
      action: "metadata_only",
    });
  });

  it("renders AI attachment notes before extracted or transcribed content status", async () => {
    const [pdf, , audio] = collectAttachmentsFromContext(
      readJson("fixtures/attachments/context-tree.json"),
    );

    const parsed = await parseAttachmentContent(pdf!, "first page text", {
      parsers: {
        pdf: async ({ data }) => ({
          status: "partial",
          parser: "fixture-pdf",
          text: String(data),
          reason: "Only the first page was available in the fixture.",
        }),
      },
    });

    expect(renderAttachmentContextParts(parsed)).toEqual([
      {
        type: "system_note",
        text: "System Note: The user attached ../Q2 Final?.pdf as Q2_Final_.pdf (application/pdf, 124000 bytes) from UPLOADED_CONTENT in current_message. Extraction status: partial. Transcription status: skipped.",
      },
      {
        type: "attachment_content",
        status: "partial",
        text: "first page text",
        note: "Only the first page was available in the fixture.",
      },
    ]);

    const transcribed = await transcribeAudio(audio!, new Uint8Array());
    expect(transcribed.processing.transcription.status).toBe("disabled");
    expect(renderAttachmentContextParts(transcribed)[0]!.text).toContain(
      "Transcription status: disabled.",
    );
  });

  it("blocks unsafe parser input and bounds extracted attachment text", async () => {
    const attachment = normalizeAttachment({
      name: "spaces/AAA/messages/root/attachments/note",
      contentName: "note.txt",
      contentType: "text/plain",
    });
    expect(attachment).not.toBeNull();
    const parser = async () => ({
      status: "complete" as const,
      parser: "fixture-text",
      text: "abcdefgh",
    });

    const scannerBlocked = await parseAttachmentContent(attachment!, "safe", {
      scanner: async () => ({ status: "blocked", reason: "scanner policy" }),
      parsers: { text: parser },
    });
    expect(scannerBlocked.processing.extraction).toMatchObject({
      status: "blocked",
      reason: "scanner policy",
      text: null,
    });

    const inputBlocked = await parseAttachmentContent(attachment!, "too long", {
      maxParseBytes: 3,
      parsers: { text: parser },
    });
    expect(inputBlocked.processing.extraction.status).toBe("blocked");

    const bounded = await parseAttachmentContent(attachment!, "safe", {
      maxExtractedChars: 4,
      parsers: { text: parser },
    });
    expect(bounded.processing.extraction).toMatchObject({
      status: "partial",
      text: "abcd",
    });
    expect(bounded.processing.extraction.reason).toContain("truncated at 4");
  });

  it("keeps OpenAI and Gemini transcription providers optional and auth-explicit", () => {
    expect(() => createOpenAITranscriptionProvider({})).toThrow(
      "OpenAI transcription requires an explicit apiKey or client.",
    );
    expect(() => createGeminiTranscriptionProvider({})).toThrow(
      "Gemini transcription requires an explicit apiKey or client.",
    );
  });

  it("transcribes audio with explicit OpenAI auth, model gpt-4o-transcribe, and redacted evidence", async () => {
    const audio = normalizeAttachment({
      name: "spaces/AAA/messages/root/attachments/audio-1",
      contentName: "voice-note.wav",
      contentType: "audio/wav",
      contentSizeBytes: 5,
      attachmentDataRef: {
        resourceName: "spaces/AAA/messages/root/attachments/audio-1/media",
      },
    })!;
    const requests: Array<{ url: string; authorization: string; model: string }> = [];
    const provider = createOpenAITranscriptionProvider({
      apiKey: "test-key",
      fetch: async (url, init) => {
        const form = init.body as FormData;
        requests.push({
          url,
          authorization: String(init.headers?.authorization ?? ""),
          model: String(form.get("model")),
        });
        return new Response(JSON.stringify({ text: "hello from audio" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const transcribed = await transcribeAudio(
      audio,
      new TextEncoder().encode("audio"),
      { enabled: true, provider },
    );

    expect(provider.model).toBe("gpt-4o-transcribe");
    expect(requests).toEqual([
      {
        url: "https://api.openai.com/v1/audio/transcriptions",
        authorization: "Bearer test-key",
        model: "gpt-4o-transcribe",
      },
    ]);
    expect(transcribed.processing.transcription).toEqual({
      status: "complete",
      provider: "openai",
      text: "hello from audio",
      reason: null,
    });
    expect(
      summarizeTranscriptionEvidence({
        attachment: audio,
        data: new TextEncoder().encode("audio"),
        result: transcribed.processing.transcription,
        includeTranscriptText: false,
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-4o-transcribe",
      status: "complete",
      audioSha256: "6ed8919ce20490a5e3ad8630a4fab69475297abd07db73918dd5f36fcfaeb11b",
      audioSizeBytes: 5,
      transcriptLength: 16,
      transcriptSha256: "e2cb600338632c29a8db6708095bde5628f7bd8b1e59239661dfb9ffac9505af",
      transcriptText: null,
      redacted: true,
    });
  });

  it("transcribes audio with explicit Gemini auth, model gemini-3.5-flash, and Interactions API payload", async () => {
    const audio = normalizeAttachment({
      name: "spaces/AAA/messages/root/attachments/audio-1",
      contentName: "voice-note.wav",
      contentType: "audio/wav",
      contentSizeBytes: 5,
      attachmentDataRef: {
        resourceName: "spaces/AAA/messages/root/attachments/audio-1/media",
      },
    })!;
    const requests: Array<{
      url: string;
      apiKey: string;
      contentType: string;
      model: string;
      prompt: string;
      audioType: string;
      audioMimeType: string;
      audioData: string;
    }> = [];
    const provider = createGeminiTranscriptionProvider({
      apiKey: "test-key",
      fetch: async (url, init) => {
        const body = JSON.parse(String(init.body)) as {
          model: string;
          input: Array<{ type: string; text?: string; mime_type?: string; data?: string }>;
        };
        requests.push({
          url,
          apiKey: String(init.headers?.["x-goog-api-key"] ?? ""),
          contentType: String(init.headers?.["content-type"] ?? ""),
          model: body.model,
          prompt: String(body.input[0]?.text ?? ""),
          audioType: String(body.input[1]?.type ?? ""),
          audioMimeType: String(body.input[1]?.mime_type ?? ""),
          audioData: String(body.input[1]?.data ?? ""),
        });
        return new Response(JSON.stringify({ output_text: "hello from gemini" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const transcribed = await transcribeAudio(
      audio,
      new TextEncoder().encode("audio"),
      { enabled: true, provider },
    );

    expect(provider.model).toBe("gemini-3.5-flash");
    expect(requests).toEqual([
      {
        url: "https://generativelanguage.googleapis.com/v1beta/interactions",
        apiKey: "test-key",
        contentType: "application/json",
        model: "gemini-3.5-flash",
        prompt: "Generate a transcript of the speech. Return only the transcript text.",
        audioType: "audio",
        audioMimeType: "audio/wav",
        audioData: "YXVkaW8=",
      },
    ]);
    expect(transcribed.processing.transcription).toEqual({
      status: "complete",
      provider: "gemini",
      text: "hello from gemini",
      reason: null,
    });
    expect(
      summarizeTranscriptionEvidence({
        attachment: audio,
        data: new TextEncoder().encode("audio"),
        result: transcribed.processing.transcription,
        includeTranscriptText: false,
      }),
    ).toMatchObject({
      provider: "gemini",
      model: "gemini-3.5-flash",
      status: "complete",
      transcriptLength: 17,
      transcriptText: null,
      redacted: true,
    });
  });

  it("reads Gemini transcript text from completed Interactions API steps", async () => {
    const audio = normalizeAttachment({
      name: "spaces/AAA/messages/root/attachments/audio-1",
      contentName: "voice-note.wav",
      contentType: "audio/wav",
      contentSizeBytes: 5,
    })!;
    const provider = createGeminiTranscriptionProvider({
      apiKey: "test-key",
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: "interactions/redacted",
            status: "completed",
            steps: [
              { type: "thought", signature: "redacted" },
              {
                type: "model_response",
                content: [{ type: "text", text: "hello from gemini steps" }],
              },
            ],
            model: "gemini-3.5-flash",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });

    const transcribed = await transcribeAudio(
      audio,
      new TextEncoder().encode("audio"),
      { enabled: true, provider },
    );

    expect(transcribed.processing.transcription).toEqual({
      status: "complete",
      provider: "gemini",
      text: "hello from gemini steps",
      reason: null,
    });
  });

  it("blocks OpenAI transcription before provider calls when audio exceeds limits", async () => {
    const audio = normalizeAttachment({
      name: "spaces/AAA/messages/root/attachments/audio-1",
      contentName: "long.wav",
      contentType: "audio/wav",
      contentSizeBytes: 6,
    })!;
    let called = false;
    const provider = createOpenAITranscriptionProvider({
      apiKey: "test-key",
      maxBytes: 5,
      fetch: async () => {
        called = true;
        return new Response(JSON.stringify({ text: "not used" }), { status: 200 });
      },
    });

    const result = await transcribeAudio(audio, new Uint8Array(6), {
      enabled: true,
      provider,
    });

    expect(called).toBe(false);
    expect(result.processing.transcription).toEqual({
      status: "blocked",
      provider: "openai",
      text: null,
      reason: "Audio is 6 bytes, exceeding the configured transcription limit of 5 bytes.",
    });
  });
});
