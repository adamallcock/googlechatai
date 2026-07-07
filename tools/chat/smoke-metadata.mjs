export const smokeSpaceAllowedOperations = [
  "spaces.list",
  "spaces.get",
  "spaces.create",
  "spaces.delete",
  "spaces.messages.create",
  "spaces.messages.patch",
  "spaces.messages.delete",
];

export function parseAppAuthSmokeArgs(argv) {
  const args = {
    createTestSpace: false,
    metadataOutputPath: null,
  };
  const rest = argv.slice(2);

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--") {
      continue;
    }
    if (arg === "--create-test-space") {
      args.createTestSpace = true;
    } else if (arg === "--metadata-output") {
      args.metadataOutputPath = rest[++index];
    } else if (arg.startsWith("--metadata-output=")) {
      args.metadataOutputPath = arg.slice("--metadata-output=".length);
    }
  }

  return args;
}

export function buildSmokeSpaceMetadata(space, { customer = null } = {}) {
  const metadata = {
    space: space.name,
    displayName: space.displayName,
    spaceType: space.spaceType ?? "SPACE",
    purpose:
      "Dedicated Google Chat live-smoke test space for the Google Chat AI SDK.",
    safety: {
      dedicatedSmokeSpace: true,
      noDirectMessages: true,
      noRealUsersInvited: true,
    },
    allowedOperations: smokeSpaceAllowedOperations,
  };

  if (customer) {
    metadata.customer = customer;
  }

  return metadata;
}

export function buildCreateTestSpaceFailureHint(status) {
  if (status === 403) {
    return "Google denied app-auth space creation. A Workspace administrator must approve the Chat app authorization scopes, especially https://www.googleapis.com/auth/chat.app.spaces.create, for this app.";
  }
  if (status === 500) {
    return "Google returned 500 for app-auth space creation. Verify the app is configured from a Google Workspace account/project, has a Marketplace SDK listing with chat.app.* scopes, and has one-time Workspace admin approval for Chat app authorization.";
  }
  return "If this reports a missing or disabled Chat app, configure the Chat API app in Google Cloud Console first.";
}

export function resolveSmokeCustomer(env = process.env) {
  return env.GOOGLE_CHAT_CUSTOMER?.trim() || "customers/my_customer";
}
