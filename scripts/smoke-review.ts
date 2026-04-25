import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collectEvents, createTask } from "./runtime-harness.js";
import type { AdapterEvent } from "../src/types/internal.js";

async function main(): Promise<void> {
  const targetPath = ".tmp/delegation-runtime/review-target.ts";
  const absoluteTarget = path.resolve(process.cwd(), targetPath);
  fs.mkdirSync(path.dirname(absoluteTarget), { recursive: true });
  fs.writeFileSync(
    absoluteTarget,
    [
      "export function isAllowed(user: { isAdmin: boolean } | null): boolean {",
      "  if (user && ((user as { isAdmin: boolean }).isAdmin = true)) {",
      "    return true;",
      "  }",
      "  return false;",
      "}"
    ].join("\n"),
    "utf8"
  );

  const { harness, task } = createTask(
    "smoke-review",
    `Review ${targetPath} for bugs, regressions, and missing tests. Return findings first.`
  );

  const events = await collectEvents(harness.adapter, task);
  const strategy = events.find(
    (event): event is Extract<AdapterEvent, { type: "strategy-selected" }> =>
      event.type === "strategy-selected"
  );
  const packet = events.find(
    (event): event is Extract<AdapterEvent, { type: "packet" }> =>
      event.type === "packet" && event.packetKind === "review"
  );
  const completed = [...events]
    .reverse()
    .find(
      (event): event is Extract<AdapterEvent, { type: "completed" }> => event.type === "completed"
    );

  assert.equal(strategy?.mode, "codex_review");
  assert.ok(packet, "expected review packet");
  assert.ok(completed, "expected completed event");
  assert.ok(Array.isArray((packet.packet as { findings?: unknown[] }).findings));
  assert.match(completed.finalText, /Recommendation:/);

  console.log("REVIEW_MODE_OK");
  console.log(completed.finalText);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
