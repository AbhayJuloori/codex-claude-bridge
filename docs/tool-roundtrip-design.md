# Tool round-trip design

## Purpose

This document describes the first real bridge-native tool round-trip layer in `codex-claude-bridge`.

The goal of this design is not to be a giant generic tool framework. It is to provide the smallest reliable loop that makes the bridge useful for day-to-day coding tasks.

## Supported tools

Current bridge-native tools:

- `bash`
- `read_file`
- `write_file`
- `edit_file`

## Tool call format

Codex must emit a single deterministic fenced block per turn using the info string `bridge-tool`.

### Tool call

```bridge-tool
{"type":"tool_call","id":"call_1","tool":"read_file","args":{"path":"package.json"}}
```

Required fields:

- `type`
- `id`
- `tool`
- `args`

### Final answer

```bridge-tool
{"type":"final","answer":"..."}
```

Required fields:

- `type`
- `answer`

## Tool result format

After the bridge executes a tool, it appends a structured result back into the next turn transcript.

Example:

```bridge-tool-result
{"type":"tool_result","id":"call_1","tool":"read_file","ok":true,"summary":"read /path/to/file","result":{"path":"/path/to/file","content":"..."}} 
```

On error:

```bridge-tool-result
{"type":"tool_result","id":"call_2","tool":"edit_file","ok":false,"summary":"Tool edit_file failed: target text was not found in file","error":{"message":"target text was not found in file"}} 
```

## Execution loop

The bridge executes this loop:

1. Build the tool-loop prompt with:
   - original task context
   - strict protocol rules
   - available bridge-native tool schemas
   - prior tool call/result transcript
2. Run Codex for one turn.
3. Parse the returned `bridge-tool` block.
4. If the result is `final`, stop and return the answer.
5. If the result is `tool_call`, execute the tool locally.
6. Append the structured `tool_result` to the transcript.
7. Repeat until final answer or max-round limit.

## Why the Codex side is read-only during tool-loop turns

`codex exec` is agentic enough to sometimes perform file work directly. That would make it hard to know whether the bridge actually handled a tool round-trip.

So the bridge now forces tool-loop Codex turns into a read-only execution context and explicitly instructs Codex not to use native tools directly.

This keeps local side effects under bridge control.

## Safety model

The bridge-native safety model is intentionally simple:

- per-tool enable/disable settings
- allowed-root path restrictions for file tools
- write/edit gated by edit permission intent
- bash gated by command permission intent
- bash deny-pattern checks for obviously dangerous commands
- bash timeout and cancellation handling

This is a local development safety model. It does not claim full Claude permission parity.

## Tool behavior

### `bash`

- runs in repo root
- captures `stdout`, `stderr`, `exitCode`, and timeout status
- supports cancellation hooks
- rejects obviously dangerous command patterns

### `read_file`

- reads UTF-8 text files
- supports optional inclusive line ranges
- returns clear missing-file errors

### `write_file`

- writes full UTF-8 file contents
- can create parent directories when allowed by config

### `edit_file`

- performs exact-text replacement
- supports single replacement or `replaceAll`
- returns mismatch error if target text is not found

## Current limits

- only bridge-native tools are supported, not full outbound Anthropic `tool_use` parity
- tool activity is logged and persisted, but not yet streamed back to Claude as first-class tool events
- `codex app-server` is not yet the primary tool-loop engine
- the bridge still depends on Codex following the strict fenced protocol

## Why this design is acceptable right now

Because it is:

- deterministic enough to parse
- small enough to maintain
- honest about what it does not yet emulate
- already useful for real coding tasks
