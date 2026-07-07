import { resolveReplyTarget } from "../messages/index.js";
import type { ChatEventEnvelope } from "../types.js";

type JsonObject = Record<string, unknown>;

export type ChatSynchronousResponseBody = Record<string, unknown>;

export interface ReplyRoutingOptions {
  replyRouting?: JsonObject;
}

export interface CreateReplyHelpersOptions {
  event?: ChatEventEnvelope;
  replyRouting?: JsonObject;
}

export interface ChatReplyPlaceholder {
  kind: "reply.placeholder";
  mode: "stream" | "private" | "async";
  sent: false;
  liveSendAvailable: false;
  reason: "live_send_disabled";
  fallbackText: string;
  target?: unknown;
  body?: unknown;
}

export interface ChatReplyHelpers {
  readonly sent: false;
  target(options?: ReplyRoutingOptions): JsonObject;
  text(text: string): ChatSynchronousResponseBody;
  json(body: ChatSynchronousResponseBody): ChatSynchronousResponseBody;
  placeholder(options?: {
    mode?: ChatReplyPlaceholder["mode"];
    fallbackText?: string;
    replyRouting?: JsonObject;
    target?: unknown;
    body?: unknown;
  }): ChatReplyPlaceholder;
  stream(streamLike: unknown, options?: { fallbackText?: string }): ChatReplyPlaceholder;
  privateText(target: unknown, text: string): ChatReplyPlaceholder;
}

export type ChatHandlerResult =
  | ChatSynchronousResponseBody
  | ChatReplyPlaceholder
  | Response
  | null
  | undefined
  | void;

function mergedReplyRouting(
  base: JsonObject | undefined,
  override: JsonObject | undefined,
): JsonObject | undefined {
  return base || override ? { ...(base ?? {}), ...(override ?? {}) } : undefined;
}

export function createReplyHelpers(
  helperOptions: CreateReplyHelpersOptions = {},
): ChatReplyHelpers {
  const resolveTarget = (options: ReplyRoutingOptions = {}) => {
    if (!helperOptions.event) {
      throw new TypeError("Expected an event before resolving a reply target.");
    }
    const replyRouting = mergedReplyRouting(
      helperOptions.replyRouting,
      options.replyRouting,
    );
    return resolveReplyTarget({
      event: helperOptions.event,
      ...(replyRouting ? { replyRouting } : {}),
    });
  };

  return {
    sent: false,
    target(options = {}): JsonObject {
      return resolveTarget(options);
    },
    text(text: string): ChatSynchronousResponseBody {
      return { text };
    },
    json(body: ChatSynchronousResponseBody): ChatSynchronousResponseBody {
      return body;
    },
    placeholder(options = {}): ChatReplyPlaceholder {
      const target = options.target ?? (
        helperOptions.event
          ? resolveTarget({ replyRouting: options.replyRouting })
          : undefined
      );
      return {
        kind: "reply.placeholder",
        mode: options.mode ?? "async",
        sent: false,
        liveSendAvailable: false,
        reason: "live_send_disabled",
        fallbackText:
          options.fallbackText ??
          "Reply placeholder created. Live Google Chat sends are disabled for this runtime slice.",
        target,
        body: options.body,
      };
    },
    stream(streamLike: unknown, options = {}): ChatReplyPlaceholder {
      return this.placeholder({
        mode: "stream",
        fallbackText:
          options.fallbackText ??
          "Streaming reply placeholder created. Live Google Chat sends are disabled.",
        body: streamLike,
      });
    },
    privateText(target: unknown, text: string): ChatReplyPlaceholder {
      return this.placeholder({
        mode: "private",
        fallbackText: text,
        target,
        body: { text },
      });
    },
  };
}

export function isReplyPlaceholder(value: unknown): value is ChatReplyPlaceholder {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as ChatReplyPlaceholder).kind === "reply.placeholder"
  );
}

export function jsonResponse(
  body: ChatSynchronousResponseBody,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

export function handlerResultToResponse(result: ChatHandlerResult): Response {
  if (result instanceof Response) {
    return result;
  }

  if (isReplyPlaceholder(result)) {
    return jsonResponse({ text: result.fallbackText });
  }

  if (result === null || result === undefined) {
    return jsonResponse({});
  }

  return jsonResponse(result);
}
