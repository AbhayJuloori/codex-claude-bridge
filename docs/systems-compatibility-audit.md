# Systems compatibility audit

Date: April 5, 2026  
Project: `codex-claude-bridge`

## Summary

This audit classifies each major Claude Code system according to how realistically it can be preserved through a local proxy backed by ChatGPT-authenticated Codex.

| System | Classification | Runtime status |
| --- | --- | --- |
| Configuration | `proxy-preservable` | `supported` |
| Permissions | `bridge-emulatable` | `partial` |
| Hooks | `bridge-emulatable` | `experimental` |
| MCP | `proxy-preservable` | `partial` |
| Agents & subagents | `bridge-emulatable` | `experimental` |
| Skills | `proxy-preservable` | `partial` |
| Multi-turn session continuity | `bridge-emulatable` | `partial` |
| Background / long-running tasks | `bridge-emulatable` | `experimental` |

## Configuration

Classification: `proxy-preservable`  
Status: `supported`

What Claude owns:

- native config precedence at startup
- settings-based runtime behavior inside Claude itself
- plugin enablement and client-owned behavior

What the bridge can own:

- loading scoped Claude config artifacts from disk
- reporting merged config and precedence
- projecting visible config into prompt and runtime policy

What the current prototype preserves:

- managed, user, project, and local Claude settings file loading
- `CLAUDE.md` and `CLAUDE.local.md` loading
- Claude plugin inventory
- Codex config loading
- diagnostics endpoint for compatibility context

What must be added for stronger parity:

- richer source-by-source precedence diffs
- more one-to-one mapping of Claude config keys to bridge behavior
- more exact handling of project-local Claude plugin/config artifacts

Remaining risks:

- Claude command-line flags are not visible after ingress
- some Claude settings have no Codex equivalent
- plugin behavior may depend on client-side features the bridge cannot own

How success should be tested:

- create project `.claude` files and confirm diagnostics reflect the right precedence
- compare bridge-loaded config with Claude debug traces for the same workspace

## Permissions

Classification: `bridge-emulatable`  
Status: `partial`

What Claude owns:

- native permission prompts and UI
- exact allow/deny enforcement inside Claude runtime
- agent and subagent restriction semantics

What the bridge can own:

- deriving permission intent from visible Claude settings
- mapping that intent to Codex sandbox and approval policy
- logging parity gaps and enforcement limits

What the current prototype preserves:

- Claude permission mode detection
- allow/ask/deny rule ingestion
- internal approval policy abstraction
- mapping into `read-only`, `workspace-write`, and `danger-full-access`

What must be added for stronger parity:

- better rule matching and denial behavior
- interactive approval endpoints or bridge-controlled prompts
- stronger policy handling for app-server approval callbacks

Remaining risks:

- `codex exec` fallback cannot fully mirror Claude’s approval model
- bridge enforcement is semantic approximation, not native Claude parity

How success should be tested:

- run the same task under `plan`, `default`, `acceptEdits`, and bypass-style modes
- verify deny rules prevent equivalent bridge actions where possible

## Hooks

Classification: `bridge-emulatable`  
Status: `experimental`

What Claude owns:

- native hook lifecycle timing
- hook payload shape for client-owned events
- plugin-driven hook invocation inside Claude

What the bridge can own:

- synthetic lifecycle events at bridge boundaries
- command/webhook dispatch based on bridge config
- observability for request and background execution

What the current prototype preserves:

- discovery of hook sources from settings and plugins
- synthetic events for inbound request, dispatch, stream delta, completion, failure, cancellation, and background jobs
- configurable command and HTTP hook targets

What must be added for stronger parity:

- closer mapping to Claude hook event names and payloads
- replayable per-session hook traces
- more complete bridge payload schemas

Remaining risks:

- bridge hooks are not identical to native Claude hooks
- client-side hook execution can happen outside bridge visibility

How success should be tested:

- trigger each synthetic hook event and validate payloads
- compare outputs against Claude hook examples from official docs and local debug traces

## MCP

Classification: `proxy-preservable`  
Status: `partial`

What Claude owns:

- client-side MCP server startup
- client-side tool invocation
- Claude-specific auth and tool presentation

What the bridge can own:

- inventorying Claude and Codex MCP definitions
- comparing shared vs mismatched server sets
- querying official Codex MCP status surfaces

What the current prototype preserves:

- Claude MCP definition discovery
- Codex MCP definition discovery
- capability map and migration suggestions
- app-server MCP reload/status integration

What must be added for stronger parity:

- deeper bridge-managed MCP mediation
- dynamic tool refresh beyond diagnostics
- clearer shared-tool execution strategy

Remaining risks:

- Claude-side MCP use may stay invisible if fully client-owned
- identical server names do not imply identical capability or auth state

How success should be tested:

- verify `.mcp.json` discovery
- confirm Codex MCP reload/status via diagnostics
- validate shared-tool scenarios when the same server is configured on both sides

## Agents & subagents

Classification: `bridge-emulatable`  
Status: `experimental`

What Claude owns:

- native subagent lifecycle
- native backgrounding and concurrency UX
- exact context isolation and synthesis behavior

What the bridge can own:

- agent discovery from Claude and plugin roots
- planner/worker decomposition
- task graph tracking and result synthesis

What the current prototype preserves:

- Claude-side agent discovery
- selected-agent propagation into mapped tasks
- planner/worker orchestration for bridge-managed jobs
- task graph persistence for background runs

What must be added for stronger parity:

- more faithful agent invocation detection
- configurable delegation policies
- deeper nested-orchestration handling

Remaining risks:

- this is useful operational equivalence, not internal Claude parity
- AskUserQuestion and complex interactive workflows remain limited

How success should be tested:

- run planner-worker background jobs and inspect task graphs
- reference an agent explicitly and verify bridge selection

## Skills

Classification: `proxy-preservable`  
Status: `partial`

What Claude owns:

- native skill discovery and invocation semantics
- plugin-defined skill integration with other Claude features

What the bridge can own:

- discovering skill files
- preserving skill intent into prompts or Codex-native input items
- reporting which skills were loaded

What the current prototype preserves:

- Claude and Codex skill discovery
- explicit skill reference detection
- selected skill injection into mapped task context
- diagnostics-friendly visibility into loaded skills

What must be added for stronger parity:

- tighter invocation matching
- better frontmatter interpretation
- more consistent use of Codex-native skill input items

Remaining risks:

- instruction preservation is not the same as native skill mechanics
- plugin skills may depend on Claude-native hooks, permissions, or agents

How success should be tested:

- reference a known skill and inspect selected skills in diagnostics
- verify the mapped prompt reflects the intended skill instructions

## Multi-turn session continuity

Classification: `bridge-emulatable`  
Status: `partial`

What Claude owns:

- native session memory and conversation state management
- native client presentation of history and context compaction

What the bridge can own:

- persistent session ids
- message/event logs
- bridge-managed request correlation

What the current prototype preserves:

- session ids via Claude header when present
- persisted message logs
- persisted request event logs
- diagnostics endpoints for session inspection

What must be added for stronger parity:

- better resume semantics
- stronger history compaction and replay rules
- tighter mapping between Claude session boundaries and bridge sessions

Remaining risks:

- the bridge only sees what Claude sends
- native Claude context compaction behavior is not reproduced

How success should be tested:

- run multi-turn prompts through the same session id
- inspect persisted session history and verify continuity

## Background / long-running tasks

Classification: `bridge-emulatable`  
Status: `experimental`

What Claude owns:

- native background task UX
- native subagent result surfacing
- client-owned cancellation and status presentation

What the bridge can own:

- queued jobs
- persisted state
- polling and event replay
- bridge-managed cancellation

What the current prototype preserves:

- `POST /v1/messages/background`
- persisted jobs under `.state/jobs`
- replayable event logs
- cancellation endpoint
- planner-worker orchestration for long-running tasks

What must be added for stronger parity:

- better streaming replay
- richer cancellation semantics
- tighter connection between foreground Claude flows and background bridge jobs

Remaining risks:

- Claude itself does not automatically know about bridge job endpoints
- bridge background UX is useful, but not native Claude UX

How success should be tested:

- submit a background job
- poll status until completion
- replay event logs
- cancel an active job and verify terminal state

## Overall judgment

The bridge now preserves or emulates a meaningful portion of Claude Code’s operating environment. The strongest preserved systems are configuration, skill/config ingestion, session persistence, and runtime diagnostics. The weakest systems remain tool semantics, exact permission parity, and native subagent equivalence.

The honest headline is:

> This project can approximate a surprising amount of Claude Code’s workflow model around a Codex backend, but it still cannot become a true engine-equivalent Claude replacement with current official surfaces.
