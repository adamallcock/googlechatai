type JsonObject = Record<string, unknown>;

export const CHAT_SPACES_PINS_SCOPE =
  "https://www.googleapis.com/auth/chat.spaces.pins";
export const CHAT_SPACES_PINS_READONLY_SCOPE =
  "https://www.googleapis.com/auth/chat.spaces.pins.readonly";

/** @deprecated Use CHAT_SPACES_PINS_SCOPE. */
export const PIN_MESSAGES_SCOPE = CHAT_SPACES_PINS_SCOPE;

export const MESSAGE_PINS_DEVELOPER_PREVIEW_NOTE =
  "Message pins are a Google Workspace Developer Preview, user-authorized surface.";

/** @deprecated Use MESSAGE_PINS_DEVELOPER_PREVIEW_NOTE. */
export const CHAT_PIN_DOCS_LISTED_NOTE = MESSAGE_PINS_DEVELOPER_PREVIEW_NOTE;

const DRY_RUN_NOTE = "Dry run only; no Google Chat API call was executed.";
const USER_AUTH_REQUIRED_REASON =
  "Google Chat message pins require user authentication; app authentication is not supported.";
const DEFAULT_PAGE_SIZE = 100;
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 100;
const MESSAGE_RESOURCE_PATTERN = /^(spaces\/[^/]+)\/messages\/([^/]+)$/;
const MESSAGE_PIN_RESOURCE_PATTERN = /^spaces\/[^/]+\/messagePins\/[^/]+$/;

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

function messageParts(message: string): { space: string; messageId: string } {
  const match = MESSAGE_RESOURCE_PATTERN.exec(message);
  if (!match) {
    throw new TypeError(
      "Expected message to use the resource name format spaces/{space}/messages/{message}.",
    );
  }
  return { space: match[1]!, messageId: match[2]! };
}

function messageForSpace(input: JsonObject, space: string): string {
  const message = requiredString(input, "message");
  if (messageParts(message).space !== space) {
    throw new TypeError("Expected message to belong to the supplied space.");
  }
  return message;
}

function messagePinNameForMessage(message: string): string {
  const { space, messageId } = messageParts(message);
  return `${space}/messagePins/${messageId}`;
}

function requiredMessagePin(input: JsonObject): string {
  const messagePin = requiredString(input, "messagePin");
  if (!MESSAGE_PIN_RESOURCE_PATTERN.test(messagePin)) {
    throw new TypeError(
      "Expected messagePin to use the resource name format spaces/{space}/messagePins/{messagePin}.",
    );
  }
  return messagePin;
}

function authMode(input: JsonObject): string {
  return asString(input.authMode) ?? "user";
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
  const mode = authMode(input);
  const userAuthOk = mode === "user";

  return {
    ok: ok && userAuthOk,
    authMode: mode,
    requiredScopes,
    reasons: userAuthOk ? reasons : [...reasons, USER_AUTH_REQUIRED_REASON],
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
    warnings: [MESSAGE_PINS_DEVELOPER_PREVIEW_NOTE, ...(options.warnings ?? [])],
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

function completePinListQuery(input: JsonObject): JsonObject {
  if (asString(input.pageToken)) {
    throw new TypeError(
      "planEnsureMessagePinned does not accept pageToken because it must inspect the complete pin collection.",
    );
  }
  const requestedPageSize = asNumber(input.pageSize);
  if (requestedPageSize !== null && requestedPageSize !== MAX_PAGE_SIZE) {
    throw new TypeError(
      "planEnsureMessagePinned requires pageSize 100 so it can inspect the complete pin collection.",
    );
  }
  return { pageSize: MAX_PAGE_SIZE };
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

function createMessagePinRequest(space: string, message: string): JsonObject {
  return {
    resource: "spaces.messagePins.create",
    method: "POST",
    path: chatPath(`${space}/messagePins`),
    query: {},
    body: { message },
  };
}

export function planPinMessage(input: JsonObject): JsonObject {
  const space = requiredString(input, "space");
  const message = messageForSpace(input, space);

  return callPlan(
    "pins.pin",
    input,
    [CHAT_SPACES_PINS_SCOPE],
    [createMessagePinRequest(space, message)],
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
    const name = requiredMessagePin(input);
    return callPlan(
      "pins.unpin",
      input,
      [CHAT_SPACES_PINS_SCOPE],
      [
        {
          resource: "spaces.messagePins.delete",
          method: "DELETE",
          path: chatPath(name),
          query: {},
          body: null,
        },
      ],
      {
        extra: {
          pin: {
            action: "unpin",
            strategy: "direct",
            name,
          },
        },
      },
    );
  }

  if (space && message) {
    const validatedMessage = messageForSpace(input, space);
    const name = messagePinNameForMessage(validatedMessage);
    return callPlan(
      "pins.unpin",
      input,
      [CHAT_SPACES_PINS_SCOPE],
      [
        {
          resource: "spaces.messagePins.delete",
          method: "DELETE",
          path: chatPath(name),
          query: {},
          body: null,
        },
      ],
      {
        extra: {
          pin: {
            action: "unpin",
            strategy: "derived-from-message",
            space,
            message: validatedMessage,
            name,
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
    [CHAT_SPACES_PINS_READONLY_SCOPE],
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
  const message = messageForSpace(input, space);
  const query = completePinListQuery(input);

  return callPlan(
    "pins.ensurePinned",
    input,
    [CHAT_SPACES_PINS_SCOPE],
    [
      listMessagePinsRequest(space, query),
      {
        ...createMessagePinRequest(space, message),
        condition: {
          kind: "message_pin_absent",
          message,
          requiresCompleteList: true,
        },
      },
    ],
    {
      extra: {
        ensure: {
          strategy: "list-then-pin-if-absent",
          alreadyPinnedAction: "skip",
          requiresCompleteList: true,
        },
        pin: {
          action: "ensurePinned",
          space,
          message,
          pageSize: MAX_PAGE_SIZE,
          pageToken: null,
        },
      },
    },
  );
}
