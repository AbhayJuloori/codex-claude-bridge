import type {
  ImplementationResultPacket,
  JudgmentPacket,
  ReviewResultPacket,
  ReviewFinding
} from "./types.js";

const PACKET_RE = /```bridge-packet\s*([\s\S]*?)```/i;

export function parseBridgePacket(text: string): Record<string, unknown> | null {
  const match = text.match(PACKET_RE);
  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1].trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function ensureStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function ensureNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeFinding(item: unknown): ReviewFinding | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const candidate = item as Record<string, unknown>;
  const severity = typeof candidate.severity === "string" ? candidate.severity : "medium";
  const title = typeof candidate.title === "string" ? candidate.title : null;
  const summary = typeof candidate.summary === "string" ? candidate.summary : null;
  if (!title || !summary) {
    return null;
  }

  return {
    severity:
      severity === "critical" || severity === "high" || severity === "medium" || severity === "low"
        ? severity
        : "medium",
    title,
    file: typeof candidate.file === "string" ? candidate.file : undefined,
    line: ensureNumber(candidate.line),
    summary,
    suggestedFix:
      typeof candidate.suggestedFix === "string" ? candidate.suggestedFix : undefined
  };
}

export function parseImplementationPacket(text: string): ImplementationResultPacket | null {
  const packet = parseBridgePacket(text);
  if (!packet || packet.type !== "implementation_result") {
    return null;
  }

  return {
    type: "implementation_result",
    mode:
      typeof packet.mode === "string"
        ? (packet.mode as ImplementationResultPacket["mode"])
        : "implement",
    task: typeof packet.task === "string" ? packet.task : "unspecified task",
    status:
      packet.status === "completed" || packet.status === "partial" || packet.status === "failed"
        ? packet.status
        : "partial",
    filesChanged: ensureStringArray(packet.filesChanged),
    summary: ensureStringArray(packet.summary),
    commandsRun: ensureStringArray(packet.commandsRun),
    keyDecisions: ensureStringArray(packet.keyDecisions),
    warnings: ensureStringArray(packet.warnings),
    suggestedNextStep:
      typeof packet.suggestedNextStep === "string" ? packet.suggestedNextStep : null,
    diffSummary: ensureStringArray(packet.diffSummary),
    confidence: typeof packet.confidence === "number" ? packet.confidence : null
  };
}

export function parseReviewPacket(text: string): ReviewResultPacket | null {
  const packet = parseBridgePacket(text);
  if (!packet || packet.type !== "review_result") {
    return null;
  }

  const findings = Array.isArray(packet.findings)
    ? packet.findings.map(normalizeFinding).filter((item): item is ReviewFinding => Boolean(item))
    : [];

  return {
    type: "review_result",
    mode:
      packet.mode === "adversarial_review" ? "adversarial_review" : "review",
    task: typeof packet.task === "string" ? packet.task : "unspecified review task",
    findings,
    bugRisks: ensureStringArray(packet.bugRisks),
    regressionRisks: ensureStringArray(packet.regressionRisks),
    securityConcerns: ensureStringArray(packet.securityConcerns),
    missingTests: ensureStringArray(packet.missingTests),
    openQuestions: ensureStringArray(packet.openQuestions),
    recommendation:
      typeof packet.recommendation === "string" ? packet.recommendation : "Review completed.",
    confidence: typeof packet.confidence === "number" ? packet.confidence : null
  };
}

export function renderImplementationPacket(packet: ImplementationResultPacket): string {
  const lines: string[] = [];
  lines.push(`Status: ${packet.status}`);
  if (packet.summary.length) {
    lines.push("Summary:");
    for (const item of packet.summary) {
      lines.push(`- ${item}`);
    }
  }
  if (packet.filesChanged.length) {
    lines.push("Files changed:");
    for (const file of packet.filesChanged) {
      lines.push(`- ${file}`);
    }
  }
  if (packet.warnings.length) {
    lines.push("Warnings:");
    for (const warning of packet.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  if (packet.suggestedNextStep) {
    lines.push(`Next step: ${packet.suggestedNextStep}`);
  }
  return lines.join("\n");
}

function severityRank(severity: ReviewFinding["severity"]): number {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
  }
}

export function buildJudgmentPacket(packet: ReviewResultPacket): JudgmentPacket {
  const sorted = [...packet.findings].sort(
    (left, right) => severityRank(left.severity) - severityRank(right.severity)
  );
  const topFindings = sorted.slice(0, 5);
  const droppedFindings = sorted.slice(5).map((finding) => finding.title);
  const severeCount = sorted.filter(
    (finding) => finding.severity === "critical" || finding.severity === "high"
  ).length;
  const mergeVerdict =
    severeCount > 0 ? "needs_changes" : sorted.length > 0 ? "investigate" : "merge";
  const recommendation =
    mergeVerdict === "merge"
      ? "No blocking findings were identified."
      : mergeVerdict === "needs_changes"
        ? "Address the top findings before merging."
        : "Investigate medium-risk findings before deciding.";

  const finalSummary = [
    ...topFindings.map((finding) => {
      const location =
        finding.file && finding.line
          ? `${finding.file}:${finding.line}`
          : finding.file ?? null;
      return `- [${finding.severity}] ${finding.title}${location ? ` (${location})` : ""}: ${finding.summary}`;
    }),
    topFindings.length === 0 ? "- No actionable findings." : null
  ]
    .filter(Boolean)
    .join("\n");

  return {
    type: "judgment_result",
    sourceMode: packet.mode,
    topFindings,
    droppedFindings,
    recommendation,
    mergeVerdict,
    finalSummary
  };
}

export function renderJudgmentPacket(packet: JudgmentPacket): string {
  return [
    `Verdict: ${packet.mergeVerdict}`,
    `Recommendation: ${packet.recommendation}`,
    "Top findings:",
    packet.finalSummary
  ].join("\n");
}
