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
    if (result.status === "empty") {
      return { pass: false, reason: "Codex returned empty output" };
    }
    if (result.status === "failure") {
      return { pass: false, reason: `Codex execution failure: ${result.output.slice(0, 100)}` };
    }

    for (const pattern of ERROR_SIGNALS) {
      if (pattern.test(result.output)) {
        return { pass: false, reason: `Output contains error signal matching: ${pattern}` };
      }
    }

    // Deterministic "output contains X" check
    const containsMatch = step.success_criteria.match(/output contains ['"](.+?)['"]/i);
    if (containsMatch) {
      const expected = containsMatch[1];
      if (!result.output.includes(expected)) {
        return { pass: false, reason: `Criteria not met: output does not contain "${expected}"` };
      }
    }

    return { pass: true, reason: "Output is non-empty, clean, and meets criteria" };
  }
}
