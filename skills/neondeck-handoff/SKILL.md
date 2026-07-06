---
name: neondeck-handoff
description: Register completed local agent work with Neondeck so Neon can watch PRs, show notes, and queue bounded review assistance when allowed.
---

# Neondeck Handoff

Use this skill when you are an external local coding agent working in a repository that the user tracks with Neondeck.

Before using it, check that the CLI exists:

```sh
command -v neondeck >/dev/null 2>&1
```

If `neondeck` is missing, do nothing and do not tell the user to install it unless they asked about Neondeck.

## After You Push A PR

When you push or update a pull request for a Neondeck-tracked repo, run:

```sh
neondeck register-pr <owner/repo#number> --from <agent-name> --note "<one-line summary>" --json
```

Use a stable lowercase source name such as `claude-code`, `codex`, `kilo`, or `ci:github-actions`. The CLI stores it as attribution such as `external:codex` unless you already use a `ci:` or `external:` prefix.

The JSON contract is:

```json
{
  "ok": true,
  "action": "handoff_pr_register",
  "changed": true,
  "id": "owner/repo#123",
  "message": "Registered owner/repo#123 from codex.",
  "deckUrl": "/"
}
```

If `ok` is false, read `message`, `requires`, and `errors`. Do not retry in a loop. Duplicate PR registration is safe and returns success.

Add `--review` only when the user or repo policy wants Neon to queue bounded PR review assistance. It may start a model-backed Flue workflow that reads PR facts and creates local reports/draft comments, but it does not submit a GitHub review.

## After Significant Work Without A PR

Leave a bounded note:

```sh
neondeck note "Finished local refactor; no PR was pushed." --from <agent-name> --repo <repo-id-or-owner/name> --level ready --json
```

Levels are `info`, `ready`, and `attention`. Notes are capped to 4 KiB. Use `attention` only when the user needs to act.

## Release Watching

To watch the default branch or a source PR through release checks:

```sh
neondeck watch-release <repo-id-or-owner/name> --from <agent-name> --json
neondeck watch-release <repo-id-or-owner/name> --source-pr <owner/repo#number> --from <agent-name> --json
```

Do not use handoff commands for execution, approvals, pushes, provider changes, or remote ingest. They are only for attributed local registration into Neondeck.
