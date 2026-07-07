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
});
