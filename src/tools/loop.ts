import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { CodexAdapter } from "../adapters/base.js";
import type { AdapterEvent, AdapterProbeResult, ExecutionOptions, InternalTask, TokenUsage } from "../types/internal.js";
import { BridgeToolExecutor } from "./executor.js";
import {
  buildToolLoopPrompt,
  parseBridgeAssistantEnvelope,
  type ToolLoopTranscriptEntry
} from "./protocol.js";

function mergeUsage(total: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  if (!total && !next) {
    return undefined;
  }

  return {
    input_tokens: (total?.input_tokens ?? 0) + (next?.input_tokens ?? 0),
    output_tokens: (total?.output_tokens ?? 0) + (next?.output_tokens ?? 0)
  };
}

async function collectAssistantText(
  adapter: CodexAdapter,
  task: InternalTask,
  options?: ExecutionOptions
): Promise<{ text: string; usage?: TokenUsage; passthroughEvents: AdapterEvent[] }> {
  let text = "";
  let usage: TokenUsage | undefined;
  const passthroughEvents: AdapterEvent[] = [];

  for await (const event of adapter.execute(task, options)) {
    if (event.type === "debug") {
      passthroughEvents.push(event);
      continue;
    }

    if (event.type === "text-delta") {
      text += event.text;
      continue;
    }

    if (event.type === "completed") {
      text = event.finalText;
      usage = event.usage;
      continue;
    }

    passthroughEvents.push(event);
  }

  return { text, usage, passthroughEvents };
}

export class ToolLoopCodexAdapter implements CodexAdapter {
  readonly name: string;
  private readonly tools: BridgeToolExecutor;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
    private readonly base: CodexAdapter
  ) {
    this.name = `${base.name}+tools`;
    this.tools = new BridgeToolExecutor(config, logger);
  }

  probe(): Promise<AdapterProbeResult> {
    return this.base.probe();
  }

  async *execute(
    task: InternalTask,
    options?: ExecutionOptions
  ): AsyncGenerator<AdapterEvent> {
    const availableTools = this.tools.listAvailableTools(task);
    if (!this.config.tools.enabled || availableTools.length === 0) {
      for await (const event of this.base.execute(task, options)) {
        yield event;
      }
      return;
    }

    const transcript: ToolLoopTranscriptEntry[] = [];
    let aggregateUsage: TokenUsage | undefined;

    for (let round = 0; round < this.config.tools.maxRounds; round += 1) {
      const roundPrompt = buildToolLoopPrompt(task, availableTools, transcript);
      const roundTask: InternalTask = {
        ...task,
        prompt: roundPrompt,
        inputItems: [{ type: "text", text: roundPrompt }],
        permissionContext: {
          ...task.permissionContext,
          canEdit: false,
          canRunCommands: false,
          sandbox: "read-only",
          appServerApprovalPolicy: "never"
        }
      };

      const { text, usage, passthroughEvents } = await collectAssistantText(
        this.base,
        roundTask,
        options
      );
      aggregateUsage = mergeUsage(aggregateUsage, usage);

      for (const event of passthroughEvents) {
        yield event;
      }

      const parsed = parseBridgeAssistantEnvelope(text);
      if (!parsed) {
        yield { type: "text-delta", text };
        yield {
          type: "completed",
          finalText: text,
          usage: aggregateUsage
        };
        return;
      }

      if (parsed.type === "final") {
        yield { type: "text-delta", text: parsed.answer };
        yield {
          type: "completed",
          finalText: parsed.answer,
          usage: aggregateUsage
        };
        return;
      }

      this.logger.info("tool-loop", "executing tool call from codex", {
        requestId: task.requestId,
        sessionId: task.sessionId,
        round: round + 1,
        tool: parsed.tool,
        callId: parsed.id
      });

      yield {
        type: "tool-call",
        tool: parsed.tool,
        callId: parsed.id,
        args: parsed.args
      };

      const toolResult = await this.tools.execute(parsed, task, options);
      transcript.push({
        call: parsed,
        result: toolResult
      });

      yield {
        type: "tool-result",
        tool: parsed.tool,
        callId: parsed.id,
        ok: toolResult.ok,
        summary: toolResult.summary,
        result: toolResult.result,
        error: toolResult.error?.message
      };
    }

    throw new Error(
      `bridge tool loop exceeded max rounds (${this.config.tools.maxRounds}) without final answer`
    );
  }
}
