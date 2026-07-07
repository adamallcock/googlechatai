import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  buildCreateTestSpaceFailureHint,
  buildSmokeSpaceMetadata,
  parseAppAuthSmokeArgs,
  resolveSmokeCustomer,
} from "./smoke-metadata.mjs";

test("buildSmokeSpaceMetadata creates W7-compatible metadata from a created Chat space", () => {
  const metadata = buildSmokeSpaceMetadata(
    {
      name: "spaces/AAAA-smoke",
      displayName: "Google Chat AI SDK Smoke 2026-06-29",
      spaceType: "SPACE",
    },
    { customer: "customers/C01234567" },
  );

  assert.deepEqual(metadata, {
    space: "spaces/AAAA-smoke",
    displayName: "Google Chat AI SDK Smoke 2026-06-29",
    spaceType: "SPACE",
    customer: "customers/C01234567",
    purpose:
      "Dedicated Google Chat live-smoke test space for the Google Chat AI SDK.",
    safety: {
      dedicatedSmokeSpace: true,
      noDirectMessages: true,
      noRealUsersInvited: true,
    },
    allowedOperations: [
      "spaces.list",
      "spaces.get",
      "spaces.create",
      "spaces.delete",
      "spaces.messages.create",
      "spaces.messages.patch",
      "spaces.messages.delete",
    ],
  });
});

test("parseAppAuthSmokeArgs accepts pnpm separators and metadata output paths", () => {
  assert.deepEqual(
    parseAppAuthSmokeArgs([
      "node",
      "app-auth-smoke.mjs",
      "--",
      "--create-test-space",
      "--metadata-output",
      "fixtures/live/chat-smoke-space.local.json",
    ]),
    {
      createTestSpace: true,
      metadataOutputPath: "fixtures/live/chat-smoke-space.local.json",
    },
  );
});

test("resolveSmokeCustomer defaults app-auth space creation to the Workspace alias", () => {
  assert.equal(resolveSmokeCustomer({}), "customers/my_customer");
  assert.equal(
    resolveSmokeCustomer({ GOOGLE_CHAT_CUSTOMER: "customers/C01234567" }),
    "customers/C01234567",
  );
});

test("buildCreateTestSpaceFailureHint explains admin authorization failures", () => {
  assert.match(
    buildCreateTestSpaceFailureHint(403),
    /approve the Chat app authorization scopes/,
  );
  assert.match(
    buildCreateTestSpaceFailureHint(403),
    /chat\.app\.spaces\.create/,
  );
});

test("app-auth smoke create skips before credential reads when a test space is configured", () => {
  const output = execFileSync(
    process.execPath,
    ["tools/chat/app-auth-smoke.mjs", "--create-test-space"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        GOOGLE_APPLICATION_CREDENTIALS: "/path/that/does/not/exist.json",
        GOOGLE_CHAT_TEST_SPACE: "spaces/already-configured",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const result = JSON.parse(output);

  assert.deepEqual(result, {
    ok: true,
    project: "chat-ai-sdk",
    operation: "create-test-space-skipped",
    reason: "GOOGLE_CHAT_TEST_SPACE is already set.",
    testSpace: "spaces/already-configured",
    metadataOutputPath: null,
  });
});
