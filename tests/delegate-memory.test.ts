import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "@jest/globals";

import { DelegateMemory } from "../src/session/delegate-memory.js";

describe("DelegateMemory", () => {
  let workingDir = "";

  beforeEach(() => {
    if (workingDir) {
      fs.rmSync(workingDir, { recursive: true, force: true });
    }

    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-memory-test-"));
  });

  afterAll(() => {
    if (workingDir) {
      fs.rmSync(workingDir, { recursive: true, force: true });
    }
  });

  test("init creates the memory file with the expected content", () => {
    const memory = new DelegateMemory(workingDir);

    memory.init(
      "Proxy Layer",
      {
        runtime: "Node.js 20",
        language: "TypeScript"
      },
      ["Keep file I/O local", "Use tmp directories in tests"]
    );

    const memoryFile = path.join(workingDir, ".delegate/context.md");

    expect(fs.existsSync(memoryFile)).toBe(true);
    expect(fs.readFileSync(memoryFile, "utf8")).toBe(
      [
        "# Project Context",
        "",
        "**Project:** Proxy Layer",
        "",
        "## Tech Stack",
        "- runtime: Node.js 20",
        "- language: TypeScript",
        "",
        "## Constraints",
        "- Keep file I/O local",
        "- Use tmp directories in tests",
        "",
        "## Completed Phases",
        "(none yet)",
        "",
        "## File Map",
        "(populated as phases complete)"
      ].join("\n")
    );
  });

  test("appendPhase adds a phase entry to an existing memory file", () => {
    const memory = new DelegateMemory(workingDir);

    memory.init("Proxy Layer", { runtime: "Node.js 20" }, ["Ship tests"]);
    memory.appendPhase(
      "phase-1",
      "Scaffold tests",
      ["Created Jest coverage for DelegateMemory", "Validated temp file workflow"],
      {
        "tests/delegate-memory.test.ts": "Adds unit coverage"
      }
    );

    const content = memory.read();

    expect(content).toContain("# Project Context");
    expect(content).toContain("### Scaffold tests (phase-1)");
    expect(content).toContain("- Created Jest coverage for DelegateMemory");
    expect(content).toContain("- Validated temp file workflow");
    expect(content).toContain("- tests/delegate-memory.test.ts: Adds unit coverage");
    expect(content).not.toContain("(none yet)");
  });

  test("read returns an empty string when the memory file is missing", () => {
    const memory = new DelegateMemory(workingDir);

    expect(memory.read()).toBe("");
  });

  test("exists returns whether the memory file is present", () => {
    const memory = new DelegateMemory(workingDir);

    expect(memory.exists()).toBe(false);

    memory.init("Proxy Layer", {}, []);

    expect(memory.exists()).toBe(true);
  });
});
