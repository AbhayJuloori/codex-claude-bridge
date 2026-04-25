# Compatibility test matrix

Date: April 5, 2026  
Project: `codex-claude-bridge`

## Legend

- `pass`: works well enough today for the tested bridge scope
- `partial`: works, but with important behavioral gaps
- `fail`: not working or not honestly claimable today

## Matrix

| Category | Expected Claude behavior | Current bridge behavior | Status | Next remediation |
| --- | --- | --- | --- | --- |
| Simple prompts | Claude sends a prompt and receives an assistant reply | Verified through direct HTTP bridge and real Claude CLI | `pass` | Keep regression smokes on ingress and simple replies |
| Multi-turn chat | Claude preserves turn continuity and responds with prior context in mind | Bridge persists session logs and flattens visible transcript into the next task | `partial` | Improve session replay and compaction |
| Strategy routing | System chooses a sensible execution mode for the task | Heuristic router selects among direct, delegate, refine, review, adversarial review, and review-plus-judgment modes | `pass` | Add richer ambiguity handling and optional learned/prompt router later |
| `claude_direct` mode | Judgment-heavy work stays on the manager path | Bridge skips worker/reviewer delegation, but this is not a literal Anthropic Claude stage | `partial` | Rename or refine semantics if a true Claude runtime ever becomes available |
| `codex_delegate` mode | Worker handles mechanical implementation work with real tools | Verified delegated writes through bridge-native tools plus compressed implementation packet output | `pass` | Improve scope inference and command/file summarization |
| `codex_then_claude_refine` mode | Worker does a first pass and manager refines cheaply | Real first-pass delegation exists and refinement policy can trigger a second constrained pass, but the manager stage is an approximation | `partial` | Improve selective file inspection and refinement-specific heuristics |
| `codex_review` mode | Reviewer returns findings-first code review output | Verified findings-first review output with ordered severity and line references when available | `pass` | Improve diff-aware review inputs and richer test-gap detection |
| `codex_adversarial_review` mode | Reviewer aggressively challenges assumptions and failure modes | Verified stronger hidden-risk, security-style, and failure-mode findings | `pass` | Add more adversarial fixtures and confidence calibration |
| `codex_review_then_claude_judgment` mode | Reviewer finds issues and manager produces final merge judgment | Real two-stage review plus judgment flow exists, but the judgment stage is heuristic + optional constrained Codex pass | `partial` | Improve noise filtering and merge recommendation policy |
| Tool round-trips | Agent can request a tool, receive a result, continue, and finalize | Bridge-native loop supports real repeated calls for `bash`, `read_file`, `write_file`, and `edit_file` | `pass` | Expand tool coverage and Anthropic-facing tool-event fidelity |
| Bash tool | Run shell commands and receive stdout/stderr/exit code | Verified directly through bridge-native tool executor and loop | `pass` | Improve danger-pattern coverage and output truncation policy |
| Read file tool | Read local files safely | Verified for existing file and missing-file error | `pass` | Add binary-file refusal and richer range handling if needed |
| Write file tool | Create and overwrite text files | Verified directly and inside a real loop | `pass` | Add optional diff previews for future UX |
| Edit file tool | Perform precise text replacement with mismatch reporting | Verified directly and inside a real loop | `pass` | Add more patch-style operations later if needed |
| Compressed implementation packets | Worker result is cheaper to consume than the raw transcript | Verified compact packet shape with files changed, summary, warnings, and next step | `pass` | Add byte-size assertions and optional diff summaries in more smokes |
| Compressed review packets | Review result is cheaper to consume than the raw transcript | Verified compact packet shape with findings, risks, missing tests, and recommendation | `pass` | Add more fixture diversity and packet-size regression checks |
| Long outputs | Claude streams long responses progressively | Anthropic-style SSE envelope is preserved, but tool events and packet events are not yet streamed as first-class Anthropic events | `partial` | Tighten protocol fixtures and consider staged route/tool-status streaming |
| Markdown / JSON outputs | Claude follows formatting instructions accurately | Works for straightforward tasks, but still depends on backend behavior | `partial` | Add more structured-output regression prompts |
| Permissions-sensitive tasks | Claude respects permission mode and approval policy | Bridge maps permission intent into a local policy model, but does not match Claude-native approval UX | `partial` | Add stronger interactive approval semantics |
| Hooks-aware flows | Claude runs native hooks at documented lifecycle points | Bridge emits synthetic lifecycle events and records strategy, packet, tool-call, and tool-result boundaries | `partial` | Align more closely with Claude payloads and timing |
| MCP-connected flows | Claude can use configured MCP servers and their tools | Bridge inventories Claude/Codex MCP state, but does not provide full shared tool parity | `partial` | Explore deeper MCP mediation |
| Skill-aware prompts | Claude discovers and applies relevant skills | Bridge discovers and injects selected skills into execution context | `partial` | Improve skill invocation detection and Codex-native attachment |
| Agent/subagent delegation | Claude can delegate and synthesize results | Bridge now has explicit manager/worker/reviewer routing, but nested subagent parity is still limited | `partial` | Improve explicit task graphing and nested delegation policies |
| Background execution | Claude can run longer work without blocking the main thread | Bridge provides queued jobs, polling, replay logs, and cancellation endpoints | `partial` | Tie background flows more tightly to foreground orchestration UX |
| Failure modes | Claude returns usable errors for backend/runtime issues | Bridge returns Anthropic-style errors and structured tool failures | `partial` | Add richer packet and adapter failure fixtures |
| Cancellation | Claude can interrupt active work | Request aborts and background cancellations exist, but parity is incomplete | `partial` | Improve end-to-end interruption semantics |
| Concurrency | Claude can juggle multiple active tasks/subagents | Bridge can handle multiple requests/jobs, but orchestration concurrency is not yet deeply stress-tested | `partial` | Add concurrency stress runs |

## Concrete tests run during this pass

| Test | What it covered | Result |
| --- | --- | --- |
| `npm run build` | compile integrity after routing/orchestration changes | `pass` |
| `npm run smoke:router` | route classification across all six execution modes | `pass` |
| `npm run smoke:delegate` | delegated implementation, bridge-native write, compressed implementation packet | `pass` |
| `npm run smoke:refine` | delegated first pass plus refinement workflow | `pass` |
| `npm run smoke:review` | findings-first review packet and rendered review output | `pass` |
| `npm run smoke:adversarial-review` | stronger adversarial review packet and output | `pass` |
| `npm run smoke:review-judgment` | review packet plus final judgment output | `pass` |
| `npm run smoke:tools` | direct executor tests plus repeated bridge-native tool loop | `pass` |
| `npm run smoke:proxy` | Anthropic ingress -> bridge -> Codex -> Anthropic response | `pass` |
| `npm run smoke:claude-tools` | real Claude CLI through the proxy with at least one recorded bridge tool call | `pass` |

## Mode-specific smoke details

`npm run smoke:router` verifies:

- obvious direct/judgment-heavy request -> `claude_direct`
- obvious mechanical implementation request -> `codex_delegate`
- obvious first-pass-then-polish request -> `codex_then_claude_refine`
- obvious code review request -> `codex_review`
- obvious adversarial review request -> `codex_adversarial_review`
- obvious merge/no-merge review request -> `codex_review_then_claude_judgment`

`npm run smoke:delegate` verifies:

- router selection of `codex_delegate`
- real `write_file` execution through bridge-native tools
- compressed implementation result with changed file list

`npm run smoke:refine` verifies:

- router selection of `codex_then_claude_refine`
- real implementation step
- refinement-stage final answer without replaying the full worker transcript

`npm run smoke:review` verifies:

- router selection of `codex_review`
- read-only review inspection
- findings-first final answer shape

`npm run smoke:adversarial-review` verifies:

- router selection of `codex_adversarial_review`
- stronger failure-mode and security-minded findings

`npm run smoke:review-judgment` verifies:

- router selection of `codex_review_then_claude_judgment`
- persisted review packet
- persisted judgment packet
- concise final merge/no-merge style answer

## Highest-priority next remediation

1. Make refinement and judgment less heuristic by improving selective file inspection over compressed packets.
2. Improve Anthropic-facing streaming and event polish for route, tool, and packet activity.
3. Expand review inputs to support diff-scoped review more directly.
4. Strengthen permission and approval fidelity around delegated write-enabled work.
