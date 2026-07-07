import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  buildAuthorizationUrl,
  buildUserCreateSpaceRequest,
  parseUserAuthSmokeArgs,
  readOAuthClientConfig,
  selectUserAuthScopes,
  USER_AUTH_SCOPES,
} from "./user-auth-smoke.mjs";

test("parseUserAuthSmokeArgs accepts pnpm separators and user-auth flags", () => {
  assert.deepEqual(
    parseUserAuthSmokeArgs([
      "node",
      "user-auth-smoke.mjs",
      "--",
      "--authorize",
      "--create-test-space",
      "--read-messages",
      "--write-messages",
      "--read-reactions",
      "--write-reactions",
      "--read-memberships",
      "--read-custom-emojis",
      "--read-state",
      "--write-state",
      "--read-space-settings",
      "--read-sections",
      "--write-sections",
      "--read-drive",
      "--write-drive",
      "--metadata-output=fixtures/live/chat-smoke-space.local.json",
      "--credentials",
      "/tmp/oauth-client.json",
      "--token-store",
      ".tokens/user.json",
      "--redirect-uri=http://127.0.0.1:8765/oauth2callback",
      "--port",
      "8765",
    ]),
    {
      authorize: true,
      createTestSpace: true,
      dryRun: false,
      readMessages: true,
      writeMessages: true,
      readReactions: true,
      writeReactions: true,
      readMemberships: true,
      readCustomEmojis: true,
      readState: true,
      writeState: true,
      readSpaceSettings: true,
      readSections: true,
      writeSections: true,
      readDrive: true,
      writeDrive: true,
      metadataOutputPath: "fixtures/live/chat-smoke-space.local.json",
      credentialsPath: "/tmp/oauth-client.json",
      tokenStorePath: ".tokens/user.json",
      redirectUri: "http://127.0.0.1:8765/oauth2callback",
      port: 8765,
    },
  );
});

test("selectUserAuthScopes chooses list scope and create-ready scope bundle", () => {
  assert.deepEqual(
    selectUserAuthScopes({ createTestSpace: false }),
    USER_AUTH_SCOPES.listSpaces,
  );
  assert.deepEqual(
    selectUserAuthScopes({ createTestSpace: true }),
    [
      "https://www.googleapis.com/auth/chat.spaces.readonly",
      "https://www.googleapis.com/auth/chat.spaces.create",
    ],
  );
  assert.deepEqual(
    selectUserAuthScopes({ createTestSpace: false, readMessages: true }),
    [
      "https://www.googleapis.com/auth/chat.spaces.readonly",
      "https://www.googleapis.com/auth/chat.messages.readonly",
    ],
  );
  assert.deepEqual(
    selectUserAuthScopes({
      createTestSpace: false,
      readMessages: true,
      writeMessages: true,
      readReactions: true,
      writeReactions: true,
      readMemberships: true,
      readCustomEmojis: true,
      readState: true,
      writeState: true,
      readSpaceSettings: true,
      readSections: true,
      writeSections: true,
      readDrive: true,
      writeDrive: true,
    }),
    [
      "https://www.googleapis.com/auth/chat.spaces.readonly",
      "https://www.googleapis.com/auth/chat.messages.readonly",
      "https://www.googleapis.com/auth/chat.messages.create",
      "https://www.googleapis.com/auth/chat.messages.reactions.readonly",
      "https://www.googleapis.com/auth/chat.messages.reactions",
      "https://www.googleapis.com/auth/chat.memberships.readonly",
      "https://www.googleapis.com/auth/chat.customemojis.readonly",
      "https://www.googleapis.com/auth/chat.users.readstate.readonly",
      "https://www.googleapis.com/auth/chat.users.readstate",
      "https://www.googleapis.com/auth/chat.users.spacesettings",
      "https://www.googleapis.com/auth/chat.users.sections.readonly",
      "https://www.googleapis.com/auth/chat.users.sections",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ],
  );
  assert.deepEqual(USER_AUTH_SCOPES.listSpaces, [
    "https://www.googleapis.com/auth/chat.spaces.readonly",
  ]);
});

test("readOAuthClientConfig accepts Google installed app client JSON", () => {
  assert.deepEqual(
    readOAuthClientConfig({
      installed: {
        client_id: "client-id.apps.googleusercontent.com",
        client_secret: "secret",
        auth_uri: "https://accounts.google.com/o/oauth2/v2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        redirect_uris: ["http://localhost"],
      },
    }),
    {
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "secret",
      authUri: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUri: "https://oauth2.googleapis.com/token",
      redirectUris: ["http://localhost"],
    },
  );
});

test("buildAuthorizationUrl requests offline user consent without domain-wide delegation", () => {
  const url = new URL(
    buildAuthorizationUrl(
      {
        clientId: "client-id.apps.googleusercontent.com",
        authUri: "https://accounts.google.com/o/oauth2/v2/auth",
      },
      {
        scopes: USER_AUTH_SCOPES.createSpace,
        redirectUri: "http://127.0.0.1:8765/oauth2callback",
        state: "state",
        codeChallenge: "challenge",
      },
    ),
  );

  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("scope"),
    "https://www.googleapis.com/auth/chat.spaces.readonly https://www.googleapis.com/auth/chat.spaces.create",
  );
  assert.equal(url.searchParams.has("sub"), false);
});

test("buildUserCreateSpaceRequest omits customer for user credentials", () => {
  assert.deepEqual(
    buildUserCreateSpaceRequest("Google Chat AI SDK Smoke 2026-07-01"),
    {
      spaceType: "SPACE",
      displayName: "Google Chat AI SDK Smoke 2026-07-01",
    },
  );
});

test("user-auth smoke dry-run does not read OAuth credentials", () => {
  const output = execFileSync(
    process.execPath,
    ["tools/chat/user-auth-smoke.mjs", "--dry-run", "--create-test-space"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        GOOGLE_CHAT_OAUTH_CLIENT_CREDENTIALS: "/path/that/does/not/exist.json",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const result = JSON.parse(output);

  assert.equal(result.ok, true);
  assert.equal(result.principal, "user");
  assert.equal(result.domainWideDelegation, false);
  assert.deepEqual(result.plannedCalls, [
    "oauth.refresh-if-needed",
    "spaces.create",
  ]);
});
