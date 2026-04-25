import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collectEvents, createTask } from "./runtime-harness.js";
import type { AdapterEvent } from "../src/types/internal.js";

async function main(): Promise<void> {
  const targetPath = ".tmp/delegation-runtime/refine.ts";
  const { harness, task } = createTask(
    "smoke-refine",
    [
      `Implement a small TypeScript utility in ${targetPath} that exports a function named sum(a: number, b: number).`,
      "This is a first pass, then refine and polish the result for readability.",
      "Use the bridge-native tools and return a concise final answer."
    ].join(" ")
  );

  const events = await collectEvents(harness.adapter, task);
  const strategy = events.find(
    (event): event is Extract<AdapterEvent, { type: "strategy-selected" }> =>
      event.type === "strategy-selected"
  );
  const packet = events.find(
    (event): event is Extract<AdapterEvent, { type: "packet" }> =>
      event.type === "packet" && event.packetKind === "implementation"
  );
  const completed = [...events]
    .reverse()
    .find(
      (event): event is Extract<AdapterEvent, { type: "completed" }> => event.type === "completed"
    );

  assert.equal(strategy?.mode, "codex_then_claude_refine");
  assert.ok(packet, "expected implementation packet");
  assert.ok(completed, "expected completed event");

  const absoluteTarget = path.join(harness.config.codex.cwd, targetPath);
  const content = fs.readFileSync(absoluteTarget, "utf8");
  assert.match(content, /export function sum/);
  assert.doesNotMatch(completed.finalText, /```bridge-packet/);

  console.log("REFINE_MODE_OK");
  console.log(completed.finalText);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
