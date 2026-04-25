# Feasibility audit

Date: April 5, 2026  
Project: `codex-claude-bridge`

## Executive summary

The project is still **feasible only as a best-effort Claude compatibility runtime**, not as a fully transparent Claude-engine swap.

What is now solidly feasible:

- Claude CLI can target a local Anthropic-style proxy
- that proxy can execute real work through ChatGPT-authenticated Codex without API keys
- the bridge can preserve substantial Claude-side context before execution
- the bridge can expose sessions, diagnostics, hooks-style events, MCP inventory, and background orchestration locally

What remains not officially achievable:

- a raw ChatGPT-authenticated Codex model endpoint that mirrors Anthropic Messages
- transparent Claude tool semantics and full tool loop fidelity
- native Claude subagent behavior and client-side hook timing
- true engine-equivalent parity for permissions, approvals, and streaming

So the repo has advanced from a simple text proxy into a stronger runtime shell, but the core feasibility boundary has not changed.

## Direct answers

### 1. Can Claude Code be pointed at a custom Anthropic-compatible local proxy?

Yes, for Claude terminal CLI flows.

Official Claude Code documentation describes gateway-style configuration via:

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`
- Anthropic-style `/v1/messages`
- Anthropic-style `/v1/messages/count_tokens`

Local verification:

- `claude -p` works against this bridge on this machine
- the bridge receives real Claude CLI request shapes, including tool definitions and streaming flags

### 2. What request/response shape does the proxy need?

At minimum, it must support:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`

Important request fields:

- `model`
- `max_tokens`
- `messages`
- `system`
- `stream`
- `tools`
- `tool_choice`
- `metadata`
- Anthropic headers such as `anthropic-version` and `anthropic-beta`

For streaming, the closest relevant Anthropic SSE sequence is:

- `message_start`
- `content_block_start`
- `content_block_delta`
- `content_block_stop`
- `message_delta`
- `message_stop`
- `error`

The bridge now implements that envelope for text output. It still cannot honestly claim full Claude tool-event compatibility.

### 3. What officially supported local Codex interfaces exist with ChatGPT auth?

Official local Codex surfaces found and locally validated:

- `codex` interactive CLI
- `codex exec`
- `codex mcp-server`
- `codex app-server`

These are all local agent/application surfaces, not raw model endpoints.

### 4. Is there an officially documented Codex App Server or local transport for host apps?

Yes.

OpenAI documents `codex app-server` with:

- JSON-RPC over `stdio`
- initialization flow
- auth inspection and login flows
- thread/turn operations
- agent-message delta notifications
- MCP configuration and status methods

This remains the strongest official host-application integration path, even though it is still experimental in practice.

### 5. Can ChatGPT-authenticated Codex be driven locally without API keys?

Yes.

Local verification on this machine:

- `codex login status` reports ChatGPT auth
- `codex exec` works without `OPENAI_API_KEY`
- app-server account inspection reports a ChatGPT `plus` plan
- the bridge never falls back to OpenAI API billing

### 6. Is a full transparent backend swap feasible?

No, not in an officially supported and honest sense.

A strong partial bridge is feasible. A fully transparent Claude backend replacement is not.

Why:

- Claude expects Claude/Anthropic model semantics
- Codex local surfaces expose task, thread, approval, and agent behavior
- the bridge can translate between them, but it cannot make those contracts identical

The best realistic outcome is therefore:

- Anthropic-compatible ingress
- Claude context ingestion
- execution orchestration
- local Codex execution
- explicit compatibility gaps

### 7. What are the legal, support, and maintainability risks?

Main risks:

- cross-vendor support risk
- behavior drift in Claude CLI request patterns
- behavior drift in experimental Codex app-server methods
- mismatch between Claude permissions/hooks/subagents and bridge approximations
- MCP auth/config drift
- token counting and streaming mismatch

The project remains within the stated constraints:

- no scraping
- no browser automation hacks
- no token extraction
- no private endpoint reverse engineering
- no paid API dependency

## What changed after the compatibility-runtime upgrade

Compared with the original proof of concept, the project now additionally supports:

- scoped Claude config ingestion
- `CLAUDE.md` and skill context ingestion
- permission intent mapping
- synthetic hooks lifecycle events
- MCP inventory comparison and diagnostics
- persistent sessions
- background jobs with resumable logs
- planner/worker task graph approximation for delegated work

This meaningfully improves operational similarity to Claude Code, even though it does not change the underlying engine-swap limit.

## Current implementation verdict

Most honest one-line description:

> `codex-claude-bridge` is a local Claude compatibility runtime that can route Claude CLI traffic into ChatGPT-authenticated Codex using supported local Codex surfaces, while preserving a substantial subset of Claude runtime context, but it is still not a transparent or fully replaceable Claude engine.

## Verified behavior during the current pass

Verified locally on this machine during the compatibility-runtime upgrade:

- `npm run build`
- `npm run smoke:exec`
- `npm run smoke:proxy`
- `npm run smoke:background`
- `npm run smoke:claude`
- `npm run diagnostics:compat`
- `GET /diagnostics/mcp`

Additional observed facts:

- background jobs now persist state and replayable events
- Claude CLI still sends real tool-rich traffic through the bridge
- direct `codex app-server` probing works
- direct `codex app-server` turn execution is still unstable and should be treated as experimental

## Bottom-line feasibility call

- True engine replacement: `not feasible with current official surfaces`
- Capability-preserving local compatibility runtime: `feasible`
- Useful developer prototype: `feasible and now implemented`

## Sources

Official Claude Code docs:

- https://code.claude.com/docs/en/llm-gateway
- https://code.claude.com/docs/en/settings
- https://code.claude.com/docs/en/permissions
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/sub-agents

Official Anthropic platform docs:

- https://platform.claude.com/docs/en/build-with-claude/streaming

Official OpenAI docs:

- https://developers.openai.com/codex/app-server
- https://developers.openai.com/codex/mcp
- https://developers.openai.com/codex/subagents
- https://developers.openai.com/codex/skills
- https://developers.openai.com/codex/noninteractive

Official adjacent repo:

- https://github.com/openai/codex-plugin-cc
