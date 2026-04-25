import path from "node:path";
import toml from "toml";
import type { BridgeConfig } from "../config.js";
import { loadAgentsFromRoots } from "../agents/loader.js";
import { loadSkillsFromRoots } from "../skills/loader.js";
import {
  dedupeByKey,
  fileExists,
  listFilesRecursive,
  readJsonFileSafe,
  readTextFileSafe,
  uniqueByPath,
  walkUpDirectories
} from "./fs-utils.js";
import type {
  CompatibilityAreaReport,
  CompatibilityContext,
  CompatibilityReport,
  ConfigScope,
  HookSource,
  InstructionFile,
  LoadedConfigFile,
  McpServerDefinition,
  PluginInstall
} from "./types.js";

interface InstalledPluginsFile {
  version?: number;
  plugins?: Record<
    string,
    Array<{
      scope?: "user" | "project";
      projectPath?: string;
      installPath?: string;
      version?: string;
    }>
  >;
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];

    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      result[key] = deepMerge(
        existing as Record<string, unknown>,
        value as Record<string, unknown>
      );
      continue;
    }

    if (Array.isArray(value) && Array.isArray(existing)) {
      result[key] = Array.from(new Set([...existing, ...value]));
      continue;
    }

    result[key] = value;
  }

  return result;
}

function loadJsonConfigFile(
  filePath: string,
  scope: ConfigScope
): LoadedConfigFile<Record<string, unknown>> {
  const rawText = readTextFileSafe(filePath);
  if (!rawText) {
    return {
      path: filePath,
      scope,
      exists: false,
      parsed: null,
      rawText: null
    };
  }

  try {
    return {
      path: filePath,
      scope,
      exists: true,
      parsed: JSON.parse(rawText) as Record<string, unknown>,
      rawText
    };
  } catch (error) {
    return {
      path: filePath,
      scope,
      exists: true,
      parsed: null,
      rawText,
      parseError: error instanceof Error ? error.message : "failed to parse json"
    };
  }
}

function loadTomlConfigFile(
  filePath: string,
  scope: ConfigScope
): LoadedConfigFile<Record<string, unknown>> {
  const rawText = readTextFileSafe(filePath);
  if (!rawText) {
    return {
      path: filePath,
      scope,
      exists: false,
      parsed: null,
      rawText: null
    };
  }

  try {
    return {
      path: filePath,
      scope,
      exists: true,
      parsed: toml.parse(rawText) as Record<string, unknown>,
      rawText
    };
  } catch (error) {
    return {
      path: filePath,
      scope,
      exists: true,
      parsed: null,
      rawText,
      parseError: error instanceof Error ? error.message : "failed to parse toml"
    };
  }
}

function loadInstructionFiles(workspaceRoot: string): InstructionFile[] {
  const files: InstructionFile[] = [];
  const userClaudePath = path.join(process.env.HOME ?? "", ".claude", "CLAUDE.md");
  const userClaude = readTextFileSafe(userClaudePath);

  if (userClaude) {
    files.push({
      path: userClaudePath,
      scope: "user",
      kind: "claude_md",
      content: userClaude
    });
  }

  for (const dir of walkUpDirectories(workspaceRoot).reverse()) {
    const candidates: Array<{ relative: string; kind: InstructionFile["kind"] }> = [
      { relative: "CLAUDE.md", kind: "claude_md" },
      { relative: path.join(".claude", "CLAUDE.md"), kind: "claude_md" },
      { relative: "CLAUDE.local.md", kind: "claude_local_md" }
    ];

    for (const candidate of candidates) {
      const absolutePath = path.join(dir, candidate.relative);
      const content = readTextFileSafe(absolutePath);
      if (!content) {
        continue;
      }

      files.push({
        path: absolutePath,
        scope:
          candidate.kind === "claude_local_md"
            ? "local"
            : dir === workspaceRoot
              ? "project"
              : "project",
        kind: candidate.kind,
        content
      });
    }
  }

  return dedupeByKey(files, (file) => file.path);
}

function loadInstalledPlugins(mergedSettings: Record<string, unknown>): PluginInstall[] {
  const installedPluginsPath = path.join(
    process.env.HOME ?? "",
    ".claude",
    "plugins",
    "installed_plugins.json"
  );
  const parsed = readJsonFileSafe<InstalledPluginsFile>(installedPluginsPath);
  const enabledPlugins =
    (mergedSettings.enabledPlugins as Record<string, boolean> | undefined) ?? {};

  if (!parsed?.plugins) {
    return [];
  }

  const installs: PluginInstall[] = [];

  for (const [pluginKey, entries] of Object.entries(parsed.plugins)) {
    const [name, marketplace] = pluginKey.split("@");

    for (const entry of entries) {
      if (!entry.installPath) {
        continue;
      }

      installs.push({
        pluginKey,
        name,
        marketplace,
        installPath: entry.installPath,
        scope: entry.scope ?? "user",
        version: entry.version ?? "unknown",
        enabled: enabledPlugins[pluginKey] ?? true
      });
    }
  }

  return installs;
}

function loadHookSources(
  mergedSettings: Record<string, unknown>,
  enabledPlugins: PluginInstall[]
): HookSource[] {
  const hookSources: HookSource[] = [];
  const settingsHooks = mergedSettings.hooks as Record<string, unknown> | undefined;

  if (settingsHooks) {
    hookSources.push({
      name: "settings",
      path: "merged:settings.hooks",
      scope: "runtime",
      sourceType: "settings",
      events: Object.keys(settingsHooks),
      raw: settingsHooks
    });
  }

  for (const plugin of enabledPlugins.filter((item) => item.enabled)) {
    const hookFiles = uniqueByPath([
      path.join(plugin.installPath, "hooks", "hooks.json"),
      path.join(path.dirname(plugin.installPath), "hooks", "hooks.json")
    ]).filter(fileExists);

    for (const hookFile of hookFiles) {
      const parsed = readJsonFileSafe<Record<string, unknown>>(hookFile);
      if (!parsed) {
        continue;
      }

      hookSources.push({
        name: plugin.pluginKey,
        path: hookFile,
        scope: "plugin",
        sourceType: "plugin",
        events: Object.keys(parsed),
        raw: parsed
      });
    }
  }

  return dedupeByKey(hookSources, (item) => `${item.name}:${item.path}`);
}

function loadClaudeMcpServers(
  workspaceRoot: string,
  enabledPlugins: PluginInstall[]
): McpServerDefinition[] {
  const servers: McpServerDefinition[] = [];
  const userClaudeStatePath = path.join(process.env.HOME ?? "", ".claude.json");
  const userClaudeState = readJsonFileSafe<Record<string, unknown>>(userClaudeStatePath);
  const projectMcpPath = path.join(workspaceRoot, ".mcp.json");
  const projectMcp = readJsonFileSafe<Record<string, unknown>>(projectMcpPath);

  function extractServers(
    sourcePath: string,
    scope: ConfigScope,
    raw: Record<string, unknown> | null
  ): void {
    if (!raw) {
      return;
    }

    const candidates = [
      raw.mcpServers as Record<string, unknown> | undefined,
      raw.mcp_servers as Record<string, unknown> | undefined
    ].filter(Boolean) as Array<Record<string, unknown>>;

    for (const record of candidates) {
      for (const [name, value] of Object.entries(record)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          continue;
        }

        const config = value as Record<string, unknown>;
        const transport =
          typeof config.command === "string"
            ? "stdio"
            : typeof config.url === "string"
              ? "http"
              : "unknown";

        servers.push({
          name,
          path: sourcePath,
          source: "claude",
          scope,
          transport,
          config
        });
      }
    }
  }

  extractServers(userClaudeStatePath, "user", userClaudeState);
  extractServers(projectMcpPath, "project", projectMcp);

  for (const plugin of enabledPlugins.filter((item) => item.enabled)) {
    const pluginMcpFiles = uniqueByPath([
      path.join(plugin.installPath, ".mcp.json"),
      path.join(path.dirname(plugin.installPath), ".mcp.json")
    ]).filter(fileExists);

    for (const pluginMcpFile of pluginMcpFiles) {
      extractServers(pluginMcpFile, "plugin", readJsonFileSafe(pluginMcpFile));
    }
  }

  return dedupeByKey(servers, (item) => `${item.name}:${item.path}`);
}

function loadCodexMcpServers(mergedConfig: Record<string, unknown>, configFiles: LoadedConfigFile[]): McpServerDefinition[] {
  const servers: McpServerDefinition[] = [];
  const mcpServers = mergedConfig.mcp_servers as Record<string, unknown> | undefined;

  if (!mcpServers) {
    return [];
  }

  const preferredPath =
    configFiles.find((file) => file.scope === "project" && file.exists)?.path ??
    configFiles.find((file) => file.scope === "user" && file.exists)?.path ??
    "merged:codex.mcp_servers";

  for (const [name, value] of Object.entries(mcpServers)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    const config = value as Record<string, unknown>;
    const transport =
      typeof config.command === "string"
        ? "stdio"
        : typeof config.url === "string"
          ? "http"
          : "unknown";

    servers.push({
      name,
      path: preferredPath,
      source: "codex",
      scope: preferredPath.includes(`${path.sep}.codex${path.sep}`) ? "project" : "user",
      transport,
      config
    });
  }

  return dedupeByKey(servers, (item) => `${item.name}:${item.path}`);
}

function makeAreaReport(
  classification: CompatibilityAreaReport["classification"],
  status: CompatibilityAreaReport["status"],
  whatClaudeOwns: string[],
  whatBridgeOwns: string[],
  preservedToday: string[],
  nextParityWork: string[],
  remainingRisks: string[],
  suggestedTests: string[]
): CompatibilityAreaReport {
  return {
    classification,
    status,
    whatClaudeOwns,
    whatBridgeOwns,
    preservedToday,
    nextParityWork,
    remainingRisks,
    suggestedTests
  };
}

function buildCompatibilityReport(context: Omit<CompatibilityContext, "report">): CompatibilityReport {
  const generatedAt = context.generatedAt;

  return {
    generatedAt,
    configuration: makeAreaReport(
      "proxy-preservable",
      "supported",
      [
        "Loads scoped settings, CLAUDE.md files, project-local config, plugins, and environment variables.",
        "Owns the final in-client config precedence and startup attachment behavior."
      ],
      [
        "Can ingest and report Claude-compatible config artifacts from disk.",
        "Can project honored config into prompt and runtime policy."
      ],
      [
        `Loaded ${context.claude.settingsFiles.filter((file) => file.exists).length} Claude settings files.`,
        `Loaded ${context.claude.instructionFiles.length} CLAUDE instruction files.`,
        `Loaded ${context.claude.plugins.filter((plugin) => plugin.enabled).length} enabled Claude plugins.`
      ],
      [
        "Tighten precedence fidelity for every Claude settings key.",
        "Map more settings directly to Codex app-server or bridge behavior.",
        "Add config diff diagnostics by source."
      ],
      [
        "Command-line flags used by Claude are not visible to the proxy after ingress.",
        "Some Claude-only settings have no Codex equivalent and remain advisory."
      ],
      [
        "Verify merged settings against local Claude debug traces.",
        "Create project-level .claude files and confirm diagnostics reflect precedence correctly."
      ]
    ),
    permissions: makeAreaReport(
      "bridge-emulatable",
      "partial",
      [
        "Decides tool prompts, permission modes, and approval UX in the native client.",
        "Owns allow/deny rules and can restrict Agent(subagent) usage."
      ],
      [
        "Can derive a semantic permission mode from Claude settings.",
        "Can translate that mode into Codex sandbox and approval behavior.",
        "Can log parity gaps when the bridge cannot match Claude’s guarantee."
      ],
      [
        "Permission mode and allow/deny rules are loaded from Claude settings.",
        "The runtime now has a first-class approval policy abstraction."
      ],
      [
        "Handle server-initiated app-server approval requests consistently.",
        "Improve command-pattern matching and deny behavior.",
        "Add user-facing approval endpoints for future interactive prompting."
      ],
      [
        "The bridge cannot fully reproduce Claude’s native permission UX inside another backend.",
        "Exec fallback has weaker enforcement than app-server-based approvals."
      ],
      [
        "Run permission-sensitive tasks under plan/default/acceptEdits/bypass modes.",
        "Verify deny rules block equivalent Codex actions where possible."
      ]
    ),
    hooks: makeAreaReport(
      "bridge-emulatable",
      "experimental",
      [
        "Owns hook lifecycle invocation in the Claude runtime, including native events and plugin hooks."
      ],
      [
        "Can emit synthetic compatibility events at bridge lifecycle boundaries.",
        "Can run bridge-local command or HTTP hooks with Claude-like JSON payloads."
      ],
      [
        `Detected ${context.claude.hookSources.length} Claude hook sources from settings and plugins.`
      ],
      [
        "Mirror more Claude event names and payload shapes.",
        "Add hook replay and per-session observability."
      ],
      [
        "Bridge hooks are not identical to native Claude hook timing.",
        "Client-side hooks remain owned by Claude and cannot be intercepted perfectly."
      ],
      [
        "Trigger inbound, pre-dispatch, completion, failure, and cancellation events.",
        "Compare synthetic payloads with Claude hook examples."
      ]
    ),
    mcp: makeAreaReport(
      "proxy-preservable",
      "partial",
      [
        "Claude owns native MCP server startup, tool invocation, and auth on the client side."
      ],
      [
        "Can inventory Claude MCP config and Codex MCP config side by side.",
        "Can use official Codex app-server MCP status and reload surfaces."
      ],
      [
        `Detected ${context.claude.mcpServers.length} Claude MCP server definitions.`,
        `Detected ${context.codex.mcpServers.length} Codex MCP server definitions.`
      ],
      [
        "Call app-server migration and MCP status APIs for stronger parity diagnostics.",
        "Propagate MCP capability summaries into execution context.",
        "Explore shared MCP server configuration as the cleanest common tool layer."
      ],
      [
        "Claude-side MCP tools used entirely client-side may never be visible to the bridge.",
        "Codex MCP and Claude MCP config formats overlap conceptually but are not identical."
      ],
      [
        "Verify project .mcp.json detection.",
        "Verify Codex MCP reload and status enumeration via app-server."
      ]
    ),
    agents: makeAreaReport(
      "bridge-emulatable",
      "experimental",
      [
        "Claude owns native subagent invocation, backgrounding, context isolation, and result synthesis."
      ],
      [
        "Can load Claude and plugin-provided agents.",
        "Can approximate planner/worker delegation and task graph tracking inside the bridge."
      ],
      [
        `Loaded ${context.claude.agents.length} Claude-side agent definitions.`
      ],
      [
        "Add planner/worker background execution.",
        "Honor default agent selection and explicit agent mentions more faithfully.",
        "Expose task graph diagnostics and replay."
      ],
      [
        "This is operational equivalence, not internal Claude parity.",
        "Nested delegation and native AskUserQuestion flows remain limited."
      ],
      [
        "Run a planner-worker background job and inspect the task graph.",
        "Verify agent selection from settings and @agent references."
      ]
    ),
    skills: makeAreaReport(
      "proxy-preservable",
      "partial",
      [
        "Claude owns native skill discovery, attachment, and invocation semantics."
      ],
      [
        "Can discover user, project, plugin, and Codex skill files.",
        "Can inject selected skill content into backend prompts or orchestration."
      ],
      [
        `Loaded ${context.claude.skills.length} Claude-compatible skills and ${context.codex.skills.length} Codex skills.`
      ],
      [
        "Improve skill invocation detection and frontmatter handling.",
        "Use Codex-native skill input items when safe and supported."
      ],
      [
        "The bridge preserves instruction effects, not full native Claude skill mechanics.",
        "Plugin-defined skills may rely on other Claude-native features."
      ],
      [
        "Mention a known skill in a request and inspect diagnostics for selection.",
        "Verify skill content appears in mapped prompts."
      ]
    ),
    background: makeAreaReport(
      "bridge-emulatable",
      "experimental",
      [
        "Claude owns native background subagent behavior and concurrency UX."
      ],
      [
        "Can run queued background jobs with persisted events, cancellation, and result retrieval.",
        "Can attach planner/worker orchestration for long-running tasks."
      ],
      [
        "The bridge now exposes persisted jobs and resumable event logs."
      ],
      [
        "Improve cancellation semantics and streaming replay.",
        "Bind background runs more directly to Claude-visible flows where possible."
      ],
      [
        "Claude CLI does not automatically know about bridge background endpoints.",
        "Long-running job UX remains bridge-specific rather than native Claude UI."
      ],
      [
        "Submit a background request, poll status, replay events, and cancel a running job."
      ]
    )
  };
}

export class CompatibilityContextLoader {
  constructor(private readonly config: BridgeConfig) {}

  load(): CompatibilityContext {
    const workspaceRoot = this.config.codex.cwd;
    const managedSettingsPath = "/Library/Application Support/ClaudeCode/managed-settings.json";
    const claudeSettingsFiles = [
      loadJsonConfigFile(managedSettingsPath, "managed"),
      loadJsonConfigFile(path.join(process.env.HOME ?? "", ".claude", "settings.json"), "user"),
      loadJsonConfigFile(path.join(workspaceRoot, ".claude", "settings.json"), "project"),
      loadJsonConfigFile(path.join(workspaceRoot, ".claude", "settings.local.json"), "local")
    ];

    const mergedClaudeSettings = claudeSettingsFiles.reduce<Record<string, unknown>>((acc, file) => {
      if (!file.parsed) {
        return acc;
      }

      if (file.scope === "managed") {
        return deepMerge(acc, file.parsed);
      }

      return deepMerge(acc, file.parsed);
    }, {});

    const installedPlugins = loadInstalledPlugins(mergedClaudeSettings);
    const enabledPlugins = installedPlugins.filter((plugin) => plugin.enabled);

    const claudeInstructionFiles = loadInstructionFiles(workspaceRoot);
    const claudeSkillRoots = [
      { root: path.join(process.env.HOME ?? "", ".claude", "skills"), scope: "user" as const, source: "claude" as const },
      { root: path.join(workspaceRoot, ".claude", "skills"), scope: "project" as const, source: "claude" as const },
      ...enabledPlugins.flatMap((plugin) => [
        { root: path.join(plugin.installPath, "skills"), scope: "plugin" as const, source: "claude" as const },
        { root: path.join(plugin.installPath, ".claude", "skills"), scope: "plugin" as const, source: "claude" as const }
      ])
    ];
    const claudeSkills = dedupeByKey(
      loadSkillsFromRoots(claudeSkillRoots),
      (skill) => `${skill.source}:${skill.path}`
    );

    const claudeAgentRoots = [
      { root: path.join(process.env.HOME ?? "", ".claude", "agents"), scope: "user" as const, source: "claude" as const },
      { root: path.join(workspaceRoot, ".claude", "agents"), scope: "project" as const, source: "claude" as const },
      ...enabledPlugins.map((plugin) => ({
        root: path.join(plugin.installPath, "agents"),
        scope: "plugin" as const,
        source: "claude" as const
      }))
    ];
    const claudeAgents = dedupeByKey(
      loadAgentsFromRoots(claudeAgentRoots),
      (agent) => `${agent.source}:${agent.path}`
    );

    const codexConfigFiles = [
      loadTomlConfigFile(path.join(process.env.HOME ?? "", ".codex", "config.toml"), "user"),
      loadTomlConfigFile(path.join(workspaceRoot, ".codex", "config.toml"), "project")
    ];
    const mergedCodexConfig = codexConfigFiles.reduce<Record<string, unknown>>((acc, file) => {
      if (!file.parsed) {
        return acc;
      }

      return deepMerge(acc, file.parsed);
    }, {});

    const codexSkillRoots = [
      { root: path.join(process.env.HOME ?? "", ".codex", "skills"), scope: "user" as const, source: "codex" as const },
      { root: path.join(workspaceRoot, ".codex", "skills"), scope: "project" as const, source: "codex" as const },
      { root: path.join(workspaceRoot, ".agents", "skills"), scope: "project" as const, source: "codex" as const }
    ];
    const codexSkills = dedupeByKey(
      loadSkillsFromRoots(codexSkillRoots),
      (skill) => `${skill.source}:${skill.path}`
    );

    const codexAgentRoots = [
      { root: path.join(process.env.HOME ?? "", ".codex", "agents"), scope: "user" as const, source: "codex" as const },
      { root: path.join(workspaceRoot, ".codex", "agents"), scope: "project" as const, source: "codex" as const },
      { root: path.join(workspaceRoot, ".agents", "agents"), scope: "project" as const, source: "codex" as const }
    ];
    const codexAgents = dedupeByKey(
      loadAgentsFromRoots(codexAgentRoots),
      (agent) => `${agent.source}:${agent.path}`
    );

    const contextWithoutReport = {
      generatedAt: new Date().toISOString(),
      workspaceRoot,
      environment: {
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ? "[set]" : undefined,
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:
          process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
        ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH
      },
      claude: {
        settingsFiles: claudeSettingsFiles,
        mergedSettings: mergedClaudeSettings,
        instructionFiles: claudeInstructionFiles,
        plugins: installedPlugins,
        hookSources: loadHookSources(mergedClaudeSettings, enabledPlugins),
        skills: claudeSkills,
        agents: claudeAgents,
        mcpServers: loadClaudeMcpServers(workspaceRoot, enabledPlugins)
      },
      codex: {
        configFiles: codexConfigFiles,
        mergedConfig: mergedCodexConfig,
        skills: codexSkills,
        agents: codexAgents,
        mcpServers: loadCodexMcpServers(mergedCodexConfig, codexConfigFiles)
      }
    };

    return {
      ...contextWithoutReport,
      report: buildCompatibilityReport(contextWithoutReport)
    };
  }
}
