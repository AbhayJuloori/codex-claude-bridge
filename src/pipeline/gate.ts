import type { StepSpec, StepExecutionResult, GateResult } from "./types.js";

// Fix #8: expanded to cover common Node.js / runtime error patterns
const ERROR_SIGNALS = [
  /^error:/im,
  /\buncaught\b/i,
  /\bfatal\b/i,
  /\bsegfault\b/i,
  /\bcannot find module\b/i,
  /\bmodule not found\b/i,
  /\bsyntaxerror\b/i,
  /\btypeerror\b/i,
  /\breferenceerror\b/i,
  /\brangeerror\b/i,
  /\benoent\b/i,            // no such file or directory
  /\beperm\b/i,             // operation not permitted
  /\beacces\b/i,            // permission denied
  /\bcommand not found\b/i,
  /\bnot found\b.*error/i,
  /\bprocess exited with code [^0]/i,
  /\bcompilation failed\b/i,
  /\bbuild failed\b/i,
];

// Fix #4: partial-completion signals — work was explicitly deferred or left incomplete
const INCOMPLETE_SIGNALS = [
  /\bnot (yet implemented|yet done|implemented|complete[d]?)\b/i,
  /\bstill needs?\b/i,
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bremains? (unimplemented|incomplete|to be done)\b/i,
  /\bleft as an exercise\b/i,
];

export class Gate {
  check(step: StepSpec, result: StepExecutionResult): GateResult {
    // 1. Status checks
    if (result.status === "empty") {
      return { pass: false, reason: "Codex returned empty output" };
    }
    if (result.status === "failure") {
      return { pass: false, reason: `Codex execution failure: ${result.output.slice(0, 100)}` };
    }

    // 2. Error signal scan
    for (const pattern of ERROR_SIGNALS) {
      if (pattern.test(result.output)) {
        return { pass: false, reason: `Output contains error signal: ${pattern}` };
      }
    }

    // 3. Fix #4: Partial completion scan
    for (const pattern of INCOMPLETE_SIGNALS) {
      if (pattern.test(result.output)) {
        return { pass: false, reason: `Output signals incomplete work: ${pattern}` };
      }
    }

    // 4. Fix #6: success_criteria parsing — support multiple formats
    const gateFromCriteria = evaluateCriteria(step.success_criteria, result.output);
    if (gateFromCriteria !== null) return gateFromCriteria;

    return { pass: true, reason: "Output is non-empty, clean, and meets criteria" };
  }
}

/**
 * Fix #6: Evaluate structured criteria formats.
 * Returns a GateResult if a recognized format is matched, null if unrecognized
 * (caller treats unrecognized criteria as "passed by default" since no
 * deterministic check is possible).
 *
 * Supported formats:
 *   output contains 'X'         — X must appear in output
 *   output does not contain 'X' — X must not appear in output
 *   output contains "X"         — same, double-quote variant
 */
function evaluateCriteria(criteria: string, output: string): GateResult | null {
  // "output contains 'X'" or "output contains "X""
  const containsMatch = criteria.match(/output contains ['"](.+?)['"]/i);
  if (containsMatch) {
    const expected = containsMatch[1];
    if (!output.includes(expected)) {
      return { pass: false, reason: `Criteria not met: output does not contain "${expected}"` };
    }
    return { pass: true, reason: `Criteria met: output contains "${expected}"` };
  }

  // "output does not contain 'X'"
  const notContainsMatch = criteria.match(/output does not contain ['"](.+?)['"]/i);
  if (notContainsMatch) {
    const forbidden = notContainsMatch[1];
    if (output.includes(forbidden)) {
      return { pass: false, reason: `Criteria not met: output still contains "${forbidden}"` };
    }
    return { pass: true, reason: `Criteria met: output does not contain "${forbidden}"` };
  }

  // Unrecognized format — no deterministic check possible
  return null;
}
