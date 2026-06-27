# Flue Docs Map

This reference summarizes Flue features and where to verify details. It was created from the public Flue quickstart and guide pages, including `https://flueframework.com/docs/getting-started/quickstart/index.md`.

Flue is still evolving. Use this file to find the right docs page and conceptual fit. Before implementing, verify concrete function names, imports, route shapes, config keys, and CLI flags against the installed `@flue/*` packages or current upstream docs.

## Quickstart

Docs:

- https://flueframework.com/docs/getting-started/quickstart/
- https://flueframework.com/docs/getting-started/quickstart/index.md

Key points:

- Flue is a TypeScript framework for building AI agents that can run locally, on Node.js servers, in CI, on Cloudflare, and other targets.
- Requirements include Node.js `>=22.19.0`, at least one model specifier, and provider credentials unless using a provider/target that does not need an API key.
- The quickstart shows installing the runtime and CLI packages, initializing a target, creating an agent module, and running it locally.
- A default export from an agent module registers the agent; the filename becomes the Flue resource name.
- The quickstart shows local execution through the Flue CLI with JSON input.
- Add `.env` to `.gitignore`; provider credentials should not be committed.

## Project Layout

Docs: https://flueframework.com/docs/guide/project-layout/

- Flue discovers application entrypoints from one source layout. The project-layout docs describe source directory precedence and discovery rules.
- New projects should normally use `src/`.
- The docs describe optional application, persistence, and Cloudflare-specific entrypoints. Verify current filenames and exports before implementation.
- Agents, workflows, and channels are discovered from source-layout directories. Verify current nesting and naming rules in the docs.

## Agents

Docs: https://flueframework.com/docs/guide/building-agents/

- Use agents for continuing, addressable sessions with persistent history.
- The docs show the current agent definition helper, HTTP exposure model, event dispatch model, and how agent IDs can scope resources.
- Agent profiles and subagents can share common model/instruction/tool configuration.

## Workflows

Docs: https://flueframework.com/docs/guide/workflows/

- Use workflows for finite, bounded jobs that return results and create run records.
- The docs show the current workflow definition helper, CLI invocation pattern, application invocation helper, and HTTP/run exposure exports.
- Workflow invocation admits a run and returns run identity; inspect the docs for current waiting/result options.
- Run data can contain sensitive model activity, inputs, and outputs.

## Actions

Docs: https://flueframework.com/docs/guide/actions/

- Bind actions to workflows to avoid repeating schema and handler code.
- Give actions to agents when the model should call deterministic framework-managed tools.
- Actions own their input/output schemas and handler.
- Prefer inline workflow logic when the behavior is only used by one workflow.

## Skills

Docs: https://flueframework.com/docs/guide/skills/

- Use Flue skills to give agents procedural knowledge, conventions, and prompt guidance.
- Flue supports importing skill packages into agent configuration and discovering Agent Skills-compatible directories inside the harness sandbox.
- Use skills for knowledge and procedures; use actions for deterministic executable capabilities.

## Schedules

Docs: https://flueframework.com/docs/guide/schedules/

- Flue supports scheduled work by integrating with the scheduler provided by the deployment environment.
- Model bounded scheduled work as workflows; every occurrence should get independent run identity, events, and history.
- Send scheduled events to a continuing agent when repeated occurrences should share one persistent session.
- Flue does not prescribe a scheduling library.
- Cloudflare: use Worker scheduling primitives and the Cloudflare Flue entrypoint described in the docs.
- Node.js: Node has no built-in cron scheduler. Use a library such as Croner for simple in-process schedules, or a persistent scheduler such as BullMQ for schedules that must survive restarts or coordinate across replicas.

## Routing

Docs: https://flueframework.com/docs/guide/routing/

- Add an application entrypoint when the app needs auth, custom routes, route prefixes, health endpoints, or custom event ingress alongside Flue.
- The routing docs show how to mount Flue into a Hono app and how prefixes affect SDK `baseUrl`.
- SDK clients must include the mount path in `baseUrl`.
- Custom webhooks should belong to application code, validate/normalize the provider event, then deliver it to the appropriate Flue resource using the current event/workflow API.

## Database

Docs: https://flueframework.com/docs/guide/database/

- Flue stores agent session history, accepted direct prompts, accepted `dispatch(...)` submissions, workflow-run records, workflow events, and run indexing.
- Node.js persistence is explicit through source-root `db.ts`.
- The Node database docs currently describe a SQLite adapter for local or single-host persistence. Verify the current import and adapter API before editing.
- Without `db.ts`, Node uses in-memory SQLite and loses sessions/run records on process exit.
- Cloudflare uses generated Durable Object SQLite automatically and does not use `db.ts`.
- The database does not store provider credentials, model request/response payloads as durable conversation transcript beyond framework state, or external API side effects.

## React

Docs: https://flueframework.com/docs/guide/react/

- `@flue/react` provides React helpers for live agent conversations and workflow runs.
- HTTP requests, auth, and stream transport are configured through `@flue/sdk`; verify current provider/hook/client names before implementing.
- Browser-only relative `baseUrl` values like `/api/flue` are valid in the client; server rendering needs an absolute URL.

## Node.js Target

Docs: https://flueframework.com/docs/guide/targets/node/

- Builds Flue resources as a standard Node.js server.
- Generated server owns HTTP, agent dispatch, workflow admission, and event streaming routes.
- Node target can use a local sandbox for host filesystem and shell access; verify the current sandbox API before enabling it.
- With durable DB adapter, direct prompts and dispatch inputs enter SQL-backed per-instance queues.
- Node does not have Cloudflare Durable Object wake/recovery semantics.

## Cloudflare Target

Docs: https://flueframework.com/docs/guide/targets/cloudflare/

- Builds agents and workflows for Cloudflare Durable Objects and Workers.
- Generated Durable Objects provide persistent state, durable execution, and global addressability.
- `wrangler.jsonc` needs `nodejs_compat` and Durable Object migrations including `FlueRegistry`.
- Cloudflare Workers AI models can be used with `cloudflare/...` model names without provider API keys.
- The Cloudflare target docs describe extension hooks for Durable Object capabilities and a Cloudflare-specific entrypoint for Worker-level handlers such as cron triggers, queues, or inbound email.
