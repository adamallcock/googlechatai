type JsonObject = Record<string, unknown>;

export const PIN_MESSAGES_SCOPE =
  "https://www.googleapis.com/auth/chat.messages";

export const CHAT_PIN_DOCS_LISTED_NOTE =
  "spaces.messagePins.* is a docs-listed surface; verify live support before relying on it.";

const DRY_RUN_NOTE = "Dry run only; no Google Chat API call was executed.";
const DEFAULT_PAGE_SIZE = 100;
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 1000;
const RESOLVED_MESSAGE_PIN_PLACEHOLDER = "/v1/{resolvedMessagePin}";

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requiredString(input: JsonObject, key: string): string {
  const value = asString(input[key]);
  if (!value) {
    throw new TypeError(`Expected ${key} to be a non-empty string.`);
  }
  return value;
}

function authMode(input: JsonObject): string {
  return asString(input.authMode) ?? "app";
}

function chatPath(resourceName: string): string {
  return `/v1/${resourceName}`;
}

function safety(): JsonObject {
  return {
    liveAllowed: false,
    directMessage: false,
    notes: [DRY_RUN_NOTE],
  };
}

function capability(
  input: JsonObject,
  requiredScopes: string[],
  ok = true,
  reasons: string[] = [],
): JsonObject {
  return {
    ok,
    authMode: authMode(input),
    requiredScopes,
    reasons,
  };
}

function idempotency(): JsonObject {
  return {
    requestId: null,
    clientMessageId: null,
  };
}

function callPlan(
  operation: string,
  input: JsonObject,
  requiredScopes: string[],
  requests: JsonObject[],
  options: {
    extra?: JsonObject;
    warnings?: string[];
    capabilityOk?: boolean;
    capabilityReasons?: string[];
  } = {},
): JsonObject {
  return {
    kind: "chat.call_plan",
    operation,
    dryRun: true,
    capability: capability(
      input,
      requiredScopes,
      options.capabilityOk ?? true,
      options.capabilityReasons ?? [],
    ),
    requests,
    idempotency: idempotency(),
    ...(options.extra ?? {}),
    safety: safety(),
    warnings: [CHAT_PIN_DOCS_LISTED_NOTE, ...(options.warnings ?? [])],
  };
}

function pageSizeFrom(input: JsonObject): number {
  const value = asNumber(input.pageSize) ?? DEFAULT_PAGE_SIZE;
  return Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, Math.floor(value)));
}

function listQuery(input: JsonObject): JsonObject {
  const query: JsonObject = { pageSize: pageSizeFrom(input) };
  const pageToken = asString(input.pageToken);
  if (pageToken) {
    query.pageToken = pageToken;
  }
  return query;
}

function listMessagePinsRequest(space: string, query: JsonObject): JsonObject {
  return {
    resource: "spaces.messagePins.list",
    method: "GET",
    path: chatPath(`${space}/messagePins`),
    query,
    body: null,
  };
}

export function planPinMessage(input: JsonObject): JsonObject {
  const space = requiredString(input, "space");
  const message = requiredString(input, "message");

  return callPlan(
    "pins.pin",
    input,
    [PIN_MESSAGES_SCOPE],
    [
      {
        resource: "spaces.messagePins.create",
        method: "POST",
        path: chatPath(`${space}/messagePins`),
        query: {},
        body: { messagePin: { message } },
      },
    ],
    {
      extra: {
        pin: {
          action: "pin",
          space,
          message,
        },
      },
    },
  );
}

export function planUnpinMessage(input: JsonObject): JsonObject {
  const messagePin = asString(input.messagePin);
  const space = asString(input.space);
  const message = asString(input.message);

  if (messagePin) {
    return callPlan(
      "pins.unpin",
      input,
      [PIN_MESSAGES_SCOPE],
      [
        {
          resource: "spaces.messagePins.delete",
          method: "DELETE",
          path: chatPath(messagePin),
          query: {},
          body: null,
        },
      ],
      {
        extra: {
          pin: {
            action: "unpin",
            strategy: "direct",
            name: messagePin,
          },
        },
      },
    );
  }

  if (space && message) {
    return callPlan(
      "pins.unpin",
      input,
      [PIN_MESSAGES_SCOPE],
      [
        listMessagePinsRequest(space, listQuery(input)),
        {
          resource: "spaces.messagePins.delete",
          method: "DELETE",
          path: RESOLVED_MESSAGE_PIN_PLACEHOLDER,
          query: {},
          body: null,
        },
      ],
      {
        warnings: [
          "The message pin name is not derivable from space and message alone; list message pins first and resolve the matching messagePin name before deleting.",
        ],
        extra: {
          pin: {
            action: "unpin",
            strategy: "list-then-delete",
            space,
            message,
            resolvedMessagePinPlaceholder: RESOLVED_MESSAGE_PIN_PLACEHOLDER,
          },
        },
      },
    );
  }

  throw new TypeError(
    "Expected messagePin, or both space and message, to be non-empty strings.",
  );
}

export function planListMessagePins(input: JsonObject): JsonObject {
  const space = requiredString(input, "space");
  const query = listQuery(input);

  return callPlan(
    "pins.list",
    input,
    [PIN_MESSAGES_SCOPE],
    [listMessagePinsRequest(space, query)],
    {
      extra: {
        pin: {
          action: "list",
          space,
          pageSize: asNumber(query.pageSize),
          pageToken: asString(query.pageToken),
        },
      },
    },
  );
}

export function planEnsureMessagePinned(input: JsonObject): JsonObject {
  const space = requiredString(input, "space");
  const message = requiredString(input, "message");
  const query = listQuery(input);

  return callPlan(
    "pins.ensurePinned",
    input,
    [PIN_MESSAGES_SCOPE],
    [
      listMessagePinsRequest(space, query),
      {
        resource: "spaces.messagePins.create",
        method: "POST",
        path: chatPath(`${space}/messagePins`),
        query: {},
        body: { messagePin: { message } },
      },
    ],
    {
      extra: {
        ensure: {
          strategy: "list-then-pin",
          alreadyPinnedAction: "skip",
        },
        pin: {
          action: "ensurePinned",
          space,
          message,
          pageSize: asNumber(query.pageSize),
          pageToken: asString(query.pageToken),
        },
      },
    },
  );
}
