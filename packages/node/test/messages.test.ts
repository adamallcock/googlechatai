import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildBufferedStreamPatches,
  planReplaceCards,
  planSearchMessages,
  buildConversationContext,
  buildConversationContextWithIdentity,
  buildUpdateMask,
  generateClientMessageId,
  generateRequestId,
  hydratePlaceholderResponseHandle,
  InMemoryAsyncResponseQueue,
  InMemoryIdentityCache,
  planBufferedPlaceholderCompletion,
  planBufferedStreamMessage,
  planAsyncResponse,
  planCompletePlaceholderResponse,
  planDeleteAppMessage,
  planEditMessage,
  planFindOrSetupDm,
  planPlaceholderResponse,
  planReplyToEvent,
  planReadSpaceContext,
  planReadThreadContext,
  planReplyInThread,
  projectModelContext,
  planSendToSpace,
  planSendToUser,
  planStartThread,
  planStreamMessage,
  resolveReplyTarget,
  selectPlaceholderText,
  syncDirectoryUsersToCache,
} from "../src/index.js";

const root = path.resolve(import.meta.dirname, "../../..");

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")) as T;
}

const planners: Record<string, (input: Record<string, unknown>) => unknown> = {
  "messages.sendToSpace": planSendToSpace,
  "messages.sendToUser": planSendToUser,
  "messages.findOrSetupDm": planFindOrSetupDm,
  "messages.replyInThread": planReplyInThread,
  "messages.replyToEvent": planReplyToEvent,
  "messages.startThread": planStartThread,
  "messages.edit": planEditMessage,
  "messages.deleteAppMessage": planDeleteAppMessage,
  "messages.stream": planStreamMessage,
  "messages.placeholder.create": planPlaceholderResponse,
  "messages.placeholder.complete": planCompletePlaceholderResponse,
  "messages.placeholder.bufferedComplete": planBufferedPlaceholderCompletion,
  "messages.async.plan": planAsyncResponse,
};

describe("message dry-run call plans", () => {
  const cases = readJson<
    Array<{
      id: string;
      operation: string;
      input: Record<string, unknown>;
      expect: unknown;
    }>
  >("conformance/cases/messages.call-plans.json");

  for (const testCase of cases) {
    it(`matches conformance case ${testCase.id}`, () => {
      expect(planners[testCase.operation](testCase.input)).toEqual(testCase.expect);
    });
  }

  it("generates stable request and client message IDs from seeds", () => {
    expect(generateRequestId("W9 Stream #1")).toBe("req-w9-stream-1");
    expect(generateClientMessageId("W9 Stream #1")).toBe("client-w9-stream-1");
  });

  it("generates update masks in Google Chat patch field order", () => {
    expect(buildUpdateMask({ accessoryWidgets: [], text: "hi", cardsV2: [] })).toBe(
      "text,cardsV2,accessoryWidgets",
    );
  });

  it("resolves reply targets by mimicking DM, room thread, and room top-level context", () => {
    expect(
      resolveReplyTarget({
        event: {
          kind: "message.direct",
          space: { name: "spaces/DM1", type: "DM" },
          message: { state: { directMessage: true, threadReply: false } },
        },
      }),
    ).toMatchObject({
      kind: "chat.reply_target",
      conversation: "dm",
      route: "topLevel",
      space: "spaces/DM1",
      threadName: null,
      threadKey: null,
      reason: "dm_top_level",
    });

    expect(
      resolveReplyTarget({
        event: {
          kind: "message.thread_reply",
          space: { name: "spaces/AAA", type: "ROOM" },
          message: {
            thread: { name: "spaces/AAA/threads/T1" },
            state: { threadReply: true, directMessage: false },
          },
        },
      }),
    ).toMatchObject({
      conversation: "space",
      route: "thread",
      space: "spaces/AAA",
      threadName: "spaces/AAA/threads/T1",
      threadKey: null,
      messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
      reason: "room_thread_reply",
    });

    expect(
      resolveReplyTarget({
        event: {
          kind: "message.mentioned_app",
          space: { name: "spaces/AAA", type: "ROOM" },
          message: {
            ref: { name: "spaces/AAA/messages/ROOT" },
            state: { threadReply: false, directMessage: false },
          },
        },
      }),
    ).toMatchObject({
      conversation: "space",
      route: "thread",
      space: "spaces/AAA",
      threadName: null,
      threadKey: "chat-ai-sdk-reply-spaces-aaa-messages-root",
      reason: "room_top_level_thread_key",
      warnings: [
        "Event did not include a thread name; using a stable threadKey derived from the triggering message.",
      ],
    });
  });

  it("lets developers override reply routing to top-level messages", () => {
    expect(
      resolveReplyTarget({
        event: {
          kind: "message.thread_reply",
          space: { name: "spaces/AAA", type: "ROOM" },
          message: {
            thread: { name: "spaces/AAA/threads/T1" },
            state: { threadReply: true, directMessage: false },
          },
        },
        replyRouting: {
          strategy: "topLevel",
        },
      }),
    ).toMatchObject({
      conversation: "space",
      route: "topLevel",
      space: "spaces/AAA",
      threadName: null,
      threadKey: null,
      messageReplyOption: null,
      reason: "forced_top_level",
    });
  });

  it("guards invalid reply routing options before planning sends", () => {
    expect(() =>
      resolveReplyTarget({
        event: {
          kind: "message.mentioned_app",
          space: { name: "spaces/AAA", type: "ROOM" },
          message: {
            state: { threadReply: false, directMessage: false },
          },
        },
        replyRouting: {
          messageReplyOption: "REPLY_SOMEWHERE_MAYBE",
        },
      }),
    ).toThrow(/replyRouting.messageReplyOption/);
  });

  it("treats top-level room messages with thread names as top-level invocations", () => {
    expect(
      resolveReplyTarget({
        event: {
          kind: "message.mentioned_app",
          space: { name: "spaces/AAA", type: "ROOM" },
          message: {
            thread: { name: "spaces/AAA/threads/ROOT" },
            state: { threadReply: false, directMessage: false },
          },
        },
        replyRouting: {
          roomTopLevel: "topLevel",
          roomThreadReply: "thread",
        },
      }),
    ).toMatchObject({
      conversation: "space",
      route: "topLevel",
      space: "spaces/AAA",
      threadName: null,
      threadKey: null,
      reason: "room_top_level_top_level",
    });
  });

  it("plans reply-to-event sends using the resolved reply target", () => {
    const plan = planReplyToEvent({
      event: {
        kind: "message.thread_reply",
        space: { name: "spaces/AAA", type: "ROOM" },
        message: {
          thread: { name: "spaces/AAA/threads/T1" },
          state: { threadReply: true, directMessage: false },
        },
      },
      text: "Answer in the same thread.",
      requestId: "req-reply-route",
      clientMessageId: "client-reply-route",
    });

    expect(plan.requests).toEqual([
      {
        resource: "spaces.messages.create",
        method: "POST",
        path: "/v1/spaces/AAA/messages",
        query: {
          requestId: "req-reply-route",
          messageId: "client-reply-route",
          messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
        },
        body: {
          text: "Answer in the same thread.",
          thread: { name: "spaces/AAA/threads/T1" },
        },
      },
    ]);
    expect(plan.replyTarget).toMatchObject({
      route: "thread",
      threadName: "spaces/AAA/threads/T1",
      reason: "room_thread_reply",
    });
  });

  it("plans placeholders directly from event reply routing metadata", () => {
    const plan = planPlaceholderResponse({
      event: {
        kind: "message.mentioned_app",
        space: { name: "spaces/AAA", type: "ROOM" },
        message: {
          ref: { name: "spaces/AAA/messages/ROOT" },
          state: { threadReply: false, directMessage: false },
        },
      },
      placeholderText: "Thinking...",
      requestId: "req-event-placeholder",
      clientMessageId: "client-event-placeholder",
      correlationId: "event-root",
    });

    expect(plan.requests[0]).toMatchObject({
      path: "/v1/spaces/AAA/messages",
      query: {
        requestId: "req-event-placeholder",
        messageId: "client-event-placeholder",
        messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
      },
      body: {
        text: "Thinking...",
        thread: {
          threadKey: "chat-ai-sdk-reply-spaces-aaa-messages-root",
        },
      },
    });
    expect(plan.placeholder.replyTarget).toMatchObject({
      route: "thread",
      threadKey: "chat-ai-sdk-reply-spaces-aaa-messages-root",
      reason: "room_top_level_thread_key",
    });
    expect(plan.placeholder.handle).toMatchObject({
      threadName: null,
      threadKey: "chat-ai-sdk-reply-spaces-aaa-messages-root",
      replyTarget: {
        route: "thread",
        threadKey: "chat-ai-sdk-reply-spaces-aaa-messages-root",
      },
    });
  });

  it("buffers model chunks into bounded edit-stream patches", () => {
    const input = readJson<Record<string, unknown>>("fixtures/messages/buffered-stream.json");
    const expected = readJson<Record<string, unknown>>(
      "fixtures/expected/messages/buffered-stream.json",
    );

    expect(buildBufferedStreamPatches(input)).toEqual(
      (expected.streaming as Record<string, unknown>).buffering,
    );
    expect(planBufferedStreamMessage(input)).toEqual(expected);
    expect(buildBufferedStreamPatches({ ...input, throttleMs: 0 }).cadence).toMatchObject({
      throttleMs: 0,
    });
  });

  it("selects placeholder text from configurable defaults and modes", () => {
    expect(selectPlaceholderText({})).toEqual({
      kind: "chat.placeholder_text_selection",
      text: "Thinking...",
      mode: "first",
      index: 0,
      count: 3,
      source: "default",
      nextCursor: null,
      randomSeed: null,
      warnings: [],
    });
    expect(
      selectPlaceholderText({
        placeholderTexts: ["One", "Two", "Three"],
        placeholderMode: "roundRobin",
        placeholderCursor: 4,
      }),
    ).toEqual({
      kind: "chat.placeholder_text_selection",
      text: "Two",
      mode: "roundRobin",
      index: 1,
      count: 3,
      source: "placeholderTexts",
      nextCursor: 5,
      randomSeed: null,
      warnings: [],
    });
    expect(
      selectPlaceholderText({
        placeholderTexts: ["One", "Two", "Three"],
        placeholderMode: "random",
        placeholderRandomSeed: "abc",
      }),
    ).toEqual({
      kind: "chat.placeholder_text_selection",
      text: "Three",
      mode: "random",
      index: 2,
      count: 3,
      source: "placeholderTexts",
      nextCursor: null,
      randomSeed: "abc",
      warnings: [],
    });
  });

  it("parses admin placeholder configs from JSON and CSV strings", () => {
    expect(
      selectPlaceholderText({
        placeholderConfigJson: JSON.stringify({
          texts: ["Thinking...", "Checking the thread...", "Reviewing attachments..."],
          mode: "roundRobin",
          cursor: 2,
        }),
      }),
    ).toMatchObject({
      text: "Reviewing attachments...",
      mode: "roundRobin",
      index: 2,
      nextCursor: 3,
      source: "placeholderConfigJson",
    });
    expect(
      selectPlaceholderText({
        placeholderConfigCsv: "Thinking...,Checking context...,Reviewing files...",
        placeholderMode: "roundRobin",
        placeholderCursor: 1,
      }),
    ).toMatchObject({
      text: "Checking context...",
      mode: "roundRobin",
      index: 1,
      nextCursor: 2,
      source: "placeholderConfigCsv",
    });
  });

  it("refuses empty placeholder text pools and unknown selection modes", () => {
    expect(() => selectPlaceholderText({ placeholderTexts: ["", "   "] })).toThrow(
      /at least one non-empty placeholder/,
    );
    expect(() =>
      selectPlaceholderText({
        placeholderTexts: ["Thinking..."],
        placeholderMode: "shuffle",
      }),
    ).toThrow(/placeholderMode/);
  });

  it("hydrates a placeholder response handle from the created Chat message", () => {
    const plan = planPlaceholderResponse({
      space: "spaces/AAA",
      thread: "spaces/AAA/threads/T1",
      placeholderConfigJson: JSON.stringify({
        texts: ["Thinking...", "Checking recent context...", "Reviewing files..."],
        mode: "roundRobin",
        cursor: 1,
      }),
      authMode: "user",
      requestId: "req-placeholder",
      clientMessageId: "client-placeholder",
      correlationId: "event-123",
    });
    const seed = (plan.placeholder as Record<string, unknown>).handle as Record<
      string,
      unknown
    >;

    expect(
      hydratePlaceholderResponseHandle(seed, {
        name: "spaces/AAA/messages/created-placeholder",
        createTime: "2026-07-04T00:00:00Z",
        thread: { name: "spaces/AAA/threads/T1" },
      }),
    ).toEqual({
      kind: "chat.placeholder_response_handle",
      space: "spaces/AAA",
      messageName: "spaces/AAA/messages/created-placeholder",
      threadName: "spaces/AAA/threads/T1",
      threadKey: null,
      requestId: "req-placeholder",
      clientMessageId: "client-placeholder",
      correlationId: "event-123",
      authMode: "user",
      createdAt: "2026-07-04T00:00:00Z",
      editable: true,
      allowedUpdateMasks: ["text", "cardsV2", "accessoryWidgets"],
    });
    expect(plan.placeholder).toMatchObject({
      textSelection: {
        text: "Checking recent context...",
        mode: "roundRobin",
        index: 1,
        nextCursor: 2,
        source: "placeholderConfigJson",
      },
    });
  });

  it("plans placeholder completion as a patch only and makes fallback explicit", () => {
    const handle = {
      kind: "chat.placeholder_response_handle",
      space: "spaces/AAA",
      messageName: "spaces/AAA/messages/placeholder",
      threadName: "spaces/AAA/threads/T1",
      threadKey: null,
      requestId: "req-placeholder",
      clientMessageId: "client-placeholder",
      correlationId: "event-123",
      authMode: "app",
      createdAt: "2026-07-04T00:00:00Z",
      editable: true,
      allowedUpdateMasks: ["text", "cardsV2", "accessoryWidgets"],
    };

    const plan = planCompletePlaceholderResponse({
      handle,
      text: "Final answer",
      onPatchFailure: "createNewMessage",
      fallbackRequestId: "req-fallback",
      fallbackClientMessageId: "client-fallback",
    });

    expect(plan.requests).toEqual([
      {
        resource: "spaces.messages.patch",
        method: "PATCH",
        path: "/v1/spaces/AAA/messages/placeholder",
        query: { updateMask: "text" },
        body: { text: "Final answer" },
      },
    ]);
    expect(plan.placeholder).toMatchObject({
      strategy: "edit-placeholder",
      state: "complete",
      updateMask: "text",
      fallback: {
        onPatchFailure: "createNewMessage",
        request: {
          resource: "spaces.messages.create",
          method: "POST",
          path: "/v1/spaces/AAA/messages",
          query: {
            requestId: "req-fallback",
            messageId: "client-fallback",
            messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
          },
          body: {
            text: "Final answer",
            thread: { name: "spaces/AAA/threads/T1" },
          },
        },
      },
    });
  });

  it("refuses to complete placeholder handles that are not editable", () => {
    expect(() =>
      planCompletePlaceholderResponse({
        handle: {
          kind: "chat.placeholder_response_handle",
          space: "spaces/AAA",
          messageName: null,
          editable: false,
        },
        text: "Final answer",
      }),
    ).toThrow(/editable placeholder response handle/);
  });

  it("refuses ambiguous placeholder thread targets", () => {
    expect(() =>
      planPlaceholderResponse({
        space: "spaces/AAA",
        thread: "spaces/AAA/threads/T1",
        threadKey: "same-turn",
      }),
    ).toThrow(/only one of thread or threadKey/);
  });

  it("refuses placeholder completions outside the handle update mask", () => {
    expect(() =>
      planCompletePlaceholderResponse({
        handle: {
          kind: "chat.placeholder_response_handle",
          space: "spaces/AAA",
          messageName: "spaces/AAA/messages/placeholder",
          threadName: null,
          threadKey: null,
          requestId: "req-placeholder",
          clientMessageId: "client-placeholder",
          correlationId: "event-123",
          authMode: "app",
          createdAt: "2026-07-04T00:00:00Z",
          editable: true,
          allowedUpdateMasks: ["text"],
        },
        cardsV2: [{ cardId: "blocked" }],
      }),
    ).toThrow(/does not allow updating cardsV2/);
  });

  it("buffers placeholder completion into patches without creating a second message", () => {
    const plan = planBufferedPlaceholderCompletion({
      handle: {
        kind: "chat.placeholder_response_handle",
        space: "spaces/AAA",
        messageName: "spaces/AAA/messages/placeholder",
        threadName: "spaces/AAA/threads/T1",
        threadKey: null,
        requestId: "req-placeholder",
        clientMessageId: "client-placeholder",
        correlationId: "event-123",
        authMode: "app",
        createdAt: "2026-07-04T00:00:00Z",
        editable: true,
        allowedUpdateMasks: ["text", "cardsV2", "accessoryWidgets"],
      },
      chunks: ["One. ", "Two. ", "Three."],
      maxPatches: 2,
      minPatchChars: 1,
      throttleMs: 250,
    });

    expect(plan.operation).toBe("messages.placeholder.bufferedComplete");
    expect(plan.requests).toHaveLength(2);
    expect(plan.requests.every((request) => request.method === "PATCH")).toBe(true);
    expect(plan.requests.every((request) => request.resource === "spaces.messages.patch")).toBe(
      true,
    );
    expect(plan.streaming).toMatchObject({
      strategy: "edit-placeholder-buffered",
      patchCount: 2,
      buffering: {
        patchCount: 2,
        finalText: "One. Two. Three.",
      },
    });
  });

  it("plans async placeholder handoff and enqueues the queue-safe task locally", () => {
    const plan = planAsyncResponse({
      space: "spaces/AAA",
      thread: "spaces/AAA/threads/T1",
      eventId: "event-123",
      correlationId: "event-123",
      authMode: "app",
      expectedWorkMs: 45_000,
      receivedAt: "2026-07-04T00:00:00.000Z",
      now: "2026-07-04T00:00:03.000Z",
      respondWithPlaceholder: true,
      placeholderText: "Thinking...",
      requestId: "req-async-placeholder",
      clientMessageId: "client-async-placeholder",
      createdMessage: {
        name: "spaces/AAA/messages/placeholder",
        createTime: "2026-07-04T00:00:03.500Z",
        thread: { name: "spaces/AAA/threads/T1" },
      },
      queue: {
        adapter: "cloudTasks",
        target: "projects/p/locations/us-central1/queues/chat-ai",
      },
      payloadRef: "gs://chat-ai-sdk/tasks/event-123.json",
    });

    expect(plan).toMatchObject({
      kind: "chat.async_response_plan",
      status: "defer",
      strategy: "placeholder_then_queue",
      deadline: {
        syncDeadlineMs: 30000,
        safetyMarginMs: 5000,
        elapsedMs: 3000,
        remainingMs: 27000,
        workBudgetMs: 22000,
        expectedWorkMs: 45000,
        shouldDefer: true,
      },
      idempotency: {
        idempotencyKey: "chat-event:event-123",
        duplicateStrategy: "guard_before_placeholder",
        replaySafe: true,
      },
      replyHandle: {
        messageName: "spaces/AAA/messages/placeholder",
        editable: true,
      },
      queue: {
        adapter: "cloudTasks",
        target: "projects/p/locations/us-central1/queues/chat-ai",
        status: "planned",
        task: {
          kind: "chat.async_response_task",
          taskId: "task-event-123",
          payloadRef: "gs://chat-ai-sdk/tasks/event-123.json",
          finalDelivery: {
            strategy: "edit_placeholder",
            successOperation: "messages.placeholder.complete",
            errorOperation: "messages.placeholder.complete",
          },
        },
      },
    });
    expect(plan.placeholderPlan.requests).toHaveLength(1);
    expect(plan.queue.task.replyHandle).toEqual(plan.replyHandle);

    const queue = new InMemoryAsyncResponseQueue();
    expect(queue.enqueue(plan.queue.task)).toMatchObject({
      kind: "chat.async_queue_enqueue_result",
      status: "enqueued",
      depth: 1,
      taskId: "task-event-123",
    });
    expect(queue.dequeue()).toEqual(plan.queue.task);
    expect(queue.dequeue()).toBeNull();
  });

  it("pipes event reply routing through async placeholder and queue metadata", () => {
    const plan = planAsyncResponse({
      event: {
        kind: "message.mentioned_app",
        space: { name: "spaces/AAA", type: "ROOM" },
        message: {
          ref: { name: "spaces/AAA/messages/ROOT" },
          state: { threadReply: false, directMessage: false },
        },
      },
      eventId: "event-root",
      correlationId: "event-root",
      expectedWorkMs: 45_000,
      receivedAt: "2026-07-04T00:00:00.000Z",
      now: "2026-07-04T00:00:03.000Z",
      respondWithPlaceholder: true,
      placeholderText: "Thinking...",
      requestId: "req-async-route",
      clientMessageId: "client-async-route",
      createdMessage: {
        name: "spaces/AAA/messages/placeholder",
        createTime: "2026-07-04T00:00:03.500Z",
        thread: { name: "spaces/AAA/threads/generated" },
      },
      queue: {
        adapter: "cloudTasks",
        target: "projects/p/locations/us-central1/queues/chat-ai",
      },
      payloadRef: "gs://chat-ai-sdk/tasks/event-root.json",
    });

    expect(plan.replyTarget).toMatchObject({
      route: "thread",
      threadKey: "chat-ai-sdk-reply-spaces-aaa-messages-root",
      reason: "room_top_level_thread_key",
    });
    expect(plan.placeholderPlan.requests[0]).toMatchObject({
      path: "/v1/spaces/AAA/messages",
      body: {
        thread: {
          threadKey: "chat-ai-sdk-reply-spaces-aaa-messages-root",
        },
      },
    });
    expect(plan.replyHandle).toMatchObject({
      threadName: "spaces/AAA/threads/generated",
      threadKey: "chat-ai-sdk-reply-spaces-aaa-messages-root",
      replyTarget: {
        route: "thread",
        threadKey: "chat-ai-sdk-reply-spaces-aaa-messages-root",
      },
    });
    expect(plan.queue.task).toMatchObject({
      space: "spaces/AAA",
      replyTarget: {
        route: "thread",
        threadKey: "chat-ai-sdk-reply-spaces-aaa-messages-root",
      },
      replyHandle: {
        replyTarget: {
          route: "thread",
        },
      },
    });
    expect(plan.systemNotes).toContain(
      "System Note: Reply routing selected a thread reply target.",
    );
  });

  it("chooses sync or queue-only async mode when placeholders are disabled", () => {
    expect(
      planAsyncResponse({
        space: "spaces/AAA",
        eventId: "event-fast",
        expectedWorkMs: 1000,
        respondWithPlaceholder: false,
        receivedAt: "2026-07-04T00:00:00.000Z",
        now: "2026-07-04T00:00:01.000Z",
      }),
    ).toMatchObject({
      status: "sync",
      strategy: "sync_response",
      placeholderPlan: null,
      queue: null,
    });

    expect(
      planAsyncResponse({
        space: "spaces/AAA",
        eventId: "event-slow",
        expectedWorkMs: 45_000,
        respondWithPlaceholder: false,
        receivedAt: "2026-07-04T00:00:00.000Z",
        now: "2026-07-04T00:00:03.000Z",
        payloadRef: "gs://chat-ai-sdk/tasks/event-slow.json",
      }),
    ).toMatchObject({
      status: "defer",
      strategy: "queue_only",
      placeholderPlan: null,
      replyHandle: null,
      queue: {
        adapter: "localMemory",
        task: {
          taskId: "task-event-slow",
          finalDelivery: {
            strategy: "create_message",
            successOperation: "messages.sendToSpace",
          },
        },
      },
    });
  });

  it("uses reply-to-event final delivery for queue-only async work with a reply target", () => {
    const plan = planAsyncResponse({
      event: {
        kind: "message.thread_reply",
        space: { name: "spaces/AAA", type: "ROOM" },
        message: {
          thread: { name: "spaces/AAA/threads/T1" },
          state: { threadReply: true, directMessage: false },
        },
      },
      eventId: "event-thread",
      expectedWorkMs: 45_000,
      respondWithPlaceholder: false,
      receivedAt: "2026-07-04T00:00:00.000Z",
      now: "2026-07-04T00:00:03.000Z",
      payloadRef: "gs://chat-ai-sdk/tasks/event-thread.json",
    });

    expect(plan).toMatchObject({
      status: "defer",
      strategy: "queue_only",
      replyTarget: {
        route: "thread",
        threadName: "spaces/AAA/threads/T1",
      },
      queue: {
        task: {
          space: "spaces/AAA",
          replyTarget: {
            route: "thread",
            threadName: "spaces/AAA/threads/T1",
          },
          finalDelivery: {
            strategy: "create_reply_to_event",
            successOperation: "messages.replyToEvent",
            errorOperation: "messages.replyToEvent",
          },
        },
      },
      completion: {
        successOperation: "messages.replyToEvent",
        errorOperation: "messages.replyToEvent",
        finalDeliveryStrategy: "create_reply_to_event",
      },
    });
  });
});

describe("thread and space context readers", () => {
  const cases = readJson<
    Array<{
      id: string;
      operation: string;
      input: Record<string, unknown>;
      apiResponses: Array<{ fixture: string }>;
      expect: { plan: unknown; context: unknown };
    }>
  >("conformance/cases/messages.context.json");

  for (const testCase of cases) {
    it(`matches conformance case ${testCase.id}`, () => {
      const responses = testCase.apiResponses.map((response) => readJson(response.fixture));
      const plan =
        testCase.operation === "threads.readContext"
          ? planReadThreadContext(testCase.input)
          : planReadSpaceContext(testCase.input);

      expect(plan).toEqual(testCase.expect.plan);
      expect(buildConversationContext(testCase.input, responses)).toEqual(
        testCase.expect.context,
      );
    });
  }

  it("bounds deeply nested quoted context without recursive traversal", () => {
    let message: Record<string, unknown> = {
      plainTextForModel: "leaf",
      attachments: [],
      quotedMessages: [],
    };
    for (let index = 0; index < 1_100; index += 1) {
      message = {
        plainTextForModel: `quote-${index}`,
        attachments: [],
        quotedMessages: [message],
      };
    }

    const projected = projectModelContext(
      { kind: "chat.context", messages: [message] },
      { maxQuoteDepth: 8 },
    );
    const projection = projected.projection as Record<string, unknown>;
    const fragments = projected.fragments as unknown[];

    expect(projection.quoteDepthLimited).toBe(true);
    expect(fragments).toHaveLength(10); // policy plus root and eight quotes
  });

  it("trims model context by estimated token budget while preserving requested order", () => {
    const input = {
      space: "spaces/AAA",
      authMode: "user",
      limit: 5,
      pageSize: 5,
      order: "desc",
      maxContextTokens: 45,
      reserveOutputTokens: 5,
      charsPerToken: 10,
    };
    const responses = [
      readJson<Record<string, unknown>>(
        "fixtures/api-responses/messages/context-budget-page.json",
      ),
    ];
    const plan = planReadSpaceContext(input);
    const context = buildConversationContext(input, responses);
    const budget = context.modelTokenBudget as Record<string, number | boolean>;
    const messages = context.messages as Array<{ ref: { name: string } }>;

    expect(plan.reader).toMatchObject({
      modelTokenBudget: {
        maxTokens: 45,
        reserveOutputTokens: 5,
        availableTokens: 40,
        strategy: "preserve_order",
        estimator: {
          strategy: "chars_per_token",
          charsPerToken: 10,
        },
      },
    });
    expect(budget).toMatchObject({
      maxTokens: 45,
      reserveOutputTokens: 5,
      availableTokens: 40,
      includedMessages: context.returnedMessages,
      truncated: true,
    });
    expect(budget.estimatedTokensAfter as number).toBeLessThanOrEqual(40);
    expect(budget.estimatedTokensBefore as number).toBeGreaterThan(
      budget.estimatedTokensAfter as number,
    );
    expect(budget.droppedMessages as number).toBeGreaterThan(0);
    expect(context.partial).toBe(true);
    expect(context.truncated).toBe(true);
    expect(context.systemNotes).toContain(
      "System Note: 3 message(s) were omitted to fit the model context budget of 40 estimated tokens.",
    );
    expect(messages.map((message) => message.ref.name)).toEqual([
      "spaces/AAA/messages/budget-5",
      "spaces/AAA/messages/budget-4",
    ]);
  });

  it("renders custom emoji annotations as AI-facing context notes", () => {
    const context = buildConversationContext(
      {
        space: "spaces/AAA",
        authMode: "user",
        limit: 1,
        pageSize: 1,
        order: "asc",
      },
      [
        {
          messages: [
            {
              name: "spaces/AAA/messages/custom-emoji",
              text: "ship it :party_blob:",
              createTime: "2026-07-03T15:00:00Z",
              sender: {
                name: "users/ada",
                displayName: "Ada Lovelace",
                email: "ada@example.com",
                type: "HUMAN",
              },
              annotations: [
                {
                  type: "CUSTOM_EMOJI",
                  startIndex: 8,
                  length: 12,
                  customEmojiMetadata: {
                    customEmoji: {
                      name: "customEmojis/party_blob",
                      emojiName: ":party_blob:",
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    );

    expect(context.messages?.[0]?.systemNotes).toContain(
      "System Note: Custom emoji :party_blob: (customEmojis/party_blob) appears in this message.",
    );
  });

  it("enriches context sender identities from the directory cache recursively", async () => {
    const cache = new InMemoryIdentityCache();
    await syncDirectoryUsersToCache(
      [
        {
          id: "ada",
          primaryEmail: "ada@example.com",
          name: { fullName: "Ada Lovelace" },
        },
        {
          id: "grace",
          primaryEmail: "grace@example.com",
          name: { fullName: "Grace Hopper" },
        },
      ],
      { cache, nowMs: 1_782_930_000_000 },
    );
    await syncDirectoryUsersToCache(
      [
        {
          id: "ada",
          primaryEmail: "ada@example.com",
          name: { fullName: "Ada Lovelace" },
        },
      ],
      { cache, nowMs: 1_782_933_600_000, markMissingStale: true },
    );

    const context = await buildConversationContextWithIdentity(
      {
        space: "spaces/AAA",
        authMode: "user",
        limit: 1,
        pageSize: 1,
        order: "asc",
        maxQuoteDepth: 2,
      },
      [
        {
          messages: [
            {
              name: "spaces/AAA/messages/root",
              text: "See quoted message",
              createTime: "2026-07-03T15:00:00Z",
              sender: {
                name: "users/ada",
                displayName: "users/ada",
                type: "HUMAN",
              },
              quotedMessages: [
                {
                  name: "spaces/AAA/messages/quote",
                  text: "Older context",
                  createTime: "2026-07-02T12:00:00Z",
                  sender: {
                    name: "users/grace",
                    displayName: "users/grace",
                    type: "HUMAN",
                  },
                },
              ],
            },
          ],
        },
      ],
      { identityCache: cache },
    );

    const [message] = context.messages as Array<Record<string, unknown>>;
    const sender = message.sender as Record<string, unknown>;
    const quoted = (message.quotedMessages as Array<Record<string, unknown>>)[0]!;
    const quotedSender = quoted.sender as Record<string, unknown>;

    expect(sender).toMatchObject({
      name: "users/ada",
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      directoryStatus: "active",
      source: "directory_cache",
      stale: false,
    });
    expect(message.systemNotes).toContain(
      "System Note: The sender is Ada Lovelace <ada@example.com>.",
    );
    expect(quotedSender).toMatchObject({
      name: "users/grace",
      displayName: "Grace Hopper",
      email: "grace@example.com",
      directoryStatus: "stale",
      source: "directory_cache",
      stale: true,
    });
    expect(quoted.systemNotes).toContain(
      "System Note: The sender is Grace Hopper <grace@example.com>. This directory record is stale and may be out of date.",
    );
  });

  it("keeps context handling available when identity enrichment fails", async () => {
    const failingCache = {
      async getById() {
        throw new Error("cache unavailable");
      },
      async getByEmail() {
        throw new Error("cache unavailable");
      },
      async list() {
        return [];
      },
      async putMany() {},
    };

    const context = await buildConversationContextWithIdentity(
      {
        space: "spaces/AAA",
        authMode: "user",
        limit: 1,
        pageSize: 1,
      },
      [
        {
          messages: [
            {
              name: "spaces/AAA/messages/root",
              text: "hello",
              createTime: "2026-07-03T15:00:00Z",
              sender: {
                name: "users/ada",
                displayName: "users/ada",
                type: "HUMAN",
              },
            },
          ],
        },
      ],
      { identityCache: failingCache },
    );

    expect((context.messages as Array<Record<string, unknown>>)[0]?.sender).toMatchObject({
      name: "users/ada",
      displayName: "users/ada",
    });
    expect(context.systemNotes).toContain(
      "System Note: Identity enrichment was skipped because the identity cache was unavailable.",
    );
  });
});

describe("docs-listed message planners", () => {
  it("plans message search with clamped page size and docs-listed warning", () => {
    const plan = planSearchMessages({
      space: "spaces/AAA",
      query: "hello",
      pageSize: 5000,
    });
    expect(plan.requests[0]?.query.pageSize).toBe(1000);
    expect(plan.requests[0]?.path).toBe("/v1/spaces/AAA/messages:search");
    expect(plan.warnings[0]).toContain("docs-listed");
  });

  it("rejects searches without a query", () => {
    expect(() => planSearchMessages({ space: "spaces/AAA" } as never)).toThrow(
      /query/,
    );
  });

  it("plans replaceCards and rejects empty card lists", () => {
    const plan = planReplaceCards({
      message: "spaces/AAA/messages/BBB",
      cardsV2: [{ cardId: "x", card: {} }],
    });
    expect(plan.requests[0]?.path).toBe(
      "/v1/spaces/AAA/messages/BBB:replaceCards",
    );
    expect(() =>
      planReplaceCards({ message: "spaces/AAA/messages/BBB", cardsV2: [] }),
    ).toThrow(/at least one card/);
  });
});
