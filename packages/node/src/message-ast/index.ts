type RawRecord = Record<string, unknown>;

export type MessageAccessState =
  | "available"
  | "metadata_only"
  | "inaccessible"
  | "deleted";

export interface ChatIdentity {
  displayName: string | null;
  email: string | null;
  resourceName: string | null;
  type: string | null;
  accessState: "available" | "resource_only" | "partial" | "anonymous" | "unknown";
  ambiguityState: "unambiguous" | "ambiguous" | "unresolved";
}

export interface MessageContextNode {
  kind: "message" | "attachment" | "gif" | "card";
  relationship: "root" | "quoted_message" | "attachment" | "card";
  ref?: { name: string };
  name?: string | null;
  sender?: ChatIdentity | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  deletedAt?: string | null;
  accessState: MessageAccessState;
  text?: string;
  contentName?: string | null;
  contentType?: string | null;
  source?: string | null;
  mediaResourceName?: string | null;
  uri?: string | null;
  cardId?: string | null;
  title?: string | null;
  systemNotes: string[];
  children: MessageContextNode[];
  plainTextForModel: string;
}

export interface NormalizedMessageAst {
  schemaVersion: "message-ast.v1";
  ref: { name: string };
  space: { name: string; displayName: string | null; type: string | null } | null;
  thread: { name: string } | null;
  sender: ChatIdentity | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  state: {
    deleted: boolean;
    private: boolean;
    threadReply: boolean;
    directMessage: boolean;
  };
  privateMessageViewer: ChatIdentity | null;
  text: string;
  formattedText: string | null;
  argumentText: string | null;
  segments: RawRecord[];
  annotations: RawRecord[];
  links: RawRecord[];
  slashCommand: RawRecord | null;
  customEmojis: RawRecord[];
  attachments: RawRecord[];
  attachedGifs: RawRecord[];
  cards: RawRecord[];
  reactions: RawRecord[];
  systemNotes: string[];
  contextNode: MessageContextNode;
  plainTextForModel: string;
}

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

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeIdentity(value: unknown): ChatIdentity | null {
  const raw = asRecord(value);

  if (!raw) {
    return null;
  }

  const resourceName = asString(raw.name);
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

function normalizeSpace(value: unknown): NormalizedMessageAst["space"] {
  const raw = asRecord(value);
  const name = asString(raw?.name);

  if (!raw || !name) {
    return null;
  }

  return {
    name,
    displayName: asString(raw.displayName),
    type: asString(raw.type),
  };
}

function normalizeThread(value: unknown): NormalizedMessageAst["thread"] {
  const raw = asRecord(value);
  const name = asString(raw?.name);
  return name ? { name } : null;
}

function identityLabel(identity: ChatIdentity | null): string {
  if (!identity) {
    return "Unknown sender (unknown access)";
  }

  const label =
    identity.displayName ?? identity.email ?? identity.resourceName ?? "Unknown sender";
  const withEmail =
    identity.email && identity.email !== label ? `${label} <${identity.email}>` : label;
  const details = [identity.type, identity.resourceName].filter(
    (part): part is string => part !== null,
  );

  if (details.length === 0) {
    return `${withEmail} (${identity.accessState})`;
  }

  return `${withEmail} (${details.join(", ")})`;
}

function validRange(text: string, startIndex: number | null, length: number | null): boolean {
  return (
    startIndex !== null &&
    length !== null &&
    startIndex >= 0 &&
    length >= 0 &&
    startIndex + length <= text.length
  );
}

function commandLabel(command: RawRecord | null): string | null {
  if (!command) {
    return null;
  }

  return asString(command.commandName) ?? asString(command.commandId);
}

function normalizeSlashCommand(raw: RawRecord | null): RawRecord | null {
  if (!raw) {
    return null;
  }

  return {
    commandName: asString(raw.commandName),
    commandId: asString(raw.commandId),
    type: asString(raw.type),
    triggersDialog: asBoolean(raw.triggersDialog),
    bot: normalizeIdentity(raw.bot),
  };
}

function normalizeCustomEmoji(raw: RawRecord | null): RawRecord | null {
  if (!raw) {
    return null;
  }

  return {
    name: asString(raw.name),
    emojiName: asString(raw.emojiName),
    temporaryImageUri: asString(raw.temporaryImageUri),
  };
}

function normalizeChatSpaceLinkData(raw: RawRecord | null): RawRecord | null {
  if (!raw) {
    return null;
  }

  const data: RawRecord = {};
  for (const key of ["space", "thread", "message", "spaceDisplayName"]) {
    const value = asString(raw[key]);
    if (value) {
      data[key] = value;
    }
  }

  return Object.keys(data).length > 0 ? data : null;
}

function richLinkTitle(metadata: RawRecord): string | null {
  const driveData = asRecord(metadata.driveLinkData);
  const chatSpaceData = asRecord(metadata.chatSpaceLinkData);
  return (
    asString(metadata.title) ??
    asString(driveData?.title) ??
    asString(chatSpaceData?.spaceDisplayName)
  );
}

function normalizeAnnotations(text: string, annotations: unknown): RawRecord[] {
  return asArray(annotations).flatMap((item): RawRecord[] => {
    const raw = asRecord(item);
    const rawType = asString(raw?.type);

    if (!raw || !rawType) {
      return [];
    }

    const startIndex = asNumber(raw.startIndex);
    const length = asNumber(raw.length);
    const sourceText = validRange(text, startIndex, length)
      ? text.slice(startIndex ?? 0, (startIndex ?? 0) + (length ?? 0))
      : "";

    if (rawType === "USER_MENTION") {
      const metadata = asRecord(raw.userMention);
      const user = normalizeIdentity(metadata?.user);
      const renderText = `@${user?.displayName ?? user?.email ?? user?.resourceName ?? sourceText}`;

      return [
        {
          kind: "userMention",
          startIndex,
          length,
          text: sourceText,
          renderText,
          user,
          mentionType: asString(metadata?.type),
        } satisfies RawRecord,
      ];
    }

    if (rawType === "SLASH_COMMAND") {
      const slashCommand = normalizeSlashCommand(asRecord(raw.slashCommand));

      return [
        {
          kind: "slashCommand",
          startIndex,
          length,
          text: sourceText,
          renderText: commandLabel(slashCommand) ?? sourceText,
          slashCommand,
        } satisfies RawRecord,
      ];
    }

    if (rawType === "CUSTOM_EMOJI") {
      const metadata = asRecord(raw.customEmojiMetadata);
      const customEmoji = normalizeCustomEmoji(asRecord(metadata?.customEmoji));
      const renderText = asString(customEmoji?.emojiName) ?? sourceText;

      return [
        {
          kind: "customEmoji",
          startIndex,
          length,
          text: sourceText,
          renderText,
          emoji: customEmoji,
        } satisfies RawRecord,
      ];
    }

    if (rawType === "RICH_LINK") {
      const metadata = asRecord(raw.richLinkMetadata) ?? {};
      const renderText = sourceText;
      const chatSpaceLinkData = normalizeChatSpaceLinkData(
        asRecord(metadata.chatSpaceLinkData),
      );
      const annotation: RawRecord = {
        kind: "richLink",
        startIndex,
        length,
        text: sourceText,
        renderText,
        url: asString(metadata.uri),
        richLinkType: asString(metadata.richLinkType),
        mimeType: asString(metadata.mimeType),
        title: richLinkTitle(metadata),
      };
      if (chatSpaceLinkData) {
        annotation.chatSpaceLinkData = chatSpaceLinkData;
      }

      return [annotation];
    }

    return [
      {
        kind: "unknown",
        rawType,
        startIndex,
        length,
        text: sourceText,
        renderText: sourceText,
      } satisfies RawRecord,
    ];
  });
}

function sortAnnotations(annotations: RawRecord[]): RawRecord[] {
  return [...annotations].sort((left, right) => {
    const leftStart = asNumber(left.startIndex) ?? Number.MAX_SAFE_INTEGER;
    const rightStart = asNumber(right.startIndex) ?? Number.MAX_SAFE_INTEGER;
    const startDiff = leftStart - rightStart;

    if (startDiff !== 0) {
      return startDiff;
    }

    const leftLength = asNumber(left.length) ?? 0;
    const rightLength = asNumber(right.length) ?? 0;
    return leftLength - rightLength;
  });
}

function buildSegments(text: string, annotations: RawRecord[]): RawRecord[] {
  const segments: RawRecord[] = [];
  let cursor = 0;

  for (const [annotationIndex, annotation] of sortAnnotations(annotations).entries()) {
    const startIndex = asNumber(annotation.startIndex);
    const length = asNumber(annotation.length);

    if (!validRange(text, startIndex, length)) {
      continue;
    }

    const start = startIndex as number;
    const span = length as number;

    if (start < cursor) {
      continue;
    }

    if (start > cursor) {
      segments.push({
        kind: "text",
        startIndex: cursor,
        length: start - cursor,
        text: text.slice(cursor, start),
      });
    }

    segments.push({
      kind: asString(annotation.kind),
      startIndex: start,
      length: span,
      text: asString(annotation.renderText) ?? asString(annotation.text) ?? "",
      sourceText: asString(annotation.text) ?? "",
      annotationIndex,
    });
    cursor = start + span;
  }

  if (cursor < text.length) {
    segments.push({
      kind: "text",
      startIndex: cursor,
      length: text.length - cursor,
      text: text.slice(cursor),
    });
  }

  return segments;
}

function renderSegments(text: string, segments: RawRecord[]): string {
  if (segments.length === 0) {
    return text;
  }

  return segments.map((segment) => asString(segment.text) ?? "").join("");
}

function normalizeLinks(raw: RawRecord, text: string, annotations: RawRecord[]): RawRecord[] {
  const links: RawRecord[] = [];
  const matchedUrl = asRecord(raw.matchedUrl);
  const matchedUrlValue = asString(matchedUrl?.url);

  if (matchedUrlValue) {
    const startIndex = text.indexOf(matchedUrlValue);
    links.push({
      kind: "matchedUrl",
      url: matchedUrlValue,
      startIndex: startIndex >= 0 ? startIndex : null,
      length: matchedUrlValue.length,
      text: matchedUrlValue,
    });
  }

  for (const annotation of annotations) {
    if (annotation.kind !== "richLink") {
      continue;
    }

    links.push({
      kind: "richLink",
      url: asString(annotation.url),
      startIndex: asNumber(annotation.startIndex),
      length: asNumber(annotation.length),
      text: asString(annotation.text),
      richLinkType: asString(annotation.richLinkType),
      mimeType: asString(annotation.mimeType),
      title: asString(annotation.title),
    });
    const chatSpaceLinkData = asRecord(annotation.chatSpaceLinkData);
    if (chatSpaceLinkData) {
      links[links.length - 1]!.chatSpaceLinkData = chatSpaceLinkData;
    }
  }

  return links.sort((left, right) => {
    const leftStart = asNumber(left.startIndex) ?? Number.MAX_SAFE_INTEGER;
    const rightStart = asNumber(right.startIndex) ?? Number.MAX_SAFE_INTEGER;
    return leftStart - rightStart;
  });
}

function normalizeAttachments(value: unknown): RawRecord[] {
  return asArray(value).flatMap((item) => {
    const raw = asRecord(item);
    const name = asString(raw?.name);

    if (!raw || !name) {
      return [];
    }

    const attachmentDataRef = asRecord(raw.attachmentDataRef);
    const driveDataRef = asRecord(raw.driveDataRef);
    const attachment: RawRecord = {
      name,
      contentName: asString(raw.contentName),
      contentType: asString(raw.contentType),
      source: asString(raw.source),
      mediaResourceName: asString(attachmentDataRef?.resourceName),
      thumbnailUri: asString(raw.thumbnailUri),
    };
    if (driveDataRef) {
      attachment.driveDataRef = {
        ...driveDataRef,
        driveFileId: asString(driveDataRef.driveFileId),
      };
    }
    return [attachment];
  });
}

function normalizeAttachedGifs(value: unknown): RawRecord[] {
  return asArray(value).flatMap((item) => {
    const raw = asRecord(item);
    const uri = asString(raw?.uri);
    return uri ? [{ uri }] : [];
  });
}

function normalizeCards(value: unknown): RawRecord[] {
  return asArray(value).flatMap((item) => {
    const raw = asRecord(item);
    if (!raw) {
      return [];
    }

    const card = asRecord(raw.card);
    const header = asRecord(card?.header);
    return [
      {
        cardId: asString(raw.cardId),
        title: asString(header?.title),
      },
    ];
  });
}

function normalizeEmoji(value: unknown): RawRecord {
  const raw = asRecord(value) ?? {};
  const customEmoji = normalizeCustomEmoji(asRecord(raw.customEmoji));
  const unicode = asString(raw.unicode);
  const label = unicode ?? asString(customEmoji?.emojiName) ?? asString(customEmoji?.name) ?? "unknown emoji";

  return {
    type: unicode ? "unicode" : customEmoji ? "custom" : null,
    label,
    unicode,
    customEmoji,
  };
}

function normalizeReactions(value: unknown): RawRecord[] {
  return asArray(value).flatMap((item) => {
    const raw = asRecord(item);

    if (!raw) {
      return [];
    }

    return [
      {
        emoji: normalizeEmoji(raw.emoji),
        reactionCount: asNumber(raw.reactionCount) ?? 0,
      },
    ];
  });
}

function topLevelSlashCommand(raw: RawRecord, annotations: RawRecord[]): RawRecord | null {
  const topLevel = asRecord(raw.slashCommand);
  const annotation = annotations.find((item) => item.kind === "slashCommand");
  const annotationSlashCommand = asRecord(annotation?.slashCommand);

  if (!topLevel && !annotationSlashCommand) {
    return null;
  }

  return {
    commandName: asString(annotationSlashCommand?.commandName),
    commandId: asString(topLevel?.commandId) ?? asString(annotationSlashCommand?.commandId),
    type: asString(annotationSlashCommand?.type),
    triggersDialog: asBoolean(annotationSlashCommand?.triggersDialog),
    bot: (asRecord(annotationSlashCommand?.bot) as ChatIdentity | null) ?? null,
  };
}

function normalizeCustomEmojis(annotations: RawRecord[]): RawRecord[] {
  return annotations
    .filter((annotation) => annotation.kind === "customEmoji")
    .map((annotation) => ({
      startIndex: asNumber(annotation.startIndex),
      length: asNumber(annotation.length),
      text: asString(annotation.text),
      renderText: asString(annotation.renderText),
      emoji: asRecord(annotation.emoji),
    }));
}

function baseMessageSystemNotes(params: {
  name: string;
  relationship: "root" | "quoted_message";
  sender: ChatIdentity | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  deleted: boolean;
  deletionType: string | null;
  threadReply: boolean;
  thread: { name: string } | null;
  privateMessageViewer: ChatIdentity | null;
  directMessage: boolean;
}): string[] {
  const prefix = params.relationship === "quoted_message" ? "Quoted message" : "Message";
  const created = params.createdAt ?? "unknown time";
  let first = `System Note: ${prefix} ${params.name} from ${identityLabel(
    params.sender,
  )} created at ${created}`;

  if (params.updatedAt && params.updatedAt !== params.createdAt) {
    first += ` and updated at ${params.updatedAt}`;
  }

  first += ".";
  const notes = [first];

  if (params.deleted) {
    const deletedAt = params.deletedAt ?? "an unknown time";
    const reason = params.deletionType ? ` (${params.deletionType})` : "";
    notes.push(`System Note: Message was deleted at ${deletedAt}${reason}.`);
  }

  if (params.threadReply && params.thread) {
    notes.push(`System Note: This message is a thread reply in ${params.thread.name}.`);
  }

  if (params.privateMessageViewer) {
    notes.push(
      `System Note: This message is private to ${identityLabel(params.privateMessageViewer)}.`,
    );
  }

  if (params.directMessage) {
    notes.push("System Note: This message was sent in a direct message space.");
  }

  return notes;
}

function metadataSystemNotes(params: {
  slashCommand: RawRecord | null;
  links: RawRecord[];
  customEmojis: RawRecord[];
  reactions: RawRecord[];
}): string[] {
  const notes: string[] = [];

  if (params.slashCommand) {
    const label =
      asString(params.slashCommand.commandName) ?? asString(params.slashCommand.commandId) ?? "unknown";
    const commandId = asString(params.slashCommand.commandId);
    const bot = asRecord(params.slashCommand.bot) as ChatIdentity | null;
    const idText = commandId && commandId !== label ? ` (${commandId})` : "";
    const botText = bot ? ` for ${identityLabel(bot)}` : "";
    notes.push(`System Note: Slash command ${label}${idText} invoked${botText}.`);
  }

  for (const link of params.links) {
    if (link.kind === "matchedUrl") {
      notes.push(`System Note: Matched URL: ${asString(link.url) ?? "unknown URL"}.`);
      continue;
    }

    const richType = asString(link.richLinkType) ?? "rich link";
    const title = asString(link.title);
    const url = asString(link.url) ?? "unknown URL";
    const mimeType = asString(link.mimeType);
    const titleText = title ? `${title} at ` : "";
    const mimeText = mimeType ? ` (${mimeType})` : "";
    notes.push(`System Note: Rich link ${richType}: ${titleText}${url}${mimeText}.`);
  }

  for (const customEmoji of params.customEmojis) {
    const emoji = asRecord(customEmoji.emoji);
    const label = asString(customEmoji.renderText) ?? asString(emoji?.emojiName) ?? "custom emoji";
    const name = asString(emoji?.name);
    const nameText = name ? ` (${name})` : "";
    notes.push(`System Note: Custom emoji ${label}${nameText} appears in this message.`);
  }

  for (const reaction of params.reactions) {
    const emoji = asRecord(reaction.emoji);
    const label = asString(emoji?.label) ?? "unknown emoji";
    const count = asNumber(reaction.reactionCount) ?? 0;
    const plural = count === 1 ? "reaction" : "reactions";
    notes.push(`System Note: ${count} ${plural} with ${label}.`);
  }

  return notes;
}

function attachmentNode(attachment: RawRecord): MessageContextNode {
  const contentName = asString(attachment.contentName);
  const contentType = asString(attachment.contentType);
  const label = contentName ?? asString(attachment.name) ?? "an attachment";
  const typeText = contentType ? ` (${contentType})` : "";
  const systemNotes = [`System Note: The user attached ${label}${typeText} with this message.`];

  return {
    kind: "attachment",
    relationship: "attachment",
    name: asString(attachment.name),
    contentName,
    contentType,
    source: asString(attachment.source),
    mediaResourceName: asString(attachment.mediaResourceName),
    accessState: "metadata_only",
    systemNotes,
    children: [],
    plainTextForModel: systemNotes.join("\n"),
  };
}

function gifNode(gif: RawRecord): MessageContextNode {
  const uri = asString(gif.uri);
  const systemNotes = [`System Note: The user attached a GIF: ${uri ?? "unknown URI"}.`];

  return {
    kind: "gif",
    relationship: "attachment",
    uri,
    accessState: "metadata_only",
    systemNotes,
    children: [],
    plainTextForModel: systemNotes.join("\n"),
  };
}

function cardNode(card: RawRecord): MessageContextNode {
  const cardId = asString(card.cardId);
  const title = asString(card.title);
  const idText = cardId ? ` ${cardId}` : "";
  const titleText = title ? `: ${title}` : "";
  const systemNotes = [`System Note: Message includes card${idText}${titleText}.`];

  return {
    kind: "card",
    relationship: "card",
    cardId,
    title,
    accessState: "metadata_only",
    systemNotes,
    children: [],
    plainTextForModel: systemNotes.join("\n"),
  };
}

function inaccessibleQuoteNode(metadata: RawRecord): MessageContextNode | null {
  const name = asString(metadata.name);

  if (!name) {
    return null;
  }

  const updatedAt = asString(metadata.lastUpdateTime);
  const updateText = updatedAt ? `; last known update ${updatedAt}` : "";
  const systemNotes = [
    `System Note: Quoted message ${name} was referenced but content is inaccessible${updateText}.`,
  ];

  return {
    kind: "message",
    relationship: "quoted_message",
    ref: { name },
    sender: null,
    createdAt: null,
    updatedAt,
    deletedAt: null,
    accessState: "inaccessible",
    text: "",
    systemNotes,
    children: [],
    plainTextForModel: systemNotes.join("\n"),
  };
}

function renderContextNode(
  systemNotes: string[],
  text: string,
  children: MessageContextNode[],
): string {
  return [...systemNotes, ...(text ? [text] : []), ...children.map((child) => child.plainTextForModel)]
    .filter((line) => line.length > 0)
    .join("\n");
}

function buildContextChildren(
  raw: RawRecord,
  attachments: RawRecord[],
  attachedGifs: RawRecord[],
  cards: RawRecord[],
): MessageContextNode[] {
  const children: MessageContextNode[] = [
    ...attachments.map(attachmentNode),
    ...attachedGifs.map(gifNode),
    ...cards.map(cardNode),
  ];
  const quoteMetadata = asRecord(raw.quotedMessageMetadata);

  if (quoteMetadata) {
    const quotedMessage =
      asRecord(quoteMetadata.message) ??
      asRecord(quoteMetadata.quotedMessage) ??
      quotedSnapshotMessage(quoteMetadata);
    const quoteNode = quotedMessage
      ? buildMessageAst(quotedMessage, "quoted_message").contextNode
      : inaccessibleQuoteNode(quoteMetadata);

    if (quoteNode) {
      children.push(quoteNode);
    }
  }

  return children;
}

function quotedSnapshotMessage(metadata: RawRecord): RawRecord | null {
  const snapshot = asRecord(metadata.quotedMessageSnapshot);
  if (!snapshot) {
    return null;
  }

  const senderName = asString(snapshot.sender);
  const lastUpdateTime = asString(metadata.lastUpdateTime);
  return {
    name: asString(metadata.name),
    createTime: lastUpdateTime,
    sender: senderName
      ? {
          name: senderName,
          displayName: senderName,
          type: "UNKNOWN",
        }
      : undefined,
    text: asString(snapshot.text),
    formattedText: asString(snapshot.formattedText),
    annotations: asArray(snapshot.annotations),
    attachment: asArray(snapshot.attachments),
  };
}

function deletionType(raw: RawRecord): string | null {
  const deletionMetadata = asRecord(raw.deletionMetadata);
  return asString(deletionMetadata?.deletionType);
}

function buildMessageAst(
  raw: RawRecord,
  relationship: "root" | "quoted_message",
): NormalizedMessageAst {
  const name = asString(raw.name);

  if (!name) {
    throw new TypeError("Expected a Google Chat Message object with a name.");
  }

  const text = asString(raw.text) ?? "";
  const annotations = normalizeAnnotations(text, raw.annotations);
  const segments = buildSegments(text, annotations);
  const renderedText = renderSegments(text, segments);
  const links = normalizeLinks(raw, text, annotations);
  const slashCommand = topLevelSlashCommand(raw, annotations);
  const customEmojis = normalizeCustomEmojis(annotations);
  const attachments = normalizeAttachments([
    ...asArray(raw.attachment),
    ...asArray(raw.attachments),
  ]);
  const attachedGifs = normalizeAttachedGifs(raw.attachedGifs);
  const cards = normalizeCards(raw.cardsV2);
  const reactions = normalizeReactions(raw.emojiReactionSummaries);
  const space = normalizeSpace(raw.space);
  const thread = normalizeThread(raw.thread);
  const sender = normalizeIdentity(raw.sender);
  const privateMessageViewer = normalizeIdentity(raw.privateMessageViewer);
  const createdAt = asString(raw.createTime);
  const updatedAt = asString(raw.lastUpdateTime);
  const deletedAt = asString(raw.deleteTime);
  const deleted = deletedAt !== null || raw.deletionMetadata !== undefined;
  const threadReply = asBoolean(raw.threadReply) ?? thread !== null;
  const directMessage = space?.type === "DM";
  const baseNotes = baseMessageSystemNotes({
    name,
    relationship,
    sender,
    createdAt,
    updatedAt,
    deletedAt,
    deleted,
    deletionType: deletionType(raw),
    threadReply,
    thread,
    privateMessageViewer,
    directMessage,
  });
  const systemNotes = [
    ...baseNotes,
    ...metadataSystemNotes({ slashCommand, links, customEmojis, reactions }),
  ];
  const children = buildContextChildren(raw, attachments, attachedGifs, cards);
  const contextNode: MessageContextNode = {
    kind: "message",
    relationship,
    ref: { name },
    sender,
    createdAt,
    updatedAt,
    deletedAt,
    accessState: deleted ? "deleted" : "available",
    text: deleted ? "" : renderedText,
    systemNotes,
    children,
    plainTextForModel: renderContextNode(systemNotes, deleted ? "" : renderedText, children),
  };

  return {
    schemaVersion: "message-ast.v1",
    ref: { name },
    space,
    thread,
    sender,
    createdAt,
    updatedAt,
    deletedAt,
    state: {
      deleted,
      private: privateMessageViewer !== null,
      threadReply,
      directMessage,
    },
    privateMessageViewer,
    text,
    formattedText: asString(raw.formattedText),
    argumentText: asString(raw.argumentText),
    segments,
    annotations,
    links,
    slashCommand,
    customEmojis,
    attachments,
    attachedGifs,
    cards,
    reactions,
    systemNotes,
    contextNode,
    plainTextForModel: contextNode.plainTextForModel,
  };
}

export function normalizeMessage(input: unknown): NormalizedMessageAst {
  const raw = asRecord(input);

  if (!raw) {
    throw new TypeError("Expected a Google Chat Message object.");
  }

  return buildMessageAst(raw, "root");
}
