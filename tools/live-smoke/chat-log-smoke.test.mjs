import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLogSmokePlan,
  resolveLogSmokeConfig,
  runLogSmoke,
} from "./chat-log-smoke.mjs";

function env(overrides = {}) {
  return {
    RUN_LIVE_CHAT_LOG_SMOKE: "1",
    GOOGLE_CLOUD_PROJECT: "example-chat-project",
    GOOGLE_CHAT_CLOUD_RUN_SERVICE: "chat-ai-sdk-dev-webhook",
    GOOGLE_CHAT_LOG_SMOKE_RUN_ID: "log-smoke-test",
    ...overrides,
  };
}

function eventEntry(overrides = {}) {
  return {
    timestamp: "2026-07-01T20:30:01Z",
    severity: "INFO",
    resource: {
      labels: {
        revision_name: "chat-ai-sdk-dev-webhook-00001-test",
      },
    },
    jsonPayload: {
      event: "chat_event_received",
      eventType: "message",
      messageName: "spaces/AAA/messages/private-message-id",
      addOnEnvelope: true,
      hasAuthorization: true,
      idempotency: {
        mode: "firestore",
        claimed: true,
        duplicate: false,
        seenCount: 1,
      },
      eventDebugSummary: {
        sourceShape: "workspace_addon_envelope",
        kind: "message",
        eventTime: "2026-07-01T20:30:00Z",
        message: {
          text: {
            length: 41,
            sha256: "abc123",
          },
          annotations: {
            count: 1,
            byType: {
              USER_MENTION: 1,
            },
            userMentionCount: 1,
            slashCommandCount: 0,
          },
          attachments: {
            count: 0,
            items: [],
          },
        },
        action: {
          parameterCount: 0,
          parameterKeys: [],
          formInputCount: 0,
          formInputKeys: [],
        },
        relationship: {
          hasThread: true,
          hasQuotedMessage: false,
          quoteDepth: 0,
          hasSlashCommand: false,
          hasAppCommand: false,
          hasAction: false,
        },
        identity: {
          source: "workspace_addon_envelope",
          rawKind: "message",
          eventTime: "2026-07-01T20:30:00Z",
          resourceNameAvailable: true,
          resourceNameHash: "resource-hash",
          eventIdHash: "event-id-hash",
          idempotencyKeyHash: "event-id-hash",
          materialShape: "source:rawKind:resourceName:eventTime",
        },
      },
    },
    ...overrides,
  };
}

function httpEntry(overrides = {}) {
  return {
    timestamp: "2026-07-01T20:30:01Z",
    severity: "INFO",
    resource: {
      labels: {
        revision_name: "chat-ai-sdk-dev-webhook-00001-test",
      },
    },
    httpRequest: {
      requestMethod: "POST",
      requestUrl:
        "https://chat-ai-sdk-dev-webhook.example.run.app/api/chat/events",
      status: 200,
      latency: "0.1s",
    },
    ...overrides,
  };
}

test("resolveLogSmokeConfig refuses to run without explicit guard", () => {
  assert.throws(
    () =>
      resolveLogSmokeConfig({
        argv: ["node", "chat-log-smoke.mjs", "--since=2026-07-01T20:30:00Z"],
        env: {
          GOOGLE_CLOUD_PROJECT: "example-chat-project",
        },
      }),
    /RUN_LIVE_CHAT_LOG_SMOKE=1/,
  );
});

test("dry-run plan includes redacted Cloud Logging filters", () => {
  const config = resolveLogSmokeConfig({
    argv: [
      "node",
      "chat-log-smoke.mjs",
      "--dry-run",
      "--since=2026-07-01T20:30:00Z",
      "--expect-events=1",
      "--expect-http-posts=1",
      "--expect-event-type=message",
    ],
    env: env(),
  });
  const plan = buildLogSmokePlan(config);

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.project, "example-chat-project");
  assert.equal(plan.expectations.events, 1);
  assert.match(plan.filters.errors, /severity>=ERROR/);
  assert.match(plan.filters.events, /jsonPayload.event="chat_event_received"/);
  assert.match(plan.filters.httpPosts, /requestUrl:"\/api\/chat\/events"/);
});

test("runLogSmoke summarizes matching event and http logs without raw payloads", async () => {
  const config = resolveLogSmokeConfig({
    argv: [
      "node",
      "chat-log-smoke.mjs",
      "--since=2026-07-01T20:30:00Z",
      "--expect-events=2",
      "--expect-http-posts=2",
      "--expect-event-type=message",
      "--expect-card-action-state",
      "--expect-mention-count=1",
      "--expect-attachment-count=1",
      "--expect-attachment-data-ref-count=0",
      "--expect-drive-attachment-count=1",
      "--expect-quoted-message",
      "--expect-quote-depth=1",
      "--expect-event-identity",
      "--expect-duplicate-deliveries=1",
      "--expect-idempotency-mode=firestore",
    ],
    env: env(),
  });
  const result = await runLogSmoke(config, {
    writeEvidence: false,
    readLogs(filter) {
      if (filter.includes("severity>=ERROR")) {
        return [];
      }
      if (filter.includes("jsonPayload.event")) {
        return [
          eventEntry({
            jsonPayload: {
              ...eventEntry().jsonPayload,
              duplicateDelivery: false,
              eventDebugSummary: {
                ...eventEntry().jsonPayload.eventDebugSummary,
                relationship: {
                  hasThread: true,
                  hasQuotedMessage: true,
                  quoteDepth: 1,
                  hasSlashCommand: false,
                  hasAppCommand: false,
                  hasAction: true,
                },
                message: {
                  ...eventEntry().jsonPayload.eventDebugSummary.message,
                  attachments: {
                    count: 1,
                    items: [
                      {
                        contentType: "application/vnd.google-apps.document",
                        source: "DRIVE_FILE",
                        hasAttachmentDataRef: false,
                        hasDriveDataRef: true,
                        driveFileIdAvailable: true,
                      },
                    ],
                  },
                },
                action: {
                  ...eventEntry().jsonPayload.eventDebugSummary.action,
                  cardActionState: {
                    present: true,
                    decoded: true,
                    encodedLength: 120,
                    encodedHash: "state-hash",
                    topLevelKeys: ["approval", "cursor"],
                    nestedObjectKeys: {
                      approval: ["id", "version"],
                    },
                  },
                },
              },
            },
          }),
          eventEntry({
            jsonPayload: {
              ...eventEntry().jsonPayload,
              duplicateDelivery: true,
              idempotency: {
                mode: "firestore",
                claimed: false,
                duplicate: true,
                seenCount: 2,
              },
              eventDebugSummary: {
                ...eventEntry().jsonPayload.eventDebugSummary,
                relationship: {
                  hasThread: true,
                  hasQuotedMessage: true,
                  quoteDepth: 1,
                  hasSlashCommand: false,
                  hasAppCommand: false,
                  hasAction: true,
                },
                message: {
                  ...eventEntry().jsonPayload.eventDebugSummary.message,
                  attachments: {
                    count: 1,
                    items: [
                      {
                        contentType: "application/vnd.google-apps.document",
                        source: "DRIVE_FILE",
                        hasAttachmentDataRef: false,
                        hasDriveDataRef: true,
                        driveFileIdAvailable: true,
                      },
                    ],
                  },
                },
              },
            },
          }),
        ];
      }
      if (filter.includes("requestUrl")) {
        return [httpEntry(), httpEntry()];
      }
      return [];
    },
  });
  const serialized = JSON.stringify(result.evidence);

  assert.equal(result.ok, true);
  assert.equal(result.evidence.assertions.expectedEventCountMatches, true);
  assert.equal(result.evidence.assertions.expectedHttpPostCountMatches, true);
  assert.equal(result.evidence.assertions.expectedCardActionStateMatches, true);
  assert.equal(result.evidence.assertions.expectedMentionCountMatches, true);
  assert.equal(result.evidence.assertions.expectedAttachmentCountMatches, true);
  assert.equal(result.evidence.assertions.expectedAttachmentDataRefCountMatches, true);
  assert.equal(result.evidence.assertions.expectedDriveAttachmentCountMatches, true);
  assert.equal(result.evidence.assertions.expectedQuotedMessageMatches, true);
  assert.equal(result.evidence.assertions.expectedQuoteDepthMatches, true);
  assert.equal(result.evidence.assertions.expectedEventIdentityMatches, true);
  assert.equal(result.evidence.assertions.expectedDuplicateDeliveryCountMatches, true);
  assert.equal(result.evidence.assertions.expectedIdempotencyModeMatches, true);
  assert.equal(result.evidence.logs.events[0].idempotency.mode, "firestore");
  assert.deepEqual(
    result.evidence.logs.events[0].debugSummary.action.cardActionState
      .topLevelKeys,
    ["approval", "cursor"],
  );
  assert.equal(result.evidence.assertions.noCloudRunErrors, true);
  assert.equal(serialized.includes("private-message-id"), false);
  assert.equal(serialized.includes("raw mention text"), false);
  assert.equal(serialized.includes("card-action-smoke-page-2"), false);
});

test("runLogSmoke fails when expected count does not match", async () => {
  const config = resolveLogSmokeConfig({
    argv: [
      "node",
      "chat-log-smoke.mjs",
      "--since=2026-07-01T20:30:00Z",
      "--expect-events=1",
      "--expect-http-posts=1",
    ],
    env: env(),
  });

  await assert.rejects(
    () =>
      runLogSmoke(config, {
        writeEvidence: false,
        readLogs(filter) {
          if (filter.includes("requestUrl")) {
            return [httpEntry()];
          }
          return [];
        },
      }),
    /expectedEventCountMatches/,
  );
});

test("runLogSmoke treats omitted optional expectations as unasserted", async () => {
  const config = {
    dryRun: false,
    project: "example-chat-project",
    service: "chat-ai-sdk-dev-webhook",
    since: "2026-07-01T20:30:00Z",
    until: null,
    limit: 100,
    runId: "partial-expectation-test",
    evidencePath: null,
    expectations: {
      events: 1,
      httpPosts: 1,
      eventType: "message",
      mentionCount: 1,
      attachmentCount: 0,
    },
  };

  const result = await runLogSmoke(config, {
    writeEvidence: false,
    readLogs(filter) {
      if (filter.includes("severity>=ERROR")) {
        return [];
      }
      if (filter.includes("jsonPayload.event")) {
        return [eventEntry()];
      }
      if (filter.includes("requestUrl")) {
        return [httpEntry()];
      }
      return [];
    },
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.evidence.assertions.expectedAttachmentDataRefCountMatches,
    null,
  );
  assert.equal(
    result.evidence.assertions.expectedDriveAttachmentCountMatches,
    null,
  );
  assert.equal(result.evidence.assertions.expectedQuotedMessageMatches, null);
  assert.equal(result.evidence.assertions.expectedQuoteDepthMatches, null);
  assert.equal(result.evidence.assertions.expectedCardActionStateMatches, null);
  assert.equal(
    result.evidence.assertions.expectedDuplicateDeliveryCountMatches,
    null,
  );
  assert.equal(result.evidence.assertions.expectedIdempotencyModeMatches, null);
});
