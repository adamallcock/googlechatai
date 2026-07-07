import type {
  ChatEventEnvelope,
  NormalizedMessage,
} from "../types.js";
import { resolveReplyTarget } from "../messages/index.js";

type JsonObject = Record<string, unknown>;

export interface ChatContextLoaderInput {
  event: ChatEventEnvelope;
  rawPayload: unknown;
  request: Request | null;
  replyRouting?: JsonObject;
}

export interface ChatHistoryLoadOptions {
  limit?: number;
  order?: "asc" | "desc";
  since?: string;
  until?: string;
}

export interface ChatContextLoaders {
  currentMessage?: (
    input: ChatContextLoaderInput,
  ) => Promise<NormalizedMessage | null> | NormalizedMessage | null;
  quotedMessageTree?: (
    input: ChatContextLoaderInput,
  ) => Promise<unknown> | unknown;
  threadHistory?: (
    input: ChatContextLoaderInput,
    options?: ChatHistoryLoadOptions,
  ) => Promise<unknown> | unknown;
  roomHistory?: (
    input: ChatContextLoaderInput,
    options?: ChatHistoryLoadOptions,
  ) => Promise<unknown> | unknown;
  attachments?: (
    input: ChatContextLoaderInput,
  ) => Promise<unknown[]> | unknown[];
  senderIdentities?: (
    input: ChatContextLoaderInput,
  ) => Promise<unknown> | unknown;
  timestamps?: (input: ChatContextLoaderInput) => Promise<unknown> | unknown;
  relationshipSystemNotes?: (
    input: ChatContextLoaderInput,
  ) => Promise<string[]> | string[];
}

export interface ChatAIContextHelpers {
  currentMessage(): Promise<NormalizedMessage | null>;
  replyTarget(options?: { replyRouting?: JsonObject }): Promise<JsonObject>;
  quotedMessageTree(): Promise<unknown>;
  threadHistory(options?: ChatHistoryLoadOptions): Promise<unknown>;
  roomHistory(options?: ChatHistoryLoadOptions): Promise<unknown>;
  attachments(): Promise<unknown[]>;
  senderIdentities(): Promise<unknown>;
  timestamps(): Promise<unknown>;
  relationshipSystemNotes(): Promise<string[]>;
}

export function createAIContextHelpers(
  input: ChatContextLoaderInput,
  loaders: ChatContextLoaders = {},
): ChatAIContextHelpers {
  const resolvedReplyTarget = (options: { replyRouting?: JsonObject } = {}) => {
    const replyRouting =
      input.replyRouting || options.replyRouting
        ? { ...(input.replyRouting ?? {}), ...(options.replyRouting ?? {}) }
        : undefined;
    return resolveReplyTarget({
      event: input.event,
      ...(replyRouting ? { replyRouting } : {}),
    });
  };

  return {
    async currentMessage(): Promise<NormalizedMessage | null> {
      return loaders.currentMessage
        ? loaders.currentMessage(input)
        : input.event.message;
    },
    async replyTarget(options = {}): Promise<JsonObject> {
      return resolvedReplyTarget(options);
    },
    async quotedMessageTree(): Promise<unknown> {
      return loaders.quotedMessageTree ? loaders.quotedMessageTree(input) : null;
    },
    async threadHistory(options?: ChatHistoryLoadOptions): Promise<unknown> {
      return loaders.threadHistory
        ? loaders.threadHistory(input, options)
        : {
            items: [],
            partial: true,
            reason: "No thread history loader configured.",
          };
    },
    async roomHistory(options?: ChatHistoryLoadOptions): Promise<unknown> {
      return loaders.roomHistory
        ? loaders.roomHistory(input, options)
        : {
            items: [],
            partial: true,
            reason: "No room history loader configured.",
          };
    },
    async attachments(): Promise<unknown[]> {
      return loaders.attachments
        ? loaders.attachments(input)
        : input.event.message?.attachments ?? [];
    },
    async senderIdentities(): Promise<unknown> {
      return loaders.senderIdentities
        ? loaders.senderIdentities(input)
        : {
            actor: input.event.actor,
            sender: input.event.message?.sender ?? null,
          };
    },
    async timestamps(): Promise<unknown> {
      return loaders.timestamps
        ? loaders.timestamps(input)
        : {
            eventReceivedAt: input.event.receivedAt,
            messageCreatedAt: input.event.message?.createdAt ?? null,
            messageUpdatedAt: input.event.message?.updatedAt ?? null,
            messageDeletedAt: input.event.message?.deletedAt ?? null,
          };
    },
    async relationshipSystemNotes(): Promise<string[]> {
      if (loaders.relationshipSystemNotes) {
        return loaders.relationshipSystemNotes(input);
      }

      const notes: string[] = [];
      if (input.event.kind === "message.mentioned_app") {
        notes.push("System Note: The app was mentioned in this message.");
      }
      if (input.event.message?.state.threadReply) {
        notes.push("System Note: This message is in a thread.");
      }
      if ((input.event.message?.attachments.length ?? 0) > 0) {
        notes.push(
          "System Note: This message includes attachment metadata; use the attachment loader for parsed content.",
        );
      }
      try {
        notes.push(...(resolvedReplyTarget().systemNotes as string[]));
      } catch {
        // Some non-message events don't carry enough routing metadata; leave notes unchanged.
      }
      return notes;
    },
  };
}
