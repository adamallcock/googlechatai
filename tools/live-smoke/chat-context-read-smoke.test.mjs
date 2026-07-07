import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildContextReadPlan,
  loadContextReadSmokeConfig,
  runContextReadSmoke,
} from "./chat-context-read-smoke.mjs";

const SMOKE_SPACE_PREFIX = "Google Chat AI SDK Smoke";

async function writeMetadata(t, overrides = {}) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "chat-context-read-smoke-test-"),
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
    RUN_LIVE_CHAT_CONTEXT_READ_SMOKE: "1",
    GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
    GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
    GOOGLE_CHAT_CONTEXT_READ_SMOKE_RUN_ID: "context-read-test",
    GOOGLE_CHAT_CONTEXT_START_TIME: "2026-07-01T00:00:00Z",
    GOOGLE_CHAT_CONTEXT_END_TIME: "2026-07-02T00:00:00Z",
    GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS: "/tmp/oauth-client.json",
    GOOGLE_CHAT_USER_TOKEN_STORE: "/tmp/user-token.json",
    ...overrides,
  };
}

function customEmojiNotesForMessage(message) {
  return (message.annotations ?? []).flatMap((annotation) => {
    const metadata = annotation?.customEmojiMetadata;
    const customEmoji = metadata?.customEmoji;
    if (!metadata && annotation?.type !== "CUSTOM_EMOJI") {
      return [];
    }
    const label =
      customEmoji?.emojiName ?? customEmoji?.name ?? "custom emoji";
    const nameText =
      customEmoji?.name && customEmoji.name !== label
        ? ` (${customEmoji.name})`
        : "";
    return [
      `System Note: Custom emoji ${label}${nameText} appears in this message.`,
    ];
  });
}

function fakeSdk() {
  const planFor = (input) => ({
    requests: [
      {
        query: {
          pageSize: input.pageSize,
          filter: [
            `createTime > "${input.startTime}"`,
            `createTime < "${input.endTime}"`,
            input.thread ? `thread.name = "${input.thread}"` : null,
          ]
            .filter(Boolean)
            .join(" AND "),
          orderBy: `createTime ${input.order}`,
        },
      },
    ],
  });

  return {
    planReadSpaceContext: planFor,
    planReadThreadContext: planFor,
    buildConversationContext(input, responses) {
      const messages = responses.flatMap((response) => response.messages ?? []);
      const context = {
        kind: "chat.context",
        scope: input.thread ? "thread" : "space",
        space: input.space,
        thread: input.thread ?? null,
        order: input.order,
        requestedLimit: input.limit,
        returnedMessages: messages.length,
        pageCursors: { next: null },
        partial: false,
        truncated: false,
        inaccessible: false,
        systemNotes: [],
        messages: messages.map((message) => ({
          ref: { name: message.name },
          sender: {
            name: "users/ada",
            displayName: "Ada Lovelace",
            email: "ada@example.com",
            type: "HUMAN",
            access: "available",
          },
          createdAt: message.createTime,
          updatedAt: message.lastUpdateTime ?? null,
          deletedAt: message.deleteTime ?? null,
          relationship: {
            kind: input.thread ? "thread_reply" : "space_message",
            thread: message.thread?.name ?? input.thread ?? null,
            parentMessage: null,
          },
          text: message.text ?? "",
          plainTextForModel: message.text ?? "",
          attachments: message.attachment ?? [],
          quotedMessages: message.quotedMessages ?? [],
          systemNotes: [
            `System Note: Ada Lovelace (ada@example.com) sent this message at ${message.createTime}.`,
            ...(message.cardsV2?.length ? ["System Note: This message includes 1 card object."] : []),
            ...customEmojiNotesForMessage(message),
            ...(message.deleteTime
              ? ["System Note: This message was deleted and content is unavailable."]
              : []),
          ],
        })),
      };

      if (typeof input.maxContextTokens === "number") {
        const included = context.messages.slice(0, 1);
        const droppedMessages = context.messages.length - included.length;
        return {
          ...context,
          returnedMessages: included.length,
          partial: droppedMessages > 0,
          truncated: droppedMessages > 0,
          systemNotes:
            droppedMessages > 0
              ? [
                  `System Note: ${droppedMessages} message(s) were omitted to fit the model context budget of ${input.maxContextTokens - input.reserveOutputTokens} estimated tokens.`,
                ]
              : [],
          modelTokenBudget: {
            maxTokens: input.maxContextTokens,
            reserveOutputTokens: input.reserveOutputTokens,
            availableTokens: input.maxContextTokens - input.reserveOutputTokens,
            strategy: "preserve_order",
            estimator: {
              strategy: "chars_per_token",
              charsPerToken: input.charsPerToken,
            },
            estimatedTokensBefore: context.messages.length * 20,
            estimatedTokensAfter: included.length * 20,
            includedMessages: included.length,
            droppedMessages,
            truncated: droppedMessages > 0,
          },
          messages: included,
        };
      }

      return context;
    },
  };
}

function fakeClient() {
  const calls = [];
  return {
    calls,
    async listMessages(query) {
      calls.push(query);
      const isSecondPage = query.pageToken === "next-page";
      const thread = query.filter?.includes("thread.name");
      return {
        ok: true,
        status: 200,
        refreshed: calls.length === 1,
        replayedAfter401: false,
        json: isSecondPage
          ? {
              messages: [
                {
                  name: `spaces/AAAA-smoke/messages/${thread ? "thread" : "space"}-2`,
                  text: "second secret message",
                  createTime: "2026-07-01T11:00:00Z",
                  sender: {
                    name: "users/ada",
                    displayName: "Ada Lovelace",
                    email: "ada@example.com",
                    type: "HUMAN",
                  },
                  thread: { name: "spaces/AAAA-smoke/threads/thread-1" },
                  deleteTime: thread ? "2026-07-01T11:05:00Z" : undefined,
                },
              ],
            }
          : {
              messages: [
                {
                  name: `spaces/AAAA-smoke/messages/${thread ? "thread" : "space"}-1`,
                  text: "first secret message",
                  createTime: "2026-07-01T10:00:00Z",
                  sender: {
                    name: "users/ada",
                    displayName: "Ada Lovelace",
                    email: "ada@example.com",
                    type: "HUMAN",
                  },
                  thread: { name: "spaces/AAAA-smoke/threads/thread-1" },
                  cardsV2: thread ? [] : [{ cardId: "card-1" }],
                  annotations: thread
                    ? []
                    : [
                        {
                          type: "CUSTOM_EMOJI",
                          startIndex: 21,
                          length: 14,
                          customEmojiMetadata: {
                            customEmoji: {
                              name: "customEmojis/context_secret",
                              emojiName: ":context_secret:",
                              temporaryImageUri: "https://example.invalid/context-secret.png",
                            },
                          },
                        },
                      ],
                  attachment: thread
                    ? []
                    : [
                        {
                          name: "spaces/AAAA-smoke/messages/space-1/attachments/doc-1",
                          contentName: "drive-smoke-doc",
                          contentType: "application/vnd.google-apps.document",
                          source: "DRIVE_FILE",
                          driveDataRef: { driveFileId: "drive-file-secret" },
                        },
                      ],
                  quotedMessages: thread
                    ? []
                    : [
                        {
                          ref: { name: "spaces/AAAA-smoke/messages/quoted-1" },
                          sender: {
                            name: "users/grace",
                            displayName: "Grace Hopper",
                            email: "grace@example.com",
                            type: "HUMAN",
                            access: "available",
                          },
                          createdAt: "2026-07-01T09:59:00Z",
                          updatedAt: null,
                          deletedAt: null,
                          relationship: {
                            kind: "quote",
                            thread: "spaces/AAAA-smoke/threads/thread-1",
                            parentMessage: null,
                          },
                          text: "quoted secret message",
                          plainTextForModel: "quoted secret message",
                          attachments: [
                            {
                              name: "spaces/AAAA-smoke/messages/quoted-1/attachments/audio-1",
                              contentName: "voice.wav",
                              contentType: "audio/wav",
                              source: "UPLOADED_CONTENT",
                              mediaResourceName:
                                "spaces/AAAA-smoke/messages/quoted-1/attachments/audio-1/media",
                            },
                          ],
                          quotedMessages: [],
                          systemNotes: [
                            "System Note: This message was included as quoted context.",
                            "System Note: The user attached voice.wav (audio/wav, unknown size) with this message.",
                          ],
                        },
                      ],
                },
              ],
              nextPageToken: "next-page",
            },
      };
    },
  };
}

function fakeDeletedOnlyClient() {
  const calls = [];
  return {
    calls,
    async listMessages(query) {
      calls.push(query);
      return {
        ok: true,
        status: 200,
        refreshed: false,
        replayedAfter401: false,
        json: {
          messages: [
            {
              name: "spaces/AAAA-smoke/messages/deleted-1",
              createTime: "2026-07-01T12:00:00Z",
              deleteTime: "2026-07-01T12:01:00Z",
            },
            {
              name: "spaces/AAAA-smoke/messages/deleted-2",
              createTime: "2026-07-01T12:02:00Z",
              deleteTime: "2026-07-01T12:03:00Z",
            },
          ],
        },
      };
    },
  };
}

test("loadContextReadSmokeConfig refuses to run without explicit guard", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadContextReadSmokeConfig({
        argv: ["node", "chat-context-read-smoke.mjs", "--dry-run"],
        env: {
          GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
          GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
        },
      }),
    /RUN_LIVE_CHAT_CONTEXT_READ_SMOKE=1/,
  );
});

test("dry-run plan is read-only and uses user message-read scope", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadContextReadSmokeConfig({
    argv: [
      "node",
      "chat-context-read-smoke.mjs",
      "--dry-run",
      "--limit=5",
      "--page-size=2",
      "--max-context-tokens=80",
      "--reserve-output-tokens=20",
      "--chars-per-token=5",
    ],
    env: smokeEnv(metadataPath),
  });
  const plan = buildContextReadPlan(config);

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.calls[0].writes, false);
  assert.equal(plan.calls[0].authMode, "user");
  assert.deepEqual(plan.calls[0].requiredScopes, [
    "https://www.googleapis.com/auth/chat.messages.readonly",
  ]);
  assert.equal(plan.reader.limit, 5);
  assert.equal(plan.reader.pageSize, 2);
  assert.equal(plan.reader.maxContextTokens, 80);
  assert.equal(plan.reader.reserveOutputTokens, 20);
  assert.equal(plan.reader.charsPerToken, 5);
});

test("runContextReadSmoke accepts deleted-only windows with no thread metadata", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadContextReadSmokeConfig({
    argv: ["node", "chat-context-read-smoke.mjs", "--limit=8", "--page-size=2"],
    env: smokeEnv(metadataPath),
  });
  const client = fakeDeletedOnlyClient();
  const result = await runContextReadSmoke(config, {
    client,
    sdk: fakeSdk(),
    writeEvidence: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.contexts.space.returnedMessages, 2);
  assert.equal(result.evidence.contexts.space.rawApi.deletedMessages, 2);
  assert.equal(result.evidence.contexts.thread, undefined);
  assert.equal(result.evidence.assertions.threadFilterExercised, null);
  assert.equal(result.evidence.assertions.contextIncludesCreatedTimes, true);
  assert.equal(result.evidence.assertions.contextIncludesSenderTimeNotes, true);
  assert.deepEqual(result.evidence.failures, []);
  assert.equal(client.calls.length, 1);
});

test("runContextReadSmoke builds redacted space and thread context evidence", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadContextReadSmokeConfig({
    argv: [
      "node",
      "chat-context-read-smoke.mjs",
      "--limit=2",
      "--page-size=1",
      "--expect-text=first secret",
      "--expect-quoted-messages=1",
      "--expect-quoted-attachments=1",
      "--expect-drive-attachments=1",
      "--expect-custom-emojis=1",
      "--expect-thread-messages=2",
      "--expect-thread-replies=1",
      "--expect-pagination",
      "--expect-human-thread-anchor",
    ],
    env: smokeEnv(metadataPath),
  });
  const client = fakeClient();
  const result = await runContextReadSmoke(config, {
    client,
    sdk: fakeSdk(),
    writeEvidence: false,
  });
  const serialized = JSON.stringify(result.evidence);

  assert.equal(result.ok, true);
  assert.equal(result.evidence.contexts.space.rawApi.pages, 2);
  assert.equal(result.evidence.contexts.thread.rawApi.pages, 2);
  assert.equal(result.evidence.assertions.paginationExercised, true);
  assert.equal(result.evidence.assertions.paginationObserved, true);
  assert.equal(result.evidence.assertions.threadFilterExercised, true);
  assert.equal(
    result.evidence.assertions.expectedThreadMessageCountMatches,
    true,
  );
  assert.equal(
    result.evidence.assertions.expectedThreadReplyCountMatches,
    true,
  );
  assert.equal(
    result.evidence.contexts.thread.relationshipSummary.replyLikeMessages,
    1,
  );
  assert.equal(result.evidence.assertions.humanThreadAnchor, true);
  assert.equal(
    result.evidence.contexts.thread.selection.selectedByExpectedText,
    true,
  );
  assert.equal(
    result.evidence.contexts.thread.selection.anchorSender.type,
    "HUMAN",
  );
  assert.equal(result.evidence.assertions.contextIncludesCreatedTimes, true);
  assert.equal(result.evidence.assertions.quotedMessageCount, 1);
  assert.equal(result.evidence.assertions.quotedAttachmentCount, 1);
  assert.equal(result.evidence.assertions.driveAttachmentCount, 1);
  assert.equal(result.evidence.assertions.customEmojiCount, 1);
  assert.equal(result.evidence.assertions.expectedQuotedMessageCountMatches, true);
  assert.equal(result.evidence.assertions.expectedQuotedAttachmentCountMatches, true);
  assert.equal(result.evidence.assertions.expectedDriveAttachmentCountMatches, true);
  assert.equal(result.evidence.assertions.expectedCustomEmojiCountMatches, true);
  assert.equal(result.evidence.assertions.expectedText.found, true);
  assert.equal(client.calls.some((query) => query.pageToken === "next-page"), true);
  assert.equal(serialized.includes("first secret message"), false);
  assert.equal(serialized.includes("second secret message"), false);
  assert.equal(serialized.includes("ada@example.com"), false);
  assert.equal(serialized.includes("Ada Lovelace"), false);
  assert.equal(serialized.includes("drive-file-secret"), false);
  assert.equal(serialized.includes("context_secret"), false);
});

test("runContextReadSmoke finds expected text in an explicit thread context", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadContextReadSmokeConfig({
    argv: [
      "node",
      "chat-context-read-smoke.mjs",
      "--limit=2",
      "--page-size=1",
      "--thread=spaces/AAAA-smoke/threads/thread-expected",
      "--expect-text=thread-only secret",
      "--expect-thread-messages=1",
    ],
    env: smokeEnv(metadataPath),
  });
  const calls = [];
  const client = {
    calls,
    async listMessages(query) {
      calls.push(query);
      const thread = query.filter?.includes("thread.name");
      return {
        ok: true,
        status: 200,
        refreshed: false,
        replayedAfter401: false,
        json: {
          messages: [
            {
              name: `spaces/AAAA-smoke/messages/${thread ? "thread" : "space"}-expected`,
              text: thread ? "thread-only secret" : "old space message",
              createTime: "2026-07-01T10:00:00Z",
              sender: {
                name: "users/ada",
                displayName: "Ada Lovelace",
                email: "ada@example.com",
                type: "HUMAN",
              },
              thread: { name: "spaces/AAAA-smoke/threads/thread-expected" },
            },
          ],
        },
      };
    },
  };
  const result = await runContextReadSmoke(config, {
    client,
    sdk: fakeSdk(),
    writeEvidence: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.assertions.expectedText.found, true);
  assert.equal(
    result.evidence.assertions.expectedThreadMessageCountMatches,
    true,
  );
  assert.equal(
    calls.some((query) => query.filter?.includes("thread.name")),
    true,
  );
});

test("runContextReadSmoke records model-token budget truncation evidence", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadContextReadSmokeConfig({
    argv: [
      "node",
      "chat-context-read-smoke.mjs",
      "--limit=2",
      "--page-size=1",
      "--max-context-tokens=30",
      "--reserve-output-tokens=10",
      "--chars-per-token=5",
      "--expect-budget-truncation",
    ],
    env: smokeEnv(metadataPath),
  });
  const result = await runContextReadSmoke(config, {
    client: fakeClient(),
    sdk: fakeSdk(),
    writeEvidence: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.contexts.space.modelTokenBudget.applied, true);
  assert.equal(result.evidence.contexts.space.modelTokenBudget.maxTokens, 30);
  assert.equal(result.evidence.contexts.space.modelTokenBudget.availableTokens, 20);
  assert.equal(
    result.evidence.contexts.space.modelTokenBudget.estimator.charsPerToken,
    5,
  );
  assert.equal(result.evidence.contexts.space.modelTokenBudget.truncated, true);
  assert.equal(
    result.evidence.assertions.expectedBudgetTruncationMatches,
    true,
  );
  assert.equal(result.evidence.failures.length, 0);
});
