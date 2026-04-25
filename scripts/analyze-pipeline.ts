/**
 * Pipeline analysis harness — no pipeline code changes.
 * Calls layers directly with instrumentation to observe routing decisions,
 * compression behavior, and classification quality.
 */
import { loadConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { ClaudeSubprocessManager } from "../src/claude/subprocess.js";
import { HaikuClassifier } from "../src/pipeline/haiku-classifier.js";
import { HaikuClarifier } from "../src/pipeline/haiku-clarifier.js";
import { ContextDistiller, estimateTokens } from "../src/pipeline/context-distiller.js";
import { SonnetPlanner } from "../src/pipeline/sonnet-planner.js";
import { Gate } from "../src/pipeline/gate.js";
import { PipelineController } from "../src/pipeline/controller.js";
import type { StepSpec, StepExecutionResult } from "../src/pipeline/types.js";

const config = loadConfig();
const logger = new Logger(config);
const claude = new ClaudeSubprocessManager(config, logger);
const classifier = new HaikuClassifier(claude);
const distiller = new ContextDistiller(claude);
const gate = new Gate();
const controller = new PipelineController({ max_retries_per_step: 2, max_total_steps: 99 });

// ── Test prompts ──────────────────────────────────────────────────────────────

const TEST_PROMPTS = [
  // Expected: mechanical / codex_direct
  { label: "rename fn",          prompt: "rename the function calculateTotal to computeTotal in src/utils.ts" },
  { label: "add console.log",    prompt: "add a console.log('starting') to the top of src/index.ts" },
  // Expected: multi_step / sonnet_plan
  { label: "auth middleware",    prompt: "add JWT authentication middleware to the Express server and protect the /v1/messages route" },
  { label: "refactor config",    prompt: "refactor the config system to load all settings from environment variables instead of the JSON file" },
  // Expected: judgment / sonnet_plan
  { label: "REST vs GraphQL",   prompt: "should I use REST or GraphQL for this API? evaluate tradeoffs" },
  { label: "cache tradeoffs",   prompt: "evaluate the current caching approach and recommend improvements" },
  // Expected: ambiguous / surface_to_user
  { label: "improve code",      prompt: "improve the code" },
  { label: "fix the bug",       prompt: "fix the bug" },
  // Tricky classification edges
  { label: "refactor auth",     prompt: "refactor the authentication flow" },
  { label: "optimize perf",     prompt: "optimize performance" },
  { label: "update README",     prompt: "update the README" },
  { label: "add error handling", prompt: "add error handling" },
];

// ── Gate tests ────────────────────────────────────────────────────────────────

const GATE_CASES: Array<{ label: string; step: StepSpec; result: StepExecutionResult }> = [
  {
    label: "clean success",
    step: { id: "s1", description: "rename fn", prompt: "...", success_criteria: "output contains 'computeTotal'" },
    result: { step_id: "s1", output: "Renamed calculateTotal → computeTotal in utils.ts", status: "success" }
  },
  {
    label: "criteria miss",
    step: { id: "s2", description: "rename fn", prompt: "...", success_criteria: "output contains 'computeTotal'" },
    result: { step_id: "s2", output: "Made changes to the file", status: "success" }
  },
  {
    label: "node TypeError in output",
    step: { id: "s3", description: "run step", prompt: "...", success_criteria: "non-empty output" },
    result: { step_id: "s3", output: "TypeError: Cannot read properties of undefined (reading 'foo')", status: "success" }
  },
  {
    label: "partial success with warning",
    step: { id: "s4", description: "add middleware", prompt: "...", success_criteria: "non-empty output" },
    result: { step_id: "s4", output: "Added middleware. Warning: route /admin not protected yet.", status: "success" }
  },
  {
    label: "false error — contains 'error' in context",
    step: { id: "s5", description: "describe error", prompt: "...", success_criteria: "non-empty output" },
    result: { step_id: "s5", output: "The previous error was a type mismatch. Fixed by casting to string.", status: "success" }
  },
  {
    label: "empty output",
    step: { id: "s6", description: "do nothing", prompt: "...", success_criteria: "non-empty" },
    result: { step_id: "s6", output: "", status: "empty" }
  },
];

// ── Context distiller tests ───────────────────────────────────────────────────

const DISTILLER_CASES = [
  { label: "short (pass-through)",   text: "rename foo to bar" },
  { label: "~400 tokens (compress)", text: "x".repeat(1600) },
  { label: "code block 500 tokens",  text: `function authenticate(req, res, next) {\n${"  // lots of code\n".repeat(80)}}` },
];

// ── Clarifier tests ──────────────────────────────────────────────────────────

const CLARIFIER_CASES = [
  {
    label: "non-question output",
    originalTask: "rename calculateTotal to computeTotal",
    codexOutput: "Done. Renamed the function in src/utils.ts.",
    expected: "not_question"
  },
  {
    label: "question Haiku CAN answer",
    originalTask: "Create /tmp/smoke-clarify-4.ts with exported greet(name) returning Hello name",
    codexOutput: "Should I create this file in /tmp or in the current working directory?",
    expected: "answered"
  },
  {
    label: "question Haiku CANNOT answer",
    originalTask: "Update the HTTP client to call the new internal logging endpoint",
    codexOutput: "Which endpoint URL and request schema should I use for the logging service?",
    expected: "needs_user"
  },
  {
    label: "ends with question mark",
    originalTask: "add logging to runPipeline",
    codexOutput: "I can add logging. Should I use debug level or info level?",
    expected: "answered"
  },
];

// ── Runner ────────────────────────────────────────────────────────────────────

async function runClassification() {
  console.log("\n═══════════════════════════════════════════");
  console.log("SECTION 1: Classification (Haiku → route)");
  console.log("═══════════════════════════════════════════");

  for (const { label, prompt } of TEST_PROMPTS) {
    process.stdout.write(`\n[${label}]\n  prompt: "${prompt.slice(0, 70)}"\n`);
    try {
      const result = await classifier.classify(prompt);
      const route = controller.getRoute(result);
      console.log(`  task_type:      ${result.task_type}`);
      console.log(`  confidence:     ${result.confidence}`);
      console.log(`  requires_plan:  ${result.requires_plan}`);
      console.log(`  → route:        ${route}`);
      console.log(`  compressed_spec: "${result.compressed_spec.slice(0, 100)}"`);
      if (result.ambiguity_question) {
        console.log(`  ambiguity_q:   "${result.ambiguity_question}"`);
      }
    } catch (err) {
      console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function runGateAnalysis() {
  console.log("\n═══════════════════════════════════════════");
  console.log("SECTION 2: Gate false positives/negatives");
  console.log("═══════════════════════════════════════════");

  for (const { label, step, result } of GATE_CASES) {
    const gateResult = gate.check(step, result);
    const verdict = gateResult.pass ? "✓ PASS" : "✗ FAIL";
    console.log(`\n  [${label}]`);
    console.log(`  output: "${result.output.slice(0, 80)}"`);
    console.log(`  criteria: "${step.success_criteria}"`);
    console.log(`  gate: ${verdict} — ${gateResult.reason}`);
  }
}

async function runDistillerAnalysis() {
  console.log("\n═══════════════════════════════════════════");
  console.log("SECTION 3: Context distillation");
  console.log("═══════════════════════════════════════════");

  for (const { label, text } of DISTILLER_CASES) {
    const inputTokens = estimateTokens(text);
    process.stdout.write(`\n  [${label}] input: ${inputTokens} tokens\n`);
    try {
      const result = await distiller.distill(text);
      const outputTokens = estimateTokens(result.content);
      const ratio = (outputTokens / inputTokens * 100).toFixed(0);
      console.log(`  output: ${outputTokens} tokens (${ratio}% of input), compressed=${result.compressed}`);
      if (result.compressionError) console.log(`  compressionError: ${result.compressionError}`);
      if (result.compressed) {
        console.log(`  compressed: "${result.content.slice(0, 120)}..."`);
      } else {
        console.log(`  pass-through (no compression)`);
      }
    } catch (err) {
      console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function runPlannerSample() {
  console.log("\n═══════════════════════════════════════════");
  console.log("SECTION 4: Sonnet plan quality (2 samples)");
  console.log("═══════════════════════════════════════════");

  const planner = new SonnetPlanner(claude);

  const cases = [
    { label: "auth middleware", prompt: "add JWT authentication middleware to Express server" },
    { label: "multi-file refactor", prompt: "refactor the config system to use environment variables" },
  ];

  for (const { label, prompt } of cases) {
    console.log(`\n  [${label}]`);
    try {
      const plan = await planner.plan(prompt);
      console.log(`  steps: ${plan.steps.length}`);
      plan.steps.forEach((s, i) => {
        console.log(`    step-${i+1}: ${s.description}`);
        console.log(`      criteria: "${s.success_criteria.slice(0, 80)}"`);
      });
      console.log(`  escalation_triggers: ${JSON.stringify(plan.escalation_triggers)}`);
    } catch (err) {
      console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n  invocation_count: ${planner.invocationCount} / 2`);
}

async function runClarifierAnalysis() {
  console.log("\n═══════════════════════════════════════════");
  console.log("SECTION 5: Clarification handling (Haiku)");
  console.log("═══════════════════════════════════════════");

  const clarifier = new HaikuClarifier(claude);

  for (const { label, originalTask, codexOutput, expected } of CLARIFIER_CASES) {
    console.log(`\n  [${label}]`);
    console.log(`  expected: ${expected}`);
    try {
      const result = await clarifier.clarify(originalTask, codexOutput);
      console.log(`  type: ${result.type}`);
      if (result.type === "answered") {
        console.log(`  answer: "${result.answer}"`);
      } else if (result.type === "needs_user") {
        console.log(`  question: "${result.question}"`);
      } else {
        console.log("  answer/question: n/a");
      }
    } catch (err) {
      console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function main() {
  console.log("Pipeline Analysis Harness");
  console.log("Proxy-Layer @ " + config.codex.cwd);

  await runClassification();
  runGateAnalysis();  // sync — no network
  await runDistillerAnalysis();
  await runPlannerSample();
  await runClarifierAnalysis();

  console.log("\n═══════════════════════════════════════════");
  console.log("DONE");
  console.log("═══════════════════════════════════════════\n");
}

main().catch(err => { console.error(err); process.exit(1); });
