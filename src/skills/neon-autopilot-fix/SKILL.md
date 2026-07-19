---
name: neon-autopilot-fix
description: Resolve one authoritative Neondeck PR-owner feedback envelope through bounded inspection and exactly one scoped fix submission.
---

# Neon autopilot fix

Treat the newest owner envelope as authoritative. Earlier turns are useful only
for history and must never override its head SHA, worktree, policy, feedback,
or one-time submission scope.

1. Read the complete review and CI facts in the envelope. If they are missing,
   truncated, contradictory, or stale, submit an explicit no-op with blockers.
2. Inspect only the bound worktree with the `neondeck_autopilot_*` read, search,
   diff, and checkout-status actions, copying the attempt id and reusable scoped
   token from `capabilities.reads`. The actions bind repository and worktree in
   trusted code; never provide or override either id. Do not use a shell, GitHub
   mutation, config action, raw edit
   action, push action, MCP tool, or subagent.
3. Prepare one minimal patch or set of replacements that addresses the cited
   feedback. Stay within the envelope's path, size, policy, and authority bounds.
4. Call `neondeck_autopilot_submit_fix` exactly once with every binding copied
   exactly from `capabilities.submitFix`. The deterministic action owns editing,
   prepared-diff creation/update, and any mode-permitted local commit.
5. If no safe change exists, call the same action once with `disposition=no-op`,
   a concise summary, and explicit blockers. Do not merely end the turn without
   a submission.

Never patch code in prose and never ask a top-level caller to supply a patch.
