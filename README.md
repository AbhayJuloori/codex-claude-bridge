# codex-claude-bridge

`codex-claude-bridge` is a local Claude compatibility runtime that accepts Anthropic-style traffic from Claude CLI and routes execution into ChatGPT-authenticated Codex without `OPENAI_API_KEY`, Anthropic runtime billing, OpenRouter, or other paid API services.

The runtime now behaves as a hybrid orchestration system:

- manager/router path for higher-judgment tasks
- Codex worker path for implementation-heavy tasks
- Codex reviewer path for findings-first review work
- compressed packet handoff between stages so the manager layer does not need the full worker transcript

## Current status

- Anthropic-compatible ingress: `supported`
- Claude CLI against local proxy: `supported`
- Real bridge-native tool round-trips: `supported`
- Hybrid routing runtime: `supported`
- Real Claude subprocess routing (via `claude --print`): `supported`
- Real Claude packet judgment for refinement and review: `supported`
- Real Claude direct response (`claude_direct`): `supported`
- Conservative fast-path router (3 unambiguous patterns only): `supported`
- `codex exec` adapter: `supported`
- `codex app-server` probing and MCP surfaces: `experimental`
- `codex app-server` direct turn execution: `experimental / unstable`
- Config, `CLAUDE.md`, skills, agents, and settings ingestion: `supported`
- Compressed implementation packets: `supported`
- Compressed review packets: `supported`
- Permissions parity with Claude: `partial`
- Hooks compatibility layer: `experimental`
- MCP bridging: `partial`
- Transparent Claude tool semantics: `partial`
- `claude_direct` tool use (bridge-native loop for Claude): `not available — falls back to Codex direct`
- Full Claude-engine replacement: `not achievable with current official surfaces`

## Execution modes

- `claude_direct` — **real `claude --print` subprocess response** (streams stdout); falls back to Codex direct if subprocess unavailable
- `codex_delegate` — Codex worker + tool loop
- `codex_then_claude_refine` — Codex first pass → **real Claude packet judgment** → accept/refine/patch/reroute/escalate
- `codex_review` — Codex review worker + tool loop
- `codex_adversarial_review` — adversarial Codex review
- `codex_review_then_claude_judgment` — Codex review → **real Claude judgment** → accept/refine/reroute/escalate

## Routing

Tasks are routed in two stages:

1. **Conservative fast-path** (no Claude required): fires only for 3 unambiguous patterns — pure code review, pure adversarial review, pure mechanical implementation. Any conflicting signals skip the fast-path entirely.
2. **Real Claude routing** (via `claude --print`): handles all ambiguous cases. Returns a structured JSON mode decision. Falls back to a conservative heuristic if the subprocess fails.

The fast-path is intentionally narrow. Misrouting is more expensive than an extra subprocess call.

## What this bridge can do now

- Accept `POST /v1/messages`, `POST /v1/messages/count_tokens`, and `POST /v1/messages/background`
- Preserve Claude-side context such as settings, `CLAUDE.md`, visible skills, agents, and MCP inventory
- Run a real multi-turn bridge tool loop for `bash`, `read_file`, `write_file`, and `edit_file`
- Route tasks into direct, delegation, review, adversarial review, and judgment flows
- Return compressed implementation packets instead of full worker transcripts
- Return compressed review packets and judgment summaries for review-style work
- Persist sessions, logs, background jobs, packet events, and task graphs
- Expose diagnostics for compatibility context, MCP status, jobs, and sessions

## Documentation

- [Feasibility](./docs/feasibility.md)
- [Architecture](./docs/architecture.md)
- [Tool round-trip design](./docs/tool-roundtrip-design.md)
- [Delegation runtime design](./docs/delegation-runtime-design.md)
- [Review runtime design](./docs/review-runtime-design.md)
- [Systems compatibility audit](./docs/systems-compatibility-audit.md)
- [Compatibility test matrix](./docs/compatibility-test-matrix.md)
- [Risks and limitations](./docs/risks-and-limitations.md)
- [Build log](./docs/build-log.md)

## Prerequisites

- macOS or Linux
- Node.js 20+
- `codex` CLI installed
- Claude CLI installed if you want end-to-end client testing
- ChatGPT-authenticated Codex login

Verify Codex auth:

```bash
codex login status
```

Expected:

```text
Logged in using ChatGPT
```

## Install

```bash
npm install
cp .env.example .env
```

Optional:

```bash
cp codex-claude-bridge.config.example.json codex-claude-bridge.config.json
```

## Start the bridge

For the most reliable delegation and tool-loop behavior today, prefer the `exec` adapter:

```bash
CODEX_ADAPTER=exec npm run dev
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

## Point Claude CLI at the bridge

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=codex-bridge-local
claude -p "Reply with exactly BRIDGE_OK"
```

## Tool protocol summary

When Codex needs a bridge-native tool, it emits a strict fenced block:

```bridge-tool
{"type":"tool_call","id":"call_1","tool":"read_file","args":{"path":"package.json"}}
```

When it is done, it emits:

```bridge-tool
{"type":"final","answer":"..."}
```

The bridge executes the tool locally, appends a structured `tool_result` transcript entry, and runs the next turn until it reaches a final answer.

## Compressed packet summary

Implementation packets use a compact `bridge-packet` JSON result with fields such as:

- `status`
- `filesChanged`
- `summary`
- `commandsRun`
- `warnings`
- `suggestedNextStep`
- `confidence`

Review packets use a compact `bridge-packet` JSON result with fields such as:

- `findings`
- `bugRisks`
- `regressionRisks`
- `securityConcerns`
- `missingTests`
- `openQuestions`
- `recommendation`
- `confidence`

These packets are also recorded in session events so the runtime can reuse them for refinement, judgment, and diagnostics without replaying the full worker transcript.

## Diagnostics endpoints

- `GET /health`
- `GET /diagnostics/config`
- `GET /diagnostics/compatibility`
- `GET /diagnostics/mcp`
- `POST /diagnostics/mcp/reload`
- `GET /diagnostics/sessions`
- `GET /diagnostics/sessions/:sessionId`
- `GET /jobs`
- `GET /jobs/:jobId`
- `GET /jobs/:jobId/events`
- `POST /jobs/:jobId/cancel`

## Smoke tests

Build integrity:

```bash
npm run build
```

Router classification:

```bash
npm run smoke:router
```

Worker delegation:

```bash
npm run smoke:delegate
```

Delegation plus refinement:

```bash
npm run smoke:refine
```

Review mode:

```bash
npm run smoke:review
```

Adversarial review mode:

```bash
npm run smoke:adversarial-review
```

Review plus final judgment:

```bash
npm run smoke:review-judgment
```

Direct bridge-native tool loop:

```bash
npm run smoke:tools
```

Direct HTTP proxy request:

```bash
npm run smoke:proxy
```

Background jobs and persisted logs:

```bash
npm run smoke:background
```

Real Claude CLI through the bridge:

```bash
npm run smoke:claude
```

Real Claude CLI plus at least one recorded bridge tool round-trip:

```bash
npm run smoke:claude-tools
```

Compatibility diagnostics:

```bash
npm run diagnostics:compat
```

## Verified during the current pass

- `npm run build`
- `npm run smoke:router`
- `npm run smoke:delegate`
- `npm run smoke:refine`
- `npm run smoke:review`
- `npm run smoke:adversarial-review`
- `npm run smoke:review-judgment`

Observed locally:

- route selection matched all six orchestration modes
- delegated implementation wrote files through the real bridge-native tool loop
- refinement path returned a compressed implementation outcome instead of a raw transcript
- review path returned findings-first output
- adversarial review surfaced stronger hidden-risk findings
- review-plus-judgment produced a more concise final decision than the raw review packet

## Main implementation files

- `src/server.ts`
- `src/router/strategy-router.ts`
- `src/delegation/envelopes.ts`
- `src/orchestrator/hybrid-runtime.ts`
- `src/orchestrator/packets.ts`
- `src/orchestrator/types.ts`
- `src/review/judgment-policy.ts`
- `src/refinement/policy.ts`
- `src/tools/protocol.ts`
- `src/tools/executor.ts`
- `src/tools/loop.ts`

## /delegate — Claude Plans, Codex Builds

The `/delegate` endpoint implements the **advisor strategy**: Claude plans + quality-gates, Codex executes. Claude spends ~5–10k tokens per project; Codex handles the bulk.

### Trigger

**Claude Code skill** (type in any Claude Code session):
```
/delegate build me an ML portfolio project with FastAPI backend and React frontend
```

**Direct API** (for scripts or other tools):
```bash
curl -X POST http://localhost:8787/delegate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer codex-bridge-local" \
  -d @manifest.json
```

### Domain-Aware Quality Gates

| Domain | Codex role | Claude role |
|--------|-----------|-------------|
| `backend`, `ml`, `data`, `test` | Primary builder | Review → accept/patch |
| `ui`, `frontend` | Build skeleton only | **Always rewrites** to production quality |
| `architecture` | Skipped | Claude handles directly |

### Codex Skills (auto-injected)

- `skills/testing/` — test-first patterns, pytest/jest
- `skills/code-quality/` — types, naming, error handling
- `skills/project-structure/` — conventional layouts
- `skills/ui-baseline/` — functional skeleton (Claude rewrites visual quality)
- `skills/ml-patterns/` — reproducible ML, train/val splits, persistence

### Project Memory

`.delegate/context.md` is updated after each phase — Codex reads it at task start to avoid cross-phase contradictions.

### Smoke test

```bash
CODEX_ADAPTER=exec npm run dev &
sleep 3
npx tsx scripts/smoke-delegate-workflow.ts
```

## Biggest remaining blocker

The bridge now better matches a local manager/worker/reviewer runtime, but the single biggest blocker to a true Claude-manager plus Codex-worker fusion is still the lack of an officially documented ChatGPT-authenticated Codex raw model interface and the lack of a real Anthropic Claude runtime stage inside the bridge.
