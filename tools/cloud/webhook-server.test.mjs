import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import test from "node:test";

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  if (!port) {
    throw new Error("Unable to allocate a local test port.");
  }
  return port;
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 5_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/healthz`);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw lastError ?? new Error("Webhook test server did not become healthy.");
}

async function readJsonRequest(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function startFakeFirestore(t) {
  const docs = new Map();
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const documentId = url.searchParams.get("documentId");
    const auth = request.headers.authorization ?? null;
    requests.push({
      method: request.method,
      pathname: url.pathname,
      documentId,
      auth,
    });

    if (request.method === "POST" && documentId) {
      const body = await readJsonRequest(request);
      if (docs.has(documentId)) {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { status: "ALREADY_EXISTS" },
          }),
        );
        return;
      }
      docs.set(documentId, {
        name: `${url.pathname}/${documentId}`,
        fields: body.fields,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(docs.get(documentId)));
      return;
    }

    const key = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    if (request.method === "GET" && docs.has(key)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(docs.get(key)));
      return;
    }

    if (request.method === "PATCH" && docs.has(key)) {
      const body = await readJsonRequest(request);
      docs.set(key, {
        ...docs.get(key),
        fields: {
          ...docs.get(key).fields,
          ...body.fields,
        },
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(docs.get(key)));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { status: "NOT_FOUND" } }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());
  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    docs,
  };
}

test("Cloud Run webhook supports direct Chat and Workspace add-on envelopes", async (t) => {
  const port = await getFreePort();
  const publicBaseUrl = `http://127.0.0.1:${port}/api`;
  const child = spawn(process.execPath, ["examples/cloud-run-node/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      BASE_URL: publicBaseUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  t.after(() => {
    child.kill();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);

  const directResponse = await fetch(`${baseUrl}/api/chat/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "MESSAGE",
      message: { name: "spaces/AAA/messages/BBB" },
    }),
  });
  assert.equal(directResponse.status, 200);
  assert.deepEqual(await directResponse.json(), {
    text: "Google Chat AI SDK dev webhook received the event.",
  });

  const addOnResponse = await fetch(`${baseUrl}/api/chat/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat: {
        messagePayload: {
          message: { name: "spaces/AAA/messages/CCC" },
        },
      },
    }),
  });
  assert.equal(addOnResponse.status, 200);
  assert.deepEqual(await addOnResponse.json(), {
    hostAppDataAction: {
      chatDataAction: {
        createMessageAction: {
          message: {
            text: "Google Chat AI SDK dev webhook received the event.",
          },
        },
      },
    },
  });

  const addToSpaceResponse = await fetch(`${baseUrl}/api/chat/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat: {
        addedToSpacePayload: {
          space: { name: "spaces/AAA" },
        },
      },
    }),
  });
  assert.equal(addToSpaceResponse.status, 200);
  assert.deepEqual(await addToSpaceResponse.json(), {});

  const attachmentFixture = JSON.parse(
    await fs.readFile("fixtures/events/message-created/attachment.json", "utf8"),
  );
  const attachmentResponse = await fetch(`${baseUrl}/api/chat/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(attachmentFixture),
  });
  assert.equal(attachmentResponse.status, 200);
  assert.deepEqual(await attachmentResponse.json(), {
    text: "Google Chat AI SDK dev webhook received the event.",
  });

  const dialogFixture = JSON.parse(
    await fs.readFile("fixtures/events/card/dialog-submit.json", "utf8"),
  );
  const dialogResponse = await fetch(`${baseUrl}/api/chat/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(dialogFixture),
  });
  assert.equal(dialogResponse.status, 200);
  assert.deepEqual(await dialogResponse.json(), {});

  const markCardResponse = await fetch(`${baseUrl}/api/chat/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commonEventObject: {
        parameters: {
          actionName: "googlechatai_sdk_card_mark_received",
          runId: "card-action-test",
        },
      },
      chat: {
        buttonClickedPayload: {
          message: {
            name: "spaces/AAA/messages/CARD_ACTION",
          },
          action: {
            function: "https://example.test/api/chat/events",
            parameters: [
              {
                key: "actionName",
                value: "googlechatai_sdk_card_mark_received",
              },
              {
                key: "runId",
                value: "card-action-test",
              },
            ],
          },
        },
      },
    }),
  });
  assert.equal(markCardResponse.status, 200);
  const markCardJson = await markCardResponse.json();
  assert.equal(
    markCardJson.hostAppDataAction.chatDataAction.updateMessageAction.message
      .cardsV2[0].cardId,
    "card-action-smoke-card-action-test",
  );
  assert.equal(
    markCardJson.hostAppDataAction.chatDataAction.updateMessageAction.message
      .cardsV2[0].card.sections[0].widgets[0].decoratedText.text,
    "Button action received by the dev webhook.",
  );

  const encodedState = `v1.${Buffer.from(
    JSON.stringify({
      cursor: "card-action-smoke-page-2",
      approval: { id: "stateful-card-action-test", version: 1 },
    }),
    "utf8",
  ).toString("base64url")}`;
  const statefulMarkCardResponse = await fetch(`${baseUrl}/api/chat/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commonEventObject: {
        parameters: {
          actionName: "googlechatai_sdk_card_mark_received",
          runId: "stateful-card-action-test",
          __googleChatAiState: encodedState,
        },
      },
      chat: {
        buttonClickedPayload: {
          message: {
            name: "spaces/AAA/messages/STATEFUL_CARD_ACTION",
          },
          action: {
            function: "https://example.test/api/chat/events",
            parameters: [
              {
                key: "actionName",
                value: "googlechatai_sdk_card_mark_received",
              },
              {
                key: "runId",
                value: "stateful-card-action-test",
              },
              {
                key: "__googleChatAiState",
                value: encodedState,
              },
            ],
          },
        },
      },
    }),
  });
  assert.equal(statefulMarkCardResponse.status, 200);
  const statefulMarkCardJson = await statefulMarkCardResponse.json();
  assert.equal(
    statefulMarkCardJson.hostAppDataAction.chatDataAction.updateMessageAction
      .message.cardsV2[0].card.sections[0].widgets[0].decoratedText.text,
    "Button action received by the dev webhook. State decoded.",
  );

  const feedbackResponse = await fetch(`${baseUrl}/api/chat/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commonEventObject: {
        parameters: {
          actionName: "ai_visual_feedback",
          runId: "feedback-action-test",
          responseId: "resp_feedback",
          rating: "helpful",
        },
      },
      chat: {
        buttonClickedPayload: {
          message: {
            name: "spaces/AAA/messages/FEEDBACK",
            text: "[feedback-action-test] Answer smoke with low-impact accessory feedback controls.",
          },
          action: {
            function: `${publicBaseUrl}/chat/events`,
            parameters: [
              {
                key: "actionName",
                value: "ai_visual_feedback",
              },
              {
                key: "runId",
                value: "feedback-action-test",
              },
              {
                key: "responseId",
                value: "resp_feedback",
              },
              {
                key: "rating",
                value: "helpful",
              },
            ],
          },
        },
      },
    }),
  });
  assert.equal(feedbackResponse.status, 200);
  const feedbackJson = await feedbackResponse.json();
  const feedbackMessage =
    feedbackJson.hostAppDataAction.chatDataAction.updateMessageAction.message;
  assert.equal(
    feedbackMessage.text,
    "[feedback-action-test] Answer smoke with low-impact accessory feedback controls.",
  );
  assert.equal(feedbackMessage.accessoryWidgets[0].buttonList.buttons.length, 2);
  assert.equal(
    feedbackMessage.accessoryWidgets[0].buttonList.buttons[0].icon.materialIcon
      .name,
    "thumb_up",
  );
  assert.equal(
    feedbackMessage.accessoryWidgets[0].buttonList.buttons[0].type,
    "BORDERLESS",
  );
  assert.deepEqual(
    feedbackMessage.accessoryWidgets[0].buttonList.buttons[0].color,
    {
      red: 0.2,
      green: 0.55,
      blue: 0.25,
      alpha: 1,
    },
  );
  assert.equal(
    feedbackMessage.accessoryWidgets[0].buttonList.buttons[1].color,
    undefined,
  );
  assert.equal(
    feedbackMessage.accessoryWidgets[0].buttonList.buttons[0].onClick.action
      .function,
    `${publicBaseUrl}/chat/events`,
  );
  assert.equal(
    feedbackMessage.accessoryWidgets[0].buttonList.buttons[0].onClick.action
      .parameters[2].value,
    "helpful",
  );

  const openDialogResponse = await fetch(`${baseUrl}/api/chat/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commonEventObject: {
        parameters: {
          actionName: "googlechatai_sdk_card_open_dialog",
          runId: "dialog-action-test",
        },
      },
      chat: {
        buttonClickedPayload: {
          message: {
            name: "spaces/AAA/messages/DIALOG_ACTION",
          },
        },
      },
    }),
  });
  assert.equal(openDialogResponse.status, 200);
  const openDialogJson = await openDialogResponse.json();
  assert.equal(
    openDialogJson.action.navigations[0].pushCard.header.title,
    "Google Chat AI SDK Dialog Smoke",
  );
  assert.equal(
    openDialogJson.action.navigations[0].pushCard.sections[0].widgets[0]
      .textInput.name,
    "smoke_note",
  );

  const navigationResponse = await fetch(`${baseUrl}/api/chat/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commonEventObject: {
        parameters: {
          actionName: "googlechatai_sdk_card_navigation_next",
          runId: "navigation-action-test",
        },
      },
      chat: {
        buttonClickedPayload: {
          message: {
            name: "spaces/AAA/messages/NAVIGATION_ACTION",
          },
        },
      },
    }),
  });
  assert.equal(navigationResponse.status, 200);
  const navigationJson = await navigationResponse.json();
  assert.equal(
    navigationJson.action.navigations[0].pushCard.header.title,
    "Google Chat AI SDK Navigation Smoke",
  );
  assert.equal(
    navigationJson.action.navigations[0].pushCard.sections[0].widgets[0]
      .decoratedText.text,
    "The dev webhook returned a pushCard navigation response.",
  );
  assert.equal(
    navigationJson.action.navigations[0].pushCard.sections[0].widgets[1]
      .buttonList.buttons[0].text,
    "Update top card",
  );
  assert.equal(
    navigationJson.action.navigations[0].pushCard.sections[0].widgets[1]
      .buttonList.buttons[0].onClick.action.parameters[0].value,
    "googlechatai_sdk_card_navigation_update",
  );

  const navigationUpdateResponse = await fetch(`${baseUrl}/api/chat/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commonEventObject: {
        parameters: {
          actionName: "googlechatai_sdk_card_navigation_update",
          runId: "navigation-update-action-test",
        },
      },
      chat: {
        buttonClickedPayload: {
          message: {
            name: "spaces/AAA/messages/NAVIGATION_UPDATE_ACTION",
          },
        },
      },
    }),
  });
  assert.equal(navigationUpdateResponse.status, 200);
  const navigationUpdateJson = await navigationUpdateResponse.json();
  assert.equal(
    navigationUpdateJson.action.navigations[0].updateCard.header.title,
    "Google Chat AI SDK Navigation Update Smoke",
  );
  assert.equal(
    navigationUpdateJson.action.navigations[0].updateCard.sections[0].widgets[0]
      .decoratedText.text,
    "The dev webhook returned an updateCard navigation response.",
  );

  const submitDialogResponse = await fetch(`${baseUrl}/api/chat/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commonEventObject: {
        parameters: {
          actionName: "googlechatai_sdk_card_submit_dialog",
          runId: "dialog-submit-test",
        },
        formInputs: {
          smoke_note: {
            stringInputs: {
              value: ["Visible test note"],
            },
          },
        },
      },
      chat: {
        buttonClickedPayload: {
          message: {
            name: "spaces/AAA/messages/DIALOG_SUBMIT",
          },
        },
      },
    }),
  });
  assert.equal(submitDialogResponse.status, 200);
  assert.deepEqual(await submitDialogResponse.json(), {
    hostAppDataAction: {
      chatDataAction: {
        createMessageAction: {
          message: {
            text: "[dialog-submit-test] Dialog smoke submitted.",
          },
        },
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  const logs = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const attachmentLog = logs.find(
    (entry) => entry.messageName === "spaces/AAA/messages/attachment-1",
  );
  const dialogLog = logs.find(
    (entry) => entry.eventDebugSummary?.action?.methodName ===
      "submit_incident_dialog",
  );
  const cardActionLog = logs.find(
    (entry) => entry.messageName === "spaces/AAA/messages/CARD_ACTION",
  );
  const statefulCardActionLog = logs.find(
    (entry) => entry.messageName === "spaces/AAA/messages/STATEFUL_CARD_ACTION",
  );
  const dialogActionLog = logs.find(
    (entry) => entry.messageName === "spaces/AAA/messages/DIALOG_SUBMIT",
  );
  const navigationActionLog = logs.find(
    (entry) => entry.messageName === "spaces/AAA/messages/NAVIGATION_ACTION",
  );

  assert.equal(attachmentLog.eventDebugSummary.kind, "MESSAGE");
  assert.equal(attachmentLog.eventIdentity.source, "direct_chat_event");
  assert.equal(attachmentLog.eventIdentity.rawKind, "MESSAGE");
  assert.equal(attachmentLog.eventIdentity.resourceNameAvailable, true);
  assert.equal(typeof attachmentLog.eventIdentity.eventIdHash, "string");
  assert.equal(
    attachmentLog.eventIdentity.eventIdHash,
    attachmentLog.eventIdentity.idempotencyKeyHash,
  );
  assert.deepEqual(
    attachmentLog.eventDebugSummary.identity,
    attachmentLog.eventIdentity,
  );
  assert.equal(attachmentLog.eventDebugSummary.eventTime, "2026-06-29T18:25:00Z");
  assert.equal(attachmentLog.eventDebugSummary.user.displayNameAvailable, true);
  assert.equal(attachmentLog.eventDebugSummary.user.emailDomain, "example.com");
  assert.equal(attachmentLog.eventDebugSummary.message.text.length, 38);
  assert.equal(attachmentLog.eventDebugSummary.message.attachments.count, 1);
  assert.deepEqual(attachmentLog.eventDebugSummary.message.attachments.items[0], {
    name: "spaces/AAA/messages/attachment-1/attachments/audio-1",
    contentName: "standup.m4a",
    contentType: "audio/mp4",
    source: "UPLOADED_CONTENT",
    sizeBytes: 2100000,
    hasAttachmentDataRef: true,
    hasDriveDataRef: false,
    mediaResourceName: "spaces/AAA/messages/attachment-1/attachments/audio-1/media",
    driveFileIdAvailable: false,
  });
  assert.equal(stdout.includes("Please review the recording and brief."), false);
  assert.equal(stdout.includes("direct_chat_event:MESSAGE:"), false);

  assert.equal(dialogLog.eventDebugSummary.dialogEventType, "SUBMIT_DIALOG");
  assert.deepEqual(dialogLog.eventDebugSummary.action.formInputKeys, [
    "decision",
    "notes",
  ]);
  assert.equal(stdout.includes("Ship it"), false);

  assert.deepEqual(cardActionLog.eventDebugSummary.action.parameterKeys, [
    "actionName",
    "runId",
    "actionName",
    "runId",
  ]);
  assert.equal(
    cardActionLog.eventDebugSummary.action.methodName,
    "googlechatai_sdk_card_mark_received",
  );
  assert.equal(
    statefulCardActionLog.eventDebugSummary.action.cardActionState.present,
    true,
  );
  assert.equal(
    statefulCardActionLog.eventDebugSummary.action.cardActionState.decoded,
    true,
  );
  assert.deepEqual(
    statefulCardActionLog.eventDebugSummary.action.cardActionState.topLevelKeys,
    ["approval", "cursor"],
  );
  assert.deepEqual(
    statefulCardActionLog.eventDebugSummary.action.cardActionState
      .nestedObjectKeys,
    { approval: ["id", "version"] },
  );
  assert.deepEqual(dialogActionLog.eventDebugSummary.action.formInputKeys, [
    "smoke_note",
  ]);
  assert.equal(
    navigationActionLog.eventDebugSummary.action.methodName,
    "googlechatai_sdk_card_navigation_next",
  );
  assert.equal(stdout.includes("Visible test note"), false);
  assert.equal(stdout.includes("card-action-test"), false);
  assert.equal(stdout.includes("card-action-smoke-page-2"), false);
  assert.equal(stdout.includes("stateful-card-action-test"), false);
  assert.equal(stdout.includes("navigation-action-test"), false);
});

test("Cloud Run webhook suppresses duplicate direct Chat event responses", async (t) => {
  const port = await getFreePort();
  const child = spawn(process.execPath, ["examples/cloud-run-node/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      GOOGLE_CHAT_IDEMPOTENCY_TTL_MS: "600000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  t.after(() => {
    child.kill();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  const event = {
    type: "MESSAGE",
    eventTime: "2026-07-02T10:00:00Z",
    message: {
      name: "spaces/AAA/messages/DUPLICATE",
      createTime: "2026-07-02T10:00:00Z",
    },
  };

  const first = await fetch(`${baseUrl}/api/chat/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  const second = await fetch(`${baseUrl}/api/chat/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });

  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {
    text: "Google Chat AI SDK dev webhook received the event.",
  });
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), {});

  await new Promise((resolve) => setTimeout(resolve, 100));
  const logs = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.messageName === "spaces/AAA/messages/DUPLICATE");

  assert.equal(logs.length, 2);
  assert.equal(logs[0].duplicateDelivery, false);
  assert.equal(logs[0].idempotency.claimed, true);
  assert.equal(logs[1].duplicateDelivery, true);
  assert.equal(logs[1].idempotency.claimed, false);
  assert.equal(logs[1].idempotency.duplicate, true);
  assert.equal(logs[1].idempotency.seenCount, 2);
});

test("Cloud Run webhook suppresses duplicates through Firestore idempotency store", async (t) => {
  const firestore = await startFakeFirestore(t);
  const port = await getFreePort();
  const child = spawn(process.execPath, ["examples/cloud-run-node/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      GOOGLE_CLOUD_PROJECT: "unit-test-project",
      GOOGLE_CHAT_IDEMPOTENCY_STORE: "firestore",
      GOOGLE_CHAT_IDEMPOTENCY_TTL_MS: "600000",
      GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_BASE_URL: firestore.baseUrl,
      GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION: "chatEventClaims",
      GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_TOKEN: "local-firestore-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  t.after(() => {
    child.kill();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  const event = {
    type: "MESSAGE",
    eventTime: "2026-07-02T11:00:00Z",
    message: {
      name: "spaces/AAA/messages/FIRESTORE_DUPLICATE",
      createTime: "2026-07-02T11:00:00Z",
    },
  };

  const first = await fetch(`${baseUrl}/api/chat/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  const second = await fetch(`${baseUrl}/api/chat/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });

  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {
    text: "Google Chat AI SDK dev webhook received the event.",
  });
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), {});

  await new Promise((resolve) => setTimeout(resolve, 100));
  const logs = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(
      (entry) => entry.messageName === "spaces/AAA/messages/FIRESTORE_DUPLICATE",
    );

  assert.equal(logs.length, 2);
  assert.equal(logs[0].duplicateDelivery, false);
  assert.equal(logs[0].idempotency.mode, "firestore");
  assert.equal(logs[0].idempotency.claimed, true);
  assert.equal(logs[1].duplicateDelivery, true);
  assert.equal(logs[1].idempotency.mode, "firestore");
  assert.equal(logs[1].idempotency.claimed, false);
  assert.equal(logs[1].idempotency.duplicate, true);
  assert.equal(logs[1].idempotency.seenCount, 2);
  assert.equal(firestore.docs.size, 1);
  assert.ok(
    firestore.requests.some(
      (request) =>
        request.method === "POST" &&
        request.auth === "Bearer local-firestore-token",
    ),
  );
});
