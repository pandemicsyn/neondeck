---
name: stacked-prs
description: Use only when the user explicitly asks to implement with stacked PRs, branch-on-branch PRs, or `gh stack`. For ordinary implementation, use vanilla branches, worktrees, and pull requests.
---

# Stacked PRs

Use GitHub's official `github/gh-stack` extension to create a linear series of branches where each pull request targets the branch below it.

## When to Use

Use this skill only when the user specifically requests a stack. Otherwise use vanilla branches, worktrees, and PRs, even when a change is large or could be split.

## Usage

Inspect the current branch and working tree, preserve unrelated changes, and confirm `gh stack --help` works. If needed, install the extension:

```sh
gh extension install github/gh-stack
```

Plan a few reviewable layers from foundational to dependent, then implement and commit them bottom to top:

```sh
gh stack init --base <trunk> <first-branch>
# implement, verify, and commit
gh stack add <next-branch>
# implement, verify, and commit
gh stack view --json
gh stack submit --auto
```

`submit --auto` creates draft PRs. Add `--open` only when the user wants them ready for review.

To update a lower layer:

```sh
gh stack checkout <branch>
# edit, verify, and commit
gh stack rebase --upstack
gh stack push
```

Use `gh stack sync` after lower layers merge.

## Rules

- Keep layers linear, focused, and independently reviewable, with their own tests and documentation.
- Follow repository branch conventions; in this repository, default to `agent/` names.
- Use explicit arguments and non-interactive forms such as `view --json` and `submit --auto`.
- With multiple remotes, identify the correct one and pass `--remote <name>` where supported.
- Publish, merge, prune, unstack, or restructure only when authorized by the user's request.
- Consult the [GitHub command reference](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands) for less common operations and recovery.
