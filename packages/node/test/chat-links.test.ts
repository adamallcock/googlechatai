import { describe, expect, it } from "vitest";

import {
  buildChatLinkCacheKey,
  collectChatLinkCandidates,
  createChatLinkRetrievalPlan,
  normalizeMessage,
} from "../src/index.js";

const CHAT_MESSAGE_READ_SCOPE = "https://www.googleapis.com/auth/chat.messages.readonly";
const CHAT_SPACE_READ_SCOPE = "https://www.googleapis.com/auth/chat.spaces.readonly";
const CHAT_APP_MESSAGE_READ_SCOPE = "https://www.googleapis.com/auth/chat.app.messages.readonly";

describe("chat link retrieval planning", () => {
  it("prefers structured chatSpaceLinkData over brittle browser URL parsing", () => {
    const raw = {
      name: "spaces/AAA/messages/source",
      text: "See launch thread",
      createTime: "2026-07-05T15:00:00Z",
      annotations: [
        {
          type: "RICH_LINK",
          startIndex: 4,
          length: 13,
          richLinkMetadata: {
            uri: "https://chat.google.com/u/0/app/chat/AAA/AAA/thread-1?cls=7",
            richLinkType: "CHAT_SPACE",
            title: "Launch thread",
            chatSpaceLinkData: {
              space: "spaces/AAA",
              thread: "spaces/AAA/threads/thread-1",
              message: "spaces/AAA/messages/msg-1",
              spaceDisplayName: "Launch Review",
            },
          },
        },
      ],
    };
    const normalized = normalizeMessage(raw);

    expect(normalized.links[0]).toMatchObject({
      kind: "richLink",
      chatSpaceLinkData: {
        space: "spaces/AAA",
        thread: "spaces/AAA/threads/thread-1",
        message: "spaces/AAA/messages/msg-1",
        spaceDisplayName: "Launch Review",
      },
    });

    expect(collectChatLinkCandidates(normalized)).toEqual([
      {
        kind: "chat_link",
        candidateId: "chat-link-1",
        source: "chat_space_link_data",
        originalUrl: "https://chat.google.com/u/0/app/chat/AAA/AAA/thread-1?cls=7",
        title: "Launch thread",
        parseStatus: "parsed",
        confidence: "high",
        scope: "message",
        space: "spaces/AAA",
        thread: "spaces/AAA/threads/thread-1",
        message: "spaces/AAA/messages/msg-1",
        resourceName: "spaces/AAA/messages/msg-1",
        urlShape: "chat_space_link_data",
        context: {
          messageName: "spaces/AAA/messages/source",
          relationship: "self",
          path: ["self:spaces/AAA/messages/source"],
          sender: null,
          createdAt: "2026-07-05T15:00:00Z",
          updatedAt: null,
          deletedAt: null,
          accessState: null,
        },
        warnings: [],
      },
    ]);
  });

  it("parses known Chat URL shapes and keeps unknown Chat URLs visible without API calls", () => {
    const candidates = collectChatLinkCandidates({
      links: [
        {
          kind: "plain_url",
          url: "https://mail.google.com/mail/u/0/#chat/space/AAA",
        },
        {
          kind: "matchedUrl",
          url: "https://chat.google.com/room/AAA/thread-1?cls=11",
        },
        {
          kind: "plain_url",
          url: "https://chat.google.com/u/2/app/chat/BBB",
        },
        {
          kind: "plain_url",
          url: "https://chat.google.com/u/2/app/chat/BBB/BBB/thread-9",
        },
        {
          kind: "plain_url",
          url: "https://example.test/room/AAA",
        },
      ],
    });

    expect(
      candidates.map((candidate) => ({
        source: candidate.source,
        parseStatus: candidate.parseStatus,
        confidence: candidate.confidence,
        scope: candidate.scope,
        space: candidate.space,
        thread: candidate.thread,
        message: candidate.message,
        resourceName: candidate.resourceName,
        urlShape: candidate.urlShape,
        warnings: candidate.warnings,
      })),
    ).toEqual([
      {
        source: "plain_url",
        parseStatus: "parsed",
        confidence: "high",
        scope: "space",
        space: "spaces/AAA",
        thread: null,
        message: null,
        resourceName: "spaces/AAA",
        urlShape: "gmail_hash_space",
        warnings: [],
      },
      {
        source: "matched_url",
        parseStatus: "parsed",
        confidence: "low",
        scope: "thread",
        space: "spaces/AAA",
        thread: "spaces/AAA/threads/thread-1",
        message: null,
        resourceName: "spaces/AAA/threads/thread-1",
        urlShape: "chat_room_thread",
        warnings: ["Thread URL shape is empirical; verify with live corpus before treating as a stable Google contract."],
      },
      {
        source: "plain_url",
        parseStatus: "parsed",
        confidence: "medium",
        scope: "space",
        space: "spaces/BBB",
        thread: null,
        message: null,
        resourceName: "spaces/BBB",
        urlShape: "chat_app_space",
        warnings: [],
      },
      {
        source: "plain_url",
        parseStatus: "unknown",
        confidence: "unknown",
        scope: "unknown",
        space: null,
        thread: null,
        message: null,
        resourceName: null,
        urlShape: "unknown_chat_url",
        warnings: ["Chat URL shape is not recognized; retained for corpus collection but no API request will be planned."],
      },
    ]);
  });

  it("pins the parser matrix for documented, observed, empirical, and unknown URL shapes", () => {
    const cases = [
      {
        url: "https://mail.google.com/mail/u/0/#chat/space/AAA?ignored=1",
        shape: "gmail_hash_space",
        confidence: "high",
        scope: "space",
        resourceName: "spaces/AAA",
      },
      {
        url: "https://mail.google.com/chat/u/0/#chat/space/GCHAT",
        shape: "gmail_chat_hash_space",
        confidence: "medium",
        scope: "space",
        resourceName: "spaces/GCHAT",
      },
      {
        url: "https://chat.google.com/room/ROOM?cls=11#ignored",
        shape: "chat_room_space",
        confidence: "medium",
        scope: "space",
        resourceName: "spaces/ROOM",
      },
      {
        url: "https://chat.google.com/room/THREAD/thread-1?cls=11",
        shape: "chat_room_thread",
        confidence: "low",
        scope: "thread",
        resourceName: "spaces/THREAD/threads/thread-1",
      },
      {
        url: "https://chat.google.com/u/2/app/chat/BBB",
        shape: "chat_app_space",
        confidence: "medium",
        scope: "space",
        resourceName: "spaces/BBB",
      },
      {
        url: "https://mail.google.com/mail/u/0/extra/#chat/space/AAA",
        shape: "unknown_chat_url",
        confidence: "unknown",
        scope: "unknown",
        resourceName: null,
      },
      {
        url: "https://mail.google.com/chat/u/0/extra/#chat/space/AAA",
        shape: "unknown_chat_url",
        confidence: "unknown",
        scope: "unknown",
        resourceName: null,
      },
      {
        url: "https://mail.google.com/mail/u/notnum/#chat/space/AAA",
        shape: "unknown_chat_url",
        confidence: "unknown",
        scope: "unknown",
        resourceName: null,
      },
      {
        url: "https://chat.google.com/u/notnum/app/chat/BBB",
        shape: "unknown_chat_url",
        confidence: "unknown",
        scope: "unknown",
        resourceName: null,
      },
      {
        url: "https://mail.google.com/mail/u/0/#chat/dm/AAA",
        shape: "unknown_chat_url",
        confidence: "unknown",
        scope: "unknown",
        resourceName: null,
      },
      {
        url: "https://mail.google.com/mail/u/0/#chat/space/AAA%2FBBB",
        shape: "unknown_chat_url",
        confidence: "unknown",
        scope: "unknown",
        resourceName: null,
      },
      {
        url: "https://mail.google.com/mail/u/0/#chat/space/AAA/thread-1",
        shape: "unknown_chat_url",
        confidence: "unknown",
        scope: "unknown",
        resourceName: null,
      },
      {
        url: "https://chat.google.com/room/AAA%2FBBB",
        shape: "unknown_chat_url",
        confidence: "unknown",
        scope: "unknown",
        resourceName: null,
      },
      {
        url: "https://chat.google.com/u/2/app/chat/BBB/BBB/thread-9",
        shape: "unknown_chat_url",
        confidence: "unknown",
        scope: "unknown",
        resourceName: null,
      },
      {
        url: "https://chat.google.com/room/AAA/thread%22x",
        shape: "unknown_chat_url",
        confidence: "unknown",
        scope: "unknown",
        resourceName: null,
      },
      {
        url: "http://chat.google.com/room/AAA",
        shape: "unknown_chat_url",
        confidence: "unknown",
        scope: "unknown",
        resourceName: null,
      },
      {
        url: "http://mail.google.com/mail/u/0/#chat/space/AAA",
        shape: "unknown_chat_url",
        confidence: "unknown",
        scope: "unknown",
        resourceName: null,
      },
    ];

    expect(
      collectChatLinkCandidates({
        links: cases.map((item) => ({ kind: "plain_url", url: item.url })),
      }).map((candidate) => ({
        shape: candidate.urlShape,
        confidence: candidate.confidence,
        scope: candidate.scope,
        resourceName: candidate.resourceName,
      })),
    ).toEqual(
      cases.map((item) => ({
        shape: item.shape,
        confidence: item.confidence,
        scope: item.scope,
        resourceName: item.resourceName,
      })),
    );
  });

  it("accepts a direct list of links", () => {
    expect(
      collectChatLinkCandidates([
        {
          kind: "plain_url",
          url: "https://chat.google.com/room/AAA",
        },
      ]),
    ).toMatchObject([
      {
        source: "plain_url",
        resourceName: "spaces/AAA",
        context: {
          relationship: "input",
          path: ["input"],
        },
      },
    ]);
  });

  it("can be disabled by feature flag option", () => {
    expect(
      collectChatLinkCandidates({
        text: "https://chat.google.com/room/AAA",
        options: {
          enabled: false,
        },
      }),
    ).toEqual([]);

    const plan = createChatLinkRetrievalPlan({
      links: [{ kind: "plain_url", url: "https://chat.google.com/room/AAA" }],
      options: {
        enabled: false,
      },
    });

    expect(plan).toMatchObject({
      status: "blocked",
      summary: "Chat link retrieval planning is disabled by option.",
      counts: {
        candidates: 0,
        plannedRequests: 0,
      },
      candidates: [],
      requests: [],
    });
    expect(plan.systemNotes).toContain(
      "System Note: Chat link retrieval planning is disabled by option.",
    );
  });

  it("carries source message sender and timestamp breadcrumbs", () => {
    const [candidate] = collectChatLinkCandidates({
      name: "spaces/AAA/messages/source",
      createTime: "2026-07-05T15:00:00Z",
      lastUpdateTime: "2026-07-05T15:05:00Z",
      sender: {
        name: "users/ada",
        displayName: "Ada Lovelace",
        email: "ada@example.com",
        type: "HUMAN",
      },
      links: [
        {
          kind: "plain_url",
          url: "https://chat.google.com/room/AAA",
        },
      ],
    });

    expect(candidate.context).toEqual({
      messageName: "spaces/AAA/messages/source",
      relationship: "self",
      path: ["self:spaces/AAA/messages/source"],
      sender: {
        displayName: "Ada Lovelace",
        email: "ada@example.com",
        resourceName: "users/ada",
        type: "HUMAN",
        accessState: "available",
        ambiguityState: "unambiguous",
      },
      createdAt: "2026-07-05T15:00:00Z",
      updatedAt: "2026-07-05T15:05:00Z",
      deletedAt: null,
      accessState: null,
    });
  });

  it("applies source toggles to annotation-derived matched and plain links", () => {
    const candidates = collectChatLinkCandidates(
      {
        annotations: [
          {
            kind: "matchedUrl",
            url: "https://chat.google.com/room/AAA",
          },
          {
            kind: "plain_url",
            url: "https://chat.google.com/room/BBB",
          },
          {
            kind: "richLink",
            url: "https://chat.google.com/room/CCC",
          },
        ],
      },
      {
        includeMatchedUrls: false,
        includePlainTextUrls: false,
      },
    );

    expect(candidates.map((candidate) => candidate.resourceName)).toEqual(["spaces/CCC"]);
  });

  it("applies rich-link source toggles to raw links and structured Chat metadata", () => {
    const candidates = collectChatLinkCandidates(
      {
        links: [
          {
            kind: "richLink",
            url: "https://chat.google.com/room/RICH",
          },
          {
            kind: "richLink",
            url: "https://chat.google.com/room/STRUCTURED",
            chatSpaceLinkData: {
              space: "spaces/STRUCTURED",
            },
          },
          {
            kind: "matchedUrl",
            url: "https://chat.google.com/room/MATCHED",
          },
          {
            kind: "plain_url",
            url: "https://chat.google.com/room/PLAIN",
          },
        ],
      },
      {
        includeRichLinks: false,
      },
    );

    expect(candidates.map((candidate) => candidate.resourceName)).toEqual([
      "spaces/MATCHED",
      "spaces/PLAIN",
    ]);
  });

  it("rejects cross-space chatSpaceLinkData instead of mixing resources", () => {
    const [candidate] = collectChatLinkCandidates({
      links: [
        {
          kind: "richLink",
          url: "https://chat.google.com/u/0/app/chat/AAA",
          chatSpaceLinkData: {
            message: "spaces/AAA/messages/msg-1",
            thread: "spaces/BBB/threads/thread-1",
          },
        },
      ],
    });

    expect(candidate).toMatchObject({
      parseStatus: "invalid",
      confidence: "unknown",
      scope: "unknown",
      resourceName: null,
      urlShape: "invalid_chat_space_link_data",
      warnings: ["chatSpaceLinkData resource names point at different spaces."],
    });
  });

  it("creates bounded dry-run calls with user-auth scopes and cache metadata hints", () => {
    const plan = createChatLinkRetrievalPlan({
      links: [
        {
          kind: "richLink",
          url: "https://chat.google.com/u/0/app/chat/AAA",
          title: "Message",
          chatSpaceLinkData: {
            space: "spaces/AAA",
            message: "spaces/AAA/messages/msg-1",
          },
        },
        {
          kind: "plain_url",
          url: "https://chat.google.com/room/AAA/thread-1",
        },
        {
          kind: "plain_url",
          url: "https://chat.google.com/u/2/app/chat/BBB",
        },
      ],
      options: {
        authMode: "user",
        allowSpaceLevelContext: true,
        maxThreadMessages: 12,
        maxSpaceMessages: 5,
        cache: {
          entriesByResourceName: {
            "spaces/AAA/messages/msg-1": {
              hit: true,
              key: "chat-link:cached-message",
              lastUpdateTime: "2026-07-05T15:10:00Z",
            },
          },
        },
      },
    });

    expect(plan).toMatchObject({
      kind: "chat.chat_link_retrieval_plan",
      status: "ready",
      dryRun: true,
      summary: "Planned 3 Google Chat link candidate reads; 1 cache hit can be reused after metadata revalidation.",
      counts: {
        candidates: 3,
        parsed: 3,
        unknown: 0,
        plannedRequests: 5,
        cacheHits: 1,
      },
      capability: {
        ok: true,
        authMode: "user",
        requiredScopes: [CHAT_MESSAGE_READ_SCOPE, CHAT_SPACE_READ_SCOPE],
      },
      safety: {
        liveAllowed: false,
        notes: ["Dry run only; no Google Chat API call was executed."],
      },
      systemNotes: [
        "System Note: Planned 3 linked Google Chat context reads in dry-run mode; no Google Chat API call was executed.",
        "System Note: Chat link cache keys use resource name plus lastUpdateTime when available so edited messages invalidate cached context.",
      ],
    });
    expect(plan.requests).toEqual([
      {
        candidateId: "chat-link-1",
        candidateIds: ["chat-link-1"],
        resource: "spaces.messages.get",
        method: "GET",
        path: "/v1/spaces/AAA/messages/msg-1",
        query: {
          fields: "name,lastUpdateTime,thread.name",
        },
        body: null,
        purpose: "read_message_or_revalidate_cache",
      },
      {
        candidateId: "chat-link-1",
        candidateIds: ["chat-link-1", "chat-link-2"],
        resource: "spaces.get",
        method: "GET",
        path: "/v1/spaces/AAA",
        query: {},
        body: null,
        purpose: "read_space_breadcrumb",
      },
      {
        candidateId: "chat-link-2",
        candidateIds: ["chat-link-2"],
        resource: "spaces.messages.list",
        method: "GET",
        path: "/v1/spaces/AAA/messages",
        query: {
          pageSize: 12,
          filter: 'thread.name = "spaces/AAA/threads/thread-1"',
          orderBy: "createTime asc",
        },
        body: null,
        purpose: "read_thread_context",
      },
      {
        candidateId: "chat-link-3",
        candidateIds: ["chat-link-3"],
        resource: "spaces.get",
        method: "GET",
        path: "/v1/spaces/BBB",
        query: {},
        body: null,
        purpose: "read_space_breadcrumb",
      },
      {
        candidateId: "chat-link-3",
        candidateIds: ["chat-link-3"],
        resource: "spaces.messages.list",
        method: "GET",
        path: "/v1/spaces/BBB/messages",
        query: {
          pageSize: 5,
          orderBy: "createTime desc",
        },
        body: null,
        purpose: "read_space_context",
      },
    ]);
    expect(plan.candidates[0].cache).toEqual({
      status: "hit",
      strategy: "resource_last_update_time",
      key: "chat-link:cached-message",
      resourceName: "spaces/AAA/messages/msg-1",
      lastUpdateTime: "2026-07-05T15:10:00Z",
      revalidateWith: "spaces.messages.get",
    });
  });

  it("deduplicates text URLs against matchedUrl metadata and trims terminal punctuation", () => {
    expect(
      collectChatLinkCandidates({
        text: "Discuss https://chat.google.com/room/AAA.",
        matchedUrl: {
          url: "https://chat.google.com/room/AAA",
        },
      }).map((candidate) => ({
        source: candidate.source,
        originalUrl: candidate.originalUrl,
        scope: candidate.scope,
        resourceName: candidate.resourceName,
      })),
    ).toEqual([
      {
        source: "matched_url",
        originalUrl: "https://chat.google.com/room/AAA",
        scope: "space",
        resourceName: "spaces/AAA",
      },
    ]);

    expect(
      collectChatLinkCandidates({
        text: "Discuss https://chat.google.com/room/AAA.",
      })[0],
    ).toMatchObject({
      source: "plain_url",
      originalUrl: "https://chat.google.com/room/AAA",
      scope: "space",
      resourceName: "spaces/AAA",
    });
  });

  it("ignores malformed plain-text URLs without dropping later Chat URLs", () => {
    expect(() =>
      collectChatLinkCandidates({
        text: "Bad https://[::1 then good https://chat.google.com/room/AAA",
      }),
    ).not.toThrow();

    expect(
      collectChatLinkCandidates({
        text: "Bad https://[::1 then good https://chat.google.com/room/AAA",
      }).map((candidate) => candidate.resourceName),
    ).toEqual(["spaces/AAA"]);
  });

  it("deduplicates repeated resources across contexts while preserving occurrences", () => {
    const plan = createChatLinkRetrievalPlan({
      messages: [
        {
          name: "spaces/AAA/messages/one",
          text: "https://chat.google.com/room/AAA",
        },
        {
          name: "spaces/AAA/messages/two",
          text: "https://chat.google.com/room/AAA",
        },
      ],
      options: {
        allowSpaceLevelContext: true,
      },
    });

    expect(plan.counts).toMatchObject({
      candidates: 1,
      plannedRequests: 2,
    });
    expect(plan.candidates[0]).toMatchObject({
      resourceName: "spaces/AAA",
      occurrences: [
        {
          messageName: "spaces/AAA/messages/one",
        },
        {
          messageName: "spaces/AAA/messages/two",
        },
      ],
    });
  });

  it("surfaces traversal caps and avoids queuing beyond wide-tree limits", () => {
    let siblingReads = 0;
    const messages = Array.from({ length: 20 });
    for (let index = 0; index < messages.length; index += 1) {
      Object.defineProperty(messages, index, {
        get() {
          siblingReads += 1;
          return {
            name: `spaces/AAA/messages/${index}`,
            text: `https://chat.google.com/room/${index}`,
          };
        },
      });
    }

    const plan = createChatLinkRetrievalPlan({
      messages,
      options: {
        maxTraversalNodes: 3,
        maxChatLinks: 1,
      },
    });

    expect(plan.status).toBe("partial");
    expect(plan.truncation).toMatchObject({
      status: "truncated",
      cappedCandidates: expect.any(Number),
      cappedTraversalNodes: expect.any(Number),
    });
    expect(siblingReads).toBe(2);
    expect(plan.counts.cappedCandidates).toBeGreaterThan(0);
    expect(plan.counts.cappedTraversalNodes).toBe(18);
    expect(plan.systemNotes).toContain(
      "System Note: Chat link traversal was capped; some linked Chat context may be omitted.",
    );
  });

  it("bounds plain-text scanning, oversized URLs, and occurrence breadcrumbs", () => {
    const longUrl = `https://chat.google.com/room/${"A".repeat(80)}`;
    const plan = createChatLinkRetrievalPlan({
      messages: [
        {
          name: "spaces/AAA/messages/one",
          text: `${longUrl} https://chat.google.com/room/OK trailing text beyond scan budget`,
        },
        {
          name: "spaces/AAA/messages/two",
          text: "https://chat.google.com/room/OK",
        },
        {
          name: "spaces/AAA/messages/three",
          text: "https://chat.google.com/room/OK",
        },
      ],
      options: {
        allowSpaceLevelContext: false,
        maxPlainTextScanChars: 145,
        maxUrlLength: 50,
        maxOccurrencesPerCandidate: 2,
      },
    });

    expect(plan.status).toBe("partial");
    expect(plan.candidates.map((candidate) => candidate.resourceName)).toEqual(["spaces/OK"]);
    expect(plan.candidates[0].occurrences).toHaveLength(2);
    expect(plan.counts).toMatchObject({
      cappedPlainTextScanChars: expect.any(Number),
      cappedOversizedUrls: 1,
      cappedOccurrences: 1,
    });
    expect(plan.truncation).toMatchObject({
      status: "truncated",
      cappedOversizedUrls: 1,
      cappedOccurrences: 1,
    });
    expect(plan.truncation.cappedPlainTextScanChars).toBeGreaterThan(0);
  });

  it("validates auth mode and app-auth read scopes", () => {
    expect(
      createChatLinkRetrievalPlan({
        links: [{ kind: "plain_url", url: "https://chat.google.com/room/AAA/thread-1" }],
        options: { authMode: "app" },
      }).capability,
    ).toMatchObject({
      ok: true,
      authMode: "app",
      requiredScopes: [CHAT_APP_MESSAGE_READ_SCOPE, "https://www.googleapis.com/auth/chat.bot"],
      requiresAdminApproval: true,
    });

    const invalid = createChatLinkRetrievalPlan({
      links: [{ kind: "plain_url", url: "https://chat.google.com/room/AAA" }],
      options: { authMode: "usr" },
    });

    expect(invalid).toMatchObject({
      status: "blocked",
      requests: [],
      capability: {
        ok: false,
        authMode: "usr",
        requiredScopes: [],
        reasons: ["invalid_auth_mode"],
      },
    });
  });

  it("ignores fractional and invalid positive integer options instead of emitting zero limits", () => {
    const plan = createChatLinkRetrievalPlan({
      links: [{ kind: "plain_url", url: "https://chat.google.com/room/AAA/thread-1" }],
      options: {
        maxThreadMessages: 0.5,
      },
    });

    expect(plan.requests[0].query.pageSize).toBe(50);
  });

  it("uses lazy cache lookups without normalizing unrelated cache entries", () => {
    const target = {
      "spaces/AAA/threads/thread-1": {
        hit: true,
        key: "chat-link:cached-thread",
        last_update_time: "2026-07-05T15:10:00Z",
      },
      "spaces/UNRELATED/messages/msg-1": {
        hit: true,
        key: "chat-link:unrelated",
      },
    };
    let ownKeys = 0;
    let unrelatedReads = 0;
    const entries = new Proxy(target, {
      ownKeys(value) {
        ownKeys += 1;
        return Reflect.ownKeys(value);
      },
      get(value, property, receiver) {
        if (property === "spaces/UNRELATED/messages/msg-1") {
          unrelatedReads += 1;
        }
        return Reflect.get(value, property, receiver);
      },
    });

    const plan = createChatLinkRetrievalPlan({
      links: [{ kind: "plain_url", url: "https://chat.google.com/room/AAA/thread-1" }],
      options: {
        cache: {
          entries_by_resource_name: entries,
        },
      },
    });

    expect(plan.candidates[0].cache).toMatchObject({
      status: "hit",
      key: "chat-link:cached-thread",
      lastUpdateTime: "2026-07-05T15:10:00Z",
    });
    expect(ownKeys).toBe(0);
    expect(unrelatedReads).toBe(0);
  });

  it("does not mutate context child ordering while traversing", () => {
    const first = { name: "spaces/AAA/messages/first", text: "first" };
    const second = { name: "spaces/AAA/messages/second", text: "second" };
    const input = { children: [first, second] };

    collectChatLinkCandidates(input);

    expect(input.children).toEqual([first, second]);
  });

  it("builds stable cache keys that change when Chat edit metadata changes", () => {
    expect(
      buildChatLinkCacheKey({
        resourceName: "spaces/AAA/messages/msg-1",
        lastUpdateTime: "2026-07-05T15:10:00Z",
      }),
    ).toEqual({
      namespace: "chat_link",
      key: "chat-link:5056f741a5be63d26305878efe1ac45c",
      resourceName: "spaces/AAA/messages/msg-1",
      lastUpdateTime: "2026-07-05T15:10:00Z",
    });
    expect(
      buildChatLinkCacheKey({
        resourceName: "spaces/AAA/messages/msg-1",
        lastUpdateTime: "2026-07-05T15:11:00Z",
      }).key,
    ).not.toBe("chat-link:5056f741a5be63d26305878efe1ac45c");
  });

  it("rejects invalid cache key resources", () => {
    expect(() => buildChatLinkCacheKey({ resourceName: "" })).toThrow(
      "Expected resourceName to be a non-empty string.",
    );
    expect(() =>
      buildChatLinkCacheKey({} as Parameters<typeof buildChatLinkCacheKey>[0]),
    ).toThrow("Expected resourceName to be a non-empty string.");
  });
});
