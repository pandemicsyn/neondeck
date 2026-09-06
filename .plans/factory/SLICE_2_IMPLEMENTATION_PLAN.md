# Slice 2 — Brief to candidate

Status: implementation authorized on 2026-09-06; no slice 2 implementation accepted or published yet.

## Mandatory merge gate: live slice 1 acceptance

**Do not merge any slice 2 PR until the operator and manager have completed and recorded live slice 1 acceptance.** The user deferred this exercise until the morning. Local implementation, mockdex tests, static reviews and draft stacked PRs may proceed in the interim. Mock results and CI do not satisfy this gate. This is a manager-enforced delivery gate, not a claimed GitHub branch protection rule.

Slice 1 merged in PRs #382–#387 and #389, ending at `13049498d457257626af80483d68e0aa8110ad68`. The final reviewed tree passed 1,968 tests, 63 CI checks, both independent static reviews and manager review. Deployment and live acceptance remain pending.

Before any slice 2 merge, record date, operator/manager acceptance and public-safe evidence for:

- [ ] Authorized private runtime setup and VM deployment, using existing SSH access and private provider/credential references.
- [ ] Real GitHub test issue admission through the signed public webhook; duplicate/reordered deliveries, invalid signatures and closed-source behavior.
- [ ] Live model triage and model/human planning iteration, revision comparison, persistent conversation/brief recovery, and exact human release. Unanswered decisions and changed specifications invalidate release as designed.
- [ ] Explicitly opted-in issue status/question writeback and attributed replies; retry without duplicate comments; replies cannot release work.
- [ ] VM/Neon restart recovery with no lost accepted work, and anonymous external checks proving the webhook is public while dashboard/API remain private.
- [ ] Operator and manager accept the results; failures fixed and relevant checks repeated.

Gate state: **PENDING — blocks all slice 2 merges.** Keep hostnames, credentials, SSH configuration and raw private evidence out of tracked files, screenshots and PR bodies. Do not ask for private keys in chat. No live VM/provider exercise is authorized for this interim implementation.

## Product outcome

An explicitly enabled factory consumes an exact human-released brief, creates a managed local worktree, invokes the existing Codex CLI, and retains a reviewable candidate with provenance, logs and session identity. Completion of the CLI is not acceptance of the task. A human can inspect the candidate and stop a run. Independent product verification/repair and publishing a generated PR belong to slice 3. OpenCode belongs to slice 4; remote worker provisioning belongs to slice 6.

Use a provider-neutral coding-run contract and a local execution-host boundary. Reuse existing managed worktrees, lock/path/cleanup policy, app SQLite, Valibot, event notifications and diff UI. Adapt Kilo lifecycle patterns without routing Codex through Kilo or duplicating its assumptions. Existing Kilo and Autopilot keep working; do not rebuild the removed Autopilot coordinator or a model/tool loop.

## Invariants and ownership

- Separate factory work/release, coding run, attempt, workspace and provider session identities. Bind the attempt to the immutable spec hash/version, source/repo context, policy, base commit, harness version/model and context snapshot.
- Off by default. Admission rechecks current release, enabled configuration, repo mapping and source state. One active writer globally for v1 and one per repo. Atomic durable reservation precedes resource creation; repeat admission cannot launch a second writer. A changed or withdrawn release fences the old attempt and requests cancellation.
- Worktrees belong to Neon and use a dedicated factory branch; never code in the primary checkout. Pin and record the base SHA. Hold ownership through evidence collection and verified process termination. A timed-out lease is not proof the writer is dead.
- CodingAgent owns Codex arguments, JSONL parsing and session identity. ExecutionHost owns workspace, process lifecycle, receipts, artifacts and cleanup. Keep this boundary usable by a future remote host without requiring SSH or VM provisioning now.
- Fresh Codex session per new task/attempt. Do not use last-session resume. Record explicit session IDs. Repair/resume admission is deferred to slice 3; do not expose an unsafe generic resume action.
- Explicit cwd, permission profile and model. Private per-attempt harness home, scratch and logs; allowlisted environment and explicitly selected model credentials only. Do not inherit control-plane webhook/GitHub/deployment secrets or operator plugins/MCP configuration. Operational isolation is for trusted repos; it is not an OS sandbox.
- Thin out-of-process supervisor survives controller death, writes bounded logs, heartbeat and atomic terminal receipt, and owns the CLI process group. Cancellation intent persists; TERM then bounded KILL covers child dev servers. Reconciliation imports a receipt or monitors the known job; uncertainty quarantines the workspace as needs-reconcile and never launches a replacement writer.
- Enforce wall-clock/output limits independently of Neon staying alive. Initial execution budget is 45 minutes, one attempt with no automatic repair loop. Model-reported success is untrusted: require terminal receipt and collect Git head/status/diff including untracked changes before presenting a candidate.
- Retain failed, dirty, unpublished and uncertain work. Do not automatically discard a candidate. Show cleanup attention after seven days; retain bounded logs/session evidence for 30 days subject to active/uncertain-run protection. Explicit cleanup must prove ownership and dead compute and use existing worktree policy; deletion cannot silently destroy unpublished changes.
- Validate config, requests/responses, DB records, disk receipts, CLI output and OS/process observations at IO boundaries with Valibot. Keep modules small with precise types; no broad any or unchecked casts. GitHub reads continue through the existing conditional-cache client if any are needed; slice 2 needs no new GitHub write path.

## Human touchpoints

| Moment           | Human surface and authority                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup            | Explicitly enable coding and select supported CLI/model/auth reference and finite limits; explain trusted local isolation.                                                |
| Before coding    | Existing model-led shaping and exact human release remain the admission authority. Ordinary chat and issue replies cannot start coding.                                   |
| During execution | Factory task shows run/attempt state, session ID, bounded progress, elapsed time and cancel action.                                                                       |
| Needs attention  | Explain failed launch, invalidated release, exceeded budget or uncertain ownership; retain evidence and offer safe reconciliation, never blind retry.                     |
| Candidate ready  | Link retained managed-worktree diff and show pinned base/head, changed files, execution result and validation limitations. Candidate is awaiting review, not done/merged. |
| Cleanup          | Require explicit discard when valuable work would be lost; otherwise retain according to existing policy.                                                                 |

## Reviewable stack and assignments

Use official gh stack with branch prefix agent/. Start from merged main. Layers may be refined for clean ownership, with deviations recorded.

1. `agent/factory-s2-00-plan`: merge gate, corrected slice 1 landing status and this contract.
2. `agent/factory-s2-01-runs`: shared Valibot coding-run contracts, app persistence/migration, atomic admission/state/ownership primitives and tests. No process launch yet.
3. `agent/factory-s2-02-codex`: supervised local host, Codex adapter and test-only mockdex CLI, restart/cancel/limits/evidence tests.
4. `agent/factory-s2-03-workbench`: released-brief dispatch, config/API/runtime lifecycle, candidate/run UI using existing diff surface, operator docs and screenshots.
5. `agent/factory-s2-04-acceptance`: only integration corrections required by cumulative acceptance, if needed; avoid an empty hardening PR.

Implementers use isolated worktrees and start at low reasoning for bounded changes; complex process/recovery work may use medium. Two independent dedicated static reviewers (medium) inspect each candidate before publication. The manager performs the final implementation and product-plan review. Findings return to implementers. No PR, including documentation or draft PRs, is created until both reviewers report NO FINDINGS and the manager accepts that exact candidate. New code after review requires renewed review. Never bypass the secrets-scanning pre-commit hook. Include actual synthetic UI screenshots for UI changes and upload with supported gh image attachment commands. Every PR body must repeat the pending slice 1 live-acceptance merge gate.

## Acceptance and evidence

Use Node 26.4.0 and the repository check/verify suites, with isolated temporary runtime homes and Git repos. mockdex is explicitly configured for tests and never substitutes automatically for missing Codex. Pin the supported real CLI contract from installed help/types or official documentation; record the version and date. Mock JSONL/receipts prove controller behavior, not real model quality or real CLI compatibility.

- Concurrent and replayed admission reserves at most one writer; disabled/stale/closed/withdrawn work cannot launch.
- Real mockdex subprocess exercises a small deterministic edit through candidate collection; verify primary checkout unchanged and dirty/untracked content retained.
- Fresh controller process reconciles a still-running or completed supervisor after controller termination without duplicate launch. Lost/untrusted receipt/process identity stays quarantined.
- Cancel a process with a child dev server; both terminate before lock release. Restart during cancellation completes the same intent.
- Failure, spawn error, missing terminal event, malformed/oversized output, output/time exhaustion and contradictory receipts are visible and bounded.
- Test secret/environment separation, isolated harness state, ownership/path rejection, safe repeated cleanup and failed/dirty retention.
- UI empty/loading/error/running/cancelling/needs-reconcile/candidate states and review links; screenshots from synthetic data, no private credentials or deployment target.
- Full cumulative npm run verify and staged/range secret scans; independent static reviews and manager acceptance. Any remaining real Codex smoke or remote acceptance must be explicitly pending.

## Progress ledger

| Layer / gate                             | State                          | Evidence                                           |
| ---------------------------------------- | ------------------------------ | -------------------------------------------------- |
| Slice 1 live acceptance                  | PENDING — blocks slice 2 merge | Morning operator exercise; no live test performed. |
| Slice 2 plan                             | In progress                    | This contract; publication waits for reviews.      |
| Coding run foundation                    | Pending                        | No implementation accepted.                        |
| Local Codex host / mockdex               | In progress                    | Delegated mockdex fixture; no live CLI invocation. |
| Factory workbench integration            | Pending                        | No implementation accepted.                        |
| Cumulative acceptance / real Codex smoke | Pending                        | Mock and live evidence must remain distinct.       |
