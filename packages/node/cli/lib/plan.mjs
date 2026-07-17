import {
  normalizeEvent,
  planChatPermission,
  planDeleteAppMessage,
  planEditMessage,
  planReplyInThread,
  planReplyToEvent,
  planReplaceCards,
  planSearchMessages,
  planSendToSpace,
  planSendToUser,
  planStartThread,
  planStreamMessage,
} from "../../dist/index.js";

import {
  CliUsageError,
  asRecord,
  assertOnlyOptions,
  normalizedFormat,
  parseCommandArgs,
  readJsonFile,
  writeJson,
} from "./common.mjs";

const PLANNERS = new Map([
  ["send-to-space", planSendToSpace],
  ["send-to-user", planSendToUser],
  ["reply-in-thread", planReplyInThread],
  ["reply-to-event", planReplyToEvent],
  ["start-thread", planStartThread],
  ["edit-message", planEditMessage],
  ["delete-message", planDeleteAppMessage],
  ["stream-message", planStreamMessage],
  ["search-messages", planSearchMessages],
  ["replace-cards", planReplaceCards],
]);

function renderSummary(result) {
  const requests = Array.isArray(result.requests) ? result.requests : [];
  const scopes = Array.isArray(result.capability?.requiredScopes)
    ? result.capability.requiredScopes
    : [];
  const lines = [
    `Plan: ${result.operation ?? result.intent ?? "permission"}`,
    `Principal: ${result.capability?.authMode ?? result.principal ?? "unspecified"}`,
    `Scopes: ${scopes.length > 0 ? scopes.join(", ") : "none reported"}`,
    `Live allowed: ${result.safety?.liveAllowed === true ? "yes" : "no"}`,
  ];
  for (const request of requests) {
    lines.push(`${request.method} ${request.path}`);
  }
  for (const warning of result.warnings ?? []) {
    lines.push(`Warning: ${warning}`);
  }
  return lines.join("\n");
}

export async function runPlanCommand(args, context) {
  const { options, positionals } = parseCommandArgs(args, {
    booleanFlags: ["help"],
  });
  assertOnlyOptions(options, [
    "input",
    "event",
    "text",
    "source",
    "principal",
    "format",
    "help",
  ]);

  if (options.help) {
    context.stdout.write(
      [
        "Usage: googlechatai plan <intent> --input intent.json [--format summary|json]",
        "       googlechatai plan reply-to-event --event event.json --text \"Reply\"",
        "       googlechatai plan permission <capability> [--principal app|user]",
        "",
        `Intents: ${[...PLANNERS.keys()].join(", ")}`,
        "Every result is a dry-run plan; this command never executes a write.",
      ].join("\n") + "\n",
    );
    return { exitCode: 0, result: null };
  }

  const intent = positionals[0];
  if (!intent) {
    throw new CliUsageError("plan requires an intent.");
  }
  const format = normalizedFormat(options.format, "json");
  let result;

  if (intent === "permission") {
    const capability = positionals[1];
    if (!capability || positionals.length > 2) {
      throw new CliUsageError("plan permission requires exactly one capability name.");
    }
    result = planChatPermission(capability, {
      ...(options.principal ? { principal: options.principal } : {}),
    });
  } else {
    if (positionals.length > 1) {
      throw new CliUsageError("plan accepts one intent; put planner fields in --input.");
    }
    const planner = PLANNERS.get(intent);
    if (!planner) {
      throw new CliUsageError(`Unknown plan intent: ${intent}`);
    }

    let input;
    if (intent === "reply-to-event" && options.event) {
      if (!options.text) {
        throw new CliUsageError("--text is required with --event.");
      }
      const eventFile = await readJsonFile(options.event, context.cwd, "event");
      input = {
        event: normalizeEvent(eventFile.value, {
          source: options.source ?? "fixture",
        }),
        text: options.text,
      };
    } else {
      const inputFile = await readJsonFile(options.input, context.cwd, "plan input");
      input = asRecord(inputFile.value);
      if (!input) {
        throw new CliUsageError("Plan input must be a JSON object.");
      }
    }
    result = planner(input);
  }

  if (format === "json") {
    writeJson(context.stdout, result);
  } else {
    context.stdout.write(`${renderSummary(result)}\n`);
  }
  return { exitCode: 0, result };
}
