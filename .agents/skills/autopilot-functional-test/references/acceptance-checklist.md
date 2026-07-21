# Acceptance checklist

Read this checklist for every live run. Record each item as `pass`, `fail`, `partial`, or `not run` with a deterministic evidence pointer. Items marked **full** are omitted only for the smoke profile.

## Gates and isolation

- [ ] Explicit disposable live-PR authorization recorded.
- [ ] Explicit configured-provider data/context authorization recorded.
- [ ] Primary HEAD, porcelain status, remotes, and worktree registry captured.
- [ ] Unique temporary root contains isolated source worktree, harness worktree, `NEONDECK_HOME`, databases, logs, and process metadata.
- [ ] Dedicated loopback API/dashboard ports allocated and recorded.
- [ ] Harmless two-field text fixture is the only intended PR content.
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
- [ ] **Full:** Paused watch performed no work after the autonomous fixture request.
- [ ] **Full:** Autonomous mode without a required check blocked and left the remote unchanged.
- [ ] **Full:** Exact fixture-only check passed after policy repair.
- [ ] **Full:** Current head, policy, and authenticated HTTPS actor were re-proven before safe push.
- [ ] **Full:** Exact autonomous prepared SHA was pushed non-force and result behavior was recorded.
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
