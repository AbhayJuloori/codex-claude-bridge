import type { Response } from "express";
import type { TokenUsage } from "../types/internal.js";
import {
  buildContentBlockStartEvent,
  buildContentBlockStopEvent,
  buildErrorEvent,
  buildMessageDeltaEvent,
  buildMessageStartEvent,
  buildMessageStopEvent,
  buildTextDeltaEvent
} from "../protocol/anthropic-events.js";

function writeEvent(response: Response, event: string, payload: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function initializeAnthropicSse(
  response: Response,
  messageId: string,
  model: string,
  estimatedInputTokens: number
): void {
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();

  const messageStart = buildMessageStartEvent(messageId, model, estimatedInputTokens);
  const contentBlockStart = buildContentBlockStartEvent();

  writeEvent(response, messageStart.event, messageStart.payload);
  writeEvent(response, contentBlockStart.event, contentBlockStart.payload);
}

export function writeAnthropicTextDelta(response: Response, text: string): void {
  const delta = buildTextDeltaEvent(text);
  writeEvent(response, delta.event, delta.payload);
}

export function finalizeAnthropicSse(
  response: Response,
  finalText: string,
  usage?: TokenUsage
): void {
  const contentBlockStop = buildContentBlockStopEvent();
  const messageDelta = buildMessageDeltaEvent(finalText, usage);
  const messageStop = buildMessageStopEvent();

  writeEvent(response, contentBlockStop.event, contentBlockStop.payload);
  writeEvent(response, messageDelta.event, messageDelta.payload);
  writeEvent(response, messageStop.event, messageStop.payload);

  response.end();
}

export function writeAnthropicError(response: Response, message: string): void {
  const errorEvent = buildErrorEvent(message);
  writeEvent(response, errorEvent.event, errorEvent.payload);

  response.end();
}
