import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { AccessTokenLease } from "../src/transport/index.js";
import {
  CloudTasksQueueAdapter,
  FileAsyncResponseQueue,
  PubSubQueueAdapter,
} from "../src/queues/index.js";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "queues-test-"));
}

function task(taskId: string): Record<string, unknown> {
  return {
    kind: "chat.async_response_task",
    taskId,
    eventId: null,
    space: "spaces/AAA",
    createdAt: "2026-07-06T12:00:00.000Z",
  };
}

describe("FileAsyncResponseQueue", () => {
  it("returns null/[] for a missing file without error", async () => {
    const dir = await makeTempDir();
    const queue = new FileAsyncResponseQueue({ filePath: path.join(dir, "queue.json") });

    expect(await queue.dequeue()).toBeNull();
    expect(await queue.list()).toEqual([]);
    expect(await queue.drain()).toEqual([]);
  });

  it("enqueues tasks and returns the documented enqueue result shape", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "queue.json");
    const queue = new FileAsyncResponseQueue({ filePath });

    const result = await queue.enqueue(task("task-1"));
    expect(result).toEqual({
      kind: "chat.async_queue_enqueue_result",
      status: "enqueued",
      depth: 1,
      taskId: "task-1",
    });

    const secondResult = await queue.enqueue(task("task-2"));
    expect(secondResult.depth).toBe(2);
  });

  it("persists across instances using the {version, tasks} JSON file discipline with atomic rename", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "queue.json");
    const queue = new FileAsyncResponseQueue({ filePath });

    await queue.enqueue(task("task-1"));
    await queue.enqueue(task("task-2"));

    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(raw).toEqual({ version: 1, tasks: [task("task-1"), task("task-2")] });

    const entries = await fs.readdir(dir);
    expect(entries).toEqual(["queue.json"]);

    const secondQueue = new FileAsyncResponseQueue({ filePath });
    expect(await secondQueue.list()).toEqual([task("task-1"), task("task-2")]);
  });

  it("serializes concurrent enqueues for one local queue file", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "queue.json");
    const queue = new FileAsyncResponseQueue({ filePath });

    await Promise.all(
      Array.from({ length: 12 }, (_, index) => queue.enqueue(task(`task-${index}`))),
    );

    expect((await queue.list()).map((entry) => entry.taskId).sort()).toEqual(
      Array.from({ length: 12 }, (_, index) => `task-${index}`).sort(),
    );
  });

  it("dequeues FIFO and supports drain with and without a limit", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "queue.json");
    const queue = new FileAsyncResponseQueue({ filePath });

    await queue.enqueue(task("task-1"));
    await queue.enqueue(task("task-2"));
    await queue.enqueue(task("task-3"));

    expect(await queue.dequeue()).toEqual(task("task-1"));
    expect(await queue.list()).toEqual([task("task-2"), task("task-3")]);

    const drainedOne = await queue.drain(1);
    expect(drainedOne).toEqual([task("task-2")]);
    expect(await queue.list()).toEqual([task("task-3")]);

    const drainedRest = await queue.drain();
    expect(drainedRest).toEqual([task("task-3")]);
    expect(await queue.list()).toEqual([]);
    expect(await queue.dequeue()).toBeNull();
  });

  it("throws TypeError when filePath is missing", () => {
    expect(() => new FileAsyncResponseQueue({ filePath: "" })).toThrow(TypeError);
  });

  it("throws TypeError for a task missing taskId", async () => {
    const dir = await makeTempDir();
    const queue = new FileAsyncResponseQueue({ filePath: path.join(dir, "queue.json") });
    await expect(queue.enqueue({ kind: "chat.async_response_task" })).rejects.toThrow(TypeError);
  });
});

interface CapturedRequest {
  url: string;
  method: string;
  authorization: string;
  body: string | undefined;
}

function makeFakeFetch(
  handler: (request: CapturedRequest) => Response,
): {
  fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => Promise<Response>;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<Response> => {
    const captured: CapturedRequest = {
      url,
      method: init.method,
      authorization: init.headers.authorization ?? "",
      body: init.body,
    };
    requests.push(captured);
    return handler(captured);
  };
  return { fetch: fetchImpl, requests };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fixedLease: AccessTokenLease = { accessToken: "lease-token-1", tokenType: "Bearer" };

describe("CloudTasksQueueAdapter", () => {
  it("enqueues via POST /v2/{queuePath}/tasks with base64-encoded body and returns the enqueue result", async () => {
    const { fetch, requests } = makeFakeFetch((request) => {
      expect(request.url).toBe(
        "https://cloudtasks.googleapis.com/v2/projects/my-project/locations/us-central1/queues/my-queue/tasks",
      );
      expect(request.method).toBe("POST");
      expect(request.authorization).toBe("Bearer lease-token-1");
      const body = JSON.parse(request.body ?? "{}");
      expect(body.task.httpRequest.httpMethod).toBe("POST");
      expect(body.task.httpRequest.url).toBe("https://example.com/tasks/handle");
      expect(body.task.httpRequest.headers).toEqual({ "content-type": "application/json" });
      const decoded = JSON.parse(
        Buffer.from(body.task.httpRequest.body, "base64").toString("utf8"),
      );
      expect(decoded).toEqual(task("task-1"));
      expect(body.task.httpRequest.oidcToken).toBeUndefined();
      return jsonResponse(200, {
        name: "projects/my-project/locations/us-central1/queues/my-queue/tasks/abc123",
      });
    });

    const adapter = new CloudTasksQueueAdapter({
      queuePath: "projects/my-project/locations/us-central1/queues/my-queue",
      targetUrl: "https://example.com/tasks/handle",
      fetch,
      getAccessToken: async () => fixedLease,
    });

    const result = await adapter.enqueue(task("task-1"));
    expect(result).toEqual({
      kind: "chat.async_queue_enqueue_result",
      status: "enqueued",
      depth: null,
      taskId: "task-1",
      remoteName: "projects/my-project/locations/us-central1/queues/my-queue/tasks/abc123",
    });
    expect(requests).toHaveLength(1);
  });

  it("includes oidcToken.serviceAccountEmail when serviceAccountEmail is provided", async () => {
    const { fetch } = makeFakeFetch((request) => {
      const body = JSON.parse(request.body ?? "{}");
      expect(body.task.httpRequest.oidcToken).toEqual({
        serviceAccountEmail: "chat-bot@my-project.iam.gserviceaccount.com",
      });
      return jsonResponse(200, { name: "tasks/abc123" });
    });

    const adapter = new CloudTasksQueueAdapter({
      queuePath: "projects/my-project/locations/us-central1/queues/my-queue",
      targetUrl: "https://example.com/tasks/handle",
      fetch,
      getAccessToken: async () => fixedLease,
      serviceAccountEmail: "chat-bot@my-project.iam.gserviceaccount.com",
    });

    await adapter.enqueue(task("task-1"));
  });

  it("throws on pull methods (dequeue/list/drain)", async () => {
    const adapter = new CloudTasksQueueAdapter({
      queuePath: "projects/my-project/locations/us-central1/queues/my-queue",
      targetUrl: "https://example.com/tasks/handle",
      fetch: async () => jsonResponse(200, {}),
      getAccessToken: async () => fixedLease,
    });

    await expect(adapter.dequeue()).rejects.toThrow(
      "Cloud Tasks delivers tasks by push; dequeue is not supported.",
    );
    await expect(adapter.list()).rejects.toThrow(
      "Cloud Tasks delivers tasks by push; dequeue is not supported.",
    );
    await expect(adapter.drain()).rejects.toThrow(
      "Cloud Tasks delivers tasks by push; dequeue is not supported.",
    );
  });

  it("throws Error with status and queuePath (no body contents) on non-OK response", async () => {
    const { fetch } = makeFakeFetch(() =>
      jsonResponse(500, { error: { message: "leaked internal detail" } }),
    );
    const adapter = new CloudTasksQueueAdapter({
      queuePath: "projects/my-project/locations/us-central1/queues/my-queue",
      targetUrl: "https://example.com/tasks/handle",
      fetch,
      getAccessToken: async () => fixedLease,
    });

    await expect(adapter.enqueue(task("task-1"))).rejects.toThrow(
      "Cloud Tasks POST 500 for projects/my-project/locations/us-central1/queues/my-queue",
    );
  });

  it("throws TypeError when fetch or getAccessToken are missing (never a global fetch default)", () => {
    expect(
      () =>
        new CloudTasksQueueAdapter({
          queuePath: "projects/my-project/locations/us-central1/queues/my-queue",
          targetUrl: "https://example.com/tasks/handle",
          // @ts-expect-error intentionally omitting fetch
          fetch: undefined,
          getAccessToken: async () => fixedLease,
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new CloudTasksQueueAdapter({
          queuePath: "projects/my-project/locations/us-central1/queues/my-queue",
          targetUrl: "https://example.com/tasks/handle",
          fetch: async () => jsonResponse(200, {}),
          // @ts-expect-error intentionally omitting getAccessToken
          getAccessToken: undefined,
        }),
    ).toThrow(TypeError);
  });
});

describe("PubSubQueueAdapter", () => {
  it("publishes to /v1/{topic}:publish with base64-encoded data and attributes, returning messageIds[0] as remoteName", async () => {
    const { fetch, requests } = makeFakeFetch((request) => {
      expect(request.url).toBe(
        "https://pubsub.googleapis.com/v1/projects/my-project/topics/my-topic:publish",
      );
      expect(request.method).toBe("POST");
      expect(request.authorization).toBe("Bearer lease-token-1");
      const body = JSON.parse(request.body ?? "{}");
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].attributes).toEqual({
        taskId: "task-1",
        kind: "chat.async_response_task",
      });
      const decoded = JSON.parse(Buffer.from(body.messages[0].data, "base64").toString("utf8"));
      expect(decoded).toEqual(task("task-1"));
      return jsonResponse(200, { messageIds: ["msg-123"] });
    });

    const adapter = new PubSubQueueAdapter({
      topic: "projects/my-project/topics/my-topic",
      fetch,
      getAccessToken: async () => fixedLease,
    });

    const result = await adapter.enqueue(task("task-1"));
    expect(result).toEqual({
      kind: "chat.async_queue_enqueue_result",
      status: "enqueued",
      depth: null,
      taskId: "task-1",
      remoteName: "msg-123",
    });
    expect(requests).toHaveLength(1);
  });

  it("throws on pull methods (dequeue/list/drain)", async () => {
    const adapter = new PubSubQueueAdapter({
      topic: "projects/my-project/topics/my-topic",
      fetch: async () => jsonResponse(200, { messageIds: ["msg-1"] }),
      getAccessToken: async () => fixedLease,
    });

    await expect(adapter.dequeue()).rejects.toThrow(
      "Cloud Tasks delivers tasks by push; dequeue is not supported.",
    );
    await expect(adapter.list()).rejects.toThrow(
      "Cloud Tasks delivers tasks by push; dequeue is not supported.",
    );
    await expect(adapter.drain()).rejects.toThrow(
      "Cloud Tasks delivers tasks by push; dequeue is not supported.",
    );
  });

  it("throws Error with status and topic (no body contents) on non-OK response", async () => {
    const { fetch } = makeFakeFetch(() =>
      jsonResponse(503, { error: { message: "leaked internal detail" } }),
    );
    const adapter = new PubSubQueueAdapter({
      topic: "projects/my-project/topics/my-topic",
      fetch,
      getAccessToken: async () => fixedLease,
    });

    await expect(adapter.enqueue(task("task-1"))).rejects.toThrow(
      "Pub/Sub POST 503 for projects/my-project/topics/my-topic",
    );
  });

  it("throws TypeError when fetch or getAccessToken are missing (never a global fetch default)", () => {
    expect(
      () =>
        new PubSubQueueAdapter({
          topic: "projects/my-project/topics/my-topic",
          // @ts-expect-error intentionally omitting fetch
          fetch: undefined,
          getAccessToken: async () => fixedLease,
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new PubSubQueueAdapter({
          topic: "projects/my-project/topics/my-topic",
          fetch: async () => jsonResponse(200, {}),
          // @ts-expect-error intentionally omitting getAccessToken
          getAccessToken: undefined,
        }),
    ).toThrow(TypeError);
  });
});
