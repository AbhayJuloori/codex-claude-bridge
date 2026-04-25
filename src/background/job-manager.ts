import crypto from "node:crypto";
import path from "node:path";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { CompatibilityContext } from "../config/types.js";
import { appendJsonLine, ensureDirectory, readJsonFileSafe, writeJsonFile } from "../config/fs-utils.js";
import type { InternalTask } from "../types/internal.js";
import type { CodexAdapter } from "../adapters/base.js";
import { AgentOrchestrator, type TaskGraphNode } from "../agents/orchestrator.js";
import type { HookEventBus } from "../hooks/event-bus.js";

export type BackgroundJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface BackgroundJobRecord {
  id: string;
  sessionId: string;
  requestId: string;
  createdAt: string;
  updatedAt: string;
  status: BackgroundJobStatus;
  strategy: "direct" | "planner-worker";
  promptPreview: string;
  finalText: string | null;
  error: string | null;
  taskGraph: TaskGraphNode[];
  eventLogPath: string;
}

export class BackgroundJobManager {
  private readonly jobsDir: string;
  private readonly eventsDir: string;
  private readonly emitter = new EventEmitter();
  private readonly controllers = new Map<string, AbortController>();
  private readonly orchestrator: AgentOrchestrator;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
    private readonly hooks: HookEventBus
  ) {
    this.jobsDir = path.join(config.runtime.stateDir, "jobs");
    this.eventsDir = path.join(this.jobsDir, "events");
    ensureDirectory(this.jobsDir);
    ensureDirectory(this.eventsDir);
    this.orchestrator = new AgentOrchestrator(logger);
  }

  list(): BackgroundJobRecord[] {
    return fs
      .readdirSync(this.jobsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJsonFileSafe<BackgroundJobRecord>(path.join(this.jobsDir, name)))
      .filter((item): item is BackgroundJobRecord => Boolean(item))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(jobId: string): BackgroundJobRecord | null {
    return readJsonFileSafe<BackgroundJobRecord>(this.getJobPath(jobId));
  }

  onEvent(listener: (job: BackgroundJobRecord, event: Record<string, unknown>) => void): void {
    this.emitter.on("job-event", ({ job, event }) => listener(job, event));
  }

  submit(
    adapter: CodexAdapter,
    task: InternalTask,
    context: CompatibilityContext
  ): BackgroundJobRecord {
    const id = crypto.randomUUID();
    const eventLogPath = path.join(this.eventsDir, `${id}.jsonl`);
    const strategy =
      task.sourceRequest.metadata?.bridge_execution === "planner-worker"
        ? "planner-worker"
        : "direct";

    const record: BackgroundJobRecord = {
      id,
      sessionId: task.sessionId,
      requestId: task.requestId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "queued",
      strategy,
      promptPreview: task.prompt.slice(0, 240),
      finalText: null,
      error: null,
      taskGraph: [],
      eventLogPath
    };

    this.persist(record);
    this.emit(record, { type: "queued" });
    this.hooks.emit({
      name: "background.queued",
      payload: {
        jobId: id,
        requestId: task.requestId,
        sessionId: task.sessionId
      }
    });

    const controller = new AbortController();
    this.controllers.set(id, controller);

    void this.run(adapter, task, context, record, controller);
    return record;
  }

  cancel(jobId: string): BackgroundJobRecord | null {
    const job = this.get(jobId);
    if (!job) {
      return null;
    }

    const controller = this.controllers.get(jobId);
    if (controller) {
      controller.abort();
    }

    job.status = "cancelled";
    job.updatedAt = new Date().toISOString();
    this.persist(job);
    this.emit(job, { type: "cancelled" });
    this.hooks.emit({
      name: "background.cancelled",
      payload: {
        jobId
      }
    });

    return job;
  }

  private async run(
    adapter: CodexAdapter,
    task: InternalTask,
    context: CompatibilityContext,
    job: BackgroundJobRecord,
    controller: AbortController
  ): Promise<void> {
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    this.persist(job);
    this.emit(job, { type: "started" });
    this.hooks.emit({
      name: "background.started",
      payload: {
        jobId: job.id,
        requestId: task.requestId,
        sessionId: task.sessionId
      }
    });

    try {
      const result = await this.orchestrator.run(adapter, task, context, controller.signal);
      if (controller.signal.aborted) {
        job.status = "cancelled";
      } else {
        job.status = "completed";
      }
      job.finalText = result.finalText;
      job.taskGraph = result.taskGraph;
      job.updatedAt = new Date().toISOString();
      this.persist(job);
      this.emit(job, { type: job.status, finalText: result.finalText, taskGraph: result.taskGraph });
      this.hooks.emit({
        name: "background.completed",
        payload: {
          jobId: job.id,
          finalText: result.finalText
        }
      });
    } catch (error) {
      if (controller.signal.aborted) {
        job.status = "cancelled";
      } else {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
      }
      job.updatedAt = new Date().toISOString();
      this.persist(job);
      this.emit(job, { type: job.status, error: job.error });
      this.hooks.emit({
        name: controller.signal.aborted ? "background.cancelled" : "background.failed",
        payload: {
          jobId: job.id,
          error: job.error
        }
      });
    } finally {
      this.controllers.delete(job.id);
    }
  }

  private persist(job: BackgroundJobRecord): void {
    writeJsonFile(this.getJobPath(job.id), job);
  }

  private emit(job: BackgroundJobRecord, event: Record<string, unknown>): void {
    appendJsonLine(job.eventLogPath, {
      ts: new Date().toISOString(),
      ...event
    });
    this.emitter.emit("job-event", { job, event });
  }

  private getJobPath(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.json`);
  }
}
