import assert from "node:assert/strict";
import test from "node:test";

import {
  DiscoveryFetchError,
  EXIT_DRIFT,
  EXIT_FETCH_ERROR,
  EXIT_OK,
  diffDiscovery,
  extractSortedMethods,
  fetchLiveDiscoveryDocument,
  formatReport,
  main,
  walkMethods,
} from "./check-live-drift.mjs";

const baselineFixture = {
  revision: "20260623",
  methods: ["spaces.create", "spaces.get", "spaces.messages.create"],
};

function discoveryDocumentFixture(overrides = {}) {
  return {
    revision: "20260623",
    resources: {
      spaces: {
        methods: {
          create: {},
          get: {},
        },
        resources: {
          messages: {
            methods: {
              create: {},
            },
          },
        },
      },
    },
    ...overrides,
  };
}

test("walkMethods collects nested method ids with dotted prefixes", () => {
  const resource = {
    methods: { list: {} },
    resources: {
      messages: {
        methods: { create: {}, get: {} },
        resources: {
          reactions: {
            methods: { create: {} },
          },
        },
      },
    },
  };

  assert.deepEqual(walkMethods(resource).sort(), [
    "list",
    "messages.create",
    "messages.get",
    "messages.reactions.create",
  ]);
});

test("walkMethods tolerates missing methods/resources", () => {
  assert.deepEqual(walkMethods({}), []);
});

test("extractSortedMethods sorts the full discovery document method list", () => {
  const document = discoveryDocumentFixture();
  assert.deepEqual(extractSortedMethods(document), [
    "spaces.create",
    "spaces.get",
    "spaces.messages.create",
  ]);
});

test("diffDiscovery reports ok when live matches baseline exactly", () => {
  const diff = diffDiscovery(baselineFixture, discoveryDocumentFixture());

  assert.equal(diff.ok, true);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.equal(diff.revisionChanged, false);
  assert.equal(diff.baselineMethodCount, 3);
  assert.equal(diff.liveMethodCount, 3);
});

test("diffDiscovery detects an added method", () => {
  const document = discoveryDocumentFixture({
    resources: {
      spaces: {
        methods: { create: {}, get: {}, patch: {} },
        resources: {
          messages: { methods: { create: {} } },
        },
      },
    },
  });

  const diff = diffDiscovery(baselineFixture, document);

  assert.equal(diff.ok, false);
  assert.deepEqual(diff.added, ["spaces.patch"]);
  assert.deepEqual(diff.removed, []);
});

test("diffDiscovery detects a removed method", () => {
  const document = discoveryDocumentFixture({
    resources: {
      spaces: {
        methods: { create: {} },
        resources: {
          messages: { methods: { create: {} } },
        },
      },
    },
  });

  const diff = diffDiscovery(baselineFixture, document);

  assert.equal(diff.ok, false);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, ["spaces.get"]);
});

test("diffDiscovery detects a revision change even with no method drift", () => {
  const document = discoveryDocumentFixture({ revision: "20260701" });

  const diff = diffDiscovery(baselineFixture, document);

  assert.equal(diff.ok, false);
  assert.equal(diff.revisionChanged, true);
  assert.equal(diff.liveRevision, "20260701");
  assert.equal(diff.baselineRevision, "20260623");
});

test("diffDiscovery does not flag revision change when either revision is missing", () => {
  const diff = diffDiscovery(
    { methods: baselineFixture.methods },
    discoveryDocumentFixture({ revision: undefined }),
  );

  assert.equal(diff.revisionChanged, false);
});

test("formatReport renders a human-readable OK report", () => {
  const diff = diffDiscovery(baselineFixture, discoveryDocumentFixture());
  const report = formatReport(diff);

  assert.match(report, /OK/);
  assert.match(report, /Baseline revision: 20260623/);
});

test("formatReport renders added/removed/revision drift details", () => {
  const document = discoveryDocumentFixture({
    revision: "20260701",
    resources: {
      spaces: {
        methods: { create: {}, patch: {} },
      },
    },
  });

  const diff = diffDiscovery(baselineFixture, document);
  const report = formatReport(diff);

  assert.match(report, /drift detected/i);
  assert.match(report, /Revision changed\./);
  assert.match(report, /\+ spaces\.patch/);
  assert.match(report, /- spaces\.get/);
  assert.match(report, /- spaces\.messages\.create/);
});

test("fetchLiveDiscoveryDocument returns parsed JSON on success", async () => {
  const document = discoveryDocumentFixture();
  const result = await fetchLiveDiscoveryDocument({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => document,
    }),
  });

  assert.deepEqual(result, document);
});

test("fetchLiveDiscoveryDocument raises DiscoveryFetchError on non-OK response", async () => {
  await assert.rejects(
    fetchLiveDiscoveryDocument({
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    }),
    (error) => {
      assert.ok(error instanceof DiscoveryFetchError);
      assert.match(error.message, /503/);
      return true;
    },
  );
});

test("fetchLiveDiscoveryDocument raises DiscoveryFetchError when the network call throws", async () => {
  await assert.rejects(
    fetchLiveDiscoveryDocument({
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND chat.googleapis.com");
      },
    }),
    (error) => {
      assert.ok(error instanceof DiscoveryFetchError);
      assert.match(error.message, /Failed to reach/);
      return true;
    },
  );
});

test("fetchLiveDiscoveryDocument raises DiscoveryFetchError on invalid JSON", async () => {
  await assert.rejects(
    fetchLiveDiscoveryDocument({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }),
    }),
    (error) => {
      assert.ok(error instanceof DiscoveryFetchError);
      assert.match(error.message, /Failed to parse/);
      return true;
    },
  );
});

function collectWrites() {
  const chunks = [];
  return {
    chunks,
    stream: { write: (chunk) => chunks.push(String(chunk)) },
  };
}

test("main returns EXIT_OK and prints a human report when there is no drift", async () => {
  const stdout = collectWrites();
  const stderr = collectWrites();

  const exitCode = await main({
    argv: [],
    fetchLiveDiscovery: async () => discoveryDocumentFixture(),
    readFile: async () => JSON.stringify(baselineFixture),
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, EXIT_OK);
  assert.match(stdout.chunks.join(""), /OK/);
  assert.deepEqual(stderr.chunks, []);
});

test("main returns EXIT_DRIFT and prints JSON diff with --json", async () => {
  const stdout = collectWrites();
  const stderr = collectWrites();

  const document = discoveryDocumentFixture({
    resources: {
      spaces: {
        methods: { create: {}, get: {}, patch: {} },
        resources: { messages: { methods: { create: {} } } },
      },
    },
  });

  const exitCode = await main({
    argv: ["--json"],
    fetchLiveDiscovery: async () => document,
    readFile: async () => JSON.stringify(baselineFixture),
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, EXIT_DRIFT);
  const parsed = JSON.parse(stdout.chunks.join(""));
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.added, ["spaces.patch"]);
});

test("main returns EXIT_FETCH_ERROR and writes to stderr without throwing on network failure", async () => {
  const stdout = collectWrites();
  const stderr = collectWrites();

  const exitCode = await main({
    argv: [],
    fetchLiveDiscovery: async () => {
      throw new DiscoveryFetchError("Failed to reach Google Chat discovery endpoint: boom");
    },
    readFile: async () => JSON.stringify(baselineFixture),
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, EXIT_FETCH_ERROR);
  assert.deepEqual(stdout.chunks, []);
  assert.match(stderr.chunks.join(""), /Failed to reach/);
});

test("main prints help and exits EXIT_OK for --help", async () => {
  const stdout = collectWrites();
  const stderr = collectWrites();

  const exitCode = await main({
    argv: ["--help"],
    fetchLiveDiscovery: async () => {
      throw new Error("should not be called");
    },
    readFile: async () => JSON.stringify(baselineFixture),
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, EXIT_OK);
  assert.match(stdout.chunks.join(""), /Usage: node tools\/discovery\/check-live-drift\.mjs/);
});
