import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { CompatibilityContextLoader } from "../config/compatibility-loader.js";
import { McpCompatibilityService } from "../mcp/service.js";

export class DiagnosticsService {
  private readonly compatibilityLoader: CompatibilityContextLoader;
  private readonly mcpService: McpCompatibilityService;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger
  ) {
    this.compatibilityLoader = new CompatibilityContextLoader(config);
    this.mcpService = new McpCompatibilityService(config, logger);
  }

  loadCompatibilityContext() {
    return this.compatibilityLoader.load();
  }

  async buildDiagnostics() {
    const context = this.compatibilityLoader.load();
    const mcp = await this.mcpService.buildCapabilityMap(context);

    return {
      generatedAt: new Date().toISOString(),
      workspaceRoot: this.config.codex.cwd,
      context,
      mcp
    };
  }

  async reloadMcp() {
    return this.mcpService.reloadCodexMcpConfig();
  }
}
