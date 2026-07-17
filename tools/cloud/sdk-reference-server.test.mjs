import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import {
  createMetadataAccessTokenProvider,
  createMetadataFirestoreTransport,
  createServer,
  readBoundedBody,
  smokeCorrelationForText,
} from "../../examples/cloud-run-node-sdk/server.mjs";

async function startServer(options) {
  const server = createServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("Cloud Run SDK reference keeps a bounded ingress body as bytes until Fetch parses it", async () => {
  const request = Readable.from([Buffer.from('{"event":"fixture"}', "utf8")]);
  request.headers = {};
  const body = await readBoundedBody(request, 1_024);

  assert.equal(Buffer.isBuffer(body), true);
  assert.equal(body.toString("utf8"), '{"event":"fixture"}');
});

test("Cloud Run SDK reference routes local fixtures through GoogleChatAI.fetch", async () => {
  const listener = await startServer({ localFixtures: true });
  try {
    const payload = await fs.readFile("fixtures/events/message-created/basic.json", "utf8");
    const response = await fetch(`${listener.baseUrl}/chat/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      text: "Google Chat AI SDK Cloud Run reference received the event.",
    });
  } finally {
    await listener.close();
  }
});

test("Cloud Run SDK reference rejects an unverified request before dispatch", async () => {
  let verifierCalls = 0;
  const listener = await startServer({
    audience: "https://example.test",
    projectId: "example-project",
    verifier: async () => {
      verifierCalls += 1;
      return { ok: false, status: "missing_token", reason: "no token" };
    },
  });
  try {
    const response = await fetch(`${listener.baseUrl}/chat/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 401);
    assert.equal(verifierCalls, 1);
    assert.equal((await response.json()).error.code, "unauthorized_request");
  } finally {
    await listener.close();
  }
});

test("Cloud Run SDK reference caches metadata-server tokens before Firestore calls", async () => {
  let metadataCalls = 0;
  const getAccessToken = createMetadataAccessTokenProvider({
    now: () => 1_000,
    fetchImpl: async () => {
      metadataCalls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { access_token: "metadata-token", expires_in: 3_600 };
        },
      };
    },
  });

  assert.equal(await getAccessToken(), "metadata-token");
  assert.equal(await getAccessToken(), "metadata-token");
  assert.equal(metadataCalls, 1);
});

test("Cloud Run SDK reference coalesces concurrent metadata-token refreshes", async () => {
  let metadataCalls = 0;
  let releaseMetadata;
  const getAccessToken = createMetadataAccessTokenProvider({
    fetchImpl: async () => {
      metadataCalls += 1;
      await new Promise((resolve) => {
        releaseMetadata = resolve;
      });
      return {
        ok: true,
        status: 200,
        async json() {
          return { access_token: "metadata-token", expires_in: 3_600 };
        },
      };
    },
  });

  const pending = Promise.all(Array.from({ length: 20 }, () => getAccessToken()));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(metadataCalls, 1);
  releaseMetadata();
  assert.deepEqual(await pending, Array(20).fill("metadata-token"));
});

test("Cloud Run SDK reference aborts a stalled metadata request at its deadline", async () => {
  let receivedSignal;
  const getAccessToken = createMetadataAccessTokenProvider({
    timeoutMs: 5,
    fetchImpl: async (_url, init) => {
      receivedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });

  await assert.rejects(() => getAccessToken(), /metadata token request exceeded its 5ms deadline/);
  assert.equal(receivedSignal.aborted, true);
});

test("Cloud Run SDK reference keeps metadata tokens inside its Firestore transport", async () => {
  const requests = [];
  const transport = createMetadataFirestoreTransport({
    getAccessToken: async () => "metadata-token",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return {
        status: 409,
        async text() {
          return JSON.stringify({ error: { status: "ALREADY_EXISTS" } });
        },
      };
    },
  });

  const result = await transport({
    method: "POST",
    url: "https://firestore.googleapis.com/v1/test",
    body: { fields: {} },
  });

  assert.equal(result.status, 409);
  assert.deepEqual(result.json, { error: { status: "ALREADY_EXISTS" } });
  assert.equal(requests[0].init.headers.authorization, "Bearer metadata-token");
  assert.equal(requests[0].init.headers["content-type"], "application/json");
  assert.equal(JSON.stringify(result).includes("metadata-token"), false);
});

test("Cloud Run SDK reference aborts a stalled Firestore request at its deadline", async () => {
  let receivedSignal;
  const transport = createMetadataFirestoreTransport({
    timeoutMs: 5,
    getAccessToken: async () => "metadata-token",
    fetchImpl: async (_url, init) => {
      receivedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });

  await assert.rejects(
    () => transport({ method: "GET", url: "https://firestore.googleapis.com/v1/test" }),
    /Firestore request exceeded its 5ms deadline/,
  );
  assert.equal(receivedSignal.aborted, true);
});

test("Cloud Run SDK reference hashes only explicit manual smoke markers", () => {
  const correlation = smokeCorrelationForText("@GoogleChatAISDK googlechatai-smoke:staging-smoke-12345678");
  assert.match(correlation, /^[a-f0-9]{64}$/);
  assert.equal(smokeCorrelationForText("ordinary private message text"), null);
});

test("Cloud Run SDK reference health reports verified Firestore mode", async () => {
  const listener = await startServer({
    audience: "https://example.test",
    projectId: "example-project",
    verifier: async () => ({ ok: true }),
  });
  try {
    const response = await fetch(`${listener.baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "googlechatai-cloud-run-reference",
      verification: "google-chat-jwt",
      idempotency: "firestore",
    });
  } finally {
    await listener.close();
  }
});

test("Cloud Run SDK reference rejects oversized bodies before JSON parsing", async () => {
  const listener = await startServer({ localFixtures: true, maxBodyBytes: 8 });
  try {
    const response = await fetch(`${listener.baseUrl}/chat/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "0123456789",
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, "payload_too_large");
  } finally {
    await listener.close();
  }
});

test("Cloud Run SDK reference handles its default concurrency of near-limit fixture requests", async () => {
  const maxBodyBytes = 256 * 1024;
  const handledByteLengths = [];
  const payload = JSON.stringify({
    event: "fixture",
    padding: "x".repeat(maxBodyBytes - 128),
  });
  const payloadByteLength = Buffer.byteLength(payload);
  assert.ok(payloadByteLength <= maxBodyBytes);
  assert.ok(payloadByteLength > maxBodyBytes * 0.99);

  const listener = await startServer({
    localFixtures: true,
    maxBodyBytes,
    chat: {
      async fetch(request) {
        handledByteLengths.push(Buffer.byteLength(await request.text()));
        return new Response('{"ok":true}', {
          headers: { "content-type": "application/json" },
        });
      },
    },
  });
  try {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => fetch(`${listener.baseUrl}/chat/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      })),
    );
    assert.deepEqual(responses.map((response) => response.status), Array(20).fill(200));
    assert.deepEqual(handledByteLengths, Array(20).fill(payloadByteLength));
  } finally {
    await listener.close();
  }
});

test("Cloud Run SDK reference only accepts an injected runtime in explicit fixture mode", () => {
  assert.throws(
    () => createServer({ chat: { fetch: async () => new Response() } }),
    /only allowed with localFixtures: true/,
  );
});

test("Cloud Run SDK Dockerfile preserves the server import layout", async () => {
  const dockerfile = await fs.readFile("examples/cloud-run-node-sdk/Dockerfile", "utf8");
  assert.match(dockerfile, /FROM node:22-slim AS build/);
  assert.match(dockerfile, /COPY tsconfig\.base\.json \.\//);
  assert.match(
    dockerfile,
    /COPY --from=build \/app\/packages\/node\/dist \.\/packages\/node\/dist/,
  );
  assert.match(
    dockerfile,
    /COPY examples\/cloud-run-node-sdk\/server\.mjs \.\/examples\/cloud-run-node-sdk\/server\.mjs/,
  );
  assert.match(dockerfile, /CMD \["node", "examples\/cloud-run-node-sdk\/server\.mjs"\]/);
});

test("Cloud Run SDK reference rejects absolute request targets before a verifier sees them", async () => {
  const listener = await startServer({ localFixtures: true });
  try {
    const address = listener.server.address();
    assert.ok(address && typeof address === "object");
    const response = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: address.port,
          method: "POST",
          path: "http://attacker.invalid/chat/events",
          headers: { "content-type": "application/json" },
        },
        (incoming) => {
          const chunks = [];
          incoming.on("data", (chunk) => chunks.push(chunk));
          incoming.on("end", () => {
            resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString("utf8") });
          });
        },
      );
      request.once("error", reject);
      request.end("{}");
    });
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error.code, "invalid_request_target");
  } finally {
    await listener.close();
  }
});

test("Cloud Run SDK reference rejects backslash request-target origin confusion", async () => {
  const listener = await startServer({ localFixtures: true });
  try {
    const address = listener.server.address();
    assert.ok(address && typeof address === "object");
    const response = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: address.port,
          method: "POST",
          path: "/\\attacker.invalid/chat/events",
          headers: { "content-type": "application/json" },
        },
        (incoming) => {
          const chunks = [];
          incoming.on("data", (chunk) => chunks.push(chunk));
          incoming.on("end", () => {
            resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString("utf8") });
          });
        },
      );
      request.once("error", reject);
      request.end("{}");
    });
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error.code, "invalid_request_target");
  } finally {
    await listener.close();
  }
});
