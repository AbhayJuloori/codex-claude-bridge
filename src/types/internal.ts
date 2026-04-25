import type {
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTool
} from "./anthropic.js";
import type { AgentDefinition, CompatibilityContext, SkillDefinition } from "../config/types.js";
import type { PermissionContext } from "../permissions/policy.js";

export type AdapterMode = "auto" | "app-server" | "exec";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type BridgeInputItem =
  | { type: "text"; text: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export interface InternalTask {
  requestId: string;
  sessionId: string;
  requestedModel: string;
  maxTokens: number;
  stream: boolean;
  systemPrompt: string;
  messages: AnthropicMessage[];
  tools: AnthropicTool[];
  prompt: string;
  sourceRequest: AnthropicMessagesRequest;
  compatibilityContext: CompatibilityContext;
  permissionContext: PermissionContext;
  selectedSkills: SkillDefinition[];
  selectedAgent: AgentDefinition | null;
  inputItems: BridgeInputItem[];
}

export interface AdapterProbeResult {
  name: string;
  available: boolean;
  authenticated: boolean;
  accountType: string | null;
  detail: string;
  raw?: Record<string, unknown>;
}

export interface ExecutionOptions {
  signal?: AbortSignal;
}

export type AdapterEvent =
  | { type: "debug"; message: string; raw?: unknown }
  | { type: "text-delta"; text: string }
  | { type: "strategy-selected"; mode: string; rationale: string[] }
  | {
      type: "packet";
      packetKind: "implementation" | "review" | "judgment";
      bytes: number;
      packet: Record<string, unknown>;
    }
  | { type: "tool-call"; tool: string; callId: string; args: Record<string, unknown> }
  | {
      type: "tool-result";
      tool: string;
      callId: string;
      ok: boolean;
      summary: string;
      result?: unknown;
      error?: string;
    }
  | { type: "completed"; finalText: string; usage?: TokenUsage }
  | { type: "error"; message: string; cause?: unknown };

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}
