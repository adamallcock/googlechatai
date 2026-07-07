import { Buffer } from "node:buffer";

import type {
  ChatEventEnvelope,
  ChatEventKind,
  ChatEventSource,
  ChatSpaceRef,
  ChatThreadRef,
  ChatUserRef,
  NormalizeEventOptions,
  NormalizedAction,
  NormalizedMessage,
} from "./types.js";
import { normalizeAction as normalizeChatAction } from "./actions/index.js";
import { normalizeMessage as normalizeMessageAst } from "./message-ast/index.js";

type RawRecord = Record<string, unknown>;

type TransportSnapshot = {
  kind: "direct" | "pubsub" | "workspace_events";
  pubsubMessageId: string | null;
  pubsubPublishTime: string | null;
  pubsubSubscription: string | null;
  pubsubDeliveryAttempt: string | null;
  workspaceEventId: string | null;
  workspaceEventType: string | null;
  workspaceEventSource: string | null;
  workspaceEventSubject: string | null;
};

type UnwrappedEvent = {
  event: RawRecord;
  source: ChatEventSource;
  transport: TransportSnapshot;
};

export class InvalidChatEventError extends TypeError {
  constructor(message = "Expected a Google Chat event object.") {
    super(message);
    this.name = "InvalidChatEventError";
  }
}

function asRecord(value: unknown): RawRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function defaultTransport(kind: TransportSnapshot["kind"]): TransportSnapshot {
  return {
    kind,
    pubsubMessageId: null,
    pubsubPublishTime: null,
    pubsubSubscription: null,
    pubsubDeliveryAttempt: null,
    workspaceEventId: null,
    workspaceEventType: null,
    workspaceEventSource: null,
    workspaceEventSubject: null,
  };
}

function decodeBase64Json(data: string): RawRecord | null {
  try {
    return asRecord(JSON.parse(Buffer.from(data, "base64").toString("utf8")));
  } catch {
    return null;
  }
}

function isWorkspaceEventType(value: string | null): boolean {
  return value?.startsWith("google.workspace.chat.") ?? false;
}

function workspaceEventFromCloudEvent(raw: RawRecord): RawRecord {
  const data = asRecord(raw.data) ?? {};
  return {
    type: raw.type,
    eventTime: raw.time,
    id: raw.id,
    source: raw.source,
    subject: raw.subject,
    data,
    message: data.message,
    reaction: data.reaction,
    membership: data.membership,
    space: data.space,
    user: data.user,
  };
}

function unwrapEvent(raw: RawRecord, options: NormalizeEventOptions): UnwrappedEvent {
  const sourceOverride = options.source;
  const pubsubMessage = asRecord(raw.message);
  const pubsubData = asString(pubsubMessage?.data);

  if (pubsubMessage && pubsubData) {
    const attributes = asRecord(pubsubMessage.attributes) ?? {};
    const cloudEventType = asString(attributes["ce-type"]);
    const decoded = decodeBase64Json(pubsubData) ?? {};
    const isWorkspace = isWorkspaceEventType(cloudEventType);
    const event = isWorkspace
      ? {
          type: cloudEventType,
          eventTime: asString(attributes["ce-time"]) ?? asString(pubsubMessage.publishTime),
          id: asString(attributes["ce-id"]),
          source: asString(attributes["ce-source"]),
          subject: asString(attributes["ce-subject"]),
          data: decoded,
          message: decoded.message,
          reaction: decoded.reaction,
          membership: decoded.membership,
          space: decoded.space,
          user: decoded.user,
        }
      : decoded;

    return {
      event,
      source: sourceOverride ?? (isWorkspace ? "workspace_events" : "pubsub"),
      transport: {
        ...defaultTransport(isWorkspace ? "workspace_events" : "pubsub"),
        pubsubMessageId: asString(pubsubMessage.messageId),
        pubsubPublishTime: asString(pubsubMessage.publishTime),
        pubsubSubscription: asString(raw.subscription),
        pubsubDeliveryAttempt: asString(attributes.googclient_deliveryattempt),
        workspaceEventId: isWorkspace ? asString(attributes["ce-id"]) : null,
        workspaceEventType: isWorkspace ? cloudEventType : null,
        workspaceEventSource: isWorkspace ? asString(attributes["ce-source"]) : null,
        workspaceEventSubject: isWorkspace ? asString(attributes["ce-subject"]) : null,
      },
    };
  }

  const rawKind = asString(raw.type);
  if (isWorkspaceEventType(rawKind) && asRecord(raw.data)) {
    return {
      event: workspaceEventFromCloudEvent(raw),
      source: sourceOverride ?? "workspace_events",
      transport: {
        ...defaultTransport("workspace_events"),
        workspaceEventId: asString(raw.id),
        workspaceEventType: rawKind,
        workspaceEventSource: asString(raw.source),
        workspaceEventSubject: asString(raw.subject),
      },
    };
  }

  return {
    event: raw,
    source: sourceOverride ?? "chat_http",
    transport: defaultTransport("direct"),
  };
}

function normalizeUser(value: unknown): ChatUserRef | null {
  const raw = asRecord(value);
  const name = asString(raw?.name) ?? asString(raw?.resourceName);

  if (!raw || !name) {
    return null;
  }

  const displayName = asString(raw.displayName);
  const email = asString(raw.email) ?? asString(raw.emailAddress);
  const type = asString(raw.type);
  const isApp = type === "BOT" || type === "APP" || raw.isBot === true;
  const rawAccessState = asString(raw.accessState);
  const access =
    rawAccessState === "resource_only" || rawAccessState === "unknown"
      ? {
          status: "access_limited",
          reason: "display_name_or_email_unavailable",
        }
      : rawAccessState === "anonymous"
        ? {
            status: "access_limited",
            reason: "anonymous_user",
          }
        : displayName || email
          ? { status: "available", reason: null }
          : {
              status: "access_limited",
              reason: "display_name_or_email_unavailable",
            };

  return {
    name,
    displayName,
    email,
    type,
    isApp,
    access,
  } as ChatUserRef;
}

function normalizeSpace(value: unknown): ChatSpaceRef | null {
  const raw = asRecord(value);
  const name = asString(raw?.name);

  if (!raw || !name) {
    return null;
  }

  return {
    name,
    displayName: asString(raw.displayName),
    type: asString(raw.type),
    spaceType: asString(raw.spaceType),
  } as ChatSpaceRef;
}

function normalizeThread(value: unknown): ChatThreadRef | null {
  const raw = asRecord(value);
  const name = asString(raw?.name);
  return name ? ({ name, threadKey: asString(raw?.threadKey) } as ChatThreadRef) : null;
}

function normalizeMessage(value: unknown): NormalizedMessage | null {
  const raw = asRecord(value);
  const name = asString(raw?.name);

  if (!raw || !name) {
    return null;
  }

  return normalizeMessageAst(raw);
}

function normalizeReaction(value: unknown): RawRecord | null {
  const raw = asRecord(value);
  const name = asString(raw?.name);

  if (!raw || !name) {
    return null;
  }

  const emoji = asRecord(raw.emoji);
  const messageName = asString(raw.message);

  return {
    ref: { name },
    user: normalizeUser(raw.user),
    emoji: {
      unicode: asString(emoji?.unicode),
      customEmoji: asRecord(emoji?.customEmoji) ?? null,
    },
    messageRef: messageName ? { name: messageName } : null,
    createdAt: asString(raw.createTime),
    deletedAt: asString(raw.deleteTime),
  };
}

function normalizeMembership(value: unknown): RawRecord | null {
  const raw = asRecord(value);
  const name = asString(raw?.name);

  if (!raw || !name) {
    return null;
  }

  return {
    ref: { name },
    state: asString(raw.state),
    member: normalizeUser(raw.member),
    createdAt: asString(raw.createTime),
    deletedAt: asString(raw.deleteTime),
  };
}

function normalizeDialog(event: RawRecord): RawRecord | null {
  const eventType = asString(event.dialogEventType);
  return eventType ? { eventType } : null;
}

function spaceIsDirect(space: ChatSpaceRef | null): boolean {
  const typedSpace = space as (ChatSpaceRef & { spaceType?: string | null }) | null;
  return space?.type === "DM" || typedSpace?.spaceType === "DIRECT_MESSAGE";
}

function messageMentionsApp(message: NormalizedMessage | null): boolean {
  return (
    message?.annotations.some((annotation) => {
      if (annotation.kind !== "userMention") {
        return false;
      }

      const user = asRecord(annotation.user);
      const type = asString(user?.type);
      return type === "BOT" || type === "APP";
    }) ?? false
  );
}

function classifyEvent(
  rawKind: string | null,
  rawMessage: RawRecord | null,
  message: NormalizedMessage | null,
  space: ChatSpaceRef | null,
): ChatEventKind {
  if (rawKind === "MESSAGE") {
    if (asRecord(rawMessage?.slashCommand)) {
      return "message.slash_command";
    }
    if (message?.state.directMessage || spaceIsDirect(space)) {
      return "message.direct";
    }
    if (messageMentionsApp(message)) {
      return "message.mentioned_app";
    }
    if (message?.state.threadReply) {
      return "message.thread_reply";
    }
    return "message.created";
  }

  if (rawKind === "APP_COMMAND") {
    return "message.app_command";
  }
  if (rawKind === "ADDED_TO_SPACE") {
    return "space.added";
  }
  if (rawKind === "REMOVED_FROM_SPACE") {
    return "space.removed";
  }
  if (rawKind === "CARD_CLICKED") {
    return "card.clicked";
  }
  if (rawKind === "WIDGET_UPDATED") {
    return "widget.updated";
  }

  switch (rawKind) {
    case "google.workspace.chat.message.v1.created":
      return "message.created";
    case "google.workspace.chat.message.v1.updated":
      return "message.updated";
    case "google.workspace.chat.message.v1.deleted":
      return "message.deleted";
    case "google.workspace.chat.reaction.v1.created":
      return "reaction.created";
    case "google.workspace.chat.reaction.v1.deleted":
      return "reaction.deleted";
    case "google.workspace.chat.membership.v1.created":
      return "membership.created";
    case "google.workspace.chat.membership.v1.updated":
      return "membership.updated";
    case "google.workspace.chat.membership.v1.deleted":
      return "membership.deleted";
    case "google.workspace.chat.space.v1.updated":
      return "space.updated";
    case "google.workspace.chat.space.v1.deleted":
      return "space.deleted";
    default:
      return "event.unknown";
  }
}

function refineCardKind(kind: ChatEventKind, event: RawRecord): ChatEventKind {
  if (kind !== "card.clicked") {
    return kind;
  }

  switch (asString(event.dialogEventType)) {
    case "REQUEST_DIALOG":
      return "dialog.opened";
    case "SUBMIT_DIALOG":
      return "dialog.submitted";
    case "CANCEL_DIALOG":
      return "dialog.cancelled";
    default:
      return kind;
  }
}

function resourceNameFor(
  message: NormalizedMessage | null,
  reaction: RawRecord | null,
  membership: RawRecord | null,
  space: ChatSpaceRef | null,
  action: NormalizedAction | null,
): string | null {
  return (
    message?.ref.name ??
    asString(asRecord(reaction?.ref)?.name) ??
    asString(asRecord(membership?.ref)?.name) ??
    space?.name ??
    (action as (NormalizedAction & { actionId?: string }) | null)?.actionId ??
    null
  );
}

function eventIdFor(
  source: ChatEventSource,
  rawKind: string | null,
  resourceName: string | null,
  receivedAt: string,
  transport: TransportSnapshot,
): string {
  if (source === "pubsub" && transport.pubsubMessageId) {
    return `pubsub:${transport.pubsubMessageId}`;
  }
  if (source === "workspace_events" && transport.workspaceEventId) {
    return `workspace_events:${transport.workspaceEventId}`;
  }
  return `${source}:${rawKind ?? "UNKNOWN"}:${resourceName ?? "no-resource"}:${receivedAt}`;
}

function normalizeLocale(event: RawRecord): string | null {
  const common = asRecord(event.common);
  return asString(common?.userLocale) ?? asString(common?.locale);
}

function normalizeTimeZone(event: RawRecord): string | null {
  const common = asRecord(event.common);
  const timeZone = asRecord(common?.timeZone);
  return asString(timeZone?.id) ?? asString(common?.timeZone);
}

function authContextFor(source: ChatEventSource): RawRecord {
  return {
    authType: null,
    scopes: [],
    responseMode:
      source === "chat_http" || source === "fixture"
        ? "sync"
        : source === "pubsub"
          ? "async"
          : "none",
  };
}

function capabilitiesFor(
  source: ChatEventSource,
  kind: ChatEventKind,
  thread: ChatThreadRef | null,
): RawRecord {
  const isSync = source === "chat_http" || source === "fixture";
  const isCardInteraction =
    kind === "card.clicked" ||
    kind === "dialog.opened" ||
    kind === "dialog.submitted" ||
    kind === "dialog.cancelled" ||
    kind === "widget.updated";

  return {
    canRespondSynchronously: isSync,
    canRespondAsynchronously: source === "pubsub" || isSync,
    canReplyInThread: thread !== null,
    canOpenDialog: isSync && kind === "card.clicked",
    canUpdateCard: isSync && isCardInteraction,
  };
}

function actorLabel(actor: ChatUserRef | null): string {
  return actor?.displayName ?? actor?.email ?? actor?.name ?? "Unknown actor";
}

function spaceLabel(space: ChatSpaceRef | null): string {
  return space?.displayName ?? space?.name ?? "an unknown space";
}

function systemNotesFor(
  kind: ChatEventKind,
  actor: ChatUserRef | null,
  space: ChatSpaceRef | null,
  action: NormalizedAction | null,
  reaction: RawRecord | null,
): string[] {
  const who = actorLabel(actor);
  const where = spaceLabel(space);

  if (kind === "message.slash_command") {
    return [`${who} invoked slash command ${action?.methodName ?? "unknown"}.`];
  }
  if (kind === "message.app_command") {
    return [`${who} invoked app command ${action?.methodName ?? "unknown"}.`];
  }
  if (kind === "message.direct") {
    return [`${who} sent a direct message.`];
  }
  if (kind === "message.thread_reply") {
    return [`${who} sent a thread reply in ${where}.`];
  }
  if (kind === "message.updated") {
    return [`A message in ${where} was edited.`];
  }
  if (kind === "message.deleted") {
    return [`A message in ${where} was deleted.`];
  }
  if (kind === "space.added") {
    return [`The Chat app was added to ${where} by ${who}.`];
  }
  if (kind === "space.removed") {
    return [`The Chat app was removed from ${where} by ${who}.`];
  }
  if (kind === "card.clicked") {
    return [`${who} clicked card action ${action?.methodName ?? "unknown"} in ${where}.`];
  }
  if (kind === "dialog.submitted") {
    return [`${who} submitted dialog action ${action?.methodName ?? "unknown"} in ${where}.`];
  }
  if (kind === "widget.updated") {
    return [`${who} updated widget ${action?.methodName ?? "unknown"} in ${where}.`];
  }
  if (kind === "reaction.created" || kind === "reaction.deleted") {
    const emoji = asString(asRecord(reaction?.emoji)?.unicode) ?? "a reaction";
    return [`${who} ${kind === "reaction.created" ? "added" : "removed"} ${emoji}.`];
  }
  if (kind.startsWith("membership.")) {
    return [`Membership changed in ${where}.`];
  }
  if (kind === "message.created") {
    return [`${who} sent a message in ${where}.`];
  }

  return [];
}

function relationshipFor(
  kind: ChatEventKind,
  message: NormalizedMessage | null,
  action: NormalizedAction | null,
  reaction: RawRecord | null,
  actor: ChatUserRef | null,
  space: ChatSpaceRef | null,
): RawRecord {
  const isCardAction =
    kind === "card.clicked" ||
    kind === "dialog.opened" ||
    kind === "dialog.submitted" ||
    kind === "dialog.cancelled" ||
    kind === "widget.updated";
  const quotedMessage =
    message?.contextNode.children.find((child) => child.relationship === "quoted_message") ??
    null;
  const quotedMessageRef = asRecord(quotedMessage?.ref);

  return {
    isQuote: Boolean(quotedMessage),
    isDirectReply: Boolean(asString(quotedMessageRef?.name) ?? quotedMessage?.name),
    isThreadReply: Boolean(message?.state.threadReply),
    isCardAction,
    isReaction: kind === "reaction.created" || kind === "reaction.deleted",
    isEdit: kind === "message.updated",
    isDeletion: kind === "message.deleted" || Boolean(message?.state.deleted),
    isMembershipEvent: kind.startsWith("membership."),
    isSpaceEvent: kind.startsWith("space."),
    isUserAction: Boolean(action) || kind.startsWith("message.") || kind.startsWith("reaction."),
    systemNotes: systemNotesFor(kind, actor, space, action, reaction),
  };
}

function actorCandidateFor(
  source: ChatEventSource,
  event: RawRecord,
  message: NormalizedMessage | null,
  reaction: RawRecord | null,
  membership: RawRecord | null,
): unknown {
  if (source === "workspace_events") {
    return reaction?.user ?? membership?.member ?? message?.sender ?? event.user;
  }

  return event.user ?? message?.sender;
}

export function normalizeEvent(
  input: unknown,
  options: NormalizeEventOptions = {},
): ChatEventEnvelope {
  const raw = asRecord(input);

  if (!raw) {
    throw new InvalidChatEventError();
  }

  const { event, source, transport } = unwrapEvent(raw, options);
  const rawKind = asString(event.type);
  const rawMessage = asRecord(event.message);
  const message = normalizeMessage(rawMessage);
  const reaction = normalizeReaction(event.reaction);
  const membership = normalizeMembership(event.membership);
  const space = normalizeSpace(event.space ?? rawMessage?.space);
  const thread = message?.thread ?? normalizeThread(event.thread);
  const action = normalizeChatAction(event, { source });
  const kind =
    action?.actionType === "widget_update"
      ? "widget.updated"
      : refineCardKind(classifyEvent(rawKind, rawMessage, message, space), event);
  const actorCandidate = actorCandidateFor(source, event, message, reaction, membership);
  const actor = normalizeUser(actorCandidate);
  const receivedAt =
    options.receivedAt ??
    asString(event.eventTime) ??
    asString(event.time) ??
    transport.pubsubPublishTime ??
    new Date(0).toISOString();
  const resourceName = resourceNameFor(message, reaction, membership, space, action);
  const eventId = eventIdFor(source, rawKind, resourceName, receivedAt, transport);

  return {
    eventId,
    receivedAt,
    source,
    kind,
    rawKind,
    actor,
    actorState: actor?.access ?? {
      status: "missing",
      reason:
        source === "workspace_events"
          ? "workspace_event_missing_actor"
          : "event_payload_missing_user",
    },
    space,
    thread,
    message,
    action,
    dialog: normalizeDialog(event),
    membership,
    reaction,
    locale: normalizeLocale(event),
    timeZone: normalizeTimeZone(event),
    authContext: authContextFor(source),
    capabilities: capabilitiesFor(source, kind, thread),
    relationship: relationshipFor(kind, message, action, reaction, actor, space),
    transport,
    idempotencyKey: eventId,
    raw,
  } as ChatEventEnvelope;
}
