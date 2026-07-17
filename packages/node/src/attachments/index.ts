import crypto from "node:crypto";
import { Buffer } from "node:buffer";

export type MediaKind =
  | "text"
  | "json"
  | "pdf"
  | "image"
  | "audio"
  | "video"
  | "archive"
  | "unknown";

export type ProcessingStatus =
  | "complete"
  | "skipped"
  | "partial"
  | "blocked"
  | "disabled"
  | "failed";

export interface AttachmentContextRef {
  messageName: string | null;
  relationship: string;
  path: string[];
}

export interface AttachmentPolicyResult {
  status: "allowed" | "blocked";
  reasons: string[];
  maxDownloadBytes: number;
  maxUploadBytes: number;
}

export interface AttachmentProcessing {
  extraction: {
    status: ProcessingStatus;
    parser: string | null;
    text: string | null;
    reason: string | null;
  };
  transcription: {
    status: ProcessingStatus;
    provider: string | null;
    text: string | null;
    reason: string | null;
  };
}

export interface NormalizedAttachment {
  name: string;
  contentName: string | null;
  safeFilename: string;
  contentType: string | null;
  mediaKind: MediaKind;
  source: string | null;
  contentSizeBytes: number | null;
  mediaResourceName: string | null;
  attachmentDataRef: {
    resourceName: string | null;
    attachmentUploadToken: string | null;
  } | null;
  driveDataRef: ({ driveFileId: string | null } & Record<string, unknown>) | null;
  thumbnailUri: string | null;
  downloadUri: string | null;
  context: AttachmentContextRef;
  policy: AttachmentPolicyResult;
  processing: AttachmentProcessing;
}

export interface AttachmentPolicyOptions {
  maxDownloadBytes?: number;
  maxUploadBytes?: number;
  blockedContentTypes?: string[];
  blockedExtensions?: string[];
}

export interface NormalizeAttachmentOptions {
  context?: Partial<AttachmentContextRef>;
  policy?: AttachmentPolicyOptions;
}

export interface DownloadPlanOptions {
  targetDirectory?: string;
  enableLiveMedia?: boolean;
  w7Complete?: boolean;
  env?: Record<string, string | undefined>;
}

export interface DriveExportPlanOptions {
  targetDirectory?: string;
  exportMimeType?: string | null;
  enableLiveDrive?: boolean;
  env?: Record<string, string | undefined>;
}

export interface UploadPlanInput {
  parent: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number | null;
}

export interface UploadPlanOptions {
  enableLiveMedia?: boolean;
  w7Complete?: boolean;
  env?: Record<string, string | undefined>;
  policy?: AttachmentPolicyOptions;
}

export interface AttachmentParserInput {
  attachment: NormalizedAttachment;
  data: unknown;
}

export interface AttachmentParserResult {
  status: ProcessingStatus;
  parser?: string | null;
  text?: string | null;
  reason?: string | null;
}

export type AttachmentParser = (
  input: AttachmentParserInput,
) => AttachmentParserResult | Promise<AttachmentParserResult>;

export type AttachmentParsers = Partial<
  Record<"text" | "json" | "pdf" | "image" | "audio", AttachmentParser>
>;

export interface AttachmentSafetyScanInput {
  attachment: NormalizedAttachment;
  data: unknown;
}

export interface AttachmentSafetyScanResult {
  status: "allowed" | "blocked";
  reason?: string | null;
}

/**
 * Application-owned content scanner hook. The SDK does not bundle a malware
 * or DLP engine, so deployments decide which scanner and tenant policy apply.
 */
export type AttachmentSafetyScanner = (
  input: AttachmentSafetyScanInput,
) => AttachmentSafetyScanResult | Promise<AttachmentSafetyScanResult>;

export interface ParseAttachmentOptions {
  parsers?: AttachmentParsers;
  scanner?: AttachmentSafetyScanner;
  /** Maximum byte length passed to a parser when the input is byte-like. */
  maxParseBytes?: number;
  /** Maximum extracted text characters retained in model-adjacent metadata. */
  maxExtractedChars?: number;
}

export interface AttachmentContextPart {
  type: "system_note" | "attachment_content";
  text: string | null;
  status?: ProcessingStatus;
  note?: string | null;
}

export interface TranscriptionProvider {
  provider: "openai" | "gemini";
  model: string;
  maxBytes?: number;
  transcribe: (input: {
    attachment: NormalizedAttachment;
    data: unknown;
  }) => Promise<{
    status: ProcessingStatus;
    text?: string | null;
    reason?: string | null;
  }>;
}

export interface TranscriptionProviderOptions {
  apiKey?: string;
  endpoint?: string;
  maxBytes?: number;
  fetch?: (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body: BodyInit;
    },
  ) => Promise<Response>;
  client?: (input: {
    attachment: NormalizedAttachment;
    data: unknown;
    model: string;
    apiKey?: string;
  }) => Promise<{
    status: ProcessingStatus;
    text?: string | null;
    reason?: string | null;
  }>;
  model?: string;
}

export interface TranscribeAudioOptions {
  enabled?: boolean;
  provider?: TranscriptionProvider;
}

export interface TranscriptionEvidenceInput {
  attachment: NormalizedAttachment;
  data: unknown;
  result: AttachmentProcessing["transcription"];
  includeTranscriptText?: boolean;
}

export interface AttachmentPipelineCacheEntry {
  hit?: boolean;
  negative?: boolean;
  key?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string | null;
  expiresAt?: string | null;
}

export interface AttachmentPipelineOptions {
  targetDirectory?: string;
  driveExportDirectory?: string;
  env?: Record<string, string | undefined>;
  enableLiveMedia?: boolean;
  enableLiveDrive?: boolean;
  w7Complete?: boolean;
  policy?: AttachmentPolicyOptions;
  cache?: {
    entriesByAttachmentName?: Record<string, AttachmentPipelineCacheEntry | null>;
  } | null;
  parsers?: Record<string, string | { name?: string | null } | boolean | null>;
  transcription?: {
    enabled?: boolean;
    provider?: string | null;
    model?: string | null;
    maxBytes?: number | null;
  };
}

export interface AttachmentPipelineUploadInput extends UploadPlanInput {
  sendOptions?: {
    hasAccessoryWidgets?: boolean;
  };
}

export interface AttachmentPipelineInput {
  message?: unknown;
  context?: unknown;
  attachments?: unknown;
  uploads?: AttachmentPipelineUploadInput[];
  options?: AttachmentPipelineOptions;
}

export interface AttachmentPipelinePlan {
  kind: "chat.attachment_pipeline_plan";
  status: "ready" | "partial" | "blocked";
  summary: string;
  counts: {
    attachments: number;
    uploads: number;
    downloads: number;
    driveExports: number;
    blocked: number;
    cacheHits: number;
    parserReady: number;
    transcriptionReady: number;
    fallbacks: number;
  };
  attachments: Array<Record<string, unknown>>;
  uploads: Array<Record<string, unknown>>;
  systemNotes: string[];
}

export type DriveLinkSource = "rich_link" | "matched_url" | "plain_url";

export type DriveFileKind =
  | "document"
  | "spreadsheet"
  | "presentation"
  | "drawing"
  | "blob"
  | "folder"
  | "unknown";

export interface DriveLinkContextRef {
  messageName: string | null;
  relationship: string;
  path: string[];
}

export interface DriveLinkCandidate {
  kind: "drive_link";
  candidateId: string;
  source: DriveLinkSource;
  url: string;
  title: string | null;
  richLinkType: string | null;
  mimeType: string | null;
  driveFileId: string | null;
  driveFileKind: DriveFileKind;
  retrievable: boolean;
  blockedReasons: string[];
  context: DriveLinkContextRef;
}

export interface IgnoredDriveLink {
  source: DriveLinkSource;
  url: string;
  reason: string;
  context: DriveLinkContextRef;
}

export interface DriveLinkRetrievalOptions {
  targetDirectory?: string;
  exportMimeType?: string | null;
  enableLiveDrive?: boolean;
  env?: Record<string, string | undefined>;
  policy?: AttachmentPolicyOptions;
  includePlainTextUrls?: boolean;
  includeMatchedUrls?: boolean;
  maxDriveLinks?: number | string | null;
  maxPlainTextUrls?: number | string | null;
  maxTraversalDepth?: number | string | null;
  maxTraversalNodes?: number | string | null;
  maxLinkScanItems?: number | string | null;
  cache?: {
    entriesByCandidateId?: Record<string, AttachmentPipelineCacheEntry | null>;
    entriesByFileId?: Record<string, AttachmentPipelineCacheEntry | null>;
    entriesByUrl?: Record<string, AttachmentPipelineCacheEntry | null>;
  } | null;
}

export interface DriveLinkRetrievalPlanInput {
  message?: unknown;
  context?: unknown;
  links?: unknown;
  options?: DriveLinkRetrievalOptions;
}

export interface DriveLinkRetrievalPlan {
  kind: "chat.drive_link_retrieval_plan";
  status: "ready" | "partial" | "blocked";
  summary: string;
  counts: {
    candidates: number;
    driveExports: number;
    blocked: number;
    cacheHits: number;
    fallbacks: number;
    ignored: number;
  };
  links: Array<Record<string, unknown>>;
  ignoredLinks: IgnoredDriveLink[];
  traversal?: Record<string, unknown>;
  systemNotes: string[];
}

type RawRecord = Record<string, unknown>;

export const CHAT_MEDIA_UPLOAD_MAX_BYTES = 209_715_200;
export const DEFAULT_ATTACHMENT_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_DRIVE_EXPORT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;
export const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
export const DEFAULT_GEMINI_TRANSCRIPTION_MODEL = "gemini-3.5-flash";
const DEFAULT_DRIVE_LINK_MAX_TRAVERSAL_DEPTH = 256;
const DEFAULT_DRIVE_LINK_MAX_TRAVERSAL_NODES = 5_000;
const DEFAULT_DRIVE_LINK_MAX_LINK_SCAN_ITEMS = 5_000;
const DEFAULT_DRIVE_LINK_MAX_LINKS = 200;
const DEFAULT_DRIVE_LINK_MAX_PLAIN_TEXT_URLS = 200;
export const GEMINI_INTERACTIONS_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
export const GEMINI_TRANSCRIPTION_PROMPT =
  "Generate a transcript of the speech. Return only the transcript text.";

const DEFAULT_BLOCKED_CONTENT_TYPES = [
  "application/x-msdownload",
  "application/x-dosexec",
  "application/x-executable",
  "application/vnd.microsoft.portable-executable",
];

const DEFAULT_BLOCKED_EXTENSIONS = [
  ".bat",
  ".cmd",
  ".com",
  ".dll",
  ".dmg",
  ".exe",
  ".pkg",
  ".ps1",
  ".scr",
  ".sh",
];

function asRecord(value: unknown): RawRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function dataBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  return null;
}

function dataByteLength(value: unknown): number | null {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return value.byteLength;
  }
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8");
  }
  return null;
}

function sizeBytes(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.trunc(parsed);
    }
  }

  return null;
}

function extensionFor(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0) {
    return "";
  }
  return filename.slice(dotIndex).toLowerCase();
}

function truncateFilename(filename: string, maxLength = 128): string {
  if (filename.length <= maxLength) {
    return filename;
  }

  const extension = extensionFor(filename);
  const basenameMax = Math.max(1, maxLength - extension.length);
  return `${filename.slice(0, basenameMax)}${extension}`;
}

export function sanitizeFilename(
  filename: string | null | undefined,
  fallback = "attachment",
): string {
  const raw = filename?.trim() ? filename.trim() : fallback;
  const segments = raw.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const basename = segments[segments.length - 1] ?? fallback;
  let safe = basename
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "");

  if (!safe || safe === "." || safe === "..") {
    safe = fallback;
  }

  return truncateFilename(safe);
}

export function classifyMediaKind(contentType: string | null): MediaKind {
  const type = contentType?.toLowerCase() ?? "";

  if (type.startsWith("text/")) {
    return "text";
  }
  if (type === "application/json" || type.endsWith("+json")) {
    return "json";
  }
  if (type === "application/pdf") {
    return "pdf";
  }
  if (type.startsWith("image/")) {
    return "image";
  }
  if (type.startsWith("audio/")) {
    return "audio";
  }
  if (type.startsWith("video/")) {
    return "video";
  }
  if (
    type === "application/zip" ||
    type === "application/x-tar" ||
    type === "application/gzip"
  ) {
    return "archive";
  }

  return "unknown";
}

function policyLimits(options?: AttachmentPolicyOptions): {
  maxDownloadBytes: number;
  maxUploadBytes: number;
  blockedContentTypes: Set<string>;
  blockedExtensions: Set<string>;
} {
  return {
    maxDownloadBytes:
      options?.maxDownloadBytes ?? DEFAULT_ATTACHMENT_DOWNLOAD_MAX_BYTES,
    maxUploadBytes: options?.maxUploadBytes ?? CHAT_MEDIA_UPLOAD_MAX_BYTES,
    blockedContentTypes: new Set(
      (options?.blockedContentTypes ?? DEFAULT_BLOCKED_CONTENT_TYPES).map((item) =>
        item.toLowerCase(),
      ),
    ),
    blockedExtensions: new Set(
      (options?.blockedExtensions ?? DEFAULT_BLOCKED_EXTENSIONS).map((item) =>
        item.toLowerCase(),
      ),
    ),
  };
}

export function evaluateAttachmentPolicy(
  input: {
    contentType: string | null;
    contentSizeBytes: number | null;
    safeFilename: string;
  },
  options?: AttachmentPolicyOptions,
): AttachmentPolicyResult {
  const limits = policyLimits(options);
  const reasons: string[] = [];
  const contentType = input.contentType?.toLowerCase() ?? null;
  const extension = extensionFor(input.safeFilename);

  if (contentType && limits.blockedContentTypes.has(contentType)) {
    reasons.push("content_type_blocked");
  }

  if (extension && limits.blockedExtensions.has(extension)) {
    reasons.push("extension_blocked");
  }

  if (
    input.contentSizeBytes !== null &&
    input.contentSizeBytes > limits.maxDownloadBytes
  ) {
    reasons.push("size_exceeds_download_limit");
  }

  return {
    status: reasons.length > 0 ? "blocked" : "allowed",
    reasons,
    maxDownloadBytes: limits.maxDownloadBytes,
    maxUploadBytes: limits.maxUploadBytes,
  };
}

function defaultContext(context?: Partial<AttachmentContextRef>): AttachmentContextRef {
  return {
    messageName: context?.messageName ?? null,
    relationship: context?.relationship ?? "message",
    path: context?.path ?? [],
  };
}

function processingFor(
  mediaKind: MediaKind,
  policyStatus: "allowed" | "blocked",
): AttachmentProcessing {
  return {
    extraction:
      policyStatus === "blocked"
        ? {
            status: "blocked",
            parser: null,
            text: null,
            reason: "Attachment is blocked by policy.",
          }
        : {
            status: "skipped",
            parser: null,
            text: null,
            reason: "No parser has run.",
          },
    transcription:
      mediaKind === "audio" && policyStatus === "allowed"
        ? {
            status: "disabled",
            provider: null,
            text: null,
            reason: "Audio transcription is disabled by default.",
          }
        : {
            status: "skipped",
            provider: null,
            text: null,
            reason:
              policyStatus === "blocked"
                ? "Attachment is blocked by policy."
                : "Attachment is not audio.",
          },
  };
}

export function normalizeAttachment(
  value: unknown,
  options: NormalizeAttachmentOptions = {},
): NormalizedAttachment | null {
  const raw = asRecord(value);
  const name = asString(raw?.name);

  if (!raw || !name) {
    return null;
  }

  const contentName = asString(raw.contentName);
  const safeFilename = sanitizeFilename(contentName, "attachment");
  const contentType = asString(raw.contentType);
  const contentSizeBytes =
    sizeBytes(raw.contentSizeBytes) ??
    sizeBytes(raw.contentSize) ??
    sizeBytes(raw.sizeBytes);
  const attachmentDataRefRaw = asRecord(raw.attachmentDataRef);
  const attachmentDataRef = attachmentDataRefRaw
    ? {
        resourceName: asString(attachmentDataRefRaw.resourceName),
        attachmentUploadToken: asString(attachmentDataRefRaw.attachmentUploadToken),
      }
    : null;
  const driveDataRefRaw = asRecord(raw.driveDataRef);
  const driveDataRef = driveDataRefRaw
    ? {
        ...driveDataRefRaw,
        driveFileId: asString(driveDataRefRaw.driveFileId),
      }
    : null;
  const mediaResourceName =
    asString(raw.mediaResourceName) ?? attachmentDataRef?.resourceName ?? null;
  const mediaKind = classifyMediaKind(contentType);
  const policy = evaluateAttachmentPolicy(
    { contentType, contentSizeBytes, safeFilename },
    options.policy,
  );

  return {
    name,
    contentName,
    safeFilename,
    contentType,
    mediaKind,
    source: asString(raw.source),
    contentSizeBytes,
    mediaResourceName,
    attachmentDataRef,
    driveDataRef,
    thumbnailUri: asString(raw.thumbnailUri),
    downloadUri: asString(raw.downloadUri),
    context: defaultContext(options.context),
    policy,
    processing: processingFor(mediaKind, policy.status),
  };
}

export function normalizeAttachments(
  value: unknown,
  options: NormalizeAttachmentOptions = {},
): NormalizedAttachment[] {
  return asArray(value)
    .map((item) => normalizeAttachment(item, options))
    .filter((item): item is NormalizedAttachment => item !== null);
}

export function normalizeAttachmentsFromMessage(
  message: unknown,
  options: NormalizeAttachmentOptions = {},
): NormalizedAttachment[] {
  const raw = asRecord(message);
  if (!raw) {
    return [];
  }

  const attachments =
    raw.attachment !== undefined ? raw.attachment : raw.attachments;
  return normalizeAttachments(attachments, options);
}

function messageNameFor(message: RawRecord | null): string | null {
  const ref = asRecord(message?.ref);
  return asString(message?.name) ?? asString(ref?.name);
}

function visitContextNode(
  node: unknown,
  inheritedPath: string[],
  output: NormalizedAttachment[],
  options: NormalizeAttachmentOptions,
): void {
  const raw = asRecord(node);
  if (!raw) {
    return;
  }

  const message = asRecord(raw.message) ?? raw;
  const relationship = asString(raw.relationship) ?? "message";
  const messageName = messageNameFor(message);
  const path =
    messageName !== null
      ? [...inheritedPath, `${relationship}:${messageName}`]
      : inheritedPath;

  output.push(
    ...normalizeAttachmentsFromMessage(message, {
      context: {
        messageName,
        relationship,
        path,
      },
      policy: options.policy,
    }),
  );

  for (const child of asArray(raw.children)) {
    visitContextNode(child, path, output, options);
  }

  for (const child of asArray(raw.quotedMessages)) {
    visitContextNode(
      { relationship: "quoted_message", message: child },
      path,
      output,
      options,
    );
  }

  for (const child of asArray(raw.threadHistory)) {
    visitContextNode(
      { relationship: "thread_history", message: child },
      path,
      output,
      options,
    );
  }

  const quotedMessage = raw.quotedMessage ?? message?.quotedMessage;
  if (quotedMessage !== undefined) {
    visitContextNode(
      { relationship: "quoted_message", message: quotedMessage },
      path,
      output,
      options,
    );
  }
}

export function collectAttachmentsFromContext(
  input: unknown,
  options: NormalizeAttachmentOptions = {},
): NormalizedAttachment[] {
  const output: NormalizedAttachment[] = [];
  visitContextNode(input, [], output, options);
  return output;
}

function liveMediaGate(options: DownloadPlanOptions | UploadPlanOptions): {
  allowed: boolean;
  reasons: string[];
} {
  const runtimeEnv =
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env ?? {};
  const env = options.env ?? runtimeEnv;
  const w7Complete =
    options.w7Complete ?? env.GOOGLE_CHAT_AI_W7_MEDIA_READY === "1";
  const enableLiveMedia =
    options.enableLiveMedia ?? env.GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA === "1";
  const reasons: string[] = [];

  if (!w7Complete) {
    reasons.push("w7_not_complete");
  }
  if (!enableLiveMedia) {
    reasons.push("env_flag_missing");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

function joinPath(directory: string, filename: string): string {
  const base = directory.endsWith("/")
    ? directory.slice(0, -1)
    : directory || ".";
  return `${base}/${filename}`;
}

function liveDriveGate(options: DriveExportPlanOptions): {
  allowed: boolean;
  reasons: string[];
} {
  const runtimeEnv =
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env ?? {};
  const env = options.env ?? runtimeEnv;
  const enableLiveDrive =
    options.enableLiveDrive ?? env.GOOGLE_CHAT_AI_ENABLE_LIVE_DRIVE === "1";
  const reasons: string[] = [];

  if (!enableLiveDrive) {
    reasons.push("env_flag_missing");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

function isGoogleWorkspaceMimeType(contentType: string | null): boolean {
  return Boolean(contentType?.startsWith("application/vnd.google-apps."));
}

function driveExportExtension(exportMimeType: string | null): string {
  switch (exportMimeType) {
    case "text/plain":
      return ".txt";
    case "text/csv":
      return ".csv";
    case "application/pdf":
      return ".pdf";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return ".docx";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return ".xlsx";
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return ".pptx";
    default:
      return "";
  }
}

function filenameWithExportExtension(filename: string, exportMimeType: string | null): string {
  const extension = driveExportExtension(exportMimeType);
  if (!extension || filename.toLowerCase().endsWith(extension)) {
    return filename;
  }
  const existingExtension = extensionFor(filename);
  const basename = existingExtension
    ? filename.slice(0, -existingExtension.length)
    : filename;
  return `${basename}${extension}`;
}

export function defaultDriveExportMimeType(contentType: string | null): string | null {
  switch (contentType) {
    case "application/vnd.google-apps.document":
      return "text/plain";
    case "application/vnd.google-apps.spreadsheet":
      return "text/csv";
    case "application/vnd.google-apps.presentation":
      return "text/plain";
    case "application/vnd.google-apps.drawing":
      return "image/png";
    default:
      return isGoogleWorkspaceMimeType(contentType) ? "application/pdf" : null;
  }
}

export function createDownloadPlan(
  attachment: NormalizedAttachment,
  options: DownloadPlanOptions = {},
): Record<string, unknown> {
  const policyReasons =
    attachment.policy.status === "blocked" ? attachment.policy.reasons : [];
  const blockedReasons = [...policyReasons];
  const isDriveBacked =
    attachment.source === "DRIVE_FILE" || attachment.driveDataRef !== null;

  if (!attachment.mediaResourceName) {
    blockedReasons.push(
      isDriveBacked
        ? "drive_api_required"
        : "media_resource_missing",
    );
  }

  const gate = liveMediaGate(options);
  const targetDirectory = options.targetDirectory ?? ".";
  const status = blockedReasons.length > 0 ? "blocked" : "dry_run";

  const plan: Record<string, unknown> = {
    kind: "download",
    status,
    dryRun: true,
    canExecuteLive: gate.allowed && status !== "blocked",
    liveGate: gate,
    attachmentName: attachment.name,
    mediaResourceName: attachment.mediaResourceName,
    method: "GET",
    url: attachment.mediaResourceName
      ? `https://chat.googleapis.com/v1/media/${attachment.mediaResourceName}?alt=media`
      : null,
    destinationPath: joinPath(targetDirectory, attachment.safeFilename),
    policy: {
      status: attachment.policy.status,
      reasons: attachment.policy.reasons,
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
    alternateContentApi: isDriveBacked
      ? {
          kind: "drive",
          required: true,
          driveFileIdAvailable:
            typeof attachment.driveDataRef?.driveFileId === "string",
          method: "GET",
          reason:
            "Drive-backed Google Chat attachments must be read with the Google Drive API.",
          auth: {
            required: true,
            modes: ["user"],
            scopes: ["https://www.googleapis.com/auth/drive.readonly"],
          },
        }
      : null,
  };

  if (blockedReasons.length > 0) {
    plan.blockedReasons = blockedReasons;
  }

  return plan;
}

export function createDriveExportPlan(
  attachment: NormalizedAttachment,
  options: DriveExportPlanOptions = {},
): Record<string, unknown> {
  const policyReasons =
    attachment.policy.status === "blocked" ? attachment.policy.reasons : [];
  const blockedReasons = [...policyReasons];
  const isDriveBacked =
    attachment.source === "DRIVE_FILE" || attachment.driveDataRef !== null;
  const driveFileId = attachment.driveDataRef?.driveFileId ?? null;
  const isWorkspaceFile = isGoogleWorkspaceMimeType(attachment.contentType);
  const exportMimeType =
    options.exportMimeType ?? defaultDriveExportMimeType(attachment.contentType);
  const contentApi = isWorkspaceFile
    ? "drive.files.export"
    : "drive.files.get_media";

  if (!isDriveBacked) {
    blockedReasons.push("not_drive_backed");
  }
  if (!driveFileId) {
    blockedReasons.push("drive_file_id_missing");
  }
  if (isWorkspaceFile && !exportMimeType) {
    blockedReasons.push("drive_export_mime_type_missing");
  }

  const gate = liveDriveGate(options);
  const status = blockedReasons.length > 0 ? "blocked" : "dry_run";
  const targetDirectory = options.targetDirectory ?? ".";
  const outputFilename = filenameWithExportExtension(
    attachment.safeFilename,
    isWorkspaceFile ? exportMimeType : attachment.contentType,
  );
  const url =
    driveFileId && contentApi === "drive.files.export"
      ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
          driveFileId,
        )}/export?mimeType=${encodeURIComponent(exportMimeType ?? "")}`
      : driveFileId
        ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
            driveFileId,
          )}?alt=media`
        : null;
  const plan: Record<string, unknown> = {
    kind: "drive_export",
    status,
    dryRun: true,
    canExecuteLive: gate.allowed && status !== "blocked",
    liveGate: gate,
    attachmentName: attachment.name,
    contentApi,
    method: "GET",
    url,
    driveFileIdAvailable: typeof driveFileId === "string",
    sourceContentType: attachment.contentType,
    exportMimeType: isWorkspaceFile ? exportMimeType : null,
    destinationPath: joinPath(targetDirectory, outputFilename),
    maxExportBytes: DEFAULT_DRIVE_EXPORT_MAX_BYTES,
    policy: {
      status: attachment.policy.status,
      reasons: attachment.policy.reasons,
    },
    auth: {
      required: true,
      mode: "user",
      scopes: [DRIVE_READONLY_SCOPE],
    },
  };

  if (blockedReasons.length > 0) {
    plan.blockedReasons = blockedReasons;
  }

  return plan;
}

interface DriveLinkEntry {
  source: DriveLinkSource;
  url: string;
  title: string | null;
  richLinkType: string | null;
  mimeType: string | null;
  context: DriveLinkContextRef;
}

interface ParsedDriveUrl {
  isDriveUrl: boolean;
  driveFileId: string | null;
  driveFileKind: DriveFileKind;
  mimeType: string | null;
  blockedReasons: string[];
}

interface DriveLinkTraversalState {
  nextAnonymousPathId: number;
  activeNodes: WeakSet<object>;
  maxDepth: number;
  maxTraversalNodes: number;
  maxLinkScanItems: number;
  maxDriveLinks: number;
  maxPlainTextUrls: number;
  traversalNodeCount: number;
  linkScanItemCount: number;
  entryCount: number;
  plainTextUrlCount: number;
  truncatedBranches: number;
  cappedTraversalNodes: number;
  cappedLinkScanItems: number;
  cappedDriveLinks: number;
  cappedPlainTextUrls: number;
}

interface DriveLinkCollectionResult {
  candidates: DriveLinkCandidate[];
  ignoredLinks: IgnoredDriveLink[];
  traversal: DriveLinkTraversalState;
}

function driveLinkIntegerOption(value: unknown, fallback: number): number {
  return sizeBytes(value) ?? fallback;
}

function normalizeDriveLinkCache(cache: unknown): DriveLinkRetrievalOptions["cache"] {
  const raw = asRecord(cache);
  if (!raw) {
    return cache === null ? null : undefined;
  }

  return {
    entriesByCandidateId: (asRecord(raw.entriesByCandidateId) ??
      asRecord(raw.entries_by_candidate_id)) as
      | Record<string, AttachmentPipelineCacheEntry | null>
      | undefined,
    entriesByFileId: (asRecord(raw.entriesByFileId) ??
      asRecord(raw.entries_by_file_id)) as
      | Record<string, AttachmentPipelineCacheEntry | null>
      | undefined,
    entriesByUrl: (asRecord(raw.entriesByUrl) ?? asRecord(raw.entries_by_url)) as
      | Record<string, AttachmentPipelineCacheEntry | null>
      | undefined,
  };
}

function numericOptionAlias(
  raw: RawRecord,
  camelKey: string,
  snakeKey: string,
): number | null | undefined {
  const value = raw[camelKey] ?? raw[snakeKey];
  return (
    sizeBytes(value) ??
    (raw[camelKey] === null || raw[snakeKey] === null ? null : undefined)
  );
}

function normalizeDriveLinkOptions(
  options: DriveLinkRetrievalOptions | RawRecord | null | undefined,
): DriveLinkRetrievalOptions {
  const raw = asRecord(options);
  if (!raw) {
    return {};
  }

  return {
    ...raw,
    targetDirectory:
      asString(raw.targetDirectory) ?? asString(raw.target_directory) ?? undefined,
    exportMimeType:
      asString(raw.exportMimeType) ?? asString(raw.export_mime_type) ?? null,
    enableLiveDrive:
      asBoolean(raw.enableLiveDrive) ?? asBoolean(raw.enable_live_drive) ?? undefined,
    includePlainTextUrls:
      asBoolean(raw.includePlainTextUrls) ??
      asBoolean(raw.include_plain_text_urls) ??
      undefined,
    includeMatchedUrls:
      asBoolean(raw.includeMatchedUrls) ??
      asBoolean(raw.include_matched_urls) ??
      undefined,
    maxDriveLinks: numericOptionAlias(raw, "maxDriveLinks", "max_drive_links"),
    maxPlainTextUrls: numericOptionAlias(
      raw,
      "maxPlainTextUrls",
      "max_plain_text_urls",
    ),
    maxTraversalDepth: numericOptionAlias(
      raw,
      "maxTraversalDepth",
      "max_traversal_depth",
    ),
    maxTraversalNodes: numericOptionAlias(
      raw,
      "maxTraversalNodes",
      "max_traversal_nodes",
    ),
    maxLinkScanItems: numericOptionAlias(
      raw,
      "maxLinkScanItems",
      "max_link_scan_items",
    ),
    env: (asRecord(raw.env) as Record<string, string | undefined> | null) ?? undefined,
    policy: (asRecord(raw.policy) as AttachmentPolicyOptions | null) ?? undefined,
    cache: normalizeDriveLinkCache(raw.cache),
  };
}

function createDriveLinkTraversalState(
  options: DriveLinkRetrievalOptions,
): DriveLinkTraversalState {
  return {
    nextAnonymousPathId: 1,
    activeNodes: new WeakSet<object>(),
    maxDepth: driveLinkIntegerOption(
      options.maxTraversalDepth,
      DEFAULT_DRIVE_LINK_MAX_TRAVERSAL_DEPTH,
    ),
    maxTraversalNodes: driveLinkIntegerOption(
      options.maxTraversalNodes,
      DEFAULT_DRIVE_LINK_MAX_TRAVERSAL_NODES,
    ),
    maxLinkScanItems: driveLinkIntegerOption(
      options.maxLinkScanItems,
      DEFAULT_DRIVE_LINK_MAX_LINK_SCAN_ITEMS,
    ),
    maxDriveLinks: driveLinkIntegerOption(
      options.maxDriveLinks,
      DEFAULT_DRIVE_LINK_MAX_LINKS,
    ),
    maxPlainTextUrls: driveLinkIntegerOption(
      options.maxPlainTextUrls,
      DEFAULT_DRIVE_LINK_MAX_PLAIN_TEXT_URLS,
    ),
    entryCount: 0,
    traversalNodeCount: 0,
    linkScanItemCount: 0,
    plainTextUrlCount: 0,
    truncatedBranches: 0,
    cappedTraversalNodes: 0,
    cappedLinkScanItems: 0,
    cappedDriveLinks: 0,
    cappedPlainTextUrls: 0,
  };
}

function defaultDriveLinkContext(
  context?: Partial<DriveLinkContextRef>,
): DriveLinkContextRef {
  return {
    messageName: context?.messageName ?? null,
    relationship: context?.relationship ?? "message",
    path: context?.path ?? [],
  };
}

function messageNameForDriveLinks(message: RawRecord | null): string | null {
  const ref = asRecord(message?.ref);
  return asString(message?.name) ?? asString(ref?.name);
}

function appendDriveLinkPath(
  context: DriveLinkContextRef,
  relationship: string,
  messageName: string | null,
  traversal: DriveLinkTraversalState,
): DriveLinkContextRef {
  const path =
    messageName !== null
      ? [...context.path, `${relationship}:${messageName}`]
      : [...context.path, `${relationship}:node-${traversal.nextAnonymousPathId++}`];
  return {
    messageName,
    relationship,
    path,
  };
}

function richLinkTitleFromMetadata(metadata: RawRecord): string | null {
  const driveData = asRecord(metadata.driveLinkData);
  const chatSpaceData = asRecord(metadata.chatSpaceLinkData);
  return (
    asString(metadata.title) ??
    asString(driveData?.title) ??
    asString(chatSpaceData?.spaceDisplayName)
  );
}

function addDriveLinkEntry(
  entries: DriveLinkEntry[],
  seen: Set<string>,
  entry: DriveLinkEntry,
  traversal: DriveLinkTraversalState,
): void {
  if (traversal.entryCount >= traversal.maxDriveLinks) {
    traversal.cappedDriveLinks += 1;
    return;
  }

  const key = `${entry.context.path.join(">")}:${entry.url}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  traversal.entryCount += 1;
  entries.push(entry);
}

function driveLinkOutputCapacityReached(traversal: DriveLinkTraversalState): boolean {
  return traversal.entryCount >= traversal.maxDriveLinks;
}

function consumeDriveLinkTraversalNode(traversal: DriveLinkTraversalState): boolean {
  if (traversal.traversalNodeCount >= traversal.maxTraversalNodes) {
    traversal.cappedTraversalNodes += 1;
    return false;
  }

  traversal.traversalNodeCount += 1;
  return true;
}

function consumeDriveLinkScanItem(
  traversal: DriveLinkTraversalState,
  remainingItems: number,
): boolean {
  if (traversal.linkScanItemCount >= traversal.maxLinkScanItems) {
    traversal.cappedLinkScanItems += remainingItems;
    return false;
  }

  traversal.linkScanItemCount += 1;
  return true;
}

function driveLinkBranchTraversalClosed(traversal: DriveLinkTraversalState): boolean {
  return (
    driveLinkOutputCapacityReached(traversal) ||
    traversal.traversalNodeCount >= traversal.maxTraversalNodes
  );
}

function abandonDriveLinkBranches(
  traversal: DriveLinkTraversalState,
  remainingBranches: number,
): void {
  if (remainingBranches > 0) {
    traversal.cappedTraversalNodes += remainingBranches;
  }
}

function linkSourceFor(kind: string | null): DriveLinkSource | null {
  if (kind === "richLink") {
    return "rich_link";
  }
  if (kind === "matchedUrl") {
    return "matched_url";
  }
  if (kind === "plain_url" || kind === "plainUrl") {
    return "plain_url";
  }
  return null;
}

function collectDriveLinkEntriesFromLinks(
  value: unknown,
  context: DriveLinkContextRef,
  entries: DriveLinkEntry[],
  seen: Set<string>,
  options: DriveLinkRetrievalOptions,
  traversal: DriveLinkTraversalState,
): void {
  const items = asArray(value);
  for (let index = 0; index < items.length; index += 1) {
    if (!consumeDriveLinkScanItem(traversal, items.length - index)) {
      return;
    }
    const item = items[index];
    const raw = asRecord(item);
    if (!raw) {
      continue;
    }
    const source = linkSourceFor(asString(raw.kind));
    if (!source) {
      continue;
    }
    if (source === "matched_url" && options.includeMatchedUrls === false) {
      continue;
    }
    if (source === "plain_url" && options.includePlainTextUrls === false) {
      continue;
    }
    const url = asString(raw.url);
    if (!url) {
      continue;
    }
    addDriveLinkEntry(entries, seen, {
      source,
      url,
      title: asString(raw.title),
      richLinkType: asString(raw.richLinkType),
      mimeType: asString(raw.mimeType),
      context,
    }, traversal);
  }
}

function collectRawDriveLinkAnnotations(
  value: unknown,
  context: DriveLinkContextRef,
  entries: DriveLinkEntry[],
  seen: Set<string>,
  traversal: DriveLinkTraversalState,
): void {
  const items = asArray(value);
  for (let index = 0; index < items.length; index += 1) {
    if (!consumeDriveLinkScanItem(traversal, items.length - index)) {
      return;
    }
    const item = items[index];
    const raw = asRecord(item);
    const rawType = asString(raw?.type);

    if (!raw || rawType !== "RICH_LINK") {
      continue;
    }

    const metadata = asRecord(raw.richLinkMetadata) ?? {};
    const url = asString(metadata.uri);
    if (!url) {
      continue;
    }

    addDriveLinkEntry(entries, seen, {
      source: "rich_link",
      url,
      title: richLinkTitleFromMetadata(metadata),
      richLinkType: asString(metadata.richLinkType),
      mimeType: asString(metadata.mimeType),
      context,
    }, traversal);
  }
}

function collectMatchedUrl(
  value: unknown,
  context: DriveLinkContextRef,
  entries: DriveLinkEntry[],
  seen: Set<string>,
  options: DriveLinkRetrievalOptions,
  traversal: DriveLinkTraversalState,
): void {
  if (options.includeMatchedUrls === false) {
    return;
  }

  const matchedUrl = asRecord(value);
  const url = asString(matchedUrl?.url);
  if (!url) {
    return;
  }

  addDriveLinkEntry(entries, seen, {
    source: "matched_url",
    url,
    title: null,
    richLinkType: null,
    mimeType: null,
    context,
  }, traversal);
}

function stripTrailingUrlPunctuation(url: string): string {
  return url.replace(/[),.;\]]+$/g, "");
}

function collectPlainTextDriveUrls(
  text: string | null,
  context: DriveLinkContextRef,
  entries: DriveLinkEntry[],
  seen: Set<string>,
  options: DriveLinkRetrievalOptions,
  traversal: DriveLinkTraversalState,
): void {
  if (options.includePlainTextUrls === false || !text) {
    return;
  }

  const pattern = /https?:\/\/[^\s<>"']+/g;
  for (const match of text.matchAll(pattern)) {
    if (traversal.plainTextUrlCount >= traversal.maxPlainTextUrls) {
      traversal.cappedPlainTextUrls += 1;
      return;
    }
    traversal.plainTextUrlCount += 1;
    const url = stripTrailingUrlPunctuation(match[0]);
    addDriveLinkEntry(entries, seen, {
      source: "plain_url",
      url,
      title: null,
      richLinkType: null,
      mimeType: null,
      context,
    }, traversal);
  }
}

function collectDriveLinkEntriesFromNode(
  input: unknown,
  context: DriveLinkContextRef,
  entries: DriveLinkEntry[],
  seen: Set<string>,
  options: DriveLinkRetrievalOptions,
  traversal: DriveLinkTraversalState,
  depth = 0,
): void {
  if (depth >= traversal.maxDepth) {
    traversal.truncatedBranches += 1;
    return;
  }

  if (Array.isArray(input)) {
    collectDriveLinkEntriesFromLinks(input, context, entries, seen, options, traversal);
    return;
  }

  const raw = asRecord(input);
  if (!raw) {
    return;
  }
  if (traversal.activeNodes.has(raw)) {
    traversal.truncatedBranches += 1;
    return;
  }
  if (!consumeDriveLinkTraversalNode(traversal)) {
    return;
  }

  traversal.activeNodes.add(raw);
  try {
    collectDriveLinkEntriesFromRecord(raw, context, entries, seen, options, traversal, depth);
  } finally {
    traversal.activeNodes.delete(raw);
  }
}

function collectDriveLinkEntriesFromRecord(
  raw: RawRecord,
  context: DriveLinkContextRef,
  entries: DriveLinkEntry[],
  seen: Set<string>,
  options: DriveLinkRetrievalOptions,
  traversal: DriveLinkTraversalState,
  depth: number,
): void {
  const wrapperOnlyLinks =
    "links" in raw &&
    !("relationship" in raw) &&
    !("ref" in raw) &&
    !("name" in raw) &&
    !("text" in raw) &&
    !("annotations" in raw) &&
    !("matchedUrl" in raw);
  if ("context" in raw || wrapperOnlyLinks) {
    if (raw.links !== undefined) {
      collectDriveLinkEntriesFromLinks(
        raw.links,
        context,
        entries,
        seen,
        options,
        traversal,
      );
    }
    if (raw.message !== undefined) {
      if (driveLinkBranchTraversalClosed(traversal)) {
        abandonDriveLinkBranches(traversal, 1);
      } else {
        collectDriveLinkEntriesFromNode(
          raw.message,
          context,
          entries,
          seen,
          options,
          traversal,
          depth + 1,
        );
      }
    }
    if (raw.context !== undefined) {
      if (driveLinkBranchTraversalClosed(traversal)) {
        abandonDriveLinkBranches(traversal, 1);
      } else {
        collectDriveLinkEntriesFromNode(
          raw.context,
          context,
          entries,
          seen,
          options,
          traversal,
          depth + 1,
        );
      }
    }
    return;
  }

  const relationship = asString(raw.relationship) ?? context.relationship;
  const message = asRecord(raw.message) ?? raw;
  const messageName = messageNameForDriveLinks(message);
  const messageContext = appendDriveLinkPath(
    context,
    relationship,
    messageName,
    traversal,
  );

  if (message !== raw && raw.links !== undefined) {
    collectDriveLinkEntriesFromLinks(
      raw.links,
      messageContext,
      entries,
      seen,
      options,
      traversal,
    );
  }
  collectDriveLinkEntriesFromLinks(
    message.links,
    messageContext,
    entries,
    seen,
    options,
    traversal,
  );
  collectRawDriveLinkAnnotations(
    message.annotations,
    messageContext,
    entries,
    seen,
    traversal,
  );
  collectMatchedUrl(
    message.matchedUrl,
    messageContext,
    entries,
    seen,
    options,
    traversal,
  );
  collectPlainTextDriveUrls(
    asString(message.text) ?? asString(message.formattedText) ?? asString(message.argumentText),
    messageContext,
    entries,
    seen,
    options,
    traversal,
  );

  const childSources = message === raw ? [raw] : [raw, message];
  for (const source of childSources) {
    const children = asArray(source.children);
    for (let index = 0; index < children.length; index += 1) {
      if (driveLinkBranchTraversalClosed(traversal)) {
        abandonDriveLinkBranches(traversal, children.length - index);
        break;
      }
      const child = children[index];
      collectDriveLinkEntriesFromNode(
        child,
        messageContext,
        entries,
        seen,
        options,
        traversal,
        depth + 1,
      );
    }
    const quotedMessages = asArray(source.quotedMessages);
    for (let index = 0; index < quotedMessages.length; index += 1) {
      if (driveLinkBranchTraversalClosed(traversal)) {
        abandonDriveLinkBranches(traversal, quotedMessages.length - index);
        break;
      }
      const child = quotedMessages[index];
      collectDriveLinkEntriesFromNode(
        { relationship: "quoted_message", message: child },
        messageContext,
        entries,
        seen,
        options,
        traversal,
        depth + 1,
      );
    }
    const threadHistory = asArray(source.threadHistory);
    for (let index = 0; index < threadHistory.length; index += 1) {
      if (driveLinkBranchTraversalClosed(traversal)) {
        abandonDriveLinkBranches(traversal, threadHistory.length - index);
        break;
      }
      const child = threadHistory[index];
      collectDriveLinkEntriesFromNode(
        { relationship: "thread_history", message: child },
        messageContext,
        entries,
        seen,
        options,
        traversal,
        depth + 1,
      );
    }

    const quotedMessage = source.quotedMessage;
    if (quotedMessage !== undefined) {
      if (driveLinkBranchTraversalClosed(traversal)) {
        abandonDriveLinkBranches(traversal, 1);
      } else {
        collectDriveLinkEntriesFromNode(
          { relationship: "quoted_message", message: quotedMessage },
          messageContext,
          entries,
          seen,
          options,
          traversal,
          depth + 1,
        );
      }
    }

    const contextNode = asRecord(source.contextNode);
    if (contextNode) {
      const contextChildren = asArray(contextNode.children);
      for (let index = 0; index < contextChildren.length; index += 1) {
        if (driveLinkBranchTraversalClosed(traversal)) {
          abandonDriveLinkBranches(traversal, contextChildren.length - index);
          break;
        }
        const child = contextChildren[index];
        collectDriveLinkEntriesFromNode(
          child,
          messageContext,
          entries,
          seen,
          options,
          traversal,
          depth + 1,
        );
      }
    }
  }
}

function driveFileKindForMimeType(mimeType: string | null): DriveFileKind | null {
  switch (mimeType) {
    case "application/vnd.google-apps.document":
      return "document";
    case "application/vnd.google-apps.spreadsheet":
      return "spreadsheet";
    case "application/vnd.google-apps.presentation":
      return "presentation";
    case "application/vnd.google-apps.drawing":
      return "drawing";
    case "application/vnd.google-apps.folder":
      return "folder";
    default:
      return null;
  }
}

function mimeTypeForDriveFileKind(kind: DriveFileKind): string | null {
  switch (kind) {
    case "document":
      return "application/vnd.google-apps.document";
    case "spreadsheet":
      return "application/vnd.google-apps.spreadsheet";
    case "presentation":
      return "application/vnd.google-apps.presentation";
    case "drawing":
      return "application/vnd.google-apps.drawing";
    case "folder":
      return "application/vnd.google-apps.folder";
    default:
      return null;
  }
}

function decodePathSegment(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function docsKindForPathKind(kind: string | undefined): DriveFileKind {
  switch (kind) {
    case "document":
      return "document";
    case "spreadsheets":
      return "spreadsheet";
    case "presentation":
      return "presentation";
    case "drawings":
      return "drawing";
    default:
      return "unknown";
  }
}

function parseDriveUrl(url: string): ParsedDriveUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      isDriveUrl: false,
      driveFileId: null,
      driveFileKind: "unknown",
      mimeType: null,
      blockedReasons: ["invalid_url"],
    };
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.split("/").filter(Boolean);

  if (host === "docs.google.com") {
    const driveFileKind = docsKindForPathKind(path[0]);
    const idIndex = path.indexOf("d") + 1;
    const publishedUrlWithoutDriveId = idIndex > 0 && path[idIndex] === "e";
    const driveFileId =
      idIndex > 0 && !publishedUrlWithoutDriveId
        ? decodePathSegment(path[idIndex])
        : null;
    const blockedReasons =
      publishedUrlWithoutDriveId
        ? ["published_docs_url_unsupported"]
        : driveFileId && driveFileKind === "unknown"
        ? ["unsupported_docs_file_kind"]
        : driveFileId
        ? []
        : ["drive_file_id_missing"];
    return {
      isDriveUrl: true,
      driveFileId,
      driveFileKind,
      mimeType: mimeTypeForDriveFileKind(driveFileKind),
      blockedReasons,
    };
  }

  if (host !== "drive.google.com") {
    return {
      isDriveUrl: false,
      driveFileId: null,
      driveFileKind: "unknown",
      mimeType: null,
      blockedReasons: [],
    };
  }

  const fileIndex = path.indexOf("file");
  if (fileIndex >= 0 && path[fileIndex + 1] === "d") {
    const driveFileId = decodePathSegment(path[fileIndex + 2]);
    return {
      isDriveUrl: true,
      driveFileId,
      driveFileKind: "blob",
      mimeType: null,
      blockedReasons: driveFileId ? [] : ["drive_file_id_missing"],
    };
  }

  const folderIndex = path.indexOf("folders");
  if (folderIndex >= 0) {
    const driveFileId = decodePathSegment(path[folderIndex + 1]);
    return {
      isDriveUrl: true,
      driveFileId,
      driveFileKind: "folder",
      mimeType: null,
      blockedReasons: ["drive_folder_not_file"],
    };
  }

  const queryFileId = parsed.searchParams.get("id");
  return {
    isDriveUrl: true,
    driveFileId: queryFileId,
    driveFileKind: "blob",
    mimeType: null,
    blockedReasons: queryFileId ? [] : ["drive_file_id_missing"],
  };
}

function driveCandidateFromEntry(
  entry: DriveLinkEntry,
  index: number,
): DriveLinkCandidate | IgnoredDriveLink {
  const parsed = parseDriveUrl(entry.url);
  if (!parsed.isDriveUrl) {
    return {
      source: entry.source,
      url: entry.url,
      reason: "not_google_drive_url",
      context: entry.context,
    };
  }

  const mimeType = entry.mimeType ?? parsed.mimeType;
  const mimeKind = driveFileKindForMimeType(mimeType);
  const driveFileKind = mimeKind ?? parsed.driveFileKind;
  const blockedReasons = new Set(parsed.blockedReasons);

  if (!parsed.driveFileId) {
    blockedReasons.add("drive_file_id_missing");
  }
  if (driveFileKind === "folder") {
    blockedReasons.add("drive_folder_not_file");
  }

  const driveFileId = parsed.driveFileId;
  return {
    kind: "drive_link",
    candidateId: `drive-link:${index}:${driveFileId ?? "missing"}`,
    source: entry.source,
    url: entry.url,
    title: entry.title,
    richLinkType: entry.richLinkType,
    mimeType,
    driveFileId,
    driveFileKind,
    retrievable: blockedReasons.size === 0,
    blockedReasons: [...blockedReasons],
    context: entry.context,
  };
}

function isDriveLinkCandidate(
  result: DriveLinkCandidate | IgnoredDriveLink,
): result is DriveLinkCandidate {
  return "kind" in result && result.kind === "drive_link";
}

function collectDriveLinksWithIgnored(
  input: unknown,
  options: DriveLinkRetrievalOptions = {},
): DriveLinkCollectionResult {
  const normalizedOptions = normalizeDriveLinkOptions(options);
  const entries: DriveLinkEntry[] = [];
  const seen = new Set<string>();
  const traversal = createDriveLinkTraversalState(normalizedOptions);
  collectDriveLinkEntriesFromNode(
    input,
    defaultDriveLinkContext(),
    entries,
    seen,
    normalizedOptions,
    traversal,
  );

  const candidates: DriveLinkCandidate[] = [];
  const ignoredLinks: IgnoredDriveLink[] = [];

  for (const entry of entries) {
    const result = driveCandidateFromEntry(entry, candidates.length);
    if (isDriveLinkCandidate(result)) {
      candidates.push(result);
    } else {
      ignoredLinks.push(result);
    }
  }

  return { candidates, ignoredLinks, traversal };
}

export function collectDriveLinkCandidates(
  input: unknown,
  options: DriveLinkRetrievalOptions = {},
): DriveLinkCandidate[] {
  return collectDriveLinksWithIgnored(input, options).candidates;
}

function cachePlanForDriveLink(
  candidate: DriveLinkCandidate,
  options: DriveLinkRetrievalOptions,
): Record<string, unknown> {
  const cache = options.cache;
  const entry =
    cache?.entriesByCandidateId?.[candidate.candidateId] ??
    (candidate.driveFileId
      ? cache?.entriesByFileId?.[candidate.driveFileId]
      : undefined) ??
    cache?.entriesByUrl?.[candidate.url] ??
    null;

  if (!entry) {
    return {
      status: "miss",
      key: null,
      negative: false,
      reason: null,
      metadata: {},
    };
  }

  const negative = asBoolean(entry.negative) ?? false;
  return {
    status: negative ? "negative_hit" : "hit",
    key: asString(entry.key),
    negative,
    reason: asString(entry.reason),
    metadata: asRecord(entry.metadata) ?? {},
  };
}

function attachmentForDriveLink(
  candidate: DriveLinkCandidate,
  options: DriveLinkRetrievalOptions,
): NormalizedAttachment | null {
  if (
    !candidate.driveFileId ||
    candidate.driveFileKind === "folder" ||
    candidate.blockedReasons.length > 0
  ) {
    return null;
  }

  return normalizeAttachment(
    {
      name: `driveLinks/${candidate.driveFileId}`,
      contentName: candidate.title ?? candidate.driveFileId,
      contentType:
        candidate.mimeType ?? mimeTypeForDriveFileKind(candidate.driveFileKind),
      source: "DRIVE_FILE",
      driveDataRef: {
        driveFileId: candidate.driveFileId,
      },
    },
    {
      policy: options.policy,
      context: {
        messageName: candidate.context.messageName,
        relationship: "drive_link",
        path: candidate.context.path,
      },
    },
  );
}

function fallbackForDriveLink(
  candidate: DriveLinkCandidate,
  cache: Record<string, unknown>,
  driveExportPlan: Record<string, unknown> | null,
): Record<string, unknown> {
  if (cache.status === "negative_hit") {
    return {
      status: "blocked",
      action: "cached_unavailable",
      reason:
        asString(cache.reason) ??
        "A previous Drive link retrieval attempt recorded this content as unavailable.",
    };
  }

  if (candidate.blockedReasons.includes("published_docs_url_unsupported")) {
    return {
      status: "blocked",
      action: "metadata_only",
      reason:
        "Published Docs URLs do not expose a Drive file ID that can be exported by this planner.",
    };
  }

  if (candidate.blockedReasons.includes("unsupported_docs_file_kind")) {
    return {
      status: "blocked",
      action: "metadata_only",
      reason: "Drive link points to an unsupported Google Docs editor file kind.",
    };
  }

  if (candidate.blockedReasons.includes("drive_folder_not_file")) {
    return {
      status: "blocked",
      action: "metadata_only",
      reason:
        "Drive folders are not file content and cannot be exported by this planner.",
    };
  }

  if (!candidate.driveFileId) {
    return {
      status: "blocked",
      action: "metadata_only",
      reason: "Drive link does not expose a file ID that can be exported.",
    };
  }

  if (driveExportPlan && driveExportPlan.status !== "blocked") {
    return {
      status: "ready",
      action: "drive_export",
      reason: "Drive link can be exported with Google Drive user auth.",
    };
  }

  return {
    status: "blocked",
    action: "metadata_only",
    reason: "Drive link content is not currently exportable; render metadata only.",
  };
}

function driveLinkDisplay(candidate: DriveLinkCandidate): string {
  return candidate.title ?? candidate.url;
}

function systemNoteForDriveLink(
  candidate: DriveLinkCandidate,
  fallback: Record<string, unknown>,
  driveExportPlan: Record<string, unknown> | null,
): string {
  const display = candidate.title
    ? `${driveLinkDisplay(candidate)} at ${candidate.url}`
    : candidate.url;
  if (fallback.status === "ready") {
    return `System Note: Drive link ${display} is planned with ${String(
      driveExportPlan?.contentApi ?? "Google Drive",
    )} using Google Drive user auth.`;
  }

  return `System Note: Drive link ${candidate.url} cannot be retrieved: ${String(
    fallback.reason,
  )}`;
}

function traversalLimitSummary(
  traversal: DriveLinkTraversalState,
): Record<string, unknown> | null {
  const truncated =
    traversal.truncatedBranches > 0 ||
    traversal.cappedTraversalNodes > 0 ||
    traversal.cappedLinkScanItems > 0 ||
    traversal.cappedDriveLinks > 0 ||
    traversal.cappedPlainTextUrls > 0;
  if (!truncated) {
    return null;
  }

  return {
    status: "truncated",
    maxTraversalDepth: traversal.maxDepth,
    maxTraversalNodes: traversal.maxTraversalNodes,
    maxLinkScanItems: traversal.maxLinkScanItems,
    maxDriveLinks: traversal.maxDriveLinks,
    maxPlainTextUrls: traversal.maxPlainTextUrls,
    truncatedBranches: traversal.truncatedBranches,
    cappedTraversalNodes: traversal.cappedTraversalNodes,
    cappedLinkScanItems: traversal.cappedLinkScanItems,
    cappedDriveLinks: traversal.cappedDriveLinks,
    cappedPlainTextUrls: traversal.cappedPlainTextUrls,
  };
}

function traversalLimitSystemNote(summary: Record<string, unknown>): string {
  return `System Note: Drive link traversal was capped; skipped ${String(
    summary.truncatedBranches,
  )} deep or cyclic branch(es), ${String(
    summary.cappedTraversalNodes,
  )} traversal node(s), ${String(
    summary.cappedLinkScanItems,
  )} link scan item(s), ${String(
    summary.cappedDriveLinks,
  )} link candidate(s), and ${String(
    summary.cappedPlainTextUrls,
  )} plain-text URL(s).`;
}

export function createDriveLinkRetrievalPlan(
  input: DriveLinkRetrievalPlanInput | unknown,
  optionsOverride: DriveLinkRetrievalOptions = {},
): DriveLinkRetrievalPlan {
  const raw = asRecord(input);
  const inputOptions = asRecord(raw?.options);
  const options = normalizeDriveLinkOptions({
    ...(inputOptions ?? {}),
    ...optionsOverride,
  });
  const sourceInput =
    raw && ("message" in raw || "context" in raw || "links" in raw)
      ? {
          message: raw.message,
          context: raw.context,
          links: raw.links,
        }
      : input;
  const { candidates, ignoredLinks, traversal } = collectDriveLinksWithIgnored(
    sourceInput,
    options,
  );

  const counts = {
    candidates: candidates.length,
    driveExports: 0,
    blocked: 0,
    cacheHits: 0,
    fallbacks: 0,
    ignored: ignoredLinks.length,
  };
  const links = candidates.map((candidate) => {
    const cache = cachePlanForDriveLink(candidate, options);
    const attachment =
      cache.status === "negative_hit" ? null : attachmentForDriveLink(candidate, options);
    const driveExportPlan = attachment
      ? createDriveExportPlan(attachment, {
          targetDirectory: options.targetDirectory,
          exportMimeType: options.exportMimeType,
          enableLiveDrive: options.enableLiveDrive,
          env: options.env,
        })
      : null;
    const fallback = fallbackForDriveLink(candidate, cache, driveExportPlan);
    if (
      fallback.status === "ready" &&
      driveExportPlan &&
      driveExportPlan.status !== "blocked"
    ) {
      counts.driveExports += 1;
    }
    if (fallback.status === "blocked") {
      counts.blocked += 1;
    }
    if (["hit", "negative_hit"].includes(String(cache.status))) {
      counts.cacheHits += 1;
    }
    if (fallback.status !== "ready") {
      counts.fallbacks += 1;
    }
    return {
      candidate,
      cache,
      driveExportPlan,
      fallback,
      systemNote: systemNoteForDriveLink(candidate, fallback, driveExportPlan),
    };
  });

  const traversalSummary = traversalLimitSummary(traversal);
  let status: DriveLinkRetrievalPlan["status"] = "ready";
  if (traversalSummary || counts.fallbacks > 0) {
    status = "partial";
  }
  if (
    !traversalSummary &&
    counts.candidates > 0 &&
    counts.blocked === counts.candidates
  ) {
    status = "blocked";
  }
  const systemNotes = [
    ...links.map((item) => item.systemNote),
    ...(traversalSummary ? [traversalLimitSystemNote(traversalSummary)] : []),
  ];

  return {
    kind: "chat.drive_link_retrieval_plan",
    status,
    summary: `${counts.candidates} Drive link candidates, ${counts.driveExports} ready exports, ${counts.fallbacks} fallback or blocked path${
      counts.fallbacks === 1 ? "" : "s"
    }.`,
    counts,
    links,
    ignoredLinks,
    ...(traversalSummary ? { traversal: traversalSummary } : {}),
    systemNotes,
  };
}

export function createUploadPlan(
  input: UploadPlanInput,
  options: UploadPlanOptions = {},
): Record<string, unknown> {
  const safeFilename = sanitizeFilename(input.filename, "attachment");
  const limits = policyLimits(options.policy);
  const policy = evaluateAttachmentPolicy(
    {
      contentType: input.contentType,
      contentSizeBytes: input.sizeBytes,
      safeFilename,
    },
    options.policy,
  );
  const reasons = [...policy.reasons];

  if (input.sizeBytes !== null && input.sizeBytes > limits.maxUploadBytes) {
    reasons.push("size_exceeds_upload_limit");
  }

  const status = reasons.length > 0 ? "blocked" : "dry_run";
  const gate = liveMediaGate(options);
  const plan: Record<string, unknown> = {
    kind: "upload",
    status,
    dryRun: true,
    canExecuteLive: gate.allowed && status !== "blocked",
    liveGate: gate,
    parent: input.parent,
    safeFilename,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    method: "POST",
    url: `https://chat.googleapis.com/upload/v1/${input.parent}/attachments:upload?uploadType=multipart`,
    uploadProtocol: "simple",
    maxBytes: limits.maxUploadBytes,
    policy: {
      status: reasons.length > 0 ? "blocked" : "allowed",
      reasons,
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
  };

  if (reasons.length > 0) {
    plan.blockedReasons = reasons;
  }

  return plan;
}

function parserKindFor(attachment: NormalizedAttachment): keyof AttachmentParsers | null {
  if (
    attachment.mediaKind === "text" ||
    attachment.mediaKind === "json" ||
    attachment.mediaKind === "pdf" ||
    attachment.mediaKind === "image" ||
    attachment.mediaKind === "audio"
  ) {
    return attachment.mediaKind;
  }

  return null;
}

function withExtraction(
  attachment: NormalizedAttachment,
  result: AttachmentParserResult,
): NormalizedAttachment {
  return {
    ...attachment,
    processing: {
      ...attachment.processing,
      extraction: {
        status: result.status,
        parser: result.parser ?? null,
        text: result.text ?? null,
        reason: result.reason ?? null,
      },
    },
  };
}

export async function parseAttachmentContent(
  attachment: NormalizedAttachment,
  data: unknown,
  options: ParseAttachmentOptions = {},
): Promise<NormalizedAttachment> {
  if (attachment.policy.status === "blocked") {
    return attachment;
  }

  const maxParseBytes = options.maxParseBytes;
  if (
    maxParseBytes !== undefined &&
    (!Number.isSafeInteger(maxParseBytes) || maxParseBytes <= 0)
  ) {
    throw new TypeError("maxParseBytes must be a positive safe integer.");
  }
  const maxExtractedChars = options.maxExtractedChars;
  if (
    maxExtractedChars !== undefined &&
    (!Number.isSafeInteger(maxExtractedChars) || maxExtractedChars <= 0)
  ) {
    throw new TypeError("maxExtractedChars must be a positive safe integer.");
  }
  const inputByteLength = dataByteLength(data);
  if (
    inputByteLength !== null &&
    maxParseBytes !== undefined &&
    inputByteLength > maxParseBytes
  ) {
    return withExtraction(attachment, {
      status: "blocked",
      parser: null,
      text: null,
      reason: `Attachment parser input exceeds the ${maxParseBytes} byte limit.`,
    });
  }
  if (options.scanner) {
    const scan = await options.scanner({ attachment, data });
    if (!scan || (scan.status !== "allowed" && scan.status !== "blocked")) {
      throw new TypeError("Attachment scanner must return an allowed or blocked status.");
    }
    if (scan.status === "blocked") {
      return withExtraction(attachment, {
        status: "blocked",
        parser: null,
        text: null,
        reason: scan.reason ?? "Attachment was blocked by the configured safety scanner.",
      });
    }
  }

  const parserKind = parserKindFor(attachment);
  const parser = parserKind ? options.parsers?.[parserKind] : undefined;

  if (!parser) {
    return withExtraction(attachment, {
      status: "skipped",
      parser: null,
      text: null,
      reason: parserKind
        ? `No ${parserKind} parser registered.`
        : "No parser registered for this attachment type.",
    });
  }

  const result = await parser({ attachment, data });
  if (
    maxExtractedChars !== undefined &&
    typeof result.text === "string" &&
    result.text.length > maxExtractedChars
  ) {
    return withExtraction(attachment, {
      ...result,
      status: "partial",
      text: result.text.slice(0, maxExtractedChars),
      reason: [result.reason, `Extracted text was truncated at ${maxExtractedChars} characters.`]
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .join(" "),
    });
  }
  return withExtraction(attachment, result);
}

function filenamePhrase(attachment: NormalizedAttachment): string {
  if (
    attachment.contentName &&
    attachment.contentName !== attachment.safeFilename
  ) {
    return `${attachment.contentName} as ${attachment.safeFilename}`;
  }

  return attachment.safeFilename;
}

export function renderAttachmentContextParts(
  attachment: NormalizedAttachment,
): AttachmentContextPart[] {
  const size =
    attachment.contentSizeBytes === null
      ? "size unknown"
      : `${attachment.contentSizeBytes} bytes`;
  const contentType = attachment.contentType ?? "unknown content type";
  const source = attachment.source ?? "unknown source";
  const relationship = attachment.context.relationship;
  const extraction = attachment.processing.extraction;
  const transcription = attachment.processing.transcription;
  const parts: AttachmentContextPart[] = [
    {
      type: "system_note",
      text: `System Note: The user attached ${filenamePhrase(
        attachment,
      )} (${contentType}, ${size}) from ${source} in ${relationship}. Extraction status: ${extraction.status}. Transcription status: ${transcription.status}.`,
    },
  ];

  if (extraction.text !== null) {
    parts.push({
      type: "attachment_content",
      status: extraction.status,
      text: extraction.text,
      note: extraction.reason,
    });
    return parts;
  }

  if (transcription.text !== null) {
    parts.push({
      type: "attachment_content",
      status: transcription.status,
      text: transcription.text,
      note: transcription.reason,
    });
    return parts;
  }

  parts.push({
    type: "attachment_content",
    status:
      transcription.status !== "skipped" ? transcription.status : extraction.status,
    text: null,
    note:
      transcription.status !== "skipped"
        ? transcription.reason
        : extraction.reason,
  });

  return parts;
}

function createProvider(
  provider: "openai" | "gemini",
  missingMessage: string,
  defaultModel: string,
  options: TranscriptionProviderOptions,
  defaultClient?: TranscriptionProviderOptions["client"],
): TranscriptionProvider {
  if (!options.apiKey && !options.client) {
    throw new TypeError(missingMessage);
  }

  const model = options.model ?? defaultModel;
  const client = options.client ?? defaultClient;

  return {
    provider,
    model,
    maxBytes: options.maxBytes ?? DEFAULT_TRANSCRIPTION_MAX_BYTES,
    async transcribe({ attachment, data }) {
      if (!client) {
        return {
          status: "blocked",
          text: null,
          reason: `${provider} transcription client is not installed in the base package.`,
        };
      }

      return client({
        attachment,
        data,
        model,
        apiKey: options.apiKey,
      });
    },
  };
}

async function defaultOpenAITranscriptionClient(
  options: TranscriptionProviderOptions,
  input: {
    attachment: NormalizedAttachment;
    data: unknown;
    model: string;
    apiKey?: string;
  },
): Promise<{
  status: ProcessingStatus;
  text?: string | null;
  reason?: string | null;
}> {
  if (!input.apiKey) {
    return {
      status: "blocked",
      text: null,
      reason: "OpenAI transcription requires an explicit apiKey.",
    };
  }
  const bytes = dataBytes(input.data);
  if (!bytes) {
    return {
      status: "blocked",
      text: null,
      reason: "OpenAI transcription requires audio bytes as Uint8Array, ArrayBuffer, or string.",
    };
  }
  const filename = input.attachment.safeFilename || "audio.wav";
  const audioBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const form = new FormData();
  form.set("model", input.model);
  form.set(
    "file",
    new Blob([audioBuffer], {
      type: input.attachment.contentType ?? "application/octet-stream",
    }),
    filename,
  );
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(
    options.endpoint ?? "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { authorization: `Bearer ${input.apiKey}` },
      body: form,
    },
  );
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return {
      status: "failed",
      text: null,
      reason:
        asString(asRecord(json.error)?.message) ??
        `OpenAI transcription failed with HTTP ${response.status}.`,
    };
  }
  return {
    status: "complete",
    text: asString(json.text),
    reason: null,
  };
}

function geminiOutputText(json: RawRecord): string | null {
  const direct =
    asString(json.output_text) ??
    asString(json.outputText) ??
    asString(json.text);
  if (direct !== null) {
    return direct;
  }

  for (const step of asArray(json.steps)) {
    const content = asArray(asRecord(step)?.content);
    for (const part of content) {
      const text = asString(asRecord(part)?.text);
      if (text !== null) {
        return text;
      }
    }
  }

  return null;
}

async function defaultGeminiTranscriptionClient(
  options: TranscriptionProviderOptions,
  input: {
    attachment: NormalizedAttachment;
    data: unknown;
    model: string;
    apiKey?: string;
  },
): Promise<{
  status: ProcessingStatus;
  text?: string | null;
  reason?: string | null;
}> {
  if (!input.apiKey) {
    return {
      status: "blocked",
      text: null,
      reason: "Gemini transcription requires an explicit apiKey.",
    };
  }
  const bytes = dataBytes(input.data);
  if (!bytes) {
    return {
      status: "blocked",
      text: null,
      reason: "Gemini transcription requires audio bytes as Uint8Array, ArrayBuffer, or string.",
    };
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(options.endpoint ?? GEMINI_INTERACTIONS_ENDPOINT, {
    method: "POST",
    headers: {
      "x-goog-api-key": input.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      input: [
        { type: "text", text: GEMINI_TRANSCRIPTION_PROMPT },
        {
          type: "audio",
          data: Buffer.from(bytes).toString("base64"),
          mime_type: input.attachment.contentType ?? "application/octet-stream",
        },
      ],
    }),
  });
  const json = (await response.json().catch(() => ({}))) as RawRecord;
  if (!response.ok) {
    return {
      status: "failed",
      text: null,
      reason:
        asString(asRecord(json.error)?.message) ??
        `Gemini transcription failed with HTTP ${response.status}.`,
    };
  }

  const text = geminiOutputText(json);
  if (text === null) {
    return {
      status: "failed",
      text: null,
      reason: "Gemini transcription response did not include output_text.",
    };
  }

  return {
    status: "complete",
    text,
    reason: null,
  };
}

export function createOpenAITranscriptionProvider(
  options: TranscriptionProviderOptions,
): TranscriptionProvider {
  return createProvider(
    "openai",
    "OpenAI transcription requires an explicit apiKey or client.",
    DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
    options,
    (input) => defaultOpenAITranscriptionClient(options, input),
  );
}

export function createGeminiTranscriptionProvider(
  options: TranscriptionProviderOptions,
): TranscriptionProvider {
  return createProvider(
    "gemini",
    "Gemini transcription requires an explicit apiKey or client.",
    DEFAULT_GEMINI_TRANSCRIPTION_MODEL,
    options,
    (input) => defaultGeminiTranscriptionClient(options, input),
  );
}

export async function transcribeAudio(
  attachment: NormalizedAttachment,
  data: unknown,
  options: TranscribeAudioOptions = {},
): Promise<NormalizedAttachment> {
  if (attachment.mediaKind !== "audio") {
    return attachment;
  }

  if (!options.enabled) {
    return attachment;
  }

  if (!options.provider) {
    return {
      ...attachment,
      processing: {
        ...attachment.processing,
        transcription: {
          status: "blocked",
          provider: null,
          text: null,
          reason: "A transcription provider must be selected explicitly.",
        },
      },
    };
  }

  const bytes = dataBytes(data);
  const maxBytes = options.provider.maxBytes ?? DEFAULT_TRANSCRIPTION_MAX_BYTES;
  const byteLength = bytes?.byteLength ?? attachment.contentSizeBytes;
  if (typeof byteLength === "number" && byteLength > maxBytes) {
    return {
      ...attachment,
      processing: {
        ...attachment.processing,
        transcription: {
          status: "blocked",
          provider: options.provider.provider,
          text: null,
          reason: `Audio is ${byteLength} bytes, exceeding the configured transcription limit of ${maxBytes} bytes.`,
        },
      },
    };
  }

  const result = await options.provider.transcribe({ attachment, data });
  return {
    ...attachment,
    processing: {
      ...attachment.processing,
      transcription: {
        status: result.status,
        provider: options.provider.provider,
        text: result.text ?? null,
        reason: result.reason ?? null,
      },
    },
  };
}

function sha256Hex(input: Uint8Array | string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function summarizeTranscriptionEvidence(
  input: TranscriptionEvidenceInput,
): Record<string, unknown> {
  const bytes = dataBytes(input.data) ?? new Uint8Array();
  const text = input.result.text ?? "";
  const includeTranscriptText = input.includeTranscriptText === true;
  return {
    provider: input.result.provider,
    model:
      input.result.provider === "openai"
        ? DEFAULT_OPENAI_TRANSCRIPTION_MODEL
        : input.result.provider === "gemini"
          ? DEFAULT_GEMINI_TRANSCRIPTION_MODEL
          : input.result.provider,
    status: input.result.status,
    audioSha256: sha256Hex(bytes),
    audioSizeBytes: bytes.byteLength,
    transcriptLength: text.length,
    transcriptSha256: text ? sha256Hex(text) : null,
    transcriptText: includeTranscriptText ? text : null,
    redacted: !includeTranscriptText,
  };
}

function collectPipelineAttachments(
  input: AttachmentPipelineInput,
  options: AttachmentPipelineOptions,
): NormalizedAttachment[] {
  const attachments: NormalizedAttachment[] = [];

  if (input.attachments !== undefined) {
    attachments.push(
      ...normalizeAttachments(input.attachments, { policy: options.policy }),
    );
  }

  if (input.message !== undefined) {
    attachments.push(
      ...normalizeAttachmentsFromMessage(input.message, {
        policy: options.policy,
      }),
    );
  }

  if (input.context !== undefined) {
    attachments.push(
      ...collectAttachmentsFromContext(input.context, { policy: options.policy }),
    );
  }

  return attachments;
}

function attachmentIsDriveBacked(attachment: NormalizedAttachment): boolean {
  return attachment.source === "DRIVE_FILE" || attachment.driveDataRef !== null;
}

function cachePlanForAttachment(
  attachment: NormalizedAttachment,
  options: AttachmentPipelineOptions,
): Record<string, unknown> {
  const lookupKey = attachment.name;
  const cache = options.cache;
  if (!cache) {
    return {
      status: "disabled",
      lookupKey,
      key: null,
      negative: false,
      metadata: {},
    };
  }

  const entry = cache.entriesByAttachmentName?.[lookupKey] ?? null;
  if (!entry?.hit) {
    return {
      status: "miss",
      lookupKey,
      key: null,
      negative: false,
      metadata: {},
    };
  }

  const negative = entry.negative === true;
  return {
    status: negative ? "negative_hit" : "hit",
    lookupKey,
    key: entry.key ?? null,
    negative,
    metadata: entry.metadata ?? {},
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
    ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
  };
}

function parserNameFor(
  mediaKind: MediaKind,
  options: AttachmentPipelineOptions,
): string | null {
  const descriptor = options.parsers?.[mediaKind];
  if (typeof descriptor === "string" && descriptor.trim()) {
    return descriptor;
  }
  if (descriptor && typeof descriptor === "object") {
    return typeof descriptor.name === "string" && descriptor.name.trim()
      ? descriptor.name
      : null;
  }
  if (descriptor === true) {
    return mediaKind;
  }
  return null;
}

function planParserForAttachment(
  attachment: NormalizedAttachment,
  options: AttachmentPipelineOptions,
): Record<string, unknown> {
  if (attachment.policy.status === "blocked") {
    return {
      status: "blocked",
      mediaKind: attachment.mediaKind,
      parser: null,
      reason: "Attachment is blocked by policy.",
    };
  }

  const parserKind = parserKindFor(attachment);
  const parser = parserKind ? parserNameFor(parserKind, options) : null;
  if (parser) {
    return {
      status: "ready",
      mediaKind: attachment.mediaKind,
      parser,
      reason: null,
    };
  }

  return {
    status: "skipped",
    mediaKind: attachment.mediaKind,
    parser: null,
    reason: parserKind
      ? `No ${parserKind} parser registered.`
      : "No parser registered for this attachment type.",
  };
}

function planTranscriptionForAttachment(
  attachment: NormalizedAttachment,
  options: AttachmentPipelineOptions,
): Record<string, unknown> {
  if (attachment.policy.status === "blocked") {
    return {
      status: "skipped",
      provider: null,
      model: null,
      reason: "Attachment is blocked by policy.",
    };
  }

  if (attachment.mediaKind !== "audio") {
    return {
      status: "skipped",
      provider: null,
      model: null,
      reason: "Attachment is not audio.",
    };
  }

  const transcription = options.transcription ?? {};
  if (!transcription.enabled) {
    return {
      status: "disabled",
      provider: null,
      model: null,
      reason: "Audio transcription is disabled by default.",
    };
  }

  if (!transcription.provider) {
    return {
      status: "blocked",
      provider: null,
      model: transcription.model ?? null,
      reason: "A transcription provider must be selected explicitly.",
    };
  }

  const maxBytes = transcription.maxBytes ?? DEFAULT_TRANSCRIPTION_MAX_BYTES;
  if (
    attachment.contentSizeBytes !== null &&
    attachment.contentSizeBytes > maxBytes
  ) {
    return {
      status: "blocked",
      provider: transcription.provider,
      model: transcription.model ?? null,
      reason: `Audio is ${attachment.contentSizeBytes} bytes, exceeding the configured transcription limit of ${maxBytes} bytes.`,
    };
  }

  return {
    status: "ready",
    provider: transcription.provider,
    model: transcription.model ?? null,
    reason: null,
  };
}

function fallbackForAttachment(input: {
  attachment: NormalizedAttachment;
  downloadPlan: Record<string, unknown>;
  driveExportPlan: Record<string, unknown> | null;
  parsePlan: Record<string, unknown>;
  transcriptionPlan: Record<string, unknown>;
}): Record<string, unknown> {
  if (input.attachment.policy.status === "blocked") {
    return {
      status: "blocked",
      action: "metadata_only",
      reason: "Attachment bytes are blocked by policy; render metadata only.",
    };
  }

  if (attachmentIsDriveBacked(input.attachment)) {
    return {
      status: "fallback",
      action: "drive_export_required",
      reason:
        "Drive-backed attachments require Google Drive user auth; use the Drive export plan or render metadata only.",
    };
  }

  if (
    input.attachment.mediaKind === "audio" &&
    input.transcriptionPlan.status !== "ready"
  ) {
    return {
      status: "partial",
      action: "transcription_disabled",
      reason:
        "Audio bytes can be downloaded, but transcription is disabled or unavailable.",
    };
  }

  if (
    input.parsePlan.status === "skipped" &&
    input.attachment.mediaKind !== "unknown"
  ) {
    return {
      status: "partial",
      action: "parser_missing",
      reason: "Attachment bytes can be downloaded, but no parser is registered.",
    };
  }

  if (input.downloadPlan.status !== "blocked") {
    return {
      status: "ready",
      action: "download_chat_media",
      reason: "Chat-hosted media can be downloaded with Chat media.download.",
    };
  }

  if (input.driveExportPlan && input.driveExportPlan.status !== "blocked") {
    return {
      status: "fallback",
      action: "drive_export_required",
      reason:
        "Use the Drive export plan because Chat media.download is unavailable for this attachment.",
    };
  }

  return {
    status: "blocked",
    action: "metadata_only",
    reason: "Attachment bytes are inaccessible; render metadata only.",
  };
}

function sendStrategyForUpload(
  upload: AttachmentPipelineUploadInput,
  uploadPlan: Record<string, unknown>,
): {
  sendStrategy: Record<string, unknown>;
  fallback: Record<string, unknown>;
  systemNote: string;
} {
  const safeFilename = String(uploadPlan.safeFilename ?? "attachment");

  if (uploadPlan.status === "blocked") {
    return {
      sendStrategy: {
        kind: "drive_link_card_fallback",
        requiresSeparateMessage: false,
        reason: "Upload is blocked by attachment policy.",
      },
      fallback: {
        status: "blocked",
        action: "drive_link_card_fallback",
        reason:
          "Upload is blocked; use a Drive link/card fallback or text-only summary.",
      },
      systemNote: `System Note: Upload ${safeFilename} is blocked by policy; use a Drive link/card fallback or text-only summary.`,
    };
  }

  if (upload.sendOptions?.hasAccessoryWidgets) {
    return {
      sendStrategy: {
        kind: "separate_attachment_message",
        requiresSeparateMessage: true,
        reason:
          "Google Chat attachment messages cannot include accessory widgets.",
      },
      fallback: {
        status: "fallback",
        action: "separate_attachment_message",
        reason: "Send accessory widgets and the attachment as separate messages.",
      },
      systemNote: `System Note: Upload ${safeFilename} requires a separate attachment message because Google Chat attachment messages cannot include accessory widgets.`,
    };
  }

  return {
    sendStrategy: {
      kind: "attachment_message",
      requiresSeparateMessage: false,
      reason: "Upload can be attached to the Chat message.",
    },
    fallback: {
      status: "ready",
      action: "upload_attachment_message",
      reason: "Upload can be attached to the Chat message.",
    },
    systemNote: `System Note: Upload ${safeFilename} can be attached to the Chat message after media.upload succeeds.`,
  };
}

function planPipelineUpload(
  upload: AttachmentPipelineUploadInput,
  options: AttachmentPipelineOptions,
): { item: Record<string, unknown>; systemNote: string } {
  const uploadPlan = createUploadPlan(upload, {
    env: options.env,
    enableLiveMedia: options.enableLiveMedia,
    w7Complete: options.w7Complete,
    policy: options.policy,
  });
  const strategy = sendStrategyForUpload(upload, uploadPlan);
  return {
    item: {
      uploadPlan,
      sendStrategy: strategy.sendStrategy,
      fallback: strategy.fallback,
    },
    systemNote: strategy.systemNote,
  };
}

export function planAttachmentPipeline(
  input: AttachmentPipelineInput,
): AttachmentPipelinePlan {
  const options = input.options ?? {};
  const attachments = collectPipelineAttachments(input, options);
  const plannedAttachments = attachments.map((attachment) => {
    const downloadPlan = createDownloadPlan(attachment, {
      targetDirectory: options.targetDirectory,
      env: options.env,
      enableLiveMedia: options.enableLiveMedia,
      w7Complete: options.w7Complete,
    });
    const driveExportPlan = attachmentIsDriveBacked(attachment)
      ? createDriveExportPlan(attachment, {
          targetDirectory:
            options.driveExportDirectory ?? options.targetDirectory,
          env: options.env,
          enableLiveDrive: options.enableLiveDrive,
        })
      : null;
    const parsePlan = planParserForAttachment(attachment, options);
    const transcriptionPlan = planTranscriptionForAttachment(attachment, options);
    const fallback = fallbackForAttachment({
      attachment,
      downloadPlan,
      driveExportPlan,
      parsePlan,
      transcriptionPlan,
    });
    return {
      attachment,
      cache: cachePlanForAttachment(attachment, options),
      downloadPlan,
      driveExportPlan,
      parsePlan,
      transcriptionPlan,
      fallback,
      contextParts: renderAttachmentContextParts(attachment),
    };
  });

  const plannedUploads = (input.uploads ?? []).map((upload) =>
    planPipelineUpload(upload, options),
  );
  const uploadItems = plannedUploads.map((item) => item.item);
  const systemNotes = [
    ...plannedAttachments
      .flatMap((item) => item.contextParts)
      .filter((part) => part.type === "system_note")
      .map((part) => part.text)
      .filter((text): text is string => typeof text === "string"),
    ...plannedUploads.map((item) => item.systemNote),
  ];

  const counts = {
    attachments: plannedAttachments.length,
    uploads: uploadItems.length,
    downloads: plannedAttachments.filter(
      (item) => item.downloadPlan.status !== "blocked",
    ).length,
    driveExports: plannedAttachments.filter(
      (item) => item.driveExportPlan && item.driveExportPlan.status !== "blocked",
    ).length,
    blocked:
      plannedAttachments.filter((item) => item.fallback.status === "blocked")
        .length +
      uploadItems.filter(
        (item) => (item.fallback as Record<string, unknown>).status === "blocked",
      ).length,
    cacheHits: plannedAttachments.filter((item) =>
      ["hit", "negative_hit"].includes(String(item.cache.status)),
    ).length,
    parserReady: plannedAttachments.filter(
      (item) => item.parsePlan.status === "ready",
    ).length,
    transcriptionReady: plannedAttachments.filter(
      (item) => item.transcriptionPlan.status === "ready",
    ).length,
    fallbacks:
      plannedAttachments.filter((item) => item.fallback.status !== "ready")
        .length +
      uploadItems.filter(
        (item) => (item.fallback as Record<string, unknown>).status !== "ready",
      ).length,
  };
  const totalItems = counts.attachments + counts.uploads;
  const status =
    totalItems > 0 && counts.blocked === totalItems
      ? "blocked"
      : counts.fallbacks > 0
        ? "partial"
        : "ready";
  const readyOperations = counts.downloads + counts.driveExports;

  return {
    kind: "chat.attachment_pipeline_plan",
    status,
    summary: `${counts.attachments} attachments, ${counts.uploads} uploads, ${readyOperations} ready operations, ${counts.fallbacks} fallback or blocked paths.`,
    counts,
    attachments: plannedAttachments,
    uploads: uploadItems,
    systemNotes,
  };
}
