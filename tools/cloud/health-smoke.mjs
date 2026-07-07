import { execFileSync } from "node:child_process";

const project = process.env.GOOGLE_CLOUD_PROJECT ?? "chat-ai-sdk";
const location = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
const service =
  process.env.GOOGLE_CHAT_CLOUD_RUN_SERVICE ?? "chat-ai-sdk-dev-webhook";
const configuredBaseUrl = firstConfiguredBaseUrl();
const serviceDescription = describeCloudRunService({
  allowFailure: Boolean(configuredBaseUrl),
});
const baseUrl = normalizeBaseUrl(
  firstNonEmpty([
    configuredBaseUrl,
    serviceDescription.url ? `${serviceDescription.url}/api` : null,
  ]),
);
const healthUrl = `${baseUrl}/healthz`;

function gcloud(args) {
  return execFileSync("gcloud", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function firstConfiguredBaseUrl() {
  return [
    process.env.BASE_URL,
    process.env.GOOGLE_CHAT_BASE_URL,
    process.env.GOOGLE_CHAT_WEBHOOK_URL,
  ].find((candidate) => candidate?.trim()) ?? null;
}

function describeCloudRunService({ allowFailure = false } = {}) {
  try {
    const raw = gcloud([
      "run",
      "services",
      "describe",
      service,
      "--project",
      project,
      "--region",
      location,
      "--format=json(status.url,status.latestReadyRevisionName,status.latestCreatedRevisionName,status.traffic)",
    ]);
    const parsed = JSON.parse(raw);

    return {
      url: parsed.status?.url ?? null,
      latestReadyRevisionName: parsed.status?.latestReadyRevisionName ?? null,
      latestCreatedRevisionName: parsed.status?.latestCreatedRevisionName ?? null,
      traffic: Array.isArray(parsed.status?.traffic)
        ? parsed.status.traffic.map((entry) => ({
            revisionName: entry.revisionName ?? null,
            percent: entry.percent ?? null,
            latestRevision: entry.latestRevision ?? null,
          }))
        : [],
      error: null,
    };
  } catch (error) {
    if (!allowFailure) {
      throw error;
    }

    return {
      url: null,
      latestReadyRevisionName: null,
      latestCreatedRevisionName: null,
      traffic: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeBaseUrl(rawUrl) {
  let url = rawUrl.trim().replace(/\/+$/, "");

  if (url.endsWith("/chat/events")) {
    url = url.slice(0, -"/chat/events".length);
  }

  return url;
}

function firstNonEmpty(values) {
  const value = values.find((candidate) => candidate?.trim());

  if (!value) {
    throw new Error("No base URL could be resolved for the health smoke test.");
  }

  return value;
}

const response = await fetch(healthUrl, {
  headers: {
    accept: "application/json",
  },
});
const contentType = response.headers.get("content-type") ?? "";
const payload = contentType.includes("application/json")
  ? await response.json()
  : {
      body: (await response.text()).slice(0, 500),
    };
const result = {
  ok: response.ok && payload.ok === true,
  project,
  location,
  service,
  serviceUrl: serviceDescription.url,
  latestReadyRevisionName: serviceDescription.latestReadyRevisionName,
  latestCreatedRevisionName: serviceDescription.latestCreatedRevisionName,
  traffic: serviceDescription.traffic,
  revisionLookupError: serviceDescription.error,
  baseUrl,
  healthUrl,
  status: response.status,
  payload,
};

console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  process.exit(1);
}
