# Factory workers in development

Status: implementation and independent static reviews complete, September 7, 2026.

Operator rehearsal found that `npm run dev` serves the factory dashboard and
planning routes but does not start coding, delivery or GitHub polling workers.
Those loops currently belong only to the production managed-service entry point.
Development should support the same enabled factory workflow.

## Scope and ownership

- Start factory loops after the development Flue runtime becomes available.
- Retain one owner per runtime; retries or hot reload must not duplicate workers.
- Stop owned loops during development runtime shutdown. Production retains its
  existing managed-service ownership and must not start a second set.
- Preserve coding enablement, release, publication and concurrency gates. Starting
  development may process already-authorized queued work, just like production.
- Keep public webhook ingress configuration separate; enabling local workers does
  not expose the private dashboard.

Use an Astra-low implementation subagent and two independent static reviewers,
with manager review before creating this third layer of the current stack. Verify
startup/retry/cleanup ownership with targeted tests and an isolated temporary
runtime. Never run feature-branch startup against the operator's normal database.

The immediate workaround on the current main is to stop development, build the
dashboard/server with `npm run build:dashboard`, and run `npm start`.

## Verification record

- Two independent Astra-low reviewers returned clean after corrections for
  rejected cleanup, partial startup rollback and the public MCP import boundary.
- The manager checked lifecycle ownership and production compatibility against
  installed Flue 2.0.3 loader behavior. Documentation consulted:
  `reference/configuration`, `guide/node-target`, `ecosystem/deploy/node`.
- All 28 targeted lifecycle/startup tests passed, with TypeScript, focused lint,
  import-layer checks, formatting and the production server build.
- An isolated live Vite smoke verified all three workers active, replacement
  instance IDs on hot reload, and stopped worker records after server shutdown.
  It used a temporary runtime and exercised no real model, coding or GitHub work.
- Failed replacement loads keep workers stopped until a successful reload.
  Failed cleanup is retried on subsequent reloads before replacement can start.
  The operator's live development workflow still needs acceptance after upgrade.

## Additional operator finding

The first production coding admission also exposed the 95,000-character frozen
context cap. Current assembly includes every active non-built-in runtime skill and
its supporting files, serializes binary resources as base64, and injects that JSON
into the prompt. This is an application snapshot limit rather than a model token
limit. A follow-up should select task-relevant skills, separate retained artifacts
from prompt content, and expose a pre-release size breakdown and recovery path.
Context-budget redesign remains open and is not part of worker lifecycle wiring.
