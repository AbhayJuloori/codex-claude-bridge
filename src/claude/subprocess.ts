import { spawn } from "node:child_process";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_TIMEOUT_MS = 120_000;

export class ClaudeSubprocessManager {
  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger
  ) {}

  /**
   * Fire-and-return call. Used for routing classification and packet judgment.
   * Prompt is written to stdin. Returns trimmed stdout on success.
   * Throws on timeout, non-zero exit, or empty response.
   */
  async call(prompt: string, timeoutMs = DEFAULT_CALL_TIMEOUT_MS, model?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ["--print", "--dangerously-skip-permissions"];
      if (model) args.push("--model", model);
      const proc = spawn("claude", args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: this.config.codex.cwd
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`Claude subprocess timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdin.write(prompt, "utf8");
      proc.stdin.end();

      proc.on("close", (code) => {
        clearTimeout(timer);
        const result = stdout.trim();

        if (code !== 0) {
          this.logger.warn("claude-subprocess", "non-zero exit", {
            code,
            stderr: stderr.slice(0, 500)
          });
          reject(new Error(`Claude subprocess exited with code ${code}`));
          return;
        }

        if (!result) {
          reject(new Error("Claude subprocess returned empty response"));
          return;
        }

        resolve(result);
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Streaming call. Used for claude_direct full-response mode.
   * Yields text chunks as they arrive from Claude's stdout.
   */
  async *stream(
    prompt: string,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_STREAM_TIMEOUT_MS
  ): AsyncGenerator<string> {
    const proc = spawn("claude", ["--print", "--dangerously-skip-permissions"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.config.codex.cwd
    });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
    }, timeoutMs);

    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        proc.kill("SIGTERM");
      });
    }

    proc.stdin.write(prompt, "utf8");
    proc.stdin.end();

    const chunks: string[] = [];
    let resolveNext: ((value: IteratorResult<string>) => void) | null = null;
    let done = false;
    let exitError: unknown = null;

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (resolveNext) {
        const fn = resolveNext;
        resolveNext = null;
        fn({ value: text, done: false });
      } else {
        chunks.push(text);
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      done = true;
      if (code !== 0) {
        exitError = new Error(`Claude subprocess exited with code ${code}`);
      }
      if (resolveNext) {
        const fn = resolveNext;
        resolveNext = null;
        fn({ value: undefined as unknown as string, done: true });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      done = true;
      exitError = err;
      if (resolveNext) {
        const fn = resolveNext;
        resolveNext = null;
        fn({ value: undefined as unknown as string, done: true });
      }
    });

    while (true) {
      if (chunks.length > 0) {
        yield chunks.shift()!;
        continue;
      }

      if (done) {
        break;
      }

      await new Promise<IteratorResult<string>>((resolve) => {
        resolveNext = resolve;
      });
    }

    // Drain any remaining buffered chunks
    while (chunks.length > 0) {
      yield chunks.shift()!;
    }

    if (exitError) {
      this.logger.warn("claude-subprocess", "stream exited with error", {
        error: exitError instanceof Error ? exitError.message : String(exitError)
      });
    }
  }
}
