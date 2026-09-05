# Slice 1 — Manager and implementer handoff

Status: documentation root PR #382 is open at `9aba1ae2` against `main`.
Intake PR #383 is open at `0c39917930b42aeacc3cbad71031d5552a29ccee` against
`agent/software-factory-plan`. Planning PR #384 is open at
`3210fbb00eddb54e2873b1e44bfea9eea012b9d5` against `agent/factory-s1-01-intake`.
Human shaping PR #385 is open at `8809958947531e3c7fa727accae4aab3f3073f57`
against `agent/factory-s1-02-planning`, manager-accepted with all six GitHub checks
passing. All four PRs remain unmerged and undeployed. Increment 4 is an uncommitted
implementation candidate; final verification and dedicated review remain pending.

Read the [slice contract](SLICE_1_IMPLEMENTATION_PLAN.md) before starting.
The coordinating assistant acts as **dev manager and reviewer**. Implementation
is handed to separate coding subagents. Dedicated independent subagents perform
static reviews before the manager's final review. No PR, including a draft or
documentation root PR, may be created until its dedicated reviews return no
findings and the manager accepts implementation and product-plan adherence.

## Ownership

| Role             | Responsibility                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human            | Product direction, scope changes that affect the agreed outcome, GitHub/VM access and deployment consent; merge authorization                                                 |
| Manager/reviewer | Maintain the dependency stack and contracts, prepare bounded assignments, inspect changes independently, prioritize findings, check acceptance evidence, and report readiness |
| Implementer      | Own one assigned branch/worktree, read local code and skills, implement the full PR contract, run checks, fix findings, and produce a concrete handoff                        |

Dedicated static reviewers are separate from implementers. Start implementers at
low reasoning and reviewers at medium; raise effort for demonstrated difficulty.
Use two independent review assignments per increment: correctness/security and
architecture/product-contract adherence. The manager remains the final reviewer.

Default to one active implementation PR at a time. The next branch starts from
the manager-accepted parent commit, even if the parent PR is not merged yet.
Parallel investigation is fine; avoid concurrent writers on the same checkout,
migration lineage or shared API contracts. Use isolated git worktrees for separate
implementation tasks. Do not use this planning thread's checkout as a shared editor.

The manager should send actionable review findings back to the implementer rather
than becoming the primary author of the feature. Routine implementation decisions
within the contract do not need another human approval. Escalate actual product
tradeoffs with a concrete proposed change and consequence, while continuing work
that does not depend on the answer.

## Starting sequence

1. Read `AGENTS.md`, `.plans/ROADMAP.md`, `.plans/DEVIATIONS.md`, this directory and
   the overall proposal. Resolve the remote default branch and current plan branch
   again; names in this document are a starting point, not proof of current state.
2. Inspect working trees, pending changes, hooks and dependency availability. Never
   overwrite unrelated user work. Ensure `core.hooksPath` uses `.githooks` and that
   `gitleaks` is installed; fix missing setup rather than bypassing the scanner.
3. Keep a documentation root branch if the plan has not landed. The prepared planning
   branch is `agent/software-factory-plan`; it contains the overall proposal commit
   `403a70dc`. Include the slice documents in that root before branching implementation.
4. Create the first isolated implementation worktree from the agreed root commit.
   Assign only PR 1 using the template below. Record its real branch/base/SHA.
5. On implementation handoff, freeze the review snapshot and send it to dedicated
   static reviewers. Return findings to the implementer and repeat review until
   every assigned reviewer explicitly reports no findings on the final candidate.
   Then perform the manager's final implementation/product review. Only after both
   gates pass may the manager create the PR and accept the parent for the next
   increment. This applies to the documentation root too. Do not merge until the
   user has authorized merging.

## Stack topology and maintenance

If planning is still unmerged, use this dependency chain. If it has already landed,
PR 1 bases directly on the current default branch instead.

```text
main
  └─ agent/software-factory-plan          documentation root
      └─ agent/factory-s1-01-intake
          └─ agent/factory-s1-02-planning
              └─ agent/factory-s1-03-shaping
                  └─ agent/factory-s1-04-github-ingress
                      └─ agent/factory-s1-05-github-status
```

Each GitHub PR targets its immediate parent branch, so its Files changed view
contains only that increment. Its description lists parent PR, next dependent PR
when known, slice contract, before/after behavior, acceptance evidence, and any
remaining deployment check. The final PR is not a substitute for reviewing earlier
increments. Review both the parent-relative diff and the accumulated integration
behavior at the top of the stack.

Record the parent tip used by each child. If a parent changes after review, rebase
its child and propagate through descendants in order. Re-review changed behavior
and rerun affected checks; don't repeatedly run unrelated checks on unchanged trees.

Land bottom-up only. After a parent lands, inspect the actual merge strategy before
retargeting its child. A squash/rebase merge can change ancestry: replay only the
child's unique commits onto the new base, using the recorded old parent tip as the
boundary. Do not blindly replay all unmerged ancestor commits onto `main`. Verify
the diff and ancestry before pushing. Use `--force-with-lease` only when necessary
on owned stack branches after checking the expected remote tip; never force the
default branch or overwrite another author's changes.

Changing a PR base can invalidate review context; inspect the resulting commit and
file lists and renew affected review, as described by
[GitHub's base-change documentation](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/changing-the-base-branch-of-a-pull-request).
Keep parent branches until their descendants are safely restacked. Remove only
owned worktrees after work is committed/pushed and no uncollected edits remain.

## Implementer assignment template

Fill the placeholders with inspected values before sending. Include the selected
PR row from the slice plan; do not send the implementer the entire slice as an
unbounded “implement the factory” task.

```text
Implement factory slice 1, PR <number>: <deliverable>.

Work only in the assigned isolated checkout on <branch>.
Base: <parent branch>, reviewed parent commit <SHA>.
Contract: .plans/factory/SLICE_1_IMPLEMENTATION_PLAN.md, PR <number>, plus the
cross-cutting invariants that apply to this increment.

Read AGENTS.md, ROADMAP.md and DEVIATIONS.md. Use the roadmap-implementation
skill. For Flue work use the installed-version Flue skill/docs. Before accessing
Drizzle files or generating migrations, load the required Drizzle skills.
Use the Impeccable skill for the shaping UI, preserving Neondeck's design language.

Build the assigned user path end to end, with typed services, durable state,
applicable UI/loading/error states, meaningful tests, docs and changesets.
Keep factory features disabled by default until ready. Do not add coding agents,
remote workers, PR delivery or unrelated Autopilot changes.

Treat this as a public repository. Never commit credentials, deployment addresses,
SSH configuration or raw live-environment logs. The gitleaks pre-commit hook must
run; do not disable it or use bypass flags. Use synthetic test data.

Run the PR's checks and acceptance scenarios. For UI changes, capture screenshots
of the implemented states using synthetic data, including relevant empty/error or
conflict states and the main happy path. Supply image paths with captions, viewport,
tested commit and reproduction steps. Keep environment details out of images.
Record actual deviations with reason and follow-up. Do not create PRs (even draft),
push for publication, merge PRs or change public deployment configuration.
Return the branch/base/head SHAs, scoped change summary, exact checks/results,
acceptance evidence, migrations, deviations and outstanding review concerns.
Stop at the assigned PR boundary. The manager reviews before assigning more work.
```

Use `npm exec -- flue docs search ...` then read relevant full pages; do not
implement obsolete workflow APIs from old roadmap prose. Planning was checked
against Flue 2.0.3 guides `guide/building-agents` and `guide/routing`; implementers
must additionally inspect `guide/durability`, tool result contracts, the agent API,
React clients and Node lifecycle docs when touching those surfaces. No dependency
upgrade is implied by this plan.

For migrations, follow the repository's Drizzle skill chain and generation/check
commands. Generate forward migrations from the current parent snapshot; do not
hand-edit applied migration history to make stacked branches agree.

## Review and evidence protocol

Dedicated reviewers work independently from the implementation conversation. Use the
repository's `roadmap-review` skill for static local-change review: inspect the
actual parent-relative changes and relevant source, roadmap and deviations.
That skill does not run tests, linters, builds, formatters, app commands or network
calls. The implementer runs verification and supplies evidence; publishing and
stack maintenance happen separately from the static review pass.

For already committed PRs, prepare an isolated review worktree at the recorded
parent and apply the exact PR delta as local changes before invoking the local-diff
review skill. The implementer or manager prepares that snapshot outside the review
pass. Record parent/head identity and include added files; never reset the active
implementation checkout just to manufacture a review diff.

Review in this order:

1. Domain correctness: source identity, transaction boundaries, exact-version
   release, stale inputs, restart reconciliation and external effect uncertainty.
2. Authority/exposure: planner capabilities, human-only release/send, task binding,
   public/private routes, and public-safe outputs.
3. Architectural fit: Flue vs app ownership, import layers, small reusable UI pieces,
   no second coding harness or removed coordinator resurrection.
4. Usability: clear next actor, model-led proposals, editable/versioned artifacts,
   recoverable conflicts and truthful queue/writeback states.
5. Evidence and scope: meaningful verification against the reviewed commit,
   migration/build coverage, honest omissions and documented deviations.

Return findings by severity with file/line references and concrete failure cases.
The implementer fixes them and supplies new evidence for affected paths. Do not
clear a correctness concern solely because tests pass. The publication gate is
**no findings**, not merely no high-severity findings. Resolve disputed findings
with evidence and obtain an explicit reviewer disposition; never silently waive
them. Record reviewer identity, parent/head SHAs, verdict and any acknowledged
residual limits. A changed candidate invalidates the prior verdict for the affected
scope and must be reviewed again.

After clean dedicated reviews, the manager inspects implementation and product-plan
adherence and checks the implementer's evidence. Any manager findings go back for
fixes and renewed dedicated review before publication. Manager acceptance is not
human merge approval.

UI screenshots are required evidence where applicable. The implementer captures
them before review; static reviewers inspect supplied artifacts without launching
the application. The manager checks that images correspond to the implemented
states, contain no credentials/deployment addresses/private context, and illustrate
the changed behavior. After the review gate, upload them with the available GitHub
CLI image-upload capability and embed the resulting assets in the PR description.
Inspect the installed `gh` help for the actual upload command; do not guess flags or
put workstation file paths into public Markdown. If upload is unavailable, preserve
the images and report the publication-evidence blocker rather than claiming upload.

## Private setup needed later

| Needed for                   | Input/access                                                                                                                                        | When                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Local PR work                | Node 26, dependencies, working pre-commit scanner                                                                                                   | Before PR 1; no live secrets required                       |
| Reviewed implementation PRs  | Existing GitHub CLI/account repository access and image-upload support where applicable                                                             | After dedicated reviews and final manager acceptance        |
| Real model exercise          | A configured existing provider credential and model roles                                                                                           | Before accepting model-led planning against a live provider |
| GitHub integration rehearsal | Selected registered test repo/issue, repo webhook setup access, webhook secret, least-privilege issue/comment credential, explicit writeback choice | Before live PR 4/5 acceptance                               |
| Deployment rehearsal         | SSH access through the operator's existing agent/config, private runtime home/config, public webhook route and private dashboard route              | Before deployed slice acceptance                            |

Do not ask anyone to paste private SSH keys or tokens into chat or planning docs.
Use the configured SSH agent/key reference and private environment secret references.
The deployment target has already been chosen in conversation; keep its address out
of tracked files, public PR bodies and screenshots. Confirm actual access/routing
privately when required; local implementation need not wait for it.

## Progress ledger

Update with real evidence as work proceeds. Do not infer “implemented” from branch
creation, “verified” from a claimed plan, or “deployed” from passing local tests.

| Increment                      | State                                                        | Branch/base + reviewed head                                                                                         | PR         | Verification / review / deployment evidence                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan root                      | Reviewed, open                                               | `agent/software-factory-plan`; head `9aba1ae2`, base `main`                                                         | #382       | Documentation only; not merged/deployed                                                                                                                                                                                            |
| 1 — Manual intake/domain       | Accepted, open                                               | `agent/factory-s1-01-intake`; head `0c39917930b42aeacc3cbad71031d5552a29ccee`, base `agent/software-factory-plan`   | #383       | Feature verification: 1,594 tests at `587bbafd`; six-line CI-only follow-up independently reviewed by both reviewers and manager; all six GitHub checks pass at `0c399179`; not merged/deployed                                    |
| 2 — Model planning             | Accepted, open                                               | `agent/factory-s1-02-planning`; head `3210fbb00eddb54e2873b1e44bfea9eea012b9d5`, base `agent/factory-s1-01-intake`  | #384       | Both dedicated static reviews and manager clean. V3 full verification: 1,623 tests on identical runtime source; final README-only clarification checked separately. All six GitHub checks pass at `3210fbb0`; not merged/deployed. |
| 3 — Human workbench            | Accepted, open                                               | `agent/factory-s1-03-shaping`; head `8809958947531e3c7fa727accae4aab3f3073f57`, base `agent/factory-s1-02-planning` | #385       | Both dedicated reviews and manager clean; 1,632-test verification followed by CSS-only wrap correction and rebuilt screenshots; all six GitHub checks pass. Not merged/deployed.                                                   |
| 4 — GitHub ingress             | Uncommitted candidate; final verification and review pending | `agent/factory-s1-04-github-ingress`; base/head `8809958947531e3c7fa727accae4aab3f3073f57` plus local delta         | Not opened | Signed receiver, reconciliation, attributed context and packaged listeners; see increment 4 operator guide. Actual deployment and external setup remain pending.                                                                   |
| 5 — GitHub status              | Not started                                                  | Not created                                                                                                         | Not opened | None                                                                                                                                                                                                                               |
| Full slice / deployed exercise | Not started                                                  | Record final accepted SHA                                                                                           | —          | Manual + GitHub + real model + restart + exposure checks pending                                                                                                                                                                   |

On completion, update `.plans/ROADMAP.md` and this ledger with the actual remaining
limits. Preserve the plans as active while review/landing is underway; archive under
the planning-index policy once complete. Next work is slice 2, not an unplanned
extension of the last PR into a coding agent implementation.

### Increment 2 implementation references

Installed Flue 2.0.3 full pages: `guide/durability`, `reference/agent-api`,
`reference/agent-hooks-api`, `guide/routing`, `guide/node-target`, `guide/react`,
`guide/observability`, `reference/agent-behavior`, `guide/models`, and
`reference/events` (provider-call interception). The installed public
`AgentDispatchRequest` declaration additionally supplies the idempotency-key replay
contract. Operator behavior and finite limits are documented in
[INCREMENT_2_OPERATOR.md](INCREMENT_2_OPERATOR.md).

### Increment 3 implementation references

See [human shaping operations](INCREMENT_3_OPERATOR.md). Installed Flue 2.0.3
`guide/react` informed the existing conversation integration; no runtime hooks,
planner tools or model policy were changed. Pierre 1.3.6 installed declarations
for `parseDiffFromFile` and `FileDiff` define the document renderer adapter.

### Increment 4 implementation references

See [GitHub intake operations](INCREMENT_4_OPERATOR.md). Installed Flue 2.0.3
`guide/node-target`, `guide/deploy`, `guide/routing`, `reference/agent-api`, and
`reference/agent-behavior`, plus the installed Node bootstrap/types, inform the
owned two-listener host and attributed signal delivery. No writable agent harness
is introduced. GitHub signature/best-practice and REST issue/comment documents and
exe.dev's index/proxy guide were read; actual deployment routing was not changed.
