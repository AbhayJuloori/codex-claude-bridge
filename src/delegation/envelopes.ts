import type { InternalTask } from "../types/internal.js";
import type { CodexExecutionMode, ExecutionStrategyMode } from "../orchestrator/types.js";

function flattenMessageContent(content: InternalTask["messages"][number]["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((block) => {
      if ("text" in block && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function latestUserRequest(task: InternalTask): string {
  const reversed = [...task.messages].reverse();
  const latest = reversed.find((message) => message.role === "user");
  return latest ? flattenMessageContent(latest.content) : task.prompt;
}

function guessFileScope(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g) ?? [];
  return Array.from(new Set(matches)).slice(0, 12);
}

export function buildImplementationEnvelope(
  task: InternalTask,
  mode: CodexExecutionMode
): string {
  const request = latestUserRequest(task);
  const fileScope = guessFileScope(request);

  return [
    `Execution mode: ${mode}`,
    "You are the Codex worker inside a Claude-manager/Codex-worker runtime.",
    "You may use the bridge-native tools to inspect, edit, write files, and run commands as needed.",
    "Do the work directly when it is mechanical or implementation-heavy.",
    "Return a compressed implementation packet only, inside a single ```bridge-packet fenced JSON block.",
    'Use this JSON shape: {"type":"implementation_result","mode":"implement","task":"...","status":"completed|partial|failed","filesChanged":["..."],"summary":["..."],"commandsRun":["..."],"keyDecisions":["..."],"warnings":["..."],"suggestedNextStep":"...","diffSummary":["..."],"confidence":0.0}',
    "Do not return the raw full transcript.",
    `Task statement:\n${request}`,
    fileScope.length ? `Likely file scope:\n${fileScope.map((item) => `- ${item}`).join("\n")}` : null,
    "Acceptance criteria:",
    "- Complete the requested implementation as far as practical.",
    "- Keep the packet compact and factual.",
    "- Include warnings for anything unresolved."
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildReviewEnvelope(
  task: InternalTask,
  mode: "review" | "adversarial_review"
): string {
  const request = latestUserRequest(task);
  const fileScope = guessFileScope(request);

  return [
    `Execution mode: ${mode}`,
    "You are the Codex reviewer inside a Claude-manager/Codex-worker runtime.",
    mode === "adversarial_review"
      ? "Be skeptical and try to break assumptions, find hidden regressions, security issues, and failure modes."
      : "Focus on bug risks, regressions, missing tests, and actionable review findings.",
    "Prefer read-only inspection. Do not mutate files unless explicitly asked.",
    "Return a compressed review packet only, inside a single ```bridge-packet fenced JSON block.",
    'Use this JSON shape: {"type":"review_result","mode":"review|adversarial_review","task":"...","findings":[{"severity":"critical|high|medium|low","title":"...","file":"...","line":1,"summary":"...","suggestedFix":"..."}],"bugRisks":["..."],"regressionRisks":["..."],"securityConcerns":["..."],"missingTests":["..."],"openQuestions":["..."],"recommendation":"...","confidence":0.0}',
    "Findings should be ordered by severity.",
    `Review target:\n${request}`,
    fileScope.length ? `Likely file scope:\n${fileScope.map((item) => `- ${item}`).join("\n")}` : null
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildRefinementEnvelope(
  originalTask: InternalTask,
  packetText: string
): string {
  const request = latestUserRequest(originalTask);
  return [
    "Execution mode: refine",
    "You are performing a manager-side refinement pass using only a compressed worker packet.",
    "You may selectively inspect changed files with read-only tools if needed.",
    "Return a concise final user-facing answer, not a packet.",
    "If the worker packet already looks good, accept it and summarize clearly.",
    `Original user request:\n${request}`,
    `Worker implementation packet:\n${packetText}`
  ].join("\n\n");
}

export function buildJudgmentEnvelope(
  originalTask: InternalTask,
  packetText: string
): string {
  const request = latestUserRequest(originalTask);
  return [
    "Execution mode: judge",
    "You are producing a final judgment over a compressed review packet.",
    "Return a concise findings-first final judgment for the human reader.",
    "Prioritize the strongest findings and suppress weak noise.",
    `Original review request:\n${request}`,
    `Compressed review packet:\n${packetText}`
  ].join("\n\n");
}

export function wantsWriteAccess(mode: ExecutionStrategyMode): boolean {
  return mode === "codex_delegate" || mode === "codex_then_claude_refine";
}
