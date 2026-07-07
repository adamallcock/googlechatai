import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEvidenceCollectPlan,
  recordChatFixture,
  replayRecordedFixture,
  resolveEvidenceConfig,
  runEvidenceTool,
} from "./evidence.mjs";

function samplePayload() {
  return {
    type: "MESSAGE",
    eventTime: "2026-07-04T12:00:00Z",
    authorization: "Bearer secret-token-value",
    user: {
      name: "users/123",
      displayName: "Private Person",
      email: "private@example-tenant.test",
      type: "HUMAN",
    },
    space: {
      name: "spaces/AAA",
      displayName: "Private Space",
      type: "ROOM",
    },
    message: {
      name: "spaces/AAA/messages/msg-1",
      text: "this is private message text",
      formattedText: "<b>this is private message text</b>",
      createTime: "2026-07-04T12:00:00Z",
      sender: {
        name: "users/123",
        displayName: "Private Person",
        email: "private@example-tenant.test",
        type: "HUMAN",
      },
      thread: {
        name: "spaces/AAA/threads/thread-1",
      },
      attachments: [
        {
          name: "spaces/AAA/messages/msg-1/attachments/file-1",
          contentName: "secret-plan.pdf",
          contentType: "application/pdf",
          sizeBytes: 1024,
          data: "base64-private-attachment-bytes",
        },
      ],
    },
    common: {
      formInputs: {
        prompt: {
          stringInputs: {
            value: ["private form value"],
          },
        },
      },
    },
  };
}

test("collect dry-run plans evidence commands without side effects", async () => {
  const config = resolveEvidenceConfig({
    argv: ["node", "evidence.mjs", "collect", "--", "--dry-run", "--since=10m"],
    env: { GOOGLE_CLOUD_PROJECT: "doctor-project" },
    cwd: "/repo",
  });
  const effects = [];
  const result = await runEvidenceTool(config, {
    runCommand() {
      effects.push("command");
      throw new Error("dry-run should not execute commands");
    },
    writeFile() {
      effects.push("writeFile");
      throw new Error("dry-run should not write files");
    },
  });

  assert.deepEqual(effects, []);
  assert.equal(result.kind, "chat.evidence_collect_plan");
  assert.equal(result.mode, "dry-run");
  assert.equal(result.privacy.rawTokensSaved, false);
  assert.equal(result.commands.length, 2);

  const plan = buildEvidenceCollectPlan(config);
  assert.equal(plan.commands[0].id, "chat.doctor");
  assert.equal(plan.commands[1].id, "chat.logs");
});

test("recordChatFixture redacts sensitive payload values but preserves replayable shape", () => {
  const recorded = recordChatFixture(samplePayload(), {
    fixtureId: "sample-private-event",
    receivedAt: "2026-07-04T12:00:01Z",
  });
  const serialized = JSON.stringify(recorded);

  assert.equal(recorded.kind, "chat.evidence_recorded_fixture");
  assert.equal(recorded.structure.eventType, "MESSAGE");
  assert.equal(recorded.structure.attachmentCount, 1);
  assert.equal(recorded.structure.authAvailable, true);
  assert.equal(recorded.payload.message.attachments[0].data, "[redacted:bytes]");
  assert.match(recorded.payload.message.text, /^\[redacted:text:/);
  assert.equal(recorded.payload.user.email, "redacted-email@example.invalid");
  assert.equal(serialized.includes("secret-token-value"), false);
  assert.equal(serialized.includes("private message text"), false);
  assert.equal(serialized.includes("private@example-tenant.test"), false);
  assert.equal(serialized.includes("private form value"), false);
  assert.equal(serialized.includes("base64-private-attachment-bytes"), false);
});

test("replayRecordedFixture checks Node and Python normalization parity", async () => {
  const recorded = recordChatFixture(samplePayload(), {
    fixtureId: "sample-private-event",
    receivedAt: "2026-07-04T12:00:01Z",
  });
  const replay = await replayRecordedFixture(recorded);

  assert.equal(replay.kind, "chat.evidence_replay_result");
  assert.equal(replay.nodePythonEqual, true);
  assert.equal(replay.node.kind, replay.python.kind);
  assert.equal(replay.privacy.rawPayloadSaved, false);
});
