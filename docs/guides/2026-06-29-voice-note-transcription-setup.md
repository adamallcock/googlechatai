---
title: Voice Note Transcription Setup
date: 2026-06-29
type: guide
status: draft
---

# Voice Note Transcription Setup

Voice-note and audio transcription is optional, auth-explicit, and disabled by
default. This guide defines the developer experience W8 should preserve as
helper coverage grows into real provider integrations.

## Status

- Implemented: Node and Python attachment helpers expose disabled-by-default
  audio transcription state, optional OpenAI/Gemini provider factories, and
  auth/client checks that block provider use without explicit configuration.
- Implemented: OpenAI batch transcription can call
  `https://api.openai.com/v1/audio/transcriptions` with
  `gpt-4o-transcribe` when an application explicitly supplies
  `OPENAI_API_KEY` or an injected client.
- Implemented: Gemini audio transcription can call the Gemini Interactions API
  at `https://generativelanguage.googleapis.com/v1beta/interactions` with
  `gemini-3.5-flash` when an application explicitly supplies `GEMINI_API_KEY`,
  `GOOGLE_GENERATIVE_AI_API_KEY`, or an injected client.
- Implemented: attachment AI context notes say whether transcription was
  disabled, skipped, complete, partial, failed, blocked, or inaccessible.
- Implemented: redacted transcription evidence summaries include provider,
  model, status, audio hash/size, transcript length/hash, and no transcript text
  by default.
- Implemented: guarded live smoke harness
  `corepack pnpm live:chat-transcription-smoke` for OpenAI and Gemini.
- Planned: production provider package split if the base package grows too
  large.
- Required: no transcription should run unless the application explicitly
  enables it and configures provider auth.

## Source Links

- OpenAI speech-to-text guide:
  https://developers.openai.com/api/docs/guides/speech-to-text
- Gemini audio understanding guide:
  https://ai.google.dev/gemini-api/docs/audio
- Gemini Files API guide:
  https://ai.google.dev/gemini-api/docs/files

## Provider Choices

OpenAI provider:

- Use when an application already has OpenAI API credentials and wants a
  speech-to-text provider separate from Google Cloud auth.
- Requires explicit OpenAI auth such as `OPENAI_API_KEY`.
- Chat service-account credentials are not OpenAI credentials.
- Default model is `gpt-4o-transcribe` for batch/file transcription. Realtime
  Whisper-style models are not used for this non-realtime helper.
- The provider adapter exposes model selection, maximum byte limits, and
  injected HTTP clients for tests or custom deployments.

Gemini provider:

- Use when an application wants Google AI/Gemini audio understanding or prefers
  Google-managed auth paths.
- Requires explicit Gemini auth such as `GEMINI_API_KEY` or a documented
  `GOOGLE_GENERATIVE_AI_API_KEY`.
- Default model is `gemini-3.5-flash`.
- Chat service-account credentials are not used for this adapter.
- The base adapter uses inline audio for small audio bytes and enforces the SDK
  max-byte guard before provider calls. Larger-file Files API flows remain a
  future adapter concern.

## Disabled-By-Default Configuration

The safest default is no transcription:

```ts
const chat = new GoogleChatAI({
  transcription: {
    enabled: false,
  },
});
```

Planned explicit enablement:

```ts
const chat = new GoogleChatAI({
  transcription: {
    enabled: true,
    provider: "openai",
    model: "chosen-at-implementation-time",
  },
});
```

Python should preserve the same semantics:

```python
chat = GoogleChatAI(
    transcription={
        "enabled": True,
        "provider": "gemini",
        "model": "chosen-at-implementation-time",
    }
)
```

These snippets are planned application-level API shape, not the current helper
API. The shipped helper surface is the explicit provider/transcription callback
shape used by the Node and Python attachment modules.

Current Gemini Node helper:

```ts
const provider = createGeminiTranscriptionProvider({
  apiKey: process.env.GEMINI_API_KEY,
  model: "gemini-3.5-flash",
  maxBytes: 25 * 1024 * 1024,
});

const transcribed = await transcribeAudio(audioAttachment, audioBytes, {
  enabled: true,
  provider,
});
```

Current Gemini Python helper:

```python
provider = create_gemini_transcription_provider(
    api_key=os.environ["GEMINI_API_KEY"],
    model="gemini-3.5-flash",
    max_bytes=25 * 1024 * 1024,
)

transcribed = transcribe_audio(
    audio_attachment,
    audio_bytes,
    enabled=True,
    provider=provider,
)
```

Python helpers also accept the legacy shared-shape `apiKey` and `maxBytes`
keywords for compatibility. Prefer `api_key` and `max_bytes` in Python code;
passing both spellings with different values raises an error. Provider metadata
does not echo raw API keys.

## Optional Dependency Strategy

The core SDK should not require OpenAI or Gemini transcription dependencies just
to parse events or send Chat messages. Provider implementations should use one
of these strategies:

- Separate optional packages, such as a future
  `@googlechatai/transcription-openai` or
  `googlechatai[transcription-openai]`.
- Peer/optional dependencies with clear install errors.
- A provider callback interface that lets applications bring their own
  transcription client.

Before adding any provider dependency or making real provider calls, the
implementing workstream must check the package registry and official docs at
implementation time, choose a latest modern supported package version unless
compatibility requires otherwise, and record the freshness check in the handoff.
The base SDK still adds no OpenAI or Gemini runtime dependency.

## Live Smoke

The provider smoke is explicitly gated and currently not run unless
`.env.local` contains the selected provider key and the operator supplies a test
audio file or explicitly approves sample download.

OpenAI:

```bash
RUN_LIVE_TRANSCRIPTION_SMOKE=1 \
corepack pnpm live:chat-transcription-smoke -- \
  --provider openai \
  --audio-file /absolute/path/to/sample.wav
```

Gemini:

```bash
RUN_LIVE_TRANSCRIPTION_SMOKE=1 \
corepack pnpm live:chat-transcription-smoke -- \
  --provider gemini \
  --audio-file /absolute/path/to/sample.wav
```

For an internet-hosted test sample, add both a URL and a separate download gate:

```bash
RUN_LIVE_TRANSCRIPTION_SMOKE=1 \
RUN_LIVE_TRANSCRIPTION_SAMPLE_DOWNLOAD=1 \
corepack pnpm live:chat-transcription-smoke -- \
  --sample-url https://example.com/transcription-test.wav
```

The evidence file records hashes, sizes, provider/model/status, and transcript
length/hash. It does not save raw audio or transcript text by default. Add
`--include-transcript-text` only for a local private debugging run where storing
the transcript in ignored evidence is explicitly acceptable.

## AI Context Output Requirements

Audio attachments must always produce an AI-facing metadata note before any
transcript:

```text
System Note: Ada Lovelace attached voice-note-123.m4a (audio/mp4, 842 KB) at 2026-06-29T14:05:00Z. Transcription status: disabled because transcription is not enabled.
```

If transcription is enabled and succeeds:

```text
System Note: Ada Lovelace attached voice-note-123.m4a (audio/mp4, 842 KB) at 2026-06-29T14:05:00Z. Transcription status: complete via provider openai, model configured by the application.
```

If transcription cannot run:

```text
System Note: Audio transcription was skipped because no provider credentials were configured. The attachment metadata is included, but no transcript is available.
```

Partial or failed transcriptions must be explicit. Do not pass a partial
transcript to an AI as if it were complete.

## Auth And Privacy Rules

- Do not send audio to OpenAI, Gemini, or any third-party provider unless the
  application has explicitly enabled that provider.
- Do not reuse Chat service-account credentials for provider calls unless that
  auth mode is intentionally supported and tested.
- Do not log raw audio, transcripts, API keys, or provider request bodies.
- Include provider, model, status, and failure reason in local structured
  metadata, but do not expose secrets.
- Enforce max byte limits before provider calls. If an application wants
  chunking, it should use an audio-aware package outside the base SDK so chunks
  are cut at valid audio boundaries and can be cached independently.
- Preserve raw attachment refs so the application can reprocess with different
  auth later.
