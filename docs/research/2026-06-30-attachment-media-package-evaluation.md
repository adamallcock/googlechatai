---
title: Attachment Media Package Evaluation
date: 2026-06-30
type: research
status: draft
---

# Attachment Media Package Evaluation

## Decision

W8 does not add runtime media or transcription dependencies to the base Node or Python packages.

The implemented surface normalizes metadata, builds dry-run download/upload plans, exposes parser hooks, and provides optional OpenAI/Gemini transcription provider adapters that require explicit auth or an injected client. This keeps private Chat media local by default and avoids pulling large parser/transcription stacks into the base install before W7 live media gates are complete.

## Google Chat Media Baseline

Live discovery check on 2026-06-30:

- Discovery revision: `20260623`.
- `media.download`: `GET v1/media/{+resourceName}`, used as `https://chat.googleapis.com/v1/media/{resourceName}?alt=media`.
- `media.upload`: `POST v1/{+parent}/attachments:upload`.
- Simple upload path: `/upload/v1/{+parent}/attachments:upload`.
- Upload max size: `209715200` bytes.
- Upload scopes: `chat.messages.create`, `chat.messages`, or `chat.import`.
- Download scopes: `chat.bot`, `chat.messages`, or `chat.messages.readonly`.

## Node Packages Checked

Checked with `npm view` on 2026-06-30.

| Package | Version | Modified | Decision |
|---|---:|---:|---|
| `openai` | `6.45.0` | 2026-06-29 | Rejected for base install; use optional injected client/provider because transcription must be disabled by default. |
| `@google/genai` | `2.10.0` | 2026-06-24 | Rejected for base install; same optional-provider reason as OpenAI. |
| `file-type` | `22.0.1` | 2026-04-09 | Deferred; useful once W7 downloads bytes, but W8 only plans and normalizes metadata. |
| `pdf-parse` | `2.4.5` | 2025-10-29 | Deferred; PDF text extraction should be an optional parser hook. |
| `music-metadata` | `11.13.0` | 2026-06-07 | Deferred; useful for audio metadata after live downloads are enabled. |
| `mammoth` | `1.12.0` | 2026-03-12 | Deferred; document conversion belongs in optional parser packages. |
| `sharp` | `0.35.2` | 2026-06-27 | Rejected for W8; too heavy for metadata/planning and not needed without bytes. |

## Python Packages Checked

Checked with PyPI JSON or `pip index versions` on 2026-06-30.

| Package | Version | Upload time | Decision |
|---|---:|---:|---|
| `openai` | `2.44.0` | 2026-06-24 | Rejected for base install; use optional injected client/provider. |
| `google-genai` | `2.10.0` | 2026-06-24 | Rejected for base install; use optional injected client/provider. |
| `pypdf` | `6.14.2` | 2026-06-23 | Deferred; fit for optional PDF parser hook after downloads land. |
| `filetype` | `1.2.0` | 2022-11-02 | Rejected for now; stale and not needed until byte inspection exists. |
| `mutagen` | `1.48.1` | 2026-06-25 | Deferred; fit for optional audio metadata parser after downloads land. |

## Follow-Up

- W7 should add live download/upload execution behind `GOOGLE_CHAT_AI_W7_MEDIA_READY=1` and `GOOGLE_CHAT_AI_ENABLE_LIVE_MEDIA=1`.
- Parser packages should remain optional extras/subpackages so base event parsing does not install heavy media stacks.
- Once bytes are available, add signature-based MIME checks before invoking text/PDF/image/audio parsers.

## 2026-07-02 Parser Package Recheck

Live registry recheck for the optional parser smoke found:

- Node: `pdf-parse` `2.4.5`, `sharp` `0.35.3`, `music-metadata` `11.13.0`.
- Python: `pypdf` `6.14.2`, `Pillow` `12.3.0`, `mutagen` `1.48.1`.

The base packages still do not depend on these parser packages. The guarded
`pnpm chat:real-parser-package-smoke` harness imports them only when they are
already installed and records redacted parser evidence for generated PDF, PNG,
and WAV fixtures.

Follow-up package-backed smoke `real-parser-package-isolated-20260702T1914Z`
installed those exact versions in ignored optional environments under
`artifacts/live/parser-smoke/` and verified Node and Python PDF text extraction,
PNG metadata extraction, and WAV metadata extraction. The harness now accepts an
explicit `--node-module-dir` and `--python-executable` so future parser checks do
not accidentally resolve packages from ambient parent directories. The evidence
records exact versions, parser statuses, text hashes/lengths, media metadata,
and redacted environment hashes only.
