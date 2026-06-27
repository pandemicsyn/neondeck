---
name: flue
description: Explain, research, design, and carefully implement Flue framework projects and integrations. Use when Codex is asked about Flue features, docs locations, TypeScript agents, workflows, actions, skills, schedules, routes, React clients, Node.js or Cloudflare targets, persistence, durable execution, or Flue integration in a local developer dashboard such as neondeck.
---

# Flue

Use this skill when working on Flue framework projects or answering questions about Flue capabilities. Flue is evolving quickly, so treat this skill as a map and orientation guide, not a frozen API reference.

Prefer this order of authority:

1. Current project code and installed `@flue/*` package docs.
2. Public Flue docs linked in this skill.
3. Prior memory or examples, only after verification.

## Start Here

Read [references/docs-map.md](references/docs-map.md) when you need feature coverage, docs URLs, or a reminder of which Flue primitive fits a task.

For implementation work, inspect the project before editing and verify exact function names, imports, route shapes, and CLI flags against the installed package or current docs:

1. Check `package.json` for installed Flue package versions.
2. Identify the active Flue source layout and discovered resource directories.
3. Inspect Flue config, application entrypoints, persistence setup, agents, workflows, channels, actions, and imported skills.
4. Validate with the repo’s typecheck/build scripts and Flue CLI where appropriate.

## Choose the Flue Primitive

- Use an **Agent** for continuing, addressable sessions with identity and persistent conversation state.
- Use a **Workflow** for bounded, finite jobs with lifecycle events, run records, and inspectable results.
- Use an **Action** for reusable, schema-backed harness logic that should be deterministic or callable from multiple places.
- Use a **Skill** for procedural knowledge, conventions, or prompt guidance that should shape model behavior.
- Use **Schedules** when recurring work should start workflows or send events to continuing agents. Node.js still needs an application scheduler; Cloudflare can use Worker scheduling primitives.
- Use **Routing** when the application needs auth, health checks, route prefixes, custom APIs, webhooks, SPA serving, or another HTTP surface alongside Flue.

## Implementation Guardrails

- Avoid hardcoding Flue API details from memory. Confirm exact names and signatures before writing code.
- Keep scheduled work modeled as Flue work units, but let the host environment or app scheduler decide when to start them.
- Treat workflow/run inspection as potentially sensitive because it can reveal prompts, inputs, outputs, and model activity.
- For Node.js persistence, verify the current database guide before adding or changing state storage.
- For Cloudflare persistence, verify the current Cloudflare target guide before adding database files or migrations.
- For React clients, verify the mounted API path and SDK setup before choosing a `baseUrl`.
- For host filesystem or shell access, verify the target and sandbox guide before enabling local execution.

## Docs

Primary docs:

- Quickstart: https://flueframework.com/docs/getting-started/quickstart/
- Quickstart Markdown: https://flueframework.com/docs/getting-started/quickstart/index.md
- Schedules: https://flueframework.com/docs/guide/schedules/
- Project Layout: https://flueframework.com/docs/guide/project-layout/
- Agents: https://flueframework.com/docs/guide/building-agents/
- Workflows: https://flueframework.com/docs/guide/workflows/
- Actions: https://flueframework.com/docs/guide/actions/
- Skills: https://flueframework.com/docs/guide/skills/
- Routing: https://flueframework.com/docs/guide/routing/
- Database: https://flueframework.com/docs/guide/database/
- React: https://flueframework.com/docs/guide/react/
- Node.js target: https://flueframework.com/docs/guide/targets/node/
- Cloudflare target: https://flueframework.com/docs/guide/targets/cloudflare/
