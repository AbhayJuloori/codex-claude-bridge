# Review runtime design

## Purpose

The review runtime is the reviewer side of the hybrid Claude-Codex orchestration model.

Its job is to:

- classify review-oriented tasks separately from implementation work
- run a dedicated reviewer or adversarial reviewer through the bridge-native tool loop
- produce a compact review packet
- optionally produce a final prioritized judgment without replaying the full review transcript

## Execution modes covered here

- `codex_review`
- `codex_adversarial_review`
- `codex_review_then_claude_judgment`

## Routing policy

The current router uses heuristic triggers from the latest user request.

It tends to select:

- `codex_review` for phrases like `review`, `findings`, `regression`, `code review`
- `codex_adversarial_review` for phrases like `adversarial`, `try to break`, `failure mode`, `security`
- `codex_review_then_claude_judgment` when a review request also asks for:
  - merge/no-merge
  - judgment
  - prioritized findings
  - ship/no-ship style decision

## Review envelopes

Review envelopes are built in `src/delegation/envelopes.ts`.

They include:

- execution mode
- concise review target
- guessed file scope
- explicit instruction to stay read-only unless asked otherwise
- strict requirement to return a compressed review packet only

Adversarial review envelopes add a stronger skeptical stance:

- challenge assumptions
- look for hidden failure modes
- surface security and reliability concerns

## Review packet format

The reviewer must return a single fenced `bridge-packet` JSON block:

```json
{
  "type": "review_result",
  "mode": "review",
  "task": "Review src/server.ts",
  "findings": [
    {
      "severity": "high",
      "title": "Bug title",
      "file": "src/server.ts",
      "line": 42,
      "summary": "What goes wrong and why it matters.",
      "suggestedFix": "How to address it."
    }
  ],
  "bugRisks": ["Concrete bug risk."],
  "regressionRisks": ["Concrete regression risk."],
  "securityConcerns": ["Concrete security concern."],
  "missingTests": ["Coverage gap."],
  "openQuestions": ["Clarifying uncertainty."],
  "recommendation": "Do not merge yet.",
  "confidence": 0.9
}
```

The final rendered review is findings-first.

## Adversarial review behavior

`codex_adversarial_review` uses the same packet format as normal review, but the reviewer is pushed toward:

- exploit-style thinking
- edge-case failure analysis
- hidden reliability issues
- security-sensitive defaults
- brittle assumptions

This is intentionally more skeptical than standard review mode.

## Judgment workflow

`codex_review_then_claude_judgment` adds a second stage:

1. Run normal review and capture a compressed review packet.
2. Build a smaller judgment packet from the review packet.
3. Optionally run a constrained judge pass over that packet.
4. Return a concise merge/no-merge style answer.

The judgment packet currently includes:

- top findings
- dropped finding titles
- recommendation
- merge verdict
- final summary

## Judgment policy

The current judgment policy is implemented in `src/review/judgment-policy.ts`.

Today it is explicitly heuristic:

- there is no Anthropic Claude runtime available to interpret the review packet directly
- the bridge derives a prioritized judgment packet first
- a constrained follow-up pass may then render a cleaner final judgment

Important honesty note:

- this is a useful review-interpretation layer
- it is not a literal Claude editorial judgment stage

## Why review modes stay read-only

Review flows override the worker permission context to:

- `canEdit: false`
- `canRunCommands: false`
- `sandbox: "read-only"`

That keeps review behavior non-mutating unless the runtime is explicitly extended to support fix-suggestion or patch-generation variants later.

## Current strengths

- real review and adversarial review modes exist
- findings are returned in a compact, structured packet
- judgment can prioritize findings without replaying the full transcript

## Current limits

- no true Claude judgment stage exists
- review inputs are currently prompt/file oriented, not fully diff-native
- weak findings can still slip into the packet and need better filtering over time
- confidence scoring is backend-authored and not independently calibrated
