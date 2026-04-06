import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { CodexAdapter } from "../adapters/base.js";
import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import type {
  AdapterEvent,
  AdapterProbeResult,
  ExecutionOptions,
  InternalTask,
  TokenUsage
} from "../types/internal.js";
import { routeTask } from "../router/strategy-router.js";
import {
  buildImplementationEnvelope,
  buildJudgmentEnvelope,
  buildRefinementEnvelope,
  buildReviewEnvelope
} from "../delegation/envelopes.js";
import {
  parseImplementationPacket,
  parseReviewPacket,
  renderImplementationPacket,
  renderJudgmentPacket
} from "./packets.js";
import { decideRefinement } from "../refinement/policy.js";
import { decideJudgment } from "../review/judgment-policy.js";
import { buildDirectResponsePrompt } from "../claude/prompts.js";
import type { ImplementationResultPacket, ReviewResultPacket } from "./types.js";

async function collectExecution(
  adapter: CodexAdapter,
  task: InternalTask,
  options?: ExecutionOptions
): Promise<{ finalText: string; usage?: TokenUsage; passthroughEvents: AdapterEvent[] }> {
  let finalText = "";
  let usage: TokenUsage | undefined;
  const passthroughEvents: AdapterEvent[] = [];

  for await (const event of adapter.execute(task, options)) {
    if (
      event.type === "debug" ||
      event.type === "tool-call" ||
      event.type === "tool-result" ||
      event.type === "packet" ||
      event.type === "strategy-selected"
    ) {
      passthroughEvents.push(event);
      continue;
    }

    if (event.type === "text-delta") {
      finalText += event.text;
      continue;
    }

    if (event.type === "completed") {
      finalText = event.finalText;
      usage = event.usage;
    }
  }

  return {
    finalText,
    usage,
    passthroughEvents
  };
}

function buildSubtask(
  task: InternalTask,
  prompt: string,
  overrides?: Partial<InternalTask["permissionContext"]>
): InternalTask {
  return {
    ...task,
    prompt,
    inputItems: [{ type: "text", text: prompt }],
    permissionContext: {
      ...task.permissionContext,
      ...overrides
    }
  };
}

function packetEvent(
  packetKind: "implementation" | "review" | "judgment",
  packet: unknown
): AdapterEvent {
  const record = JSON.parse(JSON.stringify(packet)) as Record<string, unknown>;
  return {
    type: "packet",
    packetKind,
    bytes: JSON.stringify(record).length,
    packet: record
  };
}

export class HybridRuntimeAdapter implements CodexAdapter {
  readonly name: string;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
    private readonly directAdapter: CodexAdapter,
    private readonly workerAdapter: CodexAdapter,
    private readonly claude: ClaudeSubprocessManager | null = null
  ) {
    this.name = `${directAdapter.name}+hybrid`;
  }

  probe(): Promise<AdapterProbeResult> {
    return this.directAdapter.probe();
  }

  async *execute(
    task: InternalTask,
    options?: ExecutionOptions
  ): AsyncGenerator<AdapterEvent> {
    const strategy = await routeTask(task, this.claude);
    yield {
      type: "strategy-selected",
      mode: strategy.mode,
      rationale: strategy.rationale
    };

    this.logger.info("router", "selected execution strategy", {
      requestId: task.requestId,
      sessionId: task.sessionId,
      mode: strategy.mode,
      rationale: strategy.rationale
    });

    if (strategy.mode === "claude_direct") {
      yield* this.runClaudeDirect(task, options);
      return;
    }

    if (strategy.mode === "codex_delegate") {
      const packet = yield* this.runImplementation(task, "implement", options);
      const rendered = renderImplementationPacket(packet);
      yield { type: "text-delta", text: rendered };
      yield { type: "completed", finalText: rendered };
      return;
    }

    if (strategy.mode === "codex_then_claude_refine") {
      yield* this.runImplementationWithRefinement(task, options);
      return;
    }

    if (strategy.mode === "codex_review") {
      yield* this.runReview(task, "review", false, options);
      return;
    }

    if (strategy.mode === "codex_adversarial_review") {
      yield* this.runReview(task, "adversarial_review", false, options);
      return;
    }

    yield* this.runReview(task, "review", true, options);
  }

  /**
   * Real Claude subprocess response for judgment-heavy or architecture tasks.
   * Streams stdout incrementally as text-delta events.
   * Falls back to Codex direct adapter if Claude subprocess is unavailable or fails.
   */
  private async *runClaudeDirect(
    task: InternalTask,
    options?: ExecutionOptions
  ): AsyncGenerator<AdapterEvent> {
    if (!this.claude) {
      this.logger.warn("hybrid-runtime", "claude_direct: no ClaudeSubprocessManager — falling back to Codex direct", {
        requestId: task.requestId
      });
      for await (const event of this.directAdapter.execute(task, options)) {
        yield event;
      }
      return;
    }

    const prompt = buildDirectResponsePrompt(task);
    let fullText = "";
    let hadError = false;

    try {
      for await (const chunk of this.claude.stream(prompt, options?.signal)) {
        fullText += chunk;
        yield { type: "text-delta", text: chunk };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn("hybrid-runtime", "claude_direct stream failed — falling back to Codex direct", {
        requestId: task.requestId,
        error: message
      });
      hadError = true;
    }

    if (hadError) {
      for await (const event of this.directAdapter.execute(task, options)) {
        yield event;
      }
      return;
    }

    yield { type: "completed", finalText: fullText };
  }

  private async *runImplementation(
    task: InternalTask,
    mode: "implement" | "refactor" = "implement",
    options?: ExecutionOptions
  ): AsyncGenerator<AdapterEvent, ImplementationResultPacket, void> {
    const prompt = buildImplementationEnvelope(task, mode);
    const workerTask = buildSubtask(task, prompt);
    const result = await collectExecution(this.workerAdapter, workerTask, options);

    for (const event of result.passthroughEvents) {
      yield event;
    }

    const packet =
      parseImplementationPacket(result.finalText) ??
      ({
        type: "implementation_result",
        mode,
        task: "delegated task",
        status: "partial",
        filesChanged: [],
        summary: [result.finalText.trim() || "No structured implementation packet was returned."],
        commandsRun: [],
        keyDecisions: [],
        warnings: ["Worker did not return a structured implementation packet."],
        suggestedNextStep: null,
        diffSummary: [],
        confidence: null
      } satisfies ImplementationResultPacket);

    yield packetEvent("implementation", packet);
    return packet;
  }

  private async *runImplementationWithRefinement(
    task: InternalTask,
    options?: ExecutionOptions
  ): AsyncGenerator<AdapterEvent> {
    const packet = yield* this.runImplementation(task, "implement", options);

    // Real Claude judges the compressed packet
    const refinement = await decideRefinement(packet, this.claude);
    yield {
      type: "debug",
      message: "refinement policy evaluated implementation packet",
      raw: {
        action: refinement.action,
        verdict: refinement.verdict,
        riskScore: refinement.riskScore,
        rationale: refinement.rationale
      }
    };

    if (refinement.action === "accept_packet") {
      const rendered = renderImplementationPacket(packet);
      yield { type: "text-delta", text: rendered };
      yield { type: "completed", finalText: rendered };
      return;
    }

    if (refinement.action === "escalate") {
      yield* this.runClaudeDirect(task, options);
      return;
    }

    if (refinement.action === "reroute") {
      yield* this.runReview(task, "adversarial_review", false, options);
      return;
    }

    // refine or patch: constrained Codex follow-up pass
    const packetText = resultToBridgePacketText(packet);
    const refinePrompt = buildRefinementEnvelope(task, packetText);
    const refineTask = buildSubtask(task, refinePrompt, {
      canEdit: false,
      canRunCommands: false,
      sandbox: "read-only"
    });
    const refined = await collectExecution(this.workerAdapter, refineTask, options);

    for (const event of refined.passthroughEvents) {
      yield event;
    }

    yield { type: "text-delta", text: refined.finalText };
    yield { type: "completed", finalText: refined.finalText, usage: refined.usage };
  }

  private async *runReview(
    task: InternalTask,
    mode: "review" | "adversarial_review",
    withJudgment: boolean,
    options?: ExecutionOptions
  ): AsyncGenerator<AdapterEvent> {
    const prompt = buildReviewEnvelope(task, mode);
    const reviewTask = buildSubtask(task, prompt, {
      canEdit: false,
      canRunCommands: false,
      sandbox: "read-only"
    });
    const review = await collectExecution(this.workerAdapter, reviewTask, options);

    for (const event of review.passthroughEvents) {
      yield event;
    }

    const packet =
      parseReviewPacket(review.finalText) ??
      ({
        type: "review_result",
        mode,
        task: "review task",
        findings: [],
        bugRisks: [],
        regressionRisks: [],
        securityConcerns: [],
        missingTests: [],
        openQuestions: [],
        recommendation: review.finalText.trim() || "No structured review packet was returned.",
        confidence: null
      } satisfies ReviewResultPacket);

    yield packetEvent("review", packet);

    if (!withJudgment) {
      const rendered = this.renderReview(packet);
      yield { type: "text-delta", text: rendered };
      yield { type: "completed", finalText: rendered, usage: review.usage };
      return;
    }

    // Real Claude judges the review packet
    const judgment = await decideJudgment(packet, this.claude);
    yield {
      type: "debug",
      message: "judgment policy evaluated review packet",
      raw: {
        action: judgment.action,
        verdict: judgment.verdict,
        riskScore: judgment.riskScore,
        rationale: judgment.rationale
      }
    };

    const judgmentPacket = judgment.packet;
    yield packetEvent("judgment", judgmentPacket);

    if (judgment.verdict === "escalate") {
      yield* this.runClaudeDirect(task, options);
      return;
    }

    if (judgment.verdict === "reroute") {
      yield* this.runReview(task, "adversarial_review", false, options);
      return;
    }

    if (judgment.verdict === "refine") {
      const judgmentPrompt = buildJudgmentEnvelope(task, resultToBridgePacketText(packet));
      const judgeTask = buildSubtask(task, judgmentPrompt, {
        canEdit: false,
        canRunCommands: false,
        sandbox: "read-only"
      });
      const judged = await collectExecution(this.workerAdapter, judgeTask, options);

      for (const event of judged.passthroughEvents) {
        yield event;
      }

      const finalText = judged.finalText.trim() || renderJudgmentPacket(judgmentPacket);
      yield { type: "text-delta", text: finalText };
      yield { type: "completed", finalText, usage: judged.usage };
      return;
    }

    // accept: return the heuristic judgment packet rendering
    const finalText = renderJudgmentPacket(judgmentPacket);
    yield { type: "text-delta", text: finalText };
    yield { type: "completed", finalText, usage: review.usage };
  }

  private renderReview(packet: ReviewResultPacket): string {
    const findings = [...packet.findings].sort(
      (left, right) => severityWeight(left.severity) - severityWeight(right.severity)
    );
    const lines: string[] = [];
    if (findings.length === 0) {
      lines.push("No findings.");
    } else {
      for (const finding of findings) {
        const location =
          finding.file && finding.line
            ? `${finding.file}:${finding.line}`
            : finding.file ?? null;
        lines.push(
          `- [${finding.severity}] ${finding.title}${location ? ` (${location})` : ""}: ${finding.summary}`
        );
      }
    }

    if (packet.openQuestions.length) {
      lines.push("Open questions:");
      for (const question of packet.openQuestions) {
        lines.push(`- ${question}`);
      }
    }

    lines.push(`Recommendation: ${packet.recommendation}`);
    return lines.join("\n");
  }
}

function severityWeight(
  severity: ReviewResultPacket["findings"][number]["severity"]
): number {
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

function resultToBridgePacketText(packet: unknown): string {
  return `\`\`\`bridge-packet\n${JSON.stringify(packet, null, 2)}\n\`\`\``;
}
