import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const project = process.env.GOOGLE_CLOUD_PROJECT ?? "chat-ai-sdk";
const location = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
const runtimeServiceAccount =
  process.env.GOOGLE_CHAT_CLOUD_RUN_SERVICE_ACCOUNT ??
  `chat-ai-sdk-runtime@${project}.iam.gserviceaccount.com`;
const artifactRepository =
  process.env.GOOGLE_CHAT_ARTIFACT_REPOSITORY ?? "chat-ai-sdk";
const cloudRunService =
  process.env.GOOGLE_CHAT_CLOUD_RUN_SERVICE ?? "chat-ai-sdk-dev-webhook";
const workspaceEventsTopic =
  process.env.WORKSPACE_EVENTS_PUBSUB_TOPIC ?? "chat-ai-sdk-workspace-events";
const workspaceEventsSubscription =
  process.env.WORKSPACE_EVENTS_PUBSUB_SUBSCRIPTION ??
  "chat-ai-sdk-workspace-events-dev-pull";
const smokeTestsTopic =
  process.env.GOOGLE_CHAT_SMOKE_PUBSUB_TOPIC ?? "chat-ai-sdk-smoke-tests";
const smokeTestsSubscription =
  process.env.GOOGLE_CHAT_SMOKE_PUBSUB_SUBSCRIPTION ??
  "chat-ai-sdk-smoke-tests-dev-pull";
const credentialsPath =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ??
  path.join(
    os.homedir(),
    ".config/googlechatai-sdk/credentials/chat-ai-sdk-service-account.json",
  );

const expectedServices = [
  "admin.googleapis.com",
  "appsmarket-component.googleapis.com",
  "appsmarket.googleapis.com",
  "artifactregistry.googleapis.com",
  "chat.googleapis.com",
  "cloudbuild.googleapis.com",
  "cloudresourcemanager.googleapis.com",
  "drive.googleapis.com",
  "firestore.googleapis.com",
  "gsuiteaddons.googleapis.com",
  "iam.googleapis.com",
  "iamcredentials.googleapis.com",
  "logging.googleapis.com",
  "monitoring.googleapis.com",
  "people.googleapis.com",
  "pubsub.googleapis.com",
  "run.googleapis.com",
  "secretmanager.googleapis.com",
  "serviceusage.googleapis.com",
  "workspaceevents.googleapis.com",
];

function gcloud(args) {
  return execFileSync("gcloud", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function exists(args) {
  try {
    gcloud(args);
    return true;
  } catch {
    return false;
  }
}

function projectIamBindingExists(member, role) {
  try {
    return gcloud([
      "projects",
      "get-iam-policy",
      project,
      "--flatten=bindings[].members",
      `--filter=bindings.role:${role} AND bindings.members:${member}`,
      "--format=value(bindings.role)",
    ]).includes(role);
  } catch {
    return false;
  }
}

const enabledServices = gcloud([
  "services",
  "list",
  "--enabled",
  "--project",
  project,
  "--format=value(config.name)",
])
  .split("\n")
  .filter(Boolean)
  .sort();

const missingServices = expectedServices.filter(
  (service) => !enabledServices.includes(service),
);
const credentialStats = fs.existsSync(credentialsPath)
  ? fs.statSync(credentialsPath)
  : null;
const resources = {
  runtimeServiceAccount: exists([
    "iam",
    "service-accounts",
    "describe",
    runtimeServiceAccount,
    "--project",
    project,
  ]),
  artifactRegistry: exists([
    "artifacts",
    "repositories",
    "describe",
    artifactRepository,
    "--project",
    project,
    "--location",
    location,
  ]),
  cloudRunWebhook: exists([
    "run",
    "services",
    "describe",
    cloudRunService,
    "--project",
    project,
    "--region",
    location,
  ]),
  firestoreDatabase: exists([
    "firestore",
    "databases",
    "describe",
    "--database=(default)",
    "--project",
    project,
  ]),
  runtimeDatastoreUser: projectIamBindingExists(
    `serviceAccount:${runtimeServiceAccount}`,
    "roles/datastore.user",
  ),
  workspaceEventsTopic: exists([
    "pubsub",
    "topics",
    "describe",
    workspaceEventsTopic,
    "--project",
    project,
  ]),
  smokeTestsTopic: exists([
    "pubsub",
    "topics",
    "describe",
    smokeTestsTopic,
    "--project",
    project,
  ]),
  workspaceEventsSubscription: exists([
    "pubsub",
    "subscriptions",
    "describe",
    workspaceEventsSubscription,
    "--project",
    project,
  ]),
  smokeTestsSubscription: exists([
    "pubsub",
    "subscriptions",
    "describe",
    smokeTestsSubscription,
    "--project",
    project,
  ]),
};

const result = {
  ok:
    missingServices.length === 0 &&
    credentialStats !== null &&
    Object.values(resources).every(Boolean),
  project,
  location,
  credentials: {
    path: credentialsPath,
    exists: credentialStats !== null,
    mode: credentialStats
      ? `0${(credentialStats.mode & 0o777).toString(8)}`
      : null,
  },
  services: {
    expected: expectedServices.length,
    enabledExpected: expectedServices.length - missingServices.length,
    missing: missingServices,
  },
  resources,
};

console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  process.exit(1);
}
