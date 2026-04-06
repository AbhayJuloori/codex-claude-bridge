import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { CodexAdapter } from "./base.js";
import { AutoCodexAdapter, CodexAppServerAdapter } from "./codex-app-server.js";
import { CodexExecAdapter } from "./codex-exec.js";
import { ToolLoopCodexAdapter } from "../tools/loop.js";
import { HybridRuntimeAdapter } from "../orchestrator/hybrid-runtime.js";
import { ClaudeSubprocessManager } from "../claude/subprocess.js";

export function createBaseAdapter(config: BridgeConfig, logger: Logger): CodexAdapter {
  const exec = new CodexExecAdapter(config, logger);
  const appServer = new CodexAppServerAdapter(config, logger);

  if (config.adapterMode === "exec") {
    return exec;
  }

  if (config.adapterMode === "app-server") {
    return appServer;
  }

  return new AutoCodexAdapter(appServer, exec, logger);
}

export function createAdapter(config: BridgeConfig, logger: Logger): CodexAdapter {
  const base = createBaseAdapter(config, logger);
  const worker = config.tools.enabled ? new ToolLoopCodexAdapter(config, logger, base) : base;
  const claude = new ClaudeSubprocessManager(config, logger);
  return new HybridRuntimeAdapter(config, logger, base, worker, claude);
}
