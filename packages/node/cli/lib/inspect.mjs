import {
  buildConversationContext,
  normalizeEvent,
  projectModelContext,
  resolveReplyTarget,
} from "../../dist/index.js";

import {
  CliUsageError,
  asRecord,
  asString,
  assertOnlyOptions,
  normalizedFormat,
  parseCommandArgs,
  readJsonFile,
  safeEvent,
  writeJson,
} from "./common.mjs";

const EVENT_SOURCES = new Set([
  "chat_http",
  "workspace_events",
  "pubsub",
  "fixture",
]);

function rawMessageFor(payload) {
  const direct = asRecord(payload)?.message;
  if (direct) {
    return direct;
  }

  const data = asRecord(asRecord(payload)?.data);
  const dataMessage = asRecord(data?.message);
  if (dataMessage) {
    return dataMessage;
  }

  return null;
}

function inspectContext(payload, event) {
  const rawMessage = rawMessageFor(payload);
  const space = asString(asRecord(event.space)?.name);
  if (!rawMessage || !space) {
    return { conversationContext: null, modelContext: null };
  }

  const thread = asString(asRecord(event.thread)?.name);
  const conversationContext = buildConversationContext(
    {
      space,
      ...(thread ? { thread } : {}),
      limit: 1,
      order: "asc",
      maxQuoteDepth: 2,
    },
    [{ messages: [rawMessage] }],
  );
  return {
    conversationContext,
    modelContext: projectModelContext(conversationContext),
  };
}

function safeReplyTarget(event) {
  try {
    return resolveReplyTarget({ event });
  } catch {
    return null;
  }
}

function renderSummary(result) {
  const event = result.event;
  const actor = asRecord(event.actor);
  const message = asRecord(event.message);
  const reply = asRecord(result.replyTarget);
  const model = asRecord(result.modelContext);
  const fragments = Array.isArray(model?.fragments) ? model.fragments.length : 0;
  return [
    `Event: ${event.kind} (${event.source})`,
    `Actor: ${actor?.displayName ?? actor?.resourceName ?? actor?.name ?? event.actorState?.status ?? "unknown"}`,
    `Space: ${event.space?.name ?? "none"}`,
    `Thread: ${event.thread?.name ?? "none"}`,
    `Message: ${message?.ref?.name ?? "none"}`,
    `Reply target: ${reply ? `${reply.route} via ${reply.reason}` : "not applicable"}`,
    `Model context: ${fragments} fragment(s)`,
  ].join("\n");
}

export async function runInspectCommand(args, context) {
  const { options, positionals } = parseCommandArgs(args, {
    booleanFlags: ["include-raw", "help"],
  });
  assertOnlyOptions(options, ["input", "source", "format", "include-raw", "help"]);

  if (options.help) {
    context.stdout.write(
      [
        "Usage: googlechatai inspect <event.json> [--source fixture] [--format summary|json]",
        "",
        "Normalizes an event and reports identity state, reply routing, canonical",
        "conversation context, and the model-safe projection. Raw payloads are",
        "omitted unless --include-raw is supplied.",
      ].join("\n") + "\n",
    );
    return { exitCode: 0, result: null };
  }

  const inputPath = options.input ?? positionals[0];
  if (!inputPath || positionals.length > 1) {
    throw new CliUsageError("inspect requires exactly one event JSON file.");
  }
  const source = options.source ?? "fixture";
  if (!EVENT_SOURCES.has(source)) {
    throw new CliUsageError(
      "--source must be chat_http, workspace_events, pubsub, or fixture.",
    );
  }
  const format = normalizedFormat(options.format);
  const { filePath, value } = await readJsonFile(inputPath, context.cwd, "event");
  const normalized = normalizeEvent(value, { source });
  const projected = inspectContext(value, normalized);
  const result = {
    kind: "googlechatai.inspect_result",
    input: filePath,
    event: safeEvent(normalized, { includeRaw: options["include-raw"] === true }),
    replyTarget: safeReplyTarget(normalized),
    ...projected,
  };

  if (format === "json") {
    writeJson(context.stdout, result);
  } else {
    context.stdout.write(`${renderSummary(result)}\n`);
  }
  return { exitCode: 0, result };
}
