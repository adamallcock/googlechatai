import { describe, expect, it } from "vitest";

import {
  FirestoreIdempotencyStore,
  type FirestoreTransportRequest,
} from "../src/firestore/index.js";

type JsonObject = Record<string, unknown>;

function fakeFirestore() {
  const documents = new Map<string, { fields: JsonObject; updateTime: string }>();
  const requests: FirestoreTransportRequest[] = [];
  let revision = 0;

  const request = async (input: FirestoreTransportRequest) => {
    requests.push(input);
    const url = new URL(input.url);
    const documentPath = url.pathname;
    if (input.method === "POST") {
      const documentId = url.searchParams.get("documentId");
      const fullPath = `${documentPath}/${documentId}`;
      if (!documentId || documents.has(fullPath)) {
        return { status: 409 };
      }
      const document = {
        fields: (input.body?.fields ?? {}) as JsonObject,
        updateTime: `revision-${++revision}`,
      };
      documents.set(fullPath, document);
      return { status: 200, json: { ...document } };
    }

    const current = documents.get(documentPath);
    if (input.method === "GET") {
      return current ? { status: 200, json: { ...current } } : { status: 404 };
    }
    if (!current) {
      return { status: 404 };
    }
    if (url.searchParams.get("currentDocument.updateTime") !== current.updateTime) {
      return { status: 409 };
    }
    if (input.method === "DELETE") {
      documents.delete(documentPath);
      return { status: 200 };
    }
    const updated = {
      fields: { ...current.fields, ...(input.body?.fields as JsonObject) },
      updateTime: `revision-${++revision}`,
    };
    documents.set(documentPath, updated);
    return { status: 200, json: { ...updated } };
  };

  return { request, requests };
}

describe("FirestoreIdempotencyStore", () => {
  it("uses conditional creation and update-time CAS for duplicate claims", async () => {
    const firestore = fakeFirestore();
    const store = new FirestoreIdempotencyStore({
      projectId: "demo-project",
      collectionPath: "chatIdempotency",
      request: firestore.request,
    });

    const first = await store.claim({
      key: "event/with/private-looking-value",
      ttlMs: 100,
      nowMs: 1_000,
      metadata: { eventKind: "message.created" },
    });
    const duplicate = await store.claim({
      key: "event/with/private-looking-value",
      ttlMs: 100,
      nowMs: 1_050,
    });

    expect(first).toMatchObject({ claimed: true, duplicate: false, seenCount: 1 });
    expect(duplicate).toMatchObject({
      claimed: false,
      duplicate: true,
      seenCount: 2,
      metadata: { eventKind: "message.created" },
    });
    expect(firestore.requests[0]?.url).not.toContain("event/with/private-looking-value");
    expect(firestore.requests.some((request) => request.method === "PATCH")).toBe(true);
  });

  it("reclaims a document only after its observed expiry precondition", async () => {
    const firestore = fakeFirestore();
    const store = new FirestoreIdempotencyStore({
      projectId: "demo-project",
      collectionPath: "chatIdempotency",
      request: firestore.request,
    });

    await store.claim({ key: "event-1", ttlMs: 100, nowMs: 1_000 });
    const afterExpiry = await store.claim({ key: "event-1", ttlMs: 100, nowMs: 1_100 });

    expect(afterExpiry).toMatchObject({ claimed: true, duplicate: false, seenCount: 1 });
    expect(firestore.requests.some((request) => request.method === "DELETE")).toBe(true);
  });

  it("can avoid duplicate-delivery CAS writes on a hot ingress path", async () => {
    const firestore = fakeFirestore();
    const store = new FirestoreIdempotencyStore({
      projectId: "demo-project",
      collectionPath: "chatIdempotency",
      request: firestore.request,
      recordDuplicateDeliveries: false,
    });

    await store.claim({ key: "event-1", nowMs: 1_000 });
    const duplicate = await store.claim({ key: "event-1", nowMs: 1_050 });

    expect(duplicate).toMatchObject({ duplicate: true, seenCount: 1 });
    expect(firestore.requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("retries Firestore FAILED_PRECONDITION responses during a stale CAS", async () => {
    const firestore = fakeFirestore();
    let rejectFirstPatch = true;
    const store = new FirestoreIdempotencyStore({
      projectId: "demo-project",
      collectionPath: "chatIdempotency",
      request: async (request) => {
        if (request.method === "PATCH" && rejectFirstPatch) {
          rejectFirstPatch = false;
          return {
            status: 400,
            json: { error: { status: "FAILED_PRECONDITION" } },
          };
        }
        return firestore.request(request);
      },
      casRetryBaseDelayMs: 0,
    });

    await store.claim({ key: "event-1", nowMs: 1_000 });
    const duplicate = await store.claim({ key: "event-1", nowMs: 1_050 });

    expect(duplicate).toMatchObject({ duplicate: true, seenCount: 2 });
    expect(firestore.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
  });

  it("fails after bounded repeated Firestore precondition conflicts", async () => {
    const firestore = fakeFirestore();
    const store = new FirestoreIdempotencyStore({
      projectId: "demo-project",
      collectionPath: "chatIdempotency",
      request: async (request) => {
        if (request.method === "PATCH") {
          return {
            status: 400,
            json: { error: { status: "FAILED_PRECONDITION" } },
          };
        }
        return firestore.request(request);
      },
      maxCasAttempts: 2,
      casRetryBaseDelayMs: 0,
    });

    await store.claim({ key: "event-1", nowMs: 1_000 });
    await expect(store.claim({ key: "event-1", nowMs: 1_050 })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("requires a narrow authenticated transport and valid collection path", () => {
    expect(
      () =>
        new FirestoreIdempotencyStore({
          projectId: "demo-project",
          collectionPath: "collection/document",
          request: async () => ({ status: 200 }),
        }),
    ).toThrow(/collectionPath/);
    expect(
      () =>
        new FirestoreIdempotencyStore({
          projectId: "demo-project",
          collectionPath: "claims",
          request: undefined as never,
        }),
    ).toThrow(/request transport/);
  });
});
