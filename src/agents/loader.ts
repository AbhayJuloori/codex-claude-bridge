import path from "node:path";
import matter from "gray-matter";
import { listFilesRecursive, readTextFileSafe } from "../config/fs-utils.js";
import type { AgentDefinition, ConfigScope } from "../config/types.js";

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function parseAgentFile(
  filePath: string,
  scope: ConfigScope,
  source: "claude" | "codex"
): AgentDefinition | null {
  const raw = readTextFileSafe(filePath);
  if (!raw) {
    return null;
  }

  const parsed = matter(raw);
  const fallbackName = path.basename(filePath, path.extname(filePath));

  return {
    id: `${source}:${fallbackName}`,
    name:
      (typeof parsed.data.name === "string" && parsed.data.name.trim()) || fallbackName,
    path: filePath,
    source,
    scope,
    description:
      typeof parsed.data.description === "string" ? parsed.data.description : null,
    prompt: parsed.content.trim(),
    frontmatter: parsed.data as Record<string, unknown>,
    tools: parseStringArray(parsed.data.tools),
    skills: parseStringArray(parsed.data.skills),
    model: typeof parsed.data.model === "string" ? parsed.data.model : null
  };
}

export function loadAgentsFromRoots(
  roots: Array<{ root: string; scope: ConfigScope; source: "claude" | "codex" }>
): AgentDefinition[] {
  const agents: AgentDefinition[] = [];

  for (const root of roots) {
    const agentPaths = listFilesRecursive(
      root.root,
      (absolutePath) => absolutePath.endsWith(".md") && absolutePath.includes(`${path.sep}agents${path.sep}`),
      8
    );

    for (const agentPath of agentPaths) {
      const parsed = parseAgentFile(agentPath, root.scope, root.source);
      if (parsed) {
        agents.push(parsed);
      }
    }
  }

  return agents;
}

export function findReferencedAgent(
  agents: AgentDefinition[],
  text: string,
  defaultAgent: string | null
): AgentDefinition | null {
  const lowered = text.toLowerCase();

  if (defaultAgent) {
    const direct = agents.find(
      (agent) =>
        agent.name.toLowerCase() === defaultAgent.toLowerCase() ||
        agent.id.toLowerCase() === defaultAgent.toLowerCase()
    );
    if (direct) {
      return direct;
    }
  }

  return (
    agents.find((agent) => lowered.includes(`@agent-${agent.name.toLowerCase()}`)) ??
    agents.find((agent) => lowered.includes(agent.name.toLowerCase())) ??
    null
  );
}
