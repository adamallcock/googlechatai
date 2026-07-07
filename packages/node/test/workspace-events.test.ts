import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  FileWorkspaceEventsCheckpointStore,
  InMemoryWorkspaceEventsCheckpointStore,
  normalizeEvent,
  parsePubSubPullPayload,
  parsePubSubPushPayload,
  parseWorkspaceChatResourceEvent,
} from "../src/index.js";

const root = path.resolve(import.meta.dirname, "../../..");

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

describe("workspace events", () => {
  it("normalizes a Workspace Events Chat resource event through the shared envelope", () => {
    const raw = readJson("fixtures/workspace-events/chat-message-created.event.json");
    const expected = readJson(
      "fixtures/expected/workspace-events/chat-message-created.normalized.json",
    );

    const parsed = parseWorkspaceChatResourceEvent(raw);

    expect(parsed.event).toEqual(expected);
    expect(parsed.rawWorkspaceEvent).toEqual(raw);
  });

  it("normalizes access-limited Workspace Events resources without inventing message data", () => {
    const raw = readJson(
      "fixtures/workspace-events/chat-message-deleted.access-limited.event.json",
    );
    const expected = readJson(
      "fixtures/expected/workspace-events/chat-message-deleted.access-limited.normalized.json",
    );

    expect(parseWorkspaceChatResourceEvent(raw).event).toEqual(expected);
    expect(normalizeEvent(raw)).toMatchObject({
      eventId: "workspace_events:workspace-events-chat-message-deleted-access-limited-1",
      kind: "message.deleted",
      message: null,
      transport: {
        workspaceEventId: "workspace-events-chat-message-deleted-access-limited-1",
      },
    });
  });

  it("normalizes a Pub/Sub push payload carrying a Workspace Events Chat resource event", () => {
    const raw = readJson("fixtures/workspace-events/pubsub-push-chat-message-created.json");
    const expected = readJson(
      "fixtures/expected/workspace-events/pubsub-push-chat-message-created.normalized.json",
    );

    const parsed = parsePubSubPushPayload(raw);

    expect(parsed.event).toEqual(expected);
    expect(normalizeEvent(raw)).toMatchObject({
      eventId: "workspace_events:workspace-events-chat-message-created-1",
      source: "workspace_events",
      kind: "message.created",
      transport: {
        pubsubMessageId: "pubsub-message-1",
        workspaceEventId: "workspace-events-chat-message-created-1",
      },
    });
    expect(parsed.rawPubSubPayload).toEqual(raw);
    expect(parsed.rawWorkspaceEvent).toEqual(
      readJson("fixtures/workspace-events/chat-message-created.event.json"),
    );
  });

  it("normalizes Pub/Sub pull payloads and preserves checkpoint cursors", async () => {
    const raw = readJson("fixtures/workspace-events/pubsub-pull-chat-message-created.json");
    const expected = readJson(
      "fixtures/expected/workspace-events/pubsub-pull-chat-message-created.normalized.json",
    );

    const parsed = parsePubSubPullPayload(raw, {
      subscription:
        "projects/chat-ai-sdk/subscriptions/chat-ai-sdk-workspace-events-dev-pull",
    });

    expect(parsed.map((item) => item.event)).toEqual(expected);
    expect(parsed[0]?.event.pubSub?.checkpoint.ackId).toBe(
      "ack-workspace-events-chat-message-created-1",
    );

    const store = new InMemoryWorkspaceEventsCheckpointStore();
    await store.save("dev-subscription", parsed[0]!.event.pubSub!.checkpoint);

    await expect(store.load("dev-subscription")).resolves.toEqual(
      parsed[0]!.event.pubSub!.checkpoint,
    );

    const checkpointPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "googlechatai-w11-")),
      "checkpoints.json",
    );
    const fileStore = new FileWorkspaceEventsCheckpointStore(checkpointPath);
    await fileStore.save("dev-subscription", parsed[0]!.event.pubSub!.checkpoint);

    const reloadedStore = new FileWorkspaceEventsCheckpointStore(checkpointPath);
    await expect(reloadedStore.load("dev-subscription")).resolves.toEqual(
      parsed[0]!.event.pubSub!.checkpoint,
    );
  });
});
