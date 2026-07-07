import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const datastoreScope = "https://www.googleapis.com/auth/datastore";
const loggingWriteScope = "https://www.googleapis.com/auth/logging.write";
const defaultCloudLogName = "googlechatai-sdk-idempotency-monitor";
const metadataTokenUrl =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const authModes = new Set(["service-account-key", "metadata"]);

function parseArgs(argv) {
  const args = {
    dryRun: false,
    project: null,
    database: null,
    collection: null,
    ttlField: null,
    countUpTo: null,
    warnDocs: null,
    failDocs: null,
    sampleLimit: null,
    expiredWarnDocs: null,
    expiredFailDocs: null,
    evidencePath: null,
    runId: null,
    allowTtlUnknown: false,
    writeCloudLog: false,
    cloudLogName: null,
    authMode: null,
    help: false,
  };
  const rest = argv.slice(2);

  const readRequiredValue = (index, option) => {
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value.`);
    }
    return value;
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--") {
      continue;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--project") {
      args.project = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--project=")) {
      args.project = arg.slice("--project=".length);
    } else if (arg === "--database") {
      args.database = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--database=")) {
      args.database = arg.slice("--database=".length);
    } else if (arg === "--collection") {
      args.collection = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--collection=")) {
      args.collection = arg.slice("--collection=".length);
    } else if (arg === "--ttl-field") {
      args.ttlField = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--ttl-field=")) {
      args.ttlField = arg.slice("--ttl-field=".length);
    } else if (arg === "--count-up-to") {
      args.countUpTo = Number(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--count-up-to=")) {
      args.countUpTo = Number(arg.slice("--count-up-to=".length));
    } else if (arg === "--warn-docs") {
      args.warnDocs = Number(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--warn-docs=")) {
      args.warnDocs = Number(arg.slice("--warn-docs=".length));
    } else if (arg === "--fail-docs") {
      args.failDocs = Number(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--fail-docs=")) {
      args.failDocs = Number(arg.slice("--fail-docs=".length));
    } else if (arg === "--sample-limit") {
      args.sampleLimit = Number(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--sample-limit=")) {
      args.sampleLimit = Number(arg.slice("--sample-limit=".length));
    } else if (arg === "--expired-warn-docs") {
      args.expiredWarnDocs = Number(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--expired-warn-docs=")) {
      args.expiredWarnDocs = Number(arg.slice("--expired-warn-docs=".length));
    } else if (arg === "--expired-fail-docs") {
      args.expiredFailDocs = Number(readRequiredValue(index, arg));
      index += 1;
    } else if (arg.startsWith("--expired-fail-docs=")) {
      args.expiredFailDocs = Number(arg.slice("--expired-fail-docs=".length));
    } else if (arg === "--evidence") {
      args.evidencePath = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--evidence=")) {
      args.evidencePath = arg.slice("--evidence=".length);
    } else if (arg === "--run-id") {
      args.runId = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--run-id=")) {
      args.runId = arg.slice("--run-id=".length);
    } else if (arg === "--allow-ttl-unknown") {
      args.allowTtlUnknown = true;
    } else if (arg === "--write-cloud-log") {
      args.writeCloudLog = true;
    } else if (arg === "--cloud-log-name") {
      args.cloudLogName = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--cloud-log-name=")) {
      args.cloudLogName = arg.slice("--cloud-log-name=".length);
    } else if (arg === "--auth") {
      args.authMode = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--auth=")) {
      args.authMode = arg.slice("--auth=".length);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function positiveInteger(value, fallback, name) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return selected;
}

function nonNegativeInteger(value, fallback, name) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return selected;
}

function resolvePath(input, cwd = process.cwd()) {
  if (!input) {
    return null;
  }
  return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `idempotency-monitor-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export function loadIdempotencyMonitorConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  if (env.RUN_LIVE_IDEMPOTENCY_MONITOR !== "1" && !args.dryRun) {
    throw new Error(
      "Refusing to run Firestore idempotency monitor without RUN_LIVE_IDEMPOTENCY_MONITOR=1.",
    );
  }

  const project = args.project ?? env.GOOGLE_CLOUD_PROJECT ?? "chat-ai-sdk";
  const authMode =
    args.authMode ?? env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_AUTH ?? "service-account-key";
  if (!authModes.has(authMode)) {
    throw new Error(
      `--auth must be one of ${Array.from(authModes).join(", ")}.`,
    );
  }
  const warnDocs = positiveInteger(
    args.warnDocs ?? numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_WARN_DOCS),
    100,
    "--warn-docs",
  );
  const failDocs = positiveInteger(
    args.failDocs ?? numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_FAIL_DOCS),
    Math.max(warnDocs * 10, warnDocs + 1),
    "--fail-docs",
  );
  const countUpTo = positiveInteger(
    args.countUpTo ?? numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_COUNT_UP_TO),
    failDocs + 1,
    "--count-up-to",
  );

  return {
    dryRun: args.dryRun,
    project,
    database:
      args.database ??
      env.GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_DATABASE ??
      "(default)",
    collection:
      args.collection ??
      env.GOOGLE_CHAT_IDEMPOTENCY_FIRESTORE_COLLECTION ??
      "googleChatEventIdempotency",
    ttlField:
      args.ttlField ?? env.GOOGLE_CHAT_IDEMPOTENCY_TTL_FIELD ?? "expiresAt",
    authMode,
    credentialsPath:
      authMode === "metadata"
        ? null
        : resolvePath(
            env.GOOGLE_APPLICATION_CREDENTIALS ??
              path.join(
                os.homedir(),
                ".config/googlechatai-sdk/credentials/chat-ai-sdk-service-account.json",
              ),
            cwd,
          ),
    runId: args.runId ?? env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_RUN_ID ?? makeRunId(),
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EVIDENCE,
      cwd,
    ),
    countUpTo,
    warnDocs,
    failDocs,
    sampleLimit: positiveInteger(
      args.sampleLimit ??
        numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_SAMPLE_LIMIT),
      25,
      "--sample-limit",
    ),
    expiredWarnDocs: nonNegativeInteger(
      args.expiredWarnDocs ??
        numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EXPIRED_WARN_DOCS),
      1,
      "--expired-warn-docs",
    ),
    expiredFailDocs: nonNegativeInteger(
      args.expiredFailDocs ??
        numberEnv(env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_EXPIRED_FAIL_DOCS),
      25,
      "--expired-fail-docs",
    ),
    allowTtlUnknown:
      args.allowTtlUnknown || env.GOOGLE_CHAT_IDEMPOTENCY_ALLOW_TTL_UNKNOWN === "1",
    writeCloudLog:
      args.writeCloudLog ||
      env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_WRITE_CLOUD_LOG === "1",
    cloudLogName:
      args.cloudLogName ??
      env.GOOGLE_CHAT_IDEMPOTENCY_MONITOR_CLOUD_LOG_NAME ??
      defaultCloudLogName,
  };
}

function numberEnv(value) {
  if (value === undefined || value === "") {
    return null;
  }
  return Number(value);
}

function documentsParent(config) {
  return `projects/${config.project}/databases/${config.database}/documents`;
}

function collectionGroupFieldName(config) {
  return `projects/${config.project}/databases/${config.database}/collectionGroups/${config.collection}/fields/${config.ttlField}`;
}

function authModeLabel(config) {
  return config.authMode === "metadata"
    ? "metadata_service_account"
    : "service_account_key";
}

export function buildIdempotencyMonitorPlan(config) {
  const calls = [
    {
      operation: "firestore.fields.get.ttl",
      method: "GET",
      path: `/v1/${collectionGroupFieldName(config)}`,
      writes: false,
      authMode: authModeLabel(config),
      requiredScopes: [datastoreScope],
    },
    {
      operation: "firestore.documents.runAggregationQuery.count",
      method: "POST",
      path: `/v1/${documentsParent(config)}:runAggregationQuery`,
      writes: false,
      authMode: authModeLabel(config),
      requiredScopes: [datastoreScope],
    },
    {
      operation: "firestore.documents.runQuery.sample",
      method: "POST",
      path: `/v1/${documentsParent(config)}:runQuery`,
      writes: false,
      authMode: authModeLabel(config),
      requiredScopes: [datastoreScope],
    },
  ];

  if (config.writeCloudLog) {
    calls.push({
      operation: "logging.entries.write.monitor-result",
      method: "POST",
      path: "/v2/entries:write",
      writes: true,
      authMode: authModeLabel(config),
      requiredScopes: [loggingWriteScope],
      writesOnlyRedactedMonitorSummary: true,
    });
  }

  return {
    mode: config.dryRun
      ? "dry-run"
      : config.writeCloudLog
        ? "live-read-plus-cloud-log"
        : "live-read-only",
    project: config.project,
    authMode: authModeLabel(config),
    database: config.database,
    collection: config.collection,
    ttlField: config.ttlField,
    thresholds: {
      warnDocs: config.warnDocs,
      failDocs: config.failDocs,
      countUpTo: config.countUpTo,
      expiredWarnDocs: config.expiredWarnDocs,
      expiredFailDocs: config.expiredFailDocs,
      sampleLimit: config.sampleLimit,
    },
    calls,
    cloudLog: {
      enabled: Boolean(config.writeCloudLog),
      logName: config.cloudLogName,
      logResourceType: "global",
      emitsOnlyRedactedMonitorSummary: true,
    },
    privacy: {
      rawDocumentNamesSaved: false,
      rawEventKeysSaved: false,
      metadataJsonSaved: false,
    },
  };
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signJwt(serviceAccount, scopes) {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const claim = {
    iss: serviceAccount.client_email,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(claim),
  )}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsigned)
    .sign(serviceAccount.private_key, "base64url");

  return `${unsigned}.${signature}`;
}

function authScopesForConfig(config) {
  return config.writeCloudLog
    ? [datastoreScope, loggingWriteScope]
    : [datastoreScope];
}

async function fetchAccessToken(config, { fetchImpl = fetch, scopes = null } = {}) {
  if (config.authMode === "metadata") {
    return fetchMetadataAccessToken({ fetchImpl });
  }

  const serviceAccount = JSON.parse(await fs.readFile(config.credentialsPath, "utf8"));
  const assertion = signJwt(serviceAccount, scopes ?? authScopesForConfig(config));
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const json = await response.json().catch(() => ({}));

  if (!response.ok || typeof json.access_token !== "string") {
    throw new Error(`OAuth token request failed: HTTP ${response.status}`);
  }

  return json.access_token;
}

async function fetchMetadataAccessToken({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl(metadataTokenUrl, {
    method: "GET",
    headers: {
      "Metadata-Flavor": "Google",
    },
  });
  const json = await response.json().catch(() => ({}));

  if (!response.ok || typeof json.access_token !== "string") {
    throw new Error(`Metadata server token request failed: HTTP ${response.status}`);
  }

  return json.access_token;
}

async function firestoreJson(
  url,
  { operation, method, token, body = null, fetchImpl = fetch },
) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    const apiStatus = json?.error?.status ?? null;
    const apiMessage = json?.error?.message ?? null;
    const error = new Error(
      `Firestore ${operation ?? "request"} failed: HTTP ${response.status}${apiStatus ? ` ${apiStatus}` : ""}${apiMessage ? ` ${apiMessage}` : ""}`,
    );
    error.status = response.status;
    error.response = json;
    error.operation = operation ?? null;
    throw error;
  }

  return json;
}

async function loggingJson(
  url,
  { operation, method, token, body = null, fetchImpl = fetch },
) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    const apiStatus = json?.error?.status ?? null;
    const apiMessage = json?.error?.message ?? null;
    const error = new Error(
      `Cloud Logging ${operation ?? "request"} failed: HTTP ${response.status}${apiStatus ? ` ${apiStatus}` : ""}${apiMessage ? ` ${apiMessage}` : ""}`,
    );
    error.status = response.status;
    error.response = json;
    error.operation = operation ?? null;
    throw error;
  }

  return json;
}

function aggregationPayload(config) {
  return {
    structuredAggregationQuery: {
      structuredQuery: {
        from: [
          {
            collectionId: config.collection,
            allDescendants: true,
          },
        ],
      },
      aggregations: [
        {
          alias: "doc_count",
          count: {
            upTo: String(config.countUpTo),
          },
        },
      ],
    },
  };
}

function samplePayload(config) {
  return {
    structuredQuery: {
      select: {
        fields: [
          { fieldPath: "firstSeenAt" },
          { fieldPath: "lastSeenAt" },
          { fieldPath: "expiresAt" },
          { fieldPath: "seenCount" },
        ],
      },
      from: [
        {
          collectionId: config.collection,
          allDescendants: true,
        },
      ],
      limit: config.sampleLimit,
    },
  };
}

function aggregationCount(response, alias = "doc_count") {
  const rows = Array.isArray(response) ? response : [response];
  for (const row of rows) {
    const value = row?.result?.aggregateFields?.[alias];
    if (value?.integerValue !== undefined) {
      return Number(value.integerValue);
    }
  }
  return 0;
}

function firestoreTimestamp(fields, name) {
  const value = fields?.[name]?.timestampValue;
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

function firestoreInteger(fields, name) {
  const value = fields?.[name]?.integerValue;
  const number = value === undefined ? null : Number(value);
  return Number.isFinite(number) ? number : null;
}

function summarizeSample(rows, now = new Date()) {
  const docs = (Array.isArray(rows) ? rows : [rows])
    .map((row) => row.document?.fields)
    .filter(Boolean);
  const firstSeen = [];
  const lastSeen = [];
  const expires = [];
  const seenCounts = [];
  let expiredDocs = 0;
  let missingExpiresAt = 0;

  for (const fields of docs) {
    const firstSeenAt = firestoreTimestamp(fields, "firstSeenAt");
    const lastSeenAt = firestoreTimestamp(fields, "lastSeenAt");
    const expiresAt = firestoreTimestamp(fields, "expiresAt");
    const seenCount = firestoreInteger(fields, "seenCount");

    if (firstSeenAt) {
      firstSeen.push(firstSeenAt);
    }
    if (lastSeenAt) {
      lastSeen.push(lastSeenAt);
    }
    if (expiresAt) {
      expires.push(expiresAt);
      if (Date.parse(expiresAt) < now.getTime()) {
        expiredDocs += 1;
      }
    } else {
      missingExpiresAt += 1;
    }
    if (seenCount !== null) {
      seenCounts.push(seenCount);
    }
  }

  return {
    sampled: docs.length,
    firstSeenAt: minMaxIso(firstSeen),
    lastSeenAt: minMaxIso(lastSeen),
    expiresAt: minMaxIso(expires),
    seenCount: {
      max: seenCounts.length > 0 ? Math.max(...seenCounts) : null,
      duplicateDocuments: seenCounts.filter((count) => count > 1).length,
    },
    expiredInSample: expiredDocs,
    missingExpiresAt,
  };
}

function minMaxIso(values) {
  if (values.length === 0) {
    return { min: null, max: null };
  }
  return {
    min: values.reduce((left, right) =>
      Date.parse(left) <= Date.parse(right) ? left : right,
    ),
    max: values.reduce((left, right) =>
      Date.parse(left) >= Date.parse(right) ? left : right,
    ),
  };
}

function ttlStateFromField(config, field) {
  return {
    available: Boolean(field?.ttlConfig),
    state: field?.ttlConfig?.state ?? null,
    fieldNameMatches:
      typeof field?.name === "string" &&
      field.name === collectionGroupFieldName(config),
  };
}

function collectFindings({ config, count, expiredCount, ttl, sample }) {
  const warnings = [];
  const failures = [];

  if (ttl.available && ttl.state !== "ACTIVE") {
    failures.push(`ttl-not-active:${ttl.state ?? "unknown"}`);
  }
  if (!ttl.available && !config.allowTtlUnknown) {
    failures.push("ttl-unavailable");
  }
  if (count >= config.failDocs) {
    failures.push(`doc-count-${count}-gte-fail-${config.failDocs}`);
  } else if (count >= config.warnDocs) {
    warnings.push(`doc-count-${count}-gte-warn-${config.warnDocs}`);
  }
  if (expiredCount >= config.expiredFailDocs && config.expiredFailDocs > 0) {
    failures.push(
      `expired-count-${expiredCount}-gte-fail-${config.expiredFailDocs}`,
    );
  } else if (expiredCount >= config.expiredWarnDocs && config.expiredWarnDocs > 0) {
    warnings.push(
      `expired-count-${expiredCount}-gte-warn-${config.expiredWarnDocs}`,
    );
  }
  if (sample.missingExpiresAt > 0) {
    warnings.push(`sample-missing-expiresAt-${sample.missingExpiresAt}`);
  }

  return { warnings, failures };
}

function severityForFindings(findings) {
  if (findings.failures.length > 0) {
    return "ERROR";
  }
  if (findings.warnings.length > 0) {
    return "WARNING";
  }
  return "INFO";
}

function cloudLogName(config) {
  return `projects/${config.project}/logs/${config.cloudLogName}`;
}

function buildCloudLogPayload(evidence, severity) {
  return {
    event: "google_chat_idempotency_monitor",
    runId: evidence.runId,
    mode: evidence.mode,
    project: evidence.project,
    database: evidence.database,
    collection: evidence.collection,
    ttlField: evidence.ttlField,
    ok: evidence.ok,
    severity,
    warningCount: evidence.warnings.length,
    failureCount: evidence.failures.length,
    warnings: evidence.warnings,
    failures: evidence.failures,
    thresholds: evidence.thresholds,
    ttl: evidence.ttl,
    counts: evidence.counts,
    sample: evidence.sample,
    privacy: evidence.privacy,
  };
}

function buildCloudLogWriteBody(config, evidence, severity) {
  return {
    logName: cloudLogName(config),
    entries: [
      {
        resource: {
          type: "global",
          labels: {
            project_id: config.project,
          },
        },
        severity,
        labels: {
          component: "idempotency-monitor",
          run_id: config.runId,
        },
        jsonPayload: buildCloudLogPayload(evidence, severity),
      },
    ],
  };
}

async function writeCloudLogEntry(
  config,
  evidence,
  { token, fetchImpl = fetch, severity },
) {
  await loggingJson("https://logging.googleapis.com/v2/entries:write", {
    operation: "logging.entries.write.monitor-result",
    method: "POST",
    token,
    fetchImpl,
    body: buildCloudLogWriteBody(config, evidence, severity),
  });

  return {
    enabled: true,
    written: true,
    logName: config.cloudLogName,
    severity,
    operation: "logging.entries.write.monitor-result",
  };
}

async function writeEvidenceFile(config, evidence) {
  const evidencePath =
    config.evidencePath ??
    path.join(defaultEvidenceDir, `cloud-idempotency-monitor-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

export async function runIdempotencyMonitor(
  config,
  { writeEvidence = true, fetchImpl = fetch, getAccessToken } = {},
) {
  if (config.help) {
    return { ok: true, evidence: { help: true } };
  }

  if (config.dryRun) {
    return { ok: true, evidence: buildIdempotencyMonitorPlan(config) };
  }

  const startedAt = new Date().toISOString();
  const now = new Date();
  const token = getAccessToken
    ? await getAccessToken(config, { scopes: authScopesForConfig(config) })
    : await fetchAccessToken(config, { fetchImpl });
  const baseUrl = "https://firestore.googleapis.com/v1";
  const documentsUrl = `${baseUrl}/${documentsParent(config)}`;
  let ttl = { available: false, state: null, fieldNameMatches: false };

  try {
    const field = await firestoreJson(
      `${baseUrl}/${collectionGroupFieldName(config)}`,
      { operation: "firestore.fields.get.ttl", method: "GET", token, fetchImpl },
    );
    ttl = ttlStateFromField(config, field);
  } catch (error) {
    ttl = {
      available: false,
      state: null,
      fieldNameMatches: false,
      error: {
        status: error.status ?? null,
        name: error.name ?? "Error",
      },
    };
  }

  const countResponse = await firestoreJson(`${documentsUrl}:runAggregationQuery`, {
    operation: "firestore.documents.runAggregationQuery.count",
    method: "POST",
    token,
    fetchImpl,
    body: aggregationPayload(config),
  });
  const sampleResponse = await firestoreJson(`${documentsUrl}:runQuery`, {
    operation: "firestore.documents.runQuery.sample",
    method: "POST",
    token,
    fetchImpl,
    body: samplePayload(config),
  });
  const count = aggregationCount(countResponse);
  const sample = summarizeSample(sampleResponse, now);
  const expiredCount = sample.expiredInSample;
  const findings = collectFindings({ config, count, expiredCount, ttl, sample });
  const severity = severityForFindings(findings);
  const evidence = {
    ok: findings.failures.length === 0,
    mode: "firestore-idempotency-monitor",
    runId: config.runId,
    project: config.project,
    database: config.database,
    collection: config.collection,
    ttlField: config.ttlField,
    startedAt,
    finishedAt: new Date().toISOString(),
    thresholds: {
      warnDocs: config.warnDocs,
      failDocs: config.failDocs,
      countUpTo: config.countUpTo,
      expiredWarnDocs: config.expiredWarnDocs,
      expiredFailDocs: config.expiredFailDocs,
      sampleLimit: config.sampleLimit,
    },
    ttl,
    counts: {
      documents: count,
      countMayBeCapped: count >= config.countUpTo,
      expiredDocumentsInSample: expiredCount,
    },
    sample,
    warnings: findings.warnings,
    failures: findings.failures,
    cloudLog: {
      enabled: Boolean(config.writeCloudLog),
      written: false,
      logName: config.cloudLogName,
      severity,
      operation: config.writeCloudLog
        ? "logging.entries.write.monitor-result"
        : null,
    },
    privacy: {
      rawDocumentNamesSaved: false,
      rawEventKeysSaved: false,
      metadataJsonSaved: false,
    },
  };

  if (config.writeCloudLog) {
    try {
      evidence.cloudLog = await writeCloudLogEntry(config, evidence, {
        token,
        fetchImpl,
        severity,
      });
    } catch (error) {
      evidence.cloudLog = {
        ...evidence.cloudLog,
        written: false,
        error: {
          status: error.status ?? null,
          name: error.name ?? "Error",
          message: error.message ?? String(error),
        },
      };
      if (writeEvidence) {
        evidence.evidencePath = await writeEvidenceFile(config, evidence);
      }
      const wrapped = new Error(
        `Idempotency monitor Cloud Logging write failed: ${error.message}`,
      );
      wrapped.evidence = evidence;
      throw wrapped;
    }
  }

  if (writeEvidence) {
    evidence.evidencePath = await writeEvidenceFile(config, evidence);
  }

  if (findings.failures.length > 0) {
    const error = new Error(
      `Idempotency monitor failed: ${findings.failures.join(", ")}`,
    );
    error.evidence = evidence;
    throw error;
  }

  return { ok: true, evidence };
}

function usage() {
  return `${[
    "Usage: pnpm cloud:idempotency-monitor",
    "",
    "Read-only Firestore monitor for the Google Chat event idempotency collection.",
    "Requires RUN_LIVE_IDEMPOTENCY_MONITOR=1 unless --dry-run is supplied.",
    "",
    "Options:",
    "  --dry-run                    Show the read-only Firestore plan.",
    "  --project <id>               Google Cloud project. Defaults to GOOGLE_CLOUD_PROJECT.",
    "  --database <id>              Firestore database. Default: (default).",
    "  --collection <id>            Collection group. Default: googleChatEventIdempotency.",
    "  --ttl-field <field>          TTL field. Default: expiresAt.",
    "  --warn-docs <n>              Warn at document count. Default: 100.",
    "  --fail-docs <n>              Fail at document count. Default: max(warn*10, warn+1).",
    "  --count-up-to <n>            Firestore count upper bound. Default: fail+1.",
    "  --sample-limit <n>           Number of docs to sample without names/keys. Default: 25.",
    "  --expired-warn-docs <n>      Warn when expired docs reach n. Default: 1.",
    "  --expired-fail-docs <n>      Fail when expired docs reach n. Default: 25.",
    "  --allow-ttl-unknown          Do not fail if TTL field metadata cannot be read.",
    "  --write-cloud-log            Emit a redacted monitor summary to Cloud Logging.",
    `  --cloud-log-name <name>       Cloud Logging log id. Default: ${defaultCloudLogName}.`,
    "  --auth <mode>                service-account-key or metadata. Default: service-account-key.",
    "  --evidence <path>            Evidence JSON output path.",
    "  --run-id <id>                Stable run id for evidence.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = loadIdempotencyMonitorConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runIdempotencyMonitor(config);
    process.stdout.write(`${JSON.stringify(result.evidence, null, 2)}\n`);
  } catch (error) {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
      process.stdout.write(usage());
      return;
    }
    console.error(
      JSON.stringify(
        {
          name: error.name ?? "Error",
          message: error.message ?? String(error),
        },
        null,
        2,
      ),
    );
    if (error.evidence) {
      console.error(JSON.stringify(error.evidence, null, 2));
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
