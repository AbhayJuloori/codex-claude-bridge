import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { CompatibilityContext, McpServerDefinition } from "../config/types.js";
import { CodexAppServerAdapter } from "../adapters/codex-app-server.js";

export interface McpCapabilityMap {
  generatedAt: string;
  claudeServers: McpServerDefinition[];
  codexServers: McpServerDefinition[];
  sharedServerNames: string[];
  claudeOnlyServerNames: string[];
  codexOnlyServerNames: string[];
  appServerStatus?: Record<string, unknown>;
  migrationSuggestions: string[];
}

export class McpCompatibilityService {
  private readonly appServerAdapter: CodexAppServerAdapter;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger
  ) {
    this.appServerAdapter = new CodexAppServerAdapter(config, logger);
  }

  async buildCapabilityMap(context: CompatibilityContext): Promise<McpCapabilityMap> {
    const claudeNames = new Set(context.claude.mcpServers.map((server) => server.name));
    const codexNames = new Set(context.codex.mcpServers.map((server) => server.name));
    const sharedServerNames = Array.from(claudeNames).filter((name) => codexNames.has(name)).sort();
    const claudeOnlyServerNames = Array.from(claudeNames).filter((name) => !codexNames.has(name)).sort();
    const codexOnlyServerNames = Array.from(codexNames).filter((name) => !claudeNames.has(name)).sort();
    const migrationSuggestions = claudeOnlyServerNames.map(
      (name) => `Consider importing or recreating Claude MCP server "${name}" in Codex config.`
    );

    let appServerStatus: Record<string, unknown> | undefined;

    try {
      appServerStatus = await this.appServerAdapter.rawRequest("mcpServerStatus/list", {
        limit: 100
      });
    } catch (error) {
      this.logger.warn("mcp", "failed to load app-server MCP status", {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      claudeServers: context.claude.mcpServers,
      codexServers: context.codex.mcpServers,
      sharedServerNames,
      claudeOnlyServerNames,
      codexOnlyServerNames,
      appServerStatus,
      migrationSuggestions
    };
  }

  async reloadCodexMcpConfig(): Promise<Record<string, unknown>> {
    return this.appServerAdapter.rawRequest("config/mcpServer/reload", {});
  }
}
