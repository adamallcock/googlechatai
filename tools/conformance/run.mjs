import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const casesDir = path.join(root, "conformance/cases");
const nodeSdk = await import(pathToFileURL(path.join(root, "packages/node/dist/index.js")).href);
const maxTraversalDepth = 80;
const maxTraversalNodes = 20_000;

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function selectPath(value, pathExpression) {
  if (!pathExpression) {
    return value;
  }

  return pathExpression.split(".").reduce((current, key) => current?.[key], value);
}

function loadInputSpec(inputSpec) {
  if (inputSpec?.fixture) {
    return selectPath(readJson(inputSpec.fixture), inputSpec.path);
  }

  return inputSpec;
}

const schemaCache = new Map();

function readSchema(schemaFile) {
  if (!schemaCache.has(schemaFile)) {
    schemaCache.set(schemaFile, readJson(`spec/${schemaFile}`));
  }

  return schemaCache.get(schemaFile);
}

function loadCases() {
  return fs
    .readdirSync(casesDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => readJson(path.join("conformance/cases", name)));
}

function caseKind(conformanceCase) {
  if (conformanceCase.id.startsWith("events.")) {
    return "events";
  }

  if (conformanceCase.id.startsWith("actions.")) {
    return "actions";
  }

  if (conformanceCase.id.startsWith("agentInterop.")) {
    return "agentInterop";
  }

  if (conformanceCase.id.startsWith("messages.")) {
    return "messages";
  }

  if (conformanceCase.id.startsWith("context.")) {
    return "context";
  }

  if (conformanceCase.id.startsWith("reactions.")) {
    return "reactions";
  }

  if (conformanceCase.id.startsWith("capabilities.")) {
    return "capabilities";
  }

  if (conformanceCase.id.startsWith("cards.")) {
    return "cards";
  }

  if (conformanceCase.id.startsWith("attachments.")) {
    return "attachments";
  }

  if (conformanceCase.id.startsWith("chatLinks.")) {
    return "chatLinks";
  }

  if (conformanceCase.id.startsWith("ingestion.")) {
    return "ingestion";
  }

  if (conformanceCase.id.startsWith("pins.")) {
    return "pins";
  }

  if (conformanceCase.id.startsWith("verify.")) {
    return "verify";
  }

  if (conformanceCase.id.startsWith("execute.")) {
    return "execute";
  }

  if (conformanceCase.id.startsWith("stream.")) {
    return "stream";
  }

  throw new Error(`Unsupported conformance case id: ${conformanceCase.id}`);
}

function isMessageParseCase(conformanceCase) {
  return caseKind(conformanceCase) === "messages" && typeof conformanceCase.input?.fixture === "string";
}

function nodeMessageOperationResult(conformanceCase) {
  const input = conformanceCase.input;

  switch (conformanceCase.operation) {
    case "messages.sendToSpace":
      return nodeSdk.planSendToSpace(input);
    case "messages.sendToUser":
      return nodeSdk.planSendToUser(input);
    case "messages.findOrSetupDm":
      return nodeSdk.planFindOrSetupDm(input);
    case "messages.replyInThread":
      return nodeSdk.planReplyInThread(input);
    case "messages.replyToEvent":
      return nodeSdk.planReplyToEvent(input);
    case "messages.startThread":
      return nodeSdk.planStartThread(input);
    case "messages.edit":
      return nodeSdk.planEditMessage(input);
    case "messages.deleteAppMessage":
      return nodeSdk.planDeleteAppMessage(input);
    case "messages.stream":
      return nodeSdk.planStreamMessage(input);
    case "messages.async.plan":
      return nodeSdk.planAsyncResponse(input);
    case "messages.placeholder.create":
      return nodeSdk.planPlaceholderResponse(input);
    case "messages.placeholder.complete":
      return nodeSdk.planCompletePlaceholderResponse(input);
    case "messages.placeholder.bufferedComplete":
      return nodeSdk.planBufferedPlaceholderCompletion(input);
    case "messages.search":
      return nodeSdk.planSearchMessages(input);
    case "messages.replaceCards":
      return nodeSdk.planReplaceCards(input);
    case "threads.readContext": {
      const responses = conformanceCase.apiResponses.map((item) => readJson(item.fixture));
      return {
        plan: nodeSdk.planReadThreadContext(input),
        context: nodeSdk.buildConversationContext(input, responses),
      };
    }
    case "threads.readSpaceContext": {
      const responses = conformanceCase.apiResponses.map((item) => readJson(item.fixture));
      return {
        plan: nodeSdk.planReadSpaceContext(input),
        context: nodeSdk.buildConversationContext(input, responses),
      };
    }
    default:
      throw new Error(`Unsupported message operation: ${conformanceCase.operation}`);
  }
}

function nodeReactionOperationResult(conformanceCase) {
  const input = conformanceCase.input;

  switch (conformanceCase.operation) {
    case "reactions.add":
      return nodeSdk.planAddReaction(input);
    case "reactions.delete":
      return nodeSdk.planDeleteReaction(input);
    case "reactions.feedback":
      return nodeSdk.planFeedbackReaction(input);
    case "reactions.list":
      return nodeSdk.planListReactions(input);
    default:
      throw new Error(`Unsupported reaction operation: ${conformanceCase.operation}`);
  }
}

function nodeCapabilityOperationResult(conformanceCase) {
  const input = conformanceCase.input;

  switch (conformanceCase.operation) {
    case "capabilities.explainChatCapability":
      return nodeSdk.explainChatCapability(input.intent, input.options);
    case "capabilities.planChatPermission":
      return nodeSdk.planChatPermission(input.intent, input.options);
    case "capabilities.explainGoogleChatError":
      return nodeSdk.explainGoogleChatError(input.error, input.context);
    default:
      throw new Error(`Unsupported capability operation: ${conformanceCase.operation}`);
  }
}

function nodeCardOperationResult(conformanceCase) {
  const input = loadInputSpec(conformanceCase.input);

  switch (conformanceCase.operation) {
    case "cards.buildCardMessage":
      return nodeSdk.buildCardMessage(input);
    case "cards.buildApprovalCard":
      return nodeSdk.buildApprovalCard(input);
    case "cards.buildProgressCard":
      return nodeSdk.buildProgressCard(input);
    case "cards.buildErrorCard":
      return nodeSdk.buildErrorCard(input);
    case "cards.buildDialog":
      return nodeSdk.buildDialog(input);
    case "cards.buildActionResponses":
      return {
        updateCardResponse: nodeSdk.buildUpdateCardResponse(input.updateMessage),
        createTextMessageResponse: nodeSdk.buildCreateMessageResponse("Created from a card action."),
        createMessageResponse: nodeSdk.buildCreateMessageResponse({
          text: "Created from a message object.",
          thread: { name: "spaces/AAA/threads/BBB" },
        }),
        openDialogResponse: nodeSdk.buildOpenDialogResponse(input.dialog),
        openRawDialogResponse: nodeSdk.buildOpenDialogResponse(input.rawDialogCard),
      };
    case "cards.buildNavigationResponse": {
      const pushStep = nodeSdk.pushCard(input.push);
      const updateStep = nodeSdk.updateCard(input.update);
      return {
        pushStep,
        updateStep,
        navigationResponse: nodeSdk.buildCardNavigationResponse([pushStep, updateStep]),
      };
    }
    case "cards.actionState": {
      const encodedState = nodeSdk.encodeCardActionState(input.state);
      const actionWithState = nodeSdk.withCardActionState(input.action, input.state);
      const event = structuredClone(input.event);
      const fallbackEvent = structuredClone(input.event);
      delete fallbackEvent.common?.invokedFunction;
      delete fallbackEvent.common?.triggeredFunction;
      delete fallbackEvent.action?.actionMethodName;
      const compactRoute = ({ matched, route, result }) => ({ matched, route, result });

      return {
        stateParameterName: nodeSdk.DEFAULT_CARD_ACTION_STATE_PARAMETER,
        encodedState,
        actionWithState,
        route: compactRoute(
          nodeSdk.routeCardAction(event, {
            methods: {
              approve_expense: (summary) => {
                const state = nodeSdk.readCardActionState(summary);
                return {
                  response: "approved",
                  requestId: summary.parameters.requestId,
                  cursor: state?.cursor,
                };
              },
            },
          }),
        ),
        fallbackRoute: compactRoute(
          nodeSdk.routeCardAction(fallbackEvent, {
            cardClick: () => "card-click-fallback",
          }),
        ),
        unknownRoute: compactRoute(
          nodeSdk.routeCardAction(fallbackEvent, {
            unknown: () => "unknown-action",
          }),
        ),
      };
    }
    case "cards.lintCardPayload":
      return nodeSdk.lintCardPayload(input.payload, input.options);
    case "cards.translateCardPayload":
      return nodeSdk.translateCardPayload(input.payload, input.options);
    case "cards.summarizeCards":
      return nodeSdk.summarizeCards(input);
    case "cards.summarizeCardAction": {
      const summary = nodeSdk.summarizeCardAction(input);
      return {
        summary,
        note: nodeSdk.renderCardActionNote(summary),
      };
    }
    default:
      throw new Error(`Unsupported card operation: ${conformanceCase.operation}`);
  }
}

function nodeContextOperationResult(conformanceCase) {
  const input = loadInputSpec(conformanceCase.input);

  switch (conformanceCase.operation) {
    case "context.render":
      return nodeSdk.renderAiContext(input);
    default:
      throw new Error(`Unsupported context operation: ${conformanceCase.operation}`);
  }
}

function nodeAttachmentOperationResult(conformanceCase) {
  const input = loadInputSpec(conformanceCase.input);

  switch (conformanceCase.operation) {
    case "attachments.planPipeline":
      return nodeSdk.planAttachmentPipeline(input);
    case "attachments.planDriveLinks":
      return nodeSdk.createDriveLinkRetrievalPlan(input);
    case "attachments.summarizeTranscriptionEvidence":
      return nodeSdk.summarizeTranscriptionEvidence({
        attachment: input.attachment,
        data: new TextEncoder().encode(input.dataUtf8 ?? ""),
        result: input.result,
        includeTranscriptText: input.includeTranscriptText === true,
      });
    default:
      throw new Error(`Unsupported attachment operation: ${conformanceCase.operation}`);
  }
}

function nodeChatLinkOperationResult(conformanceCase) {
  const input = conformanceCase.input.fixture
    ? readJson(conformanceCase.input.fixture)
    : conformanceCase.input;

  switch (conformanceCase.operation) {
    case "chatLinks.plan":
      return nodeSdk.createChatLinkRetrievalPlan(input);
    default:
      throw new Error(`Unsupported Chat link operation: ${conformanceCase.operation}`);
  }
}

function agentInteropInput(conformanceCase) {
  const rawInput = conformanceCase.input.fixture
    ? readJson(conformanceCase.input.fixture)
    : conformanceCase.input;
  return {
    rawInput,
    options: conformanceCase.input.options ?? {},
  };
}

function nodeAgentInteropOperationResult(conformanceCase) {
  const { rawInput, options } = agentInteropInput(conformanceCase);

  switch (conformanceCase.operation) {
    case "agentInterop.normalize":
      return nodeSdk.normalizeAgentResponse(rawInput, options);
    case "agentInterop.planMessage":
      return nodeSdk.planAgentResponseMessage(rawInput, options);
    default:
      throw new Error(`Unsupported agent interop operation: ${conformanceCase.operation}`);
  }
}

function ingestionInput(conformanceCase) {
  const input = { ...conformanceCase.input };
  if (typeof input.responseFixture === "string") {
    input.response = readJson(input.responseFixture);
    delete input.responseFixture;
  }
  return input;
}

function nodeIngestionOperationResult(conformanceCase) {
  const input = ingestionInput(conformanceCase);

  switch (conformanceCase.operation) {
    case "ingestion.plan":
      return nodeSdk.planChatIngestion(input);
    case "ingestion.processPollingPage":
      return nodeSdk.processPollingIngestionPage(input);
    default:
      throw new Error(`Unsupported ingestion operation: ${conformanceCase.operation}`);
  }
}

function nodePinOperationResult(conformanceCase) {
  const input = conformanceCase.input;

  switch (conformanceCase.operation) {
    case "pins.pin":
      return nodeSdk.planPinMessage(input);
    case "pins.unpin":
      return nodeSdk.planUnpinMessage(input);
    case "pins.list":
      return nodeSdk.planListMessagePins(input);
    case "pins.ensurePinned":
      return nodeSdk.planEnsureMessagePinned(input);
    default:
      throw new Error(`Unsupported pin operation: ${conformanceCase.operation}`);
  }
}

function nodeVerifyOperationResult(conformanceCase) {
  const input = conformanceCase.input;

  switch (conformanceCase.operation) {
    case "verify.verifyToken":
      return nodeSdk.verifyGoogleChatToken(input.token ?? null, input.options);
    default:
      throw new Error(`Unsupported verify operation: ${conformanceCase.operation}`);
  }
}

function nodeExecuteOperationResult(conformanceCase) {
  const input = conformanceCase.input;

  switch (conformanceCase.operation) {
    case "execute.dryRun":
      return nodeSdk.executeChatPlan(input.plan, {
        mode: "dryRun",
        ...(input.options?.placeholderValues
          ? { placeholderValues: input.options.placeholderValues }
          : {}),
      });
    default:
      throw new Error(`Unsupported execute operation: ${conformanceCase.operation}`);
  }
}

function nodeStreamOperationResult(conformanceCase) {
  switch (conformanceCase.operation) {
    case "stream.schedulerReplay":
      return nodeSdk.replayStreamScheduler(conformanceCase.input);
    default:
      throw new Error(`Unsupported stream operation: ${conformanceCase.operation}`);
  }
}

function runPythonOperation(code, conformanceCase, payload) {
  const output = execFileSync("python3", ["-c", code, conformanceCase.operation], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      PYTHONPATH: path.join(root, "packages/python/src"),
    },
  });

  return JSON.parse(output);
}

function pythonPinOperationResult(conformanceCase) {
  const code = `
import json
import sys
from googlechatai import (
    plan_ensure_message_pinned,
    plan_list_message_pins,
    plan_pin_message,
    plan_unpin_message,
)

operation = sys.argv[1]
input_data = json.load(sys.stdin)["input"]

if operation == "pins.pin":
    result = plan_pin_message(input_data)
elif operation == "pins.unpin":
    result = plan_unpin_message(input_data)
elif operation == "pins.list":
    result = plan_list_message_pins(input_data)
elif operation == "pins.ensurePinned":
    result = plan_ensure_message_pinned(input_data)
else:
    raise ValueError(f"Unsupported pin operation: {operation}")

print(json.dumps(result, sort_keys=True, separators=(",", ":")))
`;

  return runPythonOperation(code, conformanceCase, { input: conformanceCase.input });
}

function pythonVerifyOperationResult(conformanceCase) {
  const code = `
import json
import sys
from googlechatai import verify_google_chat_token

operation = sys.argv[1]
payload = json.load(sys.stdin)["input"]

if operation == "verify.verifyToken":
    result = verify_google_chat_token(payload.get("token"), payload["options"])
else:
    raise ValueError(f"Unsupported verify operation: {operation}")

print(json.dumps(result, sort_keys=True, separators=(",", ":")))
`;

  return runPythonOperation(code, conformanceCase, { input: conformanceCase.input });
}

function pythonExecuteOperationResult(conformanceCase) {
  const code = `
import json
import sys
from googlechatai import execute_chat_plan

operation = sys.argv[1]
payload = json.load(sys.stdin)["input"]

if operation == "execute.dryRun":
    options = payload.get("options") or {}
    kwargs = {}
    if options.get("placeholderValues"):
        kwargs["placeholder_values"] = options["placeholderValues"]
    result = execute_chat_plan(payload["plan"], mode="dryRun", **kwargs)
else:
    raise ValueError(f"Unsupported execute operation: {operation}")

print(json.dumps(result, sort_keys=True, separators=(",", ":")))
`;

  return runPythonOperation(code, conformanceCase, { input: conformanceCase.input });
}

function pythonStreamOperationResult(conformanceCase) {
  const code = `
import json
import sys
from googlechatai import replay_stream_scheduler

operation = sys.argv[1]
payload = json.load(sys.stdin)["input"]

if operation == "stream.schedulerReplay":
    result = replay_stream_scheduler(payload)
else:
    raise ValueError(f"Unsupported stream operation: {operation}")

print(json.dumps(result, sort_keys=True, separators=(",", ":")))
`;

  return runPythonOperation(code, conformanceCase, { input: conformanceCase.input });
}

function resultWithNode(conformanceCase, raw, source) {
  const kind = caseKind(conformanceCase);

  if (isMessageParseCase(conformanceCase)) {
    return nodeSdk.normalizeMessage(raw);
  }

  if (kind === "messages") {
    return nodeMessageOperationResult(conformanceCase);
  }

  if (kind === "reactions") {
    return nodeReactionOperationResult(conformanceCase);
  }

  if (kind === "capabilities") {
    return nodeCapabilityOperationResult(conformanceCase);
  }

  if (kind === "cards") {
    return nodeCardOperationResult(conformanceCase);
  }

  if (kind === "context") {
    return nodeContextOperationResult(conformanceCase);
  }

  if (kind === "attachments") {
    return nodeAttachmentOperationResult(conformanceCase);
  }

  if (kind === "chatLinks") {
    return nodeChatLinkOperationResult(conformanceCase);
  }

  if (kind === "agentInterop") {
    return nodeAgentInteropOperationResult(conformanceCase);
  }

  if (kind === "ingestion") {
    return nodeIngestionOperationResult(conformanceCase);
  }

  if (kind === "pins") {
    return nodePinOperationResult(conformanceCase);
  }

  if (kind === "verify") {
    return nodeVerifyOperationResult(conformanceCase);
  }

  if (kind === "execute") {
    return nodeExecuteOperationResult(conformanceCase);
  }

  if (kind === "stream") {
    return nodeStreamOperationResult(conformanceCase);
  }

  if (kind === "events") {
    const options = {};
    if (source !== undefined) {
      options.source = source;
    }
    if (conformanceCase.input?.receivedAt !== undefined) {
      options.receivedAt = conformanceCase.input.receivedAt;
    }
    return Object.keys(options).length === 0
      ? nodeSdk.normalizeEvent(raw)
      : nodeSdk.normalizeEvent(raw, options);
  }

  return nodeSdk.normalizeAction(raw, { source: source ?? "fixture" });
}

function pythonMessageOperationResult(conformanceCase) {
  const code = `
import json
import sys
from googlechatai import (
    build_conversation_context,
    plan_delete_app_message,
    plan_edit_message,
    plan_find_or_setup_dm,
    plan_async_response,
    plan_buffered_placeholder_completion,
    plan_complete_placeholder_response,
    plan_placeholder_response,
    plan_read_space_context,
    plan_read_thread_context,
    plan_reply_in_thread,
    plan_reply_to_event,
    plan_replace_cards,
    plan_search_messages,
    plan_send_to_space,
    plan_send_to_user,
    plan_start_thread,
    plan_stream_message,
)

operation = sys.argv[1]
payload = json.load(sys.stdin)
input_data = payload["input"]
responses = payload.get("responses", [])

if operation == "messages.sendToSpace":
    result = plan_send_to_space(input_data)
elif operation == "messages.sendToUser":
    result = plan_send_to_user(input_data)
elif operation == "messages.findOrSetupDm":
    result = plan_find_or_setup_dm(input_data)
elif operation == "messages.replyInThread":
    result = plan_reply_in_thread(input_data)
elif operation == "messages.replyToEvent":
    result = plan_reply_to_event(input_data)
elif operation == "messages.startThread":
    result = plan_start_thread(input_data)
elif operation == "messages.edit":
    result = plan_edit_message(input_data)
elif operation == "messages.deleteAppMessage":
    result = plan_delete_app_message(input_data)
elif operation == "messages.stream":
    result = plan_stream_message(input_data)
elif operation == "messages.async.plan":
    result = plan_async_response(input_data)
elif operation == "messages.placeholder.create":
    result = plan_placeholder_response(input_data)
elif operation == "messages.placeholder.complete":
    result = plan_complete_placeholder_response(input_data)
elif operation == "messages.placeholder.bufferedComplete":
    result = plan_buffered_placeholder_completion(input_data)
elif operation == "messages.search":
    result = plan_search_messages(input_data)
elif operation == "messages.replaceCards":
    result = plan_replace_cards(input_data)
elif operation == "threads.readContext":
    result = {
        "plan": plan_read_thread_context(input_data),
        "context": build_conversation_context(input_data, responses),
    }
elif operation == "threads.readSpaceContext":
    result = {
        "plan": plan_read_space_context(input_data),
        "context": build_conversation_context(input_data, responses),
    }
else:
    raise ValueError(f"Unsupported message operation: {operation}")

print(json.dumps(result, sort_keys=True, separators=(",", ":")))
`;

  const payload = {
    input: conformanceCase.input,
    responses: (conformanceCase.apiResponses ?? []).map((item) => readJson(item.fixture)),
  };
  const output = execFileSync("python3", ["-c", code, conformanceCase.operation], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      PYTHONPATH: path.join(root, "packages/python/src"),
    },
  });

  return JSON.parse(output);
}

function pythonReactionOperationResult(conformanceCase) {
  const code = `
import json
import sys
from googlechatai import (
    plan_add_reaction,
    plan_delete_reaction,
    plan_feedback_reaction,
    plan_list_reactions,
)

operation = sys.argv[1]
input_data = json.load(sys.stdin)["input"]

if operation == "reactions.add":
    result = plan_add_reaction(input_data)
elif operation == "reactions.delete":
    result = plan_delete_reaction(input_data)
elif operation == "reactions.feedback":
    result = plan_feedback_reaction(input_data)
elif operation == "reactions.list":
    result = plan_list_reactions(input_data)
else:
    raise ValueError(f"Unsupported reaction operation: {operation}")

print(json.dumps(result, sort_keys=True, separators=(",", ":")))
`;

  const output = execFileSync("python3", ["-c", code, conformanceCase.operation], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify({ input: conformanceCase.input }),
    env: {
      ...process.env,
      PYTHONPATH: path.join(root, "packages/python/src"),
    },
  });

  return JSON.parse(output);
}

function pythonCapabilityOperationResult(conformanceCase) {
  const code = `
import json
import sys
from googlechatai import (
    explain_chat_capability,
    explain_google_chat_error,
    plan_chat_permission,
)

operation = sys.argv[1]
input_data = json.load(sys.stdin)["input"]

if operation == "capabilities.explainChatCapability":
    result = explain_chat_capability(input_data["intent"], input_data.get("options"))
elif operation == "capabilities.planChatPermission":
    result = plan_chat_permission(input_data["intent"], input_data.get("options"))
elif operation == "capabilities.explainGoogleChatError":
    result = explain_google_chat_error(input_data["error"], input_data.get("context"))
else:
    raise ValueError(f"Unsupported capability operation: {operation}")

print(json.dumps(result, sort_keys=True, separators=(",", ":")))
`;

  const output = execFileSync("python3", ["-c", code, conformanceCase.operation], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify({ input: conformanceCase.input }),
    env: {
      ...process.env,
      PYTHONPATH: path.join(root, "packages/python/src"),
    },
  });

  return JSON.parse(output);
}

function pythonCardOperationResult(conformanceCase) {
  const code = `
import json
import sys
from googlechatai import (
    DEFAULT_CARD_ACTION_STATE_PARAMETER,
    build_approval_card,
    build_card_message,
    build_card_navigation_response,
    build_create_message_response,
    build_dialog,
    build_error_card,
    build_open_dialog_response,
    build_progress_card,
    build_update_card_response,
    encode_card_action_state,
    lint_card_payload,
    push_card,
    read_card_action_state,
    render_card_action_note,
    route_card_action,
    summarize_card_action,
    summarize_cards,
    translate_card_payload,
    update_card,
    with_card_action_state,
)

operation = sys.argv[1]
input_data = json.load(sys.stdin)["input"]

def compact_route(route):
    return {
        "matched": route["matched"],
        "route": route["route"],
        "result": route["result"],
    }

if operation == "cards.buildCardMessage":
    result = build_card_message(input_data)
elif operation == "cards.buildApprovalCard":
    result = build_approval_card(input_data)
elif operation == "cards.buildProgressCard":
    result = build_progress_card(input_data)
elif operation == "cards.buildErrorCard":
    result = build_error_card(input_data)
elif operation == "cards.buildDialog":
    result = build_dialog(input_data)
elif operation == "cards.buildActionResponses":
    result = {
        "updateCardResponse": build_update_card_response(input_data["updateMessage"]),
        "createTextMessageResponse": build_create_message_response("Created from a card action."),
        "createMessageResponse": build_create_message_response({
            "text": "Created from a message object.",
            "thread": {"name": "spaces/AAA/threads/BBB"},
        }),
        "openDialogResponse": build_open_dialog_response(input_data["dialog"]),
        "openRawDialogResponse": build_open_dialog_response(input_data["rawDialogCard"]),
    }
elif operation == "cards.buildNavigationResponse":
    push_step = push_card(input_data["push"])
    update_step = update_card(input_data["update"])
    result = {
        "pushStep": push_step,
        "updateStep": update_step,
        "navigationResponse": build_card_navigation_response([push_step, update_step]),
    }
elif operation == "cards.actionState":
    event = json.loads(json.dumps(input_data["event"]))
    fallback_event = json.loads(json.dumps(input_data["event"]))
    fallback_event.get("common", {}).pop("invokedFunction", None)
    fallback_event.get("common", {}).pop("triggeredFunction", None)
    fallback_event.get("action", {}).pop("actionMethodName", None)

    def approve(summary):
        state = read_card_action_state(summary)
        return {
            "response": "approved",
            "requestId": summary["parameters"].get("requestId"),
            "cursor": state.get("cursor") if isinstance(state, dict) else None,
        }

    result = {
        "stateParameterName": DEFAULT_CARD_ACTION_STATE_PARAMETER,
        "encodedState": encode_card_action_state(input_data["state"]),
        "actionWithState": with_card_action_state(input_data["action"], input_data["state"]),
        "route": compact_route(route_card_action(event, {"methods": {"approve_expense": approve}})),
        "fallbackRoute": compact_route(route_card_action(fallback_event, {"cardClick": lambda summary: "card-click-fallback"})),
        "unknownRoute": compact_route(route_card_action(fallback_event, {"unknown": lambda summary: "unknown-action"})),
    }
elif operation == "cards.lintCardPayload":
    result = lint_card_payload(input_data["payload"], input_data.get("options"))
elif operation == "cards.translateCardPayload":
    result = translate_card_payload(input_data["payload"], input_data.get("options"))
elif operation == "cards.summarizeCards":
    result = summarize_cards(input_data)
elif operation == "cards.summarizeCardAction":
    summary = summarize_card_action(input_data)
    result = {
        "summary": summary,
        "note": render_card_action_note(summary),
    }
else:
    raise ValueError(f"Unsupported card operation: {operation}")

print(json.dumps(result, sort_keys=True, separators=(",", ":")))
`;

  const output = execFileSync("python3", ["-c", code, conformanceCase.operation], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify({ input: loadInputSpec(conformanceCase.input) }),
    env: {
      ...process.env,
      PYTHONPATH: path.join(root, "packages/python/src"),
    },
  });

  return JSON.parse(output);
}

function pythonContextOperationResult(conformanceCase) {
  const code = `
import json
import sys
from googlechatai import render_ai_context

operation = sys.argv[1]
input_data = json.load(sys.stdin)["input"]

if operation == "context.render":
    result = render_ai_context(input_data)
else:
    raise ValueError(f"Unsupported context operation: {operation}")

print(json.dumps(result, sort_keys=True, separators=(",", ":")))
`;
  const output = execFileSync("python3", ["-c", code, conformanceCase.operation], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify({ input: loadInputSpec(conformanceCase.input) }),
    env: {
      ...process.env,
      PYTHONPATH: path.join(root, "packages/python/src"),
    },
  });

  return JSON.parse(output);
}

function pythonAttachmentOperationResult(conformanceCase) {
  const code = `
import json
import sys
from googlechatai import (
    create_drive_link_retrieval_plan,
    plan_attachment_pipeline,
    summarize_transcription_evidence,
)

operation = sys.argv[1]
input_data = json.load(sys.stdin)["input"]

if operation == "attachments.planPipeline":
    result = plan_attachment_pipeline(input_data)
elif operation == "attachments.planDriveLinks":
    result = create_drive_link_retrieval_plan(input_data)
elif operation == "attachments.summarizeTranscriptionEvidence":
    result = summarize_transcription_evidence(
        attachment=input_data["attachment"],
        data=(input_data.get("dataUtf8") or "").encode("utf-8"),
        result=input_data["result"],
        include_transcript_text=input_data.get("includeTranscriptText") is True,
    )
else:
    raise ValueError(f"Unsupported attachment operation: {operation}")

print(json.dumps(result, sort_keys=True, separators=(",", ":")))
`;
  const input = loadInputSpec(conformanceCase.input);
  const output = execFileSync("python3", ["-c", code, conformanceCase.operation], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify({ input }),
    env: {
      ...process.env,
      PYTHONPATH: path.join(root, "packages/python/src"),
    },
  });

  return JSON.parse(output);
}

function pythonChatLinkOperationResult(conformanceCase) {
  const code = `
import json
import sys
from googlechatai import create_chat_link_retrieval_plan

operation = sys.argv[1]
input_data = json.load(sys.stdin)["input"]

if operation == "chatLinks.plan":
    result = create_chat_link_retrieval_plan(input_data)
else:
    raise ValueError(f"Unsupported Chat link operation: {operation}")

print(json.dumps(result, sort_keys=True, separators=(",", ":")))
`;
  const input = conformanceCase.input.fixture
    ? readJson(conformanceCase.input.fixture)
    : conformanceCase.input;
  const output = execFileSync("python3", ["-c", code, conformanceCase.operation], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify({ input }),
    env: {
      ...process.env,
      PYTHONPATH: path.join(root, "packages/python/src"),
    },
  });

  return JSON.parse(output);
}

function pythonAgentInteropOperationResult(conformanceCase) {
  const code = `
import json
import sys
from googlechatai import normalize_agent_response, plan_agent_response_message

operation = sys.argv[1]
payload = json.load(sys.stdin)
input_data = payload["input"]
options = payload.get("options") or {}

if operation == "agentInterop.normalize":
    result = normalize_agent_response(input_data, options)
elif operation == "agentInterop.planMessage":
    result = plan_agent_response_message(input_data, options)
else:
    raise ValueError(f"Unsupported agent interop operation: {operation}")

print(json.dumps(result, sort_keys=True, separators=(",", ":")))
`;
  const { rawInput, options } = agentInteropInput(conformanceCase);
  const output = execFileSync("python3", ["-c", code, conformanceCase.operation], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify({ input: rawInput, options }),
    env: {
      ...process.env,
      PYTHONPATH: path.join(root, "packages/python/src"),
    },
  });

  return JSON.parse(output);
}

function pythonIngestionOperationResult(conformanceCase) {
  const code = `
import json
import sys
from googlechatai import plan_chat_ingestion, process_polling_ingestion_page

operation = sys.argv[1]
input_data = json.load(sys.stdin)["input"]

if operation == "ingestion.plan":
    result = plan_chat_ingestion(input_data)
elif operation == "ingestion.processPollingPage":
    result = process_polling_ingestion_page(input_data)
else:
    raise ValueError(f"Unsupported ingestion operation: {operation}")

print(json.dumps(result, sort_keys=True, separators=(",", ":")))
`;
  const output = execFileSync("python3", ["-c", code, conformanceCase.operation], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify({ input: ingestionInput(conformanceCase) }),
    env: {
      ...process.env,
      PYTHONPATH: path.join(root, "packages/python/src"),
    },
  });

  return JSON.parse(output);
}

function resultWithPython(conformanceCase, raw, source) {
  if (isMessageParseCase(conformanceCase)) {
    const code = `
import json
import sys
from googlechatai import normalize_message

raw = json.load(sys.stdin)
print(json.dumps(normalize_message(raw), sort_keys=True, separators=(",", ":")))
`;
    const output = execFileSync("python3", ["-c", code], {
      cwd: root,
      encoding: "utf8",
      input: JSON.stringify(raw),
      env: {
        ...process.env,
        PYTHONPATH: path.join(root, "packages/python/src"),
      },
    });

    return JSON.parse(output);
  }

  if (caseKind(conformanceCase) === "messages") {
    return pythonMessageOperationResult(conformanceCase);
  }

  if (caseKind(conformanceCase) === "reactions") {
    return pythonReactionOperationResult(conformanceCase);
  }

  if (caseKind(conformanceCase) === "capabilities") {
    return pythonCapabilityOperationResult(conformanceCase);
  }

  if (caseKind(conformanceCase) === "cards") {
    return pythonCardOperationResult(conformanceCase);
  }

  if (caseKind(conformanceCase) === "context") {
    return pythonContextOperationResult(conformanceCase);
  }

  if (caseKind(conformanceCase) === "attachments") {
    return pythonAttachmentOperationResult(conformanceCase);
  }

  if (caseKind(conformanceCase) === "chatLinks") {
    return pythonChatLinkOperationResult(conformanceCase);
  }

  if (caseKind(conformanceCase) === "agentInterop") {
    return pythonAgentInteropOperationResult(conformanceCase);
  }

  if (caseKind(conformanceCase) === "pins") {
    return pythonPinOperationResult(conformanceCase);
  }

  if (caseKind(conformanceCase) === "verify") {
    return pythonVerifyOperationResult(conformanceCase);
  }

  if (caseKind(conformanceCase) === "execute") {
    return pythonExecuteOperationResult(conformanceCase);
  }

  if (caseKind(conformanceCase) === "stream") {
    return pythonStreamOperationResult(conformanceCase);
  }

  if (caseKind(conformanceCase) === "ingestion") {
    return pythonIngestionOperationResult(conformanceCase);
  }

  const code = `
import json
import sys
from googlechatai import normalize_action, normalize_event

kind = sys.argv[1]
source = sys.argv[2] or None
received_at = sys.argv[3] or None
raw = json.load(sys.stdin)

if kind == "events":
    kwargs = {}
    if source is not None:
        kwargs["source"] = source
    if received_at is not None:
        kwargs["received_at"] = received_at
    result = normalize_event(raw, **kwargs)
else:
    result = normalize_action(raw, source=source or "fixture")
print(json.dumps(result, sort_keys=True, separators=(",", ":")))
`;

  const output = execFileSync(
    "python3",
    ["-c", code, caseKind(conformanceCase), source ?? "", conformanceCase.input?.receivedAt ?? ""],
    {
      cwd: root,
      encoding: "utf8",
      input: JSON.stringify(raw),
      env: {
        ...process.env,
        PYTHONPATH: path.join(root, "packages/python/src"),
      },
    },
  );

  return JSON.parse(output);
}

function assertEqual(label, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) {
    return;
  }

  throw new Error(
    `${label} did not match expected output.\nActual:\n${JSON.stringify(
      actual,
      null,
      2,
    )}\nExpected:\n${JSON.stringify(expected, null, 2)}`,
  );
}

function resolveSchemaRef(ref, currentSchema) {
  const [filePart, pointer = ""] = ref.split("#");
  const rootSchema = filePart ? readSchema(filePart) : currentSchema;
  let schema = rootSchema;

  if (!pointer) {
    return { schema, rootSchema };
  }

  for (const rawPart of pointer.replace(/^\//, "").split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    schema = schema?.[part];
  }

  if (!schema) {
    throw new Error(`Unable to resolve schema ref ${ref}`);
  }

  return { schema, rootSchema };
}

function typeMatches(value, type) {
  if (type === "null") {
    return value === null;
  }
  if (type === "array") {
    return Array.isArray(value);
  }
  if (type === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  if (type === "integer") {
    return Number.isInteger(value);
  }
  if (type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  return typeof value === type;
}

function validateAgainstSchema(value, schema, label, currentSchema = schema, pathLabel = "$", state = { count: 0 }) {
  if (schema === true) {
    return [];
  }
  if (schema === false) {
    return [`${label} ${pathLabel} is disallowed by schema.`];
  }
  if (!schema || typeof schema !== "object") {
    return [];
  }

  state.count += 1;
  if (state.count > maxTraversalNodes) {
    return [`${label} exceeds schema validation node limit ${maxTraversalNodes}.`];
  }

  if (schema.$ref) {
    const resolved = resolveSchemaRef(schema.$ref, currentSchema);
    return validateAgainstSchema(value, resolved.schema, label, resolved.rootSchema, pathLabel, state);
  }

  const errors = [];

  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    errors.push(`${label} ${pathLabel} must equal ${JSON.stringify(schema.const)}.`);
  }

  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${label} ${pathLabel} must be one of ${JSON.stringify(schema.enum)}.`);
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${label} ${pathLabel} must be type ${types.join("|")}.`);
      return errors;
    }
  }

  if (schema.oneOf) {
    const passCount = schema.oneOf.filter(
      (option) => validateAgainstSchema(value, option, label, currentSchema, pathLabel, { count: state.count }).length === 0,
    ).length;
    if (passCount !== 1) {
      errors.push(`${label} ${pathLabel} must match exactly one schema in oneOf; matched ${passCount}.`);
    }
  }

  if (schema.anyOf) {
    const passCount = schema.anyOf.filter(
      (option) => validateAgainstSchema(value, option, label, currentSchema, pathLabel, { count: state.count }).length === 0,
    ).length;
    if (passCount === 0) {
      errors.push(`${label} ${pathLabel} must match at least one schema in anyOf.`);
    }
  }

  if (schema.not) {
    const notErrors = validateAgainstSchema(value, schema.not, label, currentSchema, pathLabel, { count: state.count });
    if (notErrors.length === 0) {
      errors.push(`${label} ${pathLabel} matched a forbidden schema.`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${label} ${pathLabel} must be >= ${schema.minimum}.`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${label} ${pathLabel} must be <= ${schema.maximum}.`);
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        errors.push(`${label} ${pathLabel}.${key} is required.`);
      }
    }

    const properties = schema.properties ?? {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        errors.push(
          ...validateAgainstSchema(value[key], childSchema, label, currentSchema, `${pathLabel}.${key}`, state),
        );
      }
    }

    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      for (const [key, childValue] of Object.entries(value)) {
        if (!Object.hasOwn(properties, key)) {
          errors.push(
            ...validateAgainstSchema(
              childValue,
              schema.additionalProperties,
              label,
              currentSchema,
              `${pathLabel}.${key}`,
              state,
            ),
          );
        }
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      errors.push(...validateAgainstSchema(item, schema.items, label, currentSchema, `${pathLabel}[${index}]`, state));
    });
  }

  return errors;
}

function assertSchema(label, value, schemaFile) {
  const schema = readSchema(schemaFile);
  const errors = validateAgainstSchema(value, schema, label);

  if (errors.length > 0) {
    throw new Error(`${label} violates ${schemaFile}:\n${errors.slice(0, 20).join("\n")}`);
  }
}

function visitContextNodes(nodes, visitor) {
  const stack = nodes.map((node) => ({ node, depth: 1 })).reverse();
  let maxDepth = 0;
  let count = 0;

  while (stack.length > 0) {
    const { node, depth } = stack.pop();
    count += 1;

    if (count > maxTraversalNodes) {
      throw new Error(`Context fixture exceeds ${maxTraversalNodes} traversed nodes.`);
    }
    if (depth > maxTraversalDepth) {
      throw new Error(`Context fixture exceeds depth ${maxTraversalDepth}.`);
    }

    visitor(node, depth);
    const children = Array.isArray(node.children) ? node.children : [];
    maxDepth = Math.max(maxDepth, depth);

    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index], depth: depth + 1 });
    }
  }

  return maxDepth;
}

function assertNoOneOffContextKeys(value) {
  const stack = [{ value, pathLabel: "context", depth: 0 }];
  let count = 0;

  while (stack.length > 0) {
    const item = stack.pop();
    count += 1;

    if (count > maxTraversalNodes) {
      throw new Error(`Context fixture exceeds ${maxTraversalNodes} traversed nodes.`);
    }
    if (item.depth > maxTraversalDepth) {
      throw new Error(`Context fixture exceeds depth ${maxTraversalDepth}.`);
    }
    if (!item.value || typeof item.value !== "object") {
      continue;
    }

    if (Array.isArray(item.value)) {
      item.value.forEach((child, index) =>
        stack.push({ value: child, pathLabel: `${item.pathLabel}[${index}]`, depth: item.depth + 1 }),
      );
      continue;
    }

    for (const [key, child] of Object.entries(item.value)) {
      if (["quotedMessage", "quotedMessages", "quotedAttachment", "quotedAttachments"].includes(key)) {
        throw new Error(`${item.pathLabel}.${key} is a quote-specific field; use recursive context nodes.`);
      }
      stack.push({ value: child, pathLabel: `${item.pathLabel}.${key}`, depth: item.depth + 1 });
    }
  }
}

function validateContextInput(testCase, input, expected) {
  assert.equal(
    testCase.execution,
    "schema_only_until_context_builders",
    `${testCase.id} must declare schema-only context execution until builders exist.`,
  );
  assert.equal(input.kind, "context_source_fixture", `${testCase.id} input must be a context_source_fixture.`);
  assert.equal(typeof input.scenario, "string", `${testCase.id} input must name a scenario.`);
  assert.ok(input.source && typeof input.source === "object", `${testCase.id} input must include source data.`);

  if (testCase.id === "context.quoted-recursive") {
    assert.ok(Array.isArray(input.source.messages), `${testCase.id} source must include messages.`);
    assert.ok(input.source.messages.length >= 3, `${testCase.id} source must include nested quoted messages.`);
  }

  if (testCase.id === "context.thread-reader.truncated") {
    assert.ok(input.source.request, `${testCase.id} source must include the reader request.`);
    assert.ok(Array.isArray(input.source.messages), `${testCase.id} source must include page messages.`);
    assert.equal(input.source.pagination?.hasMore, true, `${testCase.id} source must show pagination.`);
  }

  if (testCase.id === "context.attachment-system-notes") {
    assert.ok(Array.isArray(input.source.message?.attachments), `${testCase.id} source must include attachments.`);
    assert.ok(input.source.message.attachments.length >= 3, `${testCase.id} source must include image/audio/document attachments.`);
  }

  assert.ok(expected.source?.fixtureId, `${testCase.id} expected output must identify fixture source.`);
}

function validateContextContract(testCase, expected) {
  assert.equal(expected.kind, "ai_context", `${testCase.id} must be an ai_context document.`);
  assert.equal(typeof expected.contextId, "string", `${testCase.id} must have a contextId.`);
  assert.ok(Array.isArray(expected.nodes), `${testCase.id} must have nodes.`);
  assertNoOneOffContextKeys(expected);

  let hasSystemNote = Array.isArray(expected.systemNotes) && expected.systemNotes.length > 0;
  let hasAttachmentNode = false;
  let hasTruncationSignal = false;
  let hasQuoteRelationship = false;

  const maxDepth = visitContextNodes(expected.nodes, (node, depth) => {
    assert.equal(typeof node.nodeId, "string", `${testCase.id} node at depth ${depth} needs nodeId.`);
    assert.equal(typeof node.nodeType, "string", `${node.nodeId} needs nodeType.`);
    assert.ok(Array.isArray(node.relationships), `${node.nodeId} needs relationships array.`);
    assert.ok(Array.isArray(node.children), `${node.nodeId} needs recursive children array.`);
    assert.ok(Array.isArray(node.systemNotes), `${node.nodeId} needs systemNotes array.`);
    assert.ok(node.availability && typeof node.availability === "object", `${node.nodeId} needs availability.`);
    assert.ok(node.truncation && typeof node.truncation === "object", `${node.nodeId} needs truncation.`);

    hasSystemNote ||= node.systemNotes.length > 0;
    hasAttachmentNode ||= node.nodeType === "attachment";
    hasTruncationSignal ||= node.availability.state === "truncated" || node.truncation.isTruncated === true;
    hasQuoteRelationship ||= node.relationships.some((relationship) => String(relationship.type).includes("quoted"));
  });

  if (testCase.id === "context.quoted-recursive") {
    assert.ok(maxDepth >= 3, `${testCase.id} must include nested recursive context depth.`);
    assert.ok(hasQuoteRelationship, `${testCase.id} must model quote relationships generically.`);
    assert.ok(hasAttachmentNode, `${testCase.id} must include nested attachment nodes.`);
  }

  if (testCase.id === "context.thread-reader.truncated") {
    assert.equal(expected.pagination?.hasMore, true, `${testCase.id} must expose pagination.`);
    assert.ok(hasTruncationSignal, `${testCase.id} must expose truncation.`);
  }

  if (testCase.id === "context.attachment-system-notes") {
    assert.ok(hasAttachmentNode, `${testCase.id} must include attachment nodes.`);
    assert.ok(hasSystemNote, `${testCase.id} must include AI-facing system notes.`);
  }
}

function runContextCase(conformanceCase) {
  const input = readJson(conformanceCase.input.fixture);
  const expected = readJson(conformanceCase.expect.fixture);

  validateContextInput(conformanceCase, input, expected);
  assertSchema(`context ${conformanceCase.id}`, expected, "context.schema.json");
  validateContextContract(conformanceCase, expected);
}

const totals = { node: 0, python: 0, contract: 0, deferred: 0 };
const cases = loadCases();

for (const conformanceCase of cases) {
  if (conformanceCase.status === "contract" && conformanceCase.operation === undefined) {
    totals.deferred += 1;
    console.log(`contract ${conformanceCase.id}`);
    continue;
  }

  const kind = caseKind(conformanceCase);

  if (kind === "context" && conformanceCase.operation === "context.contract") {
    runContextCase(conformanceCase);
    totals.contract += 1;
    console.log(`ok ${conformanceCase.id}`);
    continue;
  }

  const operationCase =
    (kind === "messages" && !isMessageParseCase(conformanceCase)) ||
    kind === "reactions" ||
    kind === "capabilities" ||
    kind === "context" ||
    kind === "cards" ||
    kind === "attachments" ||
    kind === "chatLinks" ||
    kind === "agentInterop" ||
    kind === "pins" ||
    kind === "verify" ||
    kind === "execute" ||
    kind === "stream";
  const fixture = operationCase ? null : conformanceCase.input.fixture;
  const source = operationCase ? "fixture" : conformanceCase.input.source;
  const expected = operationCase
    ? conformanceCase.expect.fixture
      ? readJson(conformanceCase.expect.fixture)
      : conformanceCase.expect
    : readJson(conformanceCase.expect.fixture);
  const raw = fixture ? readJson(fixture) : null;

  if (
    kind === "cards" &&
    !["cards.buildActionResponses", "cards.buildNavigationResponse", "cards.actionState"].includes(
      conformanceCase.operation,
    )
  ) {
    assertSchema(`cards ${conformanceCase.id}`, expected, "cards.schema.json");
  }

  if (
    kind === "attachments" &&
    ["attachments.planPipeline", "attachments.planDriveLinks"].includes(
      conformanceCase.operation,
    )
  ) {
    const schema = readSchema("attachments.schema.json");
    const schemaDefName =
      conformanceCase.operation === "attachments.planPipeline"
        ? "attachmentPipelinePlan"
        : "driveLinkRetrievalPlan";
    const schemaDef = schema.$defs[schemaDefName];
    const errors = validateAgainstSchema(
      expected,
      schemaDef,
      `attachments ${conformanceCase.id}`,
      schema,
    );
    if (errors.length > 0) {
      throw new Error(
        `attachments ${conformanceCase.id} violates attachments.schema.json#/$defs/${schemaDefName}:\n${errors.slice(0, 20).join("\n")}`,
      );
    }
  }

  if (kind === "chatLinks" && conformanceCase.operation === "chatLinks.plan") {
    const errors = validateAgainstSchema(
      expected,
      readSchema("chat-links.schema.json"),
      `chatLinks ${conformanceCase.id}`,
    );
    if (errors.length > 0) {
      throw new Error(
        `chatLinks ${conformanceCase.id} violates chat-links.schema.json:\n${errors.slice(0, 20).join("\n")}`,
      );
    }
  }

  if (kind === "ingestion") {
    assertSchema(`ingestion ${conformanceCase.id}`, expected, "ingestion.schema.json");
  }

  if (kind === "agentInterop") {
    assertSchema(`agentInterop ${conformanceCase.id}`, expected, "agent-interop.schema.json");
  }

  assertEqual(
    `${conformanceCase.id} Node`,
    await resultWithNode(conformanceCase, raw, source),
    expected,
  );
  assertEqual(
    `${conformanceCase.id} Python`,
    resultWithPython(conformanceCase, raw, source),
    expected,
  );

  totals.node += 1;
  totals.python += 1;
  console.log(`ok ${conformanceCase.id}`);
}

console.log(
  `Conformance passed: ${totals.node} Node runtime runs, ${totals.python} Python runtime runs, ${totals.contract} shared context contract cases, ${totals.deferred} deferred contract cases.`,
);
