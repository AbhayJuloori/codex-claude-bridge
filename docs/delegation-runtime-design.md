# Delegation runtime design

## Purpose

The delegation runtime is the worker side of the hybrid Claude-Codex orchestration model.

Its job is to:

- classify an implementation-heavy task as delegatable
- compress the request into a clean worker envelope
- let Codex do real work through the bridge-native tool loop
- return a compact implementation packet instead of a full transcript

## Execution modes covered here

- `codex_delegate`
- `codex_then_claude_refine`

## Routing policy

The current router is heuristic and intentionally simple.

It tends to select delegation when the latest user request looks implementation-heavy, for example:

- implement
- scaffold
- refactor
- edit
- write
- create
- add
- test
- fix
- boilerplate
- mechanical

It tends to select refinement after delegation when the request also looks quality-sensitive, for example:

- polish
- refine
- cleanup
- first pass
- then improve

It also routes very large implementation prompts toward refinement because a second pass is more likely to help.

## Writable Codex execution model

Codex is now allowed to perform implementation work, but not by silently mutating the repo through native Codex tools.

Instead:

- the worker gets explicit bridge-native tool definitions
- the Codex-side loop turn remains read-only
- real side effects still go through the bridge-native tools

This preserves execution authority in the bridge while still allowing the worker to request:

- file writes
- file edits
- shell commands

## Delegation envelope

Implementation envelopes are built in `src/delegation/envelopes.ts`.

They include:

- execution mode
- concise task statement
- guessed file scope
- compact acceptance criteria
- explicit requirement to return a compressed packet only

They intentionally avoid forwarding the full raw conversation when a smaller task statement is enough.

## Implementation packet format

The worker must return a single fenced `bridge-packet` JSON block:

```json
{
  "type": "implementation_result",
  "mode": "implement",
  "task": "Implement feature X",
  "status": "completed",
  "filesChanged": ["src/example.ts"],
  "summary": ["Added the helper and wired the import."],
  "commandsRun": ["npm test -- example"],
  "keyDecisions": ["Kept the API synchronous."],
  "warnings": [],
  "suggestedNextStep": "Add more coverage for edge cases.",
  "diffSummary": ["Created helper", "Updated caller"],
  "confidence": 0.87
}
```

This packet is intentionally much smaller than a full worker transcript.

## Delegation loop

The worker loop is:

1. Build the implementation envelope.
2. Run Codex through the bridge-native tool loop.
3. Execute any requested bridge-native tools.
4. Continue until Codex emits a final `bridge-packet`.
5. Parse the implementation packet.
6. Emit the packet into session events.
7. Render a compact user-facing summary.

## Refinement workflow

`codex_then_claude_refine` adds a second stage after the implementation packet is captured.

Current refinement policy checks:

- `status === failed`
- `status === partial`
- warnings present
- confidence below threshold

If refinement is needed:

1. The bridge builds a refinement envelope.
2. The follow-up stage receives only:
   - the original request
   - the compressed implementation packet
3. The follow-up stage may inspect selected files read-only if needed.
4. It returns a concise final answer rather than a new implementation packet.

Important honesty note:

- this is not a real Anthropic Claude refinement stage
- it is a bridge-managed refinement approximation over a compressed worker artifact

## Safety model

Delegation relies on the existing bridge-native tool policy:

- per-tool enable/disable
- path restrictions
- permission-derived edit/command gating
- deny-pattern checks for bash
- timeout and cancellation support

This is a local development safety model, not a formal security boundary.

## Current strengths

- real write-enabled delegation exists
- implementation work can be compressed into a small packet
- the bridge does not need to replay the full worker transcript for follow-up

## Current limits

- file-scope guessing is heuristic
- refinement still depends on prompt discipline
- no true Anthropic Claude refinement stage exists
- no diff-native refinement policy yet
