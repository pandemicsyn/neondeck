# Slice 3.1 operator flow: progress review before repair

Status: published as draft PRs [#403](https://github.com/pandemicsyn/neondeck/pull/403)
and [#404](https://github.com/pandemicsyn/neondeck/pull/404) in stack #405;
**not merged**. Source and pre-publication documentation static reviews and the
manager post-publication architecture review are clean. The reviewed fixture relocation is complete. CI is complete: all nine checks pass on each PR, #403 at `5cbc5882` and
#404 at `9a6023fe`. These results apply to those revisions; linked PRs show current status. Merge has not been authorized. Use the [handoff](SLICE_3_1_HANDOFF.md) for verification and review
status. Real model/Codex/GitHub acceptance is **NOT RUN**; model judgment quality
remains unevaluated in the [acceptance ledger](SLICE_3_1_ACCEPTANCE.md).

## Where progress review runs

After candidate checks or independent review find a scoped repair, Neon assesses
the proposed next approach before starting a fresh Codex repair. Actionable
GitHub PR feedback enters the same checkpoint. A candidate that passes its checks
and review continues through existing publication gates; progress review adds no
separate all-green certification. The configured independent reviewer model is
reused for this new read-only role.

The assessment compares the released brief, current and prior candidate diffs,
actual check/review/feedback reports, prior repair instructions and remaining
budget. Evidence is tied to its original revision. Missing or omitted evidence
is visible and cannot support permission to continue. Model judgment can be
wrong; it does not replace checks, human acceptance, or deterministic limits.

## Read the recommendation

In the delivery workbench, **Repair progress review** shows the assessed repair
ordinal, candidate, state and rationale. Expand its retained history to inspect
what the model saw. Previous assessments remain historical and cannot authorize
another candidate.

- **Continue:** Neon can start the assessed scoped repair under its existing
  grant and remaining allowance.
- **Change approach:** Neon gives revised instructions to the same next fresh
  coding attempt. This consumes the ordinary repair allowance.
- **Escalate to human planning:** Neon pauses repair and retains the rationale
  and evidence for an explicit human decision.
- Pending or uncertain assessment: no new repair is authorized. An uncertain
  result retains its original reservation until the recorded work is reconciled.

## Human decisions and recovery

**Discuss progress evidence with Neon** prepares evidence for the task's existing
planning conversation. Inspect it, add your question or decision, then send an
explicit message. Opening the conversation does not send a model turn or approve
execution. Discuss the cause, adjust the brief when necessary, or revoke work.

Discussion cannot replenish the grant. Revised scope follows the existing exact
brief release and candidate consent path. There is no same-grant budget extension
or automatic extra planning/judging round.

Each prospective repair gets at most one assessment, up to two per grant. An
assessment has at most three minutes or the smaller remaining allowance. Known
execution counts toward the existing three-hour cumulative ceiling; unknown usage
keeps its reservation. Duplicate events, changed feedback and restarts do not
refresh these limits or admit a replacement judge.

Use the existing reconciliation control to observe retained receipts, and
revocation to fence further work. The progress reviewer acts between attempts;
existing coding cancellation and execution deadlines handle a running Codex
process. Neither revocation nor an assessment undoes an already completed push.

After an uncertain assessment raises a human intervention, later recovery can
settle known usage without automatically resuming repair. The visible human pause
remains. A recorded on-time result recovered after a restart without such an
intervention can be used; recovery never starts another model window.

Real model quality and live Codex/GitHub behavior remain separate acceptance
work. Local fake-provider tests and synthetic screenshots do not establish them.
