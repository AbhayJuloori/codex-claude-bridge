# Delegate Workflow Design
**Date:** 2026-04-10
**Status:** Approved
**Goal:** Claude plans + judges, Codex executes — high quality output, minimal Claude tokens

---

## Problem

Using Claude for everything is token-expensive and slow. But delegating everything to Codex produces low-quality output in certain domains (UI, architecture). The goal is a workflow that:
- Uses Claude's intelligence upfront (planning) and at the end (quality enforcement)
- Uses Codex CLI (no API — GPT Plus only) for the bulk of execution
- Produces GitHub-quality output across all domains

---

## Trigger Mechanism

Two equivalent entry points:

1. **Claude Code skill**: `/delegate <prompt>` — skill available in Claude Code session
2. **Prompt prefix**: `[DELEGATE] <prompt>` — detected anywhere, including non-skill contexts

Both funnel into the same pipeline.

---

## Architecture

```
User: /delegate "build ML portfolio project"
         │
         ▼
┌─────────────────────────────┐
│  Claude Code: /delegate     │
│  skill                      │
│  1. Brainstorm intent       │
│  2. Domain-tag tasks        │
│  3. Generate Plan Manifest  │
│  4. POST /delegate          │
└────────────┬────────────────┘
             │ Plan Manifest (JSON)
             ▼
┌─────────────────────────────────────────────┐
│  Proxy-Layer: DelegationOrchestrator        │
│                                             │
│  For each phase:                            │
│    ├─ Build rich Codex prompt per task      │
│    │   (skills + context + acceptance)      │
│    ├─ Fan out parallel Codex workers        │
│    │   (codex exec subprocess — CLI only)   │
│    ├─ Collect compressed packets            │
│    ├─ Claude quality gate:                  │
│    │   • [ui] tag → REROUTE to Claude       │
│    │   • others → Claude review/patch       │
│    └─ Write phase result to .delegate/      │
│       context.md (local memory)             │
└────────────┬────────────────────────────────┘
             │ Final compressed result packet
             ▼
┌─────────────────────────────┐
│  Back in /delegate skill    │
│  Claude final pass:         │
│  - Domain skills applied    │
│    (frontend-design for UI) │
│  - Present to user          │
└─────────────────────────────┘
```

---

## Plan Manifest

Claude generates this before handing off to Proxy-Layer:

```json
{
  "project": "ML portfolio",
  "tech_stack": {},
  "constraints": [],
  "phases": [
    {
      "id": "phase-1-scaffold",
      "name": "Scaffold",
      "parallel": true,
      "claude_gate": true,
      "tasks": [
        {
          "id": "t1",
          "prompt": "Create FastAPI project structure with ...",
          "domain": ["backend"],
          "acceptance": ["pytest passes", "typed", "no TODOs"],
          "skills": ["code-quality", "project-structure"]
        }
      ]
    }
  ],
  "domain_flags": ["ui", "ml", "backend"],
  "memory_path": ".delegate/context.md"
}
```

---

## Codex Prompt Engineering

Each task sent to Codex is wrapped in a rich envelope by Proxy-Layer:

```
SYSTEM:
You are a precise implementation engine. Follow skills and acceptance criteria exactly.

[Injected: relevant SKILL.md content]
[Injected: .delegate/context.md — project memory from prior phases]

TASK:
<specific scoped prompt from manifest>

ACCEPTANCE CRITERIA:
<list from manifest>
- All tests must pass
- No placeholder code

OUTPUT: Compressed implementation packet with file diffs and test results.
```

Skills are injected based on `task.skills[]` field — Codex sees exactly what it needs, nothing more.

---

## Domain-Aware Quality Gate

| Domain tag | Codex role | Claude role |
|---|---|---|
| `[backend]` `[ml]` `[test]` `[data]` | Primary builder | Reviews packet → accept / patch |
| `[ui]` `[frontend]` | Builds baseline skeleton | **Always rewrites** via frontend-design skill |
| `[architecture]` `[design]` | Skipped | Claude handles directly |

Claude never rubber-stamps UI output. It always rewrites to Claude-quality.

---

## Codex Skills (SKILL.md files)

Stored in `Proxy-Layer/skills/`:

| Skill | Purpose |
|---|---|
| `testing` | Write tests first, pytest/jest patterns, coverage requirements |
| `code-quality` | Type hints, no magic numbers, clear naming, error handling |
| `project-structure` | File organization conventions per tech stack |
| `ui-baseline` | Functional but minimal UI skeleton (Claude will enhance) |
| `ml-patterns` | Model training patterns, reproducibility, logging |

---

## Local Project Memory (`.delegate/context.md`)

Written after each phase, read by Codex at task start:

```markdown
# Project Context
Tech stack: FastAPI, React, scikit-learn
Completed phases: scaffold, data-pipeline
Key decisions: SQLite for dev, postgres for prod
File map: src/api/, src/models/, frontend/src/
Open constraints: deployment target TBD
```

This prevents Codex from making contradictory decisions across phases.

---

## New Proxy-Layer Components

| Component | Location | Purpose |
|---|---|---|
| `DelegationOrchestrator` | `src/delegation/orchestrator.ts` | Manages phase loop, gates, memory |
| `CodexPromptBuilder` | `src/delegation/prompt-builder.ts` | Builds rich task envelopes |
| `SkillRegistry` | `src/skills/registry.ts` | Loads + indexes SKILL.md files |
| `DelegateMemory` | `src/session/delegate-memory.ts` | Reads/writes .delegate/context.md |
| `/delegate` endpoint | `src/server.ts` | Accepts manifest, returns SSE stream |

Existing `ClaudeSubprocessManager` handles all quality gates (already built in Phase 1).

---

## `/delegate` Claude Code Skill

Stored in Proxy-Layer's exported skills directory, installed to `~/.claude/plugins/`:

**Trigger phrases:** `/delegate`, `[DELEGATE]`

**Steps:**
1. Parse prompt → extract project description
2. Run brainstorm (intent, domain tags, tech stack)
3. Generate Plan Manifest JSON
4. POST to `http://localhost:8787/delegate`
5. Stream phase progress to user
6. Receive final packet
7. Run domain skills on flagged outputs (UI → frontend-design)
8. Present final result

---

## Token Budget (estimated)

| Stage | Model | Token spend |
|---|---|---|
| Planning + manifest | Claude | ~2-4k |
| Quality gates (per phase) | Claude subprocess | ~500-1k each |
| UI rewrite (if present) | Claude | ~2-5k |
| Final review | Claude | ~1-2k |
| **All execution tasks** | **Codex CLI** | **bulk of work** |

Claude: ~5-15k tokens per project. Codex: does the heavy lifting.

---

## Success Criteria

- `/delegate "build X"` produces a runnable, tested project
- UI output is Claude-quality (via rewrite gate)
- Codex execution is guided by skills (no wild decisions)
- Local memory prevents cross-phase contradictions
- Zero Codex API calls — CLI only via subprocess
- Showcaseable on GitHub as a novel Claude+Codex orchestration pattern
