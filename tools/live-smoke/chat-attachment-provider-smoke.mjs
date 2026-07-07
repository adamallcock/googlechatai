import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultFixturePath = path.join(repoRoot, "fixtures/attachments/context-tree.json");
const defaultEvidenceDir = path.join(repoRoot, "fixtures/live/evidence");
const distEntryPath = path.join(repoRoot, "packages/node/dist/index.js");

function parseArgs(argv) {
  const args = {
    fixturePath: null,
    evidencePath: null,
    runId: null,
    skipPython: false,
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
    } else if (arg === "--fixture") {
      args.fixturePath = readRequiredValue(index, arg);
      index += 1;
    } else if (arg.startsWith("--fixture=")) {
      args.fixturePath = arg.slice("--fixture=".length);
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
    } else if (arg === "--skip-python") {
      args.skipPython = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function resolvePath(input, cwd = process.cwd()) {
  if (!input) {
    return null;
  }
  return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  return `attachment-provider-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export function loadAttachmentProviderSmokeConfig({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    return { help: true };
  }

  return {
    fixturePath: resolvePath(
      args.fixturePath ?? env.GOOGLE_CHAT_ATTACHMENT_PROVIDER_FIXTURE,
      cwd,
    ) ?? defaultFixturePath,
    evidencePath: resolvePath(
      args.evidencePath ?? env.GOOGLE_CHAT_ATTACHMENT_PROVIDER_EVIDENCE,
      cwd,
    ),
    runId: args.runId ?? env.GOOGLE_CHAT_ATTACHMENT_PROVIDER_RUN_ID ?? makeRunId(),
    skipPython: args.skipPython,
  };
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update("googlechatai-attachment-provider-smoke")
    .update("\0")
    .update(String(value ?? ""))
    .digest("hex");
}

function textSummary(text) {
  return {
    available: typeof text === "string",
    length: typeof text === "string" ? text.length : 0,
    hash: typeof text === "string" ? stableHash(text) : null,
  };
}

function contextSummary(parts) {
  return {
    count: parts.length,
    firstType: parts[0]?.type ?? null,
    firstHasSystemNote: parts[0]?.type === "system_note",
    contentStatus: parts.find((part) => part.type === "attachment_content")?.status ?? null,
    contentText: textSummary(
      parts.find((part) => part.type === "attachment_content")?.text,
    ),
  };
}

function summarizeAttachment(attachment) {
  return {
    safeFilename: attachment.safeFilename,
    mediaKind: attachment.mediaKind,
    extraction: {
      status: attachment.processing.extraction.status,
      parser: attachment.processing.extraction.parser,
      text: textSummary(attachment.processing.extraction.text),
      reasonHash: attachment.processing.extraction.reason
        ? stableHash(attachment.processing.extraction.reason)
        : null,
    },
    transcription: {
      status: attachment.processing.transcription.status,
      provider: attachment.processing.transcription.provider,
      text: textSummary(attachment.processing.transcription.text),
      reasonHash: attachment.processing.transcription.reason
        ? stableHash(attachment.processing.transcription.reason)
        : null,
    },
  };
}

function attachmentByKind(attachments, kind) {
  const attachment = attachments.find((item) => item.mediaKind === kind);
  if (!attachment) {
    throw new Error(`Fixture does not include a ${kind} attachment.`);
  }
  return attachment;
}

function providerClientRecorder(provider, calls) {
  return async ({ attachment, data, model, apiKey }) => {
    calls.push({
      provider,
      model,
      apiKeyProvided: typeof apiKey === "string",
      mediaKind: attachment.mediaKind,
      byteLength:
        typeof data?.byteLength === "number"
          ? data.byteLength
          : Buffer.byteLength(String(data ?? "")),
    });
    return {
      status: "complete",
      text: `${provider} fixture transcript for ${attachment.safeFilename} with ${model}`,
      reason: "Fixture transcription client returned deterministic text.",
    };
  };
}

async function runNodeRuntime(config) {
  const sdk = await import(pathToFileURL(distEntryPath).href);
  const context = JSON.parse(await fs.readFile(config.fixturePath, "utf8"));
  const attachments = sdk.collectAttachmentsFromContext(context);
  const pdf = attachmentByKind(attachments, "pdf");
  const image = attachmentByKind(attachments, "image");
  const audio = attachmentByKind(attachments, "audio");
  const calls = [];

  const parsedPdf = await sdk.parseAttachmentContent(pdf, Buffer.from("fixture pdf bytes"), {
    parsers: {
      pdf: async ({ data }) => ({
        status: "partial",
        parser: "fixture-pdf-parser",
        text: `PDF fixture bytes ${Buffer.byteLength(data)}`,
        reason: "Fixture PDF parser only emits synthetic first-page text.",
      }),
    },
  });
  const parsedImage = await sdk.parseAttachmentContent(image, {
    width: 640,
    height: 480,
  }, {
    parsers: {
      image: async ({ data }) => ({
        status: "complete",
        parser: "fixture-image-metadata-parser",
        text: `Image fixture metadata ${data.width}x${data.height}`,
        reason: "Fixture image parser extracted metadata only.",
      }),
    },
  });
  const disabledAudio = await sdk.transcribeAudio(audio, Buffer.from("audio"));
  const blockedAudio = await sdk.transcribeAudio(audio, Buffer.from("audio"), {
    enabled: true,
  });
  const openaiProvider = sdk.createOpenAITranscriptionProvider({
    apiKey: "fixture-openai-key",
    model: "fixture-openai-model",
    client: providerClientRecorder("openai", calls),
  });
  const geminiProvider = sdk.createGeminiTranscriptionProvider({
    apiKey: "fixture-gemini-key",
    model: "fixture-gemini-model",
    client: providerClientRecorder("gemini", calls),
  });
  const openaiAudio = await sdk.transcribeAudio(audio, Buffer.from("audio"), {
    enabled: true,
    provider: openaiProvider,
  });
  const geminiAudio = await sdk.transcribeAudio(audio, Buffer.from("audio"), {
    enabled: true,
    provider: geminiProvider,
  });

  return {
    attachments: {
      count: attachments.length,
      pdf: summarizeAttachment(parsedPdf),
      image: summarizeAttachment(parsedImage),
      audioDisabled: summarizeAttachment(disabledAudio),
      audioBlockedNoProvider: summarizeAttachment(blockedAudio),
      audioOpenAI: summarizeAttachment(openaiAudio),
      audioGemini: summarizeAttachment(geminiAudio),
    },
    contextParts: {
      pdf: contextSummary(sdk.renderAttachmentContextParts(parsedPdf)),
      image: contextSummary(sdk.renderAttachmentContextParts(parsedImage)),
      audioOpenAI: contextSummary(sdk.renderAttachmentContextParts(openaiAudio)),
      audioGemini: contextSummary(sdk.renderAttachmentContextParts(geminiAudio)),
    },
    providerCalls: calls,
  };
}

function pythonSmokeSource() {
  return String.raw`
import json
import sys

from googlechatai import (
    collect_attachments_from_context,
    create_gemini_transcription_provider,
    create_openai_transcription_provider,
    parse_attachment_content,
    render_attachment_context_parts,
    transcribe_audio,
)


def stable_hash(value):
    import hashlib

    h = hashlib.sha256()
    h.update(b"googlechatai-attachment-provider-smoke")
    h.update(b"\0")
    h.update(str(value or "").encode())
    return h.hexdigest()


def text_summary(text):
    return {
        "available": isinstance(text, str),
        "length": len(text) if isinstance(text, str) else 0,
        "hash": stable_hash(text) if isinstance(text, str) else None,
    }


def context_summary(parts):
    content = next((part for part in parts if part.get("type") == "attachment_content"), {})
    return {
        "count": len(parts),
        "firstType": parts[0].get("type") if parts else None,
        "firstHasSystemNote": bool(parts and parts[0].get("type") == "system_note"),
        "contentStatus": content.get("status"),
        "contentText": text_summary(content.get("text")),
    }


def summarize_attachment(attachment):
    extraction = attachment["processing"]["extraction"]
    transcription = attachment["processing"]["transcription"]
    return {
        "safeFilename": attachment.get("safeFilename"),
        "mediaKind": attachment.get("mediaKind"),
        "extraction": {
            "status": extraction.get("status"),
            "parser": extraction.get("parser"),
            "text": text_summary(extraction.get("text")),
            "reasonHash": stable_hash(extraction.get("reason")) if extraction.get("reason") else None,
        },
        "transcription": {
            "status": transcription.get("status"),
            "provider": transcription.get("provider"),
            "text": text_summary(transcription.get("text")),
            "reasonHash": stable_hash(transcription.get("reason")) if transcription.get("reason") else None,
        },
    }


def attachment_by_kind(attachments, kind):
    for attachment in attachments:
        if attachment.get("mediaKind") == kind:
            return attachment
    raise RuntimeError(f"Fixture does not include a {kind} attachment.")


def provider_client(provider, calls):
    def client(*, attachment, data, model, apiKey):
        calls.append(
            {
                "provider": provider,
                "model": model,
                "apiKeyProvided": isinstance(apiKey, str),
                "mediaKind": attachment.get("mediaKind"),
                "byteLength": len(data) if hasattr(data, "__len__") else len(str(data)),
            }
        )
        return {
            "status": "complete",
            "text": f"{provider} fixture transcript for {attachment.get('safeFilename')} with {model}",
            "reason": "Fixture transcription client returned deterministic text.",
        }

    return client


with open(sys.argv[1], "r", encoding="utf8") as handle:
    context = json.load(handle)

attachments = collect_attachments_from_context(context)
pdf = attachment_by_kind(attachments, "pdf")
image = attachment_by_kind(attachments, "image")
audio = attachment_by_kind(attachments, "audio")
calls = []

parsed_pdf = parse_attachment_content(
    pdf,
    b"fixture pdf bytes",
    parsers={
        "pdf": lambda attachment, data: {
            "status": "partial",
            "parser": "fixture-pdf-parser",
            "text": f"PDF fixture bytes {len(data)}",
            "reason": "Fixture PDF parser only emits synthetic first-page text.",
        }
    },
)
parsed_image = parse_attachment_content(
    image,
    {"width": 640, "height": 480},
    parsers={
        "image": lambda attachment, data: {
            "status": "complete",
            "parser": "fixture-image-metadata-parser",
            "text": f"Image fixture metadata {data['width']}x{data['height']}",
            "reason": "Fixture image parser extracted metadata only.",
        }
    },
)
disabled_audio = transcribe_audio(audio, b"audio")
blocked_audio = transcribe_audio(audio, b"audio", enabled=True)
openai_provider = create_openai_transcription_provider(
    apiKey="fixture-openai-key",
    model="fixture-openai-model",
    client=provider_client("openai", calls),
)
gemini_provider = create_gemini_transcription_provider(
    apiKey="fixture-gemini-key",
    model="fixture-gemini-model",
    client=provider_client("gemini", calls),
)
openai_audio = transcribe_audio(
    audio,
    b"audio",
    enabled=True,
    provider=openai_provider,
)
gemini_audio = transcribe_audio(
    audio,
    b"audio",
    enabled=True,
    provider=gemini_provider,
)

print(
    json.dumps(
        {
            "attachments": {
                "count": len(attachments),
                "pdf": summarize_attachment(parsed_pdf),
                "image": summarize_attachment(parsed_image),
                "audioDisabled": summarize_attachment(disabled_audio),
                "audioBlockedNoProvider": summarize_attachment(blocked_audio),
                "audioOpenAI": summarize_attachment(openai_audio),
                "audioGemini": summarize_attachment(gemini_audio),
            },
            "contextParts": {
                "pdf": context_summary(render_attachment_context_parts(parsed_pdf)),
                "image": context_summary(render_attachment_context_parts(parsed_image)),
                "audioOpenAI": context_summary(render_attachment_context_parts(openai_audio)),
                "audioGemini": context_summary(render_attachment_context_parts(gemini_audio)),
            },
            "providerCalls": calls,
        },
        sort_keys=True,
    )
)
`;
}

function runPythonRuntime(config) {
  const result = spawnSync("python3", ["-c", pythonSmokeSource(), config.fixturePath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: path.join(repoRoot, "packages/python/src"),
    },
  });

  if (result.status !== 0) {
    throw new Error(
      `Python attachment provider smoke failed: ${result.stderr || result.stdout}`,
    );
  }

  return JSON.parse(result.stdout);
}

function runtimeAssertions(result) {
  return {
    pdfParserPartial:
      result.attachments.pdf.extraction.status === "partial" &&
      result.attachments.pdf.extraction.parser === "fixture-pdf-parser",
    imageParserComplete:
      result.attachments.image.extraction.status === "complete" &&
      result.attachments.image.extraction.parser === "fixture-image-metadata-parser",
    transcriptionDisabledByDefault:
      result.attachments.audioDisabled.transcription.status === "disabled",
    noProviderBlocked:
      result.attachments.audioBlockedNoProvider.transcription.status === "blocked",
    openaiComplete:
      result.attachments.audioOpenAI.transcription.status === "complete" &&
      result.attachments.audioOpenAI.transcription.provider === "openai",
    geminiComplete:
      result.attachments.audioGemini.transcription.status === "complete" &&
      result.attachments.audioGemini.transcription.provider === "gemini",
    contextSystemNotesFirst:
      result.contextParts.pdf.firstHasSystemNote &&
      result.contextParts.image.firstHasSystemNote &&
      result.contextParts.audioOpenAI.firstHasSystemNote &&
      result.contextParts.audioGemini.firstHasSystemNote,
    providerClientsCalledWithExplicitKeys:
      result.providerCalls.length === 2 &&
      result.providerCalls.every((call) => call.apiKeyProvided === true),
  };
}

function parityAssertions(node, python) {
  if (!python) {
    return { pythonSkipped: true };
  }

  return {
    attachmentCountMatches: node.attachments.count === python.attachments.count,
    pdfStatusMatches:
      node.attachments.pdf.extraction.status ===
      python.attachments.pdf.extraction.status,
    imageStatusMatches:
      node.attachments.image.extraction.status ===
      python.attachments.image.extraction.status,
    openaiStatusMatches:
      node.attachments.audioOpenAI.transcription.status ===
      python.attachments.audioOpenAI.transcription.status,
    geminiStatusMatches:
      node.attachments.audioGemini.transcription.status ===
      python.attachments.audioGemini.transcription.status,
    providerCallModelsMatch:
      JSON.stringify(node.providerCalls.map((call) => call.model)) ===
      JSON.stringify(python.providerCalls.map((call) => call.model)),
  };
}

function failedAssertions(assertions) {
  const failures = [];
  for (const [group, values] of Object.entries(assertions)) {
    for (const [key, value] of Object.entries(values)) {
      if (value === false) {
        failures.push(`${group}.${key}`);
      }
    }
  }
  return failures;
}

async function writeEvidenceFile(config, evidence) {
  const evidencePath =
    config.evidencePath ??
    path.join(defaultEvidenceDir, `chat-attachment-provider-smoke-${config.runId}.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

export async function runAttachmentProviderSmoke(
  config,
  { writeEvidence = true } = {},
) {
  if (config.help) {
    return { ok: true, evidence: { help: true } };
  }

  const startedAt = new Date().toISOString();
  const node = await runNodeRuntime(config);
  const python = config.skipPython ? null : runPythonRuntime(config);
  const assertions = {
    node: runtimeAssertions(node),
    python: python ? runtimeAssertions(python) : { pythonSkipped: true },
    parity: parityAssertions(node, python),
  };
  const failures = failedAssertions(assertions);
  const evidence = {
    ok: failures.length === 0,
    mode: "fixture",
    runId: config.runId,
    fixturePath: path.relative(repoRoot, config.fixturePath),
    startedAt,
    finishedAt: new Date().toISOString(),
    runtimes: {
      node,
      python,
    },
    assertions,
    failures,
    privacy: {
      rawMediaBytesSaved: false,
      rawApiKeysSaved: false,
      externalProviderCallsMade: false,
      rawTranscriptionTextSaved: false,
      rawExtractedTextSaved: false,
    },
  };

  if (writeEvidence) {
    evidence.evidencePath = await writeEvidenceFile(config, evidence);
  }

  if (failures.length > 0) {
    const error = new Error(
      `Attachment provider smoke assertions failed: ${failures.join(", ")}`,
    );
    error.evidence = evidence;
    throw error;
  }

  return { ok: true, evidence };
}

function usage() {
  return `${[
    "Usage: pnpm chat:attachment-provider-smoke",
    "",
    "Runs fixture-only Node and Python attachment parser/transcription provider checks.",
    "No external provider calls are made; OpenAI and Gemini clients are fake deterministic clients.",
    "",
    "Options:",
    "  --fixture <path>      Attachment context fixture. Default: fixtures/attachments/context-tree.json.",
    "  --evidence <path>     Evidence JSON output path.",
    "  --run-id <id>         Stable run id for evidence.",
    "  --skip-python         Run only the Node runtime.",
  ].join("\n")}\n`;
}

async function main() {
  try {
    const config = loadAttachmentProviderSmokeConfig();

    if (config.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await runAttachmentProviderSmoke(config);
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
