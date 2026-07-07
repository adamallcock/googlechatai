import { normalizeEvent } from "../events.js";

type JsonObject = Record<string, unknown>;

const CHAT_MESSAGES_READONLY_SCOPE =
  "https://www.googleapis.com/auth/chat.messages.readonly";
const CHAT_APP_MESSAGES_READONLY_SCOPE =
  "https://www.googleapis.com/auth/chat.app.messages.readonly";
const WORKSPACE_EVENTS_SCOPE =
  "https://www.googleapis.com/auth/workspace.events";
const PUBSUB_SCOPE = "https://www.googleapis.com/auth/pubsub";
const CHAT_EVENTS_PUBLISHER_PRINCIPAL =
  "serviceAccount:chat-api-push@system.gserviceaccount.com";
const DEFAULT_EVENT_TYPES = [
  "google.workspace.chat.message.v1.created",
  "google.workspace.chat.message.v1.updated",
  "google.workspace.chat.message.v1.deleted",
];

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

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredString(input: JsonObject, key: string): string {
  const value = asString(input[key]);
  if (!value) {
    throw new TypeError(`Expected ${key} to be a non-empty string.`);
  }
  return value;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  const output = asArray(value).filter((item): item is string => typeof item === "string");
  return output.length > 0 ? output : fallback;
}

function authMode(input: JsonObject): string {
  return asString(input.authMode) ?? "user";
}

function targetResource(input: JsonObject): string {
  const explicit = asString(input.targetResource);
  if (explicit) {
    return explicit;
  }
  return `//chat.googleapis.com/${requiredString(input, "space")}`;
}

function pageSize(input: JsonObject): number {
  const value = asNumber(input.pageSize) ?? 100;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}

function orderBy(input: JsonObject): string {
  const order = (asString(input.order) ?? asString(input.orderBy) ?? "ASC").toUpperCase();
  return order === "DESC" || order === "CREATE_TIME DESC"
    ? "createTime DESC"
    : "createTime ASC";
}

function buildPollingFilter(input: JsonObject): string | null {
  const clauses: string[] = [];
  const startTime = asString(input.startTime);
  const endTime = asString(input.endTime);
  const thread = asString(input.thread);

  if (startTime) {
    clauses.push(`createTime > "${startTime}"`);
  }
  if (endTime) {
    clauses.push(`createTime < "${endTime}"`);
  }
  if (thread) {
    clauses.push(`thread.name = "${thread}"`);
  }

  return clauses.length > 0 ? clauses.join(" AND ") : null;
}

function checkpointInput(input: JsonObject): JsonObject {
  return asRecord(input.checkpoint) ?? {};
}

function pageToken(input: JsonObject): string | null {
  const checkpoint = checkpointInput(input);
  return (
    asString(input.pageToken) ??
    asString(checkpoint.pageToken) ??
    asString(checkpoint.nextPageToken)
  );
}

function pollingScope(input: JsonObject): string {
  return asString(input.checkpointScope) ?? `${requiredString(input, "space")}#messages`;
}

function pollingQuery(input: JsonObject): JsonObject {
  const query: JsonObject = {
    pageSize: pageSize(input),
  };
  const token = pageToken(input);
  const filter = buildPollingFilter(input);
  const showDeleted = asBoolean(input.showDeleted);

  if (token) {
    query.pageToken = token;
  }
  if (filter) {
    query.filter = filter;
  }
  query.orderBy = orderBy(input);
  if (showDeleted !== null) {
    query.showDeleted = showDeleted;
  }
  return query;
}

function capability(input: JsonObject, mode: string): JsonObject {
  if (mode === "direct_interaction") {
    return {
      authMode: "chat_interaction",
      requiredScopes: [],
      requiresAdminApproval: false,
      requiresMembership: false,
      readOnly: true,
      writeCapable: false,
      notes: [
        "Direct interaction ingestion uses the Chat app endpoint and does not call Google APIs by itself.",
      ],
    };
  }

  const auth = authMode(input);
  if (mode === "polling") {
    return {
      authMode: auth,
      requiredScopes:
        auth === "app" ? [CHAT_APP_MESSAGES_READONLY_SCOPE] : [CHAT_MESSAGES_READONLY_SCOPE],
      requiresAdminApproval: auth === "app",
      requiresMembership: true,
      readOnly: true,
      writeCapable: false,
      notes:
        auth === "app"
          ? [
              "App-auth polling requires administrator approval and only returns public messages.",
            ]
          : ["User-auth polling reads messages visible to the installing user."],
    };
  }

  return {
    authMode: auth,
    requiredScopes: [WORKSPACE_EVENTS_SCOPE, PUBSUB_SCOPE],
    requiresAdminApproval: auth === "app",
    requiresMembership: true,
    readOnly: true,
    writeCapable: false,
    notes:
      auth === "app"
        ? ["App-auth Workspace Events subscriptions require one-time administrator approval."]
        : ["User-auth Workspace Events subscriptions observe resources visible to the user."],
  };
}

function setupChecks(input: JsonObject): JsonObject[] {
  return [
    {
      name: "workspace_events_api_enabled",
      status: "planned",
      remediation: "Enable workspaceevents.googleapis.com in the Cloud project.",
    },
    {
      name: "pubsub_topic",
      status: asString(input.pubsubTopic) ? "configured" : "missing",
      remediation: "Create a Pub/Sub topic for Workspace Events delivery.",
    },
    {
      name: "pubsub_publisher_iam",
      status: "planned",
      principal: CHAT_EVENTS_PUBLISHER_PRINCIPAL,
      remediation:
        "Grant Pub/Sub Publisher on the topic to the Google Chat event publisher principal.",
    },
    {
      name: "workspace_events_subscription",
      status: "planned",
      remediation:
        "Create a Workspace Events subscription with the chosen target resource and event types.",
    },
    {
      name: "subscription_lifecycle",
      status: "planned",
      remediation: "Renew expiring subscriptions and reactivate suspended subscriptions.",
    },
  ];
}

function backoff(input: JsonObject): JsonObject {
  const raw = asRecord(input.backoff) ?? {};
  return {
    initialMs: asNumber(raw.initialMs) ?? 1000,
    maxMs: asNumber(raw.maxMs) ?? 60000,
    multiplier: asNumber(raw.multiplier) ?? 2,
    jitter: asBoolean(raw.jitter) ?? true,
  };
}

export function planChatIngestion(input: JsonObject): JsonObject {
  const mode = asString(input.mode) ?? "direct_interaction";
  const cap = capability(input, mode);

  if (mode === "direct_interaction") {
    return {
      kind: "chat.ingestion_plan",
      mode,
      status: "planned",
      capability: cap,
      delivery: {
        transport: "chat_http",
        endpointPath: asString(input.endpointPath) ?? "/api/chat/events",
        responseMode: "sync_then_optional_async",
      },
      requests: [],
      checkpoint: null,
      safety: {
        liveAllowed: false,
        writesMessages: false,
        notes: ["Normalize delivered Chat interaction events before application routing."],
      },
      warnings: [],
    };
  }

  if (mode === "workspace_events_push" || mode === "workspace_events_pull") {
    const eventTypes = stringArray(input.eventTypes, DEFAULT_EVENT_TYPES);
    const topic = asString(input.pubsubTopic);
    const subscription = asString(input.pubsubSubscription);
    const includeResource = asBoolean(input.includeResource) ?? false;
    const endpoint = asString(input.pushEndpoint);
    const requests: JsonObject[] = [
      {
        resource: "workspaceevents.subscriptions.create",
        method: "POST",
        path: "/v1/subscriptions",
        body: {
          targetResource: targetResource(input),
          eventTypes,
          notificationEndpoint: topic ? { pubsubTopic: topic } : null,
          payloadOptions: {
            includeResource,
          },
        },
      },
    ];
    if (mode === "workspace_events_pull" && subscription) {
      requests.push({
        resource: "pubsub.subscriptions.pull",
        method: "POST",
        path: `/v1/${subscription}:pull`,
        body: {
          maxMessages: asNumber(input.maxMessages) ?? 10,
          returnImmediately: false,
        },
      });
    }

    return {
      kind: "chat.ingestion_plan",
      mode,
      status: "planned",
      capability: cap,
      targetResource: targetResource(input),
      eventTypes,
      includeResource,
      pubsub: {
        topic,
        subscription,
        publisherPrincipal: CHAT_EVENTS_PUBLISHER_PRINCIPAL,
      },
      delivery:
        mode === "workspace_events_push"
          ? {
              transport: "pubsub_push",
              endpoint,
              parser: "parsePubSubPushPayload",
            }
          : {
              transport: "pubsub_pull",
              subscription,
              parser: "parsePubSubPullPayload",
            },
      setupChecks: setupChecks(input),
      requests,
      checkpoint: {
        type: "pubsub",
        scope: subscription ?? topic ?? targetResource(input),
        cursor: asString(checkpointInput(input).cursor),
      },
      safety: {
        liveAllowed: false,
        writesMessages: false,
        notes: [
          "Workspace Events setup is planned only; creating subscriptions or IAM bindings must be explicitly gated.",
        ],
      },
      warnings: includeResource
        ? []
        : ["includeResource is false, so delivered events may require follow-up Chat API reads."],
    };
  }

  if (mode !== "polling") {
    throw new TypeError(`Unsupported ingestion mode: ${mode}`);
  }

  const space = requiredString(input, "space");
  const filter = buildPollingFilter(input);
  const query = pollingQuery(input);
  return {
    kind: "chat.ingestion_plan",
    mode,
    status: "planned",
    capability: cap,
    polling: {
      space,
      thread: asString(input.thread),
      pageSize: query.pageSize,
      filter,
      orderBy: query.orderBy,
      showDeleted: asBoolean(input.showDeleted) ?? false,
      backoff: backoff(input),
    },
    requests: [
      {
        resource: "spaces.messages.list",
        method: "GET",
        path: `/v1/${space}/messages`,
        query,
        body: null,
      },
    ],
    checkpoint: {
      type: "polling",
      scope: pollingScope(input),
      cursor: asString(checkpointInput(input).cursor),
      pageToken: pageToken(input),
      highWatermarkTime: asString(checkpointInput(input).highWatermarkTime),
    },
    idempotency: {
      duplicateStrategy: "skip_seen_polling_snapshots",
      keyFields: ["message.name", "lastUpdateTime", "deleteTime", "createTime"],
    },
    safety: {
      liveAllowed: false,
      writesMessages: false,
      notes: ["Polling is read-only and should target spaces the principal can already read."],
    },
    warnings: [
      "Polling emits snapshots, not authoritative real-time create/update/delete events.",
    ],
  };
}

function identitySummary(value: unknown): JsonObject | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  return {
    name: asString(raw.name),
    displayName: asString(raw.displayName),
    email: asString(raw.email),
    type: asString(raw.type),
    access: asString(raw.access),
  };
}

function spaceSummary(value: unknown): JsonObject | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  return {
    name: asString(raw.name),
    displayName: asString(raw.displayName),
    type: asString(raw.type),
  };
}

function threadSummary(value: unknown): JsonObject | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  return {
    name: asString(raw.name),
  };
}

function messageSummary(value: unknown): JsonObject | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  const state = asRecord(raw.state);
  return {
    name: asString(raw.name),
    text: asString(raw.text),
    plainTextForModel: asString(raw.plainTextForModel),
    createTime: asString(raw.createTime),
    sender: identitySummary(raw.sender),
    thread: threadSummary(raw.thread),
    state: state
      ? {
          deleted: asBoolean(state.deleted) ?? false,
          threadReply: asBoolean(state.threadReply) ?? false,
          directMessage: asBoolean(state.directMessage) ?? false,
        }
      : null,
  };
}

function normalizedEventSummary(event: JsonObject): JsonObject {
  const relationship = asRecord(event.relationship);
  return {
    eventId: asString(event.eventId),
    kind: asString(event.kind),
    source: asString(event.source),
    receivedAt: asString(event.receivedAt),
    actor: identitySummary(event.actor),
    space: spaceSummary(event.space),
    message: messageSummary(event.message),
    relationship: relationship
      ? {
          isThreadReply: asBoolean(relationship.isThreadReply) ?? false,
          isDeletion: asBoolean(relationship.isDeletion) ?? false,
          systemNotes: asArray(relationship.systemNotes).filter(
            (item): item is string => typeof item === "string",
          ),
        }
      : null,
  };
}

function effectiveSnapshotTime(message: JsonObject): string | null {
  return (
    asString(message.lastUpdateTime) ??
    asString(message.deleteTime) ??
    asString(message.createTime)
  );
}

function snapshotKind(message: JsonObject): string {
  if (asString(message.deleteTime) || asRecord(message.deletionMetadata)) {
    return "deleted_snapshot";
  }
  const createTime = asString(message.createTime);
  const updateTime = asString(message.lastUpdateTime);
  if (updateTime && updateTime !== createTime) {
    return "updated_snapshot";
  }
  return "created_snapshot";
}

function duplicateKey(message: JsonObject): string {
  const name = asString(message.name) ?? "{unknownMessage}";
  const time = effectiveSnapshotTime(message) ?? "unknown";
  return `polling:${name}:${time}`;
}

function maxTimestamp(values: (string | null)[]): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) {
      continue;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > bestMs) {
      best = value;
      bestMs = parsed;
    }
  }
  return best;
}

function pollingEventFromMessage(
  message: JsonObject,
  space: string,
  receivedAt: string | null,
): JsonObject {
  const eventTime = effectiveSnapshotTime(message) ?? receivedAt;
  return normalizeEvent(
    {
      type: "MESSAGE",
      eventTime,
      message,
      user: asRecord(message.sender),
      space: asRecord(message.space) ?? { name: space },
    },
    {
      source: "fixture",
      receivedAt: receivedAt ?? undefined,
    },
  ) as unknown as JsonObject;
}

export function processPollingIngestionPage(input: JsonObject): JsonObject {
  const space = requiredString(input, "space");
  const response = asRecord(input.response) ?? input;
  const messages = asArray(response.messages)
    .map((item) => asRecord(item))
    .filter((item): item is JsonObject => item !== null);
  const checkpoint = checkpointInput(input);
  const seenKeys = new Set(
    asArray(checkpoint.seenKeys).filter((item): item is string => typeof item === "string"),
  );
  const receivedAt = asString(input.receivedAt);
  const events = messages.map((message, index) => {
    const key = duplicateKey(message);
    const normalized = normalizedEventSummary(
      pollingEventFromMessage(message, space, receivedAt),
    );
    const skippedAsDuplicate = seenKeys.has(key);
    seenKeys.add(key);
    return {
      kind: "chat.ingestion_event",
      source: "polling",
      sequence: index,
      normalized,
      snapshot: {
        kind: snapshotKind(message),
        messageName: asString(message.name),
        effectiveTime: effectiveSnapshotTime(message),
        duplicateKey: key,
        skippedAsDuplicate,
      },
    };
  });
  const nextPageToken = asString(response.nextPageToken);
  const highWatermarkTime =
    maxTimestamp(messages.map(effectiveSnapshotTime)) ??
    asString(checkpoint.highWatermarkTime);
  const nextSeenKeys = [...seenKeys];
  const checkpointOut = {
    type: "polling",
    scope: pollingScope(input),
    cursor: nextPageToken ?? highWatermarkTime,
    pageToken: nextPageToken,
    nextPageToken,
    highWatermarkTime,
    seenKeys: nextSeenKeys,
  };
  const nextRequest = nextPageToken
    ? planChatIngestion({
        ...input,
        mode: "polling",
        response: undefined,
        checkpoint: {
          ...checkpoint,
          pageToken: nextPageToken,
          nextPageToken,
          highWatermarkTime,
          seenKeys: nextSeenKeys,
        },
      })
    : null;

  return {
    kind: "chat.ingestion_batch",
    mode: "polling",
    source: "spaces.messages.list",
    space,
    receivedAt,
    events,
    checkpoint: checkpointOut,
    pagination: {
      nextPageToken,
      hasMore: Boolean(nextPageToken),
      resultCount: events.length,
    },
    idempotency: {
      duplicateStrategy: "skip_seen_polling_snapshots",
      skippedCount: events.filter((item) => item.snapshot.skippedAsDuplicate).length,
    },
    nextRequest,
    systemNotes: [
      `System Note: Polling read ${events.length} message snapshot(s) from ${space}.`,
      "System Note: Polling snapshots can lag real-time Chat events and should be deduplicated before side effects.",
    ],
  };
}
