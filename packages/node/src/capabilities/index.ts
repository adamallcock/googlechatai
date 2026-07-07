type JsonObject = Record<string, unknown>;

type Principal = "app" | "user" | "admin" | "none";

type CapabilityRecord = {
  intent: string;
  aliases?: string[];
  googleMethod: string;
  defaultPrincipal: Principal;
  supportedPrincipals: Principal[];
  requiredScopes: string[];
  adminApproval: string;
  membership: string;
  readWriteRisk: string;
  idempotency: string;
  retryPolicy: string;
  liveSafe: boolean;
  knownLimitations?: string[];
  unsupportedPrincipalRemediation?: string[];
};

export type CapabilityOptions = {
  principal?: string | null;
};

export type ErrorExplanationContext = {
  intent?: string | null;
  principal?: string | null;
  requiredScopes?: string[] | null;
};

const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const CHAT_MESSAGES_READONLY_SCOPE =
  "https://www.googleapis.com/auth/chat.messages.readonly";
const CHAT_REACTIONS_SCOPE =
  "https://www.googleapis.com/auth/chat.messages.reactions";
const CHAT_REACTIONS_READONLY_SCOPE =
  "https://www.googleapis.com/auth/chat.messages.reactions.readonly";
const CHAT_MEMBERSHIPS_READONLY_SCOPE =
  "https://www.googleapis.com/auth/chat.memberships.readonly";
const CHAT_CUSTOM_EMOJIS_READONLY_SCOPE =
  "https://www.googleapis.com/auth/chat.customemojis.readonly";
const CHAT_USERS_READSTATE_SCOPE =
  "https://www.googleapis.com/auth/chat.users.readstate.readonly";
const CHAT_USERS_SPACESETTINGS_SCOPE =
  "https://www.googleapis.com/auth/chat.users.spacesettings";
const CHAT_USERS_SECTIONS_SCOPE =
  "https://www.googleapis.com/auth/chat.users.sections";
const CHAT_APP_SPACES_CREATE_SCOPE =
  "https://www.googleapis.com/auth/chat.app.spaces.create";
const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const WORKSPACE_EVENTS_SCOPE =
  "https://www.googleapis.com/auth/workspace.events";

const REACTION_USER_AUTH_REMEDIATION = [
  `Use the submitting user's OAuth token with ${CHAT_REACTIONS_SCOPE}.`,
  "Keep visible feedback reactions user-owned; do not silently create them as the app.",
];

const CAPABILITIES: CapabilityRecord[] = [
  {
    intent: "messages.send",
    aliases: ["spaces.messages.create"],
    googleMethod: "spaces.messages.create",
    defaultPrincipal: "app",
    supportedPrincipals: ["app", "user"],
    requiredScopes: [CHAT_BOT_SCOPE],
    adminApproval: "not_required",
    membership: "app_must_be_member",
    readWriteRisk: "write",
    idempotency: "request_id_or_client_message_id_recommended",
    retryPolicy: "retry_replay_safe_only",
    liveSafe: false,
  },
  {
    intent: "messages.reply",
    googleMethod: "spaces.messages.create",
    defaultPrincipal: "app",
    supportedPrincipals: ["app"],
    requiredScopes: [CHAT_BOT_SCOPE],
    adminApproval: "not_required",
    membership: "app_must_be_member",
    readWriteRisk: "write",
    idempotency: "request_id_or_client_message_id_recommended",
    retryPolicy: "retry_replay_safe_only",
    liveSafe: false,
  },
  {
    intent: "messages.edit_app_created",
    aliases: ["spaces.messages.patch"],
    googleMethod: "spaces.messages.patch",
    defaultPrincipal: "app",
    supportedPrincipals: ["app"],
    requiredScopes: [CHAT_BOT_SCOPE],
    adminApproval: "not_required",
    membership: "app_must_be_member",
    readWriteRisk: "write",
    idempotency: "target_resource_idempotent",
    retryPolicy: "retry_replay_safe_only",
    liveSafe: false,
    knownLimitations: ["Only edit messages created by the same Chat app."],
  },
  {
    intent: "messages.delete_app_created",
    aliases: ["spaces.messages.delete"],
    googleMethod: "spaces.messages.delete",
    defaultPrincipal: "app",
    supportedPrincipals: ["app"],
    requiredScopes: [CHAT_BOT_SCOPE],
    adminApproval: "not_required",
    membership: "app_must_be_member",
    readWriteRisk: "write",
    idempotency: "target_resource_idempotent",
    retryPolicy: "retry_replay_safe_only",
    liveSafe: false,
    knownLimitations: ["Only delete messages created by the same Chat app."],
  },
  {
    intent: "messages.read_context",
    aliases: ["spaces.messages.list"],
    googleMethod: "spaces.messages.list",
    defaultPrincipal: "user",
    supportedPrincipals: ["user"],
    requiredScopes: [CHAT_MESSAGES_READONLY_SCOPE],
    adminApproval: "user_consent_required",
    membership: "user_must_have_access",
    readWriteRisk: "read",
    idempotency: "read_only",
    retryPolicy: "retry_reads",
    liveSafe: true,
  },
  {
    intent: "messages.stream_edit",
    googleMethod: "spaces.messages.patch",
    defaultPrincipal: "app",
    supportedPrincipals: ["app"],
    requiredScopes: [CHAT_BOT_SCOPE],
    adminApproval: "not_required",
    membership: "app_must_be_member",
    readWriteRisk: "write",
    idempotency: "ordered_patch_target_resource",
    retryPolicy: "retry_replay_safe_only",
    liveSafe: false,
  },
  {
    intent: "attachments.upload",
    aliases: ["media.upload"],
    googleMethod: "media.upload",
    defaultPrincipal: "user",
    supportedPrincipals: ["user"],
    requiredScopes: [CHAT_MESSAGES_READONLY_SCOPE],
    adminApproval: "user_consent_required",
    membership: "user_must_have_access",
    readWriteRisk: "write",
    idempotency: "upload_token_required",
    retryPolicy: "retry_replay_safe_only",
    liveSafe: false,
    knownLimitations: ["Attachment messages cannot include accessory widgets."],
  },
  {
    intent: "attachments.download",
    aliases: ["media.download"],
    googleMethod: "media.download",
    defaultPrincipal: "user",
    supportedPrincipals: ["user"],
    requiredScopes: [CHAT_MESSAGES_READONLY_SCOPE, DRIVE_READONLY_SCOPE],
    adminApproval: "user_consent_required",
    membership: "user_must_have_access",
    readWriteRisk: "read",
    idempotency: "read_only",
    retryPolicy: "retry_reads",
    liveSafe: true,
  },
  {
    intent: "reactions.add",
    aliases: ["spaces.messages.reactions.create"],
    googleMethod: "spaces.messages.reactions.create",
    defaultPrincipal: "user",
    supportedPrincipals: ["user"],
    requiredScopes: [CHAT_REACTIONS_SCOPE],
    adminApproval: "user_consent_required",
    membership: "user_must_have_access",
    readWriteRisk: "write",
    idempotency: "not_idempotent",
    retryPolicy: "retry_reads_or_idempotent_writes_only",
    liveSafe: false,
    knownLimitations: [
      "Google Chat reactions are visible as the reacting user and should not be created with app auth.",
    ],
    unsupportedPrincipalRemediation: REACTION_USER_AUTH_REMEDIATION,
  },
  {
    intent: "reactions.list",
    aliases: ["spaces.messages.reactions.list"],
    googleMethod: "spaces.messages.reactions.list",
    defaultPrincipal: "user",
    supportedPrincipals: ["user"],
    requiredScopes: [CHAT_REACTIONS_READONLY_SCOPE],
    adminApproval: "user_consent_required",
    membership: "user_must_have_access",
    readWriteRisk: "read",
    idempotency: "read_only",
    retryPolicy: "retry_reads",
    liveSafe: true,
  },
  {
    intent: "reactions.delete",
    aliases: ["spaces.messages.reactions.delete"],
    googleMethod: "spaces.messages.reactions.delete",
    defaultPrincipal: "user",
    supportedPrincipals: ["user"],
    requiredScopes: [CHAT_REACTIONS_SCOPE],
    adminApproval: "user_consent_required",
    membership: "user_must_have_access",
    readWriteRisk: "write",
    idempotency: "target_resource_idempotent",
    retryPolicy: "retry_replay_safe_only",
    liveSafe: false,
    unsupportedPrincipalRemediation: REACTION_USER_AUTH_REMEDIATION,
  },
  {
    intent: "memberships.list",
    aliases: ["spaces.members.list"],
    googleMethod: "spaces.members.list",
    defaultPrincipal: "user",
    supportedPrincipals: ["user", "app"],
    requiredScopes: [CHAT_MEMBERSHIPS_READONLY_SCOPE],
    adminApproval: "user_consent_required",
    membership: "caller_must_have_access",
    readWriteRisk: "read",
    idempotency: "read_only",
    retryPolicy: "retry_reads",
    liveSafe: true,
  },
  {
    intent: "custom_emojis.list",
    aliases: ["customEmojis.list"],
    googleMethod: "customEmojis.list",
    defaultPrincipal: "user",
    supportedPrincipals: ["user"],
    requiredScopes: [CHAT_CUSTOM_EMOJIS_READONLY_SCOPE],
    adminApproval: "user_consent_required",
    membership: "not_required",
    readWriteRisk: "read",
    idempotency: "read_only",
    retryPolicy: "retry_reads",
    liveSafe: true,
  },
  {
    intent: "users.read_state",
    googleMethod: "users.spaces.getSpaceReadState",
    defaultPrincipal: "user",
    supportedPrincipals: ["user"],
    requiredScopes: [CHAT_USERS_READSTATE_SCOPE],
    adminApproval: "user_consent_required",
    membership: "user_must_have_access",
    readWriteRisk: "read",
    idempotency: "read_only",
    retryPolicy: "retry_reads",
    liveSafe: true,
  },
  {
    intent: "users.notification_settings",
    googleMethod: "users.spaces.spaceNotificationSetting.get",
    defaultPrincipal: "user",
    supportedPrincipals: ["user"],
    requiredScopes: [CHAT_USERS_SPACESETTINGS_SCOPE],
    adminApproval: "user_consent_required",
    membership: "user_must_have_access",
    readWriteRisk: "read_write",
    idempotency: "target_resource_idempotent",
    retryPolicy: "retry_replay_safe_only",
    liveSafe: false,
  },
  {
    intent: "users.sections",
    googleMethod: "users.sections.list",
    defaultPrincipal: "user",
    supportedPrincipals: ["user"],
    requiredScopes: [CHAT_USERS_SECTIONS_SCOPE],
    adminApproval: "user_consent_required",
    membership: "user_must_have_access",
    readWriteRisk: "read_write",
    idempotency: "target_resource_idempotent",
    retryPolicy: "retry_replay_safe_only",
    liveSafe: false,
  },
  {
    intent: "workspace_events.subscribe",
    aliases: ["subscriptions.create"],
    googleMethod: "subscriptions.create",
    defaultPrincipal: "admin",
    supportedPrincipals: ["admin"],
    requiredScopes: [WORKSPACE_EVENTS_SCOPE],
    adminApproval: "admin_required",
    membership: "target_resource_policy_required",
    readWriteRisk: "write",
    idempotency: "subscription_id_required",
    retryPolicy: "retry_replay_safe_only",
    liveSafe: false,
    knownLimitations: [
      "Workspace Events Pub/Sub publisher IAM can be blocked by tenant org policy.",
    ],
  },
  {
    intent: "card_interactions.respond",
    googleMethod: "chat.webhook.response",
    defaultPrincipal: "none",
    supportedPrincipals: ["none"],
    requiredScopes: [],
    adminApproval: "not_required",
    membership: "app_must_be_configured",
    readWriteRisk: "none",
    idempotency: "event_idempotency_key_required_before_side_effects",
    retryPolicy: "do_not_retry_after_chat_deadline",
    liveSafe: true,
  },
  {
    intent: "spaces.create_app",
    googleMethod: "spaces.create",
    defaultPrincipal: "app",
    supportedPrincipals: ["app"],
    requiredScopes: [CHAT_BOT_SCOPE, CHAT_APP_SPACES_CREATE_SCOPE],
    adminApproval: "workspace_admin_may_be_required",
    membership: "not_required",
    readWriteRisk: "write",
    idempotency: "request_id_required",
    retryPolicy: "retry_replay_safe_only",
    liveSafe: false,
  },
];

function normalizeIntent(intentOrMethod: string): string {
  return intentOrMethod.trim();
}

function findRecord(intentOrMethod: string): CapabilityRecord {
  const normalized = normalizeIntent(intentOrMethod);
  const record = CAPABILITIES.find(
    (item) =>
      item.intent === normalized ||
      item.googleMethod === normalized ||
      item.aliases?.includes(normalized),
  );

  if (!record) {
    return {
      intent: normalized,
      googleMethod: normalized,
      defaultPrincipal: "user",
      supportedPrincipals: ["app", "user"],
      requiredScopes: [],
      adminApproval: "unknown",
      membership: "unknown",
      readWriteRisk: "unknown",
      idempotency: "unknown",
      retryPolicy: "unknown",
      liveSafe: false,
      knownLimitations: ["No curated Google Chat capability record exists yet."],
    };
  }

  return record;
}

function requestedPrincipal(options: CapabilityOptions = {}): Principal {
  const value = options.principal;
  if (value === "app" || value === "user" || value === "admin" || value === "none") {
    return value;
  }
  return "user";
}

function capabilityExplanation(
  kind: "chat.capability_explanation" | "chat.permission_plan",
  intentOrMethod: string,
  options: CapabilityOptions = {},
): JsonObject {
  const record = findRecord(intentOrMethod);
  const requested = requestedPrincipal({
    principal: options.principal ?? record.defaultPrincipal,
  });
  const supported = record.supportedPrincipals.includes(requested);
  const reasons = supported ? [] : ["unsupported_principal"];

  return {
    kind,
    intent: record.intent,
    googleMethod: record.googleMethod,
    ok: supported,
    status: supported ? "available" : "unavailable",
    principal: requested,
    requestedPrincipal: requested,
    supportedPrincipals: record.supportedPrincipals,
    requiredScopes: record.requiredScopes,
    adminApproval: record.adminApproval,
    membership: record.membership,
    readWriteRisk: record.readWriteRisk,
    idempotency: record.idempotency,
    retryPolicy: record.retryPolicy,
    liveSafe: record.liveSafe,
    knownLimitations: record.knownLimitations ?? [],
    reasons,
    remediation: supported
      ? []
      : record.unsupportedPrincipalRemediation ?? [
          `Use one of the supported principals: ${record.supportedPrincipals.join(", ")}.`,
        ],
  };
}

export function explainChatCapability(
  intentOrMethod: string,
  options: CapabilityOptions = {},
): JsonObject {
  return capabilityExplanation(
    "chat.capability_explanation",
    intentOrMethod,
    options,
  );
}

export function planChatPermission(
  intentOrMethod: string,
  options: CapabilityOptions = {},
): JsonObject {
  return capabilityExplanation("chat.permission_plan", intentOrMethod, options);
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

function httpStatus(error: JsonObject): number | null {
  return (
    asNumber(error.httpStatus) ??
    asNumber(error.status) ??
    asNumber(asRecord(error.response)?.status)
  );
}

function lowerHeaders(error: JsonObject): Record<string, string> {
  const headers = asRecord(error.headers) ?? asRecord(asRecord(error.response)?.headers) ?? {};
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
}

function googleError(error: JsonObject): JsonObject {
  return (
    asRecord(asRecord(error.body)?.error) ??
    asRecord(asRecord(error.json)?.error) ??
    asRecord(error.error) ??
    {}
  );
}

function parseRetryAfterMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

function debugFor(google: JsonObject): JsonObject {
  const message = asString(google.message) ?? "";
  return {
    redacted: true,
    googleStatus: asString(google.status),
    messageLength: message.length,
  };
}

function firstRequiredScope(context: ErrorExplanationContext): string | null {
  return context.requiredScopes?.[0] ?? null;
}

export function explainGoogleChatError(
  errorInput: unknown,
  context: ErrorExplanationContext = {},
): JsonObject {
  const error = asRecord(errorInput) ?? {};
  const status = httpStatus(error);
  const google = googleError(error);
  const message = asString(google.message) ?? asString(error.message) ?? "";
  const googleStatus = asString(google.status) ?? "";
  const principal = context.principal ?? null;
  const intent = context.intent ?? null;
  const headers = lowerHeaders(error);

  if (status === 403 && /scope|insufficient/i.test(message)) {
    const scope = firstRequiredScope(context);
    return {
      kind: "chat.error_explanation",
      code: "insufficient_scopes",
      category: "permission",
      httpStatus: 403,
      retryable: false,
      principal,
      intent,
      summary: "The user token is missing a required Google Chat scope.",
      remediation: [
        `Re-run installed-user OAuth consent${scope ? ` with ${scope}` : ""}.`,
        "Keep this on the installed-user path; do not switch to domain-wide delegation by default.",
      ],
      debug: debugFor(google),
    };
  }

  if (status === 429) {
    return {
      kind: "chat.error_explanation",
      code: "rate_limited",
      category: "rate_limit",
      httpStatus: 429,
      retryable: true,
      retryAfterMs: parseRetryAfterMs(headers["retry-after"]),
      principal,
      intent,
      summary: "Google Chat rate limited the request.",
      remediation: [
        "Retry after the Retry-After delay with the central retry policy.",
        "Do not replay unsafe writes unless the request has a stable idempotency key.",
      ],
      debug: debugFor(google),
    };
  }

  if (status === 401) {
    return {
      kind: "chat.error_explanation",
      code: "auth_required",
      category: "auth",
      httpStatus: 401,
      retryable: false,
      principal,
      intent,
      summary: "Google Chat requires fresh authorization.",
      remediation: [
        "Refresh the access token silently when possible.",
        "If refresh is unavailable, ask the installing user to authorize the required scopes.",
      ],
      debug: debugFor(google),
    };
  }

  if (status === 404) {
    return {
      kind: "chat.error_explanation",
      code:
        /not.?found|NOT_FOUND/.test(`${googleStatus} ${message}`)
          ? "resource_not_found"
          : "app_not_configured",
      category: "not_found",
      httpStatus: 404,
      retryable: false,
      principal,
      intent,
      summary: "Google Chat could not find the requested app, method, or resource.",
      remediation: [
        "Verify the Cloud project, Chat app configuration, smoke-space membership, and endpoint availability.",
      ],
      debug: debugFor(google),
    };
  }

  if (status === 409) {
    return {
      kind: "chat.error_explanation",
      code: "conflict",
      category: "google_api",
      httpStatus: 409,
      retryable: false,
      principal,
      intent,
      summary: "Google Chat reported a conflict.",
      remediation: [
        "Check whether the idempotency key or target resource was already used.",
      ],
      debug: debugFor(google),
    };
  }

  if (status && status >= 500) {
    return {
      kind: "chat.error_explanation",
      code: "google_transient",
      category: "google_api",
      httpStatus: status,
      retryable: true,
      principal,
      intent,
      summary: "Google Chat returned a retryable server error.",
      remediation: [
        "Retry with exponential backoff when the operation is replay-safe.",
      ],
      debug: debugFor(google),
    };
  }

  if (status === 400) {
    return {
      kind: "chat.error_explanation",
      code: "invalid_request",
      category: "validation",
      httpStatus: 400,
      retryable: false,
      principal,
      intent,
      summary: "Google Chat rejected the request shape.",
      remediation: [
        "Validate the request body, response envelope, card surface, and required fields.",
      ],
      debug: debugFor(google),
    };
  }

  return {
    kind: "chat.error_explanation",
    code: "unknown",
    category: "unknown",
    httpStatus: status,
    retryable: false,
    principal,
    intent,
    summary: "The Google Chat failure did not match a curated SDK category.",
    remediation: [
      "Inspect the redacted debug metadata and rerun the narrow smoke command.",
    ],
    debug: debugFor(google),
  };
}
