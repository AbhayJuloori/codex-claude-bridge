import type { InternalTask } from "../types/internal.js";

export type BridgeToolName = "bash" | "read_file" | "write_file" | "edit_file";

export interface BridgeToolDefinition {
  name: BridgeToolName;
  description: string;
  argsSchema: Record<string, unknown>;
}

export interface BridgeToolCallEnvelope {
  type: "tool_call";
  id: string;
  tool: BridgeToolName;
  args: Record<string, unknown>;
}

export interface BridgeFinalEnvelope {
  type: "final";
  answer: string;
}

export type BridgeAssistantEnvelope = BridgeToolCallEnvelope | BridgeFinalEnvelope;

export interface BridgeToolResultEnvelope {
  type: "tool_result";
  id: string;
  tool: BridgeToolName;
  ok: boolean;
  summary: string;
  result?: unknown;
  error?: {
    message: string;
  };
}

export interface ToolLoopTranscriptEntry {
  call: BridgeToolCallEnvelope;
  result: BridgeToolResultEnvelope;
}

const TOOL_BLOCK_RE = /```bridge-tool\s*([\s\S]*?)```/i;

export function renderBridgeToolDefinitions(tools: BridgeToolDefinition[]): string {
  return tools
    .map(
      (tool) =>
        [
          `Tool: ${tool.name}`,
          `Description: ${tool.description}`,
          `Args schema: ${JSON.stringify(tool.argsSchema)}`
        ].join("\n")
    )
    .join("\n\n");
}

export function buildToolLoopPrompt(
  task: InternalTask,
  tools: BridgeToolDefinition[],
  transcript: ToolLoopTranscriptEntry[]
): string {
  const transcriptText = transcript.length
    ? transcript
        .map((entry, index) =>
          [
            `Loop step ${index + 1} assistant tool call`,
            "```bridge-tool",
            JSON.stringify(entry.call, null, 2),
            "```",
            `Loop step ${index + 1} tool result`,
            "```bridge-tool-result",
            JSON.stringify(entry.result, null, 2),
            "```"
          ].join("\n")
        )
        .join("\n\n")
    : "No tool calls have been executed yet.";

  return [
    "Bridge-native tool protocol",
    "You are operating inside a local Claude compatibility runtime with real executable tools.",
    "Do not use native Codex tools, native shell access, or direct file editing for this task.",
    "Treat the bridge-tool protocol as the only allowed mechanism for external actions.",
    "If you need a tool, respond with exactly one fenced block using the info string bridge-tool.",
    'For a tool call, the JSON must have the shape {"type":"tool_call","id":"call_1","tool":"read_file","args":{...}}.',
    'When you are done, respond with exactly one fenced block using the shape {"type":"final","answer":"..."}.',
    "Do not include any prose outside the fenced block.",
    "Use only the tools listed below.",
    renderBridgeToolDefinitions(tools),
    "Original task context",
    task.prompt,
    "Prior tool transcript",
    transcriptText
  ].join("\n\n");
}

export function parseBridgeAssistantEnvelope(
  text: string
): BridgeAssistantEnvelope | null {
  const match = text.match(TOOL_BLOCK_RE);
  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1].trim()) as Record<string, unknown>;
    if (parsed.type === "final" && typeof parsed.answer === "string") {
      return {
        type: "final",
        answer: parsed.answer
      };
    }

    if (
      parsed.type === "tool_call" &&
      typeof parsed.id === "string" &&
      typeof parsed.tool === "string" &&
      parsed.args &&
      typeof parsed.args === "object" &&
      ["bash", "read_file", "write_file", "edit_file"].includes(parsed.tool)
    ) {
      return {
        type: "tool_call",
        id: parsed.id,
        tool: parsed.tool as BridgeToolName,
        args: parsed.args as Record<string, unknown>
      };
    }

    return null;
  } catch {
    return null;
  }
}
