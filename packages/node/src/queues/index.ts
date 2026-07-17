import fs from "node:fs/promises";

import type { AccessTokenLease, GetAccessTokenInput } from "../transport/index.js";
import { withFileStateLock, writeFileAtomically } from "../internal/file-state.js";

type JsonObject = Record<string, unknown>;

export interface AsyncQueueEnqueueResult {
  kind: "chat.async_queue_enqueue_result";
  status: string;
  depth: number | null;
  taskId: string;
  remoteName?: string;
}

/**
 * Promise-returning counterpart to messages/index.ts's synchronous
 * InMemoryAsyncResponseQueue. That in-memory queue is unchanged and remains
 * synchronous; this interface exists for adapters (file-backed, Cloud
 * Tasks, Pub/Sub) whose enqueue/dequeue/list/drain operations require I/O
 * and therefore return Promises.
 */
export interface AsyncResponseQueue {
  enqueue(task: JsonObject): Promise<AsyncQueueEnqueueResult>;
  dequeue(): Promise<JsonObject | null>;
  list(): Promise<JsonObject[]>;
  drain(limit?: number): Promise<JsonObject[]>;
}

export interface FileAsyncResponseQueueOptions {
  filePath: string;
}

export interface CloudTasksQueueAdapterOptions {
  queuePath: string;
  targetUrl: string;
  fetch: (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
    },
  ) => Promise<Response>;
  getAccessToken: (input: GetAccessTokenInput) => Promise<AccessTokenLease>;
  baseUrl?: string;
  serviceAccountEmail?: string;
}

export interface PubSubQueueAdapterOptions {
  topic: string;
  fetch: (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
    },
  ) => Promise<Response>;
  getAccessToken: (input: GetAccessTokenInput) => Promise<AccessTokenLease>;
  baseUrl?: string;
}

interface SerializedAsyncQueueFile {
  version: 1;
  tasks: JsonObject[];
}

const DEFAULT_CLOUD_TASKS_BASE_URL = "https://cloudtasks.googleapis.com";
const DEFAULT_PUBSUB_BASE_URL = "https://pubsub.googleapis.com";
const PULL_NOT_SUPPORTED_MESSAGE =
  "Cloud Tasks delivers tasks by push; dequeue is not supported.";

function requiredNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(message);
  }
  return value;
}

function requiredTaskId(task: JsonObject): string {
  const taskId = task?.taskId;
  if (typeof taskId !== "string" || taskId.trim() === "") {
    throw new TypeError("Expected task.taskId to be a non-empty string.");
  }
  return taskId;
}

function bytesToBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

async function parseJsonBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function trimTrailingSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export class FileAsyncResponseQueue implements AsyncResponseQueue {
  readonly #filePath: string;

  constructor(options: FileAsyncResponseQueueOptions) {
    if (!options?.filePath) {
      throw new TypeError("FileAsyncResponseQueue requires filePath.");
    }
    this.#filePath = options.filePath;
  }

  async enqueue(task: JsonObject): Promise<AsyncQueueEnqueueResult> {
    const taskId = requiredTaskId(task);
    return withFileStateLock(this.#filePath, async () => {
      const tasks = await this.#readTasks();
      tasks.push(task);
      await this.#writeTasks(tasks);
      return {
        kind: "chat.async_queue_enqueue_result",
        status: "enqueued",
        depth: tasks.length,
        taskId,
      };
    });
  }

  async dequeue(): Promise<JsonObject | null> {
    return withFileStateLock(this.#filePath, async () => {
      const tasks = await this.#readTasks();
      const next = tasks.shift();
      if (next === undefined) {
        return null;
      }
      await this.#writeTasks(tasks);
      return next;
    });
  }

  async list(): Promise<JsonObject[]> {
    return this.#readTasks();
  }

  async drain(limit?: number): Promise<JsonObject[]> {
    return withFileStateLock(this.#filePath, async () => {
      const tasks = await this.#readTasks();
      const count = limit === undefined ? tasks.length : Math.max(0, Math.floor(limit));
      const drained = tasks.splice(0, count);
      await this.#writeTasks(tasks);
      return drained;
    });
  }

  async #readTasks(): Promise<JsonObject[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.#filePath, "utf8")) as
        | SerializedAsyncQueueFile
        | undefined;
      return [...(parsed?.tasks ?? [])];
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }
  }

  async #writeTasks(tasks: JsonObject[]): Promise<void> {
    const payload: SerializedAsyncQueueFile = { version: 1, tasks };
    await writeFileAtomically(
      this.#filePath,
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  }
}

export class CloudTasksQueueAdapter implements AsyncResponseQueue {
  readonly #queuePath: string;
  readonly #targetUrl: string;
  readonly #fetch: CloudTasksQueueAdapterOptions["fetch"];
  readonly #getAccessToken: CloudTasksQueueAdapterOptions["getAccessToken"];
  readonly #baseUrl: string;
  readonly #serviceAccountEmail?: string;

  constructor(options: CloudTasksQueueAdapterOptions) {
    if (!options?.queuePath) {
      throw new TypeError("CloudTasksQueueAdapter requires queuePath.");
    }
    if (!options.targetUrl) {
      throw new TypeError("CloudTasksQueueAdapter requires targetUrl.");
    }
    if (typeof options.fetch !== "function") {
      throw new TypeError("CloudTasksQueueAdapter requires an injected fetch function.");
    }
    if (typeof options.getAccessToken !== "function") {
      throw new TypeError("CloudTasksQueueAdapter requires an injected getAccessToken function.");
    }
    this.#queuePath = options.queuePath;
    this.#targetUrl = options.targetUrl;
    this.#fetch = options.fetch;
    this.#getAccessToken = options.getAccessToken;
    this.#baseUrl = trimTrailingSlash(options.baseUrl ?? DEFAULT_CLOUD_TASKS_BASE_URL);
    this.#serviceAccountEmail = options.serviceAccountEmail;
  }

  async enqueue(task: JsonObject): Promise<AsyncQueueEnqueueResult> {
    const taskId = requiredTaskId(task);
    const lease = await this.#getAccessToken({ forceRefresh: false });
    const url = `${this.#baseUrl}/v2/${this.#queuePath}/tasks`;
    const httpRequest: JsonObject = {
      httpMethod: "POST",
      url: this.#targetUrl,
      headers: { "content-type": "application/json" },
      body: bytesToBase64(JSON.stringify(task)),
      ...(this.#serviceAccountEmail
        ? { oidcToken: { serviceAccountEmail: this.#serviceAccountEmail } }
        : {}),
    };
    const response = await this.#fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `${lease.tokenType ?? "Bearer"} ${lease.accessToken}`,
      },
      body: JSON.stringify({ task: { httpRequest } }),
    });

    if (!response.ok) {
      throw new Error(`Cloud Tasks POST ${response.status} for ${this.#queuePath}`);
    }

    const body = await parseJsonBody(response);
    return {
      kind: "chat.async_queue_enqueue_result",
      status: "enqueued",
      depth: null,
      taskId,
      remoteName: typeof body.name === "string" ? body.name : undefined,
    };
  }

  async dequeue(): Promise<JsonObject | null> {
    throw new Error(PULL_NOT_SUPPORTED_MESSAGE);
  }

  async list(): Promise<JsonObject[]> {
    throw new Error(PULL_NOT_SUPPORTED_MESSAGE);
  }

  async drain(): Promise<JsonObject[]> {
    throw new Error(PULL_NOT_SUPPORTED_MESSAGE);
  }
}

export class PubSubQueueAdapter implements AsyncResponseQueue {
  readonly #topic: string;
  readonly #fetch: PubSubQueueAdapterOptions["fetch"];
  readonly #getAccessToken: PubSubQueueAdapterOptions["getAccessToken"];
  readonly #baseUrl: string;

  constructor(options: PubSubQueueAdapterOptions) {
    if (!options?.topic) {
      throw new TypeError("PubSubQueueAdapter requires topic.");
    }
    if (typeof options.fetch !== "function") {
      throw new TypeError("PubSubQueueAdapter requires an injected fetch function.");
    }
    if (typeof options.getAccessToken !== "function") {
      throw new TypeError("PubSubQueueAdapter requires an injected getAccessToken function.");
    }
    this.#topic = options.topic;
    this.#fetch = options.fetch;
    this.#getAccessToken = options.getAccessToken;
    this.#baseUrl = trimTrailingSlash(options.baseUrl ?? DEFAULT_PUBSUB_BASE_URL);
  }

  async enqueue(task: JsonObject): Promise<AsyncQueueEnqueueResult> {
    const taskId = requiredTaskId(task);
    const lease = await this.#getAccessToken({ forceRefresh: false });
    const url = `${this.#baseUrl}/v1/${this.#topic}:publish`;
    const response = await this.#fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `${lease.tokenType ?? "Bearer"} ${lease.accessToken}`,
      },
      body: JSON.stringify({
        messages: [
          {
            data: bytesToBase64(JSON.stringify(task)),
            attributes: { taskId, kind: "chat.async_response_task" },
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Pub/Sub POST ${response.status} for ${this.#topic}`);
    }

    const body = await parseJsonBody(response);
    const messageIds = Array.isArray(body.messageIds) ? (body.messageIds as unknown[]) : [];
    const remoteName = typeof messageIds[0] === "string" ? (messageIds[0] as string) : undefined;
    return {
      kind: "chat.async_queue_enqueue_result",
      status: "enqueued",
      depth: null,
      taskId,
      remoteName,
    };
  }

  async dequeue(): Promise<JsonObject | null> {
    throw new Error(PULL_NOT_SUPPORTED_MESSAGE);
  }

  async list(): Promise<JsonObject[]> {
    throw new Error(PULL_NOT_SUPPORTED_MESSAGE);
  }

  async drain(): Promise<JsonObject[]> {
    throw new Error(PULL_NOT_SUPPORTED_MESSAGE);
  }
}
