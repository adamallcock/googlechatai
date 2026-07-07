import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const DEFAULT_BASE_URL =
  "https://chat-ai-sdk-dev-webhook-zhmcqkt5jq-uc.a.run.app/api";

const variantNames = [
  "mark_received",
  "stateful_mark_received",
  "open_dialog",
  "card_navigation_next",
  "card_navigation_update",
  "submit_dialog",
  "feedback_helpful",
  "feedback_not_helpful",
  "unknown_action",
  "cancel_dialog",
];
const CARD_ACTION_STATE_PARAMETER = "__googleChatAiState";

function parseArgs(argv) {
  const args = {
    dryRun: false,
    webhookUrl: null,
    evidencePath: null,
    runId: null,
    variants: [],
    help: false,
  };
  const rest = argv.slice(2);

  const readRequiredValue = (index, option) => {
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value.`);
    }
    return value;
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--") {
      continue;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--webhook-url") {
      args.webhookUrl = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--webhook-url=")) {
      args.webhookUrl = arg.slice("--webhook-url=".length);
    } else if (arg === "--evidence") {
      args.evidencePath = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--evidence=")) {
      args.evidencePath = arg.slice("--evidence=".length);
    } else if (arg === "--run-id") {
      args.runId = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--run-id=")) {
      args.runId = arg.slice("--run-id=".length);
    } else if (arg === "--variant") {
      args.variants.push(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--variant=")) {
      args.variants.push(arg.slice("--variant=".length));
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function resolvePath(input, cwd = process.cwd()) {
  if (!input) {
    return null;
  }
  return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `card-action-webhook-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function normalizeWebhookUrl(env, argUrl) {
  const raw =
    argUrl ??
    env.GOOGLE_CHAT_WEBHOOK_URL ??
    env.GOOGLE_CHAT_BASE_URL ??
    env.BASE_URL ??
    DEFAULT_BASE_URL;
  const trimmed = String(raw).replace(/\/+$/, "");

  if (trimmed.endsWith("/chat/events")) {
    return trimmed;
  }

  return `${trimmed}/chat/events`;
}

export function loadCardActionWebhookSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_CHAT_CARD_ACTION_WEBHOOK_SMOKE !== "1" && !args.dryRun) {
    throw new Error(
      "Refusing to run card-action webhook smoke without RUN_LIVE_CHAT_CARD_ACTION_WEBHOOK_SMOKE=1.",
    );
  }

  const selectedVariants = args.variants.length > 0 ? args.variants : variantNames;
  for (const variant of selectedVariants) {
    if (!variantNames.includes(variant)) {
      throw new Error(`Unknown variant: ${variant}`);
    }
  }

  return {
    dryRun: args.dryRun,
    webhookUrl: normalizeWebhookUrl(env, args.webhookUrl),
    runId:
      args.runId ??
      env.GOOGLE_CHAT_CARD_ACTION_WEBHOOK_SMOKE_RUN_ID ??
      makeRunId(),
    variants: selectedVariants,
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_CARD_ACTION_WEBHOOK_SMOKE_EVIDENCE,
      cwd,
    ),
  };
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update("googlechatai-card-action-webhook-smoke")
    .update("\0")
    .update(String(value ?? ""))
    .digest("hex");
}

function textSummary(value) {
  const text = typeof value === "string" ? value : "";
  return {
    available: text.length > 0,
    length: text.length,
    sha256: text.length > 0 ? stableHash(text) : null,
  };
}

function encodeCardActionState(state) {
  return `v1.${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")}`;
}

function stateForVariant(runId, variant) {
  if (variant !== "stateful_mark_received") {
    return null;
  }

  return {
    cursor: "card-action-smoke-page-2",
    approval: {
      id: `stateful-${runId}`,
      version: 1,
    },
  };
}

function dialogEventTypeForVariant(variant) {
  if (variant === "submit_dialog") {
    return "SUBMIT_DIALOG";
  }
  if (variant === "cancel_dialog") {
    return "CANCEL_DIALOG";
  }
  if (
    variant === "open_dialog" ||
    variant === "card_navigation_next" ||
    variant === "card_navigation_update"
  ) {
    return "REQUEST_DIALOG";
  }
  return undefined;
}

function variantPayload(runId, variant) {
  const actionName = {
    mark_received: "googlechatai_sdk_card_mark_received",
    stateful_mark_received: "googlechatai_sdk_card_mark_received",
    open_dialog: "googlechatai_sdk_card_open_dialog",
    card_navigation_next: "googlechatai_sdk_card_navigation_next",
    card_navigation_update: "googlechatai_sdk_card_navigation_update",
    submit_dialog: "googlechatai_sdk_card_submit_dialog",
    feedback_helpful: "ai_visual_feedback",
    feedback_not_helpful: "ai_visual_feedback",
    unknown_action: "googlechatai_sdk_card_unknown_action",
    cancel_dialog: "googlechatai_sdk_card_cancel_dialog",
  }[variant];
  const messageName = `spaces/TEST/messages/${variant}`;
  const state = stateForVariant(runId, variant);
  const encodedState = state ? encodeCardActionState(state) : null;
  const feedbackRating =
    variant === "feedback_helpful"
      ? "helpful"
      : variant === "feedback_not_helpful"
        ? "not_helpful"
        : null;
  const commonEventObject = {
    time: new Date().toISOString(),
    parameters: {
      actionName,
      runId,
      ...(feedbackRating ? { responseId: runId, rating: feedbackRating } : {}),
      ...(encodedState ? { [CARD_ACTION_STATE_PARAMETER]: encodedState } : {}),
    },
  };

  if (variant === "submit_dialog") {
    commonEventObject.formInputs = {
      smoke_note: {
        stringInputs: {
          value: ["redacted-direct-webhook-smoke"],
        },
      },
    };
  }

  return {
    type: "CARD_CLICKED",
    dialogEventType: dialogEventTypeForVariant(variant),
    commonEventObject,
    chat: {
      type: "CARD_CLICKED",
      eventTime: new Date().toISOString(),
      dialogEventType: dialogEventTypeForVariant(variant),
      commonEventObject,
      buttonClickedPayload: {
        message: {
          name: messageName,
          ...(feedbackRating
            ? {
                text: `[${runId}] Answer smoke with low-impact accessory feedback controls.`,
              }
            : {}),
          thread: { name: "spaces/TEST/threads/card-action-webhook" },
          space: { name: "spaces/TEST", type: "ROOM" },
        },
        action: {
          actionMethodName: actionName,
          parameters: [
            { key: "actionName", value: actionName },
            { key: "runId", value: runId },
            ...(feedbackRating
              ? [
                  { key: "responseId", value: runId },
                  { key: "rating", value: feedbackRating },
                ]
              : []),
            ...(encodedState
              ? [{ key: CARD_ACTION_STATE_PARAMETER, value: encodedState }]
              : []),
          ],
        },
      },
    },
  };
}

export function buildCardActionWebhookPlan(config) {
  return {
    mode: config.dryRun ? "dry-run" : "live-direct-webhook",
    runId: config.runId,
    webhookUrlHash: stableHash(config.webhookUrl),
    variants: config.variants,
    calls: config.variants.map((variant) => ({
      operation: `card-action-webhook.${variant}`,
      method: "POST",
      path: "/api/chat/events",
      writes: false,
      responseShape: expectedShape(variant),
      safetyCheck:
        "Direct Cloud Run fixture post; does not send Chat messages or DM users.",
    })),
    privacy: {
      rawPayloadsSaved: false,
      rawFormValuesSaved: false,
      rawActionStateSaved: false,
      rawWebhookUrlSaved: false,
    },
  };
}

function expectedShape(variant) {
  if (
    variant === "mark_received" ||
    variant === "stateful_mark_received" ||
    variant === "feedback_helpful" ||
    variant === "feedback_not_helpful"
  ) {
    return "updateMessageAction";
  }
  if (variant === "open_dialog" || variant === "card_navigation_next") {
    return "pushCard";
  }
  if (variant === "card_navigation_update") {
    return "updateCard";
  }
  if (variant === "submit_dialog") {
    return "createMessageAction";
  }
  return "emptyObject";
}

function summarizeResponse(variant, status, json) {
  const response = {
    status,
    shape: responseShape(json),
    assertions: assertVariantResponse(variant, json),
  };

  if (variant === "submit_dialog") {
    response.createdText = textSummary(
      json.hostAppDataAction?.chatDataAction?.createMessageAction?.message?.text,
    );
  }
  if (variant === "mark_received" || variant === "stateful_mark_received") {
    response.updatedCardText = textSummary(
      json.hostAppDataAction?.chatDataAction?.updateMessageAction?.message
        ?.cardsV2?.[0]?.card?.sections?.[0]?.widgets?.[0]?.decoratedText?.text,
    );
  }
  if (variant === "feedback_helpful" || variant === "feedback_not_helpful") {
    const buttons =
      json.hostAppDataAction?.chatDataAction?.updateMessageAction?.message
        ?.accessoryWidgets?.[0]?.buttonList?.buttons ?? [];
    response.updatedText = textSummary(
      json.hostAppDataAction?.chatDataAction?.updateMessageAction?.message?.text,
    );
    response.accessoryWidgetSummary = {
      buttonCount: Array.isArray(buttons) ? buttons.length : 0,
      selectedIconNames: Array.isArray(buttons)
        ? buttons
            .filter((button) => button?.color)
            .map((button) => button?.icon?.materialIcon?.name)
            .filter(Boolean)
        : [],
    };
  }
  if (variant === "open_dialog") {
    response.dialogTitle = textSummary(
      json.action?.navigations?.[0]?.pushCard?.header?.title,
    );
  }
  if (variant === "card_navigation_next") {
    response.navigationTitle = textSummary(
      json.action?.navigations?.[0]?.pushCard?.header?.title,
    );
  }
  if (variant === "card_navigation_update") {
    response.navigationTitle = textSummary(
      json.action?.navigations?.[0]?.updateCard?.header?.title,
    );
  }

  return response;
}

function responseShape(json) {
  if (json.hostAppDataAction?.chatDataAction?.updateMessageAction) {
    return "updateMessageAction";
  }
  if (json.action?.navigations?.[0]?.pushCard) {
    return "pushCard";
  }
  if (json.action?.navigations?.[0]?.updateCard) {
    return "updateCard";
  }
  if (json.hostAppDataAction?.chatDataAction?.createMessageAction) {
    return "createMessageAction";
  }
  if (json && Object.keys(json).length === 0) {
    return "emptyObject";
  }
  return "unknown";
}

function assertVariantResponse(variant, json) {
  const shape = responseShape(json);
  const assertions = {
    expectedShape: shape === expectedShape(variant),
  };

  if (variant === "mark_received" || variant === "stateful_mark_received") {
    assertions.updatedCardHasCards =
      Array.isArray(
        json.hostAppDataAction?.chatDataAction?.updateMessageAction?.message
          ?.cardsV2,
      ) &&
      json.hostAppDataAction.chatDataAction.updateMessageAction.message.cardsV2
        .length === 1;
  }
  if (variant === "stateful_mark_received") {
    const statusText =
      json.hostAppDataAction?.chatDataAction?.updateMessageAction?.message
        ?.cardsV2?.[0]?.card?.sections?.[0]?.widgets?.[0]?.decoratedText?.text;
    assertions.stateDecodedAcknowledged =
      typeof statusText === "string" && statusText.includes("State decoded");
  }
  if (variant === "feedback_helpful" || variant === "feedback_not_helpful") {
    const message =
      json.hostAppDataAction?.chatDataAction?.updateMessageAction?.message;
    const buttons = message?.accessoryWidgets?.[0]?.buttonList?.buttons;
    const selectedIcon =
      variant === "feedback_helpful" ? "thumb_up" : "thumb_down";
    assertions.feedbackPreservesText =
      typeof message?.text === "string" && message.text.includes("Answer smoke");
    assertions.feedbackHasAccessoryThumbs =
      Array.isArray(buttons) &&
      buttons.length === 2 &&
      buttons.some((button) => button?.icon?.materialIcon?.name === "thumb_up") &&
      buttons.some(
        (button) => button?.icon?.materialIcon?.name === "thumb_down",
      );
    assertions.feedbackSelectedIconTinted =
      Array.isArray(buttons) &&
      buttons.some(
        (button) =>
          button?.icon?.materialIcon?.name === selectedIcon && Boolean(button?.color),
      );
  }
  if (variant === "open_dialog" || variant === "card_navigation_next") {
    assertions.dialogHasCard = Boolean(
      json.action?.navigations?.[0]?.pushCard?.sections,
    );
  }
  if (variant === "card_navigation_next") {
    assertions.navigationTitleMatches =
      json.action?.navigations?.[0]?.pushCard?.header?.title ===
      "Google Chat AI SDK Navigation Smoke";
  }
  if (variant === "card_navigation_update") {
    assertions.updateCardHasCard = Boolean(
      json.action?.navigations?.[0]?.updateCard?.sections,
    );
    assertions.navigationTitleMatches =
      json.action?.navigations?.[0]?.updateCard?.header?.title ===
      "Google Chat AI SDK Navigation Update Smoke";
  }
  if (variant === "submit_dialog") {
    assertions.createMessageHasText =
      typeof json.hostAppDataAction?.chatDataAction?.createMessageAction?.message
        ?.text === "string";
  }

  return assertions;
}

function failedVariantAssertions(responses) {
  const failures = [];
  for (const response of responses) {
    if (response.response.status !== 200) {
      failures.push(`${response.variant}.http-${response.response.status}`);
    }
    for (const [name, value] of Object.entries(response.response.assertions)) {
      if (value === false) {
        failures.push(`${response.variant}.${name}`);
      }
    }
  }
  return failures;
}

async function postVariant(config, variant, fetchImpl) {
  const payload = variantPayload(config.runId, variant);
  const response = await fetchImpl(config.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const json = await response.json().catch(() => ({}));

  return {
    variant,
    response: summarizeResponse(variant, response.status, json),
  };
}

async function writeEvidenceFile(config, evidence) {
  const evidencePath =
    config.evidencePath ??
    path.join(defaultEvidenceDir, `chat-card-action-webhook-smoke-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

export async function runCardActionWebhookSmoke(
  config,
  { fetchImpl = fetch, writeEvidence = true } = {},
) {
  if (config.help) {
    return { ok: true, evidence: { help: true } };
  }

  if (config.dryRun) {
    return {
      ok: true,
      evidence: {
        ok: true,
        mode: "dry-run",
        plan: buildCardActionWebhookPlan(config),
      },
    };
  }

  const startedAt = new Date().toISOString();
  const responses = [];
  for (const variant of config.variants) {
    responses.push(await postVariant(config, variant, fetchImpl));
  }

  const failures = failedVariantAssertions(responses);
  const evidence = {
    ok: failures.length === 0,
    mode: "live-direct-webhook",
    runId: config.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    webhookUrlHash: stableHash(config.webhookUrl),
    variants: config.variants,
    responses,
    failures,
    privacy: {
      rawPayloadsSaved: false,
      rawFormValuesSaved: false,
      rawActionStateSaved: false,
      rawWebhookUrlSaved: false,
      rawAccessTokensSaved: false,
      chatMessagesSent: false,
      directMessagesSent: false,
    },
  };

  if (writeEvidence) {
    evidence.evidencePath = await writeEvidenceFile(config, evidence);
  }

  if (failures.length > 0) {
    const error = new Error(
      `Card action webhook smoke assertions failed: ${failures.join(", ")}`,
    );
    error.evidence = evidence;
    throw error;
  }

  return { ok: true, evidence };
}

function usage() {
  return `${[
    "Usage: RUN_LIVE_CHAT_CARD_ACTION_WEBHOOK_SMOKE=1 pnpm live:chat-card-action-webhook-smoke",
    "",
    "Posts synthetic add-on card action envelopes directly to the Cloud Run webhook.",
    "No Chat messages are sent and no users are contacted.",
    "",
    "Options:",
    "  --dry-run              Show planned direct webhook calls.",
    "  --webhook-url <url>    Cloud Run /api/chat/events URL or /api base URL.",
    "  --variant <name>       Variant to run; repeatable. Default: all variants.",
    "                         mark_received, stateful_mark_received, open_dialog, card_navigation_next, card_navigation_update, submit_dialog, feedback_helpful, feedback_not_helpful, unknown_action, cancel_dialog.",
    "  --evidence <path>      Evidence JSON output path.",
    "  --run-id <id>          Stable run id for evidence.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = loadCardActionWebhookSmokeConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runCardActionWebhookSmoke(config);
    console.log(JSON.stringify(result.evidence, null, 2));
  } catch (error) {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
      process.stdout.write(usage());
      return;
    }
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: {
            name: error.name ?? "Error",
            message: error.message ?? String(error),
          },
          evidence: error.evidence ?? null,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
