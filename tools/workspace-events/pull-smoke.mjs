import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parsePubSubPullPayload } from "../../packages/node/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const project = process.env.GOOGLE_CLOUD_PROJECT ?? "chat-ai-sdk";
const topic = process.env.WORKSPACE_EVENTS_PUBSUB_TOPIC ?? "chat-ai-sdk-smoke-tests";
const subscription =
  process.env.WORKSPACE_EVENTS_PUBSUB_SUBSCRIPTION ??
  "chat-ai-sdk-smoke-tests-dev-pull";
const subscriptionResource = subscription.startsWith("projects/")
  ? subscription
  : `projects/${project}/subscriptions/${subscription}`;
const fixturePath = path.join(
  root,
  "fixtures/workspace-events/chat-message-created.event.json",
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const smokeId = `w11-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
const data = JSON.stringify(fixture.data);
const attributes = {
  "ce-id": smokeId,
  "ce-source": fixture.source,
  "ce-specversion": fixture.specversion,
  "ce-type": fixture.type,
  "ce-time": new Date().toISOString(),
  "ce-subject": fixture.subject,
  "content-type": "application/json",
  synthetic: "true",
  w11_smoke_id: smokeId,
};
const attributeList = Object.entries(attributes)
  .map(([key, value]) => `${key}=${value}`)
  .join(",");

function gcloud(args) {
  return execFileSync("gcloud", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

gcloud([
  "pubsub",
  "topics",
  "publish",
  topic,
  "--project",
  project,
  "--message",
  data,
  "--attribute",
  attributeList,
]);

let pulled = [];

for (let attempt = 0; attempt < 8; attempt += 1) {
  const output = gcloud([
    "pubsub",
    "subscriptions",
    "pull",
    subscription,
    "--project",
    project,
    "--auto-ack",
    "--limit",
    "10",
    "--format=json",
  ]);

  pulled = output ? JSON.parse(output) : [];
  const match = pulled.find(
    (item) => item.message?.attributes?.w11_smoke_id === smokeId,
  );

  if (match) {
    const [parsed] = parsePubSubPullPayload([match], {
      subscription: subscriptionResource,
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          project,
          topic,
          subscription,
          smokeId,
          normalized: {
            eventId: parsed.event.eventId,
            source: parsed.event.source,
            kind: parsed.event.kind,
            rawKind: parsed.event.rawKind,
            workspaceEvent: parsed.event.workspaceEvent,
            checkpoint: parsed.event.pubSub?.checkpoint ?? null,
          },
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
}

console.error(
  JSON.stringify(
    {
      ok: false,
      project,
      topic,
      subscription,
      smokeId,
      pulledCount: pulled.length,
    },
    null,
    2,
  ),
);
process.exit(1);
