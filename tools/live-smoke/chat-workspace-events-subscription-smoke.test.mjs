import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildWorkspaceEventsSubscriptionSmokePlan,
  loadWorkspaceEventsSubscriptionSmokeConfig,
  runWorkspaceEventsSubscriptionSmoke,
} from "./chat-workspace-events-subscription-smoke.mjs";

const SMOKE_SPACE_PREFIX = "Google Chat AI SDK Smoke";

async function writeMetadata(t, overrides = {}) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "chat-workspace-events-subscription-test-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "space.json");
  const metadata = {
    space: "spaces/AAAA-smoke",
    displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
    spaceType: "SPACE",
    safety: {
      dedicatedSmokeSpace: true,
      noDirectMessages: true,
      noRealUsersInvited: true,
    },
    ...overrides,
  };
  await fs.writeFile(file, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return file;
}

function smokeEnv(metadataPath, overrides = {}) {
  return {
    RUN_LIVE_WORKSPACE_EVENTS_SUBSCRIPTION_SMOKE: "1",
    GOOGLE_CLOUD_PROJECT: "unit-project",
    GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
    GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
    GOOGLE_CHAT_WORKSPACE_EVENTS_SUBSCRIPTION_RUN_ID: "workspace-events-test",
    GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS: "/tmp/oauth-client.json",
    GOOGLE_CHAT_USER_TOKEN_STORE: "/tmp/user-token.json",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/service-account.json",
    ...overrides,
  };
}

function fakePubSub() {
  const calls = [];
  return {
    calls,
    async createTopic(topic) {
      calls.push(["createTopic", topic]);
    },
    async createSubscription(subscription, topic) {
      calls.push(["createSubscription", subscription, topic]);
    },
    async addPublisher(topic, member) {
      calls.push(["addPublisher", topic, member]);
    },
    async pull(subscription) {
      calls.push(["pull", subscription]);
      return [
        {
          ackId: "ack-secret",
          message: {
            messageId: "pubsub-message-1",
            publishTime: "2026-07-02T12:00:05Z",
            attributes: {
              "ce-id": "workspace-event-1",
              "ce-source": "//workspaceevents.googleapis.com/subscriptions/sub-1",
              "ce-type": "google.workspace.chat.message.v1.created",
              "ce-subject": "//chat.googleapis.com/spaces/AAAA-smoke/messages/msg-1",
            },
            data: Buffer.from(
              JSON.stringify({
                message: { name: "spaces/AAAA-smoke/messages/msg-1" },
              }),
            ).toString("base64"),
          },
        },
      ];
    },
    async deleteSubscription(subscription) {
      calls.push(["deleteSubscription", subscription]);
    },
    async deleteTopic(topic) {
      calls.push(["deleteTopic", topic]);
    },
  };
}

function fakePubSubWithPublisherBlock() {
  const pubsub = fakePubSub();
  return {
    calls: pubsub.calls,
    async createTopic(topic) {
      return pubsub.createTopic(topic);
    },
    async createSubscription(subscription, topic) {
      return pubsub.createSubscription(subscription, topic);
    },
    async addPublisher(topic, member) {
      pubsub.calls.push(["addPublisher", topic, member]);
      const error = new Error(
        "FAILED_PRECONDITION: constraints/iam.allowedPolicyMemberDomains blocked chat-api-push@system.gserviceaccount.com",
      );
      error.status = 1;
      throw error;
    },
    async pull(subscription) {
      return pubsub.pull(subscription);
    },
    async deleteSubscription(subscription) {
      return pubsub.deleteSubscription(subscription);
    },
    async deleteTopic(topic) {
      return pubsub.deleteTopic(topic);
    },
  };
}

function fakeWorkspaceEventsClient({ createFails = false } = {}) {
  const calls = [];
  return {
    calls,
    async createSubscription(body, query) {
      calls.push(["createSubscription", body, query]);
      if (createFails) {
        const error = new Error("subscriptions.create failed with HTTP 403");
        error.name = "WorkspaceEventsApiError";
        error.operation = "workspaceEvents.subscriptions.create";
        error.status = 403;
        error.response = { error: { status: "PERMISSION_DENIED" } };
        throw error;
      }
      return query.validateOnly === "true"
        ? {
            name: "operations/validate-only",
            done: true,
            response: {},
          }
        : {
            name: "operations/create-subscription",
            done: true,
            response: { name: "subscriptions/sub-1" },
          };
    },
    async getOperation(name) {
      calls.push(["getOperation", name]);
      return { name, done: true, response: { name: "subscriptions/sub-1" } };
    },
    async deleteSubscription(name) {
      calls.push(["deleteSubscription", name]);
      return { name: "operations/delete-subscription", done: true };
    },
  };
}

function fakeChatClient() {
  const calls = [];
  return {
    calls,
    async createMessage(parent, body, query) {
      calls.push(["createMessage", parent, body, query]);
      return {
        name: `${parent}/messages/msg-1`,
        thread: { name: `${parent}/threads/thread-1` },
      };
    },
    async deleteMessage(name) {
      calls.push(["deleteMessage", name]);
      return {};
    },
  };
}

function fakeSdk() {
  return {
    parsePubSubPullPayload(items, { subscription }) {
      return items.map((item) => ({
        event: {
          eventId: item.message.attributes["ce-id"],
          source: "workspace-events",
          kind: "message.created",
          rawKind: item.message.attributes["ce-type"],
          workspaceEvent: {
            subject: item.message.attributes["ce-subject"],
            resourceName: "spaces/AAAA-smoke/messages/msg-1",
          },
          pubSub: {
            checkpoint: {
              subscription,
              messageId: item.message.messageId,
              publishTime: item.message.publishTime,
              ackId: item.ackId,
              orderingKey: "",
              deliveryAttempt: null,
            },
          },
        },
      }));
    },
  };
}

test("loadWorkspaceEventsSubscriptionSmokeConfig refuses live mode without explicit guard", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadWorkspaceEventsSubscriptionSmokeConfig({
        argv: ["node", "chat-workspace-events-subscription-smoke.mjs"],
        env: {
          GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
          GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
        },
      }),
    /RUN_LIVE_WORKSPACE_EVENTS_SUBSCRIPTION_SMOKE=1/,
  );
});

test("dry-run plan targets only the configured smoke space and does not include resource data", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadWorkspaceEventsSubscriptionSmokeConfig({
    argv: [
      "node",
      "chat-workspace-events-subscription-smoke.mjs",
      "--dry-run",
    ],
    env: smokeEnv(metadataPath),
  });
  const plan = buildWorkspaceEventsSubscriptionSmokePlan(config);

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.targetResource, "//chat.googleapis.com/spaces/AAAA-smoke");
  assert.equal(plan.payloadOptions.includeResource, false);
  assert.equal(plan.calls[0].operation, "pubsub.topics.create");
  assert.equal(plan.calls[3].operation, "workspaceEvents.subscriptions.create.validateOnly");
  assert.equal(plan.calls.some((call) => call.operation === "chat.messages.create"), false);
  assert.deepEqual(plan.requiredUserScopes, [
    "https://www.googleapis.com/auth/chat.messages.readonly",
  ]);
});

test("validate-only run creates temporary Pub/Sub resources and cleans them up", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadWorkspaceEventsSubscriptionSmokeConfig({
    argv: [
      "node",
      "chat-workspace-events-subscription-smoke.mjs",
      "--validate-only",
    ],
    env: smokeEnv(metadataPath),
  });
  const pubsub = fakePubSub();
  const workspaceEvents = fakeWorkspaceEventsClient();
  const result = await runWorkspaceEventsSubscriptionSmoke(config, {
    pubsub,
    workspaceEvents,
    chat: fakeChatClient(),
    sdk: fakeSdk(),
    writeEvidence: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.status, "validated");
  assert.equal(
    workspaceEvents.calls[0][2].validateOnly,
    "true",
  );
  assert.equal(
    pubsub.calls.some((call) => call[0] === "deleteSubscription"),
    true,
  );
  assert.equal(pubsub.calls.some((call) => call[0] === "deleteTopic"), true);
  assert.equal(JSON.stringify(result.evidence).includes("secret"), false);
});

test("live run creates a subscription, triggers one app message, pulls a matching event, and cleans up", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadWorkspaceEventsSubscriptionSmokeConfig({
    argv: ["node", "chat-workspace-events-subscription-smoke.mjs"],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_AI_ENABLE_LIVE_WORKSPACE_EVENTS_SUBSCRIPTION: "1",
    }),
  });
  const pubsub = fakePubSub();
  const workspaceEvents = fakeWorkspaceEventsClient();
  const chat = fakeChatClient();
  const result = await runWorkspaceEventsSubscriptionSmoke(config, {
    pubsub,
    workspaceEvents,
    chat,
    sdk: fakeSdk(),
    sleepMs: async () => {},
    writeEvidence: false,
  });
  const serialized = JSON.stringify(result.evidence);

  assert.equal(result.ok, true);
  assert.equal(result.evidence.status, "verified");
  assert.equal(result.evidence.subscription.nameAvailable, true);
  assert.equal(result.evidence.pubsub.matchFound, true);
  assert.equal(result.evidence.normalizedEvent.kind, "message.created");
  assert.equal(workspaceEvents.calls.some((call) => call[0] === "deleteSubscription"), true);
  assert.equal(chat.calls.some((call) => call[0] === "deleteMessage"), true);
  assert.equal(pubsub.calls.some((call) => call[0] === "deleteSubscription"), true);
  assert.equal(serialized.includes("Workspace Events subscription smoke"), false);
  assert.equal(serialized.includes("ack-secret"), false);
});

test("live run cleans temporary Pub/Sub resources when subscription creation is blocked", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadWorkspaceEventsSubscriptionSmokeConfig({
    argv: [
      "node",
      "chat-workspace-events-subscription-smoke.mjs",
      "--allow-blocked",
    ],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_AI_ENABLE_LIVE_WORKSPACE_EVENTS_SUBSCRIPTION: "1",
    }),
  });
  const pubsub = fakePubSub();
  const result = await runWorkspaceEventsSubscriptionSmoke(config, {
    pubsub,
    workspaceEvents: fakeWorkspaceEventsClient({ createFails: true }),
    chat: fakeChatClient(),
    sdk: fakeSdk(),
    writeEvidence: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.status, "blocked");
  assert.equal(
    result.evidence.blocked.apiReason,
    "PERMISSION_DENIED",
  );
  assert.equal(
    pubsub.calls.some((call) => call[0] === "deleteSubscription"),
    true,
  );
  assert.equal(pubsub.calls.some((call) => call[0] === "deleteTopic"), true);
});

test("allow-blocked classifies Workspace Events publisher IAM domain policy blockers", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadWorkspaceEventsSubscriptionSmokeConfig({
    argv: [
      "node",
      "chat-workspace-events-subscription-smoke.mjs",
      "--validate-only",
      "--allow-blocked",
    ],
    env: smokeEnv(metadataPath),
  });
  const pubsub = fakePubSubWithPublisherBlock();
  const result = await runWorkspaceEventsSubscriptionSmoke(config, {
    pubsub,
    workspaceEvents: fakeWorkspaceEventsClient(),
    chat: fakeChatClient(),
    sdk: fakeSdk(),
    writeEvidence: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.status, "blocked");
  assert.match(result.evidence.blocked.message, /allowedPolicyMemberDomains/);
  assert.equal(
    pubsub.calls.some((call) => call[0] === "deleteSubscription"),
    true,
  );
  assert.equal(pubsub.calls.some((call) => call[0] === "deleteTopic"), true);
});
