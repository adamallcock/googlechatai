import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { GoogleChatAI, InMemoryIdempotencyStore } from "../src/index.js";
import { createReplyHelpers } from "../src/router/replies.js";

function delay<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const root = path.resolve(import.meta.dirname, "../../..");

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function postJson(body: unknown): Request {
  return new Request("http://127.0.0.1/chat/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GoogleChatAI router", () => {
  it("keeps standalone placeholder helpers usable without an event target", () => {
    const reply = createReplyHelpers();

    const placeholder = reply.placeholder({ fallbackText: "Thinking..." });

    expect(placeholder.kind).toBe("reply.placeholder");
    expect(placeholder.fallbackText).toBe("Thinking...");
    expect(placeholder.target).toBeUndefined();
  });

  it("runs middleware, dispatches fixture POSTs to onMessage, and returns a synchronous JSON reply", async () => {
    const raw = readJson("fixtures/events/message-created/basic.json");
    const calls: string[] = [];
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const loadThreadHistory = vi.fn(async (_ctx, options?: { limit?: number }) => ({
      items: [],
      limit: options?.limit ?? null,
      partial: true,
      reason: "No thread history loader configured in the test.",
    }));

    const chat = new GoogleChatAI({
      source: "fixture",
      logger,
      contextLoaders: {
        threadHistory: loadThreadHistory,
      },
    });

    chat.use(async (event, ctx, next) => {
      calls.push(`middleware:${event.kind}`);
      expect(ctx.rawPayload).toEqual(raw);
      return next();
    });

    chat.onMessage(async (event, ctx) => {
      calls.push(`handler:${event.kind}`);

      expect(event.message?.plainTextForModel).toContain(
        "@Ada Lovelace deploy staging https://example.com",
      );
      expect(event.message?.plainTextForModel).toContain(
        "System Note: Message spaces/AAA/messages/BBB from Ada Lovelace",
      );
      await expect(ctx.ai.currentMessage()).resolves.toEqual(event.message);
      await expect(ctx.ai.attachments()).resolves.toEqual(event.message?.attachments);
      await expect(ctx.ai.threadHistory({ limit: 5 })).resolves.toEqual({
        items: [],
        limit: 5,
        partial: true,
        reason: "No thread history loader configured in the test.",
      });
      expect(loadThreadHistory).toHaveBeenCalledTimes(1);
      expect(ctx.reply.sent).toBe(false);

      return ctx.reply.text("Received deploy request.");
    });

    const response = await chat.fetch(postJson(raw));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ text: "Received deploy request." });
    expect(calls).toEqual(["middleware:message.thread_reply", "handler:message.thread_reply"]);
    expect(logger.info).toHaveBeenCalledWith(
      "chat.event.handled",
      expect.objectContaining({
        eventKind: "message.thread_reply",
        eventId: "fixture:MESSAGE:spaces/AAA/messages/BBB:2026-06-29T18:00:00Z",
      }),
    );
  });

  it("rejects non-POST Fetch requests with method-not-allowed JSON", async () => {
    const chat = new GoogleChatAI({ source: "fixture" });

    const response = await chat.fetch(
      new Request("http://127.0.0.1/chat/events", { method: "GET" }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "method_not_allowed",
        message: "Google Chat event endpoints accept POST requests.",
      },
    });
  });

  it("rejects invalid JSON Fetch requests with structured errors", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const chat = new GoogleChatAI({ source: "fixture", logger });

    const response = await chat.fetch(
      new Request("http://127.0.0.1/chat/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_json",
        message: "Expected a JSON Google Chat event payload.",
      },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "chat.event.invalid_json",
      expect.objectContaining({
        errorName: "SyntaxError",
      }),
    );
  });

  it("routes app mentions to onMention without sending live replies", async () => {
    const raw = readJson("fixtures/events/message-created/basic.json");
    const message = raw.message as Record<string, unknown>;
    message.text = "<users/app> summarize this thread";
    message.formattedText = "<users/app> summarize this thread";
    message.argumentText = "summarize this thread";
    message.annotations = [
      {
        type: "USER_MENTION",
        startIndex: 0,
        length: 11,
        userMention: {
          user: {
            name: "users/app",
            displayName: "Runtime Bot",
            type: "BOT",
          },
          type: "MENTION",
        },
      },
    ];

    const chat = new GoogleChatAI({
      source: "fixture",
      appUser: { name: "users/app" },
    });
    const onMessage = vi.fn();

    chat.onMessage(onMessage);
    chat.onMention(async (event, ctx) => {
      expect(event.kind).toBe("message.mentioned_app");
      expect(ctx.reply.sent).toBe(false);
      return ctx.reply.json({ text: `Mention handled: ${event.message?.argumentText}` });
    });

    const response = await chat.fetch(postJson(raw));

    expect(onMessage).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      text: "Mention handled: summarize this thread",
    });
  });

  it("dispatches card clicks, dialog submissions, and unknown events to specific handlers", async () => {
    const chat = new GoogleChatAI({ source: "fixture" });
    const seen: string[] = [];

    chat.onCardClicked(async (event, ctx) => {
      seen.push(event.kind);
      return ctx.reply.json({ actionResponse: { type: "UPDATE_MESSAGE" } });
    });
    chat.onDialogSubmitted(async (event, ctx) => {
      seen.push(event.kind);
      return ctx.reply.json({
        actionResponse: {
          type: "DIALOG",
          dialogAction: { actionStatus: "OK" },
        },
      });
    });
    chat.onUnknownEvent(async (event, ctx) => {
      seen.push(event.kind);
      return ctx.reply.json({ text: `Unhandled ${event.rawKind ?? "unknown"} event.` });
    });

    await expect(
      (
        await chat.fetch(
          postJson({ type: "CARD_CLICKED", eventTime: "2026-06-29T18:00:00Z" }),
        )
      ).json(),
    ).resolves.toEqual({ actionResponse: { type: "UPDATE_MESSAGE" } });
    await expect(
      (
        await chat.fetch(
          postJson({ type: "DIALOG_SUBMITTED", eventTime: "2026-06-29T18:00:01Z" }),
        )
      ).json(),
    ).resolves.toEqual({
      actionResponse: { type: "DIALOG", dialogAction: { actionStatus: "OK" } },
    });
    await expect(
      (
        await chat.fetch(
          postJson({ type: "SOMETHING_NEW", eventTime: "2026-06-29T18:00:02Z" }),
        )
      ).json(),
    ).resolves.toEqual({ text: "Unhandled SOMETHING_NEW event." });

    expect(seen).toEqual(["card.clicked", "dialog.submitted", "event.unknown"]);
  });

  it("delegates AI context extension points and exposes non-sending reply placeholders", async () => {
    const raw = readJson("fixtures/events/message-created/basic.json");
    const quotedMessageTree = vi.fn(async () => ({ root: "quoted-tree" }));
    const roomHistory = vi.fn(async (_ctx, options?: { limit?: number }) => ({
      items: [],
      limit: options?.limit ?? null,
    }));
    const senderIdentities = vi.fn(async () => ({ sender: "Ada Lovelace" }));
    const timestamps = vi.fn(async () => ({ eventReceivedAt: "2026-06-29T18:00:00Z" }));
    const relationshipSystemNotes = vi.fn(async () => [
      "System Note: Delegated relationship note.",
    ]);
    const chat = new GoogleChatAI({
      source: "fixture",
      contextLoaders: {
        quotedMessageTree,
        roomHistory,
        senderIdentities,
        timestamps,
        relationshipSystemNotes,
      },
    });

    chat.onMessage(async (_event, ctx) => {
      await expect(ctx.ai.quotedMessageTree()).resolves.toEqual({
        root: "quoted-tree",
      });
      await expect(ctx.ai.roomHistory({ limit: 3 })).resolves.toEqual({
        items: [],
        limit: 3,
      });
      await expect(ctx.ai.senderIdentities()).resolves.toEqual({
        sender: "Ada Lovelace",
      });
      await expect(ctx.ai.timestamps()).resolves.toEqual({
        eventReceivedAt: "2026-06-29T18:00:00Z",
      });
      await expect(ctx.ai.relationshipSystemNotes()).resolves.toEqual([
        "System Note: Delegated relationship note.",
      ]);

      expect(ctx.reply.privateText("users/123", "private").sent).toBe(false);
      return ctx.reply.stream(["chunk"], { fallbackText: "Streaming disabled locally." });
    });

    const response = await chat.fetch(postJson(raw));

    await expect(response.json()).resolves.toEqual({
      text: "Streaming disabled locally.",
    });
    expect(quotedMessageTree).toHaveBeenCalledTimes(1);
    expect(roomHistory).toHaveBeenCalledTimes(1);
    expect(senderIdentities).toHaveBeenCalledTimes(1);
    expect(timestamps).toHaveBeenCalledTimes(1);
    expect(relationshipSystemNotes).toHaveBeenCalledTimes(1);
  });

  it("pipes default reply routing through reply helpers and AI context", async () => {
    const raw = readJson("fixtures/events/message-created/basic.json");
    const chat = new GoogleChatAI({
      source: "fixture",
      replyRouting: {
        roomThreadReply: "topLevel",
      },
    });
    const snapshot: Record<string, unknown> = {};

    chat.onMessage(async (_event, ctx) => {
      snapshot.replyTarget = ctx.reply.target();
      snapshot.aiReplyTarget = await ctx.ai.replyTarget();
      snapshot.notes = await ctx.ai.relationshipSystemNotes();
      const placeholder = ctx.reply.placeholder({ fallbackText: "Working on it." });
      snapshot.placeholderTarget = placeholder.target;
      return placeholder;
    });

    const response = await chat.fetch(postJson(raw));

    await expect(response.json()).resolves.toEqual({ text: "Working on it." });
    expect(snapshot.replyTarget).toMatchObject({
      route: "topLevel",
      reason: "room_thread_reply_top_level",
    });
    expect(snapshot.aiReplyTarget).toEqual(snapshot.replyTarget);
    expect(snapshot.placeholderTarget).toEqual(snapshot.replyTarget);
    expect(snapshot.notes).toContain(
      "System Note: Reply routing selected a top-level message target.",
    );
  });

  it("returns structured errors and logs handler failures", async () => {
    const raw = readJson("fixtures/events/message-created/basic.json");
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const chat = new GoogleChatAI({ source: "fixture", logger });

    chat.onMessage(() => {
      throw new Error("boom");
    });

    const response = await chat.fetch(postJson(raw));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "handler_error",
        message: "Google Chat handler failed.",
      },
    });
    expect(logger.error).toHaveBeenCalledWith(
      "chat.event.error",
      expect.objectContaining({
        eventKind: "message.thread_reply",
        errorMessage: "boom",
      }),
    );
  });

  it("routes slash commands by name using the slash-command fixture shape", async () => {
    const raw = readJson("fixtures/events/message-created/slash-command.json");
    const chat = new GoogleChatAI({ source: "fixture" });
    const seen: string[] = [];

    chat.onSlashCommand("/deploy", async (event, ctx) => {
      seen.push("deploy");
      expect(event.kind).toBe("message.slash_command");
      return ctx.reply.text(`deployed: ${event.message?.argumentText}`);
    });
    chat.onSlashCommand("other", async () => {
      seen.push("other");
      return undefined;
    });

    const response = await chat.fetch(postJson(raw));

    expect(seen).toEqual(["deploy"]);
    await expect(response.json()).resolves.toEqual({ text: "deployed: staging" });
  });

  it("matches slash command names case-insensitively and without a leading slash", async () => {
    const raw = readJson("fixtures/events/message-created/slash-command.json");
    const chat = new GoogleChatAI({ source: "fixture" });

    chat.onSlashCommand("DEPLOY", async (_event, ctx) => ctx.reply.text("matched"));

    const response = await chat.fetch(postJson(raw));

    await expect(response.json()).resolves.toEqual({ text: "matched" });
  });

  it("falls back to a bare onSlashCommand handler when no named handler matches", async () => {
    const raw = readJson("fixtures/events/message-created/slash-command.json");
    const chat = new GoogleChatAI({ source: "fixture" });
    const namedCalls: string[] = [];

    chat.onSlashCommand("not-deploy", async () => {
      namedCalls.push("not-deploy");
      return undefined;
    });
    chat.onSlashCommand(async (_event, ctx) => ctx.reply.text("bare fallback"));

    const response = await chat.fetch(postJson(raw));

    expect(namedCalls).toEqual([]);
    await expect(response.json()).resolves.toEqual({ text: "bare fallback" });
  });

  it("falls back from slash commands to onMessage and onUnknownEvent when nothing matches", async () => {
    const raw = readJson("fixtures/events/message-created/slash-command.json");
    const chat = new GoogleChatAI({ source: "fixture" });
    const calls: string[] = [];

    chat.onMessage(async (_event, ctx) => {
      calls.push("onMessage");
      return ctx.reply.text("message fallback");
    });
    chat.onUnknownEvent(async (_event, ctx) => {
      calls.push("onUnknownEvent");
      return ctx.reply.text("unknown fallback");
    });

    const response = await chat.fetch(postJson(raw));

    expect(calls).toEqual(["onMessage"]);
    await expect(response.json()).resolves.toEqual({ text: "message fallback" });
  });

  it("routes generic on() registrations for reaction, membership, and space events", async () => {
    const chat = new GoogleChatAI({ source: "fixture" });
    const seen: string[] = [];

    chat.on("reaction.created", async (event, ctx) => {
      seen.push(event.kind);
      return ctx.reply.json({ text: "reaction seen" });
    });
    chat.on("membership.created", async (event, ctx) => {
      seen.push(event.kind);
      return ctx.reply.json({ text: "membership seen" });
    });
    chat.on("space.added", async (event, ctx) => {
      seen.push(event.kind);
      return ctx.reply.json({ text: "space seen" });
    });

    const reactionResponse = await chat.fetch(
      postJson(readJson("fixtures/events/workspace/reaction-created.json")),
    );
    const membershipResponse = await chat.fetch(
      postJson(readJson("fixtures/events/workspace/membership-created.json")),
    );
    const spaceResponse = await chat.fetch(
      postJson(readJson("fixtures/events/space/added-to-space.json")),
    );

    await expect(reactionResponse.json()).resolves.toEqual({ text: "reaction seen" });
    await expect(membershipResponse.json()).resolves.toEqual({ text: "membership seen" });
    await expect(spaceResponse.json()).resolves.toEqual({ text: "space seen" });
    expect(seen).toEqual(["reaction.created", "membership.created", "space.added"]);
  });

  it("dispatches every new dedicated on* registration to its matching event kind", async () => {
    const chat = new GoogleChatAI({ source: "fixture" });
    const seen: string[] = [];

    chat.onAddedToSpace(async (event, ctx) => {
      seen.push(event.kind);
      return ctx.reply.text("added");
    });
    chat.onRemovedFromSpace(async (event, ctx) => {
      seen.push(event.kind);
      return ctx.reply.text("removed");
    });
    chat.onReactionDeleted(async (event, ctx) => {
      seen.push(event.kind);
      return ctx.reply.text("reaction deleted");
    });
    chat.onMembershipUpdated(async (event, ctx) => {
      seen.push(event.kind);
      return ctx.reply.text("membership updated");
    });
    chat.onMembershipDeleted(async (event, ctx) => {
      seen.push(event.kind);
      return ctx.reply.text("membership deleted");
    });
    chat.onMessageUpdated(async (event, ctx) => {
      seen.push(event.kind);
      return ctx.reply.text("message updated");
    });
    chat.onMessageDeleted(async (event, ctx) => {
      seen.push(event.kind);
      return ctx.reply.text("message deleted");
    });
    chat.onDialogCancelled(async (event, ctx) => {
      seen.push(event.kind);
      return ctx.reply.text("dialog cancelled");
    });
    chat.onWidgetUpdated(async (event, ctx) => {
      seen.push(event.kind);
      return ctx.reply.text("widget updated");
    });

    const responses = await Promise.all(
      [
        "fixtures/events/space/added-to-space.json",
        "fixtures/events/space/removed-from-space.json",
        "fixtures/events/workspace/reaction-deleted.json",
        "fixtures/events/workspace/membership-updated.json",
        "fixtures/events/workspace/membership-deleted.json",
        "fixtures/events/workspace/message-updated.json",
        "fixtures/events/workspace/message-deleted.json",
        "fixtures/events/card/dialog-cancelled.json",
        "fixtures/events/card/widget-update.json",
      ].map((path) => chat.fetch(postJson(readJson(path))).then((response) => response.json())),
    );

    expect(responses).toEqual([
      { text: "added" },
      { text: "removed" },
      { text: "reaction deleted" },
      { text: "membership updated" },
      { text: "membership deleted" },
      { text: "message updated" },
      { text: "message deleted" },
      { text: "dialog cancelled" },
      { text: "widget updated" },
    ]);
    expect(seen).toEqual([
      "space.added",
      "space.removed",
      "reaction.deleted",
      "membership.updated",
      "membership.deleted",
      "message.updated",
      "message.deleted",
      "dialog.cancelled",
      "widget.updated",
    ]);
  });

  it("falls back message.updated to onMessage when no dedicated handler is registered", async () => {
    const chat = new GoogleChatAI({ source: "fixture" });

    chat.onMessage(async (event, ctx) => {
      expect(event.kind).toBe("message.updated");
      return ctx.reply.text("message fallback");
    });

    const response = await chat.fetch(
      postJson(readJson("fixtures/events/workspace/message-updated.json")),
    );

    await expect(response.json()).resolves.toEqual({ text: "message fallback" });
  });

  it("throws when on() is registered with an unknown event kind", () => {
    const chat = new GoogleChatAI({ source: "fixture" });

    expect(() =>
      chat.on("not.a.real.kind" as never, async () => undefined),
    ).toThrow(TypeError);
  });

  it("short-circuits duplicate deliveries when dedupe is configured", async () => {
    const raw = readJson("fixtures/events/message-created/basic.json");
    const store = new InMemoryIdempotencyStore();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const chat = new GoogleChatAI({
      source: "fixture",
      logger,
      dedupe: { store },
    });
    const handlerCalls: string[] = [];

    chat.onMessage(async (_event, ctx) => {
      handlerCalls.push("handled");
      return ctx.reply.text("handled once");
    });

    const first = await chat.fetch(postJson(raw));
    const second = await chat.fetch(postJson(raw));

    await expect(first.json()).resolves.toEqual({ text: "handled once" });
    await expect(second.json()).resolves.toEqual({ status: "duplicate_event_ignored" });
    expect(handlerCalls).toEqual(["handled"]);
    expect(logger.info).toHaveBeenCalledWith(
      "chat.event.duplicate",
      expect.objectContaining({
        eventKind: "message.thread_reply",
      }),
    );
  });

  it("returns the fallback response and logs late completion when the deadline is exceeded", async () => {
    const raw = readJson("fixtures/events/message-created/basic.json");
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const chat = new GoogleChatAI({
      source: "fixture",
      logger,
      deadline: { budgetMs: 20 },
    });

    chat.onMessage(async (_event, ctx) => {
      await delay(undefined, 60);
      return ctx.reply.text("slow result");
    });

    const response = await chat.fetch(postJson(raw));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "Still working on it..." });
    expect(logger.warn).toHaveBeenCalledWith(
      "chat.event.deadline_exceeded",
      expect.objectContaining({ eventKind: "message.thread_reply" }),
    );

    await vi.waitFor(() => {
      expect(logger.info).toHaveBeenCalledWith(
        "chat.event.late_result",
        expect.objectContaining({ eventKind: "message.thread_reply" }),
      );
    });
  });

  it("invokes a custom onDeadline handler when provided and the budget elapses", async () => {
    const raw = readJson("fixtures/events/message-created/basic.json");
    const chat = new GoogleChatAI({
      source: "fixture",
      deadline: {
        budgetMs: 20,
        onDeadline: async (_event, ctx) => ctx.reply.text("custom deadline reply"),
      },
    });

    chat.onMessage(async (_event, ctx) => {
      await delay(undefined, 60);
      return ctx.reply.text("slow result");
    });

    const response = await chat.fetch(postJson(raw));

    await expect(response.json()).resolves.toEqual({ text: "custom deadline reply" });
  });

  it("logs a late failure when the handler eventually rejects after the deadline", async () => {
    const raw = readJson("fixtures/events/message-created/basic.json");
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const chat = new GoogleChatAI({
      source: "fixture",
      logger,
      deadline: { budgetMs: 20 },
    });

    chat.onMessage(async () => {
      await delay(undefined, 60);
      throw new Error("late boom");
    });

    const response = await chat.fetch(postJson(raw));

    await expect(response.json()).resolves.toEqual({ text: "Still working on it..." });

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        "chat.event.late_failure",
        expect.objectContaining({ errorMessage: "late boom" }),
      );
    });
  });

  it("returns the handler result directly when it completes within the deadline budget", async () => {
    const raw = readJson("fixtures/events/message-created/basic.json");
    const chat = new GoogleChatAI({
      source: "fixture",
      deadline: { budgetMs: 200 },
    });

    chat.onMessage(async (_event, ctx) => {
      await delay(undefined, 5);
      return ctx.reply.text("fast result");
    });

    const response = await chat.fetch(postJson(raw));

    await expect(response.json()).resolves.toEqual({ text: "fast result" });
  });
});
