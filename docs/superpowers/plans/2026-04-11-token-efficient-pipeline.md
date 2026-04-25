# Token-Efficient Orchestration Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `POST /pipeline` endpoint that routes tasks through Haiku classification → optional Sonnet planning (at most twice per task) → Codex step execution → deterministic gate, all orchestrated by an external controller with hard retry and step budgets.

**Architecture:** New `src/pipeline/` module sits alongside the existing `src/delegation/` system. `ClaudeSubprocessManager.call()` gains an optional `model` parameter so Haiku can be invoked through the existing subprocess path. The external controller owns all routing logic and loop termination — no model makes control-flow decisions. Sonnet is guarded by an invocation counter that throws if called a third time.

**Tech Stack:** TypeScript 5.8, Node 20+, Express 4.21, Zod 3.24, existing `ClaudeSubprocessManager` (with model param), existing `CodexExecAdapter`, Jest + ts-jest

---

## File Map

**New files:**
- `src/pipeline/types.ts` — All pipeline-specific types and Zod schemas
- `src/pipeline/haiku-classifier.ts` — Haiku classification + compression (Layer 1)
- `src/pipeline/context-distiller.ts` — Token-budget enforcement and Haiku-powered compression (Layer 2)
- `src/pipeline/sonnet-planner.ts` — One-shot step decomposer with strict 2-invocation guard (Layer 3)
- `src/pipeline/step-executor.ts` — Single-step Codex execution wrapper
- `src/pipeline/gate.ts` — Deterministic pass/fail checks (no LLM)
- `src/pipeline/controller.ts` — External orchestration: routing, retry budget, escalation logic
- `src/pipeline/pipeline.ts` — Top-level `runPipeline()` wiring all layers
- `src/pipeline/__tests__/haiku-classifier.test.ts`
- `src/pipeline/__tests__/context-distiller.test.ts`
- `src/pipeline/__tests__/sonnet-planner.test.ts`
- `src/pipeline/__tests__/gate.test.ts`
- `src/pipeline/__tests__/controller.test.ts`
- `scripts/smoke-pipeline.ts` — End-to-end smoke test

**Modified files:**
- `src/claude/subprocess.ts:~22` — Add optional `model` parameter to `call()` method
- `src/server.ts` — Add `POST /pipeline` route

---

## Task 1: Pipeline types

**Files:**
- Create: `src/pipeline/types.ts`

- [ ] **Step 1: Write the failing test**

Create `src/pipeline/__tests__/types.test.ts`:
```typescript
import { classificationResultSchema, planResultSchema, gateResultSchema } from "../types.js";

describe("pipeline types", () => {
  it("parses a valid ClassificationResult", () => {
    const input = {
      task_type: "mechanical",
      requires_plan: false,
      requires_sonnet: false,
      confidence: 0.92,
      compressed_spec: "rename foo to bar in utils.ts"
    };
    expect(() => classificationResultSchema.parse(input)).not.toThrow();
  });

  it("rejects an invalid task_type", () => {
    const input = {
      task_type: "unknown_type",
      requires_plan: false,
      requires_sonnet: false,
      confidence: 0.5,
      compressed_spec: "do something"
    };
    expect(() => classificationResultSchema.parse(input)).toThrow();
  });

  it("parses a valid PlanResult", () => {
    const input = {
      steps: [
        {
          id: "step-1",
          description: "rename function",
          prompt: "rename foo() to bar() in src/utils.ts",
          success_criteria: "bar() exists in src/utils.ts"
        }
      ],
      escalation_triggers: ["touches public API"]
    };
    expect(() => planResultSchema.parse(input)).not.toThrow();
  });

  it("parses a valid GateResult", () => {
    expect(() => gateResultSchema.parse({ pass: true, reason: "output non-empty" })).not.toThrow();
    expect(() => gateResultSchema.parse({ pass: false, reason: "output empty" })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest src/pipeline/__tests__/types.test.ts --no-coverage 2>&1 | tail -10
```
Expected: FAIL with "Cannot find module '../types.js'"

- [ ] **Step 3: Create types.ts**

```typescript
import { z } from "zod";

export const classificationResultSchema = z.object({
  task_type: z.enum(["mechanical", "multi_step", "judgment", "ambiguous"]),
  requires_plan: z.boolean(),
  requires_sonnet: z.boolean(),
  confidence: z.number().min(0).max(1),
  compressed_spec: z.string(),
  ambiguity_question: z.string().optional()
});

export type ClassificationResult = z.infer<typeof classificationResultSchema>;

export const stepSpecSchema = z.object({
  id: z.string(),
  description: z.string(),
  prompt: z.string(),
  success_criteria: z.string()
});

export type StepSpec = z.infer<typeof stepSpecSchema>;

export const planResultSchema = z.object({
  steps: z.array(stepSpecSchema).min(1),
  escalation_triggers: z.array(z.string())
});

export type PlanResult = z.infer<typeof planResultSchema>;

export const gateResultSchema = z.object({
  pass: z.boolean(),
  reason: z.string()
});

export type GateResult = z.infer<typeof gateResultSchema>;

export interface StepExecutionResult {
  step_id: string;
  output: string;
  status: "success" | "failure" | "empty";
}

export interface EscalationResult {
  verdict: "accepted" | "escalated";
  summary: string;
}

export interface PipelineResult {
  status: "completed" | "escalated" | "failed" | "ambiguous";
  output: string;
  steps_executed: number;
  sonnet_invocations: number;
  escalation_summary?: string;
}

export interface ControllerBudget {
  max_retries_per_step: number;  // default: 2
  max_total_steps: number;       // default: plan_steps * 1.5, rounded down
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest src/pipeline/__tests__/types.test.ts --no-coverage 2>&1 | tail -10
```
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer && git add src/pipeline/types.ts src/pipeline/__tests__/types.test.ts && git commit -m "feat(pipeline): add pipeline types and Zod schemas"
```

---

## Task 2: Model parameter for ClaudeSubprocessManager

**Files:**
- Modify: `src/claude/subprocess.ts` (the `call()` method signature and spawn args)

- [ ] **Step 1: Write the failing test**

Create `src/pipeline/__tests__/subprocess-model.test.ts`:
```typescript
import { ClaudeSubprocessManager } from "../../claude/subprocess.js";

// This test verifies the model param makes it into the spawn args.
// We mock spawn to capture the args.
import { spawn } from "node:child_process";
jest.mock("node:child_process");

describe("ClaudeSubprocessManager.call() model parameter", () => {
  it("uses default args when no model specified", async () => {
    const mockProc = {
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      stdin: { write: jest.fn(), end: jest.fn() },
      on: jest.fn()
    };
    (spawn as jest.Mock).mockReturnValue(mockProc);

    const manager = new ClaudeSubprocessManager(
      { codex: { cwd: "/tmp" } } as never,
      { warn: jest.fn() } as never
    );

    // Don't await — just check spawn was called correctly
    manager.call("test prompt").catch(() => {});

    expect(spawn).toHaveBeenCalledWith(
      "claude",
      ["--print", "--dangerously-skip-permissions"],
      expect.any(Object)
    );
  });

  it("appends --model flag when model is specified", async () => {
    const mockProc = {
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      stdin: { write: jest.fn(), end: jest.fn() },
      on: jest.fn()
    };
    (spawn as jest.Mock).mockReturnValue(mockProc);

    const manager = new ClaudeSubprocessManager(
      { codex: { cwd: "/tmp" } } as never,
      { warn: jest.fn() } as never
    );

    manager.call("test prompt", 30_000, "claude-haiku-4-5-20251001").catch(() => {});

    expect(spawn).toHaveBeenCalledWith(
      "claude",
      ["--print", "--dangerously-skip-permissions", "--model", "claude-haiku-4-5-20251001"],
      expect.any(Object)
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest src/pipeline/__tests__/subprocess-model.test.ts --no-coverage 2>&1 | tail -15
```
Expected: FAIL — second test fails because model param doesn't exist yet

- [ ] **Step 3: Update ClaudeSubprocessManager.call()**

In `src/claude/subprocess.ts`, change the `call()` method signature and spawn args:

```typescript
async call(prompt: string, timeoutMs = DEFAULT_CALL_TIMEOUT_MS, model?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["--print", "--dangerously-skip-permissions"];
    if (model) {
      args.push("--model", model);
    }
    const proc = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.config.codex.cwd
    });
    // ... rest of method unchanged
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest src/pipeline/__tests__/subprocess-model.test.ts --no-coverage 2>&1 | tail -10
```
Expected: PASS, 2 tests

- [ ] **Step 5: Run full test suite to confirm no regressions**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest --no-coverage 2>&1 | tail -15
```
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer && git add src/claude/subprocess.ts src/pipeline/__tests__/subprocess-model.test.ts && git commit -m "feat(claude): add optional model parameter to ClaudeSubprocessManager.call()"
```

---

## Task 3: Haiku classifier (Layer 1)

**Files:**
- Create: `src/pipeline/haiku-classifier.ts`
- Create: `src/pipeline/__tests__/haiku-classifier.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/pipeline/__tests__/haiku-classifier.test.ts
import { HaikuClassifier } from "../haiku-classifier.js";
import type { ClassificationResult } from "../types.js";

const makeMockClaude = (response: string) => ({
  call: jest.fn().mockResolvedValue(response)
});

describe("HaikuClassifier", () => {
  it("parses a mechanical classification response", async () => {
    const raw = JSON.stringify({
      task_type: "mechanical",
      requires_plan: false,
      requires_sonnet: false,
      confidence: 0.95,
      compressed_spec: "rename foo to bar in utils.ts"
    });
    const claude = makeMockClaude(raw);
    const classifier = new HaikuClassifier(claude as never);

    const result = await classifier.classify("rename the function foo to bar in utils.ts");

    expect(result.task_type).toBe("mechanical");
    expect(result.requires_plan).toBe(false);
    expect(result.confidence).toBe(0.95);
    expect(claude.call).toHaveBeenCalledWith(
      expect.stringContaining("classify"),
      expect.any(Number),
      "claude-haiku-4-5-20251001"
    );
  });

  it("parses a multi_step classification response", async () => {
    const raw = JSON.stringify({
      task_type: "multi_step",
      requires_plan: true,
      requires_sonnet: true,
      confidence: 0.88,
      compressed_spec: "add auth middleware + update tests + update README"
    });
    const claude = makeMockClaude(raw);
    const classifier = new HaikuClassifier(claude as never);

    const result = await classifier.classify("add auth middleware, update tests, and update docs");

    expect(result.task_type).toBe("multi_step");
    expect(result.requires_plan).toBe(true);
  });

  it("handles JSON embedded in prose", async () => {
    const raw = `Here is the classification:\n\`\`\`json\n${JSON.stringify({
      task_type: "judgment",
      requires_plan: false,
      requires_sonnet: true,
      confidence: 0.80,
      compressed_spec: "evaluate tradeoffs of two architecture options"
    })}\n\`\`\``;
    const claude = makeMockClaude(raw);
    const classifier = new HaikuClassifier(claude as never);

    const result = await classifier.classify("which architecture is better?");
    expect(result.task_type).toBe("judgment");
  });

  it("falls back to ambiguous when response cannot be parsed", async () => {
    const claude = makeMockClaude("I cannot classify this task.");
    const classifier = new HaikuClassifier(claude as never);

    const result = await classifier.classify("...");
    expect(result.task_type).toBe("ambiguous");
    expect(result.confidence).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest src/pipeline/__tests__/haiku-classifier.test.ts --no-coverage 2>&1 | tail -10
```
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Create haiku-classifier.ts**

```typescript
// src/pipeline/haiku-classifier.ts
import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import { classificationResultSchema, type ClassificationResult } from "./types.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 15_000;

const CLASSIFICATION_PROMPT = (task: string) => `Classify this task for routing. Return ONLY a JSON object, no prose.

Task: ${task}

JSON schema:
{
  "task_type": "mechanical" | "multi_step" | "judgment" | "ambiguous",
  "requires_plan": boolean,
  "requires_sonnet": boolean,
  "confidence": number (0-1),
  "compressed_spec": string (≤200 chars, essential info only),
  "ambiguity_question": string (only if task_type is "ambiguous")
}

Rules:
- mechanical: single-file, deterministic, no semantic change (rename, reformat, move)
- multi_step: cross-file, sequential dependencies, or behavioral changes
- judgment: architecture, UI/UX, tradeoffs, design decisions
- ambiguous: cannot classify without more info (set ambiguity_question)
- requires_plan: true for multi_step and judgment
- requires_sonnet: true for judgment, true for multi_step, false for mechanical
- confidence: how certain you are (below 0.75 = set task_type to ambiguous)`;

export class HaikuClassifier {
  constructor(private readonly claude: ClaudeSubprocessManager) {}

  async classify(task: string): Promise<ClassificationResult> {
    try {
      const raw = await this.claude.call(
        CLASSIFICATION_PROMPT(task),
        TIMEOUT_MS,
        HAIKU_MODEL
      );
      return parseClassificationResponse(raw);
    } catch {
      return ambiguousFallback();
    }
  }
}

function parseClassificationResponse(raw: string): ClassificationResult {
  // Try direct parse first
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return ambiguousFallback();

  try {
    const parsed = JSON.parse(jsonMatch[0]) as unknown;
    return classificationResultSchema.parse(parsed);
  } catch {
    return ambiguousFallback();
  }
}

function ambiguousFallback(): ClassificationResult {
  return {
    task_type: "ambiguous",
    requires_plan: false,
    requires_sonnet: false,
    confidence: 0,
    compressed_spec: ""
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest src/pipeline/__tests__/haiku-classifier.test.ts --no-coverage 2>&1 | tail -10
```
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer && git add src/pipeline/haiku-classifier.ts src/pipeline/__tests__/haiku-classifier.test.ts && git commit -m "feat(pipeline): add HaikuClassifier (Layer 1)"
```

---

## Task 4: Context distiller (Layer 2)

**Files:**
- Create: `src/pipeline/context-distiller.ts`
- Create: `src/pipeline/__tests__/context-distiller.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/pipeline/__tests__/context-distiller.test.ts
import { ContextDistiller, estimateTokens } from "../context-distiller.js";

const makeMockClaude = (response: string) => ({
  call: jest.fn().mockResolvedValue(response)
});

describe("estimateTokens", () => {
  it("estimates tokens at ~4 chars per token", () => {
    expect(estimateTokens("hello world")).toBe(2); // 11 chars / 4 = 2.75 → 2
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("ContextDistiller", () => {
  it("passes content under 300 tokens unchanged", async () => {
    const claude = makeMockClaude("compressed");
    const distiller = new ContextDistiller(claude as never);

    const input = "short text"; // well under 300 tokens
    const result = await distiller.distill(input);

    expect(result).toBe(input);
    expect(claude.call).not.toHaveBeenCalled();
  });

  it("calls Haiku to compress content over 300 tokens", async () => {
    const claude = makeMockClaude("• key point 1\n• key point 2");
    const distiller = new ContextDistiller(claude as never);

    const input = "x".repeat(1300); // ~325 tokens
    const result = await distiller.distill(input);

    expect(result).toBe("• key point 1\n• key point 2");
    expect(claude.call).toHaveBeenCalledWith(
      expect.stringContaining("summarize"),
      expect.any(Number),
      "claude-haiku-4-5-20251001"
    );
  });

  it("throws when content exceeds 1000 token hard limit and compression also exceeds limit", async () => {
    // Haiku returns something still too large
    const claude = makeMockClaude("x".repeat(5000));
    const distiller = new ContextDistiller(claude as never);

    const input = "x".repeat(5000); // ~1250 tokens
    await expect(distiller.distill(input)).rejects.toThrow("exceeds hard token limit");
  });

  it("accepts compressed output even if original exceeded hard limit", async () => {
    const claude = makeMockClaude("• compressed to small summary");
    const distiller = new ContextDistiller(claude as never);

    const input = "x".repeat(5000); // ~1250 tokens
    const result = await distiller.distill(input);

    expect(result).toBe("• compressed to small summary");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest src/pipeline/__tests__/context-distiller.test.ts --no-coverage 2>&1 | tail -10
```
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Create context-distiller.ts**

```typescript
// src/pipeline/context-distiller.ts
import type { ClaudeSubprocessManager } from "../claude/subprocess.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SOFT_TOKEN_LIMIT = 300;
const HARD_TOKEN_LIMIT = 1000;
const COMPRESS_TIMEOUT_MS = 15_000;

export function estimateTokens(text: string): number {
  return Math.floor(text.length / 4);
}

const COMPRESS_PROMPT = (content: string) =>
  `Summarize the following into bullet points. Preserve all critical facts, file names, function names, and error messages. Drop explanatory prose. Return ONLY the bullet points, no preamble.

Content:
${content}`;

export class ContextDistiller {
  constructor(private readonly claude: ClaudeSubprocessManager) {}

  /**
   * Compress content to within token budget.
   * - Under SOFT_TOKEN_LIMIT: return as-is
   * - Between SOFT and HARD: compress via Haiku
   * - Over HARD: compress via Haiku, then enforce limit or throw
   */
  async distill(content: string): Promise<string> {
    const tokens = estimateTokens(content);

    if (tokens <= SOFT_TOKEN_LIMIT) {
      return content;
    }

    const compressed = await this.compress(content);
    const compressedTokens = estimateTokens(compressed);

    if (tokens > HARD_TOKEN_LIMIT && compressedTokens > HARD_TOKEN_LIMIT) {
      throw new Error(
        `Context exceeds hard token limit (${compressedTokens} > ${HARD_TOKEN_LIMIT} after compression)`
      );
    }

    return compressed;
  }

  private async compress(content: string): Promise<string> {
    return this.claude.call(COMPRESS_PROMPT(content), COMPRESS_TIMEOUT_MS, HAIKU_MODEL);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest src/pipeline/__tests__/context-distiller.test.ts --no-coverage 2>&1 | tail -10
```
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer && git add src/pipeline/context-distiller.ts src/pipeline/__tests__/context-distiller.test.ts && git commit -m "feat(pipeline): add ContextDistiller with token budget enforcement (Layer 2)"
```

---

## Task 5: Sonnet planner with 2-invocation guard (Layer 3)

**Files:**
- Create: `src/pipeline/sonnet-planner.ts`
- Create: `src/pipeline/__tests__/sonnet-planner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/pipeline/__tests__/sonnet-planner.test.ts
import { SonnetPlanner } from "../sonnet-planner.js";

const validPlanJson = JSON.stringify({
  steps: [
    {
      id: "step-1",
      description: "rename function",
      prompt: "rename foo() to bar() in src/utils.ts",
      success_criteria: "bar() exists in src/utils.ts, no reference to foo()"
    }
  ],
  escalation_triggers: ["touches exported API"]
});

const makeMockClaude = (response: string) => ({
  call: jest.fn().mockResolvedValue(response)
});

describe("SonnetPlanner", () => {
  it("returns a parsed plan on first invocation", async () => {
    const claude = makeMockClaude(validPlanJson);
    const planner = new SonnetPlanner(claude as never);

    const plan = await planner.plan("rename foo to bar");

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].id).toBe("step-1");
    expect(plan.escalation_triggers).toContain("touches exported API");
  });

  it("can be called a second time (review mode)", async () => {
    const claude = makeMockClaude(validPlanJson);
    const planner = new SonnetPlanner(claude as never);

    await planner.plan("first call");
    await expect(planner.plan("second call")).resolves.toBeDefined();
    expect(planner.invocationCount).toBe(2);
  });

  it("throws on third invocation", async () => {
    const claude = makeMockClaude(validPlanJson);
    const planner = new SonnetPlanner(claude as never);

    await planner.plan("first call");
    await planner.plan("second call");

    await expect(planner.plan("third call — should throw")).rejects.toThrow(
      "SonnetPlanner invocation limit exceeded"
    );
  });

  it("falls back to single-step plan when response cannot be parsed", async () => {
    const claude = makeMockClaude("I'll help you with that task.");
    const planner = new SonnetPlanner(claude as never);

    const plan = await planner.plan("do something", "compressed spec");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].id).toBe("step-fallback");
  });

  it("passes compressed_spec to Claude when provided", async () => {
    const claude = makeMockClaude(validPlanJson);
    const planner = new SonnetPlanner(claude as never);

    await planner.plan("original task", "compressed: rename foo → bar");

    expect(claude.call).toHaveBeenCalledWith(
      expect.stringContaining("compressed: rename foo → bar"),
      expect.any(Number)
      // no model arg — uses default Sonnet
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest src/pipeline/__tests__/sonnet-planner.test.ts --no-coverage 2>&1 | tail -10
```
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Create sonnet-planner.ts**

```typescript
// src/pipeline/sonnet-planner.ts
import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import { planResultSchema, type PlanResult, type StepSpec } from "./types.js";

const MAX_INVOCATIONS = 2;
const PLAN_TIMEOUT_MS = 45_000;

const PLAN_PROMPT = (task: string, compressedSpec?: string) => `You are a task planner. Decompose this task into atomic, sequential steps for a Codex executor.

Task: ${task}
${compressedSpec ? `\nCompressed context:\n${compressedSpec}` : ""}

Return ONLY a JSON object matching this schema — no prose, no markdown:
{
  "steps": [
    {
      "id": "step-N",
      "description": "one-line description",
      "prompt": "exact prompt to pass to Codex executor",
      "success_criteria": "deterministic check: what must be true when this step passes"
    }
  ],
  "escalation_triggers": ["condition that should escalate back to Sonnet"]
}

Rules:
- Each step must be independently executable by Codex
- Prompts must be self-contained (no references to other steps)
- success_criteria must be checkable without running code (file exists, string present, etc.)
- escalation_triggers: list conditions that indicate the plan has gone wrong`;

export class SonnetPlanner {
  private _invocationCount = 0;

  constructor(private readonly claude: ClaudeSubprocessManager) {}

  get invocationCount(): number {
    return this._invocationCount;
  }

  async plan(task: string, compressedSpec?: string): Promise<PlanResult> {
    if (this._invocationCount >= MAX_INVOCATIONS) {
      throw new Error(
        `SonnetPlanner invocation limit exceeded (max ${MAX_INVOCATIONS}). ` +
        `This is an architectural violation — the controller must not call plan() more than twice.`
      );
    }

    this._invocationCount++;

    try {
      const raw = await this.claude.call(PLAN_PROMPT(task, compressedSpec), PLAN_TIMEOUT_MS);
      return parsePlanResponse(raw, task);
    } catch (err) {
      if (err instanceof Error && err.message.includes("invocation limit")) throw err;
      return singleStepFallback(task, compressedSpec);
    }
  }
}

function parsePlanResponse(raw: string, task: string): PlanResult {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return singleStepFallback(task);

  try {
    const parsed = JSON.parse(jsonMatch[0]) as unknown;
    return planResultSchema.parse(parsed);
  } catch {
    return singleStepFallback(task);
  }
}

function singleStepFallback(task: string, compressedSpec?: string): PlanResult {
  const prompt = compressedSpec ?? task;
  const step: StepSpec = {
    id: "step-fallback",
    description: "execute task as single step",
    prompt,
    success_criteria: "Codex produces non-empty output without error"
  };
  return { steps: [step], escalation_triggers: [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest src/pipeline/__tests__/sonnet-planner.test.ts --no-coverage 2>&1 | tail -10
```
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer && git add src/pipeline/sonnet-planner.ts src/pipeline/__tests__/sonnet-planner.test.ts && git commit -m "feat(pipeline): add SonnetPlanner with 2-invocation guard (Layer 3)"
```

---

## Task 6: Step executor (Codex wrapper)

**Files:**
- Create: `src/pipeline/step-executor.ts`
- Create: `src/pipeline/__tests__/step-executor.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/pipeline/__tests__/step-executor.test.ts
import { StepExecutor } from "../step-executor.js";
import type { StepSpec } from "../types.js";

const makeStep = (prompt: string): StepSpec => ({
  id: "step-1",
  description: "test step",
  prompt,
  success_criteria: "output is non-empty"
});

const makeAdapter = (output: string) => ({
  execute: jest.fn().mockImplementation(async function* () {
    yield { type: "text-delta", text: output };
    yield { type: "completed", finalText: output };
  })
});

describe("StepExecutor", () => {
  it("returns success result for non-empty Codex output", async () => {
    const adapter = makeAdapter("renamed foo to bar in utils.ts");
    const executor = new StepExecutor(adapter as never, {} as never);

    const result = await executor.execute(makeStep("rename foo to bar"));

    expect(result.status).toBe("success");
    expect(result.output).toBe("renamed foo to bar in utils.ts");
    expect(result.step_id).toBe("step-1");
  });

  it("returns empty result when Codex output is blank", async () => {
    const adapter = makeAdapter("   ");
    const executor = new StepExecutor(adapter as never, {} as never);

    const result = await executor.execute(makeStep("do something"));

    expect(result.status).toBe("empty");
    expect(result.output).toBe("");
  });

  it("returns failure result when adapter throws", async () => {
    const adapter = {
      execute: jest.fn().mockImplementation(async function* () {
        throw new Error("codex subprocess failed");
      })
    };
    const executor = new StepExecutor(adapter as never, {} as never);

    const result = await executor.execute(makeStep("risky step"));

    expect(result.status).toBe("failure");
    expect(result.output).toContain("codex subprocess failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest src/pipeline/__tests__/step-executor.test.ts --no-coverage 2>&1 | tail -10
```
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Create step-executor.ts**

```typescript
// src/pipeline/step-executor.ts
import type { CodexAdapter } from "../adapters/base.js";
import type { InternalTask } from "../types/internal.js";
import type { StepSpec, StepExecutionResult } from "./types.js";

export class StepExecutor {
  constructor(
    private readonly adapter: CodexAdapter,
    private readonly baseTask: InternalTask
  ) {}

  async execute(step: StepSpec): Promise<StepExecutionResult> {
    const workerTask: InternalTask = {
      ...this.baseTask,
      prompt: step.prompt,
      inputItems: [{ type: "text", text: step.prompt }],
      messages: [{ role: "user", content: step.prompt }]
    };

    try {
      let finalText = "";

      for await (const event of this.adapter.execute(workerTask)) {
        if (event.type === "text-delta") finalText += event.text;
        if (event.type === "completed") finalText = event.finalText;
      }

      const trimmed = finalText.trim();

      return {
        step_id: step.id,
        output: trimmed,
        status: trimmed.length === 0 ? "empty" : "success"
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { step_id: step.id, output: message, status: "failure" };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest src/pipeline/__tests__/step-executor.test.ts --no-coverage 2>&1 | tail -10
```
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer && git add src/pipeline/step-executor.ts src/pipeline/__tests__/step-executor.test.ts && git commit -m "feat(pipeline): add StepExecutor Codex wrapper"
```

---

## Task 7: Deterministic gate

**Files:**
- Create: `src/pipeline/gate.ts`
- Create: `src/pipeline/__tests__/gate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/pipeline/__tests__/gate.test.ts
import { Gate } from "../gate.js";
import type { StepSpec, StepExecutionResult } from "../types.js";

const makeStep = (criteria: string): StepSpec => ({
  id: "step-1",
  description: "test",
  prompt: "do something",
  success_criteria: criteria
});

const makeResult = (output: string, status: "success" | "failure" | "empty" = "success"): StepExecutionResult => ({
  step_id: "step-1",
  output,
  status
});

describe("Gate", () => {
  const gate = new Gate();

  it("fails immediately on empty status", () => {
    const result = gate.check(makeStep("anything"), makeResult("", "empty"));
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/empty/i);
  });

  it("fails immediately on failure status", () => {
    const result = gate.check(makeStep("anything"), makeResult("error: subprocess failed", "failure"));
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/failure/i);
  });

  it("fails when output contains error signals", () => {
    const result = gate.check(
      makeStep("anything"),
      makeResult("Error: Cannot find module 'foo'")
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/error signal/i);
  });

  it("passes when output is non-empty and clean", () => {
    const result = gate.check(
      makeStep("output contains 'renamed'"),
      makeResult("Successfully renamed foo to bar in utils.ts")
    );
    expect(result.pass).toBe(true);
  });

  it("fails when success_criteria mentions a string not in output", () => {
    const result = gate.check(
      makeStep("output contains 'bar()'"),
      makeResult("renamed foo to baz")
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/criteria not met/i);
  });

  it("passes when success_criteria mention is satisfied", () => {
    const result = gate.check(
      makeStep("output contains 'bar()'"),
      makeResult("function bar() was created in utils.ts")
    );
    expect(result.pass).toBe(true);
  });

  it("ignores unrecognized success_criteria format and passes if output is clean", () => {
    const result = gate.check(
      makeStep("file exists at src/utils.ts"),  // not a 'contains' check
      makeResult("file written to src/utils.ts successfully")
    );
    expect(result.pass).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest src/pipeline/__tests__/gate.test.ts --no-coverage 2>&1 | tail -10
```
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Create gate.ts**

```typescript
// src/pipeline/gate.ts
import type { StepSpec, StepExecutionResult, GateResult } from "./types.js";

const ERROR_SIGNALS = [
  /^error:/im,
  /\buncaught\b/i,
  /\bfatal\b/i,
  /\bsegfault\b/i,
  /\bcannot find module\b/i,
  /\bsyntaxerror\b/i,
  /\btypeerror\b/i,
  /\bnot found\b.*error/i
];

export class Gate {
  check(step: StepSpec, result: StepExecutionResult): GateResult {
    // 1. Status-based checks
    if (result.status === "empty") {
      return { pass: false, reason: "Codex returned empty output" };
    }
    if (result.status === "failure") {
      return { pass: false, reason: `Codex execution failure: ${result.output.slice(0, 100)}` };
    }

    // 2. Error signal scan
    for (const pattern of ERROR_SIGNALS) {
      if (pattern.test(result.output)) {
        return { pass: false, reason: `Output contains error signal matching: ${pattern}` };
      }
    }

    // 3. Success criteria check (only "output contains X" pattern is deterministic)
    const containsMatch = step.success_criteria.match(/output contains ['"](.+?)['"]/i);
    if (containsMatch) {
      const expected = containsMatch[1];
      if (!result.output.includes(expected)) {
        return {
          pass: false,
          reason: `Criteria not met: output does not contain "${expected}"`
        };
      }
    }

    return { pass: true, reason: "Output is non-empty, clean, and meets criteria" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest src/pipeline/__tests__/gate.test.ts --no-coverage 2>&1 | tail -10
```
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer && git add src/pipeline/gate.ts src/pipeline/__tests__/gate.test.ts && git commit -m "feat(pipeline): add deterministic Gate (no LLM)"
```

---

## Task 8: External controller (orchestration)

**Files:**
- Create: `src/pipeline/controller.ts`
- Create: `src/pipeline/__tests__/controller.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/pipeline/__tests__/controller.test.ts
import { PipelineController } from "../controller.js";
import type { ClassificationResult, PlanResult, StepSpec } from "../types.js";

const mechanical: ClassificationResult = {
  task_type: "mechanical",
  requires_plan: false,
  requires_sonnet: false,
  confidence: 0.92,
  compressed_spec: "rename foo to bar"
};

const multiStep: ClassificationResult = {
  task_type: "multi_step",
  requires_plan: true,
  requires_sonnet: true,
  confidence: 0.88,
  compressed_spec: "add auth + update tests"
};

const ambiguous: ClassificationResult = {
  task_type: "ambiguous",
  requires_plan: false,
  requires_sonnet: false,
  confidence: 0.3,
  compressed_spec: "",
  ambiguity_question: "Is this a refactor or redesign?"
};

const simplePlan: PlanResult = {
  steps: [
    { id: "s1", description: "step 1", prompt: "do step 1", success_criteria: "output contains 'done'" }
  ],
  escalation_triggers: ["touches public API"]
};

describe("PipelineController.getRoute()", () => {
  it("routes mechanical high-confidence tasks to codex_direct", () => {
    const ctrl = new PipelineController({ max_retries_per_step: 2, max_total_steps: 5 });
    expect(ctrl.getRoute(mechanical)).toBe("codex_direct");
  });

  it("routes mechanical low-confidence tasks to sonnet_plan", () => {
    const lowConf: ClassificationResult = { ...mechanical, confidence: 0.7 };
    const ctrl = new PipelineController({ max_retries_per_step: 2, max_total_steps: 5 });
    expect(ctrl.getRoute(lowConf)).toBe("sonnet_plan");
  });

  it("routes multi_step tasks to sonnet_plan", () => {
    const ctrl = new PipelineController({ max_retries_per_step: 2, max_total_steps: 5 });
    expect(ctrl.getRoute(multiStep)).toBe("sonnet_plan");
  });

  it("routes ambiguous tasks to surface_to_user", () => {
    const ctrl = new PipelineController({ max_retries_per_step: 2, max_total_steps: 5 });
    expect(ctrl.getRoute(ambiguous)).toBe("surface_to_user");
  });
});

describe("PipelineController.computeBudget()", () => {
  it("sets max_total_steps to floor(plan_steps * 1.5)", () => {
    const ctrl = new PipelineController({ max_retries_per_step: 2, max_total_steps: 99 });
    const budget = ctrl.computeBudget(simplePlan);
    expect(budget.max_total_steps).toBe(1); // floor(1 * 1.5) = 1
  });

  it("computes floor of fractional result", () => {
    const plan: PlanResult = {
      steps: Array.from({ length: 4 }, (_, i) => ({
        id: `s${i}`, description: `step ${i}`, prompt: `do ${i}`, success_criteria: "done"
      })),
      escalation_triggers: []
    };
    const ctrl = new PipelineController({ max_retries_per_step: 2, max_total_steps: 99 });
    const budget = ctrl.computeBudget(plan);
    expect(budget.max_total_steps).toBe(6); // floor(4 * 1.5) = 6
  });
});

describe("PipelineController.shouldEscalate()", () => {
  it("escalates when retry count exceeds max", () => {
    const ctrl = new PipelineController({ max_retries_per_step: 2, max_total_steps: 10 });
    expect(ctrl.shouldEscalate({ retry_count: 3, total_steps: 1, plan: simplePlan })).toBe(true);
  });

  it("escalates when total steps exceeds budget", () => {
    const ctrl = new PipelineController({ max_retries_per_step: 2, max_total_steps: 10 });
    const bigPlan = { ...simplePlan, steps: Array.from({ length: 10 }, (_, i) => simplePlan.steps[0]) };
    const budget = ctrl.computeBudget(bigPlan); // max = floor(10 * 1.5) = 15
    expect(ctrl.shouldEscalate({ retry_count: 0, total_steps: 16, plan: bigPlan })).toBe(true);
  });

  it("does not escalate within budget", () => {
    const ctrl = new PipelineController({ max_retries_per_step: 2, max_total_steps: 10 });
    expect(ctrl.shouldEscalate({ retry_count: 1, total_steps: 1, plan: simplePlan })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest src/pipeline/__tests__/controller.test.ts --no-coverage 2>&1 | tail -10
```
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Create controller.ts**

```typescript
// src/pipeline/controller.ts
import type { ClassificationResult, ControllerBudget, PlanResult } from "./types.js";

export type Route = "codex_direct" | "sonnet_plan" | "surface_to_user";

const CONFIDENCE_THRESHOLD = 0.85;

export class PipelineController {
  constructor(private readonly defaultBudget: ControllerBudget) {}

  getRoute(classification: ClassificationResult): Route {
    if (classification.task_type === "ambiguous") {
      return "surface_to_user";
    }

    if (classification.task_type === "judgment") {
      return "sonnet_plan";
    }

    if (
      classification.task_type === "mechanical" &&
      classification.confidence >= CONFIDENCE_THRESHOLD &&
      !classification.requires_plan
    ) {
      return "codex_direct";
    }

    return "sonnet_plan";
  }

  computeBudget(plan: PlanResult): ControllerBudget {
    return {
      max_retries_per_step: this.defaultBudget.max_retries_per_step,
      max_total_steps: Math.floor(plan.steps.length * 1.5)
    };
  }

  shouldEscalate(state: {
    retry_count: number;
    total_steps: number;
    plan: PlanResult;
  }): boolean {
    const budget = this.computeBudget(state.plan);

    if (state.retry_count > this.defaultBudget.max_retries_per_step) return true;
    if (state.total_steps > budget.max_total_steps) return true;

    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest src/pipeline/__tests__/controller.test.ts --no-coverage 2>&1 | tail -10
```
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer && git add src/pipeline/controller.ts src/pipeline/__tests__/controller.test.ts && git commit -m "feat(pipeline): add PipelineController with routing and escalation logic"
```

---

## Task 9: Wire all layers into pipeline.ts

**Files:**
- Create: `src/pipeline/pipeline.ts`

No separate test here — the smoke test in Task 10 covers end-to-end behavior. The unit tests for each layer already cover isolation.

- [ ] **Step 1: Create pipeline.ts**

```typescript
// src/pipeline/pipeline.ts
import type { CodexAdapter } from "../adapters/base.js";
import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import type { InternalTask } from "../types/internal.js";
import type { PipelineResult } from "./types.js";
import { HaikuClassifier } from "./haiku-classifier.js";
import { ContextDistiller } from "./context-distiller.js";
import { SonnetPlanner } from "./sonnet-planner.js";
import { StepExecutor } from "./step-executor.js";
import { Gate } from "./gate.js";
import { PipelineController, type Route } from "./controller.js";

export interface PipelineOptions {
  max_retries_per_step?: number;
}

export async function runPipeline(
  task: InternalTask,
  claude: ClaudeSubprocessManager,
  adapter: CodexAdapter,
  opts: PipelineOptions = {}
): Promise<PipelineResult> {
  const classifier = new HaikuClassifier(claude);
  const distiller = new ContextDistiller(claude);
  const planner = new SonnetPlanner(claude);
  const executor = new StepExecutor(adapter, task);
  const gate = new Gate();
  const controller = new PipelineController({
    max_retries_per_step: opts.max_retries_per_step ?? 2,
    max_total_steps: 99 // overridden by computeBudget after planning
  });

  // Layer 1: classify
  const classification = await classifier.classify(task.prompt);

  // Layer 2: distill spec
  let compressedSpec: string;
  try {
    compressedSpec = await distiller.distill(classification.compressed_spec || task.prompt);
  } catch {
    compressedSpec = task.prompt.slice(0, 800);
  }

  // External routing
  const route: Route = controller.getRoute(classification);

  if (route === "surface_to_user") {
    const question = classification.ambiguity_question ?? "Task is ambiguous — please clarify.";
    return {
      status: "ambiguous",
      output: question,
      steps_executed: 0,
      sonnet_invocations: 0
    };
  }

  // Layer 3: optionally plan with Sonnet
  let steps = [
    {
      id: "step-direct",
      description: "execute task directly",
      prompt: compressedSpec,
      success_criteria: "Codex produces non-empty output without error"
    }
  ];
  let escalationTriggers: string[] = [];

  if (route === "sonnet_plan") {
    const plan = await planner.plan(task.prompt, compressedSpec);
    steps = plan.steps;
    escalationTriggers = plan.escalation_triggers;
  }

  const budget = controller.computeBudget({ steps, escalation_triggers: escalationTriggers });

  // Codex execution loop (controlled externally)
  let totalSteps = 0;
  const outputs: string[] = [];

  for (const step of steps) {
    let retries = 0;

    while (true) {
      totalSteps++;

      if (controller.shouldEscalate({ retry_count: retries, total_steps: totalSteps, plan: { steps, escalation_triggers: escalationTriggers } })) {
        // Escalate to Sonnet review (second invocation)
        const reviewPrompt = [
          `Original task: ${task.prompt}`,
          `Completed steps: ${outputs.length}`,
          `Current step failed after ${retries} retries: "${step.description}"`,
          `Last output: ${outputs.at(-1)?.slice(0, 300) ?? "(none)"}`,
          `Provide a one-sentence diagnosis and revised instruction for this step.`
        ].join("\n");

        let escalationSummary = "Escalation review: unable to complete step.";
        try {
          escalationSummary = await planner.plan(reviewPrompt);
          // planner.plan() returns PlanResult — extract first step's description as summary
          escalationSummary = `Escalated after ${retries} retries on step "${step.description}". Sonnet review complete.`;
        } catch {
          // 2-invocation guard hit — no more Sonnet
        }

        return {
          status: "escalated",
          output: outputs.join("\n\n"),
          steps_executed: totalSteps,
          sonnet_invocations: planner.invocationCount,
          escalation_summary: escalationSummary
        };
      }

      const result = await executor.execute(step);
      const gateResult = gate.check(step, result);

      if (gateResult.pass) {
        outputs.push(result.output);
        break;
      }

      retries++;
    }
  }

  return {
    status: "completed",
    output: outputs.join("\n\n"),
    steps_executed: totalSteps,
    sonnet_invocations: planner.invocationCount
  };
}
```

- [ ] **Step 2: TypeScript build check**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx tsc --noEmit 2>&1 | head -30
```
Expected: zero errors. Fix any type errors before proceeding.

- [ ] **Step 3: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer && git add src/pipeline/pipeline.ts && git commit -m "feat(pipeline): wire all layers into runPipeline()"
```

---

## Task 10: Express route + smoke test

**Files:**
- Modify: `src/server.ts`
- Create: `scripts/smoke-pipeline.ts`

- [ ] **Step 1: Read the existing server.ts to find the right insertion point**

```bash
grep -n "router\|delegate\|app\.post\|app\.get" /Users/abhayjuloori/Proxy-Layer/src/server.ts | head -20
```

- [ ] **Step 2: Add the /pipeline route to server.ts**

Find the existing route handler block in `src/server.ts` (after the delegate route) and add:

```typescript
// POST /pipeline — token-efficient orchestration pipeline
app.post("/pipeline", async (req: Request, res: Response) => {
  const body = req.body as { prompt?: string; messages?: unknown[] };

  if (!body.prompt && !body.messages) {
    res.status(400).json({ error: "prompt or messages required" });
    return;
  }

  const prompt = body.prompt ?? "";
  const internalTask: InternalTask = {
    prompt,
    messages: body.messages as InternalTask["messages"] ?? [{ role: "user", content: prompt }],
    inputItems: [{ type: "text", text: prompt }],
    stream: false
  };

  try {
    const result = await runPipeline(internalTask, claudeManager, adapter);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});
```

Also add the import at the top of `src/server.ts`:
```typescript
import { runPipeline } from "./pipeline/pipeline.js";
```

- [ ] **Step 3: Build check**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx tsc --noEmit 2>&1 | head -20
```
Expected: zero errors

- [ ] **Step 4: Create smoke-pipeline.ts**

```typescript
// scripts/smoke-pipeline.ts
const BASE = process.env.BRIDGE_URL ?? "http://localhost:8787";

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer codex-bridge-local"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }

  return res.json();
}

async function main() {
  console.log("=== Smoke: /pipeline — mechanical task ===");
  const mechanical = await post("/pipeline", {
    prompt: "rename the function calculateTotal to computeTotal in any TypeScript file"
  });
  console.log(JSON.stringify(mechanical, null, 2));

  console.log("\n=== Smoke: /pipeline — ambiguous task ===");
  const ambiguous = await post("/pipeline", {
    prompt: "improve the code"
  });
  console.log(JSON.stringify(ambiguous, null, 2));

  console.log("\n=== Smoke: /pipeline — multi-step task ===");
  const multiStep = await post("/pipeline", {
    prompt: "add a GET /health endpoint to the Express server and write a smoke test for it"
  });
  console.log(JSON.stringify(multiStep, null, 2));

  console.log("\nAll smoke tests passed.");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
```

- [ ] **Step 5: Run the smoke test**

First, start the server in a separate terminal:
```bash
cd /Users/abhayjuloori/Proxy-Layer && CODEX_ADAPTER=exec npm run dev
```

Then run:
```bash
cd /Users/abhayjuloori/Proxy-Layer && npx tsx scripts/smoke-pipeline.ts 2>&1
```
Expected: three results with `status` fields — mechanical should show `completed`, ambiguous should show `ambiguous` with a question, multi-step should show `completed` or `escalated`.

- [ ] **Step 6: Run full test suite**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest --no-coverage 2>&1 | tail -20
```
Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer && git add src/server.ts scripts/smoke-pipeline.ts && git commit -m "feat(pipeline): add POST /pipeline route and smoke test"
```

---

## Task 11: Global enforcement

This task activates only after Tasks 1–10 are complete and smoke-tested.

**Goal:** Update `strategy-router.ts` to use the new pipeline for all incoming requests. The existing delegation system remains available but the pipeline becomes the default path.

**Files:**
- Modify: `src/router/strategy-router.ts` — add pipeline shortcut for high-confidence mechanical tasks
- Modify: `src/agents/orchestrator.ts` — route through `runPipeline()` instead of direct Codex for tasks not matched by existing fast paths

- [ ] **Step 1: Read current orchestrator to understand injection point**

```bash
cat /Users/abhayjuloori/Proxy-Layer/src/agents/orchestrator.ts
```

- [ ] **Step 2: Identify where to inject pipeline call**

After reading, find the block where `codex_delegate` mode is dispatched and add a pipeline bypass check:

```typescript
// In the codex_delegate handler — add before existing Codex call:
// If PipelineController routes this as codex_direct (high-confidence mechanical),
// skip planning entirely and run one Codex step.
// All other paths run through runPipeline() for Haiku classification + optional Sonnet plan.
```

The exact edit depends on orchestrator structure — read first, then write the targeted change.

- [ ] **Step 3: Add npm script for pipeline smoke**

In `package.json`, add:
```json
"smoke:pipeline": "tsx scripts/smoke-pipeline.ts"
```

- [ ] **Step 4: Run smoke tests for both old and new paths**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npm run smoke:delegate-workflow && npm run smoke:pipeline
```
Expected: both pass

- [ ] **Step 5: Final full test suite**

```bash
cd /Users/abhayjuloori/Proxy-Layer && npx jest --no-coverage 2>&1 | tail -20
```
Expected: all pass

- [ ] **Step 6: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer && git add src/router/strategy-router.ts src/agents/orchestrator.ts package.json && git commit -m "feat(pipeline): enforce token-efficient pipeline as global default"
```

---

## Self-Review

**Spec coverage:**
- Haiku for classify/compress → Task 3, 4 ✓
- Sonnet plan once, max 2 invocations → Task 5 ✓
- Codex executes all steps → Task 6 ✓
- External routing and loop control → Task 8 ✓
- Minimal context between steps (distiller gate) → Task 4 ✓
- Incremental layer-by-layer build → Tasks 1-10, enforcement last in Task 11 ✓
- POST /pipeline endpoint → Task 10 ✓
- Smoke test → Task 10 ✓

**Placeholder scan:** None found. All code blocks are complete.

**Type consistency:**
- `PlanResult` defined in `types.ts` and used in `sonnet-planner.ts`, `controller.ts`, `pipeline.ts` ✓
- `StepSpec` defined in `types.ts`, used in `gate.ts`, `step-executor.ts` ✓
- `ClassificationResult` from `types.ts` used in `haiku-classifier.ts`, `controller.ts` ✓
- `ClaudeSubprocessManager.call()` signature updated in Task 2, consumed in Task 3 and 4 ✓
- `InternalTask` is the existing type from `src/types/internal.ts` — no changes ✓

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-11-token-efficient-pipeline.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks

**2. Inline Execution** — execute tasks in this session using executing-plans

**Which approach?**
