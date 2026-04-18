import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type {
  AdapterEvent,
  AdapterProbeResult,
  ExecutionOptions,
  InternalTask,
  TokenUsage
} from "../types/internal.js";
import type { CodexAdapter } from "./base.js";
import { extractText } from "./text-extraction.js";

const execFileAsync = promisify(execFile);

export class CodexExecAdapter implements CodexAdapter {
  readonly name = "codex-exec";

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger
  ) {}

  async probe(): Promise<AdapterProbeResult> {
    try {
      const version = await execFileAsync(this.config.codex.bin, ["--version"], {
        cwd: this.config.codex.cwd
      });
      const login = await execFileAsync(this.config.codex.bin, ["login", "status"], {
        cwd: this.config.codex.cwd
      });
      const loginOutput = [login.stdout, login.stderr].filter(Boolean).join("\n").trim();

      return {
        name: this.name,
        available: true,
        authenticated: /ChatGPT|API key/i.test(loginOutput),
        accountType: /ChatGPT/i.test(loginOutput) ? "chatgpt" : "unknown",
        detail: version.stdout.trim() || "codex CLI available",
        raw: {
          version: version.stdout.trim(),
          loginStatus: loginOutput
        }
      };
    } catch (error) {
      return {
        name: this.name,
        available: false,
        authenticated: false,
        accountType: null,
        detail: error instanceof Error ? error.message : "probe failed"
      };
    }
  }

  async *execute(
    task: InternalTask,
    options?: ExecutionOptions
  ): AsyncGenerator<AdapterEvent> {
    const args = ["exec", "--json", "--sandbox", task.permissionContext.sandbox];

    if (this.config.codex.skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }

    if (this.config.codex.model) {
      args.push("--model", this.config.codex.model);
    }

    args.push(task.prompt);

    this.logger.info("codex-exec", "spawning codex exec", {
      requestId: task.requestId,
      sessionId: task.sessionId,
      args
    });

    const child = spawn(this.config.codex.bin, args, {
      cwd: this.config.codex.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    if (options?.signal) {
      const abortHandler = () => child.kill("SIGTERM");
      options.signal.addEventListener("abort", abortHandler, { once: true });
      child.once("close", () => {
        options.signal?.removeEventListener("abort", abortHandler);
      });
    }

    const stdout = createInterface({ input: child.stdout });
    const stderr = createInterface({ input: child.stderr });
    const exitCodePromise: Promise<number> = new Promise((resolve, reject) => {
      child.once("close", (code) => resolve(code ?? 0));
      child.once("error", reject);
    });

    let finalText = "";
    let usage: TokenUsage | undefined;
    const stderrLines: string[] = [];

    stderr.on("line", (line) => {
      stderrLines.push(line);
      this.logger.debug("codex-exec", "stderr", {
        requestId: task.requestId,
        line
      });
    });

    for await (const line of stdout) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        yield { type: "debug", message: trimmed };
        continue;
      }

      const type = String(parsed.type ?? "");
      if (type === "item.completed") {
        const item = parsed.item as Record<string, unknown> | undefined;
        if (item?.type === "agent_message") {
          const itemText = extractText(item);
          if (itemText) {
            finalText = itemText;
            yield { type: "text-delta", text: itemText };
          }
        }
      } else if (type === "turn.completed") {
        const rawUsage = parsed.usage as Record<string, unknown> | undefined;
        if (rawUsage) {
          usage = {
            input_tokens: Number(rawUsage.input_tokens ?? 0),
            output_tokens: Number(rawUsage.output_tokens ?? 0)
          };
        }
      } else {
        yield { type: "debug", message: type || "event", raw: parsed };
      }
    }

    const exitCode = await exitCodePromise;

    if (options?.signal?.aborted) {
      throw new Error("codex exec run was cancelled");
    }

    if (exitCode !== 0) {
      const message = stderrLines.join("\n") || `codex exec exited with code ${exitCode}`;
      throw new Error(message);
    }

    if (!finalText) {
      finalText = "Codex completed the task (no text output).";
    }

    yield {
      type: "completed",
      finalText,
      usage
    };
  }
}
