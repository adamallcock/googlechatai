import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";

import { normalizeEvent } from "../events.js";
import type {
  ChatEventEnvelope,
  ChatEventSource,
  PubSubEventMetadata,
  WorkspaceEventMetadata,
  WorkspaceEventsAvailability,
  WorkspaceEventsCheckpoint,
} from "../types.js";

type RawRecord = Record<string, unknown>;

export interface ParsedWorkspaceEvent {
  event: ChatEventEnvelope;
  rawWorkspaceEvent: unknown;
  decodedPubSubData?: unknown;
  rawPubSubPayload?: unknown;
}

export interface WorkspaceEventsCheckpointStore {
  load(scope: string): Promise<WorkspaceEventsCheckpoint | null>;
  save(scope: string, checkpoint: WorkspaceEventsCheckpoint): Promise<void>;
}

export class InMemoryWorkspaceEventsCheckpointStore
  implements WorkspaceEventsCheckpointStore
{
  private readonly checkpoints = new Map<string, WorkspaceEventsCheckpoint>();

  async load(scope: string): Promise<WorkspaceEventsCheckpoint | null> {
    return this.checkpoints.get(scope) ?? null;
  }

  async save(scope: string, checkpoint: WorkspaceEventsCheckpoint): Promise<void> {
    this.checkpoints.set(scope, checkpoint);
  }
}

export class FileWorkspaceEventsCheckpointStore
  implements WorkspaceEventsCheckpointStore
{
  constructor(private readonly filePath: string) {}

  async load(scope: string): Promise<WorkspaceEventsCheckpoint | null> {
    const checkpoints = await this.readAll();
    return checkpoints[scope] ?? null;
  }

  async save(scope: string, checkpoint: WorkspaceEventsCheckpoint): Promise<void> {
    const checkpoints = await this.readAll();
    checkpoints[scope] = checkpoint;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(
      this.filePath,
      `${JSON.stringify(checkpoints, null, 2)}\n`,
      "utf8",
    );
  }

  private async readAll(): Promise<Record<string, WorkspaceEventsCheckpoint>> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;

      return asRecord(parsed)
        ? (parsed as Record<string, WorkspaceEventsCheckpoint>)
        : {};
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return {};
      }

      throw error;
    }
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

function asNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function attributesFrom(value: unknown): Record<string, string> {
  const raw = asRecord(value);
  const attributes: Record<string, string> = {};

  if (!raw) {
    return attributes;
  }

  for (const [key, item] of Object.entries(raw)) {
    if (typeof item === "string") {
      attributes[key] = item;
    }
  }

  return attributes;
}

function decodePubSubData(data: unknown): unknown {
  const encoded = asString(data);

  if (!encoded) {
    return null;
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf8");

  if (!decoded) {
    return null;
  }

  try {
    return JSON.parse(decoded);
  } catch {
    return decoded;
  }
}

function cloudEventFromPubSubMessage(message: RawRecord): RawRecord {
  const attributes = attributesFrom(message.attributes);
  const decodedData = decodePubSubData(message.data);

  return {
    id: attributes["ce-id"] ?? null,
    source: attributes["ce-source"] ?? null,
    specversion: attributes["ce-specversion"] ?? null,
    type: attributes["ce-type"] ?? null,
    time: attributes["ce-time"] ?? null,
    subject: attributes["ce-subject"] ?? null,
    datacontenttype:
      attributes["ce-datacontenttype"] ?? attributes["content-type"] ?? null,
    data: decodedData,
  };
}

function stripServiceResourceName(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value.replace(/^\/\/chat\.googleapis\.com\//, "");
}

function resourceTypeFrom(type: string | null, resourceName: string | null): string | null {
  if (type?.includes(".message.")) {
    return "message";
  }

  if (type?.includes(".space.")) {
    return "space";
  }

  if (type?.includes(".membership.")) {
    return "membership";
  }

  if (resourceName?.includes("/messages/")) {
    return "message";
  }

  if (resourceName?.includes("/members/")) {
    return "membership";
  }

  if (resourceName?.startsWith("spaces/")) {
    return "space";
  }

  return null;
}

function resourceNameFromWorkspaceEvent(
  workspaceEvent: RawRecord,
  workspaceData: unknown,
): string | null {
  const data = asRecord(workspaceData);
  const message = asRecord(data?.message);
  const resourceName =
    asString(message?.name) ??
    asString(data?.resourceName) ??
    asString(data?.resource) ??
    stripServiceResourceName(asString(workspaceEvent.subject));

  return stripServiceResourceName(resourceName);
}

function subscriptionFromSource(source: string | null): string | null {
  if (!source?.includes("/subscriptions/")) {
    return null;
  }

  return source;
}

function workspaceMetadataFrom(
  workspaceEvent: RawRecord,
  event: ChatEventEnvelope,
): WorkspaceEventMetadata {
  const data = workspaceEvent.data;
  const eventType = asString(workspaceEvent.type);
  const resourceName = resourceNameFromWorkspaceEvent(workspaceEvent, data);
  const dataAvailability: WorkspaceEventsAvailability = asRecord(data)?.message
    ? "available"
    : resourceName
      ? "access_limited"
      : "unavailable";

  return {
    id: asString(workspaceEvent.id),
    type: eventType,
    source: asString(workspaceEvent.source),
    subject: asString(workspaceEvent.subject),
    time: asString(workspaceEvent.time),
    subscription: subscriptionFromSource(asString(workspaceEvent.source)),
    resource: {
      type: resourceTypeFrom(eventType, resourceName),
      name: resourceName,
      service: resourceName ? "chat.googleapis.com" : null,
      availability: dataAvailability,
    },
    actor: event.actor,
    actorAvailability: event.actor ? "available" : "unavailable",
    resourceDataAvailability: dataAvailability,
  };
}

function checkpointFromPubSub(
  pubSubMessage: RawRecord,
  subscription: string | null,
  ackId: string | null,
  deliveryAttempt: number | null,
): WorkspaceEventsCheckpoint {
  const messageId =
    asString(pubSubMessage.messageId) ?? asString(pubSubMessage.message_id);
  const publishTime =
    asString(pubSubMessage.publishTime) ?? asString(pubSubMessage.publish_time);
  const orderingKey = asString(pubSubMessage.orderingKey);
  const cursorSeed = messageId ?? ackId ?? publishTime ?? "unknown";

  return {
    type: "pubsub",
    cursor: subscription ? `${subscription}#${cursorSeed}` : cursorSeed,
    ackId,
    messageId,
    subscription,
    publishTime,
    deliveryAttempt,
    orderingKey,
  };
}

function pubSubMetadataFrom(
  pubSubMessage: RawRecord,
  subscription: string | null,
  ackId: string | null,
  deliveryAttempt: number | null,
): PubSubEventMetadata {
  const checkpoint = checkpointFromPubSub(
    pubSubMessage,
    subscription,
    ackId,
    deliveryAttempt,
  );

  return {
    messageId: checkpoint.messageId,
    publishTime: checkpoint.publishTime,
    subscription: checkpoint.subscription,
    orderingKey: checkpoint.orderingKey,
    deliveryAttempt: checkpoint.deliveryAttempt,
    attributes: attributesFrom(pubSubMessage.attributes),
    checkpoint,
  };
}

function parseWorkspaceEventEnvelope(input: unknown): RawRecord {
  const raw = asRecord(input);

  if (!raw) {
    throw new TypeError("Expected a Workspace Events CloudEvent object.");
  }

  return raw;
}

export function parseWorkspaceChatResourceEvent(
  input: unknown,
  options: { source?: ChatEventSource; pubSub?: PubSubEventMetadata } = {},
): ParsedWorkspaceEvent {
  const workspaceEvent = parseWorkspaceEventEnvelope(input);
  const eventTime = asString(workspaceEvent.time);
  const normalizeOptions: { source?: ChatEventSource; receivedAt?: string } = {};

  if (options.source !== undefined) {
    normalizeOptions.source = options.source;
  }
  if (eventTime !== null) {
    normalizeOptions.receivedAt = eventTime;
  }

  const event = normalizeEvent(workspaceEvent, normalizeOptions);

  event.workspaceEvent = workspaceMetadataFrom(workspaceEvent, event);

  if (options.pubSub) {
    event.pubSub = options.pubSub;
  }

  return {
    event,
    rawWorkspaceEvent: workspaceEvent,
  };
}

export function parsePubSubPushPayload(input: unknown): ParsedWorkspaceEvent {
  const raw = asRecord(input);
  const pubSubMessage = asRecord(raw?.message);

  if (!raw || !pubSubMessage) {
    throw new TypeError("Expected a Pub/Sub push payload with a message object.");
  }

  const subscription = asString(raw.subscription);
  const workspaceEvent = cloudEventFromPubSubMessage(pubSubMessage);
  const pubSub = pubSubMetadataFrom(pubSubMessage, subscription, null, null);
  const parsed = parseWorkspaceChatResourceEvent(workspaceEvent, {
    pubSub,
  });

  return {
    ...parsed,
    decodedPubSubData: workspaceEvent.data,
    rawPubSubPayload: input,
  };
}

function normalizePullItems(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return input;
  }

  const raw = asRecord(input);
  const receivedMessages = raw?.receivedMessages;

  return Array.isArray(receivedMessages) ? receivedMessages : [];
}

export function parsePubSubPullPayload(
  input: unknown,
  options: { subscription?: string | null } = {},
): ParsedWorkspaceEvent[] {
  return normalizePullItems(input).map((item) => {
    const raw = asRecord(item);
    const pubSubMessage = asRecord(raw?.message);

    if (!raw || !pubSubMessage) {
      throw new TypeError("Expected a Pub/Sub pull item with a message object.");
    }

    const workspaceEvent = cloudEventFromPubSubMessage(pubSubMessage);
    const subscription = options.subscription ?? asString(raw.subscription);
    const pubSub = pubSubMetadataFrom(
      pubSubMessage,
      subscription,
      asString(raw.ackId),
      asNumber(raw.deliveryAttempt),
    );
    const parsed = parseWorkspaceChatResourceEvent(workspaceEvent, {
      pubSub,
    });

    return {
      ...parsed,
      decodedPubSubData: workspaceEvent.data,
      rawPubSubPayload: item,
    };
  });
}
