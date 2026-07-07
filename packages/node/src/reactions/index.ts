type JsonObject = Record<string, unknown>;

export const CHAT_REACTIONS_SCOPE =
  "https://www.googleapis.com/auth/chat.messages.reactions";
export const CHAT_REACTIONS_READONLY_SCOPE =
  "https://www.googleapis.com/auth/chat.messages.reactions.readonly";

const DRY_RUN_NOTE = "Dry run only; no Google Chat API call was executed.";
const USER_AUTH_REQUIRED_REASON =
  "Google Chat reactions require user authentication; use the submitting user's token for visible feedback.";
const FEEDBACK_USER_AUTH_WARNING =
  "Feedback reactions should use the submitting user's credentials so Chat shows the human's reaction.";

const POSITIVE_FEEDBACK_RATINGS = new Set([
  "up",
  "thumbs_up",
  "thumbsup",
  "helpful",
  "positive",
  "yes",
  "like",
]);

const NEGATIVE_FEEDBACK_RATINGS = new Set([
  "down",
  "thumbs_down",
  "thumbsdown",
  "not_helpful",
  "nothelpful",
  "negative",
  "no",
  "dislike",
]);

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function cleanRecord(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null),
  );
}

function requiredString(input: JsonObject, key: string): string {
  const value = asString(input[key]);
  if (!value) {
    throw new TypeError(`Expected ${key} to be a non-empty string.`);
  }
  return value;
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
  const userAuthOk = requiredScopes.length === 0 || mode === "user";

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
    warnings: options.warnings ?? [],
  };
}

function escapeFilterString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function normalizeCustomEmoji(raw: JsonObject): JsonObject {
  return cleanRecord({
    uid: asString(raw.uid),
    name: asString(raw.name),
    emojiName: asString(raw.emojiName),
  });
}

function normalizeEmoji(value: unknown): {
  body: JsonObject;
  summary: JsonObject;
} {
  const directUnicode = asString(value);
  if (directUnicode) {
    return {
      body: { unicode: directUnicode },
      summary: {
        type: "unicode",
        unicode: directUnicode,
        customEmoji: null,
      },
    };
  }

  const raw = asRecord(value);
  const unicode = asString(raw?.unicode);
  if (unicode) {
    return {
      body: { unicode },
      summary: {
        type: "unicode",
        unicode,
        customEmoji: null,
      },
    };
  }

  const customEmojiRaw = asRecord(raw?.customEmoji);
  const customEmoji = customEmojiRaw ? normalizeCustomEmoji(customEmojiRaw) : {};
  if (Object.keys(customEmoji).length > 0) {
    return {
      body: { customEmoji },
      summary: {
        type: "custom",
        unicode: null,
        customEmoji,
      },
    };
  }

  throw new TypeError(
    "Expected emoji to be a unicode string or an object with unicode/customEmoji.",
  );
}

function queryFrom(input: JsonObject): JsonObject {
  const query: JsonObject = {};
  const pageSize = asNumber(input.pageSize);
  const pageToken = asString(input.pageToken);
  const filter = asString(input.filter);

  if (pageSize !== null) {
    query.pageSize = Math.max(1, Math.min(200, Math.floor(pageSize)));
  }
  if (pageToken) {
    query.pageToken = pageToken;
  }
  if (filter) {
    query.filter = filter;
  }

  return query;
}

export function buildReactionFilterForEmoji(emoji: unknown): string {
  const { body } = normalizeEmoji(emoji);
  const unicode = asString(body.unicode);
  if (unicode) {
    return `emoji.unicode = "${escapeFilterString(unicode)}"`;
  }

  const customEmoji = asRecord(body.customEmoji);
  const uid = asString(customEmoji?.uid);
  if (uid) {
    return `emoji.custom_emoji.uid = "${escapeFilterString(uid)}"`;
  }

  throw new TypeError("Expected customEmoji.uid when building a custom emoji reaction filter.");
}

export function feedbackRatingToEmoji(rating: unknown): JsonObject {
  const raw = asString(rating)?.trim();
  if (!raw) {
    throw new TypeError("Expected feedback rating to be a non-empty string.");
  }

  const normalized = raw.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toLowerCase();
  const compact = normalized.replaceAll("_", "");

  if (POSITIVE_FEEDBACK_RATINGS.has(normalized) || POSITIVE_FEEDBACK_RATINGS.has(compact)) {
    return { unicode: "\u{1F44D}" };
  }
  if (NEGATIVE_FEEDBACK_RATINGS.has(normalized) || NEGATIVE_FEEDBACK_RATINGS.has(compact)) {
    return { unicode: "\u{1F44E}" };
  }

  throw new TypeError(`Unsupported feedback rating: ${raw}.`);
}

export function planAddReaction(input: JsonObject): JsonObject {
  const message = requiredString(input, "message");
  const emoji = normalizeEmoji(input.emoji);

  return callPlan(
    "reactions.add",
    input,
    [CHAT_REACTIONS_SCOPE],
    [
      {
        resource: "spaces.messages.reactions.create",
        method: "POST",
        path: chatPath(`${message}/reactions`),
        query: {},
        body: { emoji: emoji.body },
      },
    ],
    {
      extra: {
        reaction: {
          action: "add",
          message,
          emoji: emoji.summary,
          filter: buildReactionFilterForEmoji(emoji.body),
          userVisible: true,
        },
      },
    },
  );
}

export function planFeedbackReaction(input: JsonObject): JsonObject {
  const message = requiredString(input, "message");
  const rating = requiredString(input, "rating");
  const responseId = asString(input.responseId);
  const visibleReaction = asBoolean(input.visibleReaction) ?? asBoolean(input.enabled) ?? true;

  if (!visibleReaction) {
    return callPlan(
      "reactions.feedback",
      input,
      [],
      [],
      {
        extra: {
          feedback: {
            rating,
            responseId,
            visibleReaction: false,
            systemNotes: [
              "System Note: Feedback was recorded without adding a visible Google Chat reaction.",
            ],
          },
        },
      },
    );
  }

  const emoji = normalizeEmoji(feedbackRatingToEmoji(rating));
  const mode = authMode(input);
  const warnings = mode === "user" ? [] : [FEEDBACK_USER_AUTH_WARNING];

  return callPlan(
    "reactions.feedback",
    input,
    [CHAT_REACTIONS_SCOPE],
    [
      {
        resource: "spaces.messages.reactions.create",
        method: "POST",
        path: chatPath(`${message}/reactions`),
        query: {},
        body: { emoji: emoji.body },
      },
    ],
    {
      warnings,
      extra: {
        reaction: {
          action: "add",
          message,
          emoji: emoji.summary,
          filter: buildReactionFilterForEmoji(emoji.body),
          userVisible: true,
        },
        feedback: {
          rating,
          responseId,
          visibleReaction: true,
          systemNotes: [
            `System Note: Feedback rating ${rating} will also add a visible ${asString(emoji.body.unicode) ?? "emoji"} reaction from the submitting user.`,
          ],
        },
      },
    },
  );
}

export function planListReactions(input: JsonObject): JsonObject {
  const message = requiredString(input, "message");
  const query = queryFrom(input);

  return callPlan(
    "reactions.list",
    input,
    [CHAT_REACTIONS_READONLY_SCOPE],
    [
      {
        resource: "spaces.messages.reactions.list",
        method: "GET",
        path: chatPath(`${message}/reactions`),
        query,
        body: null,
      },
    ],
    {
      extra: {
        reaction: {
          action: "list",
          message,
          filter: asString(query.filter),
          pageSize: asNumber(query.pageSize),
          pageToken: asString(query.pageToken),
        },
      },
    },
  );
}

export function planDeleteReaction(input: JsonObject): JsonObject {
  const reaction = requiredString(input, "reaction");

  return callPlan(
    "reactions.delete",
    input,
    [CHAT_REACTIONS_SCOPE],
    [
      {
        resource: "spaces.messages.reactions.delete",
        method: "DELETE",
        path: chatPath(reaction),
        query: {},
        body: null,
      },
    ],
    {
      extra: {
        reaction: {
          action: "delete",
          name: reaction,
        },
      },
    },
  );
}
