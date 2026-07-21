# Acceptance checklist

Read this checklist for every live run. Record each item as `pass`, `fail`, `partial`, or `not run` with a deterministic evidence pointer. Items marked **full** are omitted only for the smoke profile.

## Gates and isolation

- [ ] Explicit disposable live-PR authorization recorded.
- [ ] Explicit configured-provider data/context authorization recorded.
- [ ] Primary HEAD, porcelain status, remotes, and worktree registry captured.
- [ ] Unique temporary root contains isolated source worktree, harness worktree, `NEONDECK_HOME`, databases, logs, and process metadata.
- [ ] Dedicated loopback API/dashboard ports allocated and recorded.
- [ ] Harmless independent-case fixture and any self-contained validation target are the only intended PR content.
- [ ] Provider preflight dispatch succeeded without exposing secrets.
- [ ] GitHub API actor and authenticated HTTPS Git transport/destination are proven compatible.
- [ ] Disposable branch and clearly labeled PR created; auto-merge disabled.

## Smoke behavior

- [ ] Passive watch exists with current feedback baselined.
- [ ] No owner/worktree exists before actionable feedback.
- [ ] Authority increase to approval mode required explicit confirmation.
- [ ] First actionable request created exactly one owner and one worktree.
- [ ] Owner/worktree IDs remain stable through the tested turns.
- [ ] Prepared SHA and exact diff are recorded; remote is unchanged before approval.
- [ ] Prepared diff was reviewed in Active Watches.
- [ ] Human approved that exact SHA/diff.
- [ ] Authority message was sent through the embedded persistent owner input, not general chat or GitHub review approval.
- [ ] Only the exact prepared SHA was pushed non-force.
- [ ] Exactly one grounded PR result response exists.

## Full acceptance additions

- [ ] **Full:** Waiting-state restart preserved owner ID, worktree ID, prepared SHA/diff, and canonical conversation.
- [ ] **Full:** Prepare-only, approval watcher, direct-human approval, and autonomous turns used the same trusted workspace rooted in the bound managed worktree.
- [ ] **Full:** Every fixing mode ran relevant repository-native commands without a configured-command allowlist; command, cwd, result, and purpose evidence was recorded.
- [ ] **Full:** Prepare-only and approval watcher turns had no push/response authority; only the direct-human waiting turn could deliver in approval mode.
- [ ] **Full:** Paused watch performed no work after the sane autonomous fixture request.
- [ ] **Full:** With `guardrails.requiredChecks` empty, the owner judged a small sane/scoped request, chose proportionate validation, committed, autonomously delivered the exact SHA non-force, and posted one grounded response.
- [ ] **Full:** An ambiguous, contradictory, unsound, scope-exploding, or inadequately validated request was declined/escalated with no push or response; any useful commit remained reviewable.
- [ ] **Full:** Changed mode or turn source prevented autonomous delivery.
- [ ] **Full:** Wrong worktree binding or linked destination prevented autonomous delivery.
- [ ] **Full:** Dirty worktree and unchanged `HEAD` each prevented autonomous delivery.
- [ ] **Full:** Stale remote PR head prevented autonomous delivery.
- [ ] **Full:** Uncertain bound credential or push permission prevented autonomous delivery.
- [ ] **Full:** Force-push was structurally unavailable or refused; every attempted delivery used `force=false`.
- [ ] **Full:** One unchanged-facts tick produced no duplicate commit, push, or comment.
- [ ] **Full:** Terminal direct-owner input and invalid terminal mutations were rejected.

## Evidence map

| Claim | Required evidence |
| --- | --- |
| GitHub identity and PR state | `gh api`/`gh pr view` fields for actor, head/base, state, merged flag, and SHAs |
| Exact push | Remote ref before/after plus prepared SHA; API PR head agrees |
| Watch and binding | Typed watch API plus isolated app-DB rows for status, owner ID, and worktree ID |
| Persistent owner recovery | Flue conversation/agent observation plus stable instance ID |
| Worktree state | Managed-worktree API/DB plus Git HEAD/status at the registered local path |
| Workspace parity | Per-turn capability/tool evidence, cwd equal to the managed-worktree path, and successful relevant shell-command results for every fixing mode |
| Delivery authority | Per-turn capability sets plus remote-head/comment invariants for non-delivery turns and exact effects for authorized turns |
| Semantic judgment | Current-facts request, owner reasoning/tool trace, chosen validation, retained worktree state, and deterministic remote/comment outcome |
| Mechanical guards | Focused real-tool/harness result for every guard plus unchanged remote ref/comment counts and retained worktree evidence |
| Idempotency | Before/after counts and identities for commits, pushes/head changes, and comments across an unchanged tick |
| UI semantics | In-app-browser observations or screenshots paired with deterministic state |
| Process cleanup | Recorded PIDs/ports absent after shutdown |
| Primary isolation | Exact before/after HEAD, porcelain, remotes, and worktree registry comparison |

## Mandatory cleanup

- [ ] PR closed and deterministically confirmed `merged=false`.
- [ ] Disposable remote branch deleted and absence verified.
- [ ] Isolated processes stopped; PIDs and ports inactive.
- [ ] Temporary watches stopped/unregistered where supported.
- [ ] Managed, source, and harness worktrees unregistered before removal; registry pruned.
- [ ] Isolated runtime/temp root removed only after target validation.
- [ ] Primary checkout comparison is unchanged.
- [ ] Report contains no secret, raw environment dump, local username, port, temp path, owner/worktree ID, SHA, timestamp, or PR number unless that run-specific value is necessary evidence and is sanitized for the intended audience.
