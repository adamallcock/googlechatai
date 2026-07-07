import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  advanceStreamScheduler,
  createStreamSchedulerState,
  FileStreamCancellationRegistry,
  InMemoryStreamCancellationRegistry,
  replayStreamScheduler,
  streamChatReply,
  type ChatStreamApplyRequest,
  type StreamSchedulerAction,
} from "../src/streaming/index.js";

const root = path.resolve(import.meta.dirname, "../../..");

function readJson(relativePath: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

async function* chunks(...texts: string[]): AsyncGenerator<string> {
  for (const text of texts) {
    yield text;
  }
}

interface AppliedCall {
  request: ChatStreamApplyRequest;
}

function fakeApplier(
  respond?: (request: ChatStreamApplyRequest, index: number) => {
    ok: boolean;
    status: number;
    json?: unknown;
  },
): {
  apply: (request: ChatStreamApplyRequest) => Promise<any>;
  calls: AppliedCall[];
} {
  const calls: AppliedCall[] = [];
  return {
    calls,
    apply: async (request) => {
      calls.push({ request });
      const result = respond?.(request, calls.length - 1) ?? {
        ok: true,
        status: 200,
        json: { name: `spaces/AAA/messages/generated-${calls.length}` },
      };
      return {
        ok: result.ok,
        status: result.status,
        json: result.json ?? {},
        error: result.ok
          ? null
          : { name: "HttpError", message: `HTTP ${result.status}` },
      };
    },
  };
}

describe("stream scheduler conformance fixtures", () => {
  it("replays every shared scheduler case identically", () => {
    const cases = readJson("conformance/cases/stream.scheduler.json");
    for (const conformanceCase of cases) {
      const result = JSON.parse(
        JSON.stringify(replayStreamScheduler(conformanceCase.input)),
      );
      expect(result, conformanceCase.id).toEqual(conformanceCase.expect);
    }
  });

  it("rejects unknown event types and foreign state kinds", () => {
    const state = createStreamSchedulerState();
    expect(() =>
      advanceStreamScheduler(state, { type: "nope", atMs: 0 } as never),
    ).toThrow(/Unsupported stream scheduler event type/);
    expect(() =>
      advanceStreamScheduler({ kind: "wrong" }, { type: "flush", atMs: 0 }),
    ).toThrow(/state\.kind/);
  });

  it("rejects invalid overflow modes", () => {
    expect(() => createStreamSchedulerState({ overflow: "wrap" as never })).toThrow(
      /truncate or split/,
    );
  });
});

describe("streamChatReply", () => {
  const target = {
    messageName: "spaces/AAA/messages/PLACEHOLDER",
    space: "spaces/AAA",
    threadName: "spaces/AAA/threads/TTT",
  };

  it("patches at the configured cadence and finalizes with exact text", async () => {
    const { apply, calls } = fakeApplier();
    let now = 0;
    const report = await streamChatReply(
      target,
      chunks("hello ", "world, this is ", "a streamed reply"),
      {
        apply,
        clock: () => (now += 200),
        minPatchChars: 10,
        minIntervalMs: 100,
      },
    );
    expect(report.ok).toBe(true);
    expect(report.finalText).toBe("hello world, this is a streamed reply");
    expect(report.cancelled).toBe(false);
    const finals = calls.filter((call) => call.request.final);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.request.body.text).toBe(
      "hello world, this is a streamed reply",
    );
    expect(finals[0]!.request.path).toBe("/v1/spaces/AAA/messages/PLACEHOLDER");
    expect(report.patches).toBe(calls.length);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("accepts placeholder response handles as targets", async () => {
    const { apply, calls } = fakeApplier();
    const report = await streamChatReply(
      {
        kind: "chat.placeholder_response_handle",
        space: "spaces/AAA",
        messageName: "spaces/AAA/messages/FROMHANDLE",
        editable: true,
      },
      chunks("short answer"),
      { apply, clock: () => 0 },
    );
    expect(report.ok).toBe(true);
    expect(calls[0]!.request.path).toBe("/v1/spaces/AAA/messages/FROMHANDLE");
  });

  it("rejects unhydrated placeholder handles", async () => {
    await expect(
      streamChatReply(
        {
          kind: "chat.placeholder_response_handle",
          space: "spaces/AAA",
          messageName: null,
          editable: false,
        },
        chunks("x"),
        { apply: fakeApplier().apply },
      ),
    ).rejects.toThrow(/editable placeholder response handle/);
  });

  it("attaches final cards on the finalize patch", async () => {
    const { apply, calls } = fakeApplier();
    const cards = [{ cardId: "sources", card: {} }];
    const report = await streamChatReply(target, chunks("answer body"), {
      apply,
      clock: () => 0,
      finalCards: cards,
    });
    expect(report.ok).toBe(true);
    const final = calls.at(-1)!.request;
    expect(final.query.updateMask).toBe("text,cardsV2");
    expect(final.body.cardsV2).toEqual(cards);
  });

  it("creates continuation messages in split mode", async () => {
    const { apply, calls } = fakeApplier();
    const longText = `${"word ".repeat(60)}`.trim();
    const report = await streamChatReply(target, chunks(longText), {
      apply,
      clock: () => 0,
      overflow: "split",
      maxMessageChars: 120,
      minPatchChars: 10,
      minIntervalMs: 0,
    });
    expect(report.ok).toBe(true);
    expect(report.continuations.length).toBeGreaterThan(0);
    const creates = calls.filter((call) => call.request.kind === "create");
    expect(creates.length).toBe(report.continuations.length);
    expect(creates[0]!.request.body.thread).toEqual({
      name: "spaces/AAA/threads/TTT",
    });
    const lastPatch = calls.at(-1)!.request;
    expect(lastPatch.path).toBe(`/v1/${report.continuations.at(-1)}`);
  });

  it("downgrades split to truncate when the target has no space", async () => {
    const { apply, calls } = fakeApplier();
    const report = await streamChatReply(
      { messageName: "spaces/AAA/messages/NO-SPACE" },
      chunks("x".repeat(500)),
      {
        apply,
        clock: () => 0,
        overflow: "split",
        maxMessageChars: 120,
      },
    );
    expect(report.ok).toBe(true);
    expect(report.truncated).toBe(true);
    expect(report.continuations).toEqual([]);
    expect(calls.every((call) => call.request.kind === "patch")).toBe(true);
  });

  it("cancels between chunks via shouldCancel", async () => {
    const { apply, calls } = fakeApplier();
    const registry = new InMemoryStreamCancellationRegistry();
    let emitted = 0;
    async function* slowStream() {
      yield "first part of the answer ";
      emitted += 1;
      registry.cancel("stream-1", "user pressed stop");
      yield "second part";
      emitted += 1;
    }
    const report = await streamChatReply(target, slowStream(), {
      apply,
      clock: () => 0,
      shouldCancel: () => registry.isCancelled("stream-1"),
    });
    expect(report.cancelled).toBe(true);
    expect(report.ok).toBe(true);
    expect(emitted).toBe(1);
    const final = calls.at(-1)!.request;
    expect(final.final).toBe(true);
    expect(String(final.body.text)).toContain("[Stopped at user request.]");
  });

  it("honors AbortSignal", async () => {
    const { apply } = fakeApplier();
    const controller = new AbortController();
    async function* stream() {
      yield "part one ";
      controller.abort();
      yield "part two";
    }
    const report = await streamChatReply(target, stream(), {
      apply,
      clock: () => 0,
      signal: controller.signal,
    });
    expect(report.cancelled).toBe(true);
  });

  it("finalizes with the error note when the stream throws", async () => {
    const { apply, calls } = fakeApplier();
    async function* failing() {
      yield "partial output ";
      throw new Error("model exploded");
    }
    const report = await streamChatReply(target, failing(), {
      apply,
      clock: () => 0,
    });
    expect(report.ok).toBe(false);
    expect(report.errored).toBe(true);
    expect(report.failure?.message).toBe("model exploded");
    const final = calls.at(-1)!.request;
    expect(String(final.body.text)).toContain(
      "[Response interrupted by an error.]",
    );
  });

  it("degrades to final-only after repeated patch failures but still finalizes", async () => {
    let now = 0;
    const { apply, calls } = fakeApplier((request) =>
      request.final
        ? { ok: true, status: 200 }
        : { ok: false, status: 429 },
    );
    const report = await streamChatReply(
      target,
      chunks("a".repeat(30), "b".repeat(30), "c".repeat(30), "d".repeat(30)),
      {
        apply,
        clock: () => (now += 1000),
        minPatchChars: 10,
        minIntervalMs: 0,
        maxConsecutivePatchFailures: 2,
      },
    );
    expect(report.ok).toBe(true);
    expect(report.degradedToFinalOnly).toBe(true);
    expect(report.warnings).toContain(
      "degraded_to_final_only_after_patch_failures",
    );
    const nonFinalPatches = calls.filter(
      (call) => call.request.kind === "patch" && !call.request.final,
    );
    expect(nonFinalPatches.length).toBe(2);
  });

  it("reports failure when the final patch cannot be applied", async () => {
    const { apply } = fakeApplier((request) =>
      request.final ? { ok: false, status: 500 } : { ok: true, status: 200 },
    );
    const report = await streamChatReply(target, chunks("something"), {
      apply,
      clock: () => 0,
    });
    expect(report.ok).toBe(false);
    expect(report.failure?.name).toBe("HttpError");
  });

  it("emits resumable state snapshots and resumes from them", async () => {
    const states: any[] = [];
    const firstApplier = fakeApplier();
    let now = 0;
    async function* interrupted() {
      yield "the first half of a long answer that keeps going ";
      throw new Error("worker restarted");
    }
    const firstReport = await streamChatReply(target, interrupted(), {
      apply: firstApplier.apply,
      clock: () => (now += 500),
      minPatchChars: 10,
      minIntervalMs: 0,
      onState: (state) => states.push(JSON.parse(JSON.stringify(state))),
    });
    expect(firstReport.ok).toBe(false);
    const resumeFrom = states.find((state) => state.finished !== true);
    expect(resumeFrom).toBeDefined();

    const secondApplier = fakeApplier();
    const resumedReport = await streamChatReply(
      target,
      chunks("and the second half"),
      {
        apply: secondApplier.apply,
        clock: () => (now += 500),
        resumeState: resumeFrom,
      },
    );
    expect(resumedReport.ok).toBe(true);
    expect(resumedReport.finalText).toContain("the first half");
    expect(resumedReport.finalText).toContain("and the second half");
  });

  it("requires an apply function", async () => {
    await expect(
      streamChatReply(target, chunks("x"), {} as never),
    ).rejects.toThrow(/options\.apply/);
  });
});

describe("stream cancellation registries", () => {
  it("tracks cancellation in memory", () => {
    const registry = new InMemoryStreamCancellationRegistry();
    expect(registry.isCancelled("s1")).toBe(false);
    registry.cancel("s1", "stop");
    expect(registry.isCancelled("s1")).toBe(true);
    expect(registry.reason("s1")).toBe("stop");
    registry.clear("s1");
    expect(registry.isCancelled("s1")).toBe(false);
  });

  it("persists cancellation to disk for cross-process cancels", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-stream-cancel-"));
    const filePath = path.join(dir, "cancels.json");
    const writer = new FileStreamCancellationRegistry({ filePath });
    const reader = new FileStreamCancellationRegistry({ filePath });
    expect(await reader.isCancelled("s1")).toBe(false);
    await writer.cancel("s1", "card button");
    expect(await reader.isCancelled("s1")).toBe(true);
    expect(await reader.reason("s1")).toBe("card button");
    await writer.clear("s1");
    expect(await reader.isCancelled("s1")).toBe(false);
  });
});
