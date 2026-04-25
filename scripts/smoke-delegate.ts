import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collectEvents, createTask } from "./runtime-harness.js";
import type { AdapterEvent } from "../src/types/internal.js";

async function main(): Promise<void> {
  const targetPath = ".tmp/delegation-runtime/delegate.txt";
  const { harness, task } = createTask(
    "smoke-delegate",
    [
      `Create or overwrite ${targetPath} with the exact text DELEGATED_WRITE.`,
      "Use the available bridge-native tools.",
      "Return a compact result."
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

  assert.equal(strategy?.mode, "codex_delegate");
  assert.ok(packet, "expected implementation packet");
  assert.ok(completed, "expected completed event");

  const absoluteTarget = path.join(harness.config.codex.cwd, targetPath);
  assert.equal(fs.readFileSync(absoluteTarget, "utf8"), "DELEGATED_WRITE");

  console.log("DELEGATE_MODE_OK");
  console.log(completed.finalText);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
