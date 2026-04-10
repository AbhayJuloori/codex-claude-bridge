import { z } from "zod";

export const domainTagSchema = z.enum([
  "backend",
  "frontend",
  "ui",
  "ml",
  "data",
  "test",
  "infrastructure",
  "architecture"
]);

export type DomainTag = z.infer<typeof domainTagSchema>;

export const delegateTaskSchema = z.object({
  id: z.string(),
  prompt: z.string().min(10),
  domain: z.array(domainTagSchema),
  acceptance: z.array(z.string()),
  skills: z.array(z.string()).default([])
});

export type DelegateTask = z.infer<typeof delegateTaskSchema>;

export const delegatePhaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  parallel: z.boolean().default(true),
  claude_gate: z.boolean().default(true),
  tasks: z.array(delegateTaskSchema).min(1)
});

export type DelegatePhase = z.infer<typeof delegatePhaseSchema>;

export const delegateManifestSchema = z.object({
  project: z.string(),
  tech_stack: z.record(z.string()).default({}),
  constraints: z.array(z.string()).default([]),
  phases: z.array(delegatePhaseSchema).min(1),
  domain_flags: z.array(domainTagSchema),
  memory_path: z.string().default(".delegate/context.md")
});

export type DelegateManifest = z.infer<typeof delegateManifestSchema>;

export interface TaskResult {
  taskId: string;
  domain: DomainTag[];
  status: "completed" | "partial" | "failed" | "rewritten";
  output: string;
  claudeRewritten: boolean;
}

export interface PhaseResult {
  phaseId: string;
  phaseName: string;
  tasks: TaskResult[];
  gateVerdict: "accepted" | "patched" | "escalated";
  summary: string;
}

export interface DelegateResult {
  project: string;
  phases: PhaseResult[];
  finalOutput: string;
  totalTasks: number;
  claudeRewriteCount: number;
}
