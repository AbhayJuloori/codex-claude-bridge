import type { CompatibilityContext } from "../config/types.js";
import type { SandboxMode } from "../types/internal.js";

export type ClaudePermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";

export interface PermissionRule {
  action: "allow" | "ask" | "deny";
  tool: string;
  pattern: string | null;
}

export interface PermissionContext {
  mode: ClaudePermissionMode;
  rules: PermissionRule[];
  canEdit: boolean;
  canRunCommands: boolean;
  sandbox: SandboxMode;
  appServerApprovalPolicy: "never" | "on-request";
  parityNotes: string[];
}

function parseRule(action: PermissionRule["action"], rawRule: string): PermissionRule {
  const match = rawRule.match(/^([^(]+?)(?:\((.*)\))?$/);

  return {
    action,
    tool: match?.[1]?.trim() ?? rawRule,
    pattern: match?.[2]?.trim() ?? null
  };
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesRule(rule: PermissionRule, tool: string, value: string | null): boolean {
  if (rule.tool.toLowerCase() !== tool.toLowerCase()) {
    return false;
  }

  if (!rule.pattern) {
    return true;
  }

  if (!value) {
    return false;
  }

  return wildcardToRegExp(rule.pattern).test(value);
}

export function derivePermissionContext(context: CompatibilityContext): PermissionContext {
  const permissions =
    (context.claude.mergedSettings.permissions as Record<string, unknown> | undefined) ?? {};
  const mode = (permissions.defaultMode as ClaudePermissionMode | undefined) ?? "default";
  const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
  const ask = Array.isArray(permissions.ask) ? permissions.ask : [];
  const deny = Array.isArray(permissions.deny) ? permissions.deny : [];
  const rules = [
    ...allow.filter((item): item is string => typeof item === "string").map((item) => parseRule("allow", item)),
    ...ask.filter((item): item is string => typeof item === "string").map((item) => parseRule("ask", item)),
    ...deny.filter((item): item is string => typeof item === "string").map((item) => parseRule("deny", item))
  ];

  const parityNotes: string[] = [];
  let canEdit = true;
  let canRunCommands = true;
  let sandbox: SandboxMode = "workspace-write";
  let appServerApprovalPolicy: "never" | "on-request" = "on-request";

  if (mode === "plan") {
    canEdit = false;
    canRunCommands = false;
    sandbox = "read-only";
    parityNotes.push("Plan mode is approximated as read-only, no-edit, no-command execution.");
  } else if (mode === "acceptEdits") {
    canEdit = true;
    canRunCommands = true;
    sandbox = "workspace-write";
    appServerApprovalPolicy = "on-request";
  } else if (mode === "bypassPermissions" || mode === "dontAsk") {
    canEdit = true;
    canRunCommands = true;
    sandbox = "danger-full-access";
    appServerApprovalPolicy = "never";
    parityNotes.push("Bypass-like modes are mapped to no-approval Codex execution only on trusted local environments.");
  } else if (mode === "auto") {
    canEdit = true;
    canRunCommands = true;
    sandbox = "workspace-write";
    appServerApprovalPolicy = "on-request";
    parityNotes.push("Claude auto mode classifier is approximated, not replicated.");
  }

  return {
    mode,
    rules,
    canEdit,
    canRunCommands,
    sandbox,
    appServerApprovalPolicy,
    parityNotes
  };
}

export function decideCommandApproval(
  permissions: PermissionContext,
  command: string | null
): "accept" | "acceptForSession" | "decline" {
  if (!permissions.canRunCommands) {
    return "decline";
  }

  if (!command) {
    return permissions.appServerApprovalPolicy === "never" ? "accept" : "accept";
  }

  const denyRule = permissions.rules.find((rule) => rule.action === "deny" && matchesRule(rule, "Bash", command));
  if (denyRule) {
    return "decline";
  }

  const allowRule = permissions.rules.find((rule) => rule.action === "allow" && matchesRule(rule, "Bash", command));
  if (allowRule) {
    return permissions.mode === "bypassPermissions" || permissions.mode === "dontAsk"
      ? "acceptForSession"
      : "accept";
  }

  if (permissions.appServerApprovalPolicy === "never") {
    return "accept";
  }

  return permissions.mode === "acceptEdits" ? "accept" : "decline";
}

export function decideFileChangeApproval(
  permissions: PermissionContext
): "accept" | "acceptForSession" | "decline" {
  if (!permissions.canEdit) {
    return "decline";
  }

  if (permissions.mode === "bypassPermissions" || permissions.mode === "dontAsk") {
    return "acceptForSession";
  }

  if (permissions.mode === "acceptEdits") {
    return "accept";
  }

  return permissions.appServerApprovalPolicy === "never" ? "accept" : "decline";
}
