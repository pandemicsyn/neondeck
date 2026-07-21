---
name: autopilot-functional-test
description: Run a consent-gated Neondeck Autopilot smoke or full acceptance test against a live disposable pull request with isolated runtime, source, and harness state. Use when a user explicitly requests an Autopilot smoke test, functional test, acceptance test, end-to-end test, or live disposable-PR validation.
---

# Autopilot Functional Test

Test the real product path without risking an existing pull request or checkout. Keep external effects and cleanup low-freedom: execute each gate in order, stop on uncertainty, and support conclusions with deterministic evidence.

## Select the profile

- Use `smoke` unless the user explicitly asks for full acceptance or names behaviors unique to it.
- `smoke`: passive watch and lazy binding; one approval-mode requested change; exact human-approved push and result; terminal cleanup.
- `full acceptance`: smoke plus restart recovery, autonomous no-check fail-closed behavior, targeted-check repair, verifiable safe push, an idempotency tick, and terminal-state rejection checks.

Read [references/acceptance-checklist.md](references/acceptance-checklist.md) before preflight. Use [assets/report-template.html](assets/report-template.html) for the final sanitized report. Treat `.plans/research/AUTOPILOT_FUNCTIONAL_TEST_ASSESSMENT.html` as historical evidence only; never use its identifiers or environment details as procedure defaults.

## Obtain authority before touching GitHub or the provider

Record two explicit user authorizations:

1. Authorization to create and use a live disposable branch and pull request for this test.
2. Authorization to send the disposable PR content and Neondeck agent context to the currently configured model provider.

Do not infer either authorization from a general request to test. If either is absent, pause and ask. State that the PR will never be merged and that provider use may incur cost. Consent to the live test does not pre-authorize the later approval-mode push: obtain exact prepared-diff approval at that gate.

## Enforce the safety envelope

Before PR creation:

1. Capture the primary checkout's path, HEAD, porcelain status, remotes, and registered worktrees. Refuse to continue if unrelated state prevents a trustworthy unchanged comparison.
2. Create a unique temporary root. Put a detached source worktree, a separate fixture-branch harness worktree, isolated `NEONDECK_HOME`, app and Flue databases, logs, and process metadata beneath it. Allocate unused loopback API and dashboard ports; never reuse the normal runtime.
3. Use a purpose-built harmless text fixture with two independent fields: one for the approval path and one for the autonomous path. Do not modify product code, dependencies, CI, configuration, secrets, or generated files.
4. Carry only non-secret provider selection/configuration into the isolated runtime. Supply credentials through the existing environment or credential helper. Never print, interpolate into reports, copy, or persist secrets.
5. Prove a minimal provider dispatch succeeds from the isolated runtime after provider consent. Prove the GitHub API actor and an authenticated HTTPS Git transport actor are bound to the intended disposable-branch destination. Do not accept SSH identity as proof. Abort before PR creation if either proof fails.
6. Push the harmless fixture branch over the proven authenticated HTTPS path, then open a clearly labeled disposable PR. Never enable auto-merge and never merge it.

Use process-scoped Git settings only. Do not change global or primary-checkout Git configuration. Keep the primary checkout unchanged throughout.

## Execute smoke

1. Register the isolated repository/runtime and create a passive `notify-only` watch. Baseline current feedback. Use deterministic API and SQLite reads to prove there is no owner or managed worktree before an actionable event.
2. Increase the watch to `autofix-with-approval` through the product surface and confirm the authority increase. Add one narrowly scoped inline request against the approval fixture field.
3. Tick or await the watcher. Prove exactly one stable owner and one managed worktree are lazily bound. Record the PR head, owner ID, worktree ID, prepared commit, watch state, and remote head without exposing secrets.
4. In Active Watches, use the in-app browser to inspect the prepared diff semantically. Independently verify the diff and SHA through API/Git/SQLite evidence. Require the human to approve that exact prepared SHA and intended diff.
5. Only after that exact approval, send the user's authority message through the embedded persistent owner input in Active Watches. This is not general Neon/display-assistant chat and not a GitHub Approve review. Instruct the owner to push exactly the reviewed prepared commit and post one concise result.
6. Prove the exact prepared SHA reached the PR head, no force push occurred, and the expected result response exists. Record the persistent owner conversation settlement separately from watch/worktree state.
7. Close the PR without merging and continue through terminal cleanup.

## Extend to full acceptance

Perform these additions without replacing the smoke assertions:

1. Restart the isolated Neondeck process while approval mode is waiting, before the direct-human message. Prove the same owner, worktree, prepared SHA, diff, and canonical Flue conversation recover. Flue conversation durability and filesystem/worktree persistence are separate assertions.
2. After the approval path succeeds, increase to `autofix-push-when-safe`. Pause polling, add a second inline request against the autonomous fixture field, and verify nothing runs while paused.
3. Resume with no required check configured. Prove the owner prepares a commit but fails closed: remote head unchanged, prepared state retained, and watch blocked with the missing-check reason.
4. Configure one exact, harmless fixture-only check. Re-prove current head, policy, and authenticated HTTPS actor. Cause a fresh current-facts evaluation and prove the targeted check passes and the exact prepared SHA is pushed non-force. Do not treat the model's claim as evidence.
5. Trigger one additional watcher tick with unchanged facts. Prove no duplicate commit, push, provider-effect response, or PR comment occurred.
6. Close the PR and wait for terminal state. Prove a direct owner message is rejected, terminal mutations fail closed, the managed worktree reaches deleted state, and the durable owner conversation remains readable where supported.

## Separate UI and deterministic evidence

- Use the in-app browser for semantic UI assertions: labels, authority-increase confirmation, Active Watches diff review, embedded owner input, visible status, and control availability.
- Use `gh`, local HTTP APIs, Git, and isolated SQLite databases for exact PR state, SHAs, review/comment identity, watch state, owner/worktree IDs, idempotency counts, terminal state, and cleanup.
- Never rely on screenshots, model prose, UI text alone, or database internals alone for an external GitHub effect. Cross-check boundary effects through the authoritative API or Git remote.

## Always clean up

Run cleanup after success, failure, interruption, or user cancellation:

1. Close the disposable PR if open; verify `merged=false` and a closed final state.
2. Delete the disposable remote branch and verify it is absent.
3. Stop every isolated API, dashboard, and helper process; verify their PIDs and ports are no longer active.
4. Stop/unregister the watch where possible, remove temporary Git worktrees with `git worktree remove`, and run `git worktree prune`. Never recursively delete a registered worktree.
5. Remove the isolated runtime and temporary root only after targets resolve inside that root and all processes/worktrees are detached.
6. Re-capture primary HEAD, porcelain status, remotes, and worktree registry. Compare them with preflight and report any difference immediately.

Cleanup failure is a test failure. Do not finish until cleanup is confirmed or a concrete unresolved target is handed to the user.

## Report

Copy the HTML template to a result path outside the skill, replace every `{{...}}` placeholder with sanitized evidence, and leave no token, credential, local username, temp path, raw environment dump, or unnecessary provider payload. Record approval method, profile, consent/config provenance, exact evidence, acceptance matrix, defects, limitations, cleanup, and final PR state. Distinguish observed facts from inferences and mark unexecuted checks `not run`, never `pass`.
