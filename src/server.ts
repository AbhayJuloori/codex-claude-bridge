import crypto from "node:crypto";
import fs from "node:fs";
import express, { type Request, type Response } from "express";
import type { BridgeConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { CompatibilityContextLoader } from "./config/compatibility-loader.js";
import {
  anthropicCountTokensRequestSchema,
  anthropicMessagesRequestSchema
} from "./types/anthropic.js";
import { mapAnthropicRequestToTask } from "./services/message-mapper.js";
import { estimateTokensFromText } from "./services/token-estimator.js";
import {
  finalizeAnthropicSse,
  initializeAnthropicSse,
  writeAnthropicError,
  writeAnthropicTextDelta
} from "./services/sse.js";
import type { CodexAdapter } from "./adapters/base.js";
import type { AdapterEvent, InternalTask, TokenUsage } from "./types/internal.js";
import { HookEventBus } from "./hooks/event-bus.js";
import { PersistentSessionStore } from "./session/persistent-session-store.js";
import { BackgroundJobManager } from "./background/job-manager.js";
import { DiagnosticsService } from "./diagnostics/service.js";
import { delegateManifestSchema } from "./delegation/manifest.js";
import { DelegationOrchestrator } from "./delegation/orchestrator.js";
import { ClaudeSubprocessManager } from "./claude/subprocess.js";
import { createBaseAdapter } from "./adapters/index.js";

function getRequestId(): string {
  return crypto.randomUUID();
}

function getSessionId(request: Request): string {
  const headerValue = request.header("x-claude-code-session-id");
  return headerValue && headerValue.trim() ? headerValue : crypto.randomUUID();
}

function readAuthToken(request: Request): string | null {
  const authHeader = request.header("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }

  const xApiKey = request.header("x-api-key");
  return xApiKey?.trim() || null;
}

function unauthorized(response: Response): void {
  response.status(401).json({
    type: "error",
    error: {
      type: "authentication_error",
      message: "Missing or invalid local bridge credentials"
    }
  });
}

function isBackgroundRequest(request: Request): boolean {
  const header = request.header("x-codex-background");
  if (header && ["1", "true", "yes"].includes(header.toLowerCase())) {
    return true;
  }

  const body = request.body as Record<string, unknown> | undefined;
  const metadata = body?.metadata as Record<string, unknown> | undefined;
  return metadata?.bridge_background === true;
}

function getEventLogLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
}

export function createServer(config: BridgeConfig, logger: Logger, adapter: CodexAdapter) {
  const app = express();
  const hooks = new HookEventBus(config, logger);
  const sessions = new PersistentSessionStore(config);
  const compatibilityLoader = new CompatibilityContextLoader(config);
  const diagnostics = new DiagnosticsService(config, logger);
  const backgroundJobs = new BackgroundJobManager(config, logger, hooks);
  const delegateWorker = createBaseAdapter(config, logger);
  const delegateClaude = new ClaudeSubprocessManager(config, logger);
  const delegationOrchestrator = new DelegationOrchestrator(config, logger, delegateWorker, delegateClaude);
  let lastProbe: unknown = null;

  function handleAdapterEvent(
    event: AdapterEvent,
    requestId: string,
    sessionId: string
  ): {
    appendedText?: string;
    completedText?: string;
    usage?: TokenUsage;
  } {
    if (event.type === "debug") {
      logger.debug("adapter", event.message, {
        requestId,
        sessionId,
        raw: event.raw
      });
      return {};
    }

    if (event.type === "strategy-selected") {
      sessions.appendEvent(sessionId, {
        type: "request.strategy_selected",
        requestId,
        mode: event.mode,
        rationale: event.rationale
      });
      return {};
    }

    if (event.type === "packet") {
      sessions.appendEvent(sessionId, {
        type: "request.packet",
        requestId,
        packetKind: event.packetKind,
        bytes: event.bytes,
        packet: event.packet
      });
      return {};
    }

    if (event.type === "tool-call") {
      sessions.appendEvent(sessionId, {
        type: "request.tool_call",
        requestId,
        callId: event.callId,
        tool: event.tool,
        args: event.args
      });
      hooks.emit({
        name: "request.tool_call",
        payload: {
          requestId,
          sessionId,
          callId: event.callId,
          tool: event.tool,
          args: event.args
        }
      });
      return {};
    }

    if (event.type === "tool-result") {
      sessions.appendEvent(sessionId, {
        type: "request.tool_result",
        requestId,
        callId: event.callId,
        tool: event.tool,
        ok: event.ok,
        summary: event.summary,
        error: event.error ?? null
      });
      hooks.emit({
        name: "request.tool_result",
        payload: {
          requestId,
          sessionId,
          callId: event.callId,
          tool: event.tool,
          ok: event.ok,
          summary: event.summary,
          error: event.error ?? null
        }
      });
      return {};
    }

    if (event.type === "text-delta") {
      return {
        appendedText: event.text
      };
    }

    if (event.type === "completed") {
      return {
        completedText: event.finalText,
        usage: event.usage
      };
    }

    return {};
  }

  app.use(
    express.json({
      limit: "5mb"
    })
  );

  app.use((request, response, next) => {
    if (!config.proxy.requireBearer) {
      next();
      return;
    }

    const providedToken = readAuthToken(request);
    if (providedToken !== config.proxy.bearerToken) {
      unauthorized(response);
      return;
    }

    next();
  });

  app.get("/health", async (_request, response) => {
    if (!lastProbe) {
      lastProbe = await adapter.probe();
    }

    const context = compatibilityLoader.load();

    response.json({
      ok: true,
      name: "codex-claude-bridge",
      adapter: adapter.name,
      config: {
        adapterMode: config.adapterMode,
        codexCwd: config.codex.cwd,
        codexSandbox: config.codex.sandbox
      },
      probe: lastProbe,
      compatibility: {
        hooks: context.claude.hookSources.length,
        skills: context.claude.skills.length + context.codex.skills.length,
        agents: context.claude.agents.length + context.codex.agents.length,
        claudeMcpServers: context.claude.mcpServers.length,
        codexMcpServers: context.codex.mcpServers.length
      }
    });
  });

  app.get("/diagnostics/config", (_request, response) => {
    const context = compatibilityLoader.load();
    response.json(context);
  });

  app.get("/diagnostics/compatibility", (_request, response) => {
    const context = compatibilityLoader.load();
    response.json(context.report);
  });

  app.get("/diagnostics/mcp", async (_request, response) => {
    response.json(await diagnostics.buildDiagnostics());
  });

  app.post("/diagnostics/mcp/reload", async (_request, response) => {
    response.json(await diagnostics.reloadMcp());
  });

  app.get("/diagnostics/sessions", (_request, response) => {
    response.json({
      sessions: sessions.list()
    });
  });

  app.get("/diagnostics/sessions/:sessionId", (request, response) => {
    const session = sessions.get(request.params.sessionId);
    if (!session) {
      response.status(404).json({ error: "session not found" });
      return;
    }

    response.json({
      session,
      events: getEventLogLines(sessions.getEventLogPath(request.params.sessionId))
    });
  });

  app.get("/jobs", (_request, response) => {
    response.json({
      jobs: backgroundJobs.list()
    });
  });

  app.get("/jobs/:jobId", (request, response) => {
    const job = backgroundJobs.get(request.params.jobId);
    if (!job) {
      response.status(404).json({ error: "job not found" });
      return;
    }

    response.json(job);
  });

  app.get("/jobs/:jobId/events", (request, response) => {
    const job = backgroundJobs.get(request.params.jobId);
    if (!job) {
      response.status(404).json({ error: "job not found" });
      return;
    }

    response.json({
      jobId: job.id,
      events: getEventLogLines(job.eventLogPath)
    });
  });

  app.post("/jobs/:jobId/cancel", (request, response) => {
    const job = backgroundJobs.cancel(request.params.jobId);
    if (!job) {
      response.status(404).json({ error: "job not found" });
      return;
    }

    response.json(job);
  });

  app.post("/v1/messages/count_tokens", (request, response) => {
    const requestId = getRequestId();
    const context = compatibilityLoader.load();

    const parsed = anthropicCountTokensRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: parsed.error.message
        }
      });
      return;
    }

    const normalized = [
      typeof parsed.data.system === "string"
        ? parsed.data.system
        : JSON.stringify(parsed.data.system ?? []),
      JSON.stringify(parsed.data.messages),
      JSON.stringify(parsed.data.tools ?? []),
      context.claude.instructionFiles.map((file) => file.content).join("\n"),
      context.claude.skills.map((skill) => `${skill.name}:${skill.description ?? ""}`).join("\n")
    ].join("\n");

    const inputTokens = estimateTokensFromText(normalized);

    logger.info("http", "count_tokens estimate returned", {
      requestId,
      inputTokens
    });

    response.setHeader("x-codex-claude-bridge-counting", "estimated");
    response.json({
      input_tokens: inputTokens
    });
  });

  app.post("/v1/messages/background", async (request, response) => {
    const requestId = getRequestId();
    const sessionId = getSessionId(request);
    const context = compatibilityLoader.load();

    const parsed = anthropicMessagesRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: parsed.error.message
        }
      });
      return;
    }

    const task = mapAnthropicRequestToTask(parsed.data, requestId, sessionId, context);
    const backgroundTask = {
      ...task,
      stream: false,
      sourceRequest: {
        ...task.sourceRequest,
        metadata: {
          ...(task.sourceRequest.metadata ?? {}),
          bridge_execution: config.runtime.plannerWorkersEnabled
            ? "planner-worker"
            : "direct",
          bridge_background: true
        }
      }
    };

    const job = backgroundJobs.submit(adapter, backgroundTask, context);
    response.status(202).json({
      type: "job",
      id: job.id,
      status: job.status,
      polling_url: `/jobs/${job.id}`,
      events_url: `/jobs/${job.id}/events`
    });
  });

  app.post("/v1/messages", async (request, response) => {
    const requestId = getRequestId();
    const sessionId = getSessionId(request);
    const context = compatibilityLoader.load();
    const session = sessions.touch(sessionId);

    const parsed = anthropicMessagesRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      logger.warn("http", "invalid anthropic request", {
        requestId,
        issues: parsed.error.issues
      });

      response.status(400).json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: parsed.error.message
        }
      });
      return;
    }

    const task = mapAnthropicRequestToTask(parsed.data, requestId, sessionId, context);
    const estimatedInputTokens = estimateTokensFromText(task.prompt);
    const messageId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;

    sessions.appendMessages(sessionId, [
      {
        ts: new Date().toISOString(),
        role: "user",
        content: task.prompt,
        requestId
      }
    ]);
    sessions.appendEvent(sessionId, {
      type: "request.inbound",
      requestId,
      stream: task.stream,
      toolCount: task.tools.length
    });

    hooks.emit({
      name: "request.inbound",
      payload: {
        requestId,
        sessionId,
        model: task.requestedModel,
        stream: task.stream,
        toolCount: task.tools.length
      }
    });

    logger.info("http", "processing anthropic request", {
      requestId,
      sessionId,
      requestCount: session.requestCount,
      model: task.requestedModel,
      stream: task.stream,
      toolCount: task.tools.length,
      selectedSkills: task.selectedSkills.map((skill) => skill.name),
      selectedAgent: task.selectedAgent?.name ?? null,
      permissionMode: task.permissionContext.mode
    });

    if (isBackgroundRequest(request)) {
      const backgroundTask = {
        ...task,
        stream: false,
        sourceRequest: {
          ...task.sourceRequest,
          metadata: {
            ...(task.sourceRequest.metadata ?? {}),
            bridge_execution: config.runtime.plannerWorkersEnabled
              ? "planner-worker"
              : "direct"
          }
        }
      };
      const job = backgroundJobs.submit(adapter, backgroundTask, context);
      response.status(202).json({
        type: "job",
        id: job.id,
        status: job.status,
        polling_url: `/jobs/${job.id}`,
        events_url: `/jobs/${job.id}/events`
      });
      return;
    }

    const controller = new AbortController();
    let cancellationEmitted = false;
    const cancelRequest = () => {
      if (response.writableEnded || cancellationEmitted) {
        return;
      }

      cancellationEmitted = true;
      controller.abort();
      hooks.emit({
        name: "request.cancelled",
        payload: {
          requestId,
          sessionId
        }
      });
    };

    request.on("aborted", cancelRequest);
    response.on("close", cancelRequest);

    hooks.emit({
      name: "request.pre_dispatch",
      payload: {
        requestId,
        sessionId,
        adapter: adapter.name,
        selectedSkills: task.selectedSkills.map((skill) => skill.name),
        selectedAgent: task.selectedAgent?.name ?? null
      }
    });

    if (task.stream) {
      initializeAnthropicSse(response, messageId, task.requestedModel, estimatedInputTokens);

      let finalText = "";
      let finalUsage: TokenUsage | undefined;

      try {
        for await (const event of adapter.execute(task, { signal: controller.signal })) {
          const handled = handleAdapterEvent(event, requestId, sessionId);

          if (handled.appendedText) {
            finalText += handled.appendedText;
            writeAnthropicTextDelta(response, handled.appendedText);
            hooks.emit({
              name: "request.stream_delta",
              payload: {
                requestId,
                sessionId,
                delta: handled.appendedText
              }
            });
          }

          if (handled.completedText !== undefined) {
            finalText = handled.completedText;
            finalUsage = handled.usage;
          }

          if (event.type === "text-delta") {
            continue;
          }
        }

        sessions.appendMessages(sessionId, [
          {
            ts: new Date().toISOString(),
            role: "assistant",
            content: finalText,
            requestId
          }
        ]);
        sessions.appendEvent(sessionId, {
          type: "request.completed",
          requestId,
          finalText
        });

        hooks.emit({
          name: "request.completed",
          payload: {
            requestId,
            sessionId,
            finalText
          }
        });

        finalizeAnthropicSse(
          response,
          finalText,
          finalUsage ?? {
            input_tokens: estimatedInputTokens,
            output_tokens: estimateTokensFromText(finalText)
          }
        );
      } catch (error) {
        logger.error("http", "streaming request failed", {
          requestId,
          sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
        sessions.appendEvent(sessionId, {
          type: "request.failed",
          requestId,
          error: error instanceof Error ? error.message : String(error)
        });
        hooks.emit({
          name: "request.failed",
          payload: {
            requestId,
            sessionId,
            error: error instanceof Error ? error.message : String(error)
          }
        });
        writeAnthropicError(
          response,
          error instanceof Error ? error.message : "unknown adapter failure"
        );
      }

      return;
    }

    let finalText = "";
    let finalUsage: TokenUsage | undefined;

    try {
      for await (const event of adapter.execute(task, { signal: controller.signal })) {
        const handled = handleAdapterEvent(event, requestId, sessionId);
        if (handled.appendedText) {
          finalText += handled.appendedText;
        }

        if (handled.completedText !== undefined) {
          finalText = handled.completedText;
          finalUsage = handled.usage;
        }
      }

      sessions.appendMessages(sessionId, [
        {
          ts: new Date().toISOString(),
          role: "assistant",
          content: finalText,
          requestId
        }
      ]);
      sessions.appendEvent(sessionId, {
        type: "request.completed",
        requestId,
        finalText
      });
      hooks.emit({
        name: "request.completed",
        payload: {
          requestId,
          sessionId,
          finalText
        }
      });

      response.json({
        id: messageId,
        type: "message",
        role: "assistant",
        model: task.requestedModel,
        content: [
          {
            type: "text",
            text: finalText
          }
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: finalUsage?.input_tokens ?? estimatedInputTokens,
          output_tokens:
            finalUsage?.output_tokens ?? estimateTokensFromText(finalText)
        }
      });
    } catch (error) {
      logger.error("http", "non-streaming request failed", {
        requestId,
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      sessions.appendEvent(sessionId, {
        type: "request.failed",
        requestId,
        error: error instanceof Error ? error.message : String(error)
      });
      hooks.emit({
        name: "request.failed",
        payload: {
          requestId,
          sessionId,
          error: error instanceof Error ? error.message : String(error)
        }
      });

      response.status(500).json({
        type: "error",
        error: {
          type: "api_error",
          message: error instanceof Error ? error.message : "unknown adapter failure"
        }
      });
    }
  });

  app.post("/delegate", async (request: Request, response: Response) => {
    const parsed = delegateManifestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        type: "error",
        error: { type: "invalid_request", message: parsed.error.message }
      });
      return;
    }

    const manifest = parsed.data;
    const requestId = getRequestId();
    const sessionId = getSessionId(request);

    logger.info("delegate", "starting delegation", {
      requestId,
      project: manifest.project,
      phases: manifest.phases.length,
      totalTasks: manifest.phases.flatMap((p) => p.tasks).length
    });

    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    // Construct a minimal InternalTask for the orchestrator
    const context = compatibilityLoader.load();
    const baseTask: InternalTask = {
      requestId,
      sessionId,
      requestedModel: "codex",
      maxTokens: 8192,
      stream: false,
      systemPrompt: "",
      messages: [{ role: "user", content: manifest.project }],
      tools: [],
      prompt: manifest.project,
      sourceRequest: {
        model: "codex",
        max_tokens: 8192,
        stream: false,
        messages: [{ role: "user", content: manifest.project }]
      },
      compatibilityContext: context,
      permissionContext: {
        mode: "default",
        rules: [],
        canEdit: true,
        canRunCommands: true,
        sandbox: config.codex.sandbox,
        appServerApprovalPolicy: "on-request",
        parityNotes: []
      },
      selectedSkills: [],
      selectedAgent: null,
      inputItems: [{ type: "text", text: manifest.project }]
    };

    try {
      for await (const event of delegationOrchestrator.run(manifest, baseTask)) {
        if (event.type === "delegate-progress") {
          response.write(`data: ${JSON.stringify({ type: "delegate-progress", ...event.event })}\n\n`);
        } else if (event.type === "text-delta") {
          response.write(`data: ${JSON.stringify({ type: "text-delta", text: event.text })}\n\n`);
        } else if (event.type === "completed") {
          response.write(`data: ${JSON.stringify({ type: "completed", finalText: event.finalText })}\n\n`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("delegate", "delegation failed", { requestId, error: message });
      response.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
    }

    response.write("data: [DONE]\n\n");
    response.end();
  });

  return app;
}
