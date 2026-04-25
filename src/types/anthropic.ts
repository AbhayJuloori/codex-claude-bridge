import { z } from "zod";

const textContentBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string()
});

const toolUseContentBlockSchema = z
  .object({
    type: z.literal("tool_use"),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.unknown().optional()
  })
  .passthrough();

const toolResultContentBlockSchema = z
  .object({
    type: z.literal("tool_result"),
    tool_use_id: z.string().optional(),
    content: z.unknown().optional()
  })
  .passthrough();

const genericContentBlockSchema = z
  .object({
    type: z.string()
  })
  .passthrough();

export const anthropicContentBlockSchema = z.union([
  textContentBlockSchema,
  toolUseContentBlockSchema,
  toolResultContentBlockSchema,
  genericContentBlockSchema
]);

export const anthropicMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(anthropicContentBlockSchema)])
});

export const anthropicToolSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.unknown().optional()
  })
  .passthrough();

export const anthropicMessagesRequestSchema = z
  .object({
    model: z.string(),
    max_tokens: z.number().int().positive().default(1024),
    messages: z.array(anthropicMessageSchema),
    system: z.union([z.string(), z.array(anthropicContentBlockSchema)]).optional(),
    metadata: z.record(z.unknown()).optional(),
    stream: z.boolean().optional().default(false),
    tools: z.array(anthropicToolSchema).optional(),
    tool_choice: z.unknown().optional(),
    stop_sequences: z.array(z.string()).optional(),
    temperature: z.number().optional(),
    thinking: z.unknown().optional()
  })
  .passthrough();

export const anthropicCountTokensRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(anthropicMessageSchema),
    system: z.union([z.string(), z.array(anthropicContentBlockSchema)]).optional(),
    tools: z.array(anthropicToolSchema).optional()
  })
  .passthrough();

export type AnthropicContentBlock = z.infer<typeof anthropicContentBlockSchema>;
export type AnthropicMessage = z.infer<typeof anthropicMessageSchema>;
export type AnthropicTool = z.infer<typeof anthropicToolSchema>;
export type AnthropicMessagesRequest = z.infer<typeof anthropicMessagesRequestSchema>;
export type AnthropicCountTokensRequest = z.infer<typeof anthropicCountTokensRequestSchema>;
