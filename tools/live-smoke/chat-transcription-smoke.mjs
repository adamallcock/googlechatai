import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const defaultEnvPath = path.join(repoRoot, ".env.local");
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const TRANSCRIPTION_PROVIDERS = {
  openai: {
    kind: "openai_transcription_smoke",
    model: "gpt-4o-transcribe",
    endpoint: "https://api.openai.com/v1/audio/transcriptions",
    apiKeyEnv: "OPENAI_API_KEY",
    missingReason: "openai_api_key_missing",
  },
  gemini: {
    kind: "gemini_transcription_smoke",
    model: "gemini-3.5-flash",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/interactions",
    apiKeyEnv: "GEMINI_API_KEY",
    alternateApiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
    missingReason: "gemini_api_key_missing",
  },
};

function parseArgs(argv) {
  const args = {
    dryRun: false,
    provider: "openai",
    model: null,
    audioFile: null,
    sampleUrl: null,
    evidencePath: null,
    maxBytes: DEFAULT_MAX_BYTES,
    includeTranscriptText: false,
    help: false,
  };
  const rest = argv.slice(2);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--provider") {
      args.provider = rest[++index];
    } else if (arg.startsWith("--provider=")) {
      args.provider = arg.slice("--provider=".length);
    } else if (arg === "--model") {
      args.model = rest[++index];
    } else if (arg.startsWith("--model=")) {
      args.model = arg.slice("--model=".length);
    } else if (arg === "--audio-file") {
      args.audioFile = rest[++index];
    } else if (arg.startsWith("--audio-file=")) {
      args.audioFile = arg.slice("--audio-file=".length);
    } else if (arg === "--sample-url") {
      args.sampleUrl = rest[++index];
    } else if (arg.startsWith("--sample-url=")) {
      args.sampleUrl = arg.slice("--sample-url=".length);
    } else if (arg === "--evidence") {
      args.evidencePath = rest[++index];
    } else if (arg.startsWith("--evidence=")) {
      args.evidencePath = arg.slice("--evidence=".length);
    } else if (arg === "--max-bytes") {
      args.maxBytes = Number(rest[++index]);
    } else if (arg.startsWith("--max-bytes=")) {
      args.maxBytes = Number(arg.slice("--max-bytes=".length));
    } else if (arg === "--include-transcript-text") {
      args.includeTranscriptText = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--") {
      continue;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!TRANSCRIPTION_PROVIDERS[args.provider]) {
    throw new Error(
      `Unknown transcription provider: ${args.provider}. Expected one of: ${Object.keys(
        TRANSCRIPTION_PROVIDERS,
      ).join(", ")}`,
    );
  }
  return args;
}

async function loadEnvFileAsync(filePath = defaultEnvPath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const env = {};
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }
      const [key, ...rest] = trimmed.split("=");
      env[key] = rest.join("=").replace(/^["']|["']$/g, "");
    }
    return env;
  } catch {
    return {};
  }
}

function makeRunId(env) {
  if (env.GOOGLE_CHAT_TRANSCRIPTION_SMOKE_RUN_ID) {
    return env.GOOGLE_CHAT_TRANSCRIPTION_SMOKE_RUN_ID;
  }
  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `transcription-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function resolvePath(input) {
  if (!input) {
    return null;
  }
  return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}

function contentTypeFor(filename) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".wav") {
    return "audio/wav";
  }
  if (extension === ".mp3") {
    return "audio/mpeg";
  }
  if (extension === ".m4a") {
    return "audio/mp4";
  }
  if (extension === ".ogg") {
    return "audio/ogg";
  }
  return "application/octet-stream";
}

export function buildTranscriptionSmokePlan({ args, env }) {
  const providerName = args.provider ?? "openai";
  const provider = TRANSCRIPTION_PROVIDERS[providerName];
  if (!provider) {
    throw new Error(
      `Unknown transcription provider: ${providerName}. Expected one of: ${Object.keys(
        TRANSCRIPTION_PROVIDERS,
      ).join(", ")}`,
    );
  }
  const apiKey =
    env[provider.apiKeyEnv] ??
    (provider.alternateApiKeyEnv ? env[provider.alternateApiKeyEnv] : undefined);
  const reasons = [];
  if (!args.dryRun && env.RUN_LIVE_TRANSCRIPTION_SMOKE !== "1") {
    reasons.push("live_env_gate_missing");
  }
  if (!args.dryRun && !apiKey) {
    reasons.push(provider.missingReason);
  }
  if (!args.audioFile && !args.sampleUrl) {
    reasons.push("audio_source_missing");
  }
  if (args.sampleUrl && env.RUN_LIVE_TRANSCRIPTION_SAMPLE_DOWNLOAD !== "1") {
    reasons.push("sample_download_gate_missing");
  }
  if (!Number.isInteger(args.maxBytes) || args.maxBytes <= 0) {
    reasons.push("invalid_max_bytes");
  }
  return {
    kind: provider.kind,
    provider: providerName,
    model: args.model ?? provider.model,
    endpoint: provider.endpoint,
    dryRun: args.dryRun,
    canExecuteLive: reasons.length === 0,
    blockedReasons: reasons,
    evidence: {
      storesRawAudio: false,
      storesRawTranscriptByDefault: false,
      includeTranscriptText: args.includeTranscriptText,
    },
  };
}

async function readAudioBytes(args, env) {
  if (args.audioFile) {
    const filePath = resolvePath(args.audioFile);
    return {
      bytes: await fs.readFile(filePath),
      filename: path.basename(filePath),
      source: "local_file",
    };
  }
  const response = await fetch(args.sampleUrl);
  if (!response.ok) {
    throw new Error(`Sample download failed: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    bytes,
    filename: path.basename(new URL(args.sampleUrl).pathname) || "sample-audio",
    source: "sample_url",
    sampleUrlHost: new URL(args.sampleUrl).host,
    sampleDownloadGate: env.RUN_LIVE_TRANSCRIPTION_SAMPLE_DOWNLOAD,
  };
}

async function loadSdk() {
  try {
    return await import(
      pathToFileURL(path.join(repoRoot, "packages/node/dist/index.js"))
    );
  } catch (error) {
    throw new Error(
      `Unable to load built SDK. Run \`corepack pnpm build\` first. ${error.message}`,
    );
  }
}

async function writeEvidence(evidencePath, evidence) {
  await fs.mkdir(path.dirname(evidencePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function assertTranscriptionSmokeComplete(transcribed) {
  const result = transcribed?.processing?.transcription;
  if (result?.status !== "complete") {
    throw new Error(
      `Transcription provider returned ${result?.status ?? "unknown"}: ${
        result?.reason ?? "no reason provided"
      }`,
    );
  }
}

export async function runTranscriptionSmoke({
  argv = process.argv,
  env = process.env,
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    return {
      help: true,
      usage:
        "RUN_LIVE_TRANSCRIPTION_SMOKE=1 GEMINI_API_KEY=... pnpm live:chat-transcription-smoke -- --provider gemini --audio-file sample.wav",
    };
  }
  const localEnv = await loadEnvFileAsync();
  const mergedEnv = { ...localEnv, ...env };
  const runId = makeRunId(mergedEnv);
  const evidencePath =
    resolvePath(args.evidencePath) ??
    path.join(defaultEvidenceDir, `chat-transcription-smoke-${runId}.json`);
  const plan = buildTranscriptionSmokePlan({ args, env: mergedEnv });

  if (args.dryRun || !plan.canExecuteLive) {
    const evidence = {
      runId,
      plan,
      assertions: {
        noProviderCall: true,
        noRawAudioSaved: true,
        noRawTranscriptSaved: true,
      },
    };
    await writeEvidence(evidencePath, evidence);
    if (!args.dryRun) {
      throw new Error(`Transcription smoke blocked: ${plan.blockedReasons.join(", ")}`);
    }
    return evidence;
  }

  const sdk = await loadSdk();
  const audio = await readAudioBytes(args, mergedEnv);
  if (audio.bytes.byteLength > args.maxBytes) {
    throw new Error(
      `Audio source is ${audio.bytes.byteLength} bytes, exceeding --max-bytes ${args.maxBytes}.`,
    );
  }
  const attachment = sdk.normalizeAttachment({
    name: `local/transcription-smoke/${runId}`,
    contentName: audio.filename,
    contentType: contentTypeFor(audio.filename),
    contentSizeBytes: audio.bytes.byteLength,
  });
  const provider =
    plan.provider === "gemini"
      ? sdk.createGeminiTranscriptionProvider({
          apiKey: mergedEnv.GEMINI_API_KEY ?? mergedEnv.GOOGLE_GENERATIVE_AI_API_KEY,
          maxBytes: args.maxBytes,
          model: plan.model,
        })
      : sdk.createOpenAITranscriptionProvider({
          apiKey: mergedEnv.OPENAI_API_KEY,
          maxBytes: args.maxBytes,
          model: plan.model,
        });
  const transcribed = await sdk.transcribeAudio(attachment, audio.bytes, {
    enabled: true,
    provider,
  });
  const evidence = {
    runId,
    plan,
    audio: {
      source: audio.source,
      filenameHash: crypto.createHash("sha256").update(audio.filename).digest("hex"),
      sampleUrlHost: audio.sampleUrlHost ?? null,
    },
    transcription: sdk.summarizeTranscriptionEvidence({
      attachment,
      data: audio.bytes,
      result: transcribed.processing.transcription,
      includeTranscriptText: args.includeTranscriptText,
    }),
    assertions: {
      providerStatus: transcribed.processing.transcription.status,
      noRawAudioSaved: true,
      noRawTranscriptSaved: args.includeTranscriptText !== true,
    },
  };
  await writeEvidence(evidencePath, evidence);
  assertTranscriptionSmokeComplete(transcribed);
  return evidence;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTranscriptionSmoke()
    .then((evidence) => {
      console.log(JSON.stringify(evidence, null, 2));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
