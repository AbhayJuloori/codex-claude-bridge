# Risks and limitations

## Bottom line

This project now has:

- a real bridge-native tool loop
- routing between direct, delegation, review, and judgment flows
- compressed result packets for implementation and review work

That makes it substantially more useful than the old text-only proxy, but it is still an experimental compatibility runtime rather than a supported production Claude replacement.

## `claude_direct` is not a literal Claude runtime

The mode name is intentionally product-facing: it means the bridge keeps the request on its direct path instead of sending it through the worker/reviewer orchestration flow.

What it does not mean:

- no Anthropic Claude model is running inside this bridge
- no real Claude-native planning/refinement stage is available locally under current constraints

Status: `fundamental limitation`

## Refinement and judgment are approximations

`codex_then_claude_refine` and `codex_review_then_claude_judgment` are real multi-stage workflows, but the manager-side stage is currently implemented as:

- bridge policy over a compressed packet
- optional constrained Codex follow-up over that packet

Why:

- there is no local Anthropic Claude runtime available to consume the packet directly
- the project cannot use paid Anthropic APIs under the stated constraints

Status: `intentional approximation`

## Tool semantics are real, but not full Claude parity

The bridge truly executes tools locally. That is a major step forward.

But the bridge still does not provide:

- full outbound Anthropic `tool_use` parity
- first-class Anthropic tool-event streaming
- exact Claude-native stop reasons and tool lifecycle semantics

Status: `partial`

## The bridge-native protocol is intentionally custom

Tool calls and compressed packets use strict bridge-owned fenced JSON protocols rather than native Claude tool-call structures.

Why this is acceptable:

- deterministic parsing
- reliable repeated turns
- small enough to maintain
- easy to persist and replay

Why it is still a limit:

- this is compatibility, not exact protocol equivalence

Status: `intentional limitation`

## Codex side still is not a raw model API

Even with routing and tool loops in place, the backend is still ChatGPT-authenticated Codex exposed through local agent/task surfaces.

That means:

- the bridge still has to steer Codex through custom envelopes and loop control
- true transparent engine replacement is still blocked
- output quality and protocol discipline depend on prompt shaping more than on a formal model API contract

Status: `fundamental blocker`

## Native Codex autonomy can interfere if not constrained

`codex exec` can sometimes perform work directly. That is why the bridge forces tool-loop turns into a read-only Codex execution context and tells Codex not to use native tools directly.

This helps, but the residual risk remains:

- the bridge depends on Codex following the bridge protocol faithfully
- a future Codex behavior change could reduce loop determinism

Status: `managed but not eliminated`

## Delegation packets can hide context

Compressed packets are a feature, but they are also a tradeoff.

Risks:

- the manager stage may miss nuance that was present in the full worker transcript
- aggressive compression can hide weak signals or secondary review findings
- file-scope guessing in envelopes is heuristic, not authoritative

Mitigation:

- the runtime can still run a constrained second pass
- packets are persisted in session events
- refinement/judgment stages can inspect selected files when needed

Status: `managed tradeoff`

## Review judgment can over- or under-filter findings

The judgment layer prioritizes review results, but it currently uses bridge heuristics plus an optional constrained Codex pass.

Risks:

- a medium-severity issue might be over-weighted or under-weighted
- noisy or under-supported findings may slip through
- no true Claude-level final editorial judgment exists in-process today

Status: `partial`

## Bash safety is intentionally simple

Current bash protections:

- per-tool enable/disable
- permission-derived command gating
- deny-pattern checks
- timeout support
- cancellation hooks

Current gaps:

- deny-pattern safety is heuristic, not formal sandboxing
- output can still be large or surprising
- it is suitable for local development, not high-assurance execution

Status: `partial`

## File tool limits

Current file tool protections:

- allowed-root enforcement
- write/edit restricted by edit capability
- exact-text edit mismatch errors

Current gaps:

- UTF-8 text only
- no patch hunks or semantic merge support
- no binary-safe write/edit path

Status: `partial`

## Permissions parity remains incomplete

The bridge maps Claude permission intent into a local policy model, but it still cannot claim Claude-native approval parity.

Current gaps:

- no full Claude approval UX
- no exact permission prompt replication
- delegated write-enabled work is still mediated by bridge-native policy, not Claude-native policy

Status: `partial`

## Hooks remain bridge-native

Hook support is useful, but still synthetic.

Current gaps:

- bridge hook timing is not the same as Claude hook timing
- route selection and packet events are observable by the bridge, but client-side Claude hooks remain owned by Claude

Status: `experimental`

## MCP remains only partially bridged

The runtime can inventory and compare Claude-side and Codex-side MCP state, but it does not yet unify tool execution through MCP in the same way the bridge-native tools are unified.

Status: `partial`

## App-server remains experimental

`codex app-server` still matters, but direct turn execution remains unstable in this repo.

Practical result:

- use `codex exec` for the current delegation/review runtime
- treat app-server as useful for probing and future host integration, not as the primary execution engine yet

Status: `experimental`

## Anthropic-facing response polish still lags

Today the final answer is clean, but route selection, packets, and tool activity are mostly visible through:

- bridge logs
- session events
- diagnostics

Not yet through:

- first-class Anthropic-style route/tool packet streaming

Status: `partial`

## Recommendation

Treat this repo as a serious local compatibility workbench that now supports a real manager/worker/reviewer flow, but not as a drop-in or fully equivalent Claude backend replacement.
