---
name: delegate
description: Plan a project with Claude and delegate execution to Codex via Proxy-Layer. Trigger with /delegate or [DELEGATE] prefix.
triggers:
  - /delegate
  - "[DELEGATE]"
---

# /delegate — Claude Plans, Codex Builds

Use this skill when you want to build a project with maximum quality and minimum Claude token spend.
Claude does the thinking. Codex does the building. Claude enforces quality.

## When this skill applies
- User types `/delegate <project description>`
- User's message starts with `[DELEGATE]`
- User asks to "build", "create", or "scaffold" a non-trivial project

## Prerequisites

Before starting, verify Proxy-Layer is running:
```bash
curl -s http://localhost:8787/health
```
If not running: `cd ~/Proxy-Layer && npm run dev`

## What you do

### Step 1: Extract project intent
Parse the user's request. Identify:
- What are they building?
- What tech stack (make sensible defaults if not specified)?
- Any constraints mentioned?

Ask at most **1 clarifying question** if genuinely ambiguous. Otherwise proceed with defaults.

### Step 2: Generate Plan Manifest

Decompose into 2–4 phases. Each phase: 2–5 tasks. Tag each task's `domain` field carefully:

**Domain rules:**
- `["ui"]` or `["frontend", "ui"]` — Claude ALWAYS rewrites these to production quality
- `["architecture"]` — handle directly in Claude, skip Codex
- `["test"]` — always include a test task in the final phase
- `["backend"]`, `["ml"]`, `["data"]` — Codex primary builder, Claude reviews

**Skills to assign per task:**
- backend: `["code-quality", "project-structure"]`
- ml/data: `["ml-patterns", "code-quality", "testing"]`
- test: `["testing", "code-quality"]`
- ui/frontend: `["ui-baseline"]` (Claude rewrites anyway)

Generate the manifest JSON. Example structure:

```json
{
  "project": "My Project",
  "tech_stack": { "backend": "FastAPI", "frontend": "React" },
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
          "prompt": "Detailed specific instructions for Codex...",
          "domain": ["backend"],
          "acceptance": ["tests pass", "typed", "no TODOs"],
          "skills": ["code-quality", "project-structure"]
        }
      ]
    }
  ],
  "domain_flags": ["backend", "frontend", "ui"],
  "memory_path": ".delegate/context.md"
}
```

**Prompt quality rules:**
- Each task prompt must be specific and self-contained (Codex has no prior context)
- Include exact file paths, function signatures, endpoint specs
- State the tech stack explicitly in each prompt
- Include concrete acceptance criteria (not vague like "works correctly")

### Step 3: POST manifest to Proxy-Layer

```bash
curl -s -X POST http://localhost:8787/delegate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer codex-bridge-local" \
  --no-buffer \
  -d '<MANIFEST_JSON_HERE>'
```

Parse and display SSE events as they stream:
- `phase-start` → "▶ Phase `<name>` starting (`<N>` tasks)"
- `task-complete` → "✓ Task `<id>`: `<status>`" or "🔁 `<id>`: rewritten by Claude" if claudeRewritten
- `gate-verdict` → "✅ Gate: `<verdict>` — `<summary>`"
- `delegate-complete` → "🏁 Done — `<N>` tasks, `<M>` Claude rewrites"

### Step 4: Final Claude quality pass

After receiving the result:
1. Read `.delegate/context.md` to understand what was built
2. If `domain_flags` includes `ui` or `frontend`: invoke `frontend-design` skill on the UI output
3. Present to user:
   - What was built (brief file map)
   - How to run it (exact commands)
   - Any warnings from escalated gates
   - Suggested next steps

## Token budget
- Planning + manifest: ~2–4k Claude tokens
- Quality gates: ~500–1k per phase
- UI rewrites: ~2–5k (only for ui/frontend tasks)
- Final review: ~1–2k
- **All implementation**: Codex CLI — bulk of work, no Claude API cost
