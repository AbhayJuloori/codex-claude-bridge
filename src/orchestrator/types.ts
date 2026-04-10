export type ExecutionStrategyMode =
  | "claude_direct"
  | "codex_delegate"
  | "codex_then_claude_refine"
  | "codex_review"
  | "codex_adversarial_review"
  | "codex_review_then_claude_judgment";

export type CodexExecutionMode =
  | "inspect"
  | "implement"
  | "refactor"
  | "review"
  | "adversarial_review"
  | "generate_tests"
  | "scaffold_ui"
  | "patch_fix"
  | "refine"
  | "judge";

export interface StrategyDecision {
  mode: ExecutionStrategyMode;
  rationale: string[];
}

export interface ImplementationResultPacket {
  type: "implementation_result";
  mode: CodexExecutionMode;
  task: string;
  status: "completed" | "partial" | "failed";
  filesChanged: string[];
  summary: string[];
  commandsRun: string[];
  keyDecisions: string[];
  warnings: string[];
  suggestedNextStep: string | null;
  diffSummary: string[];
  confidence: number | null;
}

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  file?: string;
  line?: number;
  summary: string;
  suggestedFix?: string;
}

export interface ReviewResultPacket {
  type: "review_result";
  mode: "review" | "adversarial_review";
  task: string;
  findings: ReviewFinding[];
  bugRisks: string[];
  regressionRisks: string[];
  securityConcerns: string[];
  missingTests: string[];
  openQuestions: string[];
  recommendation: string;
  confidence: number | null;
}

export interface JudgmentPacket {
  type: "judgment_result";
  sourceMode: "review" | "adversarial_review";
  topFindings: ReviewFinding[];
  droppedFindings: string[];
  recommendation: string;
  mergeVerdict: "merge" | "needs_changes" | "investigate";
  finalSummary: string;
}

export interface DelegateProgressEvent {
  type: "delegate-progress";
  event:
    | { kind: "phase-start"; phaseId: string; phaseName: string; taskCount: number }
    | { kind: "task-start"; phaseId: string; taskId: string }
    | { kind: "task-complete"; phaseId: string; taskId: string; status: string; claudeRewritten: boolean }
    | { kind: "gate-verdict"; phaseId: string; verdict: string }
    | { kind: "phase-complete"; phaseId: string; summary: string }
    | { kind: "delegate-complete"; totalTasks: number; claudeRewrites: number };
}
