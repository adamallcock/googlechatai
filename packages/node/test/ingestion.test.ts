import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  planChatIngestion,
  processPollingIngestionPage,
} from "../src/index.js";

const root = path.resolve(import.meta.dirname, "../../..");

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

describe("ingestion", () => {
  it("plans direct, Workspace Events push/pull, and polling ingestion modes", () => {
    expect(
      planChatIngestion({
        mode: "direct_interaction",
        endpointPath: "/api/chat/events",
      }),
    ).toMatchObject({
      kind: "chat.ingestion_plan",
      mode: "direct_interaction",
      delivery: {
        transport: "chat_http",
        endpointPath: "/api/chat/events",
      },
      capability: {
        authMode: "chat_interaction",
        requiredScopes: [],
        writeCapable: false,
      },
    });

    expect(
      planChatIngestion({
        mode: "workspace_events_push",
        authMode: "user",
        space: "spaces/AAA",
        pubsubTopic: "projects/p/topics/chat-events",
        pushEndpoint: "https://example.test/workspace-events",
        includeResource: true,
      }),
    ).toMatchObject({
      mode: "workspace_events_push",
      targetResource: "//chat.googleapis.com/spaces/AAA",
      delivery: {
        transport: "pubsub_push",
        endpoint: "https://example.test/workspace-events",
      },
      pubsub: {
        topic: "projects/p/topics/chat-events",
        publisherPrincipal: "serviceAccount:chat-api-push@system.gserviceaccount.com",
      },
      setupChecks: expect.arrayContaining([
        expect.objectContaining({ name: "pubsub_publisher_iam" }),
        expect.objectContaining({ name: "workspace_events_subscription" }),
      ]),
    });

    expect(
      planChatIngestion({
        mode: "workspace_events_pull",
        authMode: "app",
        space: "spaces/AAA",
        pubsubSubscription: "projects/p/subscriptions/chat-events",
      }),
    ).toMatchObject({
      mode: "workspace_events_pull",
      capability: {
        authMode: "app",
        requiresAdminApproval: true,
      },
      requests: expect.arrayContaining([
        expect.objectContaining({
          resource: "pubsub.subscriptions.pull",
          method: "POST",
        }),
      ]),
    });

    expect(
      planChatIngestion({
        mode: "polling",
        authMode: "user",
        space: "spaces/AAA",
        startTime: "2026-07-04T00:00:00Z",
        endTime: "2026-07-04T01:00:00Z",
        pageSize: 250,
        showDeleted: true,
        checkpoint: { pageToken: "cursor-1" },
      }),
    ).toMatchObject({
      mode: "polling",
      polling: {
        filter:
          'createTime > "2026-07-04T00:00:00Z" AND createTime < "2026-07-04T01:00:00Z"',
        orderBy: "createTime ASC",
      },
      requests: [
        {
          resource: "spaces.messages.list",
          method: "GET",
          path: "/v1/spaces/AAA/messages",
          query: {
            pageSize: 250,
            pageToken: "cursor-1",
            filter:
              'createTime > "2026-07-04T00:00:00Z" AND createTime < "2026-07-04T01:00:00Z"',
            orderBy: "createTime ASC",
            showDeleted: true,
          },
          body: null,
        },
      ],
    });
  });

  it("processes polling pages with cursors and duplicate snapshot signaling", () => {
    const response = readJson("fixtures/api-responses/messages/polling-ingestion-page.json");

    const batch = processPollingIngestionPage({
      space: "spaces/AAA",
      receivedAt: "2026-07-04T00:10:00.000Z",
      response,
      checkpoint: {
        seenKeys: ["polling:spaces/AAA/messages/old:2026-07-04T00:04:00Z"],
      },
    });

    expect(batch.kind).toBe("chat.ingestion_batch");
    expect(batch.events.map((item) => item.snapshot.kind)).toEqual([
      "created_snapshot",
      "updated_snapshot",
      "deleted_snapshot",
    ]);
    expect(batch.events[0]!.normalized).toMatchObject({
      kind: "message.thread_reply",
    });
    expect(batch.events[0]!.normalized.message?.plainTextForModel).toContain(
      "First passive message.",
    );
    expect(batch.events[1]!.normalized.message?.plainTextForModel).toEqual(
      expect.stringContaining("Edited passive message."),
    );
    expect(batch.events[2]!.snapshot).toMatchObject({
      skippedAsDuplicate: true,
      duplicateKey: "polling:spaces/AAA/messages/old:2026-07-04T00:04:00Z",
    });
    expect(batch.checkpoint).toMatchObject({
      type: "polling",
      scope: "spaces/AAA#messages",
      pageToken: "cursor-2",
      nextPageToken: "cursor-2",
      highWatermarkTime: "2026-07-04T00:05:00Z",
    });
    expect(batch.nextRequest?.requests[0]?.query).toMatchObject({
      pageToken: "cursor-2",
    });
  });
});
