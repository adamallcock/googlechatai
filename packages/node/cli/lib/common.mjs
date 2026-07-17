import fs from "node:fs/promises";
import path from "node:path";

export class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function asString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function parseCommandArgs(
  argv,
  { booleanFlags = [], aliases = { "-h": "help" } } = {},
) {
  const booleans = new Set(booleanFlags);
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];

    if (raw === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (raw in aliases) {
      options[aliases[raw]] = true;
      continue;
    }

    if (!raw.startsWith("--")) {
      positionals.push(raw);
      continue;
    }

    const equalIndex = raw.indexOf("=");
    const key = raw.slice(2, equalIndex === -1 ? undefined : equalIndex);
    if (!key) {
      throw new CliUsageError(`Invalid option: ${raw}`);
    }

    if (equalIndex !== -1) {
      options[key] = raw.slice(equalIndex + 1);
      continue;
    }

    if (booleans.has(key)) {
      options[key] = true;
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`--${key} requires a value.`);
    }
    options[key] = value;
    index += 1;
  }

  return { options, positionals };
}

export function assertOnlyOptions(options, allowed) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(options).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new CliUsageError(`Unknown option: --${unknown[0]}`);
  }
}

export function resolvePath(input, cwd) {
  if (!input) {
    return null;
  }
  return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}

export async function readJsonFile(input, cwd, label = "JSON input") {
  const filePath = resolvePath(input, cwd);
  if (!filePath) {
    throw new CliUsageError(`${label} path is required.`);
  }

  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new CliUsageError(`Unable to read ${label} ${filePath}: ${error.message}`);
  }

  try {
    return { filePath, value: JSON.parse(text) };
  } catch (error) {
    throw new CliUsageError(`${label} is not valid JSON: ${error.message}`);
  }
}

export function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function normalizedFormat(value, fallback = "summary") {
  const format = asString(value) ?? fallback;
  if (!["summary", "json"].includes(format)) {
    throw new CliUsageError("--format must be summary or json.");
  }
  return format;
}

export function positiveInteger(value, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new CliUsageError(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return parsed;
}

export function redactPath(filePath, cwd) {
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith("..") ? relative : path.basename(filePath);
}

export function safeEvent(event, { includeRaw = false } = {}) {
  if (!asRecord(event)) {
    return event;
  }
  const { raw, ...safe } = event;
  return includeRaw ? { ...safe, raw } : safe;
}

export function responseBodyContainsText(value, expected) {
  if (typeof value === "string") {
    return value.includes(expected);
  }
  if (Array.isArray(value)) {
    return value.some((item) => responseBodyContainsText(item, expected));
  }
  const record = asRecord(value);
  return record
    ? Object.values(record).some((item) => responseBodyContainsText(item, expected))
    : false;
}
