---
name: github-gh
description: Choose between deterministic GitHub API actions, local git facts, and approved gh CLI workflows in Neondeck.
---

# GitHub and gh Runtime Guidance

Use this skill when the user asks about GitHub pull requests, CI checks, local branches, release readiness, or whether Neon should use GitHub API actions, local git, or the `gh` CLI.

## Prefer Deterministic Neondeck Actions

Use Neondeck's typed actions and tools before reasoning:

- Use `neondeck_github_pr_queue_lookup` for review queues, authored PRs, assigned PRs, requested reviews, stale PRs, and check summaries already available through the GitHub API.
- Use `neondeck_pr_review_comments_lookup`, `neondeck_pr_requested_changes_lookup`, and `neondeck_pr_branch_permissions_lookup` for PR review-feedback autopilot facts before reasoning about fixes or push-back.
- Watched-PR delivery uses only the continuing owner's mode-scoped push tool. Every fixing mode has a full repository-native coding workspace in its managed worktree. In autonomous mode the owner decides whether feedback is reasonable, scoped, sound, and sufficiently validated; the push tool rechecks only the current autonomous turn, bound non-force destination, exact remote head, clean committed worktree, and credential identity. Approval mode receives delivery authority only on the direct human turn while the commit is held for review.
- Use `neondeck_pr_comment` to post a concise PR summary comment only after the intended body is explicit and grounded in fetched review/check/worktree facts.
- Use `/review-queue`, `/explain-ci`, `/summarize-pr`, `/draft-pr-description`, `/prepare-pr`, and `/review-local` through `neondeck_command_run` when the user wants a durable command summary.
- Use `neondeck_repo_status_lookup` for local git status facts that do not need a persisted command result.
- Use watch actions for persistent PR or release monitoring instead of repeatedly polling from chat.

## When gh Is Appropriate

The `gh` CLI is a host command. Do not claim it ran unless `neondeck_execution_run` actually runs it.

The default execution policy preapproves single-command `gh` invocations so agents can use GitHub API and CLI capabilities for their tasks. Shell operators are still not supported by the local executor.

Use `gh` when:

- the GitHub API action cannot expose the needed fact yet
- the user is working in a configured local checkout
- the command would be useful for the user or task
- the command passes `neondeck_execution_policy_check` if Neon is being asked to run it

Good candidates for `gh` use include:

- `gh pr view`
- `gh pr checks`
- `gh run view`
- `gh api`
- `gh pr diff`
- `gh issue`
- `gh pr`

Run `gh` through `neondeck_execution_run` when the execution policy preapproves it. If a command is not preapproved, create an approval request instead of using raw shell.

For mutations such as creating PRs, merging, closing issues, rerunning workflows, or editing labels, be explicit about the intended change before running the command.

## Answering Pattern

Separate facts from inference:

1. State the deterministic facts returned by Neondeck actions.
2. Note missing data plainly.
3. If a `gh` command would fill the gap, present it as a proposed command unless an approved executor is available.
4. Keep PR and CI advice operational: first failing check, likely next inspection, local validation command, and whether a watch should be created.
