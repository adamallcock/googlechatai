---
title: Five Developer Public Beta Protocol
date: 2026-07-16
type: runbook
status: implemented
---

# Five Developer Public Beta Protocol

This protocol validates whether `googlechatai` removes enough Google Chat
friction for independent developers. It is an external evidence gate, not a
substitute for automated tests. Repository maintainers, coding agents, and five
runs by one person do not count as five participants.

Current execution state on 2026-07-16:

| Slot | Participant | Language | Status |
|---|---|---|---|
| P1 | Unassigned | Node | Awaiting external participant |
| P2 | Unassigned | Node | Awaiting external participant |
| P3 | Unassigned | Python | Awaiting external participant |
| P4 | Unassigned | Python | Awaiting external participant |
| P5 | Unassigned | Participant choice | Awaiting external participant |

No external usability result is claimed until a real person completes a
session and its redacted scorecard is recorded.

## Recruitment

Recruit five developers who were not contributors to this repository:

- two who have built a Google Workspace or Chat integration;
- two who have API/backend experience but no Google Chat app experience;
- one early-career or infrequent backend developer;
- at least two Node users and two Python users;
- access to a Google Workspace where they may create or install a test Chat
  app, or an operator who can perform the administrative steps while they
  drive.

Do not request their OAuth token, service-account file, tenant id, private
message content, screen recording, or production workspace access.

Invite text:

> I am testing a public-beta Google Chat developer SDK. The session takes
> 45-60 minutes. You will build and locally test a small app, diagnose one
> intentional configuration error, and, if your Workspace permits it, deploy
> it to a dedicated empty test space. Please do not use production data. I
> need honest friction notes rather than a positive review.

## Facilitator Rules

1. Give the participant this runbook and the package version, but no private
   repository or tenant material.
2. Ask them to share their terminal only if they choose. Never ask them to
   expose `.env.local`, OAuth tokens, service-account JSON, or Cloud Console
   account identifiers.
3. Do not intervene for the first ten minutes of local setup. Record the first
   point at which help is requested.
4. Distinguish SDK/documentation failures from administrator approval or Cloud
   billing delays.
5. Record only anonymous slot id, experience band, language, elapsed times,
   command exit status, sanitized finding codes, and the participant's
   paraphrased feedback.

## Tasks

Start the clock before Task 1.

### Task 1: Local First Reply

Node:

```bash
npx googlechatai@next init beta-chat-app --language node --install
cd beta-chat-app
npm test
npm run fixture
```

Python:

```bash
npx googlechatai@next init beta-chat-app --language python --install
cd beta-chat-app
.venv/bin/python -m unittest
npx googlechatai@next replay fixtures/mention.json \
  --language python \
  --python .venv/bin/python \
  --handler app.py \
  --expect-text "You said"
```

Success means a clean machine produces the expected local reply without Google
credentials or facilitator intervention.

### Task 2: Understand Routing And Context

```bash
npx googlechatai@next inspect fixtures/mention.json --format json
```

Ask the participant to identify:

- whether the app was mentioned;
- the intended reply route;
- the triggering thread;
- what model-bound context is included;
- whether raw payloads are present by default.

Success means all five answers are correct without reading SDK source.

### Task 3: Diagnose An Injected Error

Have the participant temporarily set:

```text
GOOGLE_CHAT_PROJECT_NUMBER=my-project-id
```

Then run:

```bash
npx googlechatai@next doctor --strict
```

Success means they explain that the callback audience requires the numeric
project number and name the next corrective action. Remove the injected value
before continuing.

### Task 4: Inspect A Card And Request Plan

Use the generated card fixture and a `reply-to-event` request:

```bash
npx googlechatai@next card lint fixtures/card.json
npx googlechatai@next plan reply-to-event \
  --event fixtures/mention.json \
  --text "Working on it" \
  --format json
```

Ask them to identify principal, scopes, request method/path, and live safety
state. If card lint fails, they should use the finding path to repair it.

### Task 5: First Live Mention

This task is attempted only in an empty dedicated space whose display name
starts with `Google Chat AI SDK Smoke`. No real users may be invited.

The participant or their administrator must deploy/register/install the app,
copy `smoke-space.example.json` to the ignored local metadata file, and run
the no-write plan first:

```bash
npx googlechatai@next doctor --strict
npx googlechatai@next smoke --metadata smoke-space.local.json
```

Only after reviewing the plan may they supply a short-lived user OAuth token
with Chat space-read and message-read/write access out of band and deliberately
run `smoke --live` with
`RUN_LIVE_GOOGLECHATAI_SMOKE=1`. The smoke must:

- create one mention in the dedicated space;
- observe the app's reply in the triggering thread;
- delete the prompt;
- print or save no token, message text, or raw payload.

Administrative inability to create/install the app is recorded as
`external-admin-blocked`, not as an SDK pass or failure.

### Task 6: One Change Without Source Help

Ask the participant to change the mention reply, add one field from the
normalized event, update the local assertion, and rerun the fixture. This
proves they can build into the abstraction rather than only execute a canned
demo.

## Session Scorecard

Use one row per participant. Store no names, emails, tenant identifiers, tokens,
or private text.

| Field | Allowed value |
|---|---|
| Slot | P1-P5 |
| Experience | Workspace-experienced / backend-new-to-Chat / early-career |
| Language | Node / Python |
| Local first reply | elapsed seconds or failed |
| Help before local success | none / docs / facilitator |
| Inspect comprehension | 0-5 |
| Injected-error diagnosis | elapsed seconds or failed |
| Card/plan task | pass / fail |
| Live task | pass / sdk-failed / external-admin-blocked / declined |
| Correct-thread smoke | pass / fail / not-attempted |
| One-change task | pass / fail |
| First blocking point | sanitized command and finding code |
| Would use for a real app | yes / maybe / no, with paraphrased reason |

## Decision Gates

Do not promote the beta to stable `0.1.0` unless:

- at least four of five complete local first reply in ten minutes;
- at least four of five complete the one-change task without source help;
- median inspect comprehension is at least four of five;
- at least four of five diagnose the injected project-number error in five
  minutes;
- at least three live attempts pass mention delivery and correct-thread
  routing, excluding `external-admin-blocked` sessions from the denominator;
- no run exposes a token, private payload, or message text in CLI output;
- every repeated SDK/documentation failure has an issue and owner.

Stop promotion and repair the workflow if two developers independently hit the
same SDK-controlled blocker. Continue beta without claiming a live conversion
rate if fewer than three participants can attempt live setup because of
Workspace administration.

## Closeout

After all five sessions:

1. aggregate elapsed times and pass/fail counts without participant identity;
2. separate SDK, documentation, Google Console, and administrator blockers;
3. open one narrowly reproducible issue per repeated SDK-controlled blocker;
4. record fixes and rerun only the failed task with the affected participants;
5. write a dated redacted report and link it from `docs/README.md`;
6. make an explicit stop, continue-beta, or promote decision.
