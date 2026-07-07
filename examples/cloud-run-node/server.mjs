import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";

const port = Number(process.env.PORT ?? "8080");
const project = process.env.GOOGLE_CLOUD_PROJECT ?? "chat-ai-sdk";
const publicBaseUrl =
  process.env.GOOGLE_CHAT_BASE_URL ??
  process.env.BASE_URL ??
  "https://chat-ai-sdk-dev-webhook-zhmcqkt5jq-uc.a.run.app/api";
const eventSummaryLogsEnabled = process.env.GOOGLE_CHAT_LOG_EVENT_SUMMARY !== "0";
const CARD_ACTION_STATE_PARAMETER = "__googleChatAiState";
const feedbackActionNames = new Set(["ai_feedback", "ai_visual_feedback"]);
const idempotencyTtlMs = positiveEnvInteger(
  process.env.GOOGLE_CHAT_IDEMPOTENCY_TTL_MS,
  10 * 60 * 1000,
);
const idempotencyMaxEntries = positiveEnvInteger(
  process.env.GOOGLE_CHAT_IDEMPOTENCY_MAX_ENTRIES,
  500,
);
const idempotencyStore = createIdempotencyStore({
  mode: process.env.GOOGLE_CHAT_IDEMPOTENCY_STORE ?? "memory",
  project,
  filePath:
    process.env.GOOGLE_CHAT_IDEMPOTENCY_FILE ??
    "/tmp/googlechatai-sdk-idempotency.json",
  firestoreBaseUrl:
    process.env.GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_BASE_URL ??
    "https://firestore.googleapis.com/v1",
  firestoreDatabase:
    process.env.GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_DATABASE ?? "(default)",
  firestoreCollection:
    process.env.GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION ??
    "googleChatEventIdempotency",
  firestoreToken: process.env.GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_TOKEN ?? null,
  failOpen:
    process.env.GOOGLE_CHAT_IDEMPOTENCY_FAIL_OPEN !== "0" &&
    process.env.GOOGLE_CHAT_IDEMPOTENCY_FAIL_OPEN !== "false",
  ttlMs: idempotencyTtlMs,
  maxEntries: idempotencyMaxEntries,
});
const routePrefixes = ["", "/api"];
const avatarPng = createAvatarPng();

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function sendPng(response, payload) {
  response.writeHead(200, {
    "cache-control": "public, max-age=3600",
    "content-length": payload.length,
    "content-type": "image/png",
  });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");

  if (!raw) {
    return { raw, json: null };
  }

  try {
    return { raw, json: JSON.parse(raw) };
  } catch {
    return { raw, json: null };
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const routePath = normalizeRoutePath(url.pathname);

  if (request.method === "GET" && routePath === "/healthz") {
    sendJson(response, 200, {
      ok: true,
      service: "chat-ai-sdk-dev-webhook",
      project,
      basePath: url.pathname.startsWith("/api/") ? "/api" : "",
      now: new Date().toISOString(),
    });
    return;
  }

  if (request.method === "GET" && routePath === "/avatar.png") {
    sendPng(response, avatarPng);
    return;
  }

  if (request.method === "POST" && routePath === "/chat/events") {
    const body = await readBody(request);
    const addOnEnvelope = Boolean(body.json?.chat);
    const chatEvent = extractChatEvent(body.json, { addOnEnvelope });
    const eventType = classifyChatEvent(chatEvent, { addOnEnvelope });
    const messageName = getMessage(chatEvent)?.name ?? null;
    const eventIdentity = buildEventIdentitySummary(chatEvent, {
      addOnEnvelope,
      eventType,
    });
    const idempotency = shouldCreateChatMessage(chatEvent, { addOnEnvelope })
      ? await idempotencyStore.claim(eventIdentity.eventIdHash, {
          eventType,
          source: eventIdentity.source,
        })
      : null;
    const duplicateDelivery = Boolean(idempotency?.duplicate);

    const logEntry = {
      severity: "INFO",
      event: "chat_event_received",
      eventType,
      messageName,
      eventIdentity,
      duplicateDelivery,
      idempotency: summarizeIdempotencyClaim(idempotency),
      addOnEnvelope,
      hasAuthorization: Boolean(request.headers.authorization),
    };

    if (eventSummaryLogsEnabled) {
      logEntry.eventDebugSummary = buildEventDebugSummary(chatEvent, {
        addOnEnvelope,
        eventType,
      });
    }

    console.log(JSON.stringify(logEntry));

    const interactionResponse = buildInteractionResponse(chatEvent, {
      addOnEnvelope,
      eventType,
    });
    if (interactionResponse) {
      sendJson(response, 200, interactionResponse);
      return;
    }

    if (!shouldCreateChatMessage(chatEvent, { addOnEnvelope })) {
      sendJson(response, 200, {});
      return;
    }

    if (duplicateDelivery) {
      sendJson(response, 200, {});
      return;
    }

    const message = {
      text: "Google Chat AI SDK dev webhook received the event.",
    };

    sendJson(
      response,
      200,
      addOnEnvelope
        ? {
            hostAppDataAction: {
              chatDataAction: {
                createMessageAction: {
                  message,
                },
              },
            },
          }
        : message,
    );
    return;
  }

  sendJson(response, 404, {
    ok: false,
    error: "not_found",
    paths: routePrefixes.flatMap((prefix) => [
      `${prefix}/healthz`,
      `${prefix}/avatar.png`,
      `${prefix}/chat/events`,
    ]),
  });
});

function normalizeRoutePath(pathname) {
  const withoutTrailingSlash =
    pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  if (withoutTrailingSlash === "/api") {
    return "/";
  }

  if (withoutTrailingSlash.startsWith("/api/")) {
    return withoutTrailingSlash.slice("/api".length);
  }

  return withoutTrailingSlash;
}

function extractChatEvent(payload, { addOnEnvelope }) {
  if (!addOnEnvelope) {
    return payload;
  }

  const chat = asObject(payload?.chat) ?? {};

  return {
    ...chat,
    type: chat.type ?? payload?.type,
    eventType: chat.eventType ?? payload?.eventType,
    eventTime: chat.eventTime ?? payload?.eventTime,
    dialogEventType: chat.dialogEventType ?? payload?.dialogEventType,
    action: asObject(chat.action) ?? asObject(payload?.action) ?? undefined,
    common: asObject(chat.common) ?? asObject(payload?.common) ?? undefined,
    commonEventObject:
      asObject(chat.commonEventObject) ??
      asObject(payload?.commonEventObject) ??
      undefined,
    user: asObject(chat.user) ?? asObject(payload?.user) ?? undefined,
  };
}

function classifyChatEvent(chatEvent, { addOnEnvelope }) {
  if (!chatEvent) {
    return "unknown";
  }

  if (chatEvent.type || chatEvent.eventType) {
    return chatEvent.type ?? chatEvent.eventType;
  }

  if (addOnEnvelope) {
    if (chatEvent.messagePayload?.message) {
      return "message";
    }
    if (chatEvent.addedToSpacePayload) {
      return "added_to_space";
    }
    if (chatEvent.removedFromSpacePayload) {
      return "removed_from_space";
    }
    if (chatEvent.buttonClickedPayload) {
      return "button_clicked";
    }
    if (chatEvent.commonEventObject) {
      return "workspace_addon_event";
    }
  }

  return "unknown";
}

function buildInteractionResponse(chatEvent, { addOnEnvelope }) {
  const actionName = getActionName(chatEvent);

  if (!actionName) {
    return null;
  }

  const runId = getActionParameterValue(chatEvent, "runId") ?? "unknown-run";

  if (feedbackActionNames.has(actionName)) {
    const message = buildFeedbackActionUpdateMessage(chatEvent, actionName);

    return addOnEnvelope
      ? {
          hostAppDataAction: {
            chatDataAction: {
              updateMessageAction: {
                message,
              },
            },
          },
        }
      : {
          actionResponse: {
            type: "UPDATE_MESSAGE",
          },
          ...message,
        };
  }

  if (actionName === "googlechatai_sdk_card_mark_received") {
    const stateSummary = summarizeCardActionState(chatEvent);
    const message = buildInteractiveCardMessage({
      runId,
      statusText:
        stateSummary.present && stateSummary.decoded
          ? "Button action received by the dev webhook. State decoded."
          : "Button action received by the dev webhook.",
      actionComplete: true,
    });

    return addOnEnvelope
      ? {
          hostAppDataAction: {
            chatDataAction: {
              updateMessageAction: {
                message,
              },
            },
          },
        }
      : {
          actionResponse: {
            type: "UPDATE_MESSAGE",
          },
          ...message,
        };
  }

  if (actionName === "googlechatai_sdk_card_open_dialog") {
    const dialogCard = buildDialogCard(runId);

    return addOnEnvelope
      ? {
          action: {
            navigations: [
              {
                pushCard: dialogCard,
              },
            ],
          },
        }
      : {
          actionResponse: {
            type: "DIALOG",
            dialogAction: {
              dialog: {
                body: dialogCard,
              },
            },
          },
        };
  }

  if (actionName === "googlechatai_sdk_card_navigation_next") {
    const navigationCard = buildNavigationCard(runId);

    return addOnEnvelope
      ? {
          action: {
            navigations: [
              {
                pushCard: navigationCard,
              },
            ],
          },
        }
      : {
          actionResponse: {
            type: "DIALOG",
            dialogAction: {
              dialog: {
                body: navigationCard,
              },
            },
          },
        };
  }

  if (actionName === "googlechatai_sdk_card_navigation_update") {
    const navigationCard = buildNavigationUpdateCard(runId);

    return addOnEnvelope
      ? {
          action: {
            navigations: [
              {
                updateCard: navigationCard,
              },
            ],
          },
        }
      : {
          actionResponse: {
            type: "DIALOG",
            dialogAction: {
              dialog: {
                body: navigationCard,
              },
            },
          },
        };
  }

  if (actionName === "googlechatai_sdk_card_submit_dialog") {
    const message = {
      text: `[${runId}] Dialog smoke submitted.`,
    };

    return addOnEnvelope
      ? {
          hostAppDataAction: {
            chatDataAction: {
              createMessageAction: {
                message,
              },
            },
          },
        }
      : message;
  }

  return null;
}

function buildFeedbackActionUpdateMessage(chatEvent, actionName) {
  const originalMessage = getMessage(chatEvent) ?? {};
  const feedbackFunction = feedbackActionFunction(chatEvent, actionName);
  const text =
    stringOrNull(originalMessage.text) ??
    `Feedback ${normalizeFeedbackRating(getActionParameterValue(chatEvent, "rating")) ?? "received"}.`;
  const responseId = getActionParameterValue(chatEvent, "responseId");
  const runId = getActionParameterValue(chatEvent, "runId");
  const targetMessage =
    getActionParameterValue(chatEvent, "targetMessage") ??
    stringOrNull(originalMessage.name);
  const rating = normalizeFeedbackRating(getActionParameterValue(chatEvent, "rating"));
  const message = {
    fallbackText: text,
    text,
    accessoryWidgets: [
      {
        buttonList: {
          buttons: [
            feedbackActionButton({
              actionFunction: feedbackFunction,
              actionName,
              iconName: "thumb_up",
              altText:
                rating === "helpful" ? "Marked helpful" : "Mark helpful",
              rating: "helpful",
              selected: rating === "helpful",
              responseId,
              runId,
              targetMessage,
            }),
            feedbackActionButton({
              actionFunction: feedbackFunction,
              actionName,
              iconName: "thumb_down",
              altText:
                rating === "not_helpful"
                  ? "Marked not helpful"
                  : "Mark not helpful",
              rating: "not_helpful",
              selected: rating === "not_helpful",
              responseId,
              runId,
              targetMessage,
            }),
          ],
        },
      },
    ],
  };

  if (Array.isArray(originalMessage.cardsV2)) {
    message.cardsV2 = originalMessage.cardsV2;
  }

  return message;
}

function feedbackActionButton({
  actionFunction,
  actionName,
  iconName,
  altText,
  rating,
  selected,
  responseId,
  runId,
  targetMessage,
}) {
  const parameters = [
    { key: "actionName", value: actionName },
    ...(responseId ? [{ key: "responseId", value: responseId }] : []),
    { key: "rating", value: rating },
    ...(runId ? [{ key: "runId", value: runId }] : []),
    ...(targetMessage ? [{ key: "targetMessage", value: targetMessage }] : []),
  ];

  return dropNullish({
    icon: {
      materialIcon: {
        name: iconName,
        fill: true,
      },
    },
    altText,
    type: "BORDERLESS",
    color: selected ? feedbackRatingColor(rating) : null,
    onClick: {
      action: {
        function: actionFunction,
        parameters,
      },
    },
  });
}

function feedbackActionFunction(chatEvent, actionName) {
  const actionFunction = stringOrNull(getAction(chatEvent)?.function);
  if (actionFunction && actionFunction !== actionName) {
    return actionFunction;
  }
  return `${publicBaseUrl.replace(/\/$/, "")}/chat/events`;
}

function normalizeFeedbackRating(value) {
  const raw = stringOrNull(value)?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!raw) {
    return null;
  }
  if (["helpful", "thumbs_up", "thumbsup", "up", "positive"].includes(raw)) {
    return "helpful";
  }
  if (
    ["not_helpful", "unhelpful", "thumbs_down", "thumbsdown", "down", "negative"].includes(
      raw,
    )
  ) {
    return "not_helpful";
  }
  return null;
}

function feedbackRatingColor(rating) {
  if (rating === "not_helpful") {
    return {
      red: 0.75,
      green: 0.25,
      blue: 0.2,
      alpha: 1,
    };
  }

  return {
    red: 0.2,
    green: 0.55,
    blue: 0.25,
    alpha: 1,
  };
}

function buildEventDebugSummary(chatEvent, { addOnEnvelope, eventType }) {
  const message = getMessage(chatEvent);
  const common = asObject(chatEvent?.commonEventObject ?? chatEvent?.common);

  return dropNullish({
    sourceShape: addOnEnvelope ? "workspace_addon_envelope" : "direct_chat_event",
    kind: eventType,
    eventTime: stringOrNull(chatEvent?.eventTime ?? common?.time),
    dialogEventType: stringOrNull(chatEvent?.dialogEventType),
    space: summarizeSpace(getSpace(chatEvent, message)),
    user: summarizeUser(getUser(chatEvent, message)),
    message: summarizeMessage(message),
    action: summarizeAction(getAction(chatEvent), common, chatEvent),
    common: summarizeCommon(common),
    relationship: summarizeRelationship(message, chatEvent),
    identity: buildEventIdentitySummary(chatEvent, { addOnEnvelope, eventType }),
  });
}

function buildEventIdentitySummary(chatEvent, { addOnEnvelope, eventType }) {
  const message = getMessage(chatEvent);
  const common = asObject(chatEvent?.commonEventObject ?? chatEvent?.common);
  const rawKind =
    stringOrNull(chatEvent?.type ?? chatEvent?.eventType) ?? eventType ?? "UNKNOWN";
  const resourceName =
    stringOrNull(message?.name) ??
    stringOrNull(getSpace(chatEvent, message)?.name) ??
    getActionName(chatEvent) ??
    null;
  const eventTime =
    stringOrNull(chatEvent?.eventTime ?? common?.time ?? message?.createTime) ??
    null;
  const source = addOnEnvelope ? "workspace_addon_envelope" : "direct_chat_event";
  const material = `${source}:${rawKind}:${resourceName ?? "no-resource"}:${
    eventTime ?? "no-time"
  }`;

  return {
    source,
    rawKind,
    eventTime,
    resourceNameAvailable: resourceName !== null,
    resourceNameHash: resourceName ? stableHash(resourceName) : null,
    eventIdHash: stableHash(material),
    idempotencyKeyHash: stableHash(material),
    materialShape: "source:rawKind:resourceName:eventTime",
  };
}

function getMessage(chatEvent) {
  return (
    asObject(chatEvent?.message) ??
    asObject(chatEvent?.messagePayload?.message) ??
    asObject(chatEvent?.buttonClickedPayload?.message) ??
    null
  );
}

function getSpace(chatEvent, message) {
  return (
    asObject(chatEvent?.space) ??
    asObject(chatEvent?.spacePayload?.space) ??
    asObject(chatEvent?.addedToSpacePayload?.space) ??
    asObject(chatEvent?.removedFromSpacePayload?.space) ??
    asObject(message?.space) ??
    null
  );
}

function getUser(chatEvent, message) {
  return (
    asObject(chatEvent?.user) ??
    asObject(chatEvent?.userPayload?.user) ??
    asObject(chatEvent?.commonEventObject?.user) ??
    asObject(chatEvent?.common?.user) ??
    asObject(message?.sender) ??
    null
  );
}

function getAction(chatEvent) {
  return (
    asObject(chatEvent?.action) ??
    asObject(chatEvent?.buttonClickedPayload?.action) ??
    null
  );
}

function getActionName(chatEvent) {
  const action = getAction(chatEvent);
  const common = asObject(chatEvent?.commonEventObject ?? chatEvent?.common);
  const commonParameters = asObject(common?.parameters) ?? {};
  const actionParameterObject = actionParametersToObject(action?.parameters);

  return (
    stringOrNull(action?.actionMethodName) ??
    stringOrNull(commonParameters.actionName) ??
    actionParameterObject.actionName ??
    stringOrNull(common?.invokedFunction) ??
    stringOrNull(action?.function) ??
    null
  );
}

function getActionParameterValue(chatEvent, key) {
  const action = getAction(chatEvent);
  const common = asObject(chatEvent?.commonEventObject ?? chatEvent?.common);
  const parameters = {
    ...actionParametersToObject(action?.parameters),
    ...(asObject(common?.parameters) ?? {}),
  };

  return stringOrNull(parameters[key]);
}

function decodeCardActionState(encoded) {
  if (typeof encoded !== "string" || !encoded.startsWith("v1.")) {
    throw new TypeError("Card action state must use the v1. base64url format.");
  }

  return JSON.parse(Buffer.from(encoded.slice(3), "base64url").toString("utf8"));
}

function summarizeCardActionState(chatEvent) {
  const encoded = getActionParameterValue(chatEvent, CARD_ACTION_STATE_PARAMETER);

  if (!encoded) {
    return {
      present: false,
      decoded: false,
    };
  }

  try {
    const decoded = decodeCardActionState(encoded);
    const decodedObject = asObject(decoded);
    return dropNullish({
      present: true,
      decoded: true,
      encodedLength: encoded.length,
      encodedHash: stableHash(encoded),
      topLevelKeys: decodedObject ? Object.keys(decodedObject).sort() : [],
      nestedObjectKeys: decodedObject
        ? Object.fromEntries(
            Object.entries(decodedObject)
              .filter(([, value]) => asObject(value))
              .map(([key, value]) => [key, Object.keys(asObject(value)).sort()]),
          )
        : {},
    });
  } catch (error) {
    return {
      present: true,
      decoded: false,
      encodedLength: encoded.length,
      encodedHash: stableHash(encoded),
      errorName: error instanceof Error ? error.name : "Error",
    };
  }
}

function actionParametersToObject(parameters) {
  const out = {};

  for (const parameter of arrayOrEmpty(parameters)) {
    const key = stringOrNull(parameter?.key);
    const value = stringOrNull(parameter?.value);

    if (key !== null && value !== null) {
      out[key] = value;
    }
  }

  return out;
}

function summarizeMessage(message, depth = 0) {
  if (!message) {
    return null;
  }

  const attachments = arrayOrEmpty(message.attachment ?? message.attachments);
  const annotations = arrayOrEmpty(message.annotations);
  const cardsV2 = arrayOrEmpty(message.cardsV2);
  const quoted = asObject(message.quotedMessageMetadata);

  return dropNullish({
    name: stringOrNull(message.name),
    createTime: stringOrNull(message.createTime),
    lastUpdateTime: stringOrNull(message.lastUpdateTime),
    deleteTime: stringOrNull(message.deleteTime),
    sender: summarizeUser(message.sender),
    thread: summarizeThread(message.thread),
    text: summarizeText(message.text),
    formattedText: summarizeText(message.formattedText),
    cardsV2: summarizeCards(cardsV2),
    attachments: summarizeAttachments(attachments),
    annotations: summarizeAnnotations(annotations),
    slashCommand: summarizeCommand(message.slashCommand),
    appCommand: summarizeCommand(message.appCommandMetadata),
    emojiReactionSummaries: summarizeEmojiReactions(message.emojiReactionSummaries),
    quotedMessage: summarizeQuotedMessage(quoted, depth),
  });
}

function summarizeQuotedMessage(metadata, depth) {
  if (!metadata) {
    return null;
  }

  const quotedMessage = asObject(metadata.quotedMessage);
  const summary = dropNullish({
    name: stringOrNull(metadata.name ?? quotedMessage?.name),
    hasMessage: Boolean(quotedMessage),
  });

  if (quotedMessage && depth < 3) {
    summary.message = summarizeMessage(quotedMessage, depth + 1);
  } else if (quotedMessage) {
    summary.message = {
      name: stringOrNull(quotedMessage.name),
      truncated: true,
    };
  }

  return summary;
}

function summarizeSpace(space) {
  if (!space) {
    return null;
  }

  return dropNullish({
    name: stringOrNull(space.name),
    type: stringOrNull(space.type ?? space.spaceType),
    displayName: stringOrNull(space.displayName),
  });
}

function summarizeUser(user) {
  if (!user) {
    return null;
  }

  const email = stringOrNull(user.email);
  const displayName = stringOrNull(user.displayName);

  return dropNullish({
    name: stringOrNull(user.name),
    type: stringOrNull(user.type),
    isApp: user.type === "BOT" || user.type === "APP",
    displayNameAvailable: displayName !== null,
    displayNameHash: displayName ? stableHash(displayName) : null,
    emailAvailable: email !== null,
    emailDomain: email?.includes("@") ? email.split("@").at(-1) : null,
  });
}

function summarizeThread(thread) {
  if (!thread) {
    return null;
  }

  return dropNullish({
    name: stringOrNull(thread.name),
    threadKey: stringOrNull(thread.threadKey),
  });
}

function summarizeText(value) {
  const text = stringOrNull(value);

  if (text === null) {
    return null;
  }

  return {
    length: text.length,
    sha256: stableHash(text),
  };
}

function summarizeCards(cardsV2) {
  return {
    count: cardsV2.length,
    cardIds: cardsV2
      .map((card) => stringOrNull(card.cardId))
      .filter(Boolean),
  };
}

function summarizeAttachments(attachments) {
  return {
    count: attachments.length,
    items: attachments.map((attachment) =>
      dropNullish({
        name: stringOrNull(attachment.name),
        contentName: stringOrNull(attachment.contentName),
        contentType: stringOrNull(attachment.contentType),
        source: stringOrNull(attachment.source),
        sizeBytes: numberOrNull(attachment.sizeBytes),
        hasAttachmentDataRef: Boolean(attachment.attachmentDataRef),
        hasDriveDataRef: Boolean(attachment.driveDataRef),
        mediaResourceName: stringOrNull(attachment.attachmentDataRef?.resourceName),
        driveFileIdAvailable:
          typeof attachment.driveDataRef?.driveFileId === "string",
      }),
    ),
  };
}

function summarizeAnnotations(annotations) {
  const byType = {};

  for (const annotation of annotations) {
    const type = stringOrNull(annotation.type) ?? "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
  }

  return {
    count: annotations.length,
    byType,
    userMentionCount: annotations.filter((annotation) => annotation.userMention)
      .length,
    slashCommandCount: annotations.filter((annotation) => annotation.slashCommand)
      .length,
  };
}

function summarizeCommand(command) {
  if (!command) {
    return null;
  }

  return dropNullish({
    commandId: stringOrNull(command.commandId),
    commandName: stringOrNull(command.commandName),
    type: stringOrNull(command.type),
  });
}

function summarizeEmojiReactions(reactions) {
  const items = arrayOrEmpty(reactions);

  if (items.length === 0) {
    return { count: 0 };
  }

  return {
    count: items.length,
    emojiKeys: items
      .map((item) => stringOrNull(item.emoji?.unicode ?? item.emoji?.customEmoji?.uid))
      .filter(Boolean),
  };
}

function summarizeAction(action, common, chatEvent) {
  if (!action && !common) {
    return null;
  }

  const parameters = arrayOrEmpty(action?.parameters);
  const actionParameterObject = actionParametersToObject(parameters);
  const commonParameters = asObject(common?.parameters) ?? {};
  const formInputs = asObject(common?.formInputs) ?? {};

  return dropNullish({
    methodName: stringOrNull(
      action?.actionMethodName ??
        commonParameters.actionName ??
        actionParameterObject.actionName ??
        common?.invokedFunction ??
        action?.function,
    ),
    dialogEventType: stringOrNull(chatEvent?.dialogEventType),
    parameterCount:
      parameters.length + Object.keys(commonParameters).length,
    parameterKeys: [
      ...parameters.map((parameter) => stringOrNull(parameter.key)),
      ...Object.keys(commonParameters),
    ].filter(Boolean),
    cardActionState: summarizeCardActionState(chatEvent),
    formInputCount: Object.keys(formInputs).length,
    formInputKeys: Object.keys(formInputs),
  });
}

function summarizeCommon(common) {
  if (!common) {
    return null;
  }

  return dropNullish({
    invokedFunction: stringOrNull(common.invokedFunction),
    userLocale: stringOrNull(common.userLocale),
    timeZoneId: stringOrNull(common.timeZone?.id),
    hasParameters: Boolean(common.parameters),
    formInputCount: Object.keys(asObject(common.formInputs) ?? {}).length,
  });
}

function summarizeRelationship(message, chatEvent) {
  const quoted = asObject(message?.quotedMessageMetadata);

  return {
    hasThread: Boolean(message?.thread),
    hasQuotedMessage: Boolean(quoted),
    quoteDepth: quoted ? measureQuoteDepth(quoted) : 0,
    hasSlashCommand: Boolean(message?.slashCommand),
    hasAppCommand: Boolean(message?.appCommandMetadata),
    hasAction: Boolean(getAction(chatEvent) ?? chatEvent?.commonEventObject),
  };
}

function measureQuoteDepth(metadata, depth = 1) {
  const next = asObject(metadata?.quotedMessage?.quotedMessageMetadata);

  if (!next || depth >= 4) {
    return depth;
  }

  return measureQuoteDepth(next, depth + 1);
}

function dropNullish(input) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== null && value !== undefined),
  );
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value) {
  return typeof value === "number" ? value : null;
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(project)
    .update("\0")
    .update(value)
    .digest("hex");
}

function positiveEnvInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nowMs() {
  return Date.now();
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function summarizeIdempotencyClaim(claim) {
  if (!claim) {
    return null;
  }
  return {
    mode: claim.mode,
    claimed: claim.claimed,
    duplicate: claim.duplicate,
    firstSeenAt: claim.firstSeenAt,
    lastSeenAt: claim.lastSeenAt,
    expiresAt: claim.expiresAt,
    seenCount: claim.seenCount,
    error: claim.error ?? null,
  };
}

function createIdempotencyStore({
  mode,
  project,
  filePath,
  firestoreBaseUrl,
  firestoreDatabase,
  firestoreCollection,
  firestoreToken,
  failOpen,
  ttlMs,
  maxEntries,
}) {
  if (mode === "off" || mode === "disabled" || mode === "0") {
    return {
      async claim() {
        return {
          mode: "disabled",
          claimed: true,
          duplicate: false,
          firstSeenAt: null,
          lastSeenAt: null,
          expiresAt: null,
          seenCount: 1,
        };
      },
    };
  }

  if (mode === "file") {
    return createFileIdempotencyStore({ filePath, ttlMs, maxEntries });
  }

  if (mode === "firestore") {
    return createFirestoreIdempotencyStore({
      project,
      baseUrl: firestoreBaseUrl,
      database: firestoreDatabase,
      collection: firestoreCollection,
      explicitToken: firestoreToken,
      ttlMs,
      failOpen,
    });
  }

  return createMemoryIdempotencyStore({ ttlMs, maxEntries });
}

function createMemoryIdempotencyStore({ ttlMs, maxEntries }) {
  const entries = new Map();

  return {
    async claim(key, metadata = {}) {
      return claimIdempotencyEntry(entries, key, {
        mode: "memory",
        ttlMs,
        maxEntries,
        metadata,
      });
    },
  };
}

function createFileIdempotencyStore({ filePath, ttlMs, maxEntries }) {
  return {
    async claim(key, metadata = {}) {
      const entries = await readIdempotencyFile(filePath);
      const claim = claimIdempotencyEntry(entries, key, {
        mode: "file",
        ttlMs,
        maxEntries,
        metadata,
      });
      await writeIdempotencyFile(filePath, entries);
      return claim;
    },
  };
}

async function readIdempotencyFile(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return new Map(
      Object.entries(parsed.entries ?? {}).map(([key, entry]) => [
        key,
        {
          firstSeenAtMs: Date.parse(entry.firstSeenAt),
          lastSeenAtMs: Date.parse(entry.lastSeenAt),
          expiresAtMs: Date.parse(entry.expiresAt),
          seenCount: positiveEnvInteger(entry.seenCount, 1),
          metadata: asObject(entry.metadata) ?? {},
        },
      ]),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
}

async function writeIdempotencyFile(filePath, entries) {
  const payload = {
    version: 1,
    entries: Object.fromEntries(
      [...entries.entries()].map(([key, entry]) => [
        key,
        {
          firstSeenAt: iso(entry.firstSeenAtMs),
          lastSeenAt: iso(entry.lastSeenAtMs),
          expiresAt: iso(entry.expiresAtMs),
          seenCount: entry.seenCount,
          metadata: entry.metadata,
        },
      ]),
    ),
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
}

function claimIdempotencyEntry(entries, key, { mode, ttlMs, maxEntries, metadata }) {
  const currentMs = nowMs();
  for (const [entryKey, entry] of entries) {
    if (entry.expiresAtMs <= currentMs) {
      entries.delete(entryKey);
    }
  }

  const existing = entries.get(key);
  if (existing) {
    existing.lastSeenAtMs = currentMs;
    existing.seenCount += 1;
    return claimFromEntry(key, existing, {
      mode,
      claimed: false,
      duplicate: true,
    });
  }

  const entry = {
    firstSeenAtMs: currentMs,
    lastSeenAtMs: currentMs,
    expiresAtMs: currentMs + ttlMs,
    seenCount: 1,
    metadata,
  };
  entries.set(key, entry);
  while (entries.size > maxEntries) {
    const oldest = [...entries.entries()].sort(
      ([, left], [, right]) => left.expiresAtMs - right.expiresAtMs,
    )[0];
    if (!oldest) {
      break;
    }
    entries.delete(oldest[0]);
  }
  return claimFromEntry(key, entry, {
    mode,
    claimed: true,
    duplicate: false,
  });
}

function claimFromEntry(key, entry, { mode, claimed, duplicate }) {
  return {
    key,
    mode,
    claimed,
    duplicate,
    firstSeenAt: iso(entry.firstSeenAtMs),
    lastSeenAt: iso(entry.lastSeenAtMs),
    expiresAt: iso(entry.expiresAtMs),
    seenCount: entry.seenCount,
  };
}

function createFirestoreIdempotencyStore({
  project,
  baseUrl,
  database,
  collection,
  explicitToken,
  ttlMs,
  failOpen,
}) {
  const documentsBase = [
    trimTrailingSlash(baseUrl),
    "projects",
    encodeURIComponent(project),
    "databases",
    encodeURIComponent(database),
    "documents",
  ].join("/");
  const collectionPath = collection
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");

  if (!collectionPath) {
    throw new Error("GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION is required.");
  }

  return {
    async claim(key, metadata = {}) {
      try {
        return await claimFirestoreEntry({
          documentsBase,
          collectionPath,
          explicitToken,
          key,
          metadata,
          ttlMs,
        });
      } catch (error) {
        if (!failOpen) {
          throw error;
        }
        const currentMs = nowMs();
        return {
          key,
          mode: "firestore-fail-open",
          claimed: true,
          duplicate: false,
          firstSeenAt: iso(currentMs),
          lastSeenAt: iso(currentMs),
          expiresAt: iso(currentMs + ttlMs),
          seenCount: 1,
          error: sanitizeStoreError(error),
        };
      }
    },
  };
}

async function claimFirestoreEntry({
  documentsBase,
  collectionPath,
  explicitToken,
  key,
  metadata,
  ttlMs,
}) {
  const currentMs = nowMs();
  const entry = {
    firstSeenAtMs: currentMs,
    lastSeenAtMs: currentMs,
    expiresAtMs: currentMs + ttlMs,
    seenCount: 1,
    metadata,
  };
  const token = await getFirestoreAccessToken(explicitToken);
  const createUrl = new URL(`${documentsBase}/${collectionPath}`);
  createUrl.searchParams.set("documentId", key);
  const createResponse = await firestoreRequest(createUrl, {
    token,
    method: "POST",
    body: firestoreDocumentPayload(entry),
  });

  if (createResponse.ok) {
    return claimFromEntry(key, entry, {
      mode: "firestore",
      claimed: true,
      duplicate: false,
    });
  }

  if (createResponse.status !== 409) {
    throw new Error(
      `Firestore idempotency create failed: HTTP ${createResponse.status}`,
    );
  }

  const duplicate = await readFirestoreEntry({
    documentsBase,
    collectionPath,
    token,
    key,
  });
  duplicate.lastSeenAtMs = currentMs;
  duplicate.seenCount += 1;
  await patchFirestoreDuplicate({
    documentsBase,
    collectionPath,
    token,
    key,
    entry: duplicate,
  });
  return claimFromEntry(key, duplicate, {
    mode: "firestore",
    claimed: false,
    duplicate: true,
  });
}

async function getFirestoreAccessToken(explicitToken) {
  if (explicitToken) {
    return explicitToken;
  }

  const response = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    {
      headers: {
        "Metadata-Flavor": "Google",
      },
    },
  );
  const json = await response.json().catch(() => ({}));

  if (!response.ok || typeof json.access_token !== "string") {
    throw new Error(`Metadata token request failed: HTTP ${response.status}`);
  }

  return json.access_token;
}

async function firestoreRequest(url, { token, method, body = null }) {
  return fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function readFirestoreEntry({ documentsBase, collectionPath, token, key }) {
  const response = await firestoreRequest(
    `${documentsBase}/${collectionPath}/${encodeURIComponent(key)}`,
    {
      token,
      method: "GET",
    },
  );
  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Firestore idempotency read failed: HTTP ${response.status}`);
  }

  return entryFromFirestoreFields(json.fields ?? {});
}

async function patchFirestoreDuplicate({
  documentsBase,
  collectionPath,
  token,
  key,
  entry,
}) {
  const url = new URL(
    `${documentsBase}/${collectionPath}/${encodeURIComponent(key)}`,
  );
  url.searchParams.append("updateMask.fieldPaths", "lastSeenAt");
  url.searchParams.append("updateMask.fieldPaths", "seenCount");
  const response = await firestoreRequest(url, {
    token,
    method: "PATCH",
    body: {
      fields: {
        lastSeenAt: { timestampValue: iso(entry.lastSeenAtMs) },
        seenCount: { integerValue: String(entry.seenCount) },
      },
    },
  });

  if (!response.ok) {
    throw new Error(`Firestore idempotency patch failed: HTTP ${response.status}`);
  }
}

function firestoreDocumentPayload(entry) {
  return {
    fields: {
      firstSeenAt: { timestampValue: iso(entry.firstSeenAtMs) },
      lastSeenAt: { timestampValue: iso(entry.lastSeenAtMs) },
      expiresAt: { timestampValue: iso(entry.expiresAtMs) },
      seenCount: { integerValue: String(entry.seenCount) },
      metadataJson: { stringValue: JSON.stringify(entry.metadata ?? {}) },
    },
  };
}

function entryFromFirestoreFields(fields) {
  return {
    firstSeenAtMs: Date.parse(fields.firstSeenAt?.timestampValue),
    lastSeenAtMs: Date.parse(fields.lastSeenAt?.timestampValue),
    expiresAtMs: Date.parse(fields.expiresAt?.timestampValue),
    seenCount: positiveEnvInteger(Number(fields.seenCount?.integerValue), 1),
    metadata: parseJsonObject(fields.metadataJson?.stringValue) ?? {},
  };
}

function trimTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function parseJsonObject(value) {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  try {
    return asObject(JSON.parse(value));
  } catch {
    return null;
  }
}

function sanitizeStoreError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function shouldCreateChatMessage(chatEvent, { addOnEnvelope }) {
  if (!chatEvent) {
    return false;
  }

  if (addOnEnvelope) {
    return Boolean(chatEvent.messagePayload?.message);
  }

  return chatEvent.type === "MESSAGE" || chatEvent.eventType === "MESSAGE";
}

function buildInteractiveCardMessage({
  runId,
  statusText = "Waiting for a card button click.",
  actionComplete = false,
}) {
  return {
    text: `[${runId}] Card action smoke fallback text.`,
    cardsV2: [
      {
        cardId: `card-action-smoke-${runId}`,
        card: {
          header: {
            title: "Google Chat AI SDK Card Action Smoke",
            subtitle: runId,
            imageUrl: `${publicBaseUrl}/avatar.png`,
            imageType: "CIRCLE",
          },
          sections: [
            {
              header: "Interactive actions",
              widgets: [
                {
                  decoratedText: {
                    topLabel: actionComplete ? "Updated state" : "Initial state",
                    text: statusText,
                    startIcon: {
                      knownIcon: "DESCRIPTION",
                    },
                  },
                },
                {
                  buttonList: {
                    buttons: [
                      {
                        text: "Mark received",
                        onClick: {
                          action: {
                            function: `${publicBaseUrl}/chat/events`,
                            parameters: [
                              {
                                key: "actionName",
                                value:
                                  "googlechatai_sdk_card_mark_received",
                              },
                              {
                                key: "runId",
                                value: runId,
                              },
                            ],
                          },
                        },
                      },
                      {
                        text: "Open dialog",
                        onClick: {
                          action: {
                            function: `${publicBaseUrl}/chat/events`,
                            interaction: "OPEN_DIALOG",
                            parameters: [
                              {
                                key: "actionName",
                                value:
                                  "googlechatai_sdk_card_open_dialog",
                              },
                              {
                                key: "runId",
                                value: runId,
                              },
                            ],
                          },
                        },
                      },
                      {
                        text: "Open navigation",
                        onClick: {
                          action: {
                            function: `${publicBaseUrl}/chat/events`,
                            interaction: "OPEN_DIALOG",
                            parameters: [
                              {
                                key: "actionName",
                                value:
                                  "googlechatai_sdk_card_navigation_next",
                              },
                              {
                                key: "runId",
                                value: runId,
                              },
                            ],
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

function buildDialogCard(runId) {
  return {
    header: {
      title: "Google Chat AI SDK Dialog Smoke",
      subtitle: runId,
      imageUrl: `${publicBaseUrl}/avatar.png`,
      imageType: "CIRCLE",
    },
    sections: [
      {
        header: "Dialog submission",
        widgets: [
          {
            textInput: {
              name: "smoke_note",
              label: "Smoke note",
              type: "SINGLE_LINE",
            },
          },
          {
            buttonList: {
              buttons: [
                {
                  text: "Submit dialog",
                  onClick: {
                    action: {
                      function: `${publicBaseUrl}/chat/events`,
                      parameters: [
                        {
                          key: "actionName",
                          value: "googlechatai_sdk_card_submit_dialog",
                        },
                        {
                          key: "runId",
                          value: runId,
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function buildNavigationCard(runId) {
  return {
    header: {
      title: "Google Chat AI SDK Navigation Smoke",
      subtitle: runId,
      imageUrl: `${publicBaseUrl}/avatar.png`,
      imageType: "CIRCLE",
    },
    sections: [
      {
        header: "Pushed card",
        widgets: [
          {
            decoratedText: {
              topLabel: "NAVIGATION",
              text: "The dev webhook returned a pushCard navigation response.",
              startIcon: {
                knownIcon: "DESCRIPTION",
              },
            },
          },
          {
            buttonList: {
              buttons: [
                {
                  text: "Update top card",
                  onClick: {
                    action: {
                      function: `${publicBaseUrl}/chat/events`,
                      parameters: [
                        {
                          key: "actionName",
                          value: "googlechatai_sdk_card_navigation_update",
                        },
                        {
                          key: "runId",
                          value: runId,
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function buildNavigationUpdateCard(runId) {
  return {
    header: {
      title: "Google Chat AI SDK Navigation Update Smoke",
      subtitle: runId,
      imageUrl: `${publicBaseUrl}/avatar.png`,
      imageType: "CIRCLE",
    },
    sections: [
      {
        header: "Updated top card",
        widgets: [
          {
            decoratedText: {
              topLabel: "NAVIGATION",
              text: "The dev webhook returned an updateCard navigation response.",
              startIcon: {
                knownIcon: "DESCRIPTION",
              },
            },
          },
        ],
      },
    ],
  };
}

function createAvatarPng() {
  const size = 256;
  const bytesPerPixel = 4;
  const rowLength = 1 + size * bytesPerPixel;
  const raw = Buffer.alloc(rowLength * size);

  for (let y = 0; y < size; y += 1) {
    const row = y * rowLength;
    raw[row] = 0;

    for (let x = 0; x < size; x += 1) {
      const offset = row + 1 + x * bytesPerPixel;
      const inDiagonal = Math.abs(x - y) < 18 || Math.abs(x + y - size) < 18;
      const inCenter = x >= 72 && x < 184 && y >= 72 && y < 184;

      raw[offset] = inDiagonal ? 52 : inCenter ? 255 : 26;
      raw[offset + 1] = inDiagonal ? 168 : inCenter ? 255 : 115;
      raw[offset + 2] = inDiagonal ? 83 : inCenter ? 255 : 232;
      raw[offset + 3] = 255;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", createIhdr(size, size)),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createIhdr(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return ihdr;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc ^= byte;

    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

server.listen(port, () => {
  console.log(
    JSON.stringify({
      severity: "INFO",
      event: "server_started",
      port,
      project,
    }),
  );
});
