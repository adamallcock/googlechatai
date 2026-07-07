import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  bearerTokenFromAuthorization,
  createChatRequestVerifier,
  createGoogleChatTokenVerifier,
  createPubSubPushVerifier,
  decodeJwtWithoutVerifying,
  GOOGLE_CHAT_JWKS_URL,
  GOOGLE_CHAT_TOKEN_ISSUER,
  GOOGLE_OIDC_ISSUERS,
  verifyChatRequestAuthorization,
  verifyGoogleChatToken,
} from "../src/verify/index.js";

const root = path.resolve(import.meta.dirname, "../../..");

function readJson(relativePath: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

const fixture = readJson("fixtures/verify/tokens.json");
const jwks = readJson("fixtures/verify/jwks.json");
const keys = jwks.keys;
const nowMs = fixture.nowMs;
const audience = fixture.audience;
const pushAudience = fixture.pushAudience;
const pushEmail = fixture.pushServiceAccountEmail;
const tokens = fixture.tokens;

function expected(name: string): any {
  return readJson(`fixtures/expected/verify/${name}.json`);
}

describe("verifyGoogleChatToken", () => {
  const base = { keys, audience, nowMs };

  const sharedCases: Array<[string, string | null, Record<string, unknown>]> = [
    ["valid-chat", tokens.validChat, base],
    ["expired-chat", tokens.expiredChat, base],
    ["not-yet-valid", tokens.notYetValid, base],
    ["wrong-audience", tokens.wrongAudience, base],
    ["wrong-issuer", tokens.wrongIssuer, base],
    ["bad-signature", tokens.badSignature, base],
    ["unknown-kid", tokens.unknownKid, base],
    ["alg-none", tokens.algNone, base],
    ["malformed", tokens.malformed, base],
    ["missing-token", null, base],
    [
      "pubsub-valid",
      tokens.pubsubValid,
      {
        keys,
        audience: pushAudience,
        issuers: GOOGLE_OIDC_ISSUERS,
        expectedEmail: pushEmail,
        nowMs,
      },
    ],
    [
      "pubsub-wrong-email",
      tokens.pubsubWrongEmail,
      {
        keys,
        audience: pushAudience,
        issuers: GOOGLE_OIDC_ISSUERS,
        expectedEmail: pushEmail,
        nowMs,
      },
    ],
    [
      "pubsub-unverified-email",
      tokens.pubsubUnverifiedEmail,
      {
        keys,
        audience: pushAudience,
        issuers: GOOGLE_OIDC_ISSUERS,
        expectedEmail: pushEmail,
        nowMs,
      },
    ],
    [
      "expired-with-skew",
      tokens.expiredChat,
      { keys, audience, nowMs, clockSkewMs: 10_000_000_000 },
    ],
  ];

  for (const [name, token, options] of sharedCases) {
    it(`matches the shared expected fixture for ${name}`, () => {
      const result = verifyGoogleChatToken(token, options as never);
      expect(result).toEqual(expected(name));
    });
  }

  it("accepts an array audience when one entry matches", () => {
    const result = verifyGoogleChatToken(tokens.validChat, {
      keys,
      audience: ["something-else", audience],
      nowMs,
    });
    expect(result.status).toBe("verified");
  });

  it("defaults issuers to the Google Chat system account", () => {
    const result = verifyGoogleChatToken(tokens.validChat, {
      keys,
      audience,
      nowMs,
    });
    expect(result.claims?.iss).toBe(GOOGLE_CHAT_TOKEN_ISSUER);
  });

  it("throws when keys are missing", () => {
    expect(() =>
      verifyGoogleChatToken(tokens.validChat, { audience } as never),
    ).toThrow(/options\.keys/);
  });

  it("throws when audience is empty", () => {
    expect(() =>
      verifyGoogleChatToken(tokens.validChat, { keys, audience: [] }),
    ).toThrow(/audience/);
  });
});

describe("decodeJwtWithoutVerifying", () => {
  it("round-trips header and payload", () => {
    const decoded = decodeJwtWithoutVerifying(tokens.validChat);
    expect(decoded.header.alg).toBe("RS256");
    expect(decoded.payload.aud).toBe(audience);
    expect(decoded.signingInput).toContain(".");
  });

  it("rejects non-jwt strings", () => {
    expect(() => decodeJwtWithoutVerifying("nope")).toThrow(TypeError);
  });
});

describe("bearerTokenFromAuthorization", () => {
  it("parses Bearer headers case-insensitively", () => {
    expect(bearerTokenFromAuthorization(`Bearer ${tokens.validChat}`)).toBe(
      tokens.validChat,
    );
    expect(bearerTokenFromAuthorization(`bearer ${tokens.validChat}`)).toBe(
      tokens.validChat,
    );
  });

  it("returns null for missing or non-bearer headers", () => {
    expect(bearerTokenFromAuthorization(null)).toBeNull();
    expect(bearerTokenFromAuthorization("Basic abc")).toBeNull();
  });
});

describe("verifyChatRequestAuthorization", () => {
  it("verifies a Bearer authorization header end to end", () => {
    const result = verifyChatRequestAuthorization(
      `Bearer ${tokens.validChat}`,
      { keys, audience, nowMs },
    );
    expect(result.status).toBe("verified");
  });

  it("reports missing_token for absent headers", () => {
    const result = verifyChatRequestAuthorization(null, {
      keys,
      audience,
      nowMs,
    });
    expect(result.status).toBe("missing_token");
  });
});

function fakeJwksFetch(): {
  fetch: (url: string) => Promise<Response>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

describe("createGoogleChatTokenVerifier", () => {
  it("fetches JWKS once and caches within the TTL", async () => {
    const { fetch, calls } = fakeJwksFetch();
    const verifier = createGoogleChatTokenVerifier({
      audience,
      fetch,
      now: () => nowMs,
    });
    expect((await verifier.verify(tokens.validChat)).status).toBe("verified");
    expect((await verifier.verify(tokens.validChat)).status).toBe("verified");
    expect(calls).toEqual([GOOGLE_CHAT_JWKS_URL]);
  });

  it("refreshes once for unknown key ids", async () => {
    const { fetch, calls } = fakeJwksFetch();
    const verifier = createGoogleChatTokenVerifier({
      audience,
      fetch,
      now: () => nowMs,
    });
    const result = await verifier.verify(tokens.unknownKid);
    expect(result.status).toBe("unknown_key");
    expect(calls).toHaveLength(2);
  });

  it("refetches after the cache TTL expires", async () => {
    const { fetch, calls } = fakeJwksFetch();
    let clock = nowMs;
    const verifier = createGoogleChatTokenVerifier({
      audience,
      fetch,
      cacheTtlMs: 1000,
      now: () => clock,
    });
    await verifier.verify(tokens.validChat);
    clock += 5000;
    await verifier.verify(tokens.validChat);
    expect(calls).toHaveLength(2);
  });

  it("reports keys_unavailable when the JWKS fetch fails", async () => {
    const verifier = createGoogleChatTokenVerifier({
      audience,
      fetch: async () => new Response("nope", { status: 503 }),
      now: () => nowMs,
    });
    const result = await verifier.verify(tokens.validChat);
    expect(result.status).toBe("keys_unavailable");
    expect(result.ok).toBe(false);
  });
});

describe("createPubSubPushVerifier", () => {
  it("verifies push OIDC tokens against the push audience and email", async () => {
    const { fetch } = fakeJwksFetch();
    const verifier = createPubSubPushVerifier({
      audience: pushAudience,
      serviceAccountEmail: pushEmail,
      fetch,
      now: () => nowMs,
    });
    expect((await verifier.verify(tokens.pubsubValid)).status).toBe("verified");
    expect((await verifier.verify(tokens.pubsubWrongEmail)).status).toBe(
      "wrong_email",
    );
  });
});

describe("createChatRequestVerifier", () => {
  it("reads the authorization header from a Request", async () => {
    const { fetch } = fakeJwksFetch();
    const verify = createChatRequestVerifier({
      audience,
      fetch,
      now: () => nowMs,
    });
    const okResult = await verify(
      new Request("https://example.com/chat/events", {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.validChat}` },
      }),
    );
    expect(okResult.status).toBe("verified");

    const missing = await verify(
      new Request("https://example.com/chat/events", { method: "POST" }),
    );
    expect(missing.status).toBe("missing_token");
  });
});

describe("GoogleChatAI router verification", () => {
  it("rejects unverified requests with 401 and accepts verified ones", async () => {
    const { GoogleChatAI } = await import("../src/router/index.js");
    const { fetch: jwksFetch } = fakeJwksFetch();
    const chat = new GoogleChatAI({
      source: "fixture",
      verifier: createChatRequestVerifier({
        audience,
        fetch: jwksFetch,
        now: () => nowMs,
      }),
    });
    let handled = 0;
    chat.onMessage(async (_event, ctx) => {
      handled += 1;
      return ctx.reply.text("ok");
    });

    const payload = JSON.stringify({
      type: "MESSAGE",
      eventTime: "2026-07-06T12:00:00Z",
      message: {
        name: "spaces/AAA/messages/BBB",
        text: "hello",
        sender: { name: "users/123", type: "HUMAN" },
        space: { name: "spaces/AAA" },
      },
      space: { name: "spaces/AAA" },
    });

    const unauthorized = await chat.fetch(
      new Request("https://example.com/chat/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      }),
    );
    expect(unauthorized.status).toBe(401);
    expect(handled).toBe(0);

    const forged = await chat.fetch(
      new Request("https://example.com/chat/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokens.badSignature}`,
        },
        body: payload,
      }),
    );
    expect(forged.status).toBe(401);
    expect(handled).toBe(0);

    const verified = await chat.fetch(
      new Request("https://example.com/chat/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokens.validChat}`,
        },
        body: payload,
      }),
    );
    expect(verified.status).toBe(200);
    expect(handled).toBe(1);
  });

  it("returns 500 when the verifier itself fails", async () => {
    const { GoogleChatAI } = await import("../src/router/index.js");
    const chat = new GoogleChatAI({
      verifier: async () => {
        throw new Error("jwks fetch exploded");
      },
    });
    const response = await chat.fetch(
      new Request("https://example.com/chat/events", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(500);
  });
});
