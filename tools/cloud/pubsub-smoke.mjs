import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const project = process.env.GOOGLE_CLOUD_PROJECT ?? "chat-ai-sdk";
const topic = process.env.GOOGLE_CHAT_SMOKE_PUBSUB_TOPIC ?? "chat-ai-sdk-smoke-tests";
const subscription =
  process.env.GOOGLE_CHAT_SMOKE_PUBSUB_SUBSCRIPTION ??
  "chat-ai-sdk-smoke-tests-dev-pull";
const smokeId = `smoke-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
const message = JSON.stringify({
  smokeId,
  project,
  createdAt: new Date().toISOString(),
});

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
  message,
  "--attribute",
  `smoke_id=${smokeId}`,
]);

let pulled = [];

for (let attempt = 0; attempt < 5; attempt += 1) {
  const output = gcloud([
    "pubsub",
    "subscriptions",
    "pull",
    subscription,
    "--project",
    project,
    "--auto-ack",
    "--limit",
    "5",
    "--format=json",
  ]);

  pulled = output ? JSON.parse(output) : [];
  const match = pulled.find(
    (item) => item.message?.attributes?.smoke_id === smokeId,
  );

  if (match) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          project,
          topic,
          subscription,
          smokeId,
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
