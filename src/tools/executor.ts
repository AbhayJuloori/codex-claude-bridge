import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { ExecutionOptions, InternalTask } from "../types/internal.js";
import type {
  BridgeToolCallEnvelope,
  BridgeToolDefinition,
  BridgeToolName,
  BridgeToolResultEnvelope
} from "./protocol.js";

function truncateText(value: string, maxLength = 12000): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

function ensureObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class BridgeToolExecutor {
  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger
  ) {}

  listAvailableTools(task: InternalTask): BridgeToolDefinition[] {
    const tools: BridgeToolDefinition[] = [];

    if (this.config.tools.bash.enabled && task.permissionContext.canRunCommands) {
      tools.push({
        name: "bash",
        description:
          "Execute a shell command in the repo root and capture stdout, stderr, and exit code.",
        argsSchema: {
          command: "string"
        }
      });
    }

    if (this.config.tools.readFile.enabled) {
      tools.push({
        name: "read_file",
        description: "Read a UTF-8 text file, optionally with inclusive 1-based line ranges.",
        argsSchema: {
          path: "string",
          startLine: "number | optional",
          endLine: "number | optional"
        }
      });
    }

    if (this.config.tools.writeFile.enabled && task.permissionContext.canEdit) {
      tools.push({
        name: "write_file",
        description: "Write a full UTF-8 file, optionally creating parent directories if allowed.",
        argsSchema: {
          path: "string",
          content: "string"
        }
      });
    }

    if (this.config.tools.editFile.enabled && task.permissionContext.canEdit) {
      tools.push({
        name: "edit_file",
        description:
          "Replace text in an existing UTF-8 file using exact search text and replacement text.",
        argsSchema: {
          path: "string",
          oldText: "string",
          newText: "string",
          replaceAll: "boolean | optional"
        }
      });
    }

    return tools;
  }

  async execute(
    call: BridgeToolCallEnvelope,
    task: InternalTask,
    options?: ExecutionOptions
  ): Promise<BridgeToolResultEnvelope> {
    try {
      const result = await this.executeInner(call, task, options);
      return {
        type: "tool_result",
        id: call.id,
        tool: call.tool,
        ok: true,
        summary: summarizeResult(call.tool, result),
        result
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("tools", "tool execution failed", {
        requestId: task.requestId,
        sessionId: task.sessionId,
        tool: call.tool,
        callId: call.id,
        error: message
      });

      return {
        type: "tool_result",
        id: call.id,
        tool: call.tool,
        ok: false,
        summary: `Tool ${call.tool} failed: ${message}`,
        error: {
          message
        }
      };
    }
  }

  private async executeInner(
    call: BridgeToolCallEnvelope,
    task: InternalTask,
    options?: ExecutionOptions
  ): Promise<unknown> {
    switch (call.tool) {
      case "bash":
        return this.executeBash(call.args, task, options);
      case "read_file":
        return this.readFile(call.args);
      case "write_file":
        return this.writeFile(call.args, task);
      case "edit_file":
        return this.editFile(call.args, task);
      default:
        throw new Error(`unsupported tool ${String(call.tool)}`);
    }
  }

  private async executeBash(
    args: Record<string, unknown>,
    task: InternalTask,
    options?: ExecutionOptions
  ): Promise<unknown> {
    if (!this.config.tools.bash.enabled || !task.permissionContext.canRunCommands) {
      throw new Error("bash is disabled by bridge policy");
    }

    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) {
      throw new Error("bash requires a non-empty command");
    }

    for (const pattern of this.config.tools.bash.denyPatterns) {
      const regex = new RegExp(pattern, "i");
      if (regex.test(command)) {
        throw new Error(`bash command denied by policy pattern: ${pattern}`);
      }
    }

    this.logger.info("tools", "executing bash tool", {
      requestId: task.requestId,
      sessionId: task.sessionId,
      command
    });

    const child = spawn("/bin/zsh", ["-lc", command], {
      cwd: this.config.codex.cwd,
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, this.config.tools.bash.timeoutMs);

    if (options?.signal) {
      const abortHandler = () => child.kill("SIGTERM");
      options.signal.addEventListener("abort", abortHandler, { once: true });
      child.once("close", () => {
        options.signal?.removeEventListener("abort", abortHandler);
      });
    }

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("close", (code) => resolve(code ?? 0));
      child.once("error", reject);
    });

    clearTimeout(timeout);

    if (options?.signal?.aborted) {
      throw new Error("bash command cancelled");
    }

    return {
      command,
      cwd: this.config.codex.cwd,
      exitCode,
      timedOut,
      stdout: truncateText(stdout),
      stderr: truncateText(stderr)
    };
  }

  private async readFile(args: Record<string, unknown>): Promise<unknown> {
    if (!this.config.tools.readFile.enabled) {
      throw new Error("read_file is disabled by bridge policy");
    }

    const filePath = this.resolveAllowedPath(args.path);
    const contents = await fs.readFile(filePath, "utf8");
    const lines = contents.split("\n");
    const startLine = typeof args.startLine === "number" ? Math.max(1, Math.floor(args.startLine)) : 1;
    const endLine =
      typeof args.endLine === "number"
        ? Math.max(startLine, Math.floor(args.endLine))
        : lines.length;

    return {
      path: filePath,
      startLine,
      endLine,
      totalLines: lines.length,
      content: lines.slice(startLine - 1, endLine).join("\n")
    };
  }

  private async writeFile(
    args: Record<string, unknown>,
    task: InternalTask
  ): Promise<unknown> {
    if (!this.config.tools.writeFile.enabled || !task.permissionContext.canEdit) {
      throw new Error("write_file is disabled by bridge policy");
    }

    const filePath = this.resolveAllowedPath(args.path);
    const content = typeof args.content === "string" ? args.content : null;
    if (content === null) {
      throw new Error("write_file requires string content");
    }

    const parentDir = path.dirname(filePath);
    if (this.config.tools.writeFile.allowCreateDirectories) {
      await fs.mkdir(parentDir, { recursive: true });
    }

    await fs.writeFile(filePath, content, "utf8");
    return {
      path: filePath,
      bytesWritten: Buffer.byteLength(content, "utf8")
    };
  }

  private async editFile(
    args: Record<string, unknown>,
    task: InternalTask
  ): Promise<unknown> {
    if (!this.config.tools.editFile.enabled || !task.permissionContext.canEdit) {
      throw new Error("edit_file is disabled by bridge policy");
    }

    const filePath = this.resolveAllowedPath(args.path);
    const oldText = typeof args.oldText === "string" ? args.oldText : null;
    const newText = typeof args.newText === "string" ? args.newText : null;
    const replaceAll = args.replaceAll === true;

    if (oldText === null || newText === null) {
      throw new Error("edit_file requires oldText and newText strings");
    }

    const content = await fs.readFile(filePath, "utf8");
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) {
      throw new Error("target text was not found in file");
    }

    const nextContent = replaceAll
      ? content.split(oldText).join(newText)
      : content.replace(oldText, newText);

    await fs.writeFile(filePath, nextContent, "utf8");
    return {
      path: filePath,
      occurrencesFound: occurrences,
      replacementsApplied: replaceAll ? occurrences : 1
    };
  }

  private resolveAllowedPath(rawPath: unknown): string {
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      throw new Error("tool path must be a non-empty string");
    }

    const candidate = path.resolve(this.config.codex.cwd, rawPath);
    const allowed = this.config.tools.allowedRoots.some((root) => {
      const normalizedRoot = path.resolve(root);
      return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}${path.sep}`);
    });

    if (!allowed) {
      throw new Error(`path is outside allowed roots: ${candidate}`);
    }

    return candidate;
  }
}

function summarizeResult(tool: BridgeToolName, result: unknown): string {
  if (!ensureObject(result)) {
    return `${tool} completed`;
  }

  switch (tool) {
    case "bash":
      return `bash completed with exit code ${String(result.exitCode ?? "unknown")}`;
    case "read_file":
      return `read ${String(result.path ?? "file")}`;
    case "write_file":
      return `wrote ${String(result.path ?? "file")}`;
    case "edit_file":
      return `edited ${String(result.path ?? "file")}`;
  }
}
