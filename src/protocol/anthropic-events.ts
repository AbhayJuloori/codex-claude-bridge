import { estimateTokensFromText } from "../services/token-estimator.js";
import type { TokenUsage } from "../types/internal.js";

export type AnthropicSseEventName =
  | "message_start"
  | "content_block_start"
  | "content_block_delta"
  | "content_block_stop"
  | "message_delta"
  | "message_stop"
  | "error";

export interface AnthropicSseEvent {
  event: AnthropicSseEventName;
  payload: Record<string, unknown>;
}

export function buildMessageStartEvent(
  messageId: string,
  model: string,
  estimatedInputTokens: number
): AnthropicSseEvent {
  return {
    event: "message_start",
    payload: {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: estimatedInputTokens,
          output_tokens: 0
        }
      }
    }
  };
}

export function buildContentBlockStartEvent(): AnthropicSseEvent {
  return {
    event: "content_block_start",
    payload: {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "text",
        text: ""
      }
    }
  };
}

export function buildTextDeltaEvent(text: string): AnthropicSseEvent {
  return {
    event: "content_block_delta",
    payload: {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text
      }
    }
  };
}

export function buildContentBlockStopEvent(): AnthropicSseEvent {
  return {
    event: "content_block_stop",
    payload: {
      type: "content_block_stop",
      index: 0
    }
  };
}

export function buildMessageDeltaEvent(
  finalText: string,
  usage?: TokenUsage
): AnthropicSseEvent {
  const finalUsage = usage ?? {
    input_tokens: 0,
    output_tokens: estimateTokensFromText(finalText)
  };

  return {
    event: "message_delta",
    payload: {
      type: "message_delta",
      delta: {
        stop_reason: "end_turn",
        stop_sequence: null
      },
      usage: {
        input_tokens: finalUsage.input_tokens,
        output_tokens: finalUsage.output_tokens
      }
    }
  };
}

export function buildMessageStopEvent(): AnthropicSseEvent {
  return {
    event: "message_stop",
    payload: {
      type: "message_stop"
    }
  };
}

export function buildErrorEvent(message: string): AnthropicSseEvent {
  return {
    event: "error",
    payload: {
      type: "error",
      error: {
        type: "api_error",
        message
      }
    }
  };
}

export function buildStreamingFixture(
  messageId: string,
  model: string,
  estimatedInputTokens: number,
  textChunks: string[],
  finalText: string,
  usage?: TokenUsage
): AnthropicSseEvent[] {
  return [
    buildMessageStartEvent(messageId, model, estimatedInputTokens),
    buildContentBlockStartEvent(),
    ...textChunks.map((chunk) => buildTextDeltaEvent(chunk)),
    buildContentBlockStopEvent(),
    buildMessageDeltaEvent(finalText, usage),
    buildMessageStopEvent()
  ];
}
