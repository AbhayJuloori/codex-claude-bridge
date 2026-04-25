import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest
} from "../types/anthropic.js";
import type { InternalTask } from "../types/internal.js";
import type { CompatibilityContext, SkillDefinition } from "../config/types.js";
import { derivePermissionContext } from "../permissions/policy.js";
import { findReferencedSkills } from "../skills/loader.js";
import { findReferencedAgent } from "../agents/loader.js";

function stringifyUnknown(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function flattenContent(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((block) => {
      if (block.type === "text" && "text" in block) {
        return block.text;
      }

      if (block.type === "tool_use") {
        return [
          "[tool_use]",
          `name=${String(block.name ?? "unknown")}`,
          `id=${String(block.id ?? "unknown")}`,
          stringifyUnknown(block.input ?? {})
        ].join("\n");
      }

      if (block.type === "tool_result") {
        return [
          "[tool_result]",
          `tool_use_id=${String(block.tool_use_id ?? "unknown")}`,
          stringifyUnknown(block.content ?? "")
        ].join("\n");
      }

      return `[unsupported_content_block type=${block.type}]\n${stringifyUnknown(block)}`;
    })
    .join("\n\n");
}

function renderSystem(system: AnthropicMessagesRequest["system"]): string {
  if (!system) {
    return "";
  }

  if (typeof system === "string") {
    return system;
  }

  return flattenContent(system);
}

function renderMessages(messages: AnthropicMessage[]): string {
  return messages
    .map((message, index) => {
      const label = message.role.toUpperCase();
      return `Message ${index + 1} (${label})\n${flattenContent(message.content)}`;
    })
    .join("\n\n");
}

function renderTools(request: AnthropicMessagesRequest): string {
  if (!request.tools?.length) {
    return "";
  }

  return request.tools
    .map((tool) => {
      return [
        `Tool: ${tool.name}`,
        tool.description ? `Description: ${tool.description}` : null,
        tool.input_schema ? `Input schema: ${stringifyUnknown(tool.input_schema)}` : null
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function renderSkillContext(skills: SkillDefinition[]): string {
  if (!skills.length) {
    return "";
  }

  return skills
    .map((skill) => {
      return [
        `Skill: ${skill.name}`,
        `Path: ${skill.path}`,
        skill.description ? `Description: ${skill.description}` : null,
        `Content:\n${skill.content}`
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

export function mapAnthropicRequestToTask(
  request: AnthropicMessagesRequest,
  requestId: string,
  sessionId: string,
  compatibilityContext: CompatibilityContext
): InternalTask {
  const systemPrompt = renderSystem(request.system);
  const toolText = renderTools(request);
  const transcript = renderMessages(request.messages);
  const combinedText = [systemPrompt, transcript, request.model].join("\n");
  const allSkills = [...compatibilityContext.claude.skills, ...compatibilityContext.codex.skills];
  const defaultAgent =
    (compatibilityContext.claude.mergedSettings.agent as string | undefined) ?? null;
  const selectedAgent = findReferencedAgent(
    compatibilityContext.claude.agents,
    combinedText,
    defaultAgent
  );

  const explicitSkills = findReferencedSkills(allSkills, combinedText);
  const agentSkills = selectedAgent
    ? allSkills.filter((skill) =>
        selectedAgent.skills.some(
          (name) =>
            skill.name.toLowerCase() === name.toLowerCase() ||
            skill.id.toLowerCase() === name.toLowerCase()
        )
      )
    : [];
  const selectedSkills = Array.from(new Map(
    [...explicitSkills, ...agentSkills].map((skill) => [skill.path, skill])
  ).values());

  const permissionContext = derivePermissionContext(compatibilityContext);
  const configSummary = [
    `Permission mode: ${permissionContext.mode}`,
    `Can edit: ${permissionContext.canEdit}`,
    `Can run commands: ${permissionContext.canRunCommands}`,
    selectedAgent ? `Selected agent: ${selectedAgent.name}` : null,
    compatibilityContext.claude.mcpServers.length
      ? `Claude MCP servers detected: ${compatibilityContext.claude.mcpServers.map((server) => server.name).join(", ")}`
      : null,
    compatibilityContext.codex.mcpServers.length
      ? `Codex MCP servers detected: ${compatibilityContext.codex.mcpServers.map((server) => server.name).join(", ")}`
      : null
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    "You are answering a request that came through an Anthropic Messages compatibility bridge.",
    "Return only the assistant's next reply as plain text unless the task explicitly demands a structured format.",
    "Do not claim tool calls that you did not actually perform.",
    "Treat original Claude tool definitions and tool results as transcript context unless the local runtime truly executed them.",
    systemPrompt ? `System prompt\n${systemPrompt}` : null,
    compatibilityContext.claude.instructionFiles.length
      ? `Loaded CLAUDE instructions\n${compatibilityContext.claude.instructionFiles
          .map((file) => `File: ${file.path}\n${file.content}`)
          .join("\n\n")}`
      : null,
    configSummary ? `Compatibility runtime context\n${configSummary}` : null,
    selectedAgent
      ? `Selected Claude-compatible agent\nName: ${selectedAgent.name}\nDescription: ${selectedAgent.description ?? "n/a"}\nPrompt:\n${selectedAgent.prompt}`
      : null,
    selectedSkills.length
      ? `Selected skills\n${renderSkillContext(
          selectedSkills.filter((skill) => skill.source === "claude")
        )}`
      : null,
    toolText ? `Available tools in the original client\n${toolText}` : null,
    `Conversation transcript\n${transcript}`
  ]
    .filter(Boolean)
    .join("\n\n");

  const inputItems = [
    ...selectedSkills
      .filter((skill) => skill.source === "codex")
      .map((skill) => ({
        type: "skill" as const,
        name: skill.name,
        path: skill.path
      })),
    {
      type: "text" as const,
      text: prompt
    }
  ];

  return {
    requestId,
    sessionId,
    requestedModel: request.model,
    maxTokens: request.max_tokens,
    stream: request.stream ?? false,
    systemPrompt,
    messages: request.messages,
    tools: request.tools ?? [],
    prompt,
    sourceRequest: request,
    compatibilityContext,
    permissionContext,
    selectedSkills,
    selectedAgent,
    inputItems
  };
}
