import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";

export interface HookEvent {
  name:
    | "request.inbound"
    | "request.pre_dispatch"
    | "request.tool_call"
    | "request.tool_result"
    | "request.stream_delta"
    | "request.completed"
    | "request.failed"
    | "request.cancelled"
    | "background.queued"
    | "background.started"
    | "background.completed"
    | "background.failed"
    | "background.cancelled";
  payload: Record<string, unknown>;
}

export interface RuntimeHookTarget {
  type: "command" | "http";
  command?: string;
  url?: string;
}

export class HookEventBus {
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger
  ) {}

  on(listener: (event: HookEvent) => void): void {
    this.emitter.on("hook-event", listener);
  }

  emit(event: HookEvent): void {
    this.logger.debug("hooks", "emitting bridge hook event", {
      name: event.name
    });
    this.emitter.emit("hook-event", event);
    void this.dispatchConfiguredHooks(event);
  }

  private async dispatchConfiguredHooks(event: HookEvent): Promise<void> {
    const targets = this.config.runtime.syntheticHooks[event.name] ?? [];

    for (const target of targets) {
      if (target.type === "command" && target.command) {
        await this.runCommandHook(target.command, event);
        continue;
      }

      if (target.type === "http" && target.url) {
        await this.runHttpHook(target.url, event);
      }
    }
  }

  private async runCommandHook(command: string, event: HookEvent): Promise<void> {
    await new Promise<void>((resolve) => {
      const child = spawn("/bin/zsh", ["-lc", command], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env
      });

      child.stdin.write(JSON.stringify(event.payload));
      child.stdin.end();

      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.once("close", (code) => {
        if (code !== 0) {
          this.logger.warn("hooks", "command hook failed", {
            event: event.name,
            command,
            code,
            stderr
          });
        }
        resolve();
      });
    });
  }

  private async runHttpHook(url: string, event: HookEvent): Promise<void> {
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(event.payload)
      });
    } catch (error) {
      this.logger.warn("hooks", "http hook failed", {
        event: event.name,
        url,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
