import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import {
  executionPacketSchema,
  type ExecutionPacket,
  type ExecutionPlan,
} from "./types.js";
import { resolveModel, writePolicyToSandbox } from "./config.js";
import type { SessionManager } from "./session-manager.js";

const DEFAULT_WALL_TIME_MS = 5 * 60 * 1000;

function stripFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

function synthesizePacket(rawOutput: string, exitCode: number): ExecutionPacket {
  const status = exitCode === 0 ? "partial" : "failed";
  return {
    status,
    summary: rawOutput.slice(0, 500) || "Codex produced no text output.",
    files_changed: [],
    commands_run: [],
    risks: exitCode !== 0 ? [`Codex exited with code ${exitCode}`] : [],
    unresolved_items: ["ExecutionPacket could not be parsed from Codex output"],
    confidence: exitCode === 0 ? 0.4 : 0.1,
  };
}

function buildPrompt(task: string, plan: ExecutionPlan, plugins: string[], isRepair: boolean, repairInstructions?: string): string {
  const pluginLine = plugins.length > 0
    ? `Suggested plugins (you may extend if needed): ${plugins.join(", ")}`
    : "No specific plugins required.";
  const policyLine = plan.write_policy === "patch_only"
    ? "WRITE POLICY: patch_only — only modify existing files, do not create new ones."
    : plan.write_policy === "read_only"
    ? "WRITE POLICY: read_only — do not write or modify any files."
    : "WRITE POLICY: workspace_write — you may create and modify files freely.";
  const repairSection = isRepair && repairInstructions
    ? `\n## Repair Instructions (from Claude Judge)\n${repairInstructions}\n\nFix the issues above and complete the task.`
    : "";
  return `## Task\n${task}\n${repairSection}\n\n## Execution Context\nMode: ${plan.mode}\n${policyLine}\n${pluginLine}\nSubagent strategy hint: ${plan.subagent_strategy}\n\n## Success Criteria\n${plan.success_criteria}\n\n${plan.architecture_notes ? `## Architecture Constraints\n${plan.architecture_notes}\n` : ""}## Required Output Format\nWhen you are done, output ONLY a JSON object as your final message (no prose after it).\nThis JSON must conform to this schema:\n{\n  "status": "completed" | "partial" | "failed" | "needs_clarification",\n  "summary": string,\n  "files_changed": string[],\n  "commands_run": string[],\n  "tests_run": { "passed": number, "failed": number, "skipped": number, "output": string } | null,\n  "diff_summary": string,\n  "risks": string[],\n  "unresolved_items": string[],\n  "confidence": number (0-1)\n}`;
}

export class CodexAgent {
  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
    private readonly sessions: SessionManager
  ) {}

  async run(
    task: string,
    plan: ExecutionPlan,
    plugins: string[],
    sessionKey: string,
    isRepair = false,
    repairInstructions?: string
  ): Promise<ExecutionPacket> {
    const prompt = buildPrompt(task, plan, plugins, isRepair, repairInstructions);
    const model = resolveModel(plan.model_tier);
    const sandbox = writePolicyToSandbox(plan.write_policy);
    const wallTimeMs = plan.max_wall_time_ms ?? DEFAULT_WALL_TIME_MS;
    const isStateful = plan.session_mode === "stateful";
    const hasExistingSession = isStateful && this.sessions.has(sessionKey);
    const args: string[] = [];
    if (hasExistingSession) {
      args.push("exec", "resume", "--last");
    } else {
      args.push("exec");
    }
    args.push("--json", "--sandbox", sandbox, "-m", model);
    args.push("-c", `model_reasoning_effort=${plan.reasoning_effort}`);
    if ((this.config as any).codex?.skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }
    if (!hasExistingSession) {
      args.push(prompt);
    } else {
      args.push(repairInstructions ?? prompt);
    }
    this.logger.info("codex-agent", "spawning Codex", { model, sandbox, sessionKey, isRepair, hasExistingSession });
    const raw = await this.spawnCodex(args, wallTimeMs);
    if (isStateful && !hasExistingSession) {
      this.sessions.set(sessionKey, wallTimeMs);
    }
    return this.parsePacket(raw.finalText, raw.exitCode);
  }

  private async spawnCodex(args: string[], wallTimeMs: number): Promise<{ finalText: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const codexBin = (this.config as any).codex?.bin ?? "codex";
      const codexCwd = (this.config as any).codex?.cwd ?? process.cwd();
      const child = spawn(codexBin, args, { cwd: codexCwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      const stdout = createInterface({ input: child.stdout });
      let finalText = "";
      let exitCode = 0;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Codex agent timed out after ${wallTimeMs}ms`));
      }, wallTimeMs);
      stdout.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(trimmed) as Record<string, unknown>; } catch { return; }
        const type = String(parsed.type ?? "");
        if (type === "item.completed") {
          const item = parsed.item as Record<string, unknown> | undefined;
          if (item?.type === "agent_message") {
            const content = item.content;
            if (typeof content === "string") { finalText = content; }
            else if (Array.isArray(content)) {
              for (const block of content) {
                const b = block as Record<string, unknown>;
                if (b.type === "output_text" && typeof b.text === "string") { finalText = b.text; }
              }
            }
            if (typeof item.text === "string") { finalText = item.text; }
          }
        }
      });
      child.once("close", (code) => { clearTimeout(timer); exitCode = code ?? 0; resolve({ finalText, exitCode }); });
      child.once("error", (err) => { clearTimeout(timer); reject(err); });
    });
  }

  private parsePacket(rawText: string, exitCode: number): ExecutionPacket {
    const stripped = stripFences(rawText.trim());
    const direct = tryParsePacket(stripped);
    if (direct) return direct;
    const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/g);
    if (fenceMatch) {
      for (let i = fenceMatch.length - 1; i >= 0; i--) {
        const inner = fenceMatch[i].replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
        const candidate = tryParsePacket(inner);
        if (candidate) return candidate;
      }
    }
    const balanced = extractBalancedJsonObjects(stripped);
    for (let i = balanced.length - 1; i >= 0; i--) {
      const candidate = tryParsePacket(balanced[i]);
      if (candidate) return candidate;
    }
    this.logger.warn("codex-agent", "ExecutionPacket could not be parsed, synthesizing", { rawSlice: rawText.slice(0, 200) });
    return synthesizePacket(rawText, exitCode);
  }
}

function tryParsePacket(text: string): ExecutionPacket | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const result = executionPacketSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function extractBalancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") { depth--; if (depth === 0 && start !== -1) { objects.push(text.slice(start, i + 1)); start = -1; } }
  }
  return objects;
}
