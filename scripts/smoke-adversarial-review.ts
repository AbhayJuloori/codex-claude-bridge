import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collectEvents, createTask } from "./runtime-harness.js";
import type { AdapterEvent } from "../src/types/internal.js";

async function main(): Promise<void> {
  const targetPath = ".tmp/delegation-runtime/adversarial-target.ts";
  const absoluteTarget = path.resolve(process.cwd(), targetPath);
  fs.mkdirSync(path.dirname(absoluteTarget), { recursive: true });
  fs.writeFileSync(
    absoluteTarget,
    [
      "export function transfer(balance: number, amount: number): number {",
      "  if (amount < 0) {",
      "    return balance + Math.abs(amount);",
      "  }",
      "  return balance - amount;",
      "}",
      "",
      "export function parseFlag(value?: string): boolean {",
      "  return value !== \"false\";",
      "}"
    ].join("\n"),
    "utf8"
  );

  const { harness, task } = createTask(
    "smoke-adversarial-review",
    `Do an adversarial review of ${targetPath}. Try to break assumptions, find hidden failure modes, and call out security or reliability issues.`
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

  assert.equal(strategy?.mode, "codex_adversarial_review");
  assert.ok(packet, "expected adversarial review packet");
  assert.ok(completed, "expected completed event");
  assert.match(completed.finalText.toLowerCase(), /recommendation|finding|risk/);

  console.log("ADVERSARIAL_REVIEW_MODE_OK");
  console.log(completed.finalText);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
