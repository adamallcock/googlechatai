import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { GoogleChatAI, expressAdapter } from "../src/index.js";

const root = path.resolve(import.meta.dirname, "../../..");

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

class FakeExpressResponse {
  statusCode = 200;
  headers = new Map<string, string>();
  body = "";

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  end(chunk?: string): this {
    this.body = chunk ?? "";
    return this;
  }
}

describe("runtime adapters", () => {
  it("adapts the runtime to an Express-style request handler without requiring Express as a dependency", async () => {
    const raw = readJson("fixtures/events/message-created/basic.json");
    const chat = new GoogleChatAI({ source: "fixture" });
    const next = vi.fn();

    chat.onMessage((_event, ctx) => ctx.reply.text("Express adapter handled it."));

    const handler = expressAdapter(chat);
    const req = Object.assign(new EventEmitter(), {
      method: "POST",
      url: "/chat/events",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    const res = new FakeExpressResponse();

    await handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(res.body)).toEqual({ text: "Express adapter handled it." });
  });

  it("runs configured request verification before an Express handler can see a payload", async () => {
    const raw = readJson("fixtures/events/message-created/basic.json");
    const verifier = vi.fn(async (request: Request) => {
      expect(request.headers.get("authorization")).toBe("Bearer forged-token");
      return { ok: false, status: "wrong_audience", reason: "test rejection" };
    });
    const chat = new GoogleChatAI({ source: "fixture", verifier });
    const handler = vi.fn(() => ({ text: "must not run" }));
    chat.onMessage(handler);
    const res = new FakeExpressResponse();

    await expressAdapter(chat)(
      Object.assign(new EventEmitter(), {
        method: "POST",
        url: "/chat/events",
        headers: {
          authorization: "Bearer forged-token",
          "content-type": "application/json",
        },
        body: raw,
      }),
      res,
    );

    expect(verifier).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: {
        code: "unauthorized_request",
        message: "Google Chat request verification failed.",
      },
    });
  });

  it("enforces POST before verification through the Express adapter", async () => {
    const verifier = vi.fn(async () => ({ ok: true }));
    const chat = new GoogleChatAI({ source: "fixture", verifier });
    const res = new FakeExpressResponse();

    await expressAdapter(chat)(
      Object.assign(new EventEmitter(), {
        method: "GET",
        url: "/chat/events",
        headers: {},
      }),
      res,
    );

    expect(verifier).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body)).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Google Chat event endpoints accept POST requests.",
      },
    });
  });

  it("returns a safe invalid-JSON response through the verified Express path", async () => {
    const chat = new GoogleChatAI({ source: "fixture" });
    const res = new FakeExpressResponse();

    await expressAdapter(chat)(
      Object.assign(new EventEmitter(), {
        method: "POST",
        url: "/chat/events",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: {
        code: "invalid_json",
        message: "Expected a JSON Google Chat event payload.",
      },
    });
  });

  it("returns verification-unavailable instead of passing verifier exceptions to a handler", async () => {
    const raw = readJson("fixtures/events/message-created/basic.json");
    const chat = new GoogleChatAI({
      source: "fixture",
      verifier: async () => {
        throw new Error("JWKS temporarily unavailable");
      },
    });
    const handler = vi.fn(() => ({ text: "must not run" }));
    chat.onMessage(handler);
    const res = new FakeExpressResponse();

    await expressAdapter(chat)(
      Object.assign(new EventEmitter(), {
        method: "POST",
        url: "/chat/events",
        headers: { "content-type": "application/json" },
        body: raw,
      }),
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toEqual({
      error: {
        code: "verification_unavailable",
        message: "Google Chat request verification failed to run.",
      },
    });
  });

  it("returns a bounded 413 response before parsing an oversized Express request", async () => {
    const chat = new GoogleChatAI({ source: "fixture" });
    const res = new FakeExpressResponse();

    await expressAdapter(chat, { maxBodyBytes: 16 })(
      Object.assign(new EventEmitter(), {
        method: "POST",
        url: "/chat/events",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "payload is deliberately too large" }),
      }),
      res,
    );

    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({
      error: {
        code: "payload_too_large",
        message: "Google Chat event payload exceeds the 16 byte limit.",
      },
    });
  });

  it("rejects a declared oversized request before consuming an Express stream", async () => {
    const chat = new GoogleChatAI({ source: "fixture" });
    const res = new FakeExpressResponse();
    const req = Object.assign(new EventEmitter(), {
      method: "POST",
      url: "/chat/events",
      headers: {
        "content-type": "application/json",
        "content-length": "99",
      },
    });
    const on = vi.spyOn(req, "on");

    await expressAdapter(chat, { maxBodyBytes: 16 })(req, res);

    expect(res.statusCode).toBe(413);
    expect(on).not.toHaveBeenCalled();
  });
});
