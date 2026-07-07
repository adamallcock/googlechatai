---
title: Agent SDK Compatibility Implementation Plan
date: 2026-07-06
type: plan
status: in-progress
---

# Agent SDK Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize common agent SDK output shapes into Google Chat-ready response context and message/card plans.

**Architecture:** Add a pure `agent-interop` module in Node and Python, backed by shared fixtures, schema, and conformance cases. The module extracts final text, sources, tool calls/results, thinking summaries, warnings, usage, and optional cost metadata, then composes existing Google Chat card builders without taking ownership of model execution.

**Tech Stack:** TypeScript, Python standard library, shared JSON fixtures, conformance runner, existing Google Chat card builders.

---

### Task 1: Shared Contract And Fixtures

**Files:**
- Create: `spec/agent-interop.schema.json`
- Create: `conformance/cases/agent-interop.normalize.json`
- Create: `fixtures/agent-interop/*.json`
- Create: `fixtures/expected/agent-interop/*.json`
- Modify: `tools/conformance/run.mjs`

- [x] **Step 1: Write the failing tests**

Add shared fixture cases for Anthropic content blocks, OpenAI Agents run
results, Vercel AI SDK results, Google GenAI Interactions grounding responses,
and one Google Chat message-plan case.

- [ ] **Step 2: Run conformance to verify it fails**

Run: `corepack pnpm conformance`

Expected before implementation: FAIL because `agentInterop.*` cases and exports
are not implemented.

- [ ] **Step 3: Add schema validation**

Validate normalized responses against `agent-interop.schema.json`. Validate
message plans against the plan definition in the same schema.

### Task 2: Node Agent Interop Module

**Files:**
- Create: `packages/node/src/agent-interop/index.ts`
- Modify: `packages/node/src/index.ts`
- Create: `packages/node/test/agent-interop.test.ts`

- [ ] **Step 1: Implement `normalizeAgentResponse`**

Detect common Anthropic, OpenAI Agents, Vercel AI SDK, and Google GenAI shapes.
Return the shared `agent_response` contract with bounded summaries only.

- [ ] **Step 2: Implement `planAgentResponseMessage`**

Use `buildSourcesCard`, `buildThinkingCard`, and `buildToolStatusCard` to build
a deterministic message sequence for Google Chat callers.

- [ ] **Step 3: Run Node tests**

Run: `corepack pnpm --filter googlechatai test -- agent-interop.test.ts`

Expected after implementation: PASS.

### Task 3: Python Agent Interop Module

**Files:**
- Create: `packages/python/src/googlechatai/agent_interop.py`
- Modify: `packages/python/src/googlechatai/__init__.py`
- Create: `packages/python/tests/test_agent_interop.py`

- [ ] **Step 1: Implement Python parity**

Mirror Node semantics using snake_case public names but camelCase output JSON.

- [ ] **Step 2: Run Python tests**

Run: `PYTHONPATH=packages/python/src python3 -m unittest packages.python.tests.test_agent_interop`

Expected after implementation: PASS.

### Task 4: Parity And Release Gates

**Files:**
- Modify only if needed: `tools/release/check-sdk-parity.mjs`

- [ ] **Step 1: Run conformance**

Run: `corepack pnpm conformance`

Expected after implementation: PASS with Node and Python matching the same
expected fixtures.

- [ ] **Step 2: Run export parity**

Run: `corepack pnpm parity:exports`

Expected after implementation: PASS.

- [ ] **Step 3: Run focused package tests and build**

Run:

```bash
corepack pnpm --filter googlechatai test -- agent-interop.test.ts
PYTHONPATH=packages/python/src python3 -m unittest packages.python.tests.test_agent_interop
corepack pnpm build
```

Expected after implementation: all commands exit 0.

