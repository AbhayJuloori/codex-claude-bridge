# Hybrid Manager Design: Real Claude Manager + Codex Worker

Date: 2026-04-06
Status: Approved — implementing Phase 1

---

## 1. Honest audit of the current repo

| Component | Current reality | Label |
|---|---|---|
| `claude_direct` mode | Runs base Codex adapter. No Claude anywhere. | **FAKE** |
| `codex_then_claude_refine` — refinement stage | Heuristic rule check (`decideRefinement`) → second Codex pass with a refinement envelope | **FAKE** |
| `codex_review_then_claude_judgment` — judgment stage | `buildJudgmentPacket` is pure severity sort/count → third Codex pass with a judgment envelope | **FAKE** |
| Strategy router | Keyword regex over last user message, no confidence scoring | **APPROXIMATE** |
| Bridge-native tool loop | Real local execution of bash/read/write/edit | **REAL** |
| Compressed packet formats | Real typed structures, real SSE, real parsing | **REAL** |
| Session/job/diagnostics layer | Real persistence and diagnostics | **REAL** |

**Core problem:** Every stage with "Claude" in its name is actually Codex behind a different prompt envelope. The system is Codex-everywhere with Claude-branded mode names.

---

## 2. Target architecture

```
User request
  │
  ▼
Fast-path router (extremely conservative regex)
  │  ← Only fires for 3 perfectly unambiguous patterns
  │  ← If ANY doubt: fall through to Claude routing
  ▼
[if doubt] claude --print routing call (~100 token prompt → JSON mode + rationale)
  │
  ▼
Codex worker (tool loop, bridge-native protocol, compressed packet)
  │
  ▼
claude --print packet judgment (~500 token input → JSON verdict)
  │
  ├─ accept    → return packet-rendered response to user
  ├─ refine    → Codex refinement pass → return
  ├─ patch     → Codex targeted patch pass → return
  ├─ reroute   → different Codex mode (e.g. re-run as adversarial review)
  └─ escalate  → claude --print handles the full response (streaming)
  │
  ▼
  [claude_direct tasks skip Codex entirely → claude --print full response]
```

---

## 3. The gap

| What's missing | How we close it |
|---|---|
| Real Claude routing | `claude --print` subprocess, JSON-structured prompt, called when fast-path confidence is not 100% certain |
| Real Claude refinement judgment | `claude --print` subprocess replaces `decideRefinement()` heuristic |
| Real Claude review judgment | `claude --print` subprocess replaces `decideJudgment()` heuristic |
| `claude_direct` actually using Claude | `claude --print` subprocess for the full response, streaming stdout |
| Confidence scoring on router | Added to fast-path: only accept if ≥2 corroborating signals AND zero conflicting signals |

---

## 4. Explicit assumptions

1. `claude` binary is on PATH and authenticated via Claude Code subscription.
2. `claude --print --dangerously-skip-permissions` works for non-interactive single-prompt calls.
3. Routing and judgment prompts are structured to request JSON output. Claude response is parsed as JSON with a regex fallback.
4. Claude subprocess timeout: 30 seconds for routing/judgment calls, 120 seconds for `claude_direct` full responses.
5. Fast-path accepts only 3 patterns:
   - **Pure review**: review/findings/risks keywords present + zero implementation/architecture/judgment keywords
   - **Pure adversarial**: adversarial/security/hidden-risk keywords present + zero implementation keywords
   - **Pure mechanical implementation**: implement/scaffold/refactor/edit/write keywords present + prompt length < 2000 + zero review/architecture/judgment keywords
   - Everything else → Claude subprocess routing
6. `claude_direct` streaming: stdout from `claude --print` is read incrementally and forwarded as SSE text-delta events.
7. If Claude subprocess fails (timeout, non-zero exit, parse error): log the error and fall back to the previous behavior (heuristic policy / Codex direct). Never hard-fail a user request due to Claude subprocess failure.
8. The `ClaudeSubprocessManager` is constructed once in `createAdapter` and passed to `HybridRuntimeAdapter`.
9. Routing and judgment prompts are kept under 200 words to minimize Claude token cost and latency.
10. `claude_direct` full-response mode: sends the last user message + system context as a single prompt. Multi-turn context is flattened to text. No tool use in this path.

---

## 5. New components

### `src/claude/subprocess.ts` — ClaudeSubprocessManager

- `call(prompt, timeoutMs): Promise<string>` — non-streaming, for routing and judgment
- `stream(prompt, signal): AsyncGenerator<string>` — streaming stdout, for `claude_direct`
- Both use `spawn('claude', ['--print', '--dangerously-skip-permissions'])` with prompt on stdin
- Timeout via `AbortController`
- On failure: throws, caller decides fallback

### `src/claude/prompts.ts` — structured prompts

- `buildRoutingPrompt(taskText): string` — asks Claude to return `{"mode": "...", "rationale": "..."}` from the six valid modes
- `buildPacketJudgmentPrompt(packet): string` — asks Claude to return `{"verdict": "accept|refine|patch|reroute|escalate", "rationale": "...", "risk_score": 0.0-1.0}`
- `buildReviewJudgmentPrompt(packet): string` — same for review packets
- `buildDirectResponsePrompt(task): string` — flattens task into a single Claude prompt

---

## 6. Modified components

### `src/router/strategy-router.ts`

- Synchronous `routeTaskFastPath(task): StrategyDecision | null` — returns null if not obviously classifiable
- Async `routeTask(task, claude): Promise<StrategyDecision>` — calls fast-path first, then Claude if null
- Routing confidence: fast-path only returns a decision when zero conflicting signals exist

### `src/refinement/policy.ts`

- `async function decideRefinement(packet, claude): Promise<RefinementDecision>`
- Calls `claude.call(buildPacketJudgmentPrompt(packet))`
- Parses JSON verdict: accept | refine | patch | reroute | escalate
- Falls back to old heuristic if Claude call fails

### `src/review/judgment-policy.ts`

- `async function decideJudgment(packet, claude): Promise<JudgmentDecision>`
- Calls `claude.call(buildReviewJudgmentPrompt(packet))`
- Falls back to `buildJudgmentPacket` heuristic if Claude call fails

### `src/orchestrator/hybrid-runtime.ts`

- Constructor accepts `ClaudeSubprocessManager | null`
- `execute()` awaits `routeTask(task, this.claude)` instead of calling sync `routeTask`
- `claude_direct` → `this.runClaudeDirect(task)` which streams `claude --print`
- `runImplementationWithRefinement` awaits real `decideRefinement`
- `runReview` with judgment awaits real `decideJudgment`

### `src/adapters/index.ts`

- Constructs `ClaudeSubprocessManager` and passes to `HybridRuntimeAdapter`

---

## 7. What this makes real vs. what stays approximate

| | After Phase 1 |
|---|---|
| `claude_direct` | **REAL** — actual Claude subprocess response |
| `codex_then_claude_refine` judgment | **REAL** — actual Claude evaluates the packet |
| `codex_review_then_claude_judgment` | **REAL** — actual Claude judges the review packet |
| Strategy routing (ambiguous cases) | **REAL** — actual Claude classifies |
| Strategy routing (obvious cases) | **APPROXIMATE** — conservative regex, very narrow fast-path |
| Codex worker pass | **REAL** — unchanged |
| Tool loop | **REAL** — unchanged |

---

## 8. What still cannot be made real

| | Why |
|---|---|
| `claude_direct` tool use (bash/file ops) | `claude --print` has no bridge-native tool loop. Tool-using direct tasks fall back to Codex direct adapter. |
| Multi-turn memory in `claude_direct` | `claude --print` takes a single prompt. Conversation history is flattened to text. No native multi-turn state. |
| Streaming Claude routing/judgment | Routing and judgment calls are fire-and-return. Streaming would add complexity with no benefit. |
| Full Anthropic tool-event parity | Still behind the local proxy. No change in Phase 1. |

---

## 9. Phased roadmap

### Phase 1 (this session) — Close the manager gap
- `ClaudeSubprocessManager` with call + stream
- Conservative fast-path router + Claude routing escalation
- Real Claude packet judgment (refinement + review judgment)
- Real `claude_direct` via `claude --print`
- Graceful fallback if Claude subprocess fails

### Phase 2 — Quality signal improvements
- Packet confidence scoring: add `unresolvedRisks`, `coverageGaps`, `ambiguityScore` fields to packets
- Router fast-path coverage report: log which pattern matched or why Claude was called
- Claude judgment prompt tuning based on observed verdicts

### Phase 3 — Multi-turn Claude direct
- Flatten conversation history into a structured prompt with role labels
- Let Claude see prior turns for `claude_direct` tasks

### Phase 4 — Tool-capable Claude direct
- Investigate whether `claude` CLI supports tool-use in `--print` mode
- If yes: wire bridge tools into a Claude-native loop for `claude_direct`
