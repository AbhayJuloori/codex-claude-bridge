import type { ExecutionPlan } from "./types.js";

const UI_HINTS = ["browser-use", "build-web-apps"] as const;
const GITHUB_HINT = "github" as const;
const COMPUTER_HINT = "computer-use" as const;

export function getPluginHints(
  plan: ExecutionPlan,
  taskText: string
): string[] {
  const hints = new Set<string>();

  // Mode-based defaults
  if (plan.mode === "ui_build" || plan.mode === "ui_refine") {
    UI_HINTS.forEach((h) => hints.add(h));
  }

  // Task text signals
  const lower = taskText.toLowerCase();
  if (/\bgithub\b/.test(lower)) {
    hints.add(GITHUB_HINT);
  }

  if (
    (plan.mode === "debug" || /\bui\b|\bfront.?end\b|\bbrowser\b/.test(lower)) &&
    (/\bui\b|\bfront.?end\b|\bbrowser\b|\bbutton\b|\bcomponent\b|\bpage\b/.test(lower))
  ) {
    hints.add(COMPUTER_HINT);
    hints.add("browser-use");
  }

  // Merge caller-supplied hints (plan.plugins_hint may already have hints from dispatcher)
  for (const h of plan.plugins_hint) {
    hints.add(h);
  }

  // review and architecture modes: no plugins (read-only analysis)
  if (plan.mode === "review" || plan.mode === "architecture") {
    return [];
  }

  return Array.from(hints);
}
