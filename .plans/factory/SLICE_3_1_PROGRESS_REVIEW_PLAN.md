# Slice 3.1 — Progress supervision

Status: implementation in progress, September 6, 2026. The operator authorized
implementation after Slice 3 merged in PRs #397–#401 through `a897aa06`.
Prioritize before Slice 4's OpenCode adapter. Existing Slice 3 live acceptance
remains pending; local verification of this follow-up is a separate record.
See the [implementation handoff](SLICE_3_1_HANDOFF.md) and
[acceptance ledger](SLICE_3_1_ACCEPTANCE.md).

## Outcome

Detect unproductive or suspicious repair cycles before spending another coding
attempt. Slice 3 bounds retries and reviews each candidate independently; it does
not systematically judge progress across the repair history.

Add a read-only progress judge through the existing Flue runtime. Keep the
deterministic coordinator, candidate reviewer and Codex harness. The judge cannot
edit code, execute commands, publish, merge, extend budgets or grant authority.

## Assessment and decisions

Before admitting an otherwise authorized repair, assemble a bounded, versioned
history packet: released brief and acceptance criteria, current/prior candidate
identities and diffs, previous repair instructions, check outcomes, reviewer
findings, normalized feedback and remaining budget. Bind observations to their
actual revisions; mark omitted/missing evidence. Treat source and feedback as
untrusted input.

Use deterministic fingerprints for repeated failures and unchanged candidates.
Ask the model to assess unsuccessful repeated approaches, patches undoing earlier
work, test weakening, scope drift and lack of demonstrated progress. Recognize
legitimate partial progress even when a check still fails. Model assessment is
fallible; hard limits remain authoritative.

Persist a typed decision with evidence references and a concise rationale:

- **Continue:** the proposed repair is in scope with a credible next step.
- **Change approach:** revise instructions for the same next repair, within the
  released scope and ordinary repair allowance. Do not automatically launch
  another planning/judging cycle.
- **Escalate:** pause repair and show the evidence in the existing human planning
  conversation. Invalid, missing or inconclusive evidence cannot authorize repair.

The initial assessment judges the proposed approach without inventing a prior
history; subsequent assessments compare actual prior work.

## Limits and recovery

- Preserve the two-repair and three-hour cumulative ceilings. Judge time counts
  toward the same budget. Exhausted authority stops admission before a model call.
- Proposed default: one judge invocation per prospective repair ordinal, at most
  two per grant, each with a three-minute deadline or the smaller remaining
  allowance. Snapshot these limits in the admission contract. No recursive judges,
  voting rounds or automatic judge retry loop.
- Persist admission, input digest, original deadline, budget reservation and
  submission/result identity. Duplicate events and restarts reuse recorded state;
  reconcile unknown model admission without launching a replacement.
- Shared Valibot contracts validate inputs/results. A verdict binds its exact
  grant, candidate, repair ordinal and evidence packet. Changed evidence or
  authority invalidates permission without resetting the judge allowance.
- No verdict bypasses required checks, candidate review, writer ownership, release
  authority or publication guards.

## Human touchpoint

Show the assessed cycle, history/evidence, rationale and proposed next approach in
the delivery workbench. Escalation prepares context for the existing planning
conversation and requires an explicit human message/decision. Chat cannot refill
budgets. Revised scope follows exact brief release and candidate consent;
revocation remains available throughout.

## Acceptance and implementation handoff

Cover repeated identical failure, oscillating patches, weakened tests with green
checks, scope drift, productive partial progress and an initial repair without
history. Test duplicate feedback, stale verdicts, malformed/missing evidence,
timeout, restart during admission, unknown usage, exhaustion and human escalation.
Prove that judging cannot create unbounded model calls or coding attempts and
alternate approaches still consume the same repair allowance.

Reuse mockdex and synthetic model results for deterministic controller tests;
record actual model evaluation separately. Include screenshots for new operator
states. Delegate implementation, require independent clean static reviews before
PR creation, and retain manager plan/architecture review. Plan the implementation
stack around contracts/admission, assessment integration and human evidence
surfaces. Do not build another coding agent or workflow engine.
