---
title: Google Chat Chatbot Package Research
date: 2026-06-29
type: research
status: draft
---

# Google Chat Chatbot Package Research

## Executive Summary

As of June 29, 2026, the best current package for making Google Chat chatbot development easier is still **Vercel's Chat SDK plus `@chat-adapter/gchat`**. It is the only active package found that behaves like a real bot framework rather than a raw Google API client or webhook helper. It covers event handlers, thread/channel abstractions, state-backed subscriptions, message deduplication, cross-platform cards, Google Chat Card v2 conversion, service-account auth, and optional Workspace Events/Pub/Sub for receiving all space messages.

The best official low-level foundation remains **Google's Cloud Client Libraries**, especially `@google-apps/chat` for Node.js and `google-apps-chat` for Python. Google explicitly recommends Cloud Client Libraries for Chat API calls because they support gRPC and REST, while Google API Client Libraries are REST-only. These libraries reduce API-call boilerplate but do not provide chatbot ergonomics such as routing, user/context normalization, replying in the right thread, card builders, or subscription state.

For Python, the strongest chatbot-specific package found is **`gchatbot`**, a small FastAPI-oriented library focused on event parsing, sync/async handler dispatch, slash commands, and progressive responses. It is promising for a Python-only prototype, but it has weaker adoption, a broken GitHub source URL from PyPI during this research, and much narrower coverage than Chat SDK.

The old Google Workspace **`@google/chat-sdk`** package should not be used for a new project. Its repository is archived, it was experimental and explicitly "not an official Google product," and npm activity is tiny. It is useful only as historical design reference.

The second GitHub-project pass changes the build recommendation, not the package ranking. There are many Google Chat bots and MCP servers, but very few reusable SDKs. The most advanced handling of the hard problems - attachments, audio, rich cards, thread recovery, user lookup, and response streaming through message edits - lives inside product repos such as OpenClaw, Hermes, Google Workspace MCP servers, poll apps, migration tools, and voice-transcription tools. That is evidence for a real package gap: a focused Google Chat toolkit that extracts these hard primitives into a reusable library.

## Problem Shape

Google Chat app development has several independent hard parts:

- Incoming interaction event parsing: message payloads, annotations, slash commands, bot mentions, card actions, add/remove events, and direct messages.
- Outbound messaging: synchronous interaction responses versus authenticated asynchronous `spaces.messages.create`, update, delete, and cards replacement.
- Threading: space names, thread names, `threadKey`, direct-message spaces, and "reply in the right thread" defaults.
- Identity and membership: user resource names, display names, bot users, spaces, members, and auth scope differences between user auth and app auth.
- Rich UI: Card v1/v2, dialogs, buttons, form inputs, selections, images, media, links, and fallback text.
- Passive listening: direct Chat webhooks usually cover interactions such as mentions, while all-message monitoring needs Chat events through the Google Workspace Events API and Pub/Sub.
- Attachments/media: attachment resource references, media download, upload, and auth differences.
- Streaming-style responses: create a placeholder or typing/progress message, patch text/cards as tokens or tool progress arrive, throttle edits to avoid quota issues, and finalize cleanly.

Google's `spaces.messages` REST reference shows the breadth of `Message`: text, formatted text, Card v1, Card v2, annotations, thread, space, action responses, slash commands, attachments, matched URLs, thread replies, private message viewer, quoted/forwarded metadata, GIFs, and accessory widgets. Google's Cards v2 docs describe rich layouts with interactive UI elements, buttons, and images. Google's auth docs also separate synchronous interaction responses from authenticated async Chat API calls.

Key official references:

- Google Chat `Message` resource: https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages
- Google Chat Cards v2: https://developers.google.com/workspace/chat/api/reference/rest/v1/cards
- Google Chat auth overview: https://developers.google.com/workspace/chat/authenticate-authorize
- Google Chat event overview: https://developers.google.com/workspace/chat/events-overview
- Google Workspace Events for Chat: https://developers.google.com/workspace/events/guides/events-chat
- Google Chat API client libraries: https://developers.google.com/workspace/chat/libraries
- Google Chat upload media attachments: https://developers.google.com/workspace/chat/upload-media-attachments
- Google Chat update messages: https://developers.google.com/workspace/chat/update-messages

## Current Package Ranking

| Rank | Package | Ecosystem | Best Use | Decision |
|---:|---|---|---|---|
| 1 | `chat` + `@chat-adapter/gchat` | TypeScript / Node.js | Full chatbot framework, especially if building AI/chat-agent workflows | Use as primary reference and likely foundation |
| 2 | `@google-apps/chat` | Node.js | Official raw Chat API calls with generated types | Use under the hood or for gaps |
| 3 | `google-apps-chat` | Python | Official raw Chat API calls | Use for Python API access |
| 4 | `gchatbot` | Python / FastAPI | Python bot prototype with event parsing and progressive responses | Consider for prototype only; verify source/maintainership first |
| 5 | `python-card-framework` | Python | Object model for card/dialog JSON | Use only for Python card rendering |
| 6 | `gchatcardbuilder` | Python | Lightweight CardsV2 builder | Use only for card JSON if needed |
| 7 | `@guardian/google-chat-utils` | TypeScript | Posting to group webhooks | Avoid for chatbot product; webhook helper only |
| 8 | `googlechatbot` | Python | Sending text/cards to incoming webhook URL | Avoid for chatbot product; too thin |
| 9 | `@google/chat-sdk` | Node.js | Historical Google Workspace experimental framework | Avoid for new work; archived |
| 10 | Botkit Google Hangouts starter/adapters | Node.js | Legacy Hangouts Chat bots | Avoid; deprecated/archived |

## Detailed Findings

### 1. `chat` + `@chat-adapter/gchat`

Links:

- Core package source: https://github.com/vercel/chat/tree/main/packages/chat
- Google Chat adapter source: https://github.com/vercel/chat/tree/main/packages/adapter-gchat
- Adapter docs: https://chat-sdk.dev/adapters/official/gchat
- Package docs: https://chat-sdk.dev/docs
- npm package pages: https://www.npmjs.com/package/chat and https://www.npmjs.com/package/@chat-adapter/gchat

Current evidence:

- `chat` latest npm version checked locally: `4.31.0`, published June 16, 2026.
- `@chat-adapter/gchat` latest npm version checked locally: `4.31.0`, published June 16, 2026.
- GitHub API check: `vercel/chat` was active, unarchived, 2,142 stars, 243 forks, last pushed June 28, 2026.
- npm downloads API check for May 30-June 28, 2026: `chat` had about 5.1M downloads; `@chat-adapter/gchat` had about 134k downloads.

Coverage observed:

- `Chat` class, event handlers, `thread.post`, subscribed messages, state adapters, locks, dedupe, and fallback streaming.
- Google Chat adapter with service-account credentials, ADC, custom auth, direct webhook JWT verification, Pub/Sub push JWT verification, and an explicit fail-closed path unless verification is configured or intentionally disabled.
- Workspace Events/Pub/Sub support for receiving all messages, not only mentions.
- Thread ID encoding for space/thread/direct-message context.
- User info cache for display-name recovery where Pub/Sub events omit display names.
- Card abstraction in the core package and Card v2 conversion in the Google Chat adapter.
- Tests for cards, thread utilities, user info, Workspace Events, and adapter behavior.

Strengths:

- Best match to the actual pain: event routing, thread abstraction, reply ergonomics, rich cards, state, dedupe, and passive event subscription.
- Modern TypeScript, current publishing, visible tests, active repo.
- Good foundation if this project becomes "Google Chat but humane for developers," because it already sketches many of the right abstractions.

Risks and gaps:

- It is a broad multi-platform bot SDK, not Google Chat-specific. A product focused deeply on Google Chat might need sharper Chat-native helpers around app configuration, per-user OAuth, membership lookup, attachment fetching, auth-boundary explanations, and deployment recipes.
- Requires Node >=20.
- It currently depends on `@googleapis/chat` rather than Google's newer `@google-apps/chat` Cloud Client Library. That may be fine, but a new wrapper should evaluate whether `@google-apps/chat` gives better typed surfaces for 2026+ Chat API features.
- The Google Chat adapter docs recommend JSON service-account keys, while production setups should prefer ADC or workload identity where possible.

Decision:

Use as the primary competitive benchmark and likely as an off-the-shelf base if building in TypeScript. If the project goal is a new Google Chat-focused developer package, do not rebuild its generic bot framework without a clear wedge; instead, wrap/extend it with Google Chat-specific setup, identity, thread, attachment, and admin-consent ergonomics.

### 2. Official Google Chat Cloud Client Libraries

Links:

- Official library guide: https://developers.google.com/workspace/chat/libraries
- Node reference: https://docs.cloud.google.com/nodejs/docs/reference/chat/latest
- Python reference: https://googleapis.dev/python/google-apps-chat/latest/
- Node package: https://www.npmjs.com/package/@google-apps/chat
- Python package: https://pypi.org/project/google-apps-chat/

Current evidence:

- Google docs say Cloud Client Libraries are the latest and recommended libraries for Chat API and support both gRPC and REST.
- `@google-apps/chat` latest npm version checked locally: `0.25.0`, published June 25, 2026, Node >=18.
- `google-apps-chat` latest PyPI version checked locally: `0.10.1`, uploaded June 25, 2026, Python >=3.10.
- Google Python docs describe the library as managing Chat resources such as spaces, members, and messages.

Strengths:

- Official, actively regenerated, source-of-truth types and API coverage.
- Best choice for raw API access and edge cases: spaces, members, messages, attachments, reactions, sections, read states, etc.
- Should be the low-level dependency for any serious wrapper where available.

Risks and gaps:

- These are not chatbot frameworks. They do not solve inbound event routing, thread-safe reply helpers, card authoring ergonomics, user identity normalization, or state.
- They expose Google's API shape, including auth complexity, rather than hiding it.

Decision:

Use as the official substrate, especially for API coverage and exact resource operations. A new package should compose these clients, not compete with them.

### 3. `gchatbot`

Links:

- PyPI: https://pypi.org/project/gchatbot/
- Declared source URL from PyPI: https://github.com/guilhermecf10/gchatbot

Current evidence:

- Latest PyPI release: `0.3.1`, released June 23, 2025.
- PyPI classifies it as beta, FastAPI-oriented, Python >=3.7.
- PyPI description advertises FastAPI, serverless-safe async processing, event parsing into `ExtractedEventData`, sync/async dispatch, slash commands, and progressive responses.
- Local wheel inspection confirmed package modules: `main.py`, `parser.py`, `processor.py`, `response.py`, `types.py`.
- During this research, GitHub API returned 404 for `guilhermecf10/gchatbot`, even though PyPI still links to that repository.

Strengths:

- Solves real Python-specific bot pain: event parsing, FastAPI route handling, sync/async method dispatch, slash command parsing, and progressive responses.
- Simple enough to understand or fork if source provenance is resolved.

Risks and gaps:

- Broken source link is a serious adoption concern.
- Much narrower than Chat SDK: no robust thread/channel abstraction, no subscription state, no Workspace Events lifecycle coverage observed, no strong card model beyond a response factory, no visible adoption signal.
- Python >=3.7 support may indicate older compatibility choices; current official Google Chat Python library requires >=3.10.

Decision:

Consider only for a Python prototype or as inspiration for FastAPI progressive-response mechanics. Do not build a durable project on it until source availability, tests, and maintainer posture are verified.

### 4. `python-card-framework`

Links:

- GitHub: https://github.com/google/python-card-framework
- PyPI: https://pypi.org/project/python-card-framework/

Current evidence:

- PyPI latest release: `2.4.0`, released January 19, 2026.
- GitHub API check: unarchived, last pushed January 19, 2026, 23 stars, 5 forks.
- README says it lets Python developers treat Google Chat card/dialog JSON as objects that render themselves into valid JSON instead of hand-writing large JSON blocks.

Strengths:

- Official-ish Google GitHub org package for Python card/dialog rendering.
- Good focused answer to "rich objects are painful."

Risks and gaps:

- Not a chatbot framework. It only addresses cards/dialog JSON.
- Adoption is modest.

Decision:

Use for Python card rendering if building a Python package. It is complementary to `google-apps-chat`, not a replacement.

### 5. `gchatcardbuilder`

Links:

- PyPI: https://pypi.org/project/gchatcardbuilder/
- GitHub: https://github.com/pkarl/gchatcardbuilder

Current evidence:

- Latest PyPI release: `0.1.7`, September 17, 2023.
- PyPI description says it supports CardsV2 and aims to avoid deeply nested card structures.
- GitHub API check: unarchived but very small: 1 star, 0 forks, last pushed September 17, 2023.

Strengths:

- Narrowly useful for Python CardsV2 building.
- Small and understandable.

Risks and gaps:

- Stale.
- Not a bot framework.
- Minimal docs and adoption.

Decision:

Use only as a reference for card-builder ergonomics, not as a core dependency.

### 6. `@guardian/google-chat-utils`

Links:

- GitHub: https://github.com/guardian/google-chat-utils
- npm: https://www.npmjs.com/package/@guardian/google-chat-utils

Current evidence:

- Latest npm version checked locally: `2.1.3`, modified October 28, 2025.
- GitHub README describes it as helper functions and interfaces for Google Chat bots that post to group webhooks.
- Source inspection showed helpers for buttons, key-value widgets, cards, `sendMessageToChat`, `sendCardsToChat`, and `threadKey`.

Strengths:

- Lightweight webhook/card utilities.
- Production-origin package from The Guardian.

Risks and gaps:

- Webhook-posting helper, not a Chat app framework.
- Uses older card concepts and `node-fetch` v2; no inbound event parsing, auth, user lookup, Workspace Events, or attachments.

Decision:

Avoid for a chatbot product. Useful only as a tiny reference for webhook helpers.

### 7. `googlechatbot`

Links:

- PyPI: https://pypi.org/project/googlechatbot/
- GitHub: https://github.com/javicv/googlechatbot

Current evidence:

- Latest PyPI release: `1.2.3`, May 12, 2026.
- PyPI example sends text and cards to an incoming webhook URL.
- Local wheel inspection confirmed it is essentially `requests.post` plus a simple legacy card builder.
- GitHub API check: unarchived, 1 star, 0 forks, last pushed May 12, 2026.

Strengths:

- Tiny and easy to read.
- Fine for "post this message to an incoming webhook."

Risks and gaps:

- Not a real chatbot integration package.
- No inbound parsing, no API auth model, no thread-aware app replies beyond webhook URL parameters, no attachments, no user resolution, no Workspace Events.

Decision:

Avoid as a foundation.

### 8. `@google/chat-sdk`

Links:

- GitHub: https://github.com/googleworkspace/chat-framework-nodejs
- npm: https://www.npmjs.com/package/@google/chat-sdk

Current evidence:

- GitHub repository archived on January 18, 2026 and read-only.
- README says it is experimental and not an official Google product.
- npm latest version checked locally: `0.2.5`, published July 8, 2022.
- npm downloads API check for May 30-June 28, 2026: about 91 downloads; `@google/chat-sdk-dialogflow` about 42 downloads.

Strengths:

- Historically targeted exactly the same pain: routing incoming messages, authenticating incoming events, slash commands, dialogs, link unfurling, Dialogflow add-on, HTTP/PubSub transports.

Risks and gaps:

- Archived, low adoption, old dependencies, Node >=14-era package.
- README notes Pub/Sub bots do not support all features and may have issues with interactive cards/dialogs.

Decision:

Avoid for new work. Read for historical design ideas only.

### 9. Botkit Google Hangouts/Chat adapters

Links:

- Starter: https://github.com/howdyai/botkit-starter-googlehangouts
- Botkit core: https://github.com/howdyai/botkit

Current evidence:

- Google Hangouts starter repo is deprecated and archived.
- Botkit core is archived.

Decision:

Avoid.

## Second-Pass GitHub Project Research

This pass widened the scope from "published packages" to GitHub projects that already wrestle with the harder Google Chat behaviors: input attachments, input images/audio, media download/upload, Cards V2, dialogs, card callbacks, identity lookup, thread recovery, and edit-based streaming/progress updates.

Method:

- Searched GitHub repositories for Google Chat bots, MCP servers, Cards V2, attachments, `attachmentDataRef`, `media.upload`, `messages.patch`, and voice messages.
- Cloned or fetched source for the most relevant repos and inspected implementation, not just READMEs.
- Checked GitHub metadata on June 29, 2026 for activity and archival status.
- Treated README/marketing claims as hypotheses; downgraded projects where source showed stubbed or partial attachment support.

Important caveat: GitHub has many one-off Google Chat bots. Most are not reusable packages. The strongest reusable patterns live inside apps, gateways, MCP servers, and migration tools rather than libraries.

### GitHub Capability Matrix

| Project | Type | Most Relevant Capabilities | Gaps | Decision |
|---|---|---|---|---|
| [OpenClaw](https://github.com/openclaw/openclaw) Google Chat channel | Agent product gateway | Inbound attachment download, MIME/media pipeline, `cardsV2`, attachment upload, threaded send, message update, typing/progress modes | Not a standalone SDK; product-specific abstractions | Strongest source reference for hard Google Chat primitives |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) Google Chat adapter | Agent gateway | Pub/Sub inbound, multiple event shapes, attachment SSRF guard, audio/image/video/document MIME mapping, edit-message progress, per-user OAuth upload path | Product gateway, not package; integration is opinionated | Strongest reference for safe media and streaming/edit behavior |
| [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) and [Bark-com/google-workspace-mcp](https://github.com/Bark-com/google-workspace-mcp) | Workspace MCP server | Message read/send, thread replies, People API user resolution, rich link extraction, attachment metadata/download via media API | MCP tool surface, not bot app framework; does not solve inbound Chat webhooks | Useful reference for user/message/attachment helpers |
| [siva010928/multi-chat-mcp-server](https://github.com/siva010928/multi-chat-mcp-server) | Google Chat MCP server | Search/read/send, sender info, thread reply heuristics, card update, attachment/file tools, tests | Attachment upload path looks rough; source says workaround still needed | Useful for thread/user/search ergonomics; not package foundation |
| [nguyenvanduocit/google-chat-mcp](https://github.com/nguyenvanduocit/google-chat-mcp) | Go MCP server and CLI | OAuth flow, spaces/messages/members tools, actual Go `Media.Upload`, attachment reference then message create | No inbound event parsing, cards, streaming, audio pipeline | Good small reference for upload/send in Go |
| [ArnaudKleinveld/google-chat-mcp](https://github.com/ArnaudKleinveld/google-chat-mcp) | TypeScript MCP server | Broad API tool surface: spaces, messages, members, reactions, attachments; message update with `updateMask` | Attachment upload source is a metadata-only simplification, not real multipart upload | Avoid as implementation reference for attachments |
| [dyaskur/google-chat-poll](https://github.com/dyaskur/google-chat-poll) | TypeScript Chat app | Real Cards V2/dialog app; slash commands, form inputs, card state, `UPDATE_MESSAGE`, `messages.update` with `cardsV2` | No attachment/media layer; app-specific | Best rich-card interaction reference |
| [googleworkspace/google-chat-samples](https://github.com/googleworkspace/google-chat-samples) | Official samples | Cards, dialogs, slash commands, Pub/Sub app, link previews, app home, widget update/autocomplete, user-auth replies | Samples, not package; limited media/attachment coverage | Use as conformance fixtures and blessed patterns |
| [fgasparetto/voice-transcriber-mcp](https://github.com/fgasparetto/voice-transcriber-mcp) | Audio-focused MCP server | Parses Chat URLs, fetches messages, finds `audio/*` attachments, downloads by `attachmentDataRef.resourceName`, sends to Whisper | Narrow tool; external transcription dependency; no bot framework | Strong reference for voice/audio input pipeline |
| [markusjura/google-chat-to-slack](https://github.com/markusjura/google-chat-to-slack) | Migration CLI | Parses messages, threads, attachments, reactions, annotations; downloads attachments by media resource name; user directory lookup | Migration tool, not live bot integration | Good reference for historical message/object normalization |
| [Cloudflare/GHC-Errbot](https://github.com/cloudflare/GHC-Errbot) | Errbot backend, legacy Hangouts Chat lineage | Threading, cards, attachment download helper with bearer-auth media API | Legacy design and older card model; not modern framework | Historical but useful attachment/thread reference |
| [ikujyh/openclaw-gchat-router](https://github.com/ikujyh/openclaw-gchat-router) | FastAPI edge router | JWT audience verification, Workspace Add-on payload normalization, per-space/trigger routing | Only inbound edge routing; no send/media | Useful reference for request normalization and routing |
| [hyungwookchoi/google-chat-webhook-action](https://github.com/hyungwookchoi/google-chat-webhook-action) | GitHub Action | Cards V2 notification builder for webhooks | Output-only webhook helper; no app auth, inbound, threads, attachments | Reference only for simple card output |

### Detailed Additional Findings

#### OpenClaw Google Chat Channel

OpenClaw is not a library, but its Google Chat channel has unusually complete implementation coverage for the exact hard areas.

Observed implementation patterns:

- Message send supports `text`, `thread`, `cardsV2`, and `attachments`, and uses `REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD` when replying in a thread.
- Message update patches `text` and/or `cardsV2` with an `updateMask`, which is the core primitive for edit-based streaming or progress updates.
- Outbound attachment upload uses the Chat upload endpoint, then sends a message that references the returned `attachmentDataRef.attachmentUploadToken`.
- Inbound attachment handling reads `message.attachment`, downloads from `attachment.attachmentDataRef.resourceName`, captures content type, and passes media path/type into the agent pipeline.
- Reply handling can upload media and then send the attachment back into the originating thread.
- Typing/progress behavior is explicitly modeled, including message-style typing indicators and fallback modes.

Decision: treat OpenClaw as a design reference, not a dependency. The useful thing to extract is a standalone set of Google Chat primitives: `downloadAttachment`, `uploadAttachment`, `sendMessage`, `updateMessage`, `replyInThread`, and `typing/progress` helpers.

#### Hermes Agent Google Chat Adapter

Hermes has one of the strongest source implementations for safe media and streaming behavior.

Observed implementation patterns:

- Inbound uses Cloud Pub/Sub pull; outbound uses Chat REST API.
- The adapter accepts multiple envelope shapes, including Workspace Add-on payloads, native Pub/Sub Chat events, and custom relay events.
- Attachment download prefers `attachmentDataRef.resourceName` through the Chat media endpoint. It only falls back to `downloadUri` when the host is allowlisted as Google-owned, which is a useful SSRF guard pattern.
- MIME handling maps images, audio, video, and documents into a normalized media type.
- `edit_message` patches existing messages and is used for tool progress/stream-like updates. Tests cover message patching, truncation, and rate-limit accounting.
- Native file delivery uses a two-step upload then create-message flow with `attachmentDataRef`.
- The source and docs distinguish service-account/app auth from per-user OAuth for native attachment upload. The adapter has a per-user OAuth helper and fallback behavior when user auth is missing or revoked.
- The docs call out Chat API quota pressure for long streaming responses, so edit throttling and backoff should be first-class if this becomes a package.

Decision: Hermes is probably the best reference for a safe implementation of streaming edits plus media safety. It should influence package tests and threat model.

#### Google Workspace MCP Servers

The Google Workspace MCP ecosystem is relevant because these tools expose Chat operations to AI assistants. They are not chatbot frameworks, but they cover read/search/send ergonomics that a bot toolkit also needs.

Useful patterns from `taylorwilsdon/google_workspace_mcp` and its related fork:

- Resolve Chat sender IDs such as `users/<id>` into People API resources such as `people/<id>`, with cache/fallback behavior.
- Extract rich links from message annotations because they are not always present in plain text.
- Return attachment metadata and direct callers toward attachment download helpers.
- Download attachments through `https://chat.googleapis.com/v1/media/{attachmentDataRef.resourceName}?alt=media`, not browser `downloadUri`.
- Send thread replies using `thread_name` or `thread_key` and `REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`.

Useful patterns from `siva010928/multi-chat-mcp-server`:

- Thread replies accept full thread resource names, `threads/<id>`, and simple IDs.
- When a simple ID is supplied, it tries to recover the original message/thread name by fetching or scanning recent messages.
- Message update supports text and `cardsV2` through `messages.patch`.
- Sender enrichment uses People API and has tests around user-info helpers.

Risks:

- MCP servers are user-operated tooling, not inbound Chat app frameworks.
- Some attachment upload implementations are incomplete or fragile. For example, the TypeScript MCP's upload tool comments that the full multipart upload still needs implementation, and `multi-chat-mcp-server` includes a file-content workaround saying actual attachment upload needs more work.

Decision: use these as evidence of developer demand and helper design, not as a direct dependency.

#### Rich Cards, Dialogs, And Callback State

The best card-specific references are Google's official samples and `dyaskur/google-chat-poll`.

Useful patterns:

- `google-chat-poll` handles slash commands, Cards V2, dialogs, form inputs, card callbacks, and `UPDATE_MESSAGE` responses.
- It stores poll state inside card data, updates Cards V2 through `messages.update`/`updateMask: cardsV2`, and has tests around card rendering and action handling.
- Google's official samples cover contact forms, link previews, selection inputs, Pub/Sub message handling, app home, user-auth replies, and widget update/autocomplete.
- The official Pub/Sub sample uses `@google-apps/chat` and replies in the same thread using `MessageReplyOption.REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`.
- The official user-auth sample shows a "request configuration" flow when a user has not authorized the app, then posts using user credentials and replies in the originating thread.

Decision: a new package should treat Cards V2 as an interaction protocol, not just a JSON builder. It should include callback routing, form parsing, card state handling, dialog responses, private-message responses, and update-message helpers.

#### Attachments, Images, Audio, And Voice

The clearest repeated pattern across independent projects is this:

- Prefer `attachmentDataRef.resourceName` for downloads.
- Use the Chat media endpoint with bearer auth for file bytes.
- Treat `downloadUri` as a browser-facing or fallback field, not the primary API path.
- Normalize attachments by MIME type: image, audio, video, document, unknown.
- Add size limits and content-type checks before handing media to downstream AI models.

Project-specific evidence:

- `voice-transcriber-mcp` is narrow but valuable: it parses Chat message URLs, fetches the message, filters for `audio/*`, downloads the audio using `attachmentDataRef.resourceName`, then transcribes it.
- `google-chat-to-slack` models Google attachments with `contentName`, `contentType`, `downloadUri`, `attachmentDataRef.resourceName`, and Drive references, then carries attachments through a migration pipeline.
- Cloudflare's Errbot backend uses the same bearer-auth media download path for uploaded attachments.
- OpenClaw and Hermes both integrate downloaded media into an agent pipeline rather than leaving attachments as raw Chat objects.

Decision: attachment parsing and media normalization are a strong product wedge. They are under-served by published packages and only partially covered by samples.

#### Streaming Responses Via Edits

Google Chat does not have Slack-style live token streaming. The practical pattern in inspected projects is edit-based streaming:

1. Create a placeholder/progress/typing message.
2. Patch the same message as content is generated or tools complete.
3. Throttle edits and back off on rate limits.
4. Finalize with one last patch.
5. If an attachment must be included, send it as a separate create-message flow rather than assuming it can be patched into an existing message.

Hermes has the most complete implementation pattern here: it patches message text for progress, tracks rate-limit behavior, and handles the "typing card became final answer" edge case. OpenClaw also exposes message update and typing indicator primitives.

Decision: a package should provide `streamMessage()` as a high-level helper that hides placeholder creation, edit throttling, final patching, and fallback splitting.

### Hard Lessons To Productize

A new Google Chat developer package should productize the following primitives:

- `parseGoogleChatEvent(event)`: normalize direct app HTTP, Workspace Add-on, Pub/Sub, and custom relay event shapes.
- `normalizeMessage(message)`: return stable `text`, `argumentText`, `annotations`, `matchedUrl`, `slashCommand`, `thread`, `space`, `sender`, `cards`, `attachments`, and `privateMessageViewer` fields.
- `extractRichLinks(message)`: recover smart chips/rich links from annotations, not only `text`.
- `resolveUser(userName)`: map Chat users to People API records with cache and safe fallback display names.
- `downloadAttachment(attachment)`: use `attachmentDataRef.resourceName`, MIME dispatch, size limits, and SSRF-safe fallback behavior.
- `uploadAttachment(space, file)`: perform real media upload, return/send `attachmentDataRef`, and clearly separate app-auth and user-auth requirements.
- `replyInThread(event, message)`: default to the originating thread and `REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`.
- `editMessage(messageName, patch)`: patch `text` and/or `cardsV2` with correct `updateMask`.
- `streamMessage(event, asyncGenerator)`: create placeholder, patch progress, throttle, split oversized responses, and finalize.
- `cardActionRouter()`: route `CARD_CLICKED`, dialog submissions, widget updates, action parameters, and card state.
- `verifyChatRequest()`: validate Google Chat Bearer JWT audience and optionally Pub/Sub push JWTs.
- `findDirectMessage(user)`, `sendToUser(user)`, and `sendToSpace(space)`: hide DM-space lookup and membership edge cases.
- `fixtures` and `conformance tests`: official sample payloads plus real-world event shapes from OpenClaw/Hermes/MCP-style adapters.

### Updated Build Decision

There is room for a new project, but the target should not be "another raw Chat API wrapper." The defensible gap is:

**A Google Chat hard-primitives toolkit for AI/chatbot developers, built over official Google clients and optionally adapted into Chat SDK/FastAPI/MCP.**

Recommended shape:

1. Core TypeScript package over `@google-apps/chat` plus thin compatibility with `@chat-adapter/gchat`.
2. Optional FastAPI/Python package later if the TypeScript wedge proves out.
3. First-class attachment pipeline: images, audio, video, documents, Drive refs, rich links, and safe media download.
4. First-class Cards V2/dialog/action helpers.
5. Edit-based streaming helper with throttling/backoff.
6. Auth cookbook with explicit app-auth vs user-auth behavior, especially for native media upload.
7. Fixture-driven test suite using official samples plus captured anonymized payload shapes.

Stop condition: if a live smoke with Chat SDK already covers these primitives cleanly, contribute adapters/helpers upstream instead of starting a separate framework. Current evidence suggests Chat SDK is the best framework, but it does not yet erase the Google Chat-specific media/card/thread/auth pain.

## Build Opportunity

The package ecosystem is thin. There is one credible modern TypeScript framework (`chat` + `@chat-adapter/gchat`), official raw Google clients, and a set of small webhook/card/Python helpers. There appears to be room for a Google Chat-focused developer package if it does one of the following:

1. **Thin opinionated wrapper around Chat SDK**: "Google Chat batteries" for setup, auth, user resolution, thread behavior, attachments, event subscriptions, local dev, deployment templates, and conformance tests.
2. **Google Chat-specific toolkit over official clients**: tighter API helpers for app vs user auth, `findDirectMessage`, send/reply/update, attachment fetch, cards/dialog builders, and event normalization.
3. **Python FastAPI package**: combine `google-apps-chat`, `python-card-framework`, and a robust inbound event/router layer, using `gchatbot` as inspiration but not dependency until source provenance is clean.

The strongest product wedge is not "another raw API wrapper." It is **developer-safe orchestration around Google Chat's messy app lifecycle**:

- one route handler for all incoming Chat events;
- typed normalized event model;
- automatic "reply in thread where appropriate";
- high-level `sendToUser`, `sendToSpace`, `reply`, `update`, `replaceCard`, `openDialog`;
- attachment/media fetch helpers;
- member/user resolution with cache and scope-aware fallbacks;
- Workspace Events subscription lifecycle management;
- local verifier for Chat request JWTs, Pub/Sub push JWTs, and payload fixtures;
- card builder with compile-time/schema validation;
- app configuration checklist and deploy templates for Cloud Run, Workers, Vercel, and FastAPI.

## Recommended Next Step

Do a small smoke prototype with `chat` + `@chat-adapter/gchat`, but aim the prototype at the hard primitives found in the second GitHub pass:

1. Scaffold a minimal TypeScript bot using `create-chat-sdk`.
2. Implement an event handler that:
   - replies to an @mention in thread;
   - opens or sends a DM to a user;
   - posts a Card v2 with a button and handles the callback;
   - fetches/normalizes sender identity;
   - downloads and normalizes an input image attachment;
   - downloads and normalizes an input audio/voice attachment;
   - uploads an output attachment;
   - streams a long response by creating a placeholder message and patching it;
   - creates or validates a Workspace Events subscription for all messages in a space.
3. Record the missing Google Chat-specific helpers as product requirements.
4. Decide whether the package is:
   - a Chat SDK extension package;
   - a narrower Google Chat-native package over `@google-apps/chat`;
   - or a contribution upstream to Chat SDK.

Current decision: **wrap/extend first, but design the wedge around attachments/media, Cards V2 callbacks, thread/user normalization, and edit-based streaming.** Build a separate package only if the smoke shows those helpers are awkward to contribute upstream.

## Verification Log

Commands and checks run locally on June 29, 2026:

- `npm view` for `chat`, `@chat-adapter/gchat`, `@google-apps/chat`, `@googleapis/chat`, `googleapis`, `@google/chat-sdk`, `@guardian/google-chat-utils`.
- npm downloads API for `chat`, `@chat-adapter/gchat`, `@google-apps/chat`, `@googleapis/chat`, `googleapis`, `@google/chat-sdk`, `@google/chat-sdk-dialogflow`.
- PyPI JSON API for `gchatbot`, `googlechatbot`, `gchatcardbuilder`, `google-apps-chat`, `python-card-framework`.
- GitHub API checks for `vercel/chat`, `googleworkspace/chat-framework-nodejs`, `googleworkspace/google-chat-samples`, `googleapis/google-cloud-node`, `googleapis/google-api-nodejs-client`, `googleapis/google-cloud-python`, `javicv/googlechatbot`, `pkarl/gchatcardbuilder`, `google/python-card-framework`, `guardian/google-chat-utils`, Botkit repos.
- Local wheel inspection for `gchatbot==0.3.1`, `googlechatbot==1.2.3`, and `gchatcardbuilder==0.1.7`.
- Authenticated GitHub repo/code search for Google Chat bots, MCP servers, `cardsV2`, `attachmentDataRef`, `media.upload`, `messages.patch`, and voice-message projects.
- Source inspection of OpenClaw Google Chat docs/source snapshots, Hermes Google Chat adapter/source/tests, Google Workspace MCP Chat tools, Cloudflare GHC-Errbot, and google-chat-to-slack.
- Cloned and inspected:
  - `googleworkspace/google-chat-samples` at `62dd4336fb4062caedfb3d35bd9f8c19b07f7506`
  - `NousResearch/hermes-agent` at `929dd9c0d776186d1e8bf268cccfdb31e0398365`
  - `taylorwilsdon/google_workspace_mcp` at `6e1d1457746777f8512f52d40fb195b2a40bad36`
  - `markusjura/google-chat-to-slack` at `1fa40c5b5672504ebd0eea1b890875e593ab2628`
  - `siva010928/multi-chat-mcp-server` at `83291c74c42da60f19b1147742e779a85d269376`
  - `nguyenvanduocit/google-chat-mcp` at `792df6a57b417dcb3532feb8ab91d59cab0a56f5`
  - `ArnaudKleinveld/google-chat-mcp` at `3cd32770394fdabb922a3f3df133d9b5c7097f47`
  - `dyaskur/google-chat-poll` at `2c19359b531608b0921714505b78f7abaa419cb9`
  - `ikujyh/openclaw-gchat-router` at `f97128d28aa273f3cb4dc5686517544fdc220d60`
  - `fgasparetto/voice-transcriber-mcp` at `da30b553647f7c3381492e28f99e878c5ab919e5`
  - `hyungwookchoi/google-chat-webhook-action` at `01a8ac3d0f8a13557fdf71f2e05ada8efffc4b51`
