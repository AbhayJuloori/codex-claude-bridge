import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import {
  decideCommandApproval,
  decideFileChangeApproval,
  type PermissionContext
} from "../permissions/policy.js";
import type {
  AdapterEvent,
  AdapterProbeResult,
  BridgeInputItem,
  ExecutionOptions,
  InternalTask,
  TokenUsage
} from "../types/internal.js";
import type { CodexAdapter } from "./base.js";
import { extractText } from "./text-extraction.js";

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
};

type ServerRequestHandler = (
  message: JsonRpcMessage
) => Promise<Record<string, unknown> | undefined>;

class AppServerSession {
  constructor(
    private readonly write: (payload: Record<string, unknown>) => void,
    private readonly nextId: () => number,
    private readonly setPending: (
      id: number,
      resolve: (value: Record<string, unknown>) => void,
      reject: (error: Error) => void
    ) => void,
    private readonly notifications: JsonRpcMessage[],
    private readonly getClosedError: () => Error | null
  ) {}

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "codex-claude-bridge",
        version: "0.2.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });

    this.notify("initialized", {});
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId();
    this.write({
      id,
      method,
      params
    });

    return new Promise((resolve, reject) => {
      this.setPending(id, resolve, reject);
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  async waitForNotification(
    predicate: (message: JsonRpcMessage) => boolean,
    timeoutMs = 120000
  ): Promise<JsonRpcMessage> {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const closedError = this.getClosedError();
      if (closedError) {
        throw closedError;
      }

      const index = this.notifications.findIndex(predicate);
      if (index >= 0) {
        const [message] = this.notifications.splice(index, 1);
        return message;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error("timed out waiting for app-server notification");
  }
}

class AppServerClient {
  private requestId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger
  ) {}

  async run<T>(
    fn: (session: AppServerSession) => Promise<T>,
    options?: {
      signal?: AbortSignal;
      onServerRequest?: ServerRequestHandler;
    }
  ): Promise<T> {
    const child = spawn(this.config.codex.bin, ["app-server"], {
      cwd: this.config.codex.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const notifications: JsonRpcMessage[] = [];
    const stdout = createInterface({ input: child.stdout });
    const stderr = createInterface({ input: child.stderr });
    let closedError: Error | null = null;

    const write = (payload: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };

    const handleServerRequest = async (message: JsonRpcMessage) => {
      if (!message.method || typeof message.id !== "number") {
        return;
      }

      const result = await options?.onServerRequest?.(message);
      write({
        id: message.id,
        result: result ?? {}
      });
    };

    stdout.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      let message: JsonRpcMessage;
      try {
        message = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        this.logger.warn("codex-app-server", "failed to parse stdout line", {
          line: trimmed
        });
        return;
      }

      if (typeof message.id === "number" && message.method) {
        void handleServerRequest(message).catch((error) => {
          write({
            id: message.id,
            error: {
              message: error instanceof Error ? error.message : String(error)
            }
          });
        });
        return;
      }

      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }

        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(JSON.stringify(message.error)));
          return;
        }

        pending.resolve(message.result ?? {});
        return;
      }

      if (message.method) {
        notifications.push(message);
      }
    });

    stderr.on("line", (line) => {
      this.logger.debug("codex-app-server", "stderr", { line });
    });

    const closeHandler = (code: number | null, signal: NodeJS.Signals | null) => {
      closedError = new Error(
        `app-server process closed${code !== null ? ` with code ${code}` : ""}${
          signal ? ` (signal ${signal})` : ""
        }`
      );

      for (const [id, pending] of this.pending) {
        pending.reject(closedError);
      }
      this.pending.clear();
    };

    child.once("close", closeHandler);
    child.once("error", (error) => {
      closedError = error;
      for (const [id, pending] of this.pending) {
        pending.reject(error);
      }
      this.pending.clear();
    });

    if (options?.signal) {
      const abortHandler = () => child.kill("SIGTERM");
      options.signal.addEventListener("abort", abortHandler, { once: true });
      child.once("close", () => {
        options.signal?.removeEventListener("abort", abortHandler);
      });
    }

    const session = new AppServerSession(
      write,
      () => this.nextId(),
      (id, resolve, reject) => this.pending.set(id, { resolve, reject }),
      notifications,
      () => closedError
    );

    try {
      await session.initialize();
      return await fn(session);
    } finally {
      for (const [id, pending] of this.pending) {
        pending.reject(new Error(`app-server session closed before resolving request ${id}`));
      }
      this.pending.clear();
      child.kill();
    }
  }

  private nextId(): number {
    const id = this.requestId;
    this.requestId += 1;
    return id;
  }
}

function mapInputItems(items: BridgeInputItem[]): Array<Record<string, unknown>> {
  return items.map((item) => {
    if (item.type === "text") {
      return {
        type: "text",
        text: item.text,
        text_elements: []
      };
    }

    if (item.type === "skill") {
      return {
        type: "skill",
        name: item.name,
        path: item.path
      };
    }

    return {
      type: "mention",
      name: item.name,
      path: item.path
    };
  });
}

function buildServerRequestHandler(
  permissions: PermissionContext
): ServerRequestHandler {
  return async (message) => {
    switch (message.method) {
      case "item/commandExecution/requestApproval": {
        const command = (message.params?.command as string | null | undefined) ?? null;
        return {
          decision: decideCommandApproval(permissions, command)
        };
      }
      case "item/fileChange/requestApproval": {
        return {
          decision: decideFileChangeApproval(permissions)
        };
      }
      case "item/permissions/requestApproval": {
        return {
          permissions: {
            fileSystem: [],
            network: []
          },
          scope: "turn"
        };
      }
      case "item/tool/requestUserInput": {
        return {
          answers: {}
        };
      }
      case "mcpServer/elicitation/request": {
        return {
          action: "cancel",
          content: null,
          _meta: null
        };
      }
      default:
        return {};
    }
  };
}

export class CodexAppServerAdapter implements CodexAdapter {
  readonly name = "codex-app-server";
  private readonly client: AppServerClient;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger
  ) {
    this.client = new AppServerClient(config, logger);
  }

  async probe(): Promise<AdapterProbeResult> {
    try {
      const account = await this.rawRequest("account/read", { refreshToken: false });
      const accountValue = account.account as Record<string, unknown> | null | undefined;
      const accountType = accountValue?.type ? String(accountValue.type) : null;

      return {
        name: this.name,
        available: true,
        authenticated: Boolean(accountValue),
        accountType,
        detail: accountType
          ? `app-server initialized with account type ${accountType}`
          : "app-server initialized but no active account was reported",
        raw: account
      };
    } catch (error) {
      return {
        name: this.name,
        available: false,
        authenticated: false,
        accountType: null,
        detail: error instanceof Error ? error.message : "probe failed"
      };
    }
  }

  async rawRequest(
    method: string,
    params: Record<string, unknown>,
    options?: ExecutionOptions
  ): Promise<Record<string, unknown>> {
    return this.client.run(
      async (session) => session.request(method, params),
      {
        signal: options?.signal,
        onServerRequest: async () => ({})
      }
    );
  }

  async *execute(
    task: InternalTask,
    options?: ExecutionOptions
  ): AsyncGenerator<AdapterEvent> {
    const events: AdapterEvent[] = [];

    await this.client.run(
      async (session) => {
        const threadResponse = await session.request("thread/start", {
          cwd: this.config.codex.cwd,
          approvalPolicy: task.permissionContext.appServerApprovalPolicy,
          sandbox: task.permissionContext.sandbox,
          ephemeral: true,
          personality: "pragmatic",
          model: this.config.codex.model,
          developerInstructions: task.systemPrompt || undefined,
          serviceName: "codex-claude-bridge",
          experimentalRawEvents: false,
          persistExtendedHistory: true
        });

        const thread = threadResponse.thread as Record<string, unknown> | undefined;
        const threadId = String(thread?.id ?? "");
        if (!threadId) {
          throw new Error("app-server did not return a thread id");
        }

        const turnResponse = await session.request("turn/start", {
          threadId,
          input: mapInputItems(task.inputItems),
          cwd: this.config.codex.cwd,
          approvalPolicy: task.permissionContext.appServerApprovalPolicy
        });

        const turn = turnResponse.turn as Record<string, unknown> | undefined;
        const turnId = String(turn?.id ?? "");
        if (!turnId) {
          throw new Error("app-server did not return a turn id");
        }

        let finalText = "";
        let usage: TokenUsage | undefined;
        let sawDelta = false;

        while (true) {
          if (options?.signal?.aborted) {
            throw new Error("app-server turn was cancelled");
          }

          let notification: JsonRpcMessage;
          try {
            notification = await session.waitForNotification(
              (message) =>
                Boolean(message.method) &&
                [
                  "item/agentMessage/delta",
                  "item/completed",
                  "turn/completed",
                  "error",
                  "turn/status/changed"
                ].includes(String(message.method))
            );
          } catch (error) {
            const closedCleanly =
              error instanceof Error &&
              /app-server process closed with code 0/.test(error.message);

            if (closedCleanly && finalText) {
              events.push({
                type: "completed",
                finalText,
                usage
              });
              break;
            }

            throw error;
          }

          const method = String(notification.method);
          const params = notification.params ?? {};

          if (method === "item/agentMessage/delta" && params.turnId === turnId) {
            const delta = extractText(params.delta);
            if (delta) {
              finalText += delta;
              sawDelta = true;
              events.push({ type: "text-delta", text: delta });
            }
          } else if (method === "item/completed" && params.turnId === turnId) {
            const item = params.item as Record<string, unknown> | undefined;
            if (item?.type === "agentMessage" && !sawDelta) {
              const itemText = extractText(item);
              if (itemText) {
                finalText = itemText;
                events.push({ type: "text-delta", text: itemText });
              }
            }
          } else if (method === "turn/completed") {
            const completedTurn = params.turn as Record<string, unknown> | undefined;
            const completedTurnId = String(completedTurn?.id ?? "");
            if (completedTurnId !== turnId) {
              continue;
            }

            const rawUsage = completedTurn?.usage as Record<string, unknown> | undefined;
            if (rawUsage) {
              usage = {
                input_tokens: Number(rawUsage.input_tokens ?? 0),
                output_tokens: Number(rawUsage.output_tokens ?? 0)
              };
            }

            if (!finalText) {
              throw new Error("app-server turn completed without agent message text");
            }

            events.push({
              type: "completed",
              finalText,
              usage
            });
            break;
          } else if (method === "error") {
            throw new Error(JSON.stringify(params));
          }
        }
      },
      {
        signal: options?.signal,
        onServerRequest: buildServerRequestHandler(task.permissionContext)
      }
    );

    for (const event of events) {
      yield event;
    }
  }
}

export class AutoCodexAdapter implements CodexAdapter {
  readonly name = "codex-auto";

  constructor(
    private readonly appServerAdapter: CodexAppServerAdapter,
    private readonly execAdapter: CodexAdapter,
    private readonly logger: Logger
  ) {}

  async probe(): Promise<AdapterProbeResult> {
    const appServerProbe = await this.appServerAdapter.probe();
    if (appServerProbe.available && appServerProbe.authenticated) {
      return appServerProbe;
    }

    return this.execAdapter.probe();
  }

  async *execute(
    task: InternalTask,
    options?: ExecutionOptions
  ): AsyncGenerator<AdapterEvent> {
    let yielded = false;
    let timedOut = false;
    const appServerController = new AbortController();
    const timeout = setTimeout(() => {
      timedOut = true;
      appServerController.abort();
    }, 15000);

    if (options?.signal) {
      const forwardAbort = () => appServerController.abort();
      options.signal.addEventListener("abort", forwardAbort, { once: true });
    }

    try {
      for await (const event of this.appServerAdapter.execute(task, {
        signal: appServerController.signal
      })) {
        yielded = true;
        clearTimeout(timeout);
        yield event;
      }
      clearTimeout(timeout);
      return;
    } catch (error) {
      clearTimeout(timeout);
      if (yielded) {
        throw error;
      }

      this.logger.warn("codex-auto", "falling back to codex exec", {
        requestId: task.requestId,
        reason: timedOut
          ? "app-server timed out before yielding output"
          : error instanceof Error
            ? error.message
            : "unknown error"
      });
    }

    for await (const event of this.execAdapter.execute(task, options)) {
      yield event;
    }
  }
}
