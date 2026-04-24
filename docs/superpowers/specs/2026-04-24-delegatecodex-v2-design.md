# /delegatecodex v2 — Design Spec

**Date:** 2026-04-24  
**Status:** Approved for implementation  
**Replaces:** `src/pipeline/` (kept intact as v1 compatibility path)

---

## 1. Motivation

The existing `src/pipeline/` (v1) achieves token savings by routing through Haiku → Sonnet → Codex → Haiku clarify → Sonnet takeover. It works, but Claude is invoked at multiple stages, some of which (Haiku classify, Haiku clarify, Sonnet plan steps) do not require Claude's full judgment.

**Goal:** Same Claude quality. Fewer Claude tokens. Codex does all execution work Claude used to do via tool calls.

Claude's touch is preserved by shifting its role from *doing* to *directing + judging*. Codex is the hands. Claude is the brain that never leaves — it plans precisely once and judges once.

**Hard budget (default):**
- `max_claude_calls = 2` (1 plan + 1 judge; repair rounds do not add Claude calls)
- `max_repair_rounds = 2`
- `max_codex_turns` — configurable per mode
- `max_wall_time_ms` — configurable per mode

---

## 2. Architecture

```
POST /delegatecodex
        │
        ▼
  ┌─────────────────┐
  │ Claude Dispatcher│  ← Sonnet, 1 call
  │ (Planner)        │    produces ExecutionPlan
  └────────┬────────┘
           │
    brain == "claude_leads"?
           ├─ YES → Claude handles directly → respond
           │
           └─ NO (codex_leads)
                  │
                  ▼
         ┌────────────────┐
         │  Codex Agent   │  ← model + reasoning from plan
         │                │    plugins: hint (Codex may add/change)
         │  subagents,    │    session: stateful | stateless
         │  plugins,      │    write_policy enforced
         │  skills        │
         └───────┬────────┘
                 │
                 ▼
         ExecutionPacket  ← structured artifact from Codex
                 │
                 ▼
         ┌──────────────┐
         │ Claude Judge  │  ← Sonnet, 1 call
         │               │    judges: plan + packet + diff + tests
         └──────┬────────┘
                │
        ┌───────┼──────────┐
      ACCEPT  REPAIR    TAKEOVER
        │       │           │
      done   Codex fix   claude-takeover.ts
             (≤2 rounds)  Claude handles
             judge        directly
             feedback
             injected
```

---

## 3. New Runtime: `src/delegatecodex/`

Old pipeline **untouched** in `src/pipeline/`. Old endpoint kept as `/delegatecodex-old` for comparison testing.

```
src/delegatecodex/
├── types.ts              — ExecutionPlan, ExecutionPacket, JudgmentVerdict, all Zod schemas
├── config.ts             — model tier names, budget defaults (all names configurable)
├── dispatcher.ts         — Claude Dispatcher: task → ExecutionPlan (1 Sonnet call)
├── plugin-router.ts      — task type + mode → plugin hints
├── session-manager.ts    — Codex session ID tracking (stateful/stateless per plan)
├── codex-agent.ts        — Codex invocation (model, reasoning, plugins, session, write_policy)
├── claude-judge.ts       — Claude judgment: 6 criteria + verdict
├── repair-loop.ts        — verdict=repair → Codex retry with judge feedback (≤2 rounds)
├── claude-takeover.ts    — verdict=takeover → Claude handles directly
└── delegatecodex.ts      — orchestrator
```

---

## 4. ExecutionPlan Schema

Produced by Claude Dispatcher. Controls everything downstream.

```ts
const executionPlanSchema = z.object({
  // Routing
  brain: z.enum(["codex_leads", "claude_leads"]),

  // Mode — determines default write_policy, claude_after, model tier
  mode: z.enum([
    "implement",
    "review",
    "adversarial_review",
    "debug",
    "test_generation",
    "ui_build",
    "ui_refine",
    "architecture",
  ]),

  // Codex execution config
  model_tier: z.enum(["mini", "standard", "full", "reasoning"]),
  // Resolved to actual model name from config — never hardcoded in plan
  reasoning_effort: z.enum(["low", "medium", "high", "xhigh"]),

  // Plugin hints — Codex may extend or substitute these
  plugins_hint: z.array(z.string()),

  // Session continuity
  session_mode: z.enum(["stateless", "stateful"]),

  // Subagent strategy hint (verified bridge control not guaranteed)
  subagent_strategy: z.enum(["sequential", "parallel", "auto"]).default("auto"),

  // File access policy
  write_policy: z.enum(["read_only", "workspace_write", "patch_only"]),

  // Claude post-execution role
  claude_after: z.enum([
    "none",
    "judge_only",
    "ui_polish",
    "final_refine",
    "takeover_if_needed",
  ]),

  // What Codex is being asked to achieve
  success_criteria: z.string(),
  architecture_notes: z.string().optional(),

  // Hard budgets (override config defaults)
  max_codex_turns: z.number().optional(),
  max_wall_time_ms: z.number().optional(),
});
```

### Mode defaults

| Mode | write_policy | claude_after | model_tier | reasoning |
|---|---|---|---|---|
| implement | workspace_write | judge_only | standard | medium |
| review | read_only | judge_only | mini | low |
| adversarial_review | read_only | judge_only | full | high |
| debug | workspace_write | judge_only | full | high |
| test_generation | workspace_write | judge_only | standard | medium |
| ui_build | workspace_write | ui_polish | full | medium |
| ui_refine | patch_only | ui_polish | full | medium |
| architecture | read_only | final_refine | full | high |

---

## 5. ExecutionPacket Schema

First-class artifact returned by Codex. Claude Judge works on this, not on prose.

```ts
const executionPacketSchema = z.object({
  status: z.enum(["completed", "partial", "failed", "needs_clarification"]),
  summary: z.string(),                        // what was done
  files_changed: z.array(z.string()),         // relative paths
  commands_run: z.array(z.string()),          // shell commands executed
  tests_run: z.object({
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
    output: z.string().optional(),
  }).optional(),
  diff_summary: z.string().optional(),        // brief human-readable diff
  risks: z.array(z.string()),                 // anything Codex flagged as risky
  unresolved_items: z.array(z.string()),      // TODOs, open questions
  confidence: z.number().min(0).max(1),       // Codex self-assessment
});
```

---

## 6. Claude Judge

Not a boolean gate — a judgment. Receives:
- Original task
- `ExecutionPlan` (what was asked + success criteria + architecture notes)
- `ExecutionPacket` (what Codex did: files, tests, diff, risks, unresolved)
- Full diff output if available

Returns `JudgmentVerdict`:

```ts
const judgmentVerdictSchema = z.object({
  verdict: z.enum(["accept", "repair", "takeover"]),
  score: z.number().min(1).max(10),
  criteria: z.object({
    plan_satisfied: z.boolean(),
    architecture_preserved: z.boolean(),
    tests_meaningful: z.boolean(),
    implementation_clean: z.boolean(),
    ui_needs_polish: z.boolean(),
  }),
  repair_instructions: z.string().optional(),  // if verdict=repair
  takeover_reason: z.string().optional(),       // if verdict=takeover
  polish_notes: z.string().optional(),          // if claude_after=ui_polish/final_refine
});
```

**Judgment prompt covers:**
1. Did Codex satisfy the plan's `success_criteria`?
2. Did it preserve `architecture_notes`?
3. Are tests meaningful (not trivially passing, not missing coverage)?
4. Is implementation clean (no shortcuts, no dead code, matches codebase style)?
5. Does UI work need Sonnet-level polish?
6. Should this be accepted, repaired by Codex, or taken over by Claude?

---

## 7. Repair Loop

- Max 2 rounds
- Each round: inject `repair_instructions` into Codex prompt alongside original task + ExecutionPlan
- Codex returns new ExecutionPacket
- Claude Judge re-evaluates
- After 2 failed repairs → forced `claude-takeover`
- Repair rounds do NOT consume additional `max_claude_calls` budget (Judge is called but counted separately)

---

## 8. Dynamic Model Selection

Dispatcher picks `model_tier`, never a hardcoded model name. Actual names live in `src/delegatecodex/config.ts`:

```ts
export const MODEL_TIERS = {
  mini:      process.env.CODEX_MODEL_MINI      || "gpt-5.4-mini",
  standard:  process.env.CODEX_MODEL_STANDARD  || "gpt-5.4",
  full:      process.env.CODEX_MODEL_FULL      || "gpt-5.5",
  reasoning: process.env.CODEX_MODEL_REASONING || "o4-mini",
} as const;
```

Reasoning effort is also configurable as an override per mode.

---

## 9. Session Management

`session-manager.ts` tracks Codex session IDs keyed by `(conversationId, taskHash)`.

- `stateless` — always fresh invocation, no session file written
- `stateful` — on first run, save session ID; on retry/repair, pass `codex exec resume --last`

Long-running tasks (multi-file refactors, architecture mode, ui_build) default to `stateful`. Quick tasks default to `stateless`.

Session records expire after `max_wall_time_ms` or on server restart.

---

## 10. Plugin Routing

`plugin-router.ts` maps mode + task signals to a suggested plugin list:

| Mode / signal | Default hints |
|---|---|
| ui_build, ui_refine | `browser-use`, `build-web-apps` |
| github mention | `github` |
| architecture | *(none — read-only analysis)* |
| test_generation | *(none — file writes only)* |
| debug with UI | `computer-use`, `browser-use` |

**These are hints only.** Codex may add plugins it deems necessary or substitute equivalents. The bridge does not enforce plugin selection — it passes hints via the prompt.

---

## 11. Compatibility Path

| Route | Runtime |
|---|---|
| `POST /delegatecodex` | v2 (`src/delegatecodex/`) |
| `POST /delegatecodex-old` | v1 (`src/pipeline/`) |
| `POST /pipeline` | v1 (`src/pipeline/`) — unchanged |

Old pipeline code is not deleted. It remains as a comparison baseline.

---

## 12. File Structure (final)

```
src/
├── pipeline/               ← v1, untouched
│   ├── types.ts
│   ├── haiku-classifier.ts
│   ├── sonnet-planner.ts
│   ├── step-executor.ts
│   ├── gate.ts
│   ├── pipeline.ts
│   └── ...
│
├── delegatecodex/          ← v2, new
│   ├── types.ts
│   ├── config.ts
│   ├── dispatcher.ts
│   ├── plugin-router.ts
│   ├── session-manager.ts
│   ├── codex-agent.ts
│   ├── claude-judge.ts
│   ├── repair-loop.ts
│   ├── claude-takeover.ts
│   └── delegatecodex.ts
│
└── server.ts               ← add /delegatecodex (v2) + /delegatecodex-old routes
```

---

## 13. Success Criteria for v2

- `POST /delegatecodex` completes a mechanical task with 0 Claude tool calls (only Codex executes)
- `POST /delegatecodex` completes a multi-file feature with ≤2 Claude calls (1 plan + 1 judge)
- Claude Judge returns `accept` on clean Codex output; `repair` on incomplete output; `takeover` on fundamentally wrong output
- Repair loop fixes broken output in ≤2 rounds on at least 80% of repairable cases
- Model tier selection matches task complexity (mini for trivial, full/reasoning for complex)
- `/delegatecodex-old` still works identically to pre-v2 behavior
- TypeScript build clean (`npx tsc --noEmit`)
- All existing tests pass (`npm test`)
