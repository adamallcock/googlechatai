import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";

import {
  buildIdempotencyMonitorPlan,
  loadIdempotencyMonitorConfig,
  runIdempotencyMonitor,
} from "./idempotency-monitor.mjs";

function env(overrides = {}) {
  return {
    RUN_LIVE_IDEMPOTENCY_MONITOR: "1",
    GOOGLE_CLOUD_PROJECT: "example-chat-project",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/unused-service-account.json",
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_RUN_ID: "idempotency-monitor-test",
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EXPECTED_EVENTS_PER_MINUTE: "10",
    GOOGLE_CHAT_IDEMPOTENCY_MONITOR_RETENTION_MINUTES: "10",
    ...overrides,
  };
}

function jsonResponse(json, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return json;
    },
  };
}

function aggregationResponse(count) {
  return [
    {
      result: {
        aggregateFields: {
          doc_count: {
            integerValue: String(count),
          },
        },
      },
    },
  ];
}

function runQueryResponse() {
  return [
    {
      document: {
        name:
          "projects/example-chat-project/databases/(default)/documents/googleChatEventIdempotency/private-key-hash",
        fields: {
          firstSeenAt: { timestampValue: "2026-07-02T15:25:44.000Z" },
          lastSeenAt: { timestampValue: "2026-07-02T15:25:45.000Z" },
          expiresAt: { timestampValue: "2026-07-02T15:35:44.000Z" },
          seenCount: { integerValue: "2" },
          metadataJson: {
            stringValue: "{\"must\":\"not appear in evidence\"}",
          },
        },
      },
    },
  ];
}

function fakeFetch({
  ttlStatus = 200,
  ttlBody = {
    name: "projects/example-chat-project/databases/(default)/collectionGroups/googleChatEventIdempotency/fields/expiresAt",
    ttlConfig: { state: "ACTIVE" },
  },
  count = 2,
  expiredCount = 0,
} = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : null,
    });

    if (
      String(url) ===
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
    ) {
      return jsonResponse({
        access_token: "metadata-token",
        expires_in: 3599,
        token_type: "Bearer",
      });
    }
    if (String(url).includes("/collectionGroups/")) {
      return jsonResponse(ttlBody, { status: ttlStatus });
    }
    if (String(url).endsWith(":runAggregationQuery")) {
      const body = JSON.parse(init.body);
      if (body.structuredAggregationQuery.structuredQuery.where) {
        return jsonResponse(aggregationResponse(expiredCount));
      }
      return jsonResponse(aggregationResponse(count));
    }
    if (String(url).endsWith(":runQuery")) {
      return jsonResponse(runQueryResponse());
    }
    if (String(url) === "https://logging.googleapis.com/v2/entries:write") {
      return jsonResponse({});
    }

    throw new Error(`Unexpected request ${url}`);
  };

  return { requests, fetchImpl };
}

test("loadIdempotencyMonitorConfig refuses live run without explicit guard", () => {
  assert.throws(
    () =>
      loadIdempotencyMonitorConfig({
        argv: ["node", "idempotency-monitor.mjs"],
        env: {},
      }),
    /RUN_LIVE_IDEMPOTENCY_MONITOR=1/,
  );
});

test("live monitor requires explicit thresholds or a rate-and-retention capacity budget", () => {
  assert.throws(
    () =>
      loadIdempotencyMonitorConfig({
        argv: ["node", "idempotency-monitor.mjs"],
        env: env({
          GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EXPECTED_EVENTS_PER_MINUTE: undefined,
          GOOGLE_CHAT_IDEMPOTENCY_MONITOR_RETENTION_MINUTES: undefined,
        }),
      }),
    /Live monitoring requires/,
  );
  const config = loadIdempotencyMonitorConfig({
    argv: [
      "node",
      "idempotency-monitor.mjs",
      "--expected-events-per-minute=12",
      "--retention-minutes=10",
    ],
    env: env({
      GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EXPECTED_EVENTS_PER_MINUTE: undefined,
      GOOGLE_CHAT_IDEMPOTENCY_MONITOR_RETENTION_MINUTES: undefined,
    }),
  });
  assert.deepEqual(config.capacityBudget, {
    configured: true,
    source: "rate_and_retention",
    expectedEventsPerMinute: 12,
    retentionMinutes: 10,
    baselineDocuments: 120,
  });
  assert.equal(config.warnDocs, 180);
  assert.equal(config.failDocs, 240);
});

test("buildIdempotencyMonitorPlan is read-only and redacted", () => {
  const config = loadIdempotencyMonitorConfig({
    argv: ["node", "idempotency-monitor.mjs", "--dry-run"],
    env: env(),
  });
  const plan = buildIdempotencyMonitorPlan(config);

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.calls.length, 4);
  assert.equal(plan.calls.every((call) => call.writes === false), true);
  assert.equal(plan.privacy.rawDocumentNamesSaved, false);
  assert.equal(plan.privacy.rawEventKeysSaved, false);
  assert.equal(plan.privacy.metadataJsonSaved, false);
});

test("loadIdempotencyMonitorConfig supports metadata-server auth without key path", () => {
  const config = loadIdempotencyMonitorConfig({
    argv: ["node", "idempotency-monitor.mjs", "--dry-run", "--auth=metadata"],
    env: env(),
  });

  assert.equal(config.authMode, "metadata");
  assert.equal(config.credentialsPath, null);
});

test("runIdempotencyMonitor can fetch access tokens from metadata server", async () => {
  const config = loadIdempotencyMonitorConfig({
    argv: ["node", "idempotency-monitor.mjs", "--auth=metadata"],
    env: env(),
  });
  const fake = fakeFetch({ count: 2, expiredCount: 0 });
  const result = await runIdempotencyMonitor(config, {
    writeEvidence: false,
    fetchImpl: fake.fetchImpl,
  });

  const metadataRequest = fake.requests.find((request) =>
    request.url.includes("metadata.google.internal"),
  );
  const firestoreRequest = fake.requests.find((request) =>
    request.url.includes("firestore.googleapis.com"),
  );

  assert.equal(result.ok, true);
  assert.equal(metadataRequest.method, "GET");
  assert.equal(metadataRequest.headers["Metadata-Flavor"], "Google");
  assert.equal(firestoreRequest.headers.authorization, "Bearer metadata-token");
});

test("runIdempotencyMonitor fails before network when service account key is missing", async () => {
  const config = loadIdempotencyMonitorConfig({
    argv: ["node", "idempotency-monitor.mjs"],
    env: env({ GOOGLE_APPLICATION_CREDENTIALS: "/tmp/missing-monitor-key.json" }),
  });

  await assert.rejects(
    () =>
      runIdempotencyMonitor(config, {
        writeEvidence: false,
        fetchImpl: fakeFetch().fetchImpl,
      }),
    (error) => {
      assert.match(error.message, /access-token/);
      assert.equal(error.evidence.failure.stage, "access-token");
      assert.equal(error.evidence.privacy.rawErrorMessagesSaved, false);
      return true;
    },
  );
});

test("buildIdempotencyMonitorPlan shows Cloud Logging write when enabled", () => {
  const config = loadIdempotencyMonitorConfig({
    argv: ["node", "idempotency-monitor.mjs", "--dry-run", "--write-cloud-log"],
    env: env(),
  });
  const plan = buildIdempotencyMonitorPlan(config);

  assert.equal(plan.calls.length, 5);
  assert.deepEqual(
    plan.calls.map((call) => [call.operation, call.writes]),
    [
      ["firestore.fields.get.ttl", false],
      ["firestore.documents.runAggregationQuery.count", false],
      ["firestore.documents.runAggregationQuery.expiredCount", false],
      ["firestore.documents.runQuery.sample", false],
      ["logging.entries.write.monitor-result", true],
    ],
  );
  assert.equal(plan.cloudLog.enabled, true);
  assert.equal(plan.privacy.rawDocumentNamesSaved, false);
  assert.equal(plan.privacy.rawEventKeysSaved, false);
  assert.equal(plan.privacy.metadataJsonSaved, false);
});

test("runIdempotencyMonitor summarizes Firestore collection health without raw keys", async () => {
  const config = loadIdempotencyMonitorConfig({
    argv: ["node", "idempotency-monitor.mjs"],
    env: env(),
  });
  const fake = fakeFetch({ count: 2, expiredCount: 0 });
  const result = await runIdempotencyMonitor(config, {
    writeEvidence: false,
    fetchImpl: fake.fetchImpl,
    getAccessToken: async () => "test-token",
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.counts.documents, 2);
  assert.equal(result.evidence.counts.expiredDocuments, 0);
  assert.equal(result.evidence.ttl.state, "ACTIVE");
  assert.equal(result.evidence.sample.seenCount.max, 2);
  assert.equal(result.evidence.sample.seenCount.duplicateDocuments, 1);
  assert.equal(result.evidence.privacy.rawDocumentNamesSaved, false);
  assert.equal(result.evidence.privacy.metadataJsonSaved, false);
  assert.equal(JSON.stringify(result.evidence).includes("private-key-hash"), false);
  assert.equal(JSON.stringify(result.evidence).includes("must"), false);
  assert.equal(
    fake.requests.some((request) => request.method !== "GET" && request.method !== "POST"),
    false,
  );
});

test("runIdempotencyMonitor counts expired documents with a bounded filtered aggregation", async () => {
  const config = loadIdempotencyMonitorConfig({
    argv: [
      "node",
      "idempotency-monitor.mjs",
      "--expired-warn-docs=2",
      "--expired-fail-docs=3",
    ],
    env: env(),
  });
  const fake = fakeFetch({ count: 2, expiredCount: 2 });
  const result = await runIdempotencyMonitor(config, {
    writeEvidence: false,
    fetchImpl: fake.fetchImpl,
    getAccessToken: async () => "test-token",
  });
  const expiredAggregation = fake.requests.find(
    (request) => request.body?.structuredAggregationQuery?.structuredQuery?.where,
  );

  assert.equal(result.evidence.counts.expiredDocuments, 2);
  assert.ok(expiredAggregation);
  assert.equal(
    expiredAggregation.body.structuredAggregationQuery.structuredQuery.where.fieldFilter.field.fieldPath,
    "expiresAt",
  );
});

test("runIdempotencyMonitor targets an exact nested collection path and custom TTL field", async () => {
  const config = loadIdempotencyMonitorConfig({
    argv: [
      "node",
      "idempotency-monitor.mjs",
      "--collection=apps/tenant/claims",
      "--ttl-field=expiry",
      "--allow-ttl-unknown",
    ],
    env: env(),
  });
  const fake = fakeFetch({
    ttlBody: {
      name: "projects/example-chat-project/databases/(default)/collectionGroups/claims/fields/expiry",
      ttlConfig: { state: "ACTIVE" },
    },
  });
  await runIdempotencyMonitor(config, {
    writeEvidence: false,
    fetchImpl: fake.fetchImpl,
    getAccessToken: async () => "test-token",
  });
  const aggregation = fake.requests.find(
    (request) =>
      request.method === "POST" &&
      request.url.endsWith(":runAggregationQuery") &&
      request.body?.structuredAggregationQuery?.structuredQuery?.where === undefined,
  );
  const sample = fake.requests.find((request) => request.url.endsWith(":runQuery"));

  assert.match(aggregation.url, /documents\/apps\/tenant:runAggregationQuery$/);
  assert.equal(
    aggregation.body.structuredAggregationQuery.structuredQuery.from[0].collectionId,
    "claims",
  );
  assert.equal(
    Object.hasOwn(aggregation.body.structuredAggregationQuery.structuredQuery.from[0], "allDescendants"),
    false,
  );
  assert.equal(sample.body.structuredQuery.select.fields[2].fieldPath, "expiry");
});

test("runIdempotencyMonitor bounds diagnostic sample size", () => {
  assert.throws(
    () =>
      loadIdempotencyMonitorConfig({
        argv: ["node", "idempotency-monitor.mjs", "--sample-limit=101"],
        env: env(),
      }),
    /--sample-limit must be at most 100/,
  );
});

test("runIdempotencyMonitor accepts explicit service-account credentials", async () => {
  const keyPath = `/tmp/idempotency-monitor-test-key-${process.pid}.json`;
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 1024,
  });
  await fs.writeFile(
    keyPath,
    JSON.stringify({
      client_email: "monitor@example.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
  );
  try {
    const config = loadIdempotencyMonitorConfig({
      argv: ["node", "idempotency-monitor.mjs"],
      env: env({ GOOGLE_APPLICATION_CREDENTIALS: keyPath }),
    });
    const fake = fakeFetch({ count: 2, expiredCount: 0 });
    const result = await runIdempotencyMonitor(config, {
      writeEvidence: false,
      fetchImpl: async (url, init = {}) => {
        if (String(url) === "https://oauth2.googleapis.com/token") {
          return jsonResponse({ access_token: "key-token" });
        }
        return fake.fetchImpl(url, init);
      },
    });
    const firestoreRequest = fake.requests.find((request) =>
      request.url.includes("firestore.googleapis.com"),
    );

    assert.equal(result.ok, true);
    assert.equal(firestoreRequest.headers.authorization, "Bearer key-token");
  } finally {
    await fs.rm(keyPath, { force: true });
  }
});

test("runIdempotencyMonitor writes redacted Cloud Logging warning summary", async () => {
  const config = loadIdempotencyMonitorConfig({
    argv: ["node", "idempotency-monitor.mjs", "--write-cloud-log"],
    env: env(),
  });
  const fake = fakeFetch({ count: 2, expiredCount: 1 });
  const result = await runIdempotencyMonitor(config, {
    writeEvidence: false,
    fetchImpl: fake.fetchImpl,
    getAccessToken: async () => "test-token",
  });

  const loggingRequest = fake.requests.find((request) =>
    request.url.includes("logging.googleapis.com"),
  );

  assert.equal(result.ok, true);
  assert.equal(result.evidence.cloudLog.enabled, true);
  assert.equal(result.evidence.cloudLog.written, true);
  assert.equal(result.evidence.cloudLog.severity, "WARNING");
  assert.ok(loggingRequest);
  assert.equal(loggingRequest.method, "POST");
  assert.equal(loggingRequest.body.entries[0].severity, "WARNING");
  assert.equal(
    loggingRequest.body.entries[0].jsonPayload.event,
    "google_chat_idempotency_monitor",
  );
  assert.equal(loggingRequest.body.entries[0].jsonPayload.warningCount, 1);
  assert.equal(loggingRequest.body.entries[0].jsonPayload.failureCount, 0);
  assert.equal(JSON.stringify(loggingRequest.body).includes("private-key-hash"), false);
  assert.equal(JSON.stringify(loggingRequest.body).includes("must"), false);
});

test("runIdempotencyMonitor fails when count reaches fail threshold", async () => {
  const config = loadIdempotencyMonitorConfig({
    argv: [
      "node",
      "idempotency-monitor.mjs",
      "--fail-docs=2",
      "--warn-docs=1",
    ],
    env: env(),
  });
  const fake = fakeFetch({ count: 2, expiredCount: 0 });

  await assert.rejects(
    () =>
      runIdempotencyMonitor(config, {
        writeEvidence: false,
        fetchImpl: fake.fetchImpl,
        getAccessToken: async () => "test-token",
      }),
    /doc-count-2-gte-fail-2/,
  );
});

test("runIdempotencyMonitor writes error Cloud Logging summary before failing", async () => {
  const config = loadIdempotencyMonitorConfig({
    argv: [
      "node",
      "idempotency-monitor.mjs",
      "--write-cloud-log",
      "--fail-docs=2",
      "--warn-docs=1",
    ],
    env: env(),
  });
  const fake = fakeFetch({ count: 2, expiredCount: 0 });

  await assert.rejects(
    () =>
      runIdempotencyMonitor(config, {
        writeEvidence: false,
        fetchImpl: fake.fetchImpl,
        getAccessToken: async () => "test-token",
      }),
    (error) => {
      assert.match(error.message, /doc-count-2-gte-fail-2/);
      assert.equal(error.evidence.cloudLog.enabled, true);
      assert.equal(error.evidence.cloudLog.written, true);
      assert.equal(error.evidence.cloudLog.severity, "ERROR");
      return true;
    },
  );

  const loggingRequest = fake.requests.find((request) =>
    request.url.includes("logging.googleapis.com"),
  );
  assert.equal(loggingRequest.body.entries[0].severity, "ERROR");
  assert.equal(loggingRequest.body.entries[0].jsonPayload.failureCount, 1);
});

test("runIdempotencyMonitor emits a redacted failure summary when Firestore fails before evidence", async () => {
  const config = loadIdempotencyMonitorConfig({
    argv: ["node", "idempotency-monitor.mjs", "--write-cloud-log"],
    env: env(),
  });
  const fake = fakeFetch();
  await assert.rejects(
    () =>
      runIdempotencyMonitor(config, {
        writeEvidence: false,
        getAccessToken: async () => "test-token",
        fetchImpl: async (url, init) => {
          if (String(url).endsWith(":runAggregationQuery")) {
            return jsonResponse(
              { error: { status: "PERMISSION_DENIED", message: "private document details" } },
              { status: 403 },
            );
          }
          return fake.fetchImpl(url, init);
        },
      }),
    (error) => {
      assert.match(error.message, /document-count/);
      assert.equal(error.evidence.cloudLog.written, true);
      assert.equal(error.evidence.failure.status, 403);
      assert.equal(error.evidence.privacy.rawErrorMessagesSaved, false);
      return true;
    },
  );
  const loggingRequest = fake.requests.find((request) =>
    request.url.includes("logging.googleapis.com"),
  );
  assert.ok(loggingRequest);
  assert.equal(loggingRequest.body.entries[0].jsonPayload.failureCount, 1);
  assert.equal(JSON.stringify(loggingRequest.body).includes("private document details"), false);
});

test("runIdempotencyMonitor can allow TTL metadata to be unavailable", async () => {
  const config = loadIdempotencyMonitorConfig({
    argv: [
      "node",
      "idempotency-monitor.mjs",
      "--allow-ttl-unknown",
    ],
    env: env(),
  });
  const fake = fakeFetch({
    ttlStatus: 403,
    ttlBody: { error: { status: "PERMISSION_DENIED" } },
    count: 1,
    expiredCount: 0,
  });
  const result = await runIdempotencyMonitor(config, {
    writeEvidence: false,
    fetchImpl: fake.fetchImpl,
    getAccessToken: async () => "test-token",
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.ttl.available, false);
  assert.equal(result.evidence.ttl.error.status, 403);
});
