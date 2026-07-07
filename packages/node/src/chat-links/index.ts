import crypto from "node:crypto";

type JsonObject = Record<string, unknown>;

export const CHAT_MESSAGES_READONLY_SCOPE =
  "https://www.googleapis.com/auth/chat.messages.readonly";
export const CHAT_SPACES_READONLY_SCOPE =
  "https://www.googleapis.com/auth/chat.spaces.readonly";
export const CHAT_APP_MESSAGES_READONLY_SCOPE =
  "https://www.googleapis.com/auth/chat.app.messages.readonly";
export const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const CHAT_MESSAGE_REVALIDATION_FIELDS = "name,lastUpdateTime,thread.name";
const CHAT_MESSAGE_LIST_REVALIDATION_FIELDS =
  "messages(name,lastUpdateTime,thread.name),nextPageToken";

export type ChatLinkSource =
  | "chat_space_link_data"
  | "rich_link_url"
  | "matched_url"
  | "plain_url";

export type ChatLinkScope = "space" | "thread" | "message" | "unknown";
export type ChatLinkConfidence = "high" | "medium" | "low" | "unknown";
export type ChatLinkParseStatus = "parsed" | "unknown" | "invalid";

export interface ChatLinkContextRef {
  messageName: string | null;
  relationship: string;
  path: string[];
  sender?: ChatLinkSenderIdentity | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  deletedAt?: string | null;
  accessState?: string | null;
}

export interface ChatLinkSenderIdentity {
  displayName: string | null;
  email: string | null;
  resourceName: string | null;
  type: string | null;
  accessState: "available" | "resource_only" | "partial" | "anonymous" | "unknown";
  ambiguityState: "unambiguous" | "ambiguous" | "unresolved";
}

export interface ChatLinkCandidate {
  kind: "chat_link";
  candidateId: string;
  source: ChatLinkSource;
  originalUrl: string | null;
  title: string | null;
  parseStatus: ChatLinkParseStatus;
  confidence: ChatLinkConfidence;
  scope: ChatLinkScope;
  space: string | null;
  thread: string | null;
  message: string | null;
  resourceName: string | null;
  urlShape: string;
  context: ChatLinkContextRef;
  occurrences?: ChatLinkContextRef[];
  warnings: string[];
}

interface ChatLinkCandidateWithCache extends ChatLinkCandidate {
  cache: ChatLinkCacheStatus;
}

export interface ChatLinkCacheKey {
  namespace: "chat_link";
  key: string;
  resourceName: string;
  lastUpdateTime: string | null;
}

export interface ChatLinkCacheEntry {
  hit?: boolean;
  key?: string;
  lastUpdateTime?: string | null;
  reason?: string | null;
}

export interface ChatLinkCacheStatus {
  status: "hit" | "metadata_required" | "unavailable";
  strategy: "resource_last_update_time";
  key: string | null;
  resourceName: string | null;
  lastUpdateTime: string | null;
  revalidateWith: string | null;
}

export interface ChatLinkRetrievalOptions {
  enabled?: boolean;
  authMode?: string;
  allowSpaceLevelContext?: boolean;
  includeRichLinks?: boolean;
  includeMatchedUrls?: boolean;
  includePlainTextUrls?: boolean;
  maxChatLinks?: number;
  maxPlainTextUrls?: number;
  maxTraversalDepth?: number;
  maxTraversalNodes?: number;
  maxLinkScanItems?: number;
  maxPlainTextScanChars?: number;
  maxUrlLength?: number;
  maxOccurrencesPerCandidate?: number;
  maxThreadMessages?: number;
  maxSpaceMessages?: number;
  cache?: {
    entriesByResourceName?: Record<string, ChatLinkCacheEntry>;
  };
}

const CHAT_LINK_OPTION_ALIASES: Record<string, keyof ChatLinkRetrievalOptions> = {
  auth_mode: "authMode",
  allow_space_level_context: "allowSpaceLevelContext",
  include_rich_links: "includeRichLinks",
  include_matched_urls: "includeMatchedUrls",
  include_plain_text_urls: "includePlainTextUrls",
  max_chat_links: "maxChatLinks",
  max_plain_text_urls: "maxPlainTextUrls",
  max_traversal_depth: "maxTraversalDepth",
  max_traversal_nodes: "maxTraversalNodes",
  max_link_scan_items: "maxLinkScanItems",
  max_plain_text_scan_chars: "maxPlainTextScanChars",
  max_url_length: "maxUrlLength",
  max_occurrences_per_candidate: "maxOccurrencesPerCandidate",
  max_thread_messages: "maxThreadMessages",
  max_space_messages: "maxSpaceMessages",
};

const CHAT_LINK_CACHE_ALIASES: Record<string, string> = {
  entries_by_resource_name: "entriesByResourceName",
};

const CHAT_LINK_CACHE_ENTRY_ALIASES: Record<string, string> = {
  last_update_time: "lastUpdateTime",
};

interface ChatLinkCollectionResult {
  candidates: ChatLinkCandidate[];
  traversal: TraversalState;
}

interface TraversalItem {
  value: JsonObject;
  context: ChatLinkContextRef;
  depth: number;
}

interface TraversalState {
  maxChatLinks: number;
  maxPlainTextUrls: number;
  maxTraversalDepth: number;
  maxTraversalNodes: number;
  maxLinkScanItems: number;
  maxPlainTextScanChars: number;
  maxUrlLength: number;
  maxOccurrencesPerCandidate: number;
  candidateCount: number;
  plainTextUrlCount: number;
  plainTextCharsScanned: number;
  traversalNodeCount: number;
  linkScanItemCount: number;
  cappedCandidates: number;
  cappedPlainTextUrls: number;
  cappedPlainTextScanChars: number;
  cappedOversizedUrls: number;
  cappedOccurrences: number;
  cappedTraversalNodes: number;
  cappedLinkScanItems: number;
  nextAnonymousPathId: number;
}

interface ParsedChatLink {
  parseStatus: ChatLinkParseStatus;
  confidence: ChatLinkConfidence;
  scope: ChatLinkScope;
  space: string | null;
  thread: string | null;
  message: string | null;
  resourceName: string | null;
  urlShape: string;
  warnings: string[];
}

interface ChatLinkEntry {
  source: ChatLinkSource;
  originalUrl: string | null;
  title: string | null;
  chatSpaceLinkData: JsonObject | null;
  context: ChatLinkContextRef;
}

function asRecord(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function positiveInteger(value: unknown, fallback: number): number {
  const numberValue = asNumber(value);
  return numberValue !== null && Number.isInteger(numberValue) && numberValue > 0
    ? numberValue
    : fallback;
}

function normalizeOptionBag(options: JsonObject | null): ChatLinkRetrievalOptions {
  if (!options) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(options).map(([key, value]) => {
      const normalizedKey = CHAT_LINK_OPTION_ALIASES[key] ?? key;
      return [normalizedKey, value];
    }),
  ) as ChatLinkRetrievalOptions;
}

function normalizeOptions(
  input: unknown,
  override?: ChatLinkRetrievalOptions,
): ChatLinkRetrievalOptions {
  const raw = asRecord(input);
  const embedded = asRecord(raw?.options);
  return {
    ...normalizeOptionBag(embedded),
    ...normalizeOptionBag(asRecord(override)),
  };
}

function createTraversalState(options: ChatLinkRetrievalOptions): TraversalState {
  return {
    maxChatLinks: positiveInteger(options.maxChatLinks, 200),
    maxPlainTextUrls: positiveInteger(options.maxPlainTextUrls, 200),
    maxTraversalDepth: positiveInteger(options.maxTraversalDepth, 256),
    maxTraversalNodes: positiveInteger(options.maxTraversalNodes, 5000),
    maxLinkScanItems: positiveInteger(options.maxLinkScanItems, 5000),
    maxPlainTextScanChars: positiveInteger(options.maxPlainTextScanChars, 65_536),
    maxUrlLength: positiveInteger(options.maxUrlLength, 2048),
    maxOccurrencesPerCandidate: positiveInteger(options.maxOccurrencesPerCandidate, 50),
    candidateCount: 0,
    plainTextUrlCount: 0,
    plainTextCharsScanned: 0,
    traversalNodeCount: 0,
    linkScanItemCount: 0,
    cappedCandidates: 0,
    cappedPlainTextUrls: 0,
    cappedPlainTextScanChars: 0,
    cappedOversizedUrls: 0,
    cappedOccurrences: 0,
    cappedTraversalNodes: 0,
    cappedLinkScanItems: 0,
    nextAnonymousPathId: 1,
  };
}

function normalizedSpace(spaceId: string): string {
  return `spaces/${spaceId}`;
}

function normalizedThread(spaceId: string, threadId: string): string {
  return `spaces/${spaceId}/threads/${threadId}`;
}

function validSegment(value: string | null): value is string {
  return (
    value !== null &&
    value.length > 0 &&
    /^[A-Za-z0-9_.~:-]+$/.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function numericSegment(value: string | null): value is string {
  return value !== null && /^\d+$/.test(value);
}

function resourceSegments(value: string | null): string[] | null {
  if (!value) {
    return null;
  }
  const segments = value.split("/");
  return segments.every((segment) => validSegment(segment)) ? segments : null;
}

function spaceFromResource(resourceName: string | null): string | null {
  const segments = resourceSegments(resourceName);
  return segments?.[0] === "spaces" && validSegment(segments[1] ?? null)
    ? `spaces/${segments[1]}`
    : null;
}

function decodeUrlSegment(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function validSpaceResource(value: string | null): value is string {
  const segments = resourceSegments(value);
  return segments?.length === 2 && segments[0] === "spaces";
}

function validThreadResource(value: string | null): value is string {
  const segments = resourceSegments(value);
  return (
    segments?.length === 4 &&
    segments[0] === "spaces" &&
    segments[2] === "threads"
  );
}

function validMessageResource(value: string | null): value is string {
  const segments = resourceSegments(value);
  return (
    segments?.length === 4 &&
    segments[0] === "spaces" &&
    segments[2] === "messages"
  );
}

function resourceFor(
  scope: ChatLinkScope,
  space: string | null,
  thread: string | null,
  message: string | null,
): string | null {
  if (scope === "message") {
    return message;
  }
  if (scope === "thread") {
    return thread;
  }
  if (scope === "space") {
    return space;
  }
  return null;
}

function parsedUnknown(): ParsedChatLink {
  return {
    parseStatus: "unknown",
    confidence: "unknown",
    scope: "unknown",
    space: null,
    thread: null,
    message: null,
    resourceName: null,
    urlShape: "unknown_chat_url",
    warnings: [
      "Chat URL shape is not recognized; retained for corpus collection but no API request will be planned.",
    ],
  };
}

function invalidChatSpaceLinkData(warnings: string[]): ParsedChatLink {
  return {
    parseStatus: "invalid",
    confidence: "unknown",
    scope: "unknown",
    space: null,
    thread: null,
    message: null,
    resourceName: null,
    urlShape: "invalid_chat_space_link_data",
    warnings:
      warnings.length > 0
        ? warnings
        : ["chatSpaceLinkData did not contain a canonical space, thread, or message resource."],
  };
}

function parseChatSpaceLinkData(raw: JsonObject): ParsedChatLink | null {
  const message = asString(raw.message);
  const thread = asString(raw.thread);
  const space = asString(raw.space);
  const warnings: string[] = [];
  let normalizedMessageValue: string | null = null;
  let normalizedThreadValue: string | null = null;
  let normalizedSpaceValue: string | null = null;
  const observedSpaces = new Set<string>();

  if (message) {
    if (!validMessageResource(message)) {
      warnings.push("chatSpaceLinkData.message was not a canonical spaces/{space}/messages/{message} resource.");
    } else {
      normalizedMessageValue = message;
      normalizedSpaceValue = spaceFromResource(message);
      if (normalizedSpaceValue) {
        observedSpaces.add(normalizedSpaceValue);
      }
    }
  }
  if (thread) {
    if (!validThreadResource(thread)) {
      warnings.push("chatSpaceLinkData.thread was not a canonical spaces/{space}/threads/{thread} resource.");
    } else {
      normalizedThreadValue = thread;
      const threadSpace = spaceFromResource(thread);
      if (threadSpace) {
        observedSpaces.add(threadSpace);
      }
      normalizedSpaceValue ??= threadSpace;
    }
  }
  if (space) {
    if (!validSpaceResource(space)) {
      warnings.push("chatSpaceLinkData.space was not a canonical spaces/{space} resource.");
    } else {
      observedSpaces.add(space);
      normalizedSpaceValue = space;
    }
  }
  if (observedSpaces.size > 1 && !warnings.includes("chatSpaceLinkData resource names point at different spaces.")) {
    warnings.push("chatSpaceLinkData resource names point at different spaces.");
  }

  if (normalizedMessageValue) {
    return {
      parseStatus: warnings.length ? "invalid" : "parsed",
      confidence: warnings.length ? "unknown" : "high",
      scope: warnings.length ? "unknown" : "message",
      space: warnings.length ? null : normalizedSpaceValue,
      thread: warnings.length ? null : normalizedThreadValue,
      message: warnings.length ? null : normalizedMessageValue,
      resourceName: warnings.length ? null : normalizedMessageValue,
      urlShape: warnings.length ? "invalid_chat_space_link_data" : "chat_space_link_data",
      warnings,
    };
  }
  if (normalizedThreadValue) {
    return {
      parseStatus: warnings.length ? "invalid" : "parsed",
      confidence: warnings.length ? "unknown" : "high",
      scope: warnings.length ? "unknown" : "thread",
      space: warnings.length ? null : normalizedSpaceValue,
      thread: warnings.length ? null : normalizedThreadValue,
      message: null,
      resourceName: warnings.length ? null : normalizedThreadValue,
      urlShape: warnings.length ? "invalid_chat_space_link_data" : "chat_space_link_data",
      warnings,
    };
  }
  if (normalizedSpaceValue) {
    return {
      parseStatus: warnings.length ? "invalid" : "parsed",
      confidence: warnings.length ? "unknown" : "high",
      scope: warnings.length ? "unknown" : "space",
      space: warnings.length ? null : normalizedSpaceValue,
      thread: null,
      message: null,
      resourceName: warnings.length ? null : normalizedSpaceValue,
      urlShape: warnings.length ? "invalid_chat_space_link_data" : "chat_space_link_data",
      warnings,
    };
  }

  return invalidChatSpaceLinkData(warnings);
}

function cleanPathSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

function parseMailHashSpace(url: URL): ParsedChatLink | null {
  if (url.hostname !== "mail.google.com") {
    return null;
  }
  const path = cleanPathSegments(url.pathname);
  const hasMailPrefix = path[0] === "mail" && path[1] === "u";
  const hasChatPrefix = path[0] === "chat" && path[1] === "u";
  const isDocumentedMailPath = hasMailPrefix && path.length === 3 && numericSegment(path[2] ?? null);
  const isObservedChatPath = hasChatPrefix && path.length === 3 && numericSegment(path[2] ?? null);
  if (!isDocumentedMailPath && !isObservedChatPath) {
    return hasMailPrefix || hasChatPrefix ? parsedUnknown() : null;
  }
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const hashParts = hash.split("/").filter(Boolean);
  const rawSpaceSegment = hashParts[2]?.split(/[?#]/, 1)[0] ?? null;
  const spaceSegment = decodeUrlSegment(rawSpaceSegment);
  if (
    hashParts.length !== 3 ||
    hashParts[0] !== "chat" ||
    hashParts[1] !== "space" ||
    !validSegment(spaceSegment)
  ) {
    return parsedUnknown();
  }
  const space = normalizedSpace(spaceSegment);
  return {
    parseStatus: "parsed",
    confidence: isDocumentedMailPath ? "high" : "medium",
    scope: "space",
    space,
    thread: null,
    message: null,
    resourceName: space,
    urlShape: isDocumentedMailPath ? "gmail_hash_space" : "gmail_chat_hash_space",
    warnings: [],
  };
}

function parseChatHostUrl(url: URL): ParsedChatLink | null {
  if (url.hostname !== "chat.google.com") {
    return null;
  }
  const path = cleanPathSegments(url.pathname);

  if (path[0] === "room" && validSegment(path[1] ?? null) && path.length === 2) {
    const space = normalizedSpace(path[1] as string);
    return {
      parseStatus: "parsed",
      confidence: "medium",
      scope: "space",
      space,
      thread: null,
      message: null,
      resourceName: space,
      urlShape: "chat_room_space",
      warnings: [],
    };
  }

  if (
    path[0] === "room" &&
    validSegment(path[1] ?? null) &&
    validSegment(path[2] ?? null) &&
    path.length === 3
  ) {
    const space = normalizedSpace(path[1] as string);
    const thread = normalizedThread(path[1] as string, path[2] as string);
    return {
      parseStatus: "parsed",
      confidence: "low",
      scope: "thread",
      space,
      thread,
      message: null,
      resourceName: thread,
      urlShape: "chat_room_thread",
      warnings: [
        "Thread URL shape is empirical; verify with live corpus before treating as a stable Google contract.",
      ],
    };
  }

  if (
    path[0] === "u" &&
    numericSegment(path[1] ?? null) &&
    path[2] === "app" &&
    path[3] === "chat" &&
    validSegment(path[4] ?? null) &&
    path.length === 5
  ) {
    const space = normalizedSpace(path[4] as string);
    return {
      parseStatus: "parsed",
      confidence: "medium",
      scope: "space",
      space,
      thread: null,
      message: null,
      resourceName: space,
      urlShape: "chat_app_space",
      warnings: [],
    };
  }

  return parsedUnknown();
}

function parseChatUrl(urlValue: string | null): ParsedChatLink | null {
  if (!urlValue) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") {
    return url.hostname === "chat.google.com" || url.hostname === "mail.google.com"
      ? parsedUnknown()
      : null;
  }

  return parseMailHashSpace(url) ?? parseChatHostUrl(url);
}

function cleanOriginalUrl(value: string | null): string | null {
  return value ? value.replace(/[.,;:!?]+$/g, "") : null;
}

function messageNameFromValue(value: JsonObject | null): string | null {
  return asString(value?.ref && asRecord(value.ref)?.name) ?? asString(value?.name);
}

function senderIdentityFromValue(value: JsonObject | null): ChatLinkSenderIdentity | null {
  const raw = asRecord(value?.sender);
  if (!raw) {
    return null;
  }

  const resourceName = asString(raw.resourceName) ?? asString(raw.name);
  const displayName = asString(raw.displayName);
  const email = asString(raw.email);
  const type = asString(raw.type);
  const hasHumanReadable = displayName !== null || email !== null;
  const accessState =
    type === "ANONYMOUS"
      ? "anonymous"
      : resourceName && hasHumanReadable
        ? "available"
        : resourceName
          ? "resource_only"
          : hasHumanReadable
            ? "partial"
            : "unknown";
  const ambiguityState = resourceName
    ? hasHumanReadable
      ? "unambiguous"
      : "unresolved"
    : hasHumanReadable
      ? "ambiguous"
      : "unresolved";

  return {
    displayName,
    email,
    resourceName,
    type,
    accessState,
    ambiguityState,
  };
}

function enrichContextWithSource(
  context: ChatLinkContextRef,
  value: JsonObject | null,
): ChatLinkContextRef {
  const sender = senderIdentityFromValue(value);
  const createdAt = asString(value?.createdAt) ?? asString(value?.createTime);
  const updatedAt = asString(value?.updatedAt) ?? asString(value?.lastUpdateTime);
  const deletedAt = asString(value?.deletedAt) ?? asString(value?.deleteTime);
  const accessState = asString(value?.accessState);

  if (!sender && !createdAt && !updatedAt && !deletedAt && !accessState) {
    return context;
  }

  return {
    ...context,
    sender,
    createdAt,
    updatedAt,
    deletedAt,
    accessState,
  };
}

function childContext(
  parent: ChatLinkContextRef,
  child: JsonObject | null,
  relationship: string,
  traversal: TraversalState,
): ChatLinkContextRef {
  const messageName = messageNameFromValue(child);
  const pathPart =
    messageName !== null
      ? `${relationship}:${messageName}`
      : `${relationship}:node-${traversal.nextAnonymousPathId++}`;
  return {
    ...enrichContextWithSource(
      {
        messageName,
        relationship,
        path: [...parent.path, pathPart],
      },
      child,
    ),
  };
}

function rootContext(value: JsonObject | null): ChatLinkContextRef {
  const messageName = messageNameFromValue(value);
  if (messageName) {
    return enrichContextWithSource(
      {
        messageName,
        relationship: "self",
        path: [`self:${messageName}`],
      },
      value,
    );
  }
  return enrichContextWithSource(
    {
      messageName: null,
      relationship: "input",
      path: ["input"],
    },
    value,
  );
}

function sourceFromKind(kind: string | null, chatSpaceLinkData: JsonObject | null): ChatLinkSource | null {
  if (chatSpaceLinkData) {
    return "chat_space_link_data";
  }
  if (kind === "richLink") {
    return "rich_link_url";
  }
  if (kind === "matchedUrl") {
    return "matched_url";
  }
  if (kind === "plain_url" || kind === "plainUrl") {
    return "plain_url";
  }
  return null;
}

function entryFromLink(raw: JsonObject, context: ChatLinkContextRef): ChatLinkEntry | null {
  const metadata = asRecord(raw.richLinkMetadata);
  const chatSpaceLinkData =
    asRecord(raw.chatSpaceLinkData) ?? asRecord(metadata?.chatSpaceLinkData);
  const source = sourceFromKind(asString(raw.kind), chatSpaceLinkData);
  const originalUrl = cleanOriginalUrl(asString(raw.url) ?? asString(metadata?.uri));
  if (!source || (!originalUrl && !chatSpaceLinkData)) {
    return null;
  }
  return {
    source,
    originalUrl,
    title: asString(raw.title) ?? asString(metadata?.title),
    chatSpaceLinkData,
    context,
  };
}

function entryFromRawAnnotation(raw: JsonObject, context: ChatLinkContextRef): ChatLinkEntry | null {
  if (asString(raw.type) !== "RICH_LINK") {
    return null;
  }
  const metadata = asRecord(raw.richLinkMetadata) ?? {};
  const chatSpaceLinkData = asRecord(metadata.chatSpaceLinkData);
  const originalUrl = cleanOriginalUrl(asString(metadata.uri));
  if (!originalUrl && !chatSpaceLinkData) {
    return null;
  }
  return {
    source: chatSpaceLinkData ? "chat_space_link_data" : "rich_link_url",
    originalUrl,
    title: asString(metadata.title),
    chatSpaceLinkData,
    context,
  };
}

function candidateFromEntry(entry: ChatLinkEntry, candidateId: string): ChatLinkCandidate | null {
  const parsed = entry.chatSpaceLinkData
    ? parseChatSpaceLinkData(entry.chatSpaceLinkData)
    : parseChatUrl(entry.originalUrl);

  if (!parsed) {
    return null;
  }

  return {
    kind: "chat_link",
    candidateId,
    source: entry.source,
    originalUrl: entry.originalUrl,
    title: entry.title,
    parseStatus: parsed.parseStatus,
    confidence: parsed.confidence,
    scope: parsed.scope,
    space: parsed.space,
    thread: parsed.thread,
    message: parsed.message,
    resourceName: parsed.resourceName,
    urlShape: parsed.urlShape,
    context: entry.context,
    warnings: parsed.warnings,
  };
}

function dedupeKeyForCandidate(candidate: ChatLinkCandidate): string {
  if (candidate.resourceName) {
    return candidate.resourceName;
  }
  return `${candidate.urlShape}|${candidate.originalUrl ?? ""}`;
}

function sameContextPath(left: ChatLinkContextRef, right: ChatLinkContextRef): boolean {
  return left.path.length === right.path.length && left.path.every((part, index) => part === right.path[index]);
}

function addOccurrence(
  candidate: ChatLinkCandidate,
  context: ChatLinkContextRef,
  traversal: TraversalState,
): void {
  if (sameContextPath(candidate.context, context)) {
    return;
  }
  candidate.occurrences ??= [candidate.context];
  if (!candidate.occurrences.some((occurrence) => sameContextPath(occurrence, context))) {
    if (candidate.occurrences.length >= traversal.maxOccurrencesPerCandidate) {
      traversal.cappedOccurrences += 1;
      return;
    }
    candidate.occurrences.push(context);
  }
}

function addEntry(
  entry: ChatLinkEntry | null,
  candidates: ChatLinkCandidate[],
  seen: Map<string, ChatLinkCandidate>,
  traversal: TraversalState,
): void {
  if (!entry) {
    return;
  }
  const candidate = candidateFromEntry(entry, "chat-link-pending");
  if (!candidate) {
    return;
  }
  const key = dedupeKeyForCandidate(candidate);
  const existing = seen.get(key);
  if (existing) {
    addOccurrence(existing, candidate.context, traversal);
    return;
  }
  if (traversal.candidateCount >= traversal.maxChatLinks) {
    traversal.cappedCandidates += 1;
    return;
  }
  traversal.candidateCount += 1;
  candidate.candidateId = `chat-link-${traversal.candidateCount}`;
  seen.set(key, candidate);
  candidates.push(candidate);
}

function entryAllowedByOptions(entry: ChatLinkEntry, options: ChatLinkRetrievalOptions): boolean {
  if (entry.source === "matched_url" && options.includeMatchedUrls === false) {
    return false;
  }
  if (entry.source === "plain_url" && options.includePlainTextUrls === false) {
    return false;
  }
  if (
    (entry.source === "rich_link_url" || entry.source === "chat_space_link_data") &&
    options.includeRichLinks === false
  ) {
    return false;
  }
  return true;
}

function consumeScanItem(traversal: TraversalState, remainingItems: number): boolean {
  if (traversal.linkScanItemCount >= traversal.maxLinkScanItems) {
    traversal.cappedLinkScanItems += remainingItems;
    return false;
  }
  traversal.linkScanItemCount += 1;
  return true;
}

const URL_RE = /https?:\/\/[^\s<>"')]+/g;
const URL_DELIMITER_RE = /[\s<>"')]/;

function collectPlainTextUrls(
  text: string | null,
  context: ChatLinkContextRef,
  candidates: ChatLinkCandidate[],
  seen: Map<string, ChatLinkCandidate>,
  traversal: TraversalState,
): void {
  if (!text) {
    return;
  }
  const scanLength = Math.min(text.length, traversal.maxPlainTextScanChars);
  const scanText = text.slice(0, scanLength);
  traversal.plainTextCharsScanned += scanText.length;
  if (text.length > scanText.length) {
    traversal.cappedPlainTextScanChars += text.length - scanText.length;
  }
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(scanText)) !== null) {
    if (traversal.plainTextUrlCount >= traversal.maxPlainTextUrls) {
      traversal.cappedPlainTextUrls += 1;
      return;
    }
    const matchedUrl = match[0];
    const matchEndsAtScanBoundary = match.index + matchedUrl.length === scanText.length;
    const nextOriginalChar = text[scanText.length] ?? "";
    if (
      matchedUrl.length > traversal.maxUrlLength ||
      (matchEndsAtScanBoundary &&
        text.length > scanText.length &&
        !URL_DELIMITER_RE.test(nextOriginalChar))
    ) {
      traversal.cappedOversizedUrls += 1;
      continue;
    }
    traversal.plainTextUrlCount += 1;
    addEntry(
      {
        source: "plain_url",
        originalUrl: cleanOriginalUrl(matchedUrl),
        title: null,
        chatSpaceLinkData: null,
        context,
      },
      candidates,
      seen,
      traversal,
    );
  }
}

function collectFromMessageLike(
  value: JsonObject,
  context: ChatLinkContextRef,
  candidates: ChatLinkCandidate[],
  seen: Map<string, ChatLinkCandidate>,
  options: ChatLinkRetrievalOptions,
  traversal: TraversalState,
): void {
  const links = asArray(value.links);
  for (let index = 0; index < links.length; index += 1) {
    if (!consumeScanItem(traversal, links.length - index)) {
      return;
    }
    const raw = asRecord(links[index]);
    if (!raw) {
      continue;
    }
    const entry = entryFromLink(raw, context);
    if (!entry) {
      continue;
    }
    if (!entryAllowedByOptions(entry, options)) {
      continue;
    }
    addEntry(entry, candidates, seen, traversal);
  }

  const annotations = asArray(value.annotations);
  for (let index = 0; index < annotations.length; index += 1) {
    if (!consumeScanItem(traversal, annotations.length - index)) {
      return;
    }
    const raw = asRecord(annotations[index]);
    if (!raw) {
      continue;
    }
    const entry =
      asString(raw.type) === "RICH_LINK"
        ? entryFromRawAnnotation(raw, context)
        : entryFromLink(raw, context);
    if (!entry) {
      continue;
    }
    if (!entryAllowedByOptions(entry, options)) {
      continue;
    }
    addEntry(entry, candidates, seen, traversal);
  }

  if (options.includeMatchedUrls !== false) {
    const matchedUrl = asRecord(value.matchedUrl);
    const url = asString(matchedUrl?.url);
    if (url) {
      if (!consumeScanItem(traversal, 1)) {
        return;
      }
      addEntry(
        {
          source: "matched_url",
          originalUrl: cleanOriginalUrl(url),
          title: null,
          chatSpaceLinkData: null,
          context,
        },
        candidates,
        seen,
        traversal,
      );
    }
  }

  if (options.includePlainTextUrls !== false) {
    collectPlainTextUrls(asString(value.text), context, candidates, seen, traversal);
  }
}

function rootRecordForInput(input: unknown): JsonObject | null {
  if (Array.isArray(input)) {
    return { links: input };
  }
  return asRecord(input);
}

function pushTraversalChild(
  stack: TraversalItem[],
  traversal: TraversalState,
  parentContext: ChatLinkContextRef,
  child: JsonObject,
  relationship: string,
  depth: number,
): void {
  if (depth > traversal.maxTraversalDepth) {
    traversal.cappedTraversalNodes += 1;
    return;
  }
  if (traversal.traversalNodeCount + stack.length >= traversal.maxTraversalNodes) {
    traversal.cappedTraversalNodes += 1;
    return;
  }
  stack.push({
    value: child,
    context: childContext(parentContext, child, relationship, traversal),
    depth,
  });
}

function pushTraversalChildrenInInputOrder(
  stack: TraversalItem[],
  traversal: TraversalState,
  parentContext: ChatLinkContextRef,
  children: unknown[],
  depth: number,
  relationshipForChild: (child: JsonObject, index: number) => string,
): void {
  if (children.length === 0) {
    return;
  }
  if (depth > traversal.maxTraversalDepth) {
    traversal.cappedTraversalNodes += children.length;
    return;
  }
  const availableSlots = traversal.maxTraversalNodes - traversal.traversalNodeCount - stack.length;
  if (availableSlots <= 0) {
    traversal.cappedTraversalNodes += children.length;
    return;
  }
  const allowedCount = Math.min(children.length, availableSlots);
  traversal.cappedTraversalNodes += children.length - allowedCount;
  for (let index = allowedCount - 1; index >= 0; index -= 1) {
    const childRecord = asRecord(children[index]);
    if (!childRecord) {
      continue;
    }
    stack.push({
      value: childRecord,
      context: childContext(
        parentContext,
        childRecord,
        relationshipForChild(childRecord, index),
        traversal,
      ),
      depth,
    });
  }
}

function isNormalizedMessageAstRoot(value: JsonObject): boolean {
  return asString(value.schemaVersion) === "message-ast.v1";
}

function collectFromValue(
  input: unknown,
  candidates: ChatLinkCandidate[],
  seen: Map<string, ChatLinkCandidate>,
  options: ChatLinkRetrievalOptions,
  traversal: TraversalState,
): void {
  const root = rootRecordForInput(input);
  if (!root) {
    return;
  }

  const visited = new WeakSet<object>();
  const stack: TraversalItem[] = [{ value: root, context: rootContext(root), depth: 1 }];

  while (stack.length > 0) {
    const item = stack.pop() as TraversalItem;
    if (visited.has(item.value)) {
      continue;
    }
    visited.add(item.value);

    if (item.depth > traversal.maxTraversalDepth) {
      traversal.cappedTraversalNodes += 1;
      continue;
    }
    if (traversal.traversalNodeCount >= traversal.maxTraversalNodes) {
      traversal.cappedTraversalNodes += 1;
      continue;
    }
    traversal.traversalNodeCount += 1;

    collectFromMessageLike(item.value, item.context, candidates, seen, options, traversal);

    const nestedMessage = asRecord(item.value.message);
    if (nestedMessage) {
      pushTraversalChild(stack, traversal, item.context, nestedMessage, "message", item.depth + 1);
    }

    pushTraversalChildrenInInputOrder(
      stack,
      traversal,
      item.context,
      asArray(item.value.messages),
      item.depth + 1,
      (_child, index) => `message-${index}`,
    );

    const contextNode = asRecord(item.value.contextNode);
    if (contextNode) {
      if (isNormalizedMessageAstRoot(item.value)) {
        pushTraversalChildrenInInputOrder(
          stack,
          traversal,
          item.context,
          asArray(contextNode.children),
          item.depth + 1,
          (childRecord) => asString(childRecord.relationship) ?? "child",
        );
      } else {
        pushTraversalChild(stack, traversal, item.context, contextNode, "context", item.depth + 1);
      }
    }

    pushTraversalChildrenInInputOrder(
      stack,
      traversal,
      item.context,
      asArray(item.value.children),
      item.depth + 1,
      (childRecord) => asString(childRecord.relationship) ?? "child",
    );
  }
}

function collectChatLinkCandidatesWithTraversal(
  input: unknown,
  options?: ChatLinkRetrievalOptions,
): ChatLinkCollectionResult {
  const effectiveOptions = normalizeOptions(input, options);
  const traversal = createTraversalState(effectiveOptions);
  const candidates: ChatLinkCandidate[] = [];
  if (effectiveOptions.enabled === false) {
    return { candidates, traversal };
  }
  const seen = new Map<string, ChatLinkCandidate>();

  collectFromValue(input, candidates, seen, effectiveOptions, traversal);

  return { candidates, traversal };
}

export function collectChatLinkCandidates(
  input: unknown,
  options?: ChatLinkRetrievalOptions,
): ChatLinkCandidate[] {
  return collectChatLinkCandidatesWithTraversal(input, options).candidates;
}

export function buildChatLinkCacheKey(input: {
  resourceName: string;
  lastUpdateTime?: string | null;
}): ChatLinkCacheKey {
  if (typeof input.resourceName !== "string" || input.resourceName.length === 0) {
    throw new TypeError("Expected resourceName to be a non-empty string.");
  }
  const lastUpdateTime = input.lastUpdateTime ?? null;
  const digest = crypto
    .createHash("sha256")
    .update(`chat_link|${input.resourceName}|${lastUpdateTime ?? ""}`)
    .digest("hex")
    .slice(0, 32);
  return {
    namespace: "chat_link",
    key: `chat-link:${digest}`,
    resourceName: input.resourceName,
    lastUpdateTime,
  };
}

function cacheRevalidateWith(
  candidate: ChatLinkCandidate,
  options: ChatLinkRetrievalOptions,
): string | null {
  if (candidate.scope === "message") {
    return "spaces.messages.get";
  }
  if (candidate.scope === "thread") {
    return "spaces.messages.list";
  }
  if (candidate.scope === "space" && options.allowSpaceLevelContext === true) {
    return "spaces.messages.list";
  }
  return null;
}

function aliasedRecordValue(raw: JsonObject, key: string, aliases: Record<string, string>): unknown {
  if (Object.hasOwn(raw, key)) {
    return raw[key];
  }
  for (const [alias, normalized] of Object.entries(aliases)) {
    if (normalized === key && Object.hasOwn(raw, alias)) {
      return raw[alias];
    }
  }
  return undefined;
}

function cacheEntryForResource(
  options: ChatLinkRetrievalOptions,
  resourceName: string,
): JsonObject | null {
  const cache = asRecord(options.cache);
  if (!cache) {
    return null;
  }
  const entries = asRecord(aliasedRecordValue(cache, "entriesByResourceName", CHAT_LINK_CACHE_ALIASES));
  if (!entries) {
    return null;
  }
  return asRecord(entries[resourceName]);
}

function cacheEntryValue(entry: JsonObject, key: string): unknown {
  return aliasedRecordValue(entry, key, CHAT_LINK_CACHE_ENTRY_ALIASES);
}

function cacheStatusFor(
  candidate: ChatLinkCandidate,
  options: ChatLinkRetrievalOptions,
): ChatLinkCacheStatus {
  if (!candidate.resourceName) {
    return {
      status: "unavailable",
      strategy: "resource_last_update_time",
      key: null,
      resourceName: null,
      lastUpdateTime: null,
      revalidateWith: null,
    };
  }
  const revalidateWith = cacheRevalidateWith(candidate, options);
  const entry = cacheEntryForResource(options, candidate.resourceName);
  if (entry && cacheEntryValue(entry, "hit") === true && revalidateWith) {
    const lastUpdateTime = asString(cacheEntryValue(entry, "lastUpdateTime")) ?? null;
    return {
      status: "hit",
      strategy: "resource_last_update_time",
      key:
        asString(cacheEntryValue(entry, "key")) ??
        buildChatLinkCacheKey({
          resourceName: candidate.resourceName,
          lastUpdateTime,
        }).key,
      resourceName: candidate.resourceName,
      lastUpdateTime,
      revalidateWith,
    };
  }

  return {
    status: revalidateWith ? "metadata_required" : "unavailable",
    strategy: "resource_last_update_time",
    key: null,
    resourceName: candidate.resourceName,
    lastUpdateTime: null,
    revalidateWith,
  };
}

function traversalWasCapped(traversal: TraversalState): boolean {
  return (
    traversal.cappedCandidates > 0 ||
    traversal.cappedPlainTextUrls > 0 ||
    traversal.cappedPlainTextScanChars > 0 ||
    traversal.cappedOversizedUrls > 0 ||
    traversal.cappedOccurrences > 0 ||
    traversal.cappedTraversalNodes > 0 ||
    traversal.cappedLinkScanItems > 0
  );
}

function truncationForTraversal(traversal: TraversalState): JsonObject {
  return {
    status: traversalWasCapped(traversal) ? "truncated" : "complete",
    maxChatLinks: traversal.maxChatLinks,
    maxPlainTextUrls: traversal.maxPlainTextUrls,
    maxTraversalDepth: traversal.maxTraversalDepth,
    maxTraversalNodes: traversal.maxTraversalNodes,
    maxLinkScanItems: traversal.maxLinkScanItems,
    maxPlainTextScanChars: traversal.maxPlainTextScanChars,
    maxUrlLength: traversal.maxUrlLength,
    maxOccurrencesPerCandidate: traversal.maxOccurrencesPerCandidate,
    candidatesVisited: traversal.candidateCount,
    plainTextUrlsScanned: traversal.plainTextUrlCount,
    plainTextCharsScanned: traversal.plainTextCharsScanned,
    traversalNodesVisited: traversal.traversalNodeCount,
    linkScanItemsVisited: traversal.linkScanItemCount,
    cappedCandidates: traversal.cappedCandidates,
    cappedPlainTextUrls: traversal.cappedPlainTextUrls,
    cappedPlainTextScanChars: traversal.cappedPlainTextScanChars,
    cappedOversizedUrls: traversal.cappedOversizedUrls,
    cappedOccurrences: traversal.cappedOccurrences,
    cappedTraversalNodes: traversal.cappedTraversalNodes,
    cappedLinkScanItems: traversal.cappedLinkScanItems,
  };
}

function requestResource(request: JsonObject): string | null {
  return asString(request.resource);
}

function requiredScopesForRequests(authMode: "user" | "app", requests: JsonObject[]): string[] {
  const hasMessageRead = requests.some((request) => {
    const resource = requestResource(request);
    return resource === "spaces.messages.get" || resource === "spaces.messages.list";
  });
  const hasSpaceRead = requests.some((request) => requestResource(request) === "spaces.get");
  const scopes: string[] = [];
  if (authMode === "user") {
    if (hasMessageRead) {
      scopes.push(CHAT_MESSAGES_READONLY_SCOPE);
    }
    if (hasSpaceRead) {
      scopes.push(CHAT_SPACES_READONLY_SCOPE);
    }
    return scopes;
  }
  if (hasMessageRead) {
    scopes.push(CHAT_APP_MESSAGES_READONLY_SCOPE);
  }
  if (hasSpaceRead) {
    scopes.push(CHAT_BOT_SCOPE);
  }
  return scopes;
}

function requestForSpaceGet(candidate: ChatLinkCandidate): JsonObject | null {
  if (!candidate.space) {
    return null;
  }
  return {
    candidateId: candidate.candidateId,
    resource: "spaces.get",
    method: "GET",
    path: `/v1/${candidate.space}`,
    query: {},
    body: null,
    purpose: "read_space_breadcrumb",
  };
}

function hasCacheHit(candidate: ChatLinkCandidate, options: ChatLinkRetrievalOptions): boolean {
  if (!candidate.resourceName || !cacheRevalidateWith(candidate, options)) {
    return false;
  }
  const entry = cacheEntryForResource(options, candidate.resourceName);
  return entry ? cacheEntryValue(entry, "hit") === true : false;
}

function requestForCandidate(
  candidate: ChatLinkCandidate,
  options: ChatLinkRetrievalOptions,
): JsonObject[] {
  if (candidate.parseStatus !== "parsed") {
    return [];
  }

  const requests: JsonObject[] = [];
  const cacheHit = hasCacheHit(candidate, options);
  if (candidate.scope === "message" && candidate.message) {
    requests.push({
      candidateId: candidate.candidateId,
      resource: "spaces.messages.get",
      method: "GET",
      path: `/v1/${candidate.message}`,
      query: cacheHit ? { fields: CHAT_MESSAGE_REVALIDATION_FIELDS } : {},
      body: null,
      purpose: "read_message_or_revalidate_cache",
    });
    const spaceGet = requestForSpaceGet(candidate);
    if (spaceGet) {
      requests.push(spaceGet);
    }
    return requests;
  }

  if (candidate.scope === "thread" && candidate.space && candidate.thread) {
    requests.push({
      candidateId: candidate.candidateId,
      resource: "spaces.messages.list",
      method: "GET",
      path: `/v1/${candidate.space}/messages`,
      query: {
        pageSize: positiveInteger(options.maxThreadMessages, 50),
        filter: `thread.name = "${candidate.thread}"`,
        orderBy: "createTime asc",
        ...(cacheHit ? { fields: CHAT_MESSAGE_LIST_REVALIDATION_FIELDS } : {}),
      },
      body: null,
      purpose: "read_thread_context",
    });
    const spaceGet = requestForSpaceGet(candidate);
    if (spaceGet) {
      requests.push(spaceGet);
    }
    return requests;
  }

  if (candidate.scope === "space" && candidate.space) {
    const spaceGet = requestForSpaceGet(candidate);
    if (spaceGet) {
      requests.push(spaceGet);
    }
    if (options.allowSpaceLevelContext === true) {
      requests.push({
        candidateId: candidate.candidateId,
        resource: "spaces.messages.list",
        method: "GET",
        path: `/v1/${candidate.space}/messages`,
        query: {
          pageSize: positiveInteger(options.maxSpaceMessages, 20),
          orderBy: "createTime desc",
          ...(cacheHit ? { fields: CHAT_MESSAGE_LIST_REVALIDATION_FIELDS } : {}),
        },
        body: null,
        purpose: "read_space_context",
      });
    }
    return requests;
  }

  return [];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function dedupeRequests(requests: JsonObject[]): JsonObject[] {
  const byKey = new Map<string, JsonObject>();
  const output: JsonObject[] = [];
  for (const request of requests) {
    const key = stableStringify({
      resource: request.resource,
      method: request.method,
      path: request.path,
      query: request.query,
      body: request.body,
      purpose: request.purpose,
    });
    const existing = byKey.get(key);
    const candidateId = asString(request.candidateId);
    if (existing) {
      const candidateIds = asArray(existing.candidateIds)
        .map((item) => asString(item))
        .filter((item): item is string => item !== null);
      if (candidateId && !candidateIds.includes(candidateId)) {
        existing.candidateIds = [...candidateIds, candidateId];
      }
      continue;
    }
    if (candidateId) {
      request.candidateIds = [candidateId];
    }
    byKey.set(key, request);
    output.push(request);
  }
  return output;
}

function planStatus(
  candidates: ChatLinkCandidate[],
  requests: JsonObject[],
  isTruncated: boolean,
  capabilityOk: boolean,
): "ready" | "partial" | "blocked" {
  if (!capabilityOk) {
    return "blocked";
  }
  if (candidates.length === 0) {
    return "blocked";
  }
  if (
    isTruncated ||
    requests.length === 0 ||
    candidates.some((candidate) => candidate.parseStatus !== "parsed")
  ) {
    return "partial";
  }
  return "ready";
}

function cacheHitSummary(cacheHits: number): string {
  return `${cacheHits} cache ${cacheHits === 1 ? "hit" : "hits"} can be reused after metadata revalidation.`;
}

export function createChatLinkRetrievalPlan(
  input: unknown,
  options?: ChatLinkRetrievalOptions,
): JsonObject {
  const effectiveOptions = normalizeOptions(input, options);
  const disabled = effectiveOptions.enabled === false;
  const authModeRaw = asString(effectiveOptions.authMode) ?? "user";
  const authModeIsValid = authModeRaw === "user" || authModeRaw === "app";
  const authMode = authModeIsValid ? authModeRaw : null;
  const { candidates, traversal } = collectChatLinkCandidatesWithTraversal(input, effectiveOptions);
  const candidatesWithCache: ChatLinkCandidateWithCache[] = candidates.map((candidate) => ({
    ...candidate,
    cache: cacheStatusFor(candidate, effectiveOptions),
  }));
  const requests = authMode
    ? dedupeRequests(candidates.flatMap((candidate) => requestForCandidate(candidate, effectiveOptions)))
    : [];
  const cacheHits = candidatesWithCache.filter(
    (candidate) => candidate.cache.status === "hit",
  ).length;
  const unknown = candidates.filter((candidate) => candidate.parseStatus !== "parsed").length;
  const parsed = candidates.length - unknown;
  const truncation = truncationForTraversal(traversal);
  const isTruncated = asString(truncation.status) === "truncated";
  const requiredScopes = authMode ? requiredScopesForRequests(authMode, requests) : [];
  const capability = authMode
    ? {
        ok: true,
        authMode,
        requiredScopes,
        requiresAdminApproval:
          authMode === "app" && requiredScopes.includes(CHAT_APP_MESSAGES_READONLY_SCOPE),
        reasons: [],
      }
    : {
        ok: false,
        authMode: authModeRaw,
        requiredScopes: [],
        requiresAdminApproval: false,
        reasons: ["invalid_auth_mode"],
      };
  const status = planStatus(candidates, requests, isTruncated, capability.ok);
  const summary =
    disabled
      ? "Chat link retrieval planning is disabled by option."
      : cacheHits > 0
      ? `Planned ${candidates.length} Google Chat link candidate reads; ${cacheHitSummary(cacheHits)}`
      : `Planned ${candidates.length} Google Chat link candidate reads in dry-run mode.`;
  const truncationWarning = isTruncated
    ? ["System Note: Chat link traversal was capped; some linked Chat context may be omitted."]
    : [];

  return {
    kind: "chat.chat_link_retrieval_plan",
    status,
    dryRun: true,
    summary,
    counts: {
      candidates: candidates.length,
      parsed,
      unknown,
      plannedRequests: requests.length,
      cacheHits,
      cappedCandidates: traversal.cappedCandidates,
      cappedPlainTextUrls: traversal.cappedPlainTextUrls,
      cappedPlainTextScanChars: traversal.cappedPlainTextScanChars,
      cappedOversizedUrls: traversal.cappedOversizedUrls,
      cappedOccurrences: traversal.cappedOccurrences,
      cappedTraversalNodes: traversal.cappedTraversalNodes,
      cappedLinkScanItems: traversal.cappedLinkScanItems,
    },
    truncation,
    candidates: candidatesWithCache,
    requests,
    capability,
    safety: {
      liveAllowed: false,
      notes: ["Dry run only; no Google Chat API call was executed."],
    },
    systemNotes: [
      `System Note: Planned ${candidates.length} linked Google Chat context reads in dry-run mode; no Google Chat API call was executed.`,
      "System Note: Chat link cache keys use resource name plus lastUpdateTime when available so edited messages invalidate cached context.",
      ...(disabled ? ["System Note: Chat link retrieval planning is disabled by option."] : []),
      ...truncationWarning,
    ],
    warnings: candidates.flatMap((candidate) =>
      candidate.warnings.map((warning) => `${candidate.candidateId}: ${warning}`),
    ).concat(isTruncated ? ["Chat link traversal was capped; some linked Chat context may be omitted."] : []),
  };
}
