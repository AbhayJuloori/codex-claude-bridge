import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collectEvents, createTask } from "./runtime-harness.js";
import type { AdapterEvent } from "../src/types/internal.js";

async function main(): Promise<void> {
  const targetPath = ".tmp/delegation-runtime/judgment-target.ts";
  const absoluteTarget = path.resolve(process.cwd(), targetPath);
  fs.mkdirSync(path.dirname(absoluteTarget), { recursive: true });
  fs.writeFileSync(
    absoluteTarget,
    [
      "export function authorize(role: string, requested: string): boolean {",
      "  return role === requested || role === 'admin';",
      "}",
      "",
      "export function divide(a: number, b: number): number {",
      "  return a / b;",
      "}"
    ].join("\n"),
    "utf8"
  );

  const { harness, task } = createTask(
    "smoke-review-judgment",
    `Review ${targetPath} and give a merge or no-merge judgment after prioritizing the findings.`
  );

  const events = await collectEvents(harness.adapter, task);
  const strategy = events.find(
    (event): event is Extract<AdapterEvent, { type: "strategy-selected" }> =>
      event.type === "strategy-selected"
  );
  const reviewPacket = events.find(
    (event): event is Extract<AdapterEvent, { type: "packet" }> =>
      event.type === "packet" && event.packetKind === "review"
  );
  const judgmentPacket = events.find(
    (event): event is Extract<AdapterEvent, { type: "packet" }> =>
      event.type === "packet" && event.packetKind === "judgment"
  );
  const completed = [...events]
    .reverse()
    .find(
      (event): event is Extract<AdapterEvent, { type: "completed" }> => event.type === "completed"
    );

  assert.equal(strategy?.mode, "codex_review_then_claude_judgment");
  assert.ok(reviewPacket, "expected review packet");
  assert.ok(judgmentPacket, "expected judgment packet");
  assert.ok(completed, "expected completed event");
  assert.match(completed.finalText.toLowerCase(), /merge|judgment|recommendation|needs changes/);

  console.log("REVIEW_JUDGMENT_MODE_OK");
  console.log(completed.finalText);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
