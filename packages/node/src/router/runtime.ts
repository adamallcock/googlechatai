import { normalizeEvent } from "../events.js";
import type {
  ChatEventEnvelope,
  ChatEventKind,
  ChatEventSource,
  ChatUserRef,
} from "../types.js";
import { guardDuplicateEventDelivery, type IdempotencyStore } from "../transport/index.js";
import {
  type ChatAIContextHelpers,
  type ChatContextLoaders,
  createAIContextHelpers,
} from "./context.js";
import {
  type ChatHandlerResult,
  type ChatReplyHelpers,
  createReplyHelpers,
  handlerResultToResponse,
  jsonResponse,
} from "./replies.js";

type RawRecord = Record<string, unknown>;

export interface ChatRuntimeLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export interface ChatDedupeOptions {
  store: IdempotencyStore;
  ttlMs?: number;
}

export interface ChatDeadlineOptions {
  budgetMs: number;
  onDeadline?: ChatHandler;
}

export interface ChatRequestVerification {
  ok: boolean;
  status?: string;
  reason?: string;
  [extra: string]: unknown;
}

export type ChatRequestVerifierFn = (
  request: Request,
) => Promise<ChatRequestVerification> | ChatRequestVerification;

export interface GoogleChatAIOptions {
  source?: ChatEventSource;
  appUser?: Pick<ChatUserRef, "name">;
  replyRouting?: Record<string, unknown>;
  logger?: Partial<ChatRuntimeLogger>;
  contextLoaders?: ChatContextLoaders;
  dedupe?: ChatDedupeOptions;
  deadline?: ChatDeadlineOptions;
  verifier?: ChatRequestVerifierFn;
}

export interface ChatHandlerContext {
  event: ChatEventEnvelope;
  rawPayload: unknown;
  request: Request | null;
  ai: ChatAIContextHelpers;
  reply: ChatReplyHelpers;
  json(body: Record<string, unknown>, init?: ResponseInit): Response;
}

export type ChatHandler = (
  event: ChatEventEnvelope,
  context: ChatHandlerContext,
) => ChatHandlerResult | Promise<ChatHandlerResult>;

export type ChatMiddlewareNext = () => Promise<ChatHandlerResult>;

export type ChatMiddleware = (
  event: ChatEventEnvelope,
  context: ChatHandlerContext,
  next: ChatMiddlewareNext,
) => ChatHandlerResult | Promise<ChatHandlerResult>;

export interface HandlePayloadOptions {
  request?: Request | null;
}

const KNOWN_EVENT_KINDS: ReadonlySet<ChatEventKind> = new Set<ChatEventKind>([
  "message.created",
  "message.updated",
  "message.deleted",
  "message.mentioned_app",
  "message.direct",
  "message.thread_reply",
  "message.slash_command",
  "message.app_command",
  "message.link_preview_requested",
  "message.unknown_command",
  "space.added",
  "space.removed",
  "space.updated",
  "space.deleted",
  "membership.created",
  "membership.updated",
  "membership.deleted",
  "reaction.created",
  "reaction.deleted",
  "card.clicked",
  "dialog.opened",
  "dialog.submitted",
  "dialog.cancelled",
  "widget.updated",
  "event.batch",
  "event.unknown",
]);

const noopLogger: ChatRuntimeLogger = {
  info() {},
  warn() {},
  error() {},
};

const DEADLINE_EXCEEDED = Symbol("chat.event.deadline_exceeded");

function asRecord(value: unknown): RawRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function mergeLogger(logger?: Partial<ChatRuntimeLogger>): ChatRuntimeLogger {
  return {
    info: logger?.info ?? noopLogger.info,
    warn: logger?.warn ?? noopLogger.warn,
    error: logger?.error ?? noopLogger.error,
  };
}

function eventMetadata(event: ChatEventEnvelope): Record<string, unknown> {
  return {
    eventId: event.eventId,
    eventKind: event.kind,
    rawKind: event.rawKind,
    idempotencyKey: event.idempotencyKey,
    source: event.source,
  };
}

function errorMetadata(
  event: ChatEventEnvelope | null,
  error: unknown,
): Record<string, unknown> {
  const base = event ? eventMetadata(event) : {};
  return {
    ...base,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

function isMentionOfApp(
  event: ChatEventEnvelope,
  appUser: Pick<ChatUserRef, "name"> | undefined,
): boolean {
  if (!appUser || !event.message) {
    return false;
  }

  return asArray(event.message.annotations).some((annotation) => {
    const raw = asRecord(annotation);
    const user = asRecord(raw?.user);

    return (
      raw?.kind === "userMention" &&
      (asString(user?.resourceName) === appUser.name || asString(user?.name) === appUser.name)
    );
  });
}

function routeKindForRawPayload(
  event: ChatEventEnvelope,
  rawPayload: unknown,
  appUser: Pick<ChatUserRef, "name"> | undefined,
): ChatEventKind {
  const raw = asRecord(rawPayload);
  const rawType = asString(raw?.type);
  const dialogEventType = asString(raw?.dialogEventType);

  if (
    rawType === "DIALOG_SUBMITTED" ||
    dialogEventType === "SUBMIT_DIALOG" ||
    dialogEventType === "SUBMITTED"
  ) {
    return "dialog.submitted";
  }

  if (
    (event.kind === "message.created" ||
      event.kind === "message.direct" ||
      event.kind === "message.thread_reply") &&
    isMentionOfApp(event, appUser)
  ) {
    return "message.mentioned_app";
  }

  return event.kind;
}

function adaptEventForRouter(
  event: ChatEventEnvelope,
  rawPayload: unknown,
  appUser: Pick<ChatUserRef, "name"> | undefined,
): ChatEventEnvelope {
  const kind = routeKindForRawPayload(event, rawPayload, appUser);
  return kind === event.kind ? event : { ...event, kind };
}

function isMessageKind(kind: ChatEventKind): boolean {
  return kind.startsWith("message.");
}

function normalizeSlashCommandName(name: string): string {
  const trimmed = name.startsWith("/") ? name.slice(1) : name;
  return trimmed.trim().toLowerCase();
}

function slashCommandNameForEvent(event: ChatEventEnvelope): string | null {
  const message = event.message as unknown as RawRecord | null;
  const slashCommand = asRecord(message?.slashCommand);
  const commandName = asString(slashCommand?.commandName);
  if (commandName) {
    return normalizeSlashCommandName(commandName);
  }

  // The normalized message annotations don't always carry commandName (it is
  // only populated from a matching `slashCommand`-kind annotation). Fall back
  // to the first token of the raw message text, which for a slash command is
  // always the "/commandName" itself; `argumentText` only holds the text
  // *after* the command and can never contain the command name.
  const fallbackText =
    asString(message?.text) ?? asString(message?.argumentText);
  const firstToken = fallbackText?.trim().split(/\s+/)[0];
  return firstToken ? normalizeSlashCommandName(firstToken) : null;
}

interface SlashCommandRegistration {
  name: string | null;
  handler: ChatHandler;
}

export class GoogleChatAI {
  readonly source: ChatEventSource;
  private readonly appUser: Pick<ChatUserRef, "name"> | undefined;
  private readonly replyRouting: Record<string, unknown> | undefined;
  private readonly logger: ChatRuntimeLogger;
  private readonly contextLoaders: ChatContextLoaders;
  private readonly dedupe: ChatDedupeOptions | undefined;
  private readonly deadline: ChatDeadlineOptions | undefined;
  private readonly middlewares: ChatMiddleware[] = [];
  private readonly messageHandlers: ChatHandler[] = [];
  private readonly mentionHandlers: ChatHandler[] = [];
  private readonly cardClickedHandlers: ChatHandler[] = [];
  private readonly dialogSubmittedHandlers: ChatHandler[] = [];
  private readonly dialogCancelledHandlers: ChatHandler[] = [];
  private readonly widgetUpdatedHandlers: ChatHandler[] = [];
  private readonly linkPreviewHandlers: ChatHandler[] = [];
  private readonly addedToSpaceHandlers: ChatHandler[] = [];
  private readonly removedFromSpaceHandlers: ChatHandler[] = [];
  private readonly reactionCreatedHandlers: ChatHandler[] = [];
  private readonly reactionDeletedHandlers: ChatHandler[] = [];
  private readonly membershipCreatedHandlers: ChatHandler[] = [];
  private readonly membershipUpdatedHandlers: ChatHandler[] = [];
  private readonly membershipDeletedHandlers: ChatHandler[] = [];
  private readonly messageUpdatedHandlers: ChatHandler[] = [];
  private readonly messageDeletedHandlers: ChatHandler[] = [];
  private readonly unknownEventHandlers: ChatHandler[] = [];
  private readonly slashCommandHandlers: SlashCommandRegistration[] = [];
  private readonly genericHandlers: Map<ChatEventKind, ChatHandler[]> = new Map();
  private readonly verifier: ChatRequestVerifierFn | undefined;

  constructor(options: GoogleChatAIOptions = {}) {
    this.source = options.source ?? "chat_http";
    this.appUser = options.appUser;
    this.replyRouting = options.replyRouting;
    this.logger = mergeLogger(options.logger);
    this.contextLoaders = options.contextLoaders ?? {};
    this.dedupe = options.dedupe;
    this.deadline = options.deadline;
    this.verifier = options.verifier;
  }

  use(middleware: ChatMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  onMessage(handler: ChatHandler): this {
    this.messageHandlers.push(handler);
    return this;
  }

  onMention(handler: ChatHandler): this {
    this.mentionHandlers.push(handler);
    return this;
  }

  onCardClicked(handler: ChatHandler): this {
    this.cardClickedHandlers.push(handler);
    return this;
  }

  onDialogSubmitted(handler: ChatHandler): this {
    this.dialogSubmittedHandlers.push(handler);
    return this;
  }

  onDialogCancelled(handler: ChatHandler): this {
    this.dialogCancelledHandlers.push(handler);
    return this;
  }

  onWidgetUpdated(handler: ChatHandler): this {
    this.widgetUpdatedHandlers.push(handler);
    return this;
  }

  onLinkPreview(handler: ChatHandler): this {
    this.linkPreviewHandlers.push(handler);
    return this;
  }

  onAddedToSpace(handler: ChatHandler): this {
    this.addedToSpaceHandlers.push(handler);
    return this;
  }

  onRemovedFromSpace(handler: ChatHandler): this {
    this.removedFromSpaceHandlers.push(handler);
    return this;
  }

  onReactionCreated(handler: ChatHandler): this {
    this.reactionCreatedHandlers.push(handler);
    return this;
  }

  onReactionDeleted(handler: ChatHandler): this {
    this.reactionDeletedHandlers.push(handler);
    return this;
  }

  onMembershipCreated(handler: ChatHandler): this {
    this.membershipCreatedHandlers.push(handler);
    return this;
  }

  onMembershipUpdated(handler: ChatHandler): this {
    this.membershipUpdatedHandlers.push(handler);
    return this;
  }

  onMembershipDeleted(handler: ChatHandler): this {
    this.membershipDeletedHandlers.push(handler);
    return this;
  }

  onMessageUpdated(handler: ChatHandler): this {
    this.messageUpdatedHandlers.push(handler);
    return this;
  }

  onMessageDeleted(handler: ChatHandler): this {
    this.messageDeletedHandlers.push(handler);
    return this;
  }

  onUnknownEvent(handler: ChatHandler): this {
    this.unknownEventHandlers.push(handler);
    return this;
  }

  /**
   * Register a slash command handler. `commandName` may be provided with or
   * without a leading slash and is matched case-insensitively. Calling this
   * with only a handler registers a bare fallback that matches every slash
   * command that has no more specific named handler.
   */
  onSlashCommand(handler: ChatHandler): this;
  onSlashCommand(commandName: string, handler: ChatHandler): this;
  onSlashCommand(commandNameOrHandler: string | ChatHandler, maybeHandler?: ChatHandler): this {
    if (typeof commandNameOrHandler === "function") {
      this.slashCommandHandlers.push({ name: null, handler: commandNameOrHandler });
      return this;
    }

    if (!maybeHandler) {
      throw new TypeError("onSlashCommand requires a handler when a command name is provided.");
    }

    this.slashCommandHandlers.push({
      name: normalizeSlashCommandName(commandNameOrHandler),
      handler: maybeHandler,
    });
    return this;
  }

  /**
   * Register a handler for any known `ChatEventKind`. Throws a `TypeError`
   * for unrecognized kinds so misspelled event names fail fast at
   * registration time rather than silently never firing.
   */
  on(kind: ChatEventKind, handler: ChatHandler): this {
    if (typeof kind !== "string" || !KNOWN_EVENT_KINDS.has(kind)) {
      throw new TypeError(`Unknown Google Chat event kind: ${String(kind)}`);
    }

    const existing = this.genericHandlers.get(kind);
    if (existing) {
      existing.push(handler);
    } else {
      this.genericHandlers.set(kind, [handler]);
    }
    return this;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse(
        {
          error: {
            code: "method_not_allowed",
            message: "Google Chat event endpoints accept POST requests.",
          },
        },
        {
          status: 405,
          headers: { allow: "POST" },
        },
      );
    }

    if (this.verifier) {
      let verification: ChatRequestVerification;
      try {
        verification = await this.verifier(request);
      } catch (error) {
        this.logger.error("chat.event.verifier_error", errorMetadata(null, error));
        return jsonResponse(
          {
            error: {
              code: "verification_unavailable",
              message: "Google Chat request verification failed to run.",
            },
          },
          { status: 500 },
        );
      }
      if (verification?.ok !== true) {
        this.logger.warn("chat.event.unauthorized", {
          verificationStatus: verification?.status ?? null,
          reason: verification?.reason ?? null,
        });
        return jsonResponse(
          {
            error: {
              code: "unauthorized_request",
              message: "Google Chat request verification failed.",
            },
          },
          { status: 401 },
        );
      }
    }

    let rawPayload: unknown;
    try {
      rawPayload = await request.json();
    } catch (error) {
      this.logger.warn("chat.event.invalid_json", errorMetadata(null, error));
      return jsonResponse(
        {
          error: {
            code: "invalid_json",
            message: "Expected a JSON Google Chat event payload.",
          },
        },
        { status: 400 },
      );
    }

    return this.handlePayload(rawPayload, { request });
  }

  async handlePayload(
    rawPayload: unknown,
    options: HandlePayloadOptions = {},
  ): Promise<Response> {
    let event: ChatEventEnvelope;

    try {
      event = adaptEventForRouter(
        normalizeEvent(rawPayload, { source: this.source }),
        rawPayload,
        this.appUser,
      );
    } catch (error) {
      this.logger.warn("chat.event.invalid_payload", errorMetadata(null, error));
      return jsonResponse(
        {
          error: {
            code: "invalid_event_payload",
            message: "Expected a Google Chat event object.",
          },
        },
        { status: 400 },
      );
    }

    return this.handleEvent(event, {
      rawPayload,
      request: options.request ?? null,
    });
  }

  async handleEvent(
    event: ChatEventEnvelope,
    options: { rawPayload?: unknown; request?: Request | null } = {},
  ): Promise<Response> {
    if (this.dedupe && event.idempotencyKey && event.idempotencyKey.trim() !== "") {
      const guard = await guardDuplicateEventDelivery(event, {
        store: this.dedupe.store,
        ttlMs: this.dedupe.ttlMs,
      });

      if (guard.duplicate) {
        this.logger.info("chat.event.duplicate", eventMetadata(event));
        return jsonResponse({ status: "duplicate_event_ignored" });
      }
    }

    const context = this.createHandlerContext(
      event,
      options.rawPayload ?? event,
      options.request ?? null,
    );

    try {
      const result = await this.runWithDeadline(event, context);
      const response = handlerResultToResponse(result);
      this.logger.info("chat.event.handled", {
        ...eventMetadata(event),
        responseStatus: response.status,
      });
      return response;
    } catch (error) {
      this.logger.error("chat.event.error", errorMetadata(event, error));
      return jsonResponse(
        {
          error: {
            code: "handler_error",
            message: "Google Chat handler failed.",
          },
        },
        { status: 500 },
      );
    }
  }

  private createHandlerContext(
    event: ChatEventEnvelope,
    rawPayload: unknown,
    request: Request | null,
  ): ChatHandlerContext {
    return {
      event,
      rawPayload,
      request,
      ai: createAIContextHelpers(
        {
          event,
          rawPayload,
          request,
          replyRouting: this.replyRouting,
        },
        this.contextLoaders,
      ),
      reply: createReplyHelpers({
        event,
        replyRouting: this.replyRouting,
      }),
      json: jsonResponse,
    };
  }

  private async runWithDeadline(
    event: ChatEventEnvelope,
    context: ChatHandlerContext,
  ): Promise<ChatHandlerResult> {
    const deadline = this.deadline;
    if (!deadline) {
      return this.runMiddlewareChain(event, context);
    }

    const chainPromise = this.runMiddlewareChain(event, context);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<typeof DEADLINE_EXCEEDED>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(DEADLINE_EXCEEDED), deadline.budgetMs);
    });

    const winner = await Promise.race([chainPromise, timeoutPromise]);

    if (winner !== DEADLINE_EXCEEDED) {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      return winner;
    }

    this.logger.warn("chat.event.deadline_exceeded", eventMetadata(event));

    chainPromise
      .then((lateResult) => {
        this.logger.info("chat.event.late_result", {
          ...eventMetadata(event),
          hadResult: lateResult !== undefined,
        });
      })
      .catch((error) => {
        this.logger.error("chat.event.late_failure", errorMetadata(event, error));
      });

    if (deadline.onDeadline) {
      return deadline.onDeadline(event, context);
    }

    return jsonResponse({ text: "Still working on it..." }, { status: 200 });
  }

  private async runMiddlewareChain(
    event: ChatEventEnvelope,
    context: ChatHandlerContext,
  ): Promise<ChatHandlerResult> {
    let currentIndex = -1;

    const run = async (index: number): Promise<ChatHandlerResult> => {
      if (index <= currentIndex) {
        throw new Error("Middleware next() called multiple times.");
      }

      currentIndex = index;
      const middleware = this.middlewares[index];

      if (!middleware) {
        return this.dispatchToHandlers(event, context);
      }

      return middleware(event, context, () => run(index + 1));
    };

    return run(0);
  }

  private async dispatchToHandlers(
    event: ChatEventEnvelope,
    context: ChatHandlerContext,
  ): Promise<ChatHandlerResult> {
    const handlers = this.handlersForEvent(event);

    for (const handler of handlers) {
      const result = await handler(event, context);
      if (result !== undefined) {
        return result;
      }
    }

    return undefined;
  }

  /**
   * Build the ordered handler list for an event, honoring dispatch
   * precedence: specific registration (e.g. a named slash command, or one
   * of the dedicated `on*` methods) first, then any generic `on(kind)`
   * registrations, then the family fallback (message.* falls back to
   * onMessage, mentions fall back to onMessage, everything else falls back
   * to onUnknownEvent).
   */
  private handlersForEvent(event: ChatEventEnvelope): ChatHandler[] {
    const generic = this.genericHandlers.get(event.kind) ?? [];

    if (event.kind === "message.slash_command") {
      const commandName = slashCommandNameForEvent(event);
      const named = this.slashCommandHandlers
        .filter((registration) => registration.name !== null && registration.name === commandName)
        .map((registration) => registration.handler);
      const bare = this.slashCommandHandlers
        .filter((registration) => registration.name === null)
        .map((registration) => registration.handler);

      return [...named, ...bare, ...generic, ...this.messageHandlers, ...this.unknownEventHandlers];
    }

    if (event.kind === "message.mentioned_app") {
      const mentionHandlers = this.mentionHandlers.length > 0 ? this.mentionHandlers : this.messageHandlers;
      return [...mentionHandlers, ...generic, ...this.unknownEventHandlers];
    }

    if (event.kind === "message.updated") {
      return [...this.messageUpdatedHandlers, ...generic, ...this.messageHandlers, ...this.unknownEventHandlers];
    }

    if (event.kind === "message.deleted") {
      return [...this.messageDeletedHandlers, ...generic, ...this.messageHandlers, ...this.unknownEventHandlers];
    }

    if (event.kind === "message.link_preview_requested") {
      return [...this.linkPreviewHandlers, ...generic, ...this.messageHandlers, ...this.unknownEventHandlers];
    }

    if (event.kind === "card.clicked") {
      return [...this.cardClickedHandlers, ...generic, ...this.unknownEventHandlers];
    }

    if (event.kind === "dialog.submitted") {
      return [...this.dialogSubmittedHandlers, ...generic, ...this.unknownEventHandlers];
    }

    if (event.kind === "dialog.cancelled") {
      return [...this.dialogCancelledHandlers, ...generic, ...this.unknownEventHandlers];
    }

    if (event.kind === "widget.updated") {
      return [...this.widgetUpdatedHandlers, ...generic, ...this.unknownEventHandlers];
    }

    if (event.kind === "space.added") {
      return [...this.addedToSpaceHandlers, ...generic, ...this.unknownEventHandlers];
    }

    if (event.kind === "space.removed") {
      return [...this.removedFromSpaceHandlers, ...generic, ...this.unknownEventHandlers];
    }

    if (event.kind === "reaction.created") {
      return [...this.reactionCreatedHandlers, ...generic, ...this.unknownEventHandlers];
    }

    if (event.kind === "reaction.deleted") {
      return [...this.reactionDeletedHandlers, ...generic, ...this.unknownEventHandlers];
    }

    if (event.kind === "membership.created") {
      return [...this.membershipCreatedHandlers, ...generic, ...this.unknownEventHandlers];
    }

    if (event.kind === "membership.updated") {
      return [...this.membershipUpdatedHandlers, ...generic, ...this.unknownEventHandlers];
    }

    if (event.kind === "membership.deleted") {
      return [...this.membershipDeletedHandlers, ...generic, ...this.unknownEventHandlers];
    }

    if (event.kind === "event.unknown") {
      return [...generic, ...this.unknownEventHandlers];
    }

    if (isMessageKind(event.kind)) {
      return [...generic, ...this.messageHandlers, ...this.unknownEventHandlers];
    }

    return [...generic, ...this.unknownEventHandlers];
  }
}
