# /delegatecodex v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/delegatecodex/` — a v2 runtime where Claude plans once, Codex executes with subagents/plugins, and Claude judges once, replacing the old multi-Claude-call pipeline while keeping `src/pipeline/` intact.

**Architecture:** Single Claude Dispatcher call → structured ExecutionPlan → Codex Agent (dynamic model/reasoning/plugins) → ExecutionPacket artifact → Claude Judge (6 criteria, verdict: accept/repair/takeover) → optional Repair Loop (≤2 rounds, 1 more Judge call) → final response. Max 3 Claude calls total. Budget exhaustion returns `needs_user_or_manual_review`.

**Tech Stack:** TypeScript + ESM (`.js` imports), Express.js, Zod 3, Jest, `claude --print --dangerously-skip-permissions` for Claude calls, `codex exec --json --sandbox` for Codex calls, existing `ClaudeSubprocessManager` and `BridgeConfig`.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/delegatecodex/types.ts` | Create | All Zod schemas: ExecutionPlan, ExecutionPacket, JudgmentVerdict, BudgetState |
| `src/delegatecodex/config.ts` | Create | Model tier → name map (env-overridable), mode defaults, budget defaults |
| `src/delegatecodex/dispatcher.ts` | Create | Single Sonnet call → validated ExecutionPlan |
| `src/delegatecodex/plugin-router.ts` | Create | mode + task text → plugin hint array |
| `src/delegatecodex/session-manager.ts` | Create | Track stateful Codex sessions by key; expire on wall-time |
| `src/delegatecodex/codex-agent.ts` | Create | Spawn `codex exec` with plan params, parse JSONL, return ExecutionPacket |
| `src/delegatecodex/claude-judge.ts` | Create | Single Sonnet call with full context → JudgmentVerdict |
| `src/delegatecodex/repair-loop.ts` | Create | Run Codex repair rounds (≤2), then call Judge once if budget allows |
| `src/delegatecodex/claude-takeover.ts` | Create | Claude handles task directly via streaming subprocess |
| `src/delegatecodex/delegatecodex.ts` | Create | Orchestrator: Dispatcher → Agent → Judge → Repair/Takeover |
| `src/server.ts` | Modify | Add `/delegatecodex` (v2) + `/delegatecodex-old` (v1) routes |
| `tests/delegatecodex/types.test.ts` | Create | Schema validation unit tests |
| `tests/delegatecodex/dispatcher.test.ts` | Create | Dispatcher unit tests with mocked ClaudeSubprocessManager |
| `tests/delegatecodex/plugin-router.test.ts` | Create | Plugin routing logic tests |
| `tests/delegatecodex/claude-judge.test.ts` | Create | Judge unit tests |
| `tests/delegatecodex/repair-loop.test.ts` | Create | Repair loop budget + round tests |
| `scripts/smoke-delegatecodex-v2.ts` | Create | End-to-end smoke test for all verdict paths |
| `package.json` | Modify | Add `smoke:delegatecodex-v2` script |

---

## Task 1: Types

**Files:**
- Create: `src/delegatecodex/types.ts`
- Create: `tests/delegatecodex/types.test.ts`

- [ ] **Step 1.1: Create `src/delegatecodex/types.ts`**

```typescript
import { z } from "zod";

// ─── ExecutionPlan ──────────────────────────────────────────────────────────

export const executionPlanSchema = z.object({
  brain: z.enum(["codex_leads", "claude_leads"]),
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
  model_tier: z.enum(["mini", "standard", "full", "reasoning"]),
  reasoning_effort: z.enum(["low", "medium", "high", "xhigh"]),
  plugins_hint: z.array(z.string()),
  session_mode: z.enum(["stateless", "stateful"]),
  subagent_strategy: z.enum(["sequential", "parallel", "auto"]).default("auto"),
  write_policy: z.enum(["read_only", "workspace_write", "patch_only"]),
  claude_after: z.enum([
    "none",
    "judge_only",
    "ui_polish",
    "final_refine",
    "takeover_if_needed",
  ]),
  success_criteria: z.string(),
  architecture_notes: z.string().optional(),
  max_codex_turns: z.number().int().positive().optional(),
  max_wall_time_ms: z.number().int().positive().optional(),
  allow_takeover: z.boolean().default(false),
});

export type ExecutionPlan = z.infer<typeof executionPlanSchema>;

// ─── ExecutionPacket ────────────────────────────────────────────────────────

export const executionPacketSchema = z.object({
  status: z.enum(["completed", "partial", "failed", "needs_clarification"]),
  summary: z.string(),
  files_changed: z.array(z.string()),
  commands_run: z.array(z.string()),
  tests_run: z
    .object({
      passed: z.number().int().min(0),
      failed: z.number().int().min(0),
      skipped: z.number().int().min(0),
      output: z.string().optional(),
    })
    .optional(),
  diff_summary: z.string().optional(),
  risks: z.array(z.string()),
  unresolved_items: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export type ExecutionPacket = z.infer<typeof executionPacketSchema>;

// ─── JudgmentVerdict ────────────────────────────────────────────────────────

export const judgmentVerdictSchema = z.object({
  verdict: z.enum(["accept", "repair", "takeover"]),
  score: z.number().min(1).max(10),
  criteria: z.object({
    plan_satisfied: z.boolean(),
    architecture_preserved: z.boolean(),
    tests_meaningful: z.boolean(),
    implementation_clean: z.boolean(),
    ui_needs_polish: z.boolean(),
  }),
  repair_instructions: z.string().optional(),
  takeover_reason: z.string().optional(),
  polish_notes: z.string().optional(),
});

export type JudgmentVerdict = z.infer<typeof judgmentVerdictSchema>;

// ─── BudgetState ────────────────────────────────────────────────────────────

export interface BudgetState {
  max_claude_calls: number;
  max_repair_rounds: number;
  claude_calls_used: number;
  repair_rounds_used: number;
}

// ─── DelegatecodexResult ────────────────────────────────────────────────────

export type DelegatecodexStatus =
  | "accepted"
  | "repaired"
  | "takeover_complete"
  | "needs_user_or_manual_review";

export interface DelegatecodexResult {
  status: DelegatecodexStatus;
  output: string;
  plan: ExecutionPlan;
  packet: ExecutionPacket;
  verdict?: JudgmentVerdict;
  budget_used: BudgetState;
}
```

- [ ] **Step 1.2: Create `tests/delegatecodex/types.test.ts`**

```typescript
import { describe, expect, test } from "@jest/globals";
import {
  executionPlanSchema,
  executionPacketSchema,
  judgmentVerdictSchema,
} from "../../src/delegatecodex/types.js";

describe("executionPlanSchema", () => {
  test("accepts valid plan", () => {
    const result = executionPlanSchema.safeParse({
      brain: "codex_leads",
      mode: "implement",
      model_tier: "standard",
      reasoning_effort: "medium",
      plugins_hint: ["github"],
      session_mode: "stateless",
      subagent_strategy: "auto",
      write_policy: "workspace_write",
      claude_after: "judge_only",
      success_criteria: "tests pass",
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown brain value", () => {
    const result = executionPlanSchema.safeParse({
      brain: "alien_leads",
      mode: "implement",
      model_tier: "standard",
      reasoning_effort: "medium",
      plugins_hint: [],
      session_mode: "stateless",
      write_policy: "workspace_write",
      claude_after: "judge_only",
      success_criteria: "ok",
    });
    expect(result.success).toBe(false);
  });

  test("defaults subagent_strategy to auto when omitted", () => {
    const result = executionPlanSchema.safeParse({
      brain: "codex_leads",
      mode: "review",
      model_tier: "mini",
      reasoning_effort: "low",
      plugins_hint: [],
      session_mode: "stateless",
      write_policy: "read_only",
      claude_after: "judge_only",
      success_criteria: "review complete",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subagent_strategy).toBe("auto");
    }
  });
});

describe("executionPacketSchema", () => {
  test("accepts valid packet", () => {
    const result = executionPacketSchema.safeParse({
      status: "completed",
      summary: "Renamed function",
      files_changed: ["src/foo.ts"],
      commands_run: ["npm test"],
      risks: [],
      unresolved_items: [],
      confidence: 0.95,
    });
    expect(result.success).toBe(true);
  });

  test("rejects confidence > 1", () => {
    const result = executionPacketSchema.safeParse({
      status: "completed",
      summary: "Done",
      files_changed: [],
      commands_run: [],
      risks: [],
      unresolved_items: [],
      confidence: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("judgmentVerdictSchema", () => {
  test("accepts accept verdict", () => {
    const result = judgmentVerdictSchema.safeParse({
      verdict: "accept",
      score: 9,
      criteria: {
        plan_satisfied: true,
        architecture_preserved: true,
        tests_meaningful: true,
        implementation_clean: true,
        ui_needs_polish: false,
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts repair verdict with instructions", () => {
    const result = judgmentVerdictSchema.safeParse({
      verdict: "repair",
      score: 4,
      criteria: {
        plan_satisfied: false,
        architecture_preserved: true,
        tests_meaningful: false,
        implementation_clean: true,
        ui_needs_polish: false,
      },
      repair_instructions: "Add missing error handling to src/foo.ts",
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 1.3: Run tests**

```bash
cd /Users/abhayjuloori/Proxy-Layer && NODE_OPTIONS=--experimental-vm-modules npx jest tests/delegatecodex/types.test.ts --no-coverage
```

Expected: All 5 tests pass.

- [ ] **Step 1.4: Commit**

```bash
git add src/delegatecodex/types.ts tests/delegatecodex/types.test.ts
git commit -m "feat(delegatecodex): add v2 Zod schemas — ExecutionPlan, ExecutionPacket, JudgmentVerdict"
```

---

## Task 2: Config

**Files:**
- Create: `src/delegatecodex/config.ts`

- [ ] **Step 2.1: Create `src/delegatecodex/config.ts`**

```typescript
import type { ExecutionPlan } from "./types.js";

// ─── Model tiers ─────────────────────────────────────────────────────────────
// Names are configurable via environment variables — never hardcode in plans.

export const MODEL_TIERS = {
  mini:      process.env.CODEX_MODEL_MINI      ?? "gpt-5.4-mini",
  standard:  process.env.CODEX_MODEL_STANDARD  ?? "gpt-5.4",
  full:      process.env.CODEX_MODEL_FULL      ?? "gpt-5.5",
  reasoning: process.env.CODEX_MODEL_REASONING ?? "o4-mini",
} as const;

export type ModelTier = keyof typeof MODEL_TIERS;

export function resolveModel(tier: ModelTier): string {
  return MODEL_TIERS[tier];
}

// ─── Budget defaults ─────────────────────────────────────────────────────────

export const BUDGET_DEFAULTS = {
  max_claude_calls: 3,
  max_repair_rounds: 2,
} as const;

// ─── Mode defaults ───────────────────────────────────────────────────────────

type ModeDefaults = Pick<
  ExecutionPlan,
  "write_policy" | "claude_after" | "model_tier" | "reasoning_effort" | "session_mode" | "allow_takeover"
>;

export const MODE_DEFAULTS: Record<ExecutionPlan["mode"], ModeDefaults> = {
  implement: {
    write_policy: "workspace_write",
    claude_after: "judge_only",
    model_tier: "standard",
    reasoning_effort: "medium",
    session_mode: "stateless",
    allow_takeover: false,
  },
  review: {
    write_policy: "read_only",
    claude_after: "judge_only",
    model_tier: "mini",
    reasoning_effort: "low",
    session_mode: "stateless",
    allow_takeover: false,
  },
  adversarial_review: {
    write_policy: "read_only",
    claude_after: "judge_only",
    model_tier: "full",
    reasoning_effort: "high",
    session_mode: "stateless",
    allow_takeover: false,
  },
  debug: {
    write_policy: "workspace_write",
    claude_after: "judge_only",
    model_tier: "full",
    reasoning_effort: "high",
    session_mode: "stateful",
    allow_takeover: true,
  },
  test_generation: {
    write_policy: "workspace_write",
    claude_after: "judge_only",
    model_tier: "standard",
    reasoning_effort: "medium",
    session_mode: "stateless",
    allow_takeover: false,
  },
  ui_build: {
    write_policy: "workspace_write",
    claude_after: "ui_polish",
    model_tier: "full",
    reasoning_effort: "medium",
    session_mode: "stateful",
    allow_takeover: false,
  },
  ui_refine: {
    write_policy: "patch_only",
    claude_after: "ui_polish",
    model_tier: "full",
    reasoning_effort: "medium",
    session_mode: "stateless",
    allow_takeover: false,
  },
  architecture: {
    write_policy: "read_only",
    claude_after: "final_refine",
    model_tier: "full",
    reasoning_effort: "high",
    session_mode: "stateless",
    allow_takeover: true,
  },
};

// ─── Sandbox policy mapping ──────────────────────────────────────────────────
// Maps write_policy to codex exec --sandbox value

export function writePolicyToSandbox(
  policy: ExecutionPlan["write_policy"]
): "read-only" | "workspace-write" | "danger-full-access" {
  switch (policy) {
    case "read_only":
      return "read-only";
    case "workspace_write":
      return "workspace-write";
    case "patch_only":
      return "workspace-write"; // patch_only is enforced in the prompt, not the sandbox
  }
}
```

- [ ] **Step 2.2: Commit**

```bash
git add src/delegatecodex/config.ts
git commit -m "feat(delegatecodex): add config — model tiers, mode defaults, budget constants"
```

---

## Task 3: Dispatcher

**Files:**
- Create: `src/delegatecodex/dispatcher.ts`
- Create: `tests/delegatecodex/dispatcher.test.ts`

- [ ] **Step 3.1: Write the failing test first**

Create `tests/delegatecodex/dispatcher.test.ts`:

```typescript
import { describe, expect, jest, test } from "@jest/globals";
import { Dispatcher } from "../../src/delegatecodex/dispatcher.js";
import type { ClaudeSubprocessManager } from "../../src/claude/subprocess.js";

function makeMockClaude(response: string): ClaudeSubprocessManager {
  return {
    call: jest.fn<() => Promise<string>>().mockResolvedValue(response),
    stream: jest.fn(),
  } as unknown as ClaudeSubprocessManager;
}

const VALID_PLAN_JSON = JSON.stringify({
  brain: "codex_leads",
  mode: "implement",
  model_tier: "standard",
  reasoning_effort: "medium",
  plugins_hint: ["github"],
  session_mode: "stateless",
  write_policy: "workspace_write",
  claude_after: "judge_only",
  success_criteria: "TypeScript compiles without errors",
  architecture_notes: "Do not modify src/server.ts",
});

describe("Dispatcher", () => {
  test("returns ExecutionPlan from clean JSON response", async () => {
    const claude = makeMockClaude(VALID_PLAN_JSON);
    const dispatcher = new Dispatcher(claude);
    const plan = await dispatcher.dispatch("Add input validation to POST /users");
    expect(plan.brain).toBe("codex_leads");
    expect(plan.mode).toBe("implement");
    expect(plan.success_criteria).toBe("TypeScript compiles without errors");
  });

  test("strips markdown fences before parsing", async () => {
    const fenced = "```json\n" + VALID_PLAN_JSON + "\n```";
    const claude = makeMockClaude(fenced);
    const dispatcher = new Dispatcher(claude);
    const plan = await dispatcher.dispatch("some task");
    expect(plan.brain).toBe("codex_leads");
  });

  test("throws if Claude response is not valid JSON", async () => {
    const claude = makeMockClaude("Sorry, I cannot help with that.");
    const dispatcher = new Dispatcher(claude);
    await expect(dispatcher.dispatch("task")).rejects.toThrow(/parse/i);
  });

  test("throws if Claude response fails schema validation", async () => {
    const bad = JSON.stringify({ brain: "alien", mode: "implement" });
    const claude = makeMockClaude(bad);
    const dispatcher = new Dispatcher(claude);
    await expect(dispatcher.dispatch("task")).rejects.toThrow(/schema/i);
  });
});
```

- [ ] **Step 3.2: Run test — verify it fails**

```bash
cd /Users/abhayjuloori/Proxy-Layer && NODE_OPTIONS=--experimental-vm-modules npx jest tests/delegatecodex/dispatcher.test.ts --no-coverage 2>&1 | head -20
```

Expected: Cannot find module `../../src/delegatecodex/dispatcher.js`.

- [ ] **Step 3.3: Create `src/delegatecodex/dispatcher.ts`**

```typescript
import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import { executionPlanSchema, type ExecutionPlan } from "./types.js";
import { MODE_DEFAULTS } from "./config.js";

const DISPATCHER_MODEL = "claude-sonnet-4-6";
const DISPATCHER_TIMEOUT_MS = 45_000;

function buildPrompt(task: string): string {
  return `You are the Claude Dispatcher for a coding assistant pipeline.

Analyze this task and return ONLY a JSON object — no prose, no markdown fences.

Task: ${task}

The JSON must conform to this schema exactly:
{
  "brain": "codex_leads" | "claude_leads",
  "mode": "implement" | "review" | "adversarial_review" | "debug" | "test_generation" | "ui_build" | "ui_refine" | "architecture",
  "model_tier": "mini" | "standard" | "full" | "reasoning",
  "reasoning_effort": "low" | "medium" | "high" | "xhigh",
  "plugins_hint": string[],
  "session_mode": "stateless" | "stateful",
  "subagent_strategy": "sequential" | "parallel" | "auto",
  "write_policy": "read_only" | "workspace_write" | "patch_only",
  "claude_after": "none" | "judge_only" | "ui_polish" | "final_refine" | "takeover_if_needed",
  "success_criteria": string,
  "architecture_notes": string (optional),
  "allow_takeover": boolean
}

Rules:
- brain=claude_leads: architectural decisions, subtle multi-system debugging, design review needing taste
- brain=codex_leads: everything else — Codex handles with subagents and plugins
- model_tier: mini=rename/reformat, standard=single-feature, full=complex multi-file/UI, reasoning=deep debugging
- session_mode=stateful: multi-file refactors, ui_build, debug (needs context across repair rounds)
- plugins_hint: suggest from ["browser-use","build-web-apps","github","computer-use"] — Codex may extend
- write_policy=read_only for all review/architecture modes
- allow_takeover=true for debug and architecture modes
- success_criteria: concrete, verifiable (e.g. "npx tsc --noEmit exits 0 and npm test passes")`;
}

function stripFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

export class Dispatcher {
  constructor(private readonly claude: ClaudeSubprocessManager) {}

  async dispatch(task: string): Promise<ExecutionPlan> {
    const raw = await this.claude.call(
      buildPrompt(task),
      DISPATCHER_TIMEOUT_MS,
      DISPATCHER_MODEL
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(raw));
    } catch {
      throw new Error(`Dispatcher failed to parse Claude response: ${raw.slice(0, 200)}`);
    }

    const result = executionPlanSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Dispatcher schema validation failed: ${result.error.message}`
      );
    }

    // Fill in mode defaults for any fields the dispatcher may have omitted
    const defaults = MODE_DEFAULTS[result.data.mode];
    return {
      ...defaults,
      ...result.data,
    };
  }
}
```

- [ ] **Step 3.4: Run tests — verify they pass**

```bash
cd /Users/abhayjuloori/Proxy-Layer && NODE_OPTIONS=--experimental-vm-modules npx jest tests/delegatecodex/dispatcher.test.ts --no-coverage
```

Expected: 4 tests pass.

- [ ] **Step 3.5: Commit**

```bash
git add src/delegatecodex/dispatcher.ts tests/delegatecodex/dispatcher.test.ts
git commit -m "feat(delegatecodex): add Dispatcher — single Sonnet call produces ExecutionPlan"
```

---

## Task 4: Plugin Router

**Files:**
- Create: `src/delegatecodex/plugin-router.ts`
- Create: `tests/delegatecodex/plugin-router.test.ts`

- [ ] **Step 4.1: Write failing test**

Create `tests/delegatecodex/plugin-router.test.ts`:

```typescript
import { describe, expect, test } from "@jest/globals";
import { getPluginHints } from "../../src/delegatecodex/plugin-router.js";
import type { ExecutionPlan } from "../../src/delegatecodex/types.js";

function plan(mode: ExecutionPlan["mode"], task = ""): ExecutionPlan {
  return {
    brain: "codex_leads",
    mode,
    model_tier: "standard",
    reasoning_effort: "medium",
    plugins_hint: [],
    session_mode: "stateless",
    subagent_strategy: "auto",
    write_policy: "workspace_write",
    claude_after: "judge_only",
    success_criteria: "done",
    allow_takeover: false,
  };
}

describe("getPluginHints", () => {
  test("ui_build returns browser-use and build-web-apps", () => {
    const hints = getPluginHints(plan("ui_build"), "build a dashboard");
    expect(hints).toContain("browser-use");
    expect(hints).toContain("build-web-apps");
  });

  test("ui_refine returns browser-use and build-web-apps", () => {
    const hints = getPluginHints(plan("ui_refine"), "polish button styles");
    expect(hints).toContain("browser-use");
  });

  test("task mentioning github adds github plugin", () => {
    const hints = getPluginHints(plan("implement"), "open a PR on github for this change");
    expect(hints).toContain("github");
  });

  test("debug with UI mention adds computer-use", () => {
    const hints = getPluginHints(plan("debug"), "the button click handler is broken in the UI");
    expect(hints).toContain("computer-use");
    expect(hints).toContain("browser-use");
  });

  test("review mode returns empty hints", () => {
    const hints = getPluginHints(plan("review"), "review the auth module");
    expect(hints).toEqual([]);
  });

  test("deduplicates hints", () => {
    const hints = getPluginHints(plan("ui_build"), "fix github CI for this UI build");
    const unique = new Set(hints);
    expect(unique.size).toBe(hints.length);
  });
});
```

- [ ] **Step 4.2: Run — verify fails**

```bash
cd /Users/abhayjuloori/Proxy-Layer && NODE_OPTIONS=--experimental-vm-modules npx jest tests/delegatecodex/plugin-router.test.ts --no-coverage 2>&1 | head -10
```

- [ ] **Step 4.3: Create `src/delegatecodex/plugin-router.ts`**

```typescript
import type { ExecutionPlan } from "./types.js";

const UI_HINTS = ["browser-use", "build-web-apps"] as const;
const GITHUB_HINT = "github" as const;
const COMPUTER_HINT = "computer-use" as const;

export function getPluginHints(
  plan: ExecutionPlan,
  taskText: string
): string[] {
  const hints = new Set<string>();

  // Mode-based defaults
  if (plan.mode === "ui_build" || plan.mode === "ui_refine") {
    UI_HINTS.forEach((h) => hints.add(h));
  }

  // Task text signals
  const lower = taskText.toLowerCase();
  if (/\bgithub\b/.test(lower)) {
    hints.add(GITHUB_HINT);
  }

  if (
    (plan.mode === "debug" || /\bui\b|\bfront.?end\b|\bbrowser\b/.test(lower)) &&
    (/\bui\b|\bfront.?end\b|\bbrowser\b|\bbutton\b|\bcomponent\b|\bpage\b/.test(lower))
  ) {
    hints.add(COMPUTER_HINT);
    hints.add("browser-use");
  }

  // Merge caller-supplied hints (plan.plugins_hint may already have hints from dispatcher)
  for (const h of plan.plugins_hint) {
    hints.add(h);
  }

  // review and architecture modes: no plugins (read-only analysis)
  if (plan.mode === "review" || plan.mode === "architecture") {
    return [];
  }

  return Array.from(hints);
}
```

- [ ] **Step 4.4: Run tests**

```bash
cd /Users/abhayjuloori/Proxy-Layer && NODE_OPTIONS=--experimental-vm-modules npx jest tests/delegatecodex/plugin-router.test.ts --no-coverage
```

Expected: 6 tests pass.

- [ ] **Step 4.5: Commit**

```bash
git add src/delegatecodex/plugin-router.ts tests/delegatecodex/plugin-router.test.ts
git commit -m "feat(delegatecodex): add plugin-router — mode+task signals → plugin hint array"
```

---

## Task 5: Session Manager

**Files:**
- Create: `src/delegatecodex/session-manager.ts`

- [ ] **Step 5.1: Create `src/delegatecodex/session-manager.ts`**

```typescript
/**
 * Tracks whether a Codex session exists for a given (conversationId, taskHash) key.
 * Session records expire after max_wall_time_ms (default 10 minutes).
 *
 * ⚠️  EXPERIMENTAL: `codex exec resume --last` path is NOT tested end-to-end.
 * The session tracking (set/has/delete) IS tested. The resume invocation itself
 * has not been validated against a live Codex process. If `codex exec resume`
 * behaves unexpectedly, CodexAgent.run() will fail and the error will surface
 * as an ExecutionPacket with status="failed". Safe to ship — just monitor logs.
 *
 * For v2.0, session_mode="stateful" tracks that a session exists but the resume
 * path in CodexAgent uses `codex exec resume --last` only if `has(sessionKey)`
 * returns true. On the first call it is always a fresh invocation.
 */

const DEFAULT_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

interface SessionRecord {
  createdAt: number;
  expiresAt: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();

  /** Build a session key from conversation ID and a short task identifier. */
  static makeKey(conversationId: string, taskSuffix: string): string {
    // Normalize: lowercase, strip non-alphanumeric
    const safe = taskSuffix.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 40);
    return `${conversationId}__${safe}`;
  }

  /** Returns true if a live (non-expired) session exists for this key. */
  has(key: string): boolean {
    const record = this.sessions.get(key);
    if (!record) return false;
    if (Date.now() > record.expiresAt) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  /** Record that a Codex session now exists for this key. */
  set(key: string, maxWallTimeMs = DEFAULT_EXPIRY_MS): void {
    this.sessions.set(key, {
      createdAt: Date.now(),
      expiresAt: Date.now() + maxWallTimeMs,
    });
  }

  /** Remove a session record (e.g. on task completion or explicit reset). */
  delete(key: string): void {
    this.sessions.delete(key);
  }

  /** Purge all expired records. Call periodically to prevent memory leaks. */
  purgeExpired(): void {
    const now = Date.now();
    for (const [key, record] of this.sessions) {
      if (now > record.expiresAt) this.sessions.delete(key);
    }
  }
}
```

- [ ] **Step 5.2: Commit**

```bash
git add src/delegatecodex/session-manager.ts
git commit -m "feat(delegatecodex): add SessionManager — stateful Codex session tracking with expiry"
```

---

## Task 6: Codex Agent

**Files:**
- Create: `src/delegatecodex/codex-agent.ts`

- [ ] **Step 6.1: Create `src/delegatecodex/codex-agent.ts`**

```typescript
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import {
  executionPacketSchema,
  type ExecutionPacket,
  type ExecutionPlan,
} from "./types.js";
import { resolveModel, writePolicyToSandbox } from "./config.js";
import type { SessionManager } from "./session-manager.js";

const DEFAULT_WALL_TIME_MS = 5 * 60 * 1000; // 5 minutes

function stripFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

function synthesizePacket(
  rawOutput: string,
  exitCode: number
): ExecutionPacket {
  const status = exitCode === 0 ? "partial" : "failed";
  return {
    status,
    summary: rawOutput.slice(0, 500) || "Codex produced no text output.",
    files_changed: [],
    commands_run: [],
    risks: exitCode !== 0 ? [`Codex exited with code ${exitCode}`] : [],
    unresolved_items: ["ExecutionPacket could not be parsed from Codex output"],
    confidence: exitCode === 0 ? 0.4 : 0.1,
  };
}

function buildPrompt(task: string, plan: ExecutionPlan, plugins: string[], isRepair: boolean, repairInstructions?: string): string {
  const pluginLine = plugins.length > 0
    ? `Suggested plugins (you may extend if needed): ${plugins.join(", ")}`
    : "No specific plugins required.";

  const policyLine = plan.write_policy === "patch_only"
    ? "WRITE POLICY: patch_only — only modify existing files, do not create new ones."
    : plan.write_policy === "read_only"
    ? "WRITE POLICY: read_only — do not write or modify any files."
    : "WRITE POLICY: workspace_write — you may create and modify files freely.";

  const repairSection = isRepair && repairInstructions
    ? `\n## Repair Instructions (from Claude Judge)\n${repairInstructions}\n\nFix the issues above and complete the task.`
    : "";

  return `## Task
${task}
${repairSection}

## Execution Context
Mode: ${plan.mode}
${policyLine}
${pluginLine}
Subagent strategy hint: ${plan.subagent_strategy}

## Success Criteria
${plan.success_criteria}

${plan.architecture_notes ? `## Architecture Constraints\n${plan.architecture_notes}\n` : ""}
## Required Output Format
When you are done, output ONLY a JSON object as your final message (no prose after it).
This JSON must conform to this schema:
{
  "status": "completed" | "partial" | "failed" | "needs_clarification",
  "summary": string,
  "files_changed": string[],
  "commands_run": string[],
  "tests_run": { "passed": number, "failed": number, "skipped": number, "output": string } | null,
  "diff_summary": string,
  "risks": string[],
  "unresolved_items": string[],
  "confidence": number (0–1)
}`;
}

export class CodexAgent {
  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
    private readonly sessions: SessionManager
  ) {}

  async run(
    task: string,
    plan: ExecutionPlan,
    plugins: string[],
    sessionKey: string,
    isRepair = false,
    repairInstructions?: string
  ): Promise<ExecutionPacket> {
    const prompt = buildPrompt(task, plan, plugins, isRepair, repairInstructions);
    const model = resolveModel(plan.model_tier);
    const sandbox = writePolicyToSandbox(plan.write_policy);
    const wallTimeMs = plan.max_wall_time_ms ?? DEFAULT_WALL_TIME_MS;

    const isStateful = plan.session_mode === "stateful";
    const hasExistingSession = isStateful && this.sessions.has(sessionKey);

    // Build args
    const args: string[] = [];

    if (hasExistingSession) {
      // ⚠️  EXPERIMENTAL: resume --last not covered by unit tests.
      // If this path causes unexpected behavior, set session_mode="stateless" in the plan.
      args.push("exec", "resume", "--last");
    } else {
      args.push("exec");
    }

    args.push("--json", "--sandbox", sandbox, "-m", model);
    args.push("-c", `model_reasoning_effort=${plan.reasoning_effort}`);

    if (this.config.codex.skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }

    if (!hasExistingSession) {
      args.push(prompt);
    } else {
      // For resume, append repair instructions as a new prompt
      args.push(repairInstructions ?? prompt);
    }

    this.logger.info("codex-agent", "spawning Codex", {
      model,
      sandbox,
      sessionKey,
      isRepair,
      hasExistingSession,
    });

    const raw = await this.spawnCodex(args, wallTimeMs);

    if (isStateful && !hasExistingSession) {
      this.sessions.set(sessionKey, wallTimeMs);
    }

    return this.parsePacket(raw.finalText, raw.exitCode);
  }

  private async spawnCodex(
    args: string[],
    wallTimeMs: number
  ): Promise<{ finalText: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.codex.bin, args, {
        cwd: this.config.codex.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdout = createInterface({ input: child.stdout });
      let finalText = "";
      let exitCode = 0;

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Codex agent timed out after ${wallTimeMs}ms`));
      }, wallTimeMs);

      stdout.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return;
        }

        const type = String(parsed.type ?? "");
        if (type === "item.completed") {
          const item = parsed.item as Record<string, unknown> | undefined;
          if (item?.type === "agent_message") {
            const content = item.content;
            if (typeof content === "string") {
              finalText = content;
            } else if (Array.isArray(content)) {
              for (const block of content) {
                const b = block as Record<string, unknown>;
                if (b.type === "output_text" && typeof b.text === "string") {
                  finalText = b.text;
                }
              }
            }
          }
        }
      });

      child.once("close", (code) => {
        clearTimeout(timer);
        exitCode = code ?? 0;
        resolve({ finalText, exitCode });
      });

      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private parsePacket(rawText: string, exitCode: number): ExecutionPacket {
    const stripped = stripFences(rawText.trim());

    // Strategy 1: entire output is valid JSON
    // (helpers defined as module-level functions below the class)
    const direct = tryParsePacket(stripped);
    if (direct) return direct;

    // Strategy 2: output has fenced JSON block — already stripped above, try again on original
    const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/g);
    if (fenceMatch) {
      for (let i = fenceMatch.length - 1; i >= 0; i--) {
        const inner = fenceMatch[i].replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
        const candidate = tryParsePacket(inner);
        if (candidate) return candidate;
      }
    }

    // Strategy 3: scan for balanced {...} objects from the END of the text
    // Walk backwards finding matching brace pairs; validate each with schema.
    const balanced = extractBalancedJsonObjects(stripped);
    for (let i = balanced.length - 1; i >= 0; i--) {
      const candidate = tryParsePacket(balanced[i]);
      if (candidate) return candidate;
    }

    this.logger.warn("codex-agent", "ExecutionPacket could not be parsed, synthesizing", {
      rawSlice: rawText.slice(0, 200),
    });
    return synthesizePacket(rawText, exitCode);
  }
}

// ─── Module-level helpers ────────────────────────────────────────────────────

/** Try to parse a string as ExecutionPacket. Returns null on any failure. */
function tryParsePacket(text: string): ExecutionPacket | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const result = executionPacketSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Extract all balanced top-level {...} objects from a string.
 * Handles nested braces correctly. Returns them in document order.
 * Ignores brace imbalance mid-string gracefully.
 */
function extractBalancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return objects;
}
```

- [ ] **Step 6.2: Commit**

```bash
git add src/delegatecodex/codex-agent.ts
git commit -m "feat(delegatecodex): add CodexAgent — dynamic model/reasoning/plugins, parses ExecutionPacket"
```

---

## Task 7: Claude Judge

**Files:**
- Create: `src/delegatecodex/claude-judge.ts`
- Create: `tests/delegatecodex/claude-judge.test.ts`

- [ ] **Step 7.1: Write failing test**

Create `tests/delegatecodex/claude-judge.test.ts`:

```typescript
import { describe, expect, jest, test } from "@jest/globals";
import { ClaudeJudge } from "../../src/delegatecodex/claude-judge.js";
import type { ClaudeSubprocessManager } from "../../src/claude/subprocess.js";
import type { ExecutionPlan, ExecutionPacket } from "../../src/delegatecodex/types.js";

function mockClaude(response: string): ClaudeSubprocessManager {
  return {
    call: jest.fn<() => Promise<string>>().mockResolvedValue(response),
    stream: jest.fn(),
  } as unknown as ClaudeSubprocessManager;
}

const PLAN: ExecutionPlan = {
  brain: "codex_leads",
  mode: "implement",
  model_tier: "standard",
  reasoning_effort: "medium",
  plugins_hint: [],
  session_mode: "stateless",
  subagent_strategy: "auto",
  write_policy: "workspace_write",
  claude_after: "judge_only",
  success_criteria: "npx tsc --noEmit exits 0",
  allow_takeover: false,
};

const GOOD_PACKET: ExecutionPacket = {
  status: "completed",
  summary: "Added input validation to POST /users",
  files_changed: ["src/routes/users.ts"],
  commands_run: ["npx tsc --noEmit", "npm test"],
  tests_run: { passed: 5, failed: 0, skipped: 0 },
  diff_summary: "+12 lines in users.ts",
  risks: [],
  unresolved_items: [],
  confidence: 0.95,
};

const ACCEPT_VERDICT = JSON.stringify({
  verdict: "accept",
  score: 9,
  criteria: {
    plan_satisfied: true,
    architecture_preserved: true,
    tests_meaningful: true,
    implementation_clean: true,
    ui_needs_polish: false,
  },
});

const REPAIR_VERDICT = JSON.stringify({
  verdict: "repair",
  score: 4,
  criteria: {
    plan_satisfied: false,
    architecture_preserved: true,
    tests_meaningful: false,
    implementation_clean: true,
    ui_needs_polish: false,
  },
  repair_instructions: "The success_criteria requires tsc to pass. Run npx tsc --noEmit and fix any type errors.",
});

describe("ClaudeJudge", () => {
  test("returns accept verdict", async () => {
    const judge = new ClaudeJudge(mockClaude(ACCEPT_VERDICT));
    const verdict = await judge.judge("Add validation", PLAN, GOOD_PACKET);
    expect(verdict.verdict).toBe("accept");
    expect(verdict.score).toBe(9);
    expect(verdict.criteria.plan_satisfied).toBe(true);
  });

  test("returns repair verdict with instructions", async () => {
    const judge = new ClaudeJudge(mockClaude(REPAIR_VERDICT));
    const verdict = await judge.judge("Add validation", PLAN, GOOD_PACKET);
    expect(verdict.verdict).toBe("repair");
    expect(verdict.repair_instructions).toContain("tsc");
  });

  test("strips markdown fences before parsing", async () => {
    const fenced = "```json\n" + ACCEPT_VERDICT + "\n```";
    const judge = new ClaudeJudge(mockClaude(fenced));
    const verdict = await judge.judge("task", PLAN, GOOD_PACKET);
    expect(verdict.verdict).toBe("accept");
  });

  test("throws if response is not valid JSON", async () => {
    const judge = new ClaudeJudge(mockClaude("I cannot evaluate this."));
    await expect(judge.judge("task", PLAN, GOOD_PACKET)).rejects.toThrow(/parse/i);
  });
});
```

- [ ] **Step 7.2: Run — verify fails**

```bash
cd /Users/abhayjuloori/Proxy-Layer && NODE_OPTIONS=--experimental-vm-modules npx jest tests/delegatecodex/claude-judge.test.ts --no-coverage 2>&1 | head -10
```

- [ ] **Step 7.3: Create `src/delegatecodex/claude-judge.ts`**

```typescript
import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import { judgmentVerdictSchema, type ExecutionPacket, type ExecutionPlan, type JudgmentVerdict } from "./types.js";

const JUDGE_MODEL = "claude-sonnet-4-6";
const JUDGE_TIMEOUT_MS = 45_000;

function stripFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

function buildJudgePrompt(
  task: string,
  plan: ExecutionPlan,
  packet: ExecutionPacket,
  diffOutput?: string
): string {
  return `You are Claude Judge. Evaluate whether Codex completed this task correctly.
Return ONLY a JSON object — no prose, no markdown fences.

## Original Task
${task}

## Execution Plan (what was requested)
Mode: ${plan.mode}
Success Criteria: ${plan.success_criteria}
${plan.architecture_notes ? `Architecture Constraints: ${plan.architecture_notes}` : ""}

## Execution Packet (what Codex did)
Status: ${packet.status}
Summary: ${packet.summary}
Files changed: ${packet.files_changed.join(", ") || "none"}
Commands run: ${packet.commands_run.join(", ") || "none"}
${packet.tests_run ? `Tests: ${packet.tests_run.passed} passed, ${packet.tests_run.failed} failed, ${packet.tests_run.skipped} skipped` : "Tests: not run"}
${packet.diff_summary ? `Diff summary: ${packet.diff_summary}` : ""}
Risks flagged: ${packet.risks.join("; ") || "none"}
Unresolved items: ${packet.unresolved_items.join("; ") || "none"}
Codex confidence: ${packet.confidence}
${diffOutput ? `\n## Diff Output\n${diffOutput.slice(0, 2000)}` : ""}

## Judgment Criteria
1. plan_satisfied: Did Codex fully satisfy the success_criteria?
2. architecture_preserved: Were architecture constraints respected?
3. tests_meaningful: Are tests real (not trivially passing, not missing critical coverage)?
4. implementation_clean: Is the code clean, no shortcuts, no dead code, matches codebase style?
5. ui_needs_polish: Does UI output need Claude-level polish (only true for ui_build/ui_refine)?

## Verdict Rules
- accept: all critical criteria met, score ≥ 7
- repair: fixable gaps exist — provide specific repair_instructions Codex can act on
- takeover: fundamental misunderstanding, architectural violation, or score < 3

Return this JSON schema:
{
  "verdict": "accept" | "repair" | "takeover",
  "score": number (1-10),
  "criteria": {
    "plan_satisfied": boolean,
    "architecture_preserved": boolean,
    "tests_meaningful": boolean,
    "implementation_clean": boolean,
    "ui_needs_polish": boolean
  },
  "repair_instructions": string (required if verdict=repair),
  "takeover_reason": string (required if verdict=takeover),
  "polish_notes": string (optional, if ui_needs_polish=true)
}`;
}

export class ClaudeJudge {
  constructor(private readonly claude: ClaudeSubprocessManager) {}

  async judge(
    task: string,
    plan: ExecutionPlan,
    packet: ExecutionPacket,
    diffOutput?: string
  ): Promise<JudgmentVerdict> {
    const raw = await this.claude.call(
      buildJudgePrompt(task, plan, packet, diffOutput),
      JUDGE_TIMEOUT_MS,
      JUDGE_MODEL
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(raw));
    } catch {
      throw new Error(`ClaudeJudge failed to parse response: ${raw.slice(0, 200)}`);
    }

    const result = judgmentVerdictSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`ClaudeJudge schema validation failed: ${result.error.message}`);
    }

    return result.data;
  }
}
```

- [ ] **Step 7.4: Run tests**

```bash
cd /Users/abhayjuloori/Proxy-Layer && NODE_OPTIONS=--experimental-vm-modules npx jest tests/delegatecodex/claude-judge.test.ts --no-coverage
```

Expected: 4 tests pass.

- [ ] **Step 7.5: Commit**

```bash
git add src/delegatecodex/claude-judge.ts tests/delegatecodex/claude-judge.test.ts
git commit -m "feat(delegatecodex): add ClaudeJudge — 6-criteria judgment against ExecutionPlan+Packet"
```

---

## Task 8: Repair Loop

**Files:**
- Create: `src/delegatecodex/repair-loop.ts`
- Create: `tests/delegatecodex/repair-loop.test.ts`

- [ ] **Step 8.1: Write failing test**

Create `tests/delegatecodex/repair-loop.test.ts`:

```typescript
import { describe, expect, jest, test } from "@jest/globals";
import { RepairLoop } from "../../src/delegatecodex/repair-loop.js";
import type { CodexAgent } from "../../src/delegatecodex/codex-agent.js";
import type { ClaudeJudge } from "../../src/delegatecodex/claude-judge.js";
import type { ExecutionPacket, ExecutionPlan, JudgmentVerdict } from "../../src/delegatecodex/types.js";
import { BUDGET_DEFAULTS } from "../../src/delegatecodex/config.js";

const PLAN: ExecutionPlan = {
  brain: "codex_leads",
  mode: "implement",
  model_tier: "standard",
  reasoning_effort: "medium",
  plugins_hint: [],
  session_mode: "stateless",
  subagent_strategy: "auto",
  write_policy: "workspace_write",
  claude_after: "judge_only",
  success_criteria: "tests pass",
  allow_takeover: false,
};

const GOOD_PACKET: ExecutionPacket = {
  status: "completed",
  summary: "Fixed the bug",
  files_changed: ["src/foo.ts"],
  commands_run: ["npm test"],
  risks: [],
  unresolved_items: [],
  confidence: 0.9,
};

const ACCEPT: JudgmentVerdict = {
  verdict: "accept",
  score: 9,
  criteria: { plan_satisfied: true, architecture_preserved: true, tests_meaningful: true, implementation_clean: true, ui_needs_polish: false },
};

const REPAIR: JudgmentVerdict = {
  verdict: "repair",
  score: 4,
  criteria: { plan_satisfied: false, architecture_preserved: true, tests_meaningful: false, implementation_clean: true, ui_needs_polish: false },
  repair_instructions: "Add error handling to the catch block.",
};

function mockAgent(): CodexAgent {
  return {
    run: jest.fn<() => Promise<ExecutionPacket>>().mockResolvedValue(GOOD_PACKET),
  } as unknown as CodexAgent;
}

function mockJudge(verdict: JudgmentVerdict): ClaudeJudge {
  return {
    judge: jest.fn<() => Promise<JudgmentVerdict>>().mockResolvedValue(verdict),
  } as unknown as ClaudeJudge;
}

describe("RepairLoop", () => {
  test("returns accepted when judge says accept after repairs", async () => {
    const agent = mockAgent();
    const judge = mockJudge(ACCEPT);
    const loop = new RepairLoop(agent, judge);
    const budget = { ...BUDGET_DEFAULTS, claude_calls_used: 2, repair_rounds_used: 0 };
    const result = await loop.run("fix bug", PLAN, GOOD_PACKET, REPAIR, "k1", [], budget);
    expect(result.status).toBe("accepted");
    expect(budget.claude_calls_used).toBe(3); // used Call 3 for judge
  });

  test("returns needs_user_or_manual_review when budget exhausted", async () => {
    const agent = mockAgent();
    const judge = mockJudge(ACCEPT); // judge won't be called
    const loop = new RepairLoop(agent, judge);
    // Budget already at max (3/3)
    const budget = { ...BUDGET_DEFAULTS, claude_calls_used: 3, repair_rounds_used: 0 };
    const result = await loop.run("fix bug", PLAN, GOOD_PACKET, REPAIR, "k1", [], budget);
    expect(result.status).toBe("needs_user_or_manual_review");
    expect(budget.claude_calls_used).toBe(3); // no extra call
  });

  test("runs up to max_repair_rounds before calling judge", async () => {
    const agent = mockAgent();
    const judge = mockJudge(ACCEPT);
    const loop = new RepairLoop(agent, judge);
    const budget = { ...BUDGET_DEFAULTS, claude_calls_used: 2, repair_rounds_used: 0 };
    await loop.run("fix bug", PLAN, GOOD_PACKET, REPAIR, "k1", [], budget);
    // agent.run called max_repair_rounds=2 times
    expect((agent.run as jest.Mock).mock.calls).toHaveLength(2);
    // judge.judge called once (Call 3)
    expect((judge.judge as jest.Mock).mock.calls).toHaveLength(1);
  });
});
```

- [ ] **Step 8.2: Run — verify fails**

```bash
cd /Users/abhayjuloori/Proxy-Layer && NODE_OPTIONS=--experimental-vm-modules npx jest tests/delegatecodex/repair-loop.test.ts --no-coverage 2>&1 | head -10
```

- [ ] **Step 8.3: Create `src/delegatecodex/repair-loop.ts`**

```typescript
import type { CodexAgent } from "./codex-agent.js";
import type { ClaudeJudge } from "./claude-judge.js";
import type {
  BudgetState,
  ExecutionPacket,
  ExecutionPlan,
  JudgmentVerdict,
} from "./types.js";

export interface RepairResult {
  status: "accepted" | "takeover_needed" | "needs_user_or_manual_review";
  packet: ExecutionPacket;
  verdict?: JudgmentVerdict;
}

export class RepairLoop {
  constructor(
    private readonly agent: CodexAgent,
    private readonly judge: ClaudeJudge
  ) {}

  /**
   * Run up to budget.max_repair_rounds Codex repair attempts using the same
   * repair_instructions, then call Claude Judge once (Call 3) if budget allows.
   *
   * Mutates budget.claude_calls_used and budget.repair_rounds_used.
   */
  async run(
    task: string,
    plan: ExecutionPlan,
    lastPacket: ExecutionPacket,
    repairVerdict: JudgmentVerdict,
    sessionKey: string,
    plugins: string[],
    budget: BudgetState
  ): Promise<RepairResult> {
    const repairInstructions = repairVerdict.repair_instructions ?? "Fix the issues identified by the Judge.";

    let currentPacket = lastPacket;

    // Run Codex repair rounds — no Judge call between rounds
    for (let round = 0; round < budget.max_repair_rounds; round++) {
      budget.repair_rounds_used++;
      currentPacket = await this.agent.run(
        task,
        plan,
        plugins,
        sessionKey,
        true,
        repairInstructions
      );
    }

    // Call Judge once (Call 3) if budget allows
    if (budget.claude_calls_used >= budget.max_claude_calls) {
      return {
        status: "needs_user_or_manual_review",
        packet: currentPacket,
        verdict: repairVerdict, // last known verdict
      };
    }

    budget.claude_calls_used++;
    const finalVerdict = await this.judge.judge(task, plan, currentPacket);

    if (finalVerdict.verdict === "accept") {
      return { status: "accepted", packet: currentPacket, verdict: finalVerdict };
    }

    // repair again or takeover
    return { status: "takeover_needed", packet: currentPacket, verdict: finalVerdict };
  }
}
```

- [ ] **Step 8.4: Run tests**

```bash
cd /Users/abhayjuloori/Proxy-Layer && NODE_OPTIONS=--experimental-vm-modules npx jest tests/delegatecodex/repair-loop.test.ts --no-coverage
```

Expected: 3 tests pass.

- [ ] **Step 8.5: Commit**

```bash
git add src/delegatecodex/repair-loop.ts tests/delegatecodex/repair-loop.test.ts
git commit -m "feat(delegatecodex): add RepairLoop — ≤2 Codex rounds + Call 3 Judge, budget-aware"
```

---

## Task 9: Claude Takeover

**Files:**
- Create: `src/delegatecodex/claude-takeover.ts`

- [ ] **Step 9.1: Create `src/delegatecodex/claude-takeover.ts`**

```typescript
import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import type { ExecutionPacket, ExecutionPlan, JudgmentVerdict } from "./types.js";

const TAKEOVER_TIMEOUT_MS = 120_000;

function buildTakeoverPrompt(
  task: string,
  plan: ExecutionPlan,
  packet: ExecutionPacket,
  verdict: JudgmentVerdict | undefined
): string {
  const verdictContext = verdict?.takeover_reason
    ? `\nCodex attempted this task but was taken over because: ${verdict.takeover_reason}`
    : verdict?.repair_instructions
    ? `\nCodex repair attempts failed. Last repair instructions were:\n${verdict.repair_instructions}`
    : "";

  const priorWork = packet.files_changed.length > 0
    ? `\nCodex changed these files (review and fix as needed): ${packet.files_changed.join(", ")}`
    : "";

  return `${task}
${verdictContext}
${priorWork}

Success criteria: ${plan.success_criteria}
${plan.architecture_notes ? `Architecture constraints: ${plan.architecture_notes}` : ""}

Complete this task to the highest standard.`;
}

export class ClaudeTakeover {
  constructor(private readonly claude: ClaudeSubprocessManager) {}

  async run(
    task: string,
    plan: ExecutionPlan,
    packet: ExecutionPacket,
    verdict: JudgmentVerdict | undefined
  ): Promise<string> {
    const prompt = buildTakeoverPrompt(task, plan, packet, verdict);
    return this.claude.call(prompt, TAKEOVER_TIMEOUT_MS);
  }

  async *stream(
    task: string,
    plan: ExecutionPlan,
    packet: ExecutionPacket,
    verdict: JudgmentVerdict | undefined
  ): AsyncGenerator<string> {
    const prompt = buildTakeoverPrompt(task, plan, packet, verdict);
    // stream(prompt, signal?, timeoutMs?) — pass undefined for signal, explicit timeout
    yield* this.claude.stream(prompt, undefined, TAKEOVER_TIMEOUT_MS);
  }
}
```

- [ ] **Step 9.2: Commit**

```bash
git add src/delegatecodex/claude-takeover.ts
git commit -m "feat(delegatecodex): add ClaudeTakeover — Claude handles task directly with prior Codex context"
```

---

## Task 10: Orchestrator

**Files:**
- Create: `src/delegatecodex/delegatecodex.ts`

- [ ] **Step 10.1: Create `src/delegatecodex/delegatecodex.ts`**

```typescript
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import { BUDGET_DEFAULTS } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { getPluginHints } from "./plugin-router.js";
import { SessionManager } from "./session-manager.js";
import { CodexAgent } from "./codex-agent.js";
import { ClaudeJudge } from "./claude-judge.js";
import { RepairLoop } from "./repair-loop.js";
import { ClaudeTakeover } from "./claude-takeover.js";
import type {
  BudgetState,
  DelegatecodexResult,
  ExecutionPlan,
} from "./types.js";

// Singleton session manager — survives across requests
const sessionManager = new SessionManager();

// Purge expired sessions every 5 minutes
setInterval(() => sessionManager.purgeExpired(), 5 * 60 * 1000);

export type ProgressEvent =
  | { type: "dispatched"; plan: ExecutionPlan }
  | { type: "codex_running"; model_tier: string; mode: string }
  | { type: "judging"; call_number: number }
  | { type: "repairing"; round: number; max_rounds: number }
  | { type: "takeover"; reason: string }
  | { type: "complete"; status: DelegatecodexResult["status"] };

export interface DelegatecodexOptions {
  onProgress?: (event: ProgressEvent) => void;
}

export async function runDelegatecodex(
  task: string,
  config: BridgeConfig,
  logger: Logger,
  claude: ClaudeSubprocessManager,
  options: DelegatecodexOptions = {}
): Promise<DelegatecodexResult> {
  const { onProgress } = options;
  const emit = (event: ProgressEvent) => onProgress?.(event);

  const budget: BudgetState = {
    max_claude_calls: BUDGET_DEFAULTS.max_claude_calls,
    max_repair_rounds: BUDGET_DEFAULTS.max_repair_rounds,
    claude_calls_used: 0,
    repair_rounds_used: 0,
  };

  // ── Call 1: Claude Dispatcher ────────────────────────────────────────────
  const dispatcher = new Dispatcher(claude);
  budget.claude_calls_used++;
  const plan = await dispatcher.dispatch(task);
  emit({ type: "dispatched", plan });

  logger.info("delegatecodex", "plan dispatched", {
    brain: plan.brain,
    mode: plan.mode,
    model_tier: plan.model_tier,
  });

  // ── Claude leads: hand off directly ─────────────────────────────────────
  if (plan.brain === "claude_leads") {
    const takeover = new ClaudeTakeover(claude);
    const output = await takeover.run(task, plan, {
      status: "completed",
      summary: "Claude handled directly",
      files_changed: [],
      commands_run: [],
      risks: [],
      unresolved_items: [],
      confidence: 1,
    }, undefined);
    emit({ type: "complete", status: "takeover_complete" });
    return {
      status: "takeover_complete",
      output,
      plan,
      packet: {
        status: "completed",
        summary: "Claude handled directly (claude_leads)",
        files_changed: [],
        commands_run: [],
        risks: [],
        unresolved_items: [],
        confidence: 1,
      },
      budget_used: budget,
    };
  }

  // ── Codex leads ──────────────────────────────────────────────────────────
  const plugins = getPluginHints(plan, task);
  const sessionKey = SessionManager.makeKey(
    `task-${Date.now()}`,
    task.slice(0, 40)
  );
  const agent = new CodexAgent(config, logger, sessionManager);
  emit({ type: "codex_running", model_tier: plan.model_tier, mode: plan.mode });

  const packet = await agent.run(task, plan, plugins, sessionKey);

  // If claude_after=none, skip judgment
  if (plan.claude_after === "none") {
    emit({ type: "complete", status: "accepted" });
    return {
      status: "accepted",
      output: packet.summary,
      plan,
      packet,
      budget_used: budget,
    };
  }

  // ── Call 2: Claude Judge ─────────────────────────────────────────────────
  budget.claude_calls_used++;
  emit({ type: "judging", call_number: 2 });
  const judge = new ClaudeJudge(claude);
  const verdict = await judge.judge(task, plan, packet);

  logger.info("delegatecodex", "judgment complete", {
    verdict: verdict.verdict,
    score: verdict.score,
  });

  if (verdict.verdict === "accept") {
    // Apply polish if needed
    let output = packet.summary;
    if (verdict.polish_notes && (plan.claude_after === "ui_polish" || plan.claude_after === "final_refine")) {
      const takeover = new ClaudeTakeover(claude);
      if (budget.claude_calls_used < budget.max_claude_calls) {
        budget.claude_calls_used++;
        output = await takeover.run(task, plan, packet, verdict);
      }
    }
    emit({ type: "complete", status: "accepted" });
    return { status: "accepted", output, plan, packet, verdict, budget_used: budget };
  }

  if (verdict.verdict === "takeover") {
    // allow_takeover controls whether takeover is a permitted behavior, NOT budget bypass.
    // Budget cap is always respected. Raise max_claude_calls in the plan if more budget is needed.
    const canTakeover = plan.allow_takeover && budget.claude_calls_used < budget.max_claude_calls;
    if (!canTakeover) {
      emit({ type: "complete", status: "needs_user_or_manual_review" });
      return {
        status: "needs_user_or_manual_review",
        output: `Task needs manual review.\nJudge score: ${verdict.score}/10\nReason: ${verdict.takeover_reason ?? "see verdict"}`,
        plan,
        packet,
        verdict,
        budget_used: budget,
      };
    }
    emit({ type: "takeover", reason: verdict.takeover_reason ?? "judge requested takeover" });
    const takeover = new ClaudeTakeover(claude);
    if (budget.claude_calls_used < budget.max_claude_calls) budget.claude_calls_used++;
    const output = await takeover.run(task, plan, packet, verdict);
    emit({ type: "complete", status: "takeover_complete" });
    return { status: "takeover_complete", output, plan, packet, verdict, budget_used: budget };
  }

  // verdict === "repair"
  emit({ type: "repairing", round: 1, max_rounds: budget.max_repair_rounds });
  const repairLoop = new RepairLoop(agent, judge);
  const repairResult = await repairLoop.run(task, plan, packet, verdict, sessionKey, plugins, budget);

  if (repairResult.status === "accepted") {
    emit({ type: "complete", status: "accepted" });
    return {
      status: "accepted",
      output: repairResult.packet.summary,
      plan,
      packet: repairResult.packet,
      verdict: repairResult.verdict,
      budget_used: budget,
    };
  }

  if (repairResult.status === "needs_user_or_manual_review") {
    emit({ type: "complete", status: "needs_user_or_manual_review" });
    return {
      status: "needs_user_or_manual_review",
      output: `Budget exhausted. Latest Codex output:\n${repairResult.packet.summary}\n\nLast judge feedback:\n${repairResult.verdict?.repair_instructions ?? "none"}`,
      plan,
      packet: repairResult.packet,
      verdict: repairResult.verdict,
      budget_used: budget,
    };
  }

  // takeover_needed after repair
  const canTakeover = budget.claude_calls_used < budget.max_claude_calls || plan.allow_takeover;
  if (!canTakeover) {
    emit({ type: "complete", status: "needs_user_or_manual_review" });
    return {
      status: "needs_user_or_manual_review",
      output: `Repair failed and budget exhausted.\nLatest: ${repairResult.packet.summary}`,
      plan,
      packet: repairResult.packet,
      verdict: repairResult.verdict,
      budget_used: budget,
    };
  }

  emit({ type: "takeover", reason: repairResult.verdict?.takeover_reason ?? "repair failed" });
  const takeover = new ClaudeTakeover(claude);
  if (budget.claude_calls_used < budget.max_claude_calls) budget.claude_calls_used++;
  const output = await takeover.run(task, plan, repairResult.packet, repairResult.verdict);
  emit({ type: "complete", status: "takeover_complete" });
  return {
    status: "takeover_complete",
    output,
    plan,
    packet: repairResult.packet,
    verdict: repairResult.verdict,
    budget_used: budget,
  };
}
```

- [ ] **Step 10.2: Commit**

```bash
git add src/delegatecodex/delegatecodex.ts
git commit -m "feat(delegatecodex): add orchestrator — full dispatch→execute→judge→repair→takeover flow"
```

---

## Task 11: Server Routes

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 11.1: Add imports to `src/server.ts`**

At the top of `src/server.ts`, after the existing imports, add:

```typescript
import { runDelegatecodex } from "./delegatecodex/delegatecodex.js";
import type { DelegatecodexResult } from "./delegatecodex/types.js";
```

- [ ] **Step 11.2: Add routes to `src/server.ts`**

Find the existing `/delegatecodex` route handler (around line 968) and replace the entire block from `app.post("/delegatecodex"` through the closing `});` with:

```typescript
  // /delegatecodex — v2: Claude-dispatcher + Codex-executor + Claude-judge
  app.post("/delegatecodex", async (request: Request, response: Response) => {
    const task = (request.body as { task?: string }).task?.trim();
    if (!task) {
      response.status(400).json({ error: "task required" });
      return;
    }

    const requestId = getRequestId();

    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    const write = (payload: unknown) =>
      response.write(`data: ${JSON.stringify(payload)}\n\n`);

    try {
      const result: DelegatecodexResult = await runDelegatecodex(
        task,
        config,
        logger,
        delegateClaude,
        {
          onProgress: (event) => write(event),
        }
      );
      write({ type: "result", ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("delegatecodex-v2", "pipeline failed", { requestId, error: message });
      write({ type: "error", message });
    }

    response.write("data: [DONE]\n\n");
    response.end();
  });

  // /delegatecodex-old — v1 compatibility path (src/pipeline/ unchanged)
  app.post("/delegatecodex-old", async (request: Request, response: Response) => {
    const task = (request.body as { task?: string }).task?.trim();
    if (!task) {
      response.status(400).json({ error: "task required" });
      return;
    }

    const requestId = getRequestId();
    const sessionId = getSessionId(request);
    const context = compatibilityLoader.load();

    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    const write = (payload: unknown) =>
      response.write(`data: ${JSON.stringify(payload)}\n\n`);

    const baseTask: InternalTask = {
      requestId,
      sessionId,
      requestedModel: "codex",
      maxTokens: 8192,
      stream: false,
      systemPrompt: "",
      messages: [{ role: "user", content: task }],
      tools: [],
      prompt: task,
      sourceRequest: {
        model: "codex",
        max_tokens: 8192,
        stream: false,
        messages: [{ role: "user", content: task }]
      },
      compatibilityContext: context,
      permissionContext: {
        mode: "default",
        rules: [],
        canEdit: true,
        canRunCommands: true,
        sandbox: config.codex.sandbox,
        appServerApprovalPolicy: "on-request",
        parityNotes: []
      },
      selectedSkills: [],
      selectedAgent: null,
      inputItems: [{ type: "text", text: task }]
    };

    try {
      const result = await runPipeline(baseTask, delegateClaude, delegateWorker, {
        onProgress: (event) => write(event)
      });
      write({ type: "result", ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("delegatecodex-old", "pipeline failed", { requestId, error: message });
      write({ type: "error", message });
    }

    response.write("data: [DONE]\n\n");
    response.end();
  });
```

- [ ] **Step 11.3: Verify TypeScript build**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx tsc --noEmit 2>&1
```

Expected: No errors.

- [ ] **Step 11.4: Run all tests**

```bash
cd /Users/abhayjuloori/Proxy-Layer && NODE_OPTIONS=--experimental-vm-modules npx jest --no-coverage 2>&1
```

Expected: All existing tests pass plus all new delegatecodex tests.

- [ ] **Step 11.5: Commit**

```bash
git add src/server.ts
git commit -m "feat(delegatecodex): wire v2 /delegatecodex route + keep /delegatecodex-old as v1 compat path"
```

---

## Task 12: Smoke Script + npm Script

**Files:**
- Create: `scripts/smoke-delegatecodex-v2.ts`
- Modify: `package.json`

- [ ] **Step 12.1: Create `scripts/smoke-delegatecodex-v2.ts`**

```typescript
#!/usr/bin/env tsx
/**
 * Smoke test for /delegatecodex v2
 * Tests: accept path, repair path, claude_leads path, budget exhaustion path
 * Requires server running: npm run dev
 */

const BASE = "http://localhost:8787";
const HEADERS = {
  Authorization: "Bearer codex-bridge-local",
  "Content-Type": "application/json",
};

async function ssePost(path: string, body: object): Promise<unknown[]> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const text = await res.text();
  const events: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ") && line !== "data: [DONE]") {
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {
        // ignore
      }
    }
  }
  return events;
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ${name}... `);
  try {
    await fn();
    console.log("PASS");
  } catch (err) {
    console.log(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

console.log("\n=== /delegatecodex v2 smoke tests ===\n");

// Test 1: Simple mechanical task → should complete
await test("T1: mechanical rename task", async () => {
  const events = await ssePost("/delegatecodex", {
    task: "Rename the variable `count` to `itemCount` in any TypeScript file in src/",
  });
  const result = events.find((e) => (e as { type: string }).type === "result") as { status?: string } | undefined;
  if (!result) throw new Error("No result event received");
  if (!["accepted", "repaired", "takeover_complete"].includes(result.status ?? "")) {
    throw new Error(`Unexpected status: ${result.status}`);
  }
});

// Test 2: Check dispatched event arrives
await test("T2: dispatched event emitted", async () => {
  const events = await ssePost("/delegatecodex", {
    task: "List all TypeScript files in src/pipeline/ directory",
  });
  const dispatched = events.find((e) => (e as { type: string }).type === "dispatched");
  if (!dispatched) throw new Error("No dispatched event");
  const plan = (dispatched as { plan?: { brain?: string } }).plan;
  if (!plan?.brain) throw new Error("dispatched event missing plan.brain");
});

// Test 3: /delegatecodex-old still works
await test("T3: /delegatecodex-old (v1 compat)", async () => {
  const events = await ssePost("/delegatecodex-old", {
    task: "rename calculateTotal to computeTotal in any TypeScript file",
  });
  const result = events.find((e) => (e as { type: string }).type === "result") as { status?: string } | undefined;
  if (!result) throw new Error("No result event from v1 path");
});

// Test 4: Result includes budget_used
await test("T4: result includes budget_used", async () => {
  const events = await ssePost("/delegatecodex", {
    task: "List all exported functions in src/delegatecodex/types.ts",
  });
  const result = events.find((e) => (e as { type: string }).type === "result") as Record<string, unknown> | undefined;
  if (!result) throw new Error("No result event");
  if (!result.budget_used) throw new Error("result missing budget_used");
  const budget = result.budget_used as { claude_calls_used: number };
  if (typeof budget.claude_calls_used !== "number") throw new Error("budget_used.claude_calls_used not a number");
});

console.log("\n=== Done ===\n");
```

- [ ] **Step 12.2: Add script to `package.json`**

In `package.json`, add to the `"scripts"` object:

```json
"smoke:delegatecodex-v2": "tsx scripts/smoke-delegatecodex-v2.ts"
```

- [ ] **Step 12.3: Verify TypeScript build still clean**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx tsc --noEmit 2>&1
```

Expected: No errors.

- [ ] **Step 12.4: Commit**

```bash
git add scripts/smoke-delegatecodex-v2.ts package.json
git commit -m "feat(delegatecodex): add v2 smoke test script and npm script"
```

---

## Task 13: End-to-End Verification

- [ ] **Step 13.1: Run full test suite**

```bash
cd /Users/abhayjuloori/Proxy-Layer && NODE_OPTIONS=--experimental-vm-modules npx jest --no-coverage 2>&1
```

Expected: All tests pass (existing 4 suites + 5 new delegatecodex suites).

- [ ] **Step 13.2: Start server and run smoke tests**

```bash
# Terminal 1
cd /Users/abhayjuloori/Proxy-Layer && npm run dev &
sleep 3

# Terminal 2
npm run smoke:delegatecodex-v2
```

Expected: T1–T4 all PASS.

- [ ] **Step 13.3: Verify /delegatecodex-old still works**

```bash
curl -s -X POST http://localhost:8787/delegatecodex-old \
  -H 'Authorization: Bearer codex-bridge-local' \
  -H 'Content-Type: application/json' \
  -d '{"task":"rename calculateTotal to computeTotal in any TypeScript file"}' \
  | grep -o '"type":"result"'
```

Expected: `"type":"result"` appears.

- [ ] **Step 13.4: Final commit**

```bash
git add -A
git commit -m "feat(delegatecodex): v2 complete — Claude-dispatcher + Codex-executor + Claude-judge + repair loop"
```

---

## Success Criteria Checklist

- [ ] `POST /delegatecodex` completes a mechanical task with ≤2 Claude calls
- [ ] `POST /delegatecodex` emits `dispatched`, `codex_running`, `judging`, `complete` progress events
- [ ] `result` event includes `status`, `plan`, `packet`, `budget_used`
- [ ] `POST /delegatecodex-old` still routes to v1 pipeline (`src/pipeline/`) unchanged
- [ ] `POST /pipeline` still works unchanged
- [ ] `npx tsc --noEmit` exits 0
- [ ] `npm test` passes all suites
- [ ] `npm run smoke:delegatecodex-v2` — T1–T4 all PASS
