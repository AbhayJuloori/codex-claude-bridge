# Build log

## 2026-04-05

### Research pass and first working bridge

- Confirmed `codex` and `claude` are available locally.
- Verified official Claude gatewaying and official Codex local surfaces.
- Confirmed ChatGPT-backed Codex auth is active on this machine.
- Built the first local Anthropic-style proxy with `exec`, `app-server`, and `auto` adapter modes.

### First verified prototype behavior

- `npm run build` passed.
- `npm run probe:app-server` reported a ChatGPT `plus` account.
- `npm run smoke:exec` returned `EXEC_BRIDGE_OK`.
- `npm run smoke:proxy` returned `PROXY_BRIDGE_OK`.
- `npm run smoke:claude` returned `CLAUDE_PROXY_BRIDGE_OK`.

## 2026-04-05 later pass: compatibility-runtime upgrade

### Research and audit expansion

- Reviewed official Claude Code docs for settings, permissions, hooks, MCP, and sub-agents.
- Reviewed official OpenAI Codex docs for app-server, MCP, subagents, and skills.
- Inspected local Claude and Codex runtime state including settings, plugins, skills, agents, and MCP config.

### Runtime hardening

- Added compatibility loading under `src/config/`.
- Added permission semantics under `src/permissions/`.
- Added synthetic hook dispatch under `src/hooks/`.
- Added MCP capability diagnostics under `src/mcp/`.
- Added planner/worker orchestration under `src/agents/`.
- Added background jobs and persisted event logs under `src/background/`.
- Added persistent sessions and richer diagnostics endpoints.

### Bugs fixed in that pass

- Fixed premature request cancellation on normal HTTP requests.
- Fixed a child-process close race that could leave background jobs hanging.
- Added app-server stall fallback behavior in `auto` mode.

### Verified behavior after hardening

- `npm run smoke:proxy` passed again.
- `npm run smoke:background` completed with persisted task graph and replayable event logs.
- `npm run smoke:claude` still returned `CLAUDE_PROXY_BRIDGE_OK`.
- `npm run diagnostics:compat` produced the compatibility report.

## 2026-04-05 later pass: first real tool round-trips

### Goal

- Replace the old "tools as prompt text only" behavior with a real bridge-native tool execution loop.

### Implementation

- Added a strict bridge-native tool protocol in `src/tools/protocol.ts`.
- Added local tool executors in `src/tools/executor.ts`.
- Added repeated tool-loop orchestration in `src/tools/loop.ts`.
- Wrapped the active runtime adapter so bridge tool loops run through the normal proxy path.
- Added session events for real `request.tool_call` and `request.tool_result` records.
- Added tool config and safety controls in `src/config.ts`.
- Added protocol helpers and tool-loop-aware docs.

### Supported bridge-native tools

- `bash`
- `read_file`
- `write_file`
- `edit_file`

### Important design choice

- Tool-loop Codex turns now run in a read-only execution context and explicitly instruct Codex not to use native tools directly.
- This was necessary because `codex exec` is agentic enough to sometimes perform work itself, which would blur whether the bridge handled a real round-trip.

### Smoke coverage added

- `npm run smoke:tools`
- `npm run smoke:claude-tools`

### Verified tool-loop behavior

- Direct smoke executed real bridge-native `read_file`, `bash`, `write_file`, and `edit_file` calls in one task.
- Claude CLI through the proxy triggered at least one recorded bridge-native tool call.
- Simple non-tool proxy flow still returned `PROXY_BRIDGE_OK`.

### Current honest status

- The bridge now has a real local tool round-trip layer and is materially more useful for coding tasks.
- Anthropic-facing tool semantics are still approximate.
- `codex exec` is now the preferred adapter for tool-loop reliability.
- `codex app-server` remains experimental for direct execution.

## 2026-04-05 current pass: hybrid manager-worker-reviewer runtime

### Goal

- Evolve the bridge from a plain backend swap attempt into a local "Claude manager + Codex worker/reviewer" runtime.

### Implementation

- Added heuristic strategy routing in `src/router/strategy-router.ts`.
- Added delegation and review envelope builders in `src/delegation/envelopes.ts`.
- Added compressed packet types and parsers in `src/orchestrator/types.ts` and `src/orchestrator/packets.ts`.
- Added the hybrid orchestration runtime in `src/orchestrator/hybrid-runtime.ts`.
- Added refinement policy in `src/refinement/policy.ts`.
- Added review judgment policy in `src/review/judgment-policy.ts`.
- Updated the active adapter factory so the runtime now composes:
  - a direct path over the base adapter
  - a worker/reviewer path over the bridge-native tool loop
- Added session-visible `strategy-selected` and `packet` events.

### Execution modes added

- `claude_direct`
- `codex_delegate`
- `codex_then_claude_refine`
- `codex_review`
- `codex_adversarial_review`
- `codex_review_then_claude_judgment`

### Packet compression added

- Implementation packets now capture:
  - task attempted
  - status
  - files changed
  - summary
  - commands run
  - key decisions
  - warnings
  - suggested next step
  - diff summary
  - confidence
- Review packets now capture:
  - mode
  - ordered findings
  - bug risks
  - regression risks
  - security concerns
  - missing tests
  - open questions
  - recommendation
  - confidence

### Honest behavioral caveat

- The refinement and judgment stages are real runtime stages, but they are not backed by Anthropic Claude inside this repo.
- Today they are implemented as bridge policy plus optional constrained Codex follow-up over compressed packets.

### Smoke coverage added

- `npm run smoke:router`
- `npm run smoke:delegate`
- `npm run smoke:refine`
- `npm run smoke:review`
- `npm run smoke:adversarial-review`
- `npm run smoke:review-judgment`

### Verified behavior

- Router classification matched all six intended modes.
- Delegate mode performed real file mutation through bridge-native tool calls and returned a compressed implementation packet.
- Refine mode produced a compact implementation outcome instead of replaying the full transcript.
- Review mode returned findings-first review output.
- Adversarial review mode surfaced stronger failure-mode and security-style concerns.
- Review-then-judgment mode produced a cleaner final merge/no-merge style answer than the raw review packet alone.

### Current honest status

- The bridge now better matches a local manager/worker/reviewer runtime than a raw backend swap.
- The worker and reviewer behaviors are real.
- The "Claude" stages are still approximations because no Anthropic runtime is available under the current constraints.
