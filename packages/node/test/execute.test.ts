import { describe, expect, it } from "vitest";

import {
  CHAT_API_BASE_URL,
  executeChatPlan,
} from "../src/execute/index.js";
import {
  planCompletePlaceholderResponse,
  planSendToSpace,
  planSendToUser,
  planStreamMessage,
} from "../src/messages/index.js";
import { InMemoryIdempotencyStore } from "../src/transport/index.js";

const auth = {
  getAccessToken: () => ({ accessToken: "test-token" }),
};

interface RecordedCall {
  url: string;
  method: string;
  body: string | undefined;
}

function fakeFetch(
  respond: (call: RecordedCall, index: number) => { status: number; body: unknown },
): { fetch: (url: string, init: any) => Promise<Response>; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    fetch: async (url: string, init: any) => {
      const call = { url, method: init.method, body: init.body };
      calls.push(call);
      const { status, body } = respond(call, calls.length - 1);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

function sendToSpacePlan(): Record<string, unknown> {
  return planSendToSpace({
    space: "spaces/AAA",
    text: "Hello",
    requestId: "req-fixed",
    clientMessageId: "client-fixed",
  });
}

describe("executeChatPlan dry runs", () => {
  it("defaults to dryRun and never touches the network", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const execution = await executeChatPlan(sendToSpacePlan(), { auth, fetch });
    expect(execution.mode).toBe("dryRun");
    expect(execution.ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect(execution.steps[0]?.status).toBe("planned");
    expect(execution.steps[0]?.url).toBe(
      `${CHAT_API_BASE_URL}/v1/spaces/AAA/messages?requestId=req-fixed&messageId=client-fixed`,
    );
  });

  it("reports capability blocks in dry runs", async () => {
    const plan = planSendToUser({
      email: "ada@example.com",
      text: "hi",
      requestId: "req-fixed",
      clientMessageId: "client-fixed",
    });
    const execution = await executeChatPlan(plan, {});
    expect(execution.ok).toBe(false);
    expect(execution.blocked?.reason).toBe("capability");
    expect(execution.steps.every((step) => step.status === "planned")).toBe(true);
  });

  it("marks unresolved placeholders without failing the dry run", async () => {
    const plan = planSendToUser({
      email: "ada@example.com",
      text: "hi",
      requestId: "req-fixed",
      clientMessageId: "client-fixed",
    });
    const execution = await executeChatPlan(plan, {});
    const second = execution.steps[1]!;
    expect(second.skippedReason).toBe("unresolved_placeholder");
    expect(second.url).toContain("{resolvedDirectMessageSpace}");
  });

  it("rejects plans without requests", async () => {
    await expect(
      executeChatPlan({ kind: "chat.async_response_plan" }),
    ).rejects.toThrow(/plan\.requests/);
  });

  it("rejects unknown modes", async () => {
    await expect(
      executeChatPlan(sendToSpacePlan(), { mode: "yolo" as never }),
    ).rejects.toThrow(/dryRun or live/);
  });
});

describe("executeChatPlan live", () => {
  it("executes requests sequentially and captures created messages", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { name: "spaces/AAA/messages/BBB" },
    }));
    const execution = await executeChatPlan(sendToSpacePlan(), {
      mode: "live",
      auth,
      fetch,
    });
    expect(execution.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `${CHAT_API_BASE_URL}/v1/spaces/AAA/messages?requestId=req-fixed&messageId=client-fixed`,
    );
    expect(execution.steps[0]!.status).toBe("executed");
    expect(execution.steps[0]!.httpStatus).toBe(200);
    expect(execution.createdMessages).toEqual([
      { name: "spaces/AAA/messages/BBB" },
    ]);
  });

  it("blocks direct-message plans unless explicitly allowed", async () => {
    const plan = planSendToUser({
      email: "ada@example.com",
      text: "hi",
      requestId: "req-fixed",
      clientMessageId: "client-fixed",
    });
    const blockedRun = await executeChatPlan(plan, {
      mode: "live",
      auth,
      fetch: fakeFetch(() => ({ status: 200, body: {} })).fetch,
    });
    expect(blockedRun.ok).toBe(false);
    expect(blockedRun.blocked?.reason).toBe("capability");
    expect(blockedRun.steps.every((step) => step.status === "skipped")).toBe(true);
  });

  it("resolves the direct-message placeholder from the find response", async () => {
    const plan = planSendToUser({
      email: "ada@example.com",
      text: "hi",
      requestId: "req-fixed",
      clientMessageId: "client-fixed",
    });
    const { fetch, calls } = fakeFetch((call) =>
      call.url.includes("findDirectMessage")
        ? { status: 200, body: { name: "spaces/DM123" } }
        : { status: 200, body: { name: "spaces/DM123/messages/M1" } },
    );
    const execution = await executeChatPlan(plan, {
      mode: "live",
      auth,
      fetch,
      overrideCapability: true,
      allowDirectMessages: true,
    });
    expect(execution.ok).toBe(true);
    expect(calls[1]!.url).toContain("/v1/spaces/DM123/messages");
    expect(execution.resolvedPlaceholders.resolvedDirectMessageSpace).toBe(
      "spaces/DM123",
    );
  });

  it("fails with a typed error when a placeholder cannot resolve", async () => {
    const plan = planSendToUser({
      email: "ada@example.com",
      text: "hi",
      requestId: "req-fixed",
      clientMessageId: "client-fixed",
    });
    const { fetch } = fakeFetch(() => ({ status: 200, body: {} }));
    const execution = await executeChatPlan(plan, {
      mode: "live",
      auth,
      fetch,
      overrideCapability: true,
      allowDirectMessages: true,
    });
    expect(execution.ok).toBe(false);
    expect(execution.steps[1]!.error?.name).toBe("UnresolvedPlaceholderError");
  });

  it("applies stream throttle delays through the injected sleeper", async () => {
    const plan = planStreamMessage({
      space: "spaces/AAA",
      initialText: "Thinking...",
      message: "spaces/AAA/messages/M1",
      patchTexts: ["first", "first second"],
      throttleMs: 750,
      requestId: "req-fixed",
      clientMessageId: "client-fixed",
    });
    const delays: number[] = [];
    const { fetch } = fakeFetch(() => ({ status: 200, body: { name: "spaces/AAA/messages/M1" } }));
    const execution = await executeChatPlan(plan, {
      mode: "live",
      auth,
      fetch,
      sleepMs: async (delayMs) => {
        delays.push(delayMs);
      },
    });
    expect(execution.ok).toBe(true);
    expect(delays).toEqual([750]);
    expect(execution.steps[1]!.throttleAppliedMs).toBe(750);
    expect(execution.steps[2]!.throttleAppliedMs).toBe(0);
  });

  it("skips duplicate request ids via the idempotency store", async () => {
    const store = new InMemoryIdempotencyStore();
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { name: "spaces/AAA/messages/BBB" },
    }));
    const first = await executeChatPlan(sendToSpacePlan(), {
      mode: "live",
      auth,
      fetch,
      idempotencyStore: store,
    });
    const second = await executeChatPlan(sendToSpacePlan(), {
      mode: "live",
      auth,
      fetch,
      idempotencyStore: store,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.steps[0]!.status).toBe("skipped");
    expect(second.steps[0]!.skippedReason).toBe("duplicate_request_id");
    expect(calls).toHaveLength(1);
  });

  it("reports missing auth for the plan auth mode", async () => {
    const execution = await executeChatPlan(sendToSpacePlan(), {
      mode: "live",
      auth: { user: auth },
      fetch: fakeFetch(() => ({ status: 200, body: {} })).fetch,
    });
    expect(execution.ok).toBe(false);
    expect(execution.blocked?.reason).toBe("missing_auth");
  });

  it("records failures and stops the plan", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 403,
      body: { error: { message: "denied" } },
    }));
    const execution = await executeChatPlan(sendToSpacePlan(), {
      mode: "live",
      auth,
      fetch,
    });
    expect(execution.ok).toBe(false);
    expect(execution.steps[0]!.status).toBe("failed");
    expect(execution.steps[0]!.httpStatus).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("falls back to creating a new message when a placeholder patch fails", async () => {
    const plan = planCompletePlaceholderResponse({
      handle: {
        kind: "chat.placeholder_response_handle",
        space: "spaces/AAA",
        messageName: "spaces/AAA/messages/PLACEHOLDER",
        editable: true,
        authMode: "app",
        allowedUpdateMasks: ["text"],
      },
      text: "final answer",
      onPatchFailure: "createNewMessage",
      fallbackRequestId: "req-fallback",
      fallbackClientMessageId: "client-fallback",
    });
    const { fetch, calls } = fakeFetch((call) =>
      call.method === "PATCH"
        ? { status: 404, body: { error: { message: "gone" } } }
        : { status: 200, body: { name: "spaces/AAA/messages/NEW" } },
    );
    const execution = await executeChatPlan(plan, {
      mode: "live",
      auth,
      fetch,
    });
    expect(execution.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(execution.steps[0]!.status).toBe("failed");
    expect(execution.steps[0]!.fallback?.status).toBe("executed");
    expect(execution.createdMessages).toEqual([
      { name: "spaces/AAA/messages/NEW" },
    ]);
  });
});
