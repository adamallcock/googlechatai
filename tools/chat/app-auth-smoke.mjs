import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { chatRequestWithAppAuth } from "./app-auth-client.mjs";
import {
  buildCreateTestSpaceFailureHint,
  buildSmokeSpaceMetadata,
  parseAppAuthSmokeArgs,
  resolveSmokeCustomer,
} from "./smoke-metadata.mjs";

const project = process.env.GOOGLE_CLOUD_PROJECT ?? "chat-ai-sdk";
const credentialsPath =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ??
  path.join(
    os.homedir(),
    ".config/googlechatai-sdk/credentials/chat-ai-sdk-service-account.json",
  );
const args = parseAppAuthSmokeArgs(process.argv);
const createTestSpace = args.createTestSpace;
const existingTestSpace = process.env.GOOGLE_CHAT_TEST_SPACE ?? "";

async function chatRequest(serviceAccount, scopes, url, init = {}) {
  const result = await chatRequestWithAppAuth({
    serviceAccount,
    scopes,
    url,
    init,
  });

  return {
    ok: result.ok,
    status: result.status,
    json: result.json,
    token: {
      refreshed: result.refreshed,
      replayedAfter401: result.replayedAfter401,
    },
  };
}

if (createTestSpace && existingTestSpace.startsWith("spaces/")) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        project,
        operation: "create-test-space-skipped",
        reason: "GOOGLE_CHAT_TEST_SPACE is already set.",
        testSpace: existingTestSpace,
        metadataOutputPath: null,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const serviceAccount = JSON.parse(await fs.readFile(credentialsPath, "utf8"));
const scopes = createTestSpace
  ? [
      "https://www.googleapis.com/auth/chat.bot",
      "https://www.googleapis.com/auth/chat.app.spaces.create",
    ]
  : ["https://www.googleapis.com/auth/chat.bot"];

if (createTestSpace) {
  const displayName = `Google Chat AI SDK Smoke ${new Date()
    .toISOString()
    .slice(0, 10)}`;
  const customer = resolveSmokeCustomer(process.env);
  const createUrl = new URL("https://chat.googleapis.com/v1/spaces");
  createUrl.searchParams.set(
    "requestId",
    `app-auth-create-${displayName.slice(-10)}`,
  );
  const result = await chatRequest(serviceAccount, scopes, createUrl.toString(), {
    method: "POST",
    idempotent: true,
    body: {
      spaceType: "SPACE",
      displayName,
      customer,
    },
  });
  const smokeMetadata = result.ok
    ? buildSmokeSpaceMetadata(result.json, {
        customer,
      })
    : null;

  if (result.ok && args.metadataOutputPath) {
    const metadataPath = path.isAbsolute(args.metadataOutputPath)
      ? args.metadataOutputPath
      : path.resolve(process.cwd(), args.metadataOutputPath);
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(
      metadataPath,
      `${JSON.stringify(smokeMetadata, null, 2)}\n`,
      "utf8",
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        project,
        operation: "create-test-space",
        displayName,
        status: result.status,
        response: result.json,
        smokeMetadata,
        metadataOutputPath:
          result.ok && args.metadataOutputPath ? args.metadataOutputPath : null,
        hint: result.ok ? null : buildCreateTestSpaceFailureHint(result.status),
      },
      null,
      2,
    ),
  );
  process.exit(result.ok ? 0 : 1);
}

const result = await chatRequest(
  serviceAccount,
  scopes,
  "https://chat.googleapis.com/v1/spaces?pageSize=1",
);

console.log(
  JSON.stringify(
    {
      ok: result.ok,
      project,
      operation: "list-spaces-app-auth",
      serviceAccountEmail: serviceAccount.client_email,
      status: result.status,
      response: result.ok
        ? {
            spaces: result.json.spaces?.length ?? 0,
            nextPageToken: result.json.nextPageToken ?? null,
          }
        : result.json,
      hint: result.ok
        ? null
        : "App-auth Chat calls require the Google Chat app to be configured for this Cloud project.",
    },
    null,
    2,
  ),
);
process.exit(result.ok ? 0 : 1);
