---
name: flue
description: Use when building, debugging, reviewing, migrating, or documenting Flue projects, including agents, hooks, tools, skills, subagents, sandboxes, routing, channels, persistence, schedules, observability, React clients, deployment targets, and CLI usage. Find and read version-matched Flue documentation before relying on API details.
---

# Flue

Treat every Flue API detail as versioned. Inspect the project, search the relevant documentation, and read the matching pages before designing or editing code. Do not implement Flue APIs from memory.

## Establish the Documentation Target

1. Inspect `package.json` and the lockfile for the installed `@flue/*` versions.
2. Decide whether the task targets the installed version or upgrades to a newer version.
3. Use the project-local `flue` executable. Do not install or download another CLI merely to search its docs.

For maintenance work, prefer the documentation bundled with the installed `@flue/cli`; it matches the code being maintained. For upgrade work, read the target release's migration guide and current official docs until the dependency pins have been upgraded, then use the newly installed CLI docs.

Never combine examples from different Flue versions without explicitly reconciling the changed API.

## Search, Then Read

Use the local CLI through the project's package manager so the repository's binary wins. For npm projects, use this loop:

```sh
npm exec -- flue docs search durable execution
npm exec -- flue docs read guide/durability
```

Apply these commands deliberately:

- Run `flue docs search <query>` with the exact concept, symbol, import, CLI flag, or error text. The command returns up to eight ranked JSON results.
- Run `flue docs read <path>` for the most relevant results and read each page completely before acting on it.
- Run `flue docs` with no arguments when terminology has changed or search results are ambiguous; it lists every bundled page.
- Pass a catalog path, docs URL, absolute docs path, or source Markdown filename to `flue docs read`.
- Refine broad searches. For a cross-cutting change, search and read each affected surface rather than relying on one overview page.

Useful query shapes include:

```sh
npm exec -- flue docs search usePersistentState
npm exec -- flue docs search "tool result envelope"
npm exec -- flue docs search "conversation scoped client"
npm exec -- flue docs search "submission_settled"
npm exec -- flue docs search "<exact error message>"
```

If the local CLI is unavailable, inspect installed package types and source first. Then use only official Flue documentation at `https://flueframework.com/docs/` as the network fallback. State when live docs target a different version than the installed packages.

## Verify the Contract

Read enough material to verify all affected boundaries:

- Confirm imports, signatures, return envelopes, statics, hook rules, route shapes, event fields, and CLI flags.
- Inspect installed `.d.ts` files or runtime source when the docs do not answer a code-level question.
- Search the repository for existing conventions and removed APIs before editing.
- Treat compiler errors as prompts for another exact-symbol or exact-error docs search.
- Record the Flue docs paths that materially informed the implementation in the handoff.

## Migrate to Flue 2

For a `1.0.0-beta.9` to Flue 2 migration, read the live [migration guide](https://flueframework.com/docs/guide/migration/) before editing. Use its ordered checklist as the migration sequence: pins, build, routing, agents, tools, skills, workflows, channels and database, providers, observability, clients, deployment, then verification.

Keep these Flue 2 boundaries visible while migrating:

- Use Vite with `@flue/vite`; do not use the removed `flue dev` or `flue build` commands.
- Mount each agent and channel explicitly in `app.ts`; do not use the removed auto-router.
- Define agents as exported capitalized synchronous functions in a `'use agent'` module and compose behavior with hooks; do not use `defineAgent`.
- Replace Actions with tools. Use `run({ data })` and return the documented tool result envelope.
- Replace each Workflow with the smallest correct fit: an awaited `init()` handle, a durable tool, or an application-owned orchestrator.
- Import `SKILL.md` directly without import attributes. Wrap other Markdown with `defineSkill` only when it must behave as a skill.
- Attach a sandbox explicitly when filesystem or shell capabilities are required; Flue 2 provides no implicit sandbox.
- Use conversation-scoped SDK and React clients rather than the removed deployment-wide namespaces.
- Correlate observability with agent/submission events and `instanceId`/`submissionId`, not workflow runs.

Treat that list as orientation, not an API reference. Search and read the current target-version page for every item before implementing it.

## Choose the Smallest Flue 2 Primitive

- Use an agent for continuing, addressable model conversations.
- Use a tool for a typed capability the model or application can invoke.
- Use a durable tool for a short checkpointed side-effect sequence owned by one agent turn.
- Use application code for deterministic domain services, scheduling, and multi-step orchestration with its own state and inspection needs.
- Use a skill for procedural guidance that shapes model behavior.

For Neondeck, keep application SQLite state separate from Flue conversation/runtime persistence. Preserve one typed backend command and event surface for dashboard and future clients. Prefer deterministic Neondeck services for facts and mutations, and use Flue where model reasoning, conversation continuity, or model-facing tools add value.

## Validate Changes

Run the repository's focused typecheck and tests, then the production Vite build when build, routing, generated exports, or deployment configuration changes. During a migration, re-run searches after upgrading the packages so final code is checked against the documentation bundled with the installed Flue 2 CLI.

Primary references:

- `flue docs` CLI: https://flueframework.com/docs/cli/docs/
- Flue 2 migration guide: https://flueframework.com/docs/guide/migration/
