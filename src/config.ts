import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AdapterMode, SandboxMode } from "./types/internal.js";

const syntheticHookSchema = z.object({
  type: z.enum(["command", "http"]),
  command: z.string().optional(),
  url: z.string().optional()
});

const toolsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  maxRounds: z.number().int().positive().optional(),
  bash: z
    .object({
      enabled: z.boolean().optional(),
      timeoutMs: z.number().int().positive().optional(),
      denyPatterns: z.array(z.string()).optional()
    })
    .optional(),
  readFile: z
    .object({
      enabled: z.boolean().optional()
    })
    .optional(),
  writeFile: z
    .object({
      enabled: z.boolean().optional(),
      allowCreateDirectories: z.boolean().optional()
    })
    .optional(),
  editFile: z
    .object({
      enabled: z.boolean().optional()
    })
    .optional(),
  allowedRoots: z.array(z.string()).optional()
});

const fileConfigSchema = z
  .object({
    port: z.number().int().positive().optional(),
    adapter: z.enum(["auto", "app-server", "exec"]).optional(),
    codex: z
      .object({
        bin: z.string().optional(),
        cwd: z.string().optional(),
        model: z.string().nullable().optional(),
        sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
        skipGitRepoCheck: z.boolean().optional()
      })
      .optional(),
    proxy: z
      .object({
        requireBearer: z.boolean().optional(),
        bearerToken: z.string().optional(),
        allowEstimatedCountTokens: z.boolean().optional()
      })
      .optional(),
    logging: z
      .object({
        level: z.enum(["debug", "info", "warn", "error"]).optional(),
        dir: z.string().optional()
      })
      .optional(),
    runtime: z
      .object({
        stateDir: z.string().optional(),
        plannerWorkersEnabled: z.boolean().optional(),
        pipelineEnabled: z.boolean().optional(),
        syntheticHooks: z.record(z.array(syntheticHookSchema)).optional()
      })
      .optional()
    ,
    tools: toolsConfigSchema.optional()
  })
  .default({});

export interface BridgeConfig {
  port: number;
  adapterMode: AdapterMode;
  configPath: string;
  codex: {
    bin: string;
    cwd: string;
    model: string | null;
    sandbox: SandboxMode;
    skipGitRepoCheck: boolean;
  };
  proxy: {
    requireBearer: boolean;
    bearerToken: string;
    allowEstimatedCountTokens: boolean;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
    dir: string;
  };
  runtime: {
    stateDir: string;
    plannerWorkersEnabled: boolean;
    pipelineEnabled: boolean;
    syntheticHooks: Record<
      string,
      Array<{
        type: "command" | "http";
        command?: string;
        url?: string;
      }>
    >;
  };
  tools: {
    enabled: boolean;
    maxRounds: number;
    allowedRoots: string[];
    bash: {
      enabled: boolean;
      timeoutMs: number;
      denyPatterns: string[];
    };
    readFile: {
      enabled: boolean;
    };
    writeFile: {
      enabled: boolean;
      allowCreateDirectories: boolean;
    };
    editFile: {
      enabled: boolean;
    };
  };
}

function asBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function loadFileConfig(configPath: string): z.infer<typeof fileConfigSchema> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  return fileConfigSchema.parse(raw);
}

export function loadConfig(): BridgeConfig {
  const cwd = process.cwd();
  const configPath =
    process.env.BRIDGE_CONFIG_PATH ??
    path.join(cwd, "codex-claude-bridge.config.json");
  const fileConfig = loadFileConfig(configPath);

  const port = Number(process.env.PORT ?? fileConfig.port ?? 8787);
  const adapterMode = (process.env.CODEX_ADAPTER ??
    fileConfig.adapter ??
    "auto") as AdapterMode;
  const codexCwd = path.resolve(
    cwd,
    process.env.CODEX_CWD ?? fileConfig.codex?.cwd ?? "."
  );
  const logDir = path.resolve(
    cwd,
    process.env.LOG_DIR ?? fileConfig.logging?.dir ?? ".logs"
  );
  const stateDir = path.resolve(
    cwd,
    process.env.STATE_DIR ?? fileConfig.runtime?.stateDir ?? ".state"
  );

  return {
    port,
    adapterMode,
    configPath,
    codex: {
      bin: process.env.CODEX_BIN ?? fileConfig.codex?.bin ?? "codex",
      cwd: codexCwd,
      model: process.env.CODEX_MODEL ?? fileConfig.codex?.model ?? null,
      sandbox: (process.env.CODEX_SANDBOX ??
        fileConfig.codex?.sandbox ??
        "read-only") as SandboxMode,
      skipGitRepoCheck: asBoolean(
        process.env.CODEX_SKIP_GIT_REPO_CHECK,
        fileConfig.codex?.skipGitRepoCheck ?? true
      )
    },
    proxy: {
      requireBearer: asBoolean(
        process.env.PROXY_REQUIRE_AUTH,
        fileConfig.proxy?.requireBearer ?? true
      ),
      bearerToken:
        process.env.PROXY_BEARER_TOKEN ??
        fileConfig.proxy?.bearerToken ??
        "codex-bridge-local",
      allowEstimatedCountTokens: asBoolean(
        process.env.PROXY_ALLOW_ESTIMATED_COUNT_TOKENS,
        fileConfig.proxy?.allowEstimatedCountTokens ?? true
      )
    },
    logging: {
      level:
        (process.env.LOG_LEVEL as BridgeConfig["logging"]["level"]) ??
        fileConfig.logging?.level ??
        "info",
      dir: logDir
    },
    runtime: {
      stateDir,
      plannerWorkersEnabled: asBoolean(
        process.env.PLANNER_WORKERS_ENABLED,
        fileConfig.runtime?.plannerWorkersEnabled ?? true
      ),
      pipelineEnabled: asBoolean(
        process.env.PIPELINE_ENABLED,
        fileConfig.runtime?.pipelineEnabled ?? false
      ),
      syntheticHooks: fileConfig.runtime?.syntheticHooks ?? {}
    },
    tools: {
      enabled: asBoolean(process.env.BRIDGE_TOOLS_ENABLED, fileConfig.tools?.enabled ?? true),
      maxRounds: Number(process.env.BRIDGE_TOOLS_MAX_ROUNDS ?? fileConfig.tools?.maxRounds ?? 8),
      allowedRoots: (
        process.env.BRIDGE_TOOLS_ALLOWED_ROOTS
          ? process.env.BRIDGE_TOOLS_ALLOWED_ROOTS.split(path.delimiter)
          : fileConfig.tools?.allowedRoots ?? [codexCwd]
      ).map((root) => path.resolve(cwd, root)),
      bash: {
        enabled: asBoolean(
          process.env.BRIDGE_TOOL_BASH_ENABLED,
          fileConfig.tools?.bash?.enabled ?? true
        ),
        timeoutMs: Number(
          process.env.BRIDGE_TOOL_BASH_TIMEOUT_MS ?? fileConfig.tools?.bash?.timeoutMs ?? 15000
        ),
        denyPatterns:
          fileConfig.tools?.bash?.denyPatterns ?? [
            "\\brm\\s+-rf\\s+/",
            "\\bsudo\\b",
            "\\bshutdown\\b",
            "\\breboot\\b",
            "\\bmkfs\\b",
            "\\bdd\\s+if=",
            "git\\s+reset\\s+--hard",
            "git\\s+checkout\\s+--",
            ":\\(\\)\\s*\\{\\s*:\\|:\\s*&\\s*\\};:"
          ]
      },
      readFile: {
        enabled: asBoolean(
          process.env.BRIDGE_TOOL_READ_FILE_ENABLED,
          fileConfig.tools?.readFile?.enabled ?? true
        )
      },
      writeFile: {
        enabled: asBoolean(
          process.env.BRIDGE_TOOL_WRITE_FILE_ENABLED,
          fileConfig.tools?.writeFile?.enabled ?? true
        ),
        allowCreateDirectories: asBoolean(
          process.env.BRIDGE_TOOL_WRITE_ALLOW_CREATE_DIRECTORIES,
          fileConfig.tools?.writeFile?.allowCreateDirectories ?? true
        )
      },
      editFile: {
        enabled: asBoolean(
          process.env.BRIDGE_TOOL_EDIT_FILE_ENABLED,
          fileConfig.tools?.editFile?.enabled ?? true
        )
      }
    }
  };
}
