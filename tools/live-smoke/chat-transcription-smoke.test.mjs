import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTranscriptionSmokeComplete,
  buildTranscriptionSmokePlan,
} from "./chat-transcription-smoke.mjs";

test("transcription smoke blocks live provider calls without env gate, key, and audio source", () => {
  const plan = buildTranscriptionSmokePlan({
    args: {
      dryRun: false,
      audioFile: null,
      sampleUrl: null,
      maxBytes: 5_000_000,
      includeTranscriptText: false,
    },
    env: {},
  });

  assert.equal(plan.canExecuteLive, false);
  assert.deepEqual(plan.blockedReasons, [
    "live_env_gate_missing",
    "openai_api_key_missing",
    "audio_source_missing",
  ]);
  assert.equal(plan.evidence.storesRawAudio, false);
  assert.equal(plan.evidence.storesRawTranscriptByDefault, false);
});

test("transcription smoke requires explicit approval before downloading sample audio", () => {
  const plan = buildTranscriptionSmokePlan({
    args: {
      dryRun: false,
      audioFile: null,
      sampleUrl: "https://example.com/sample.wav",
      maxBytes: 5_000_000,
      includeTranscriptText: false,
    },
    env: {
      RUN_LIVE_TRANSCRIPTION_SMOKE: "1",
      OPENAI_API_KEY: "redacted",
    },
  });

  assert.equal(plan.canExecuteLive, false);
  assert.deepEqual(plan.blockedReasons, ["sample_download_gate_missing"]);
});

test("transcription smoke dry-run reports the OpenAI batch model and redacted evidence posture", () => {
  const plan = buildTranscriptionSmokePlan({
    args: {
      dryRun: true,
      provider: "openai",
      audioFile: "sample.wav",
      sampleUrl: null,
      maxBytes: 5_000_000,
      includeTranscriptText: false,
    },
    env: {},
  });

  assert.equal(plan.model, "gpt-4o-transcribe");
  assert.equal(plan.endpoint, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(plan.canExecuteLive, true);
  assert.equal(plan.evidence.includeTranscriptText, false);
});

test("transcription smoke can target Gemini interactions with redacted evidence posture", () => {
  const plan = buildTranscriptionSmokePlan({
    args: {
      dryRun: false,
      provider: "gemini",
      audioFile: "sample.wav",
      sampleUrl: null,
      maxBytes: 5_000_000,
      includeTranscriptText: false,
    },
    env: {
      RUN_LIVE_TRANSCRIPTION_SMOKE: "1",
      GEMINI_API_KEY: "redacted",
    },
  });

  assert.equal(plan.kind, "gemini_transcription_smoke");
  assert.equal(plan.model, "gemini-3.5-flash");
  assert.equal(plan.endpoint, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(plan.canExecuteLive, true);
  assert.equal(plan.evidence.storesRawAudio, false);
  assert.equal(plan.evidence.storesRawTranscriptByDefault, false);
});

test("transcription smoke reports Gemini key requirements separately from OpenAI", () => {
  const plan = buildTranscriptionSmokePlan({
    args: {
      dryRun: false,
      provider: "gemini",
      audioFile: "sample.wav",
      sampleUrl: null,
      maxBytes: 5_000_000,
      includeTranscriptText: false,
    },
    env: {
      RUN_LIVE_TRANSCRIPTION_SMOKE: "1",
    },
  });

  assert.equal(plan.canExecuteLive, false);
  assert.deepEqual(plan.blockedReasons, ["gemini_api_key_missing"]);
});

test("transcription smoke fails live assertions when the provider does not complete", () => {
  assert.throws(
    () =>
      assertTranscriptionSmokeComplete({
        processing: {
          transcription: {
            status: "failed",
            reason: "Gemini transcription response did not include output_text.",
          },
        },
      }),
    /Transcription provider returned failed: Gemini transcription response did not include output_text\./,
  );
});
