export type FeatureStatus =
  | "supported"
  | "experimental"
  | "partial"
  | "planned"
  | "impossible";

export type CompatibilityClassification =
  | "native passthrough"
  | "proxy-preservable"
  | "bridge-emulatable"
  | "partially compatible"
  | "not realistically replaceable";

export type ConfigScope = "managed" | "user" | "project" | "local" | "plugin" | "runtime";

export interface LoadedConfigFile<T = unknown> {
  path: string;
  scope: ConfigScope;
  exists: boolean;
  parsed: T | null;
  rawText?: string | null;
  parseError?: string | null;
}

export interface InstructionFile {
  path: string;
  scope: ConfigScope;
  kind: "claude_md" | "claude_local_md";
  content: string;
}

export interface HookSource {
  name: string;
  path: string;
  scope: ConfigScope;
  sourceType: "settings" | "plugin";
  events: string[];
  raw: unknown;
}

export interface PluginInstall {
  pluginKey: string;
  name: string;
  marketplace: string;
  installPath: string;
  scope: "user" | "project";
  version: string;
  enabled: boolean;
}

export interface SkillDefinition {
  id: string;
  name: string;
  path: string;
  source: "claude" | "codex";
  scope: ConfigScope;
  description: string | null;
  content: string;
  frontmatter: Record<string, unknown>;
}

export interface AgentDefinition {
  id: string;
  name: string;
  path: string;
  source: "claude" | "codex";
  scope: ConfigScope;
  description: string | null;
  prompt: string;
  frontmatter: Record<string, unknown>;
  tools: string[];
  skills: string[];
  model: string | null;
}

export interface McpServerDefinition {
  name: string;
  path: string;
  source: "claude" | "codex";
  scope: ConfigScope;
  transport: "stdio" | "http" | "unknown";
  config: Record<string, unknown>;
}

export interface CompatibilityAreaReport {
  classification: CompatibilityClassification;
  status: FeatureStatus;
  whatClaudeOwns: string[];
  whatBridgeOwns: string[];
  preservedToday: string[];
  nextParityWork: string[];
  remainingRisks: string[];
  suggestedTests: string[];
}

export interface CompatibilityReport {
  generatedAt: string;
  configuration: CompatibilityAreaReport;
  permissions: CompatibilityAreaReport;
  hooks: CompatibilityAreaReport;
  mcp: CompatibilityAreaReport;
  agents: CompatibilityAreaReport;
  skills: CompatibilityAreaReport;
  background: CompatibilityAreaReport;
}

export interface CompatibilityContext {
  generatedAt: string;
  workspaceRoot: string;
  environment: Record<string, string | undefined>;
  claude: {
    settingsFiles: Array<LoadedConfigFile<Record<string, unknown>>>;
    mergedSettings: Record<string, unknown>;
    instructionFiles: InstructionFile[];
    plugins: PluginInstall[];
    hookSources: HookSource[];
    skills: SkillDefinition[];
    agents: AgentDefinition[];
    mcpServers: McpServerDefinition[];
  };
  codex: {
    configFiles: Array<LoadedConfigFile<Record<string, unknown>>>;
    mergedConfig: Record<string, unknown>;
    skills: SkillDefinition[];
    agents: AgentDefinition[];
    mcpServers: McpServerDefinition[];
  };
  report: CompatibilityReport;
}
