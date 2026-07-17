import fs from "node:fs/promises";
import path from "node:path";

import { planChatPermission } from "../../dist/index.js";

import {
  CliUsageError,
  asRecord,
  assertOnlyOptions,
  normalizedFormat,
  parseCommandArgs,
  readJsonFile,
  resolvePath,
  writeJson,
} from "./common.mjs";
import { validateSmokeMetadata } from "./smoke.mjs";

function check(id, status, summary, remediation = null) {
  return {
    id,
    status,
    summary,
    ...(remediation ? { remediation } : {}),
  };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function projectCheck(cwd) {
  const candidates = [
    ["package.json", "Node"],
    ["pyproject.toml", "Python"],
    ["requirements.txt", "Python"],
  ];
  for (const [file, language] of candidates) {
    if (await exists(path.join(cwd, file))) {
      return check(
        "project.detected",
        "pass",
        `${language} project detected through ${file}.`,
      );
    }
  }
  return check(
    "project.detected",
    "warn",
    "No Node or Python project manifest was found in the current directory.",
    "Run this command inside the generated application directory.",
  );
}

function runtimeCheck(version = process.versions.node) {
  const major = Number(version.split(".")[0]);
  return Number.isInteger(major) && major >= 22
    ? check("runtime.node", "pass", `Node ${version} satisfies the CLI requirement.`)
    : check(
        "runtime.node",
        "fail",
        `Node ${version} is unsupported.`,
        "Install Node 22 or newer.",
      );
}

function projectNumberCheck(value) {
  if (!value) {
    return check(
      "chat.projectNumber",
      "warn",
      "GOOGLE_CHAT_PROJECT_NUMBER is not configured.",
      "Set the numeric Google Cloud project number used as the Chat callback audience.",
    );
  }
  return /^\d+$/.test(value)
    ? check("chat.projectNumber", "pass", "Chat callback audience is a numeric project number.")
    : check(
        "chat.projectNumber",
        "fail",
        "GOOGLE_CHAT_PROJECT_NUMBER is not numeric.",
        "Use the project number, not the project ID.",
      );
}

function appUserCheck(value) {
  if (!value) {
    return check(
      "chat.appUser",
      "warn",
      "GOOGLE_CHAT_APP_USER is not configured.",
      "Set the Chat app's users/... resource before running the live smoke.",
    );
  }
  return value.startsWith("users/")
    ? check("chat.appUser", "pass", "Chat app user resource is configured.")
    : check(
        "chat.appUser",
        "fail",
        "GOOGLE_CHAT_APP_USER is not a users/... resource.",
      );
}

async function credentialsCheck(filePath, cwd) {
  if (!filePath) {
    return check(
      "auth.credentials",
      "warn",
      "No explicit service-account credential file is configured.",
      "Set GOOGLE_APPLICATION_CREDENTIALS when the application needs app-auth API calls; local fixture replay does not need it.",
    );
  }
  const resolved = resolvePath(filePath, cwd);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(resolved, "utf8"));
  } catch (error) {
    return check(
      "auth.credentials",
      "fail",
      `Credential file is unreadable or invalid JSON: ${path.basename(resolved)}.`,
      error.code === "ENOENT"
        ? "Point GOOGLE_APPLICATION_CREDENTIALS at an existing file outside the repository."
        : "Replace the file with a valid service-account JSON credential.",
    );
  }
  const record = asRecord(parsed);
  const valid =
    record?.type === "service_account" &&
    typeof record.client_email === "string" &&
    typeof record.private_key === "string" &&
    typeof record.project_id === "string";
  return valid
    ? check(
        "auth.credentials",
        "pass",
        `Service-account credential shape is valid (${path.basename(resolved)}); secret values were not printed.`,
      )
    : check(
        "auth.credentials",
        "fail",
        "Credential JSON does not have the required service-account fields.",
      );
}

function endpointHealthUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new CliUsageError("A non-local Chat endpoint must use https.");
  }
  url.pathname = "/healthz";
  url.search = "";
  url.hash = "";
  return url;
}

async function endpointCheck(value, probe, fetchImpl) {
  if (!value) {
    return check(
      "endpoint.url",
      "warn",
      "GOOGLE_CHAT_ENDPOINT_URL is not configured.",
      "Set the exact public /chat/events callback URL after deployment.",
    );
  }
  let health;
  try {
    health = endpointHealthUrl(value);
  } catch (error) {
    return check("endpoint.url", "fail", error.message);
  }
  if (!probe) {
    return check(
      "endpoint.url",
      "pass",
      `Endpoint URL is structurally valid; health probe available at ${health.origin}/healthz.`,
    );
  }
  if (typeof fetchImpl !== "function") {
    return check("endpoint.health", "fail", "No fetch implementation is available.");
  }
  try {
    const response = await fetchImpl(health, {
      headers: { accept: "application/json" },
    });
    return response.ok
      ? check("endpoint.health", "pass", `Health endpoint returned HTTP ${response.status}.`)
      : check(
          "endpoint.health",
          "fail",
          `Health endpoint returned HTTP ${response.status}.`,
        );
  } catch (error) {
    return check("endpoint.health", "fail", `Health probe failed: ${error.message}`);
  }
}

async function metadataCheck(metadataPath, context) {
  if (!metadataPath) {
    return check(
      "smoke.metadata",
      "warn",
      "Dedicated smoke-space metadata is not configured.",
      "Copy the smoke metadata example and run `googlechatai smoke --metadata ...`.",
    );
  }
  try {
    const loaded = await readJsonFile(metadataPath, context.cwd, "smoke metadata");
    validateSmokeMetadata(
      loaded.value,
      context.env.GOOGLE_CHAT_TEST_SPACE ?? null,
    );
    return check(
      "smoke.metadata",
      "pass",
      "Dedicated smoke-space metadata satisfies the safety contract.",
    );
  } catch (error) {
    return check("smoke.metadata", "fail", error.message);
  }
}

function renderSummary(result) {
  return [
    `Google Chat doctor: ${result.status.toUpperCase()}`,
    ...result.checks.map(
      (entry) =>
        `${entry.status.toUpperCase().padEnd(4)} ${entry.id}: ${entry.summary}${
          entry.remediation ? `\n     ${entry.remediation}` : ""
        }`,
    ),
  ].join("\n");
}

export async function runDoctorCommand(args, context) {
  const { options, positionals } = parseCommandArgs(args, {
    booleanFlags: ["probe", "strict", "help"],
  });
  assertOnlyOptions(options, [
    "endpoint",
    "credentials",
    "metadata",
    "capability",
    "principal",
    "format",
    "probe",
    "strict",
    "help",
  ]);
  if (positionals.length > 0) {
    throw new CliUsageError("doctor does not accept positional arguments.");
  }
  if (options.help) {
    context.stdout.write(
      [
        "Usage: googlechatai doctor [--probe] [--strict] [--format summary|json]",
        "       [--endpoint URL] [--credentials FILE] [--metadata FILE]",
        "       [--capability INTENT] [--principal app|user]",
        "",
        "Checks local project shape, callback audience, app identity, credential",
        "shape, endpoint configuration, dedicated smoke metadata, and optional",
        "capability/principal compatibility. Secret values are never printed.",
      ].join("\n") + "\n",
    );
    return { exitCode: 0, result: null };
  }

  const format = normalizedFormat(options.format);
  const checks = [
    runtimeCheck(),
    await projectCheck(context.cwd),
    projectNumberCheck(context.env.GOOGLE_CHAT_PROJECT_NUMBER),
    appUserCheck(context.env.GOOGLE_CHAT_APP_USER),
    await credentialsCheck(
      options.credentials ?? context.env.GOOGLE_APPLICATION_CREDENTIALS,
      context.cwd,
    ),
    await endpointCheck(
      options.endpoint ?? context.env.GOOGLE_CHAT_ENDPOINT_URL,
      options.probe === true,
      context.fetch,
    ),
    context.env.GOOGLE_CHAT_ENDPOINT_CONFIGURED === "1"
      ? check(
          "chat.registration",
          "pass",
          "Operator attests the exact endpoint is configured in Google Chat.",
        )
      : check(
          "chat.registration",
          "warn",
          "Google Chat endpoint registration has not been attested.",
          "After checking the Google Cloud Chat configuration, set GOOGLE_CHAT_ENDPOINT_CONFIGURED=1.",
        ),
    await metadataCheck(
      options.metadata ?? context.env.GOOGLE_CHAT_SMOKE_METADATA,
      context,
    ),
  ];

  let capability = null;
  if (options.capability) {
    capability = planChatPermission(options.capability, {
      ...(options.principal ? { principal: options.principal } : {}),
    });
    checks.push(
      capability.ok
        ? check(
            "chat.capability",
            "pass",
            `${options.capability} is available for ${capability.principal}.`,
          )
        : check(
            "chat.capability",
            "fail",
            `${options.capability} is unavailable for ${capability.principal}.`,
            (capability.remediation ?? []).join(" "),
          ),
    );
  }

  const failed = checks.some((entry) => entry.status === "fail");
  const warned = checks.some((entry) => entry.status === "warn");
  const status = failed ? "fail" : warned ? "warn" : "pass";
  const result = {
    kind: "googlechatai.doctor_result",
    status,
    strict: options.strict === true,
    checks,
    capability,
  };

  if (format === "json") {
    writeJson(context.stdout, result);
  } else {
    context.stdout.write(`${renderSummary(result)}\n`);
  }
  return {
    exitCode: failed || (options.strict === true && warned) ? 1 : 0,
    result,
  };
}
