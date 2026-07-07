import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { UserAuthRequiredError } from "../chat/user-auth-smoke.mjs";
import {
  loadSectionsSmokeConfig,
  runSectionsSmoke,
} from "./chat-sections-smoke.mjs";

const SMOKE_SPACE_PREFIX = "Google Chat AI SDK Smoke";

async function writeMetadata(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-sections-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "space.json");
  const metadata = {
    space: "spaces/AAAA-smoke",
    displayName: `${SMOKE_SPACE_PREFIX} Unit Test`,
    spaceType: "SPACE",
    safety: {
      dedicatedSmokeSpace: true,
      noDirectMessages: true,
      noRealUsersInvited: true,
    },
    ...overrides,
  };
  await fs.writeFile(file, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return file;
}

function smokeEnv(metadataPath, overrides = {}) {
  return {
    RUN_LIVE_CHAT_SECTIONS_SMOKE: "1",
    GOOGLE_CLOUD_PROJECT: "unit-project",
    GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
    GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
    GOOGLE_CHAT_SECTIONS_SMOKE_RUN_ID: "sections-test",
    GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS: "/tmp/oauth-client.json",
    GOOGLE_CHAT_USER_TOKEN_STORE: "/tmp/user-token.json",
    ...overrides,
  };
}

test("loadSectionsSmokeConfig refuses live run without explicit guard", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadSectionsSmokeConfig({
        argv: ["node", "chat-sections-smoke.mjs"],
        env: {
          GOOGLE_CHAT_TEST_SPACE: "spaces/AAAA-smoke",
          GOOGLE_CHAT_SMOKE_METADATA: metadataPath,
        },
      }),
    /RUN_LIVE_CHAT_SECTIONS_SMOKE=1/,
  );
});

test("dry-run plan is read-only user-auth and redacted", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadSectionsSmokeConfig({
    argv: ["node", "chat-sections-smoke.mjs", "--dry-run", "--page-size=2"],
    env: smokeEnv(metadataPath, {
      RUN_LIVE_CHAT_SECTIONS_SMOKE: undefined,
    }),
  });
  const result = await runSectionsSmoke(config);
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.status, "dry_run");
  assert.equal(result.plan.length, 2);
  assert.equal(result.plan.every((entry) => entry.write === false), true);
  assert.equal(
    result.plan.every((entry) => entry.authPrincipal === "user"),
    true,
  );
  assert.equal(serialized.includes("spaces/AAAA-smoke"), false);
  assert.equal(serialized.includes(`${SMOKE_SPACE_PREFIX} Unit Test`), false);
});

test("section mutation refuses live run without explicit write gate", async (t) => {
  const metadataPath = await writeMetadata(t);

  await assert.rejects(
    () =>
      loadSectionsSmokeConfig({
        argv: [
          "node",
          "chat-sections-smoke.mjs",
          "--exercise-section-mutations",
        ],
        env: smokeEnv(metadataPath, {
          GOOGLE_CHAT_AI_ENABLE_LIVE_SECTIONS_WRITE: undefined,
        }),
      }),
    /GOOGLE_CHAT_AI_ENABLE_LIVE_SECTIONS_WRITE=1/,
  );
});

test("section mutation dry-run exposes reversible user-write plan", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadSectionsSmokeConfig({
    argv: [
      "node",
      "chat-sections-smoke.mjs",
      "--dry-run",
      "--exercise-section-mutations",
    ],
    env: smokeEnv(metadataPath, {
      RUN_LIVE_CHAT_SECTIONS_SMOKE: undefined,
    }),
  });
  const result = await runSectionsSmoke(config);
  const writePlan = result.plan.filter((entry) => entry.write);

  assert.equal(result.ok, true);
  assert.equal(writePlan.length, 6);
  assert.equal(
    writePlan.every(
      (entry) =>
        entry.explicitWriteGate === "GOOGLE_CHAT_AI_ENABLE_LIVE_SECTIONS_WRITE",
    ),
    true,
  );
  assert.equal(writePlan.every((entry) => entry.reversible === true), true);
  assert.ok(
    writePlan.some((entry) => entry.operation === "sections.items.move.restoreOriginalSection"),
  );
});

test("runSectionsSmoke records allowed auth-required sections scope", async (t) => {
  const metadataPath = await writeMetadata(t);
  const writes = [];
  const config = await loadSectionsSmokeConfig({
    argv: ["node", "chat-sections-smoke.mjs", "--allow-blocked"],
    env: smokeEnv(metadataPath),
  });
  const result = await runSectionsSmoke(config, {
    readFile: async () => JSON.stringify({ installed: { client_id: "id" } }),
    readOAuthClientConfigImpl: () => ({ clientId: "id" }),
    mkdir: async () => {},
    writeFile: async (_path, data) => {
      writes.push(data);
    },
    chatRequestWithUserAuthImpl: async () => {
      throw new UserAuthRequiredError("missing sections secret", {
        reason: "missing_requested_scopes",
        scopes: ["https://www.googleapis.com/auth/chat.users.sections.readonly"],
      });
    },
    now: () => new Date("2026-07-03T06:30:00Z"),
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.status, "blocked");
  assert.equal(result.results.length, 2);
  assert.equal(
    result.results.every((entry) => entry.allowedBlocked === true),
    true,
  );
  assert.equal(result.results[0].blockedReason, "missing_requested_scopes");
  assert.equal(writes.length, 1);
  assert.equal(serialized.includes("missing sections secret"), false);
  assert.equal(serialized.includes("spaces/AAAA-smoke"), false);
});

test("runSectionsSmoke creates, moves, restores, and deletes a temporary section", async (t) => {
  const metadataPath = await writeMetadata(t);
  const calls = [];
  const defaultItemName =
    "users/me/sections/default-spaces/items/spaces/AAAA-smoke";
  const customSectionName = "users/me/sections/custom-secret";
  const customItemName =
    "users/me/sections/custom-secret/items/spaces/AAAA-smoke";
  const config = await loadSectionsSmokeConfig({
    argv: [
      "node",
      "chat-sections-smoke.mjs",
      "--expect-smoke-space-item",
      "--exercise-section-mutations",
    ],
    env: smokeEnv(metadataPath, {
      GOOGLE_CHAT_AI_ENABLE_LIVE_SECTIONS_WRITE: "1",
    }),
  });
  const result = await runSectionsSmoke(config, {
    readFile: async () => JSON.stringify({ installed: { client_id: "id" } }),
    readOAuthClientConfigImpl: () => ({ clientId: "id" }),
    mkdir: async () => {},
    writeFile: async () => {},
    chatRequestWithUserAuthImpl: async ({ url, init, scopes }) => {
      calls.push({ url, init, scopes });
      if (init.method === "GET" && url.includes("/items")) {
        return {
          ok: true,
          status: 200,
          attempts: 1,
          refreshed: false,
          replayedAfter401: false,
          retryDecisions: [],
          headers: {},
          json: {
            sectionItems: [
              {
                name: defaultItemName,
                space: "spaces/AAAA-smoke",
              },
            ],
          },
        };
      }
      if (init.method === "GET") {
        return {
          ok: true,
          status: 200,
          attempts: 1,
          refreshed: false,
          replayedAfter401: false,
          retryDecisions: [],
          headers: {},
          json: {
            sections: [
              {
                name: "users/me/sections/default-spaces",
                type: "DEFAULT_SPACES",
                sortOrder: 2,
              },
            ],
          },
        };
      }
      if (init.method === "POST" && url.endsWith("/users/me/sections")) {
        const body = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          attempts: 1,
          refreshed: false,
          replayedAfter401: false,
          retryDecisions: [],
          headers: {},
          json: {
            name: customSectionName,
            displayName: body.displayName,
            type: "CUSTOM_SECTION",
          },
        };
      }
      if (init.method === "PATCH") {
        const body = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          attempts: 1,
          refreshed: false,
          replayedAfter401: false,
          retryDecisions: [],
          headers: {},
          json: {
            name: customSectionName,
            displayName: body.displayName,
            type: "CUSTOM_SECTION",
          },
        };
      }
      if (init.method === "POST" && url.includes(":position")) {
        return {
          ok: true,
          status: 200,
          attempts: 1,
          refreshed: false,
          replayedAfter401: false,
          retryDecisions: [],
          headers: {},
          json: {
            name: customSectionName,
            displayName: "Temporary Secret",
            type: "CUSTOM_SECTION",
            sortOrder: 9,
          },
        };
      }
      if (init.method === "POST" && url.includes(":move")) {
        const body = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          attempts: 1,
          refreshed: false,
          replayedAfter401: false,
          retryDecisions: [],
          headers: {},
          json: {
            name:
              body.targetSection === customSectionName
                ? customItemName
                : defaultItemName,
            space: "spaces/AAAA-smoke",
          },
        };
      }
      if (init.method === "DELETE") {
        return {
          ok: true,
          status: 200,
          attempts: 1,
          refreshed: false,
          replayedAfter401: false,
          retryDecisions: [],
          headers: {},
          json: {},
        };
      }
      throw new Error(`Unexpected call ${init.method} ${url}`);
    },
  });
  const serialized = JSON.stringify(result);
  const moveBodies = calls
    .filter((call) => call.url.includes(":move"))
    .map((call) => JSON.parse(call.init.body));

  assert.equal(result.ok, true);
  assert.equal(result.status, "verified");
  assert.equal(result.assertions.temporarySectionDeleted, true);
  assert.equal(result.assertions.smokeSpaceRestoredToOriginalSection, true);
  assert.equal(result.mutations.length, 1);
  assert.equal(result.mutations[0].temporarySectionCreated, true);
  assert.equal(result.mutations[0].temporarySectionDeleted, true);
  assert.equal(result.mutations[0].smokeSpaceRestoredToOriginalSection, true);
  assert.deepEqual(
    moveBodies.map((body) => body.targetSection),
    [customSectionName, "users/me/sections/default-spaces"],
  );
  assert.ok(
    calls.some(
      (call) => call.init.method === "PATCH" && call.url.includes("updateMask=displayName"),
    ),
  );
  assert.ok(calls.some((call) => call.init.method === "DELETE"));
  assert.ok(
    calls
      .filter((call) => call.init.method !== "GET")
      .every((call) =>
        call.scopes.includes("https://www.googleapis.com/auth/chat.users.sections"),
      ),
  );
  assert.equal(serialized.includes("spaces/AAAA-smoke"), false);
  assert.equal(serialized.includes("default-spaces"), false);
  assert.equal(serialized.includes("custom-secret"), false);
  assert.equal(serialized.includes("Temporary Secret"), false);
});

test("runSectionsSmoke summarizes sections and filtered smoke-space item", async (t) => {
  const metadataPath = await writeMetadata(t);
  const requestedUrls = [];
  const config = await loadSectionsSmokeConfig({
    argv: [
      "node",
      "chat-sections-smoke.mjs",
      "--expect-smoke-space-item",
    ],
    env: smokeEnv(metadataPath),
  });
  const result = await runSectionsSmoke(config, {
    readFile: async () => JSON.stringify({ installed: { client_id: "id" } }),
    readOAuthClientConfigImpl: () => ({ clientId: "id" }),
    mkdir: async () => {},
    writeFile: async () => {},
    chatRequestWithUserAuthImpl: async ({ url }) => {
      requestedUrls.push(url);
      if (url.includes("/items")) {
        return {
          ok: true,
          status: 200,
          attempts: 1,
          refreshed: false,
          replayedAfter401: false,
          retryDecisions: [],
          headers: {},
          json: {
            sectionItems: [
              {
                name: "users/me/sections/default-spaces/items/spaces/AAAA-smoke",
                space: "spaces/AAAA-smoke",
              },
            ],
          },
        };
      }
      return {
        ok: true,
        status: 200,
        attempts: 1,
        refreshed: true,
        replayedAfter401: false,
        retryDecisions: [],
        headers: {},
        json: {
          sections: [
            {
              name: "users/me/sections/default-spaces",
              type: "DEFAULT_SPACES",
              sortOrder: 2,
            },
            {
              name: "users/me/sections/custom-secret",
              displayName: "Confidential projects",
              type: "CUSTOM_SECTION",
              sortOrder: 4,
            },
          ],
        },
      };
    },
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.status, "verified");
  assert.equal(result.results.length, 2);
  assert.equal(result.assertions.smokeSpaceItemCount, 1);
  assert.equal(result.assertions.smokeSpaceItemExpectationMet, true);
  assert.ok(requestedUrls.some((url) => url.includes("users/me/sections")));
  assert.ok(requestedUrls.some((url) => url.includes("space+%3D+spaces%2FAAAA-smoke")));
  assert.equal(serialized.includes("users/me/sections/default-spaces"), false);
  assert.equal(serialized.includes("Confidential projects"), false);
  assert.equal(serialized.includes("spaces/AAAA-smoke"), false);
});

test("runSectionsSmoke follows paginated section lists", async (t) => {
  const metadataPath = await writeMetadata(t);
  const requestedUrls = [];
  const config = await loadSectionsSmokeConfig({
    argv: [
      "node",
      "chat-sections-smoke.mjs",
      "--page-size=2",
      "--max-pages=3",
      "--expect-smoke-space-item",
    ],
    env: smokeEnv(metadataPath),
  });
  const result = await runSectionsSmoke(config, {
    readFile: async () => JSON.stringify({ installed: { client_id: "id" } }),
    readOAuthClientConfigImpl: () => ({ clientId: "id" }),
    mkdir: async () => {},
    writeFile: async () => {},
    chatRequestWithUserAuthImpl: async ({ url }) => {
      requestedUrls.push(url);
      if (url.includes("/items")) {
        return {
          ok: true,
          status: 200,
          attempts: 1,
          refreshed: false,
          replayedAfter401: false,
          retryDecisions: [],
          headers: {},
          json: {
            sectionItems: [
              {
                name: "users/me/sections/default-spaces/items/spaces/AAAA-smoke",
                space: "spaces/AAAA-smoke",
              },
            ],
          },
        };
      }
      const isSecondPage = url.includes("pageToken=next-sections-page");
      return {
        ok: true,
        status: 200,
        attempts: 1,
        refreshed: false,
        replayedAfter401: false,
        retryDecisions: [],
        headers: {},
        json: {
          sections: [
            {
              name: isSecondPage
                ? "users/me/sections/default-apps"
                : "users/me/sections/default-spaces",
              type: isSecondPage ? "DEFAULT_APPS" : "DEFAULT_SPACES",
              sortOrder: isSecondPage ? 3 : 2,
            },
          ],
          ...(isSecondPage ? {} : { nextPageToken: "next-sections-page" }),
        },
      };
    },
  });
  const sectionResults = result.results.filter(
    (entry) => entry.operation === "sections.list",
  );
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(sectionResults.length, 2);
  assert.deepEqual(
    sectionResults.map((entry) => entry.pageIndex),
    [0, 1],
  );
  assert.equal(sectionResults[0].response.hasNextPageToken, true);
  assert.equal(sectionResults[1].pageTokenHash !== null, true);
  assert.equal(result.assertions.paginationTruncated, false);
  assert.equal(result.assertions.maxPagesRespected, true);
  assert.ok(requestedUrls.some((url) => url.includes("pageSize=2")));
  assert.ok(requestedUrls.some((url) => url.includes("pageToken=next-sections-page")));
  assert.equal(serialized.includes("next-sections-page"), false);
  assert.equal(serialized.includes("spaces/AAAA-smoke"), false);
});

test("runSectionsSmoke fails unmet smoke-space item expectation", async (t) => {
  const metadataPath = await writeMetadata(t);
  const config = await loadSectionsSmokeConfig({
    argv: [
      "node",
      "chat-sections-smoke.mjs",
      "--expect-smoke-space-item",
    ],
    env: smokeEnv(metadataPath),
  });
  const result = await runSectionsSmoke(config, {
    readFile: async () => JSON.stringify({ installed: { client_id: "id" } }),
    readOAuthClientConfigImpl: () => ({ clientId: "id" }),
    mkdir: async () => {},
    writeFile: async () => {},
    chatRequestWithUserAuthImpl: async ({ url }) => ({
      ok: true,
      status: 200,
      attempts: 1,
      refreshed: false,
      replayedAfter401: false,
      retryDecisions: [],
      headers: {},
      json: url.includes("/items") ? { sectionItems: [] } : { sections: [] },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.assertions.smokeSpaceItemExpectationMet, false);
});
