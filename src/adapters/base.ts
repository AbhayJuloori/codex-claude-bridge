import type {
  InternalTask,
  AdapterEvent,
  AdapterProbeResult,
  ExecutionOptions
} from "../types/internal.js";

export interface CodexAdapter {
  readonly name: string;
  probe(): Promise<AdapterProbeResult>;
  execute(task: InternalTask, options?: ExecutionOptions): AsyncGenerator<AdapterEvent>;
}
