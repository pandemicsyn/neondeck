# Development

This file is for people working inside this repository. The root
[`README.md`](./README.md) is the high-level landing page; the public docs site
under `docs/` carries the detailed user-facing guides.

## Requirements

- Node 26.4.0 or newer
- A KiloCode, OpenAI, or Anthropic API key for the configured Flue model
  provider
- A GitHub token for GitHub-backed panels and workflows

Use any Node installer or version manager. With `fnm`, that looks like:

```sh
fnm install 26.4.0
fnm use 26.4.0
```

Then install dependencies:

```sh
npm install
```

## First Run

Run the guided setup wizard:

```sh
npm run init
```

The wizard prepares the runtime home, writes local secrets to
`$NEONDECK_HOME/.env`, tunes `SOUL.md`, configures the selected model provider,
optionally sets a low-cost utility model, adds local git checkouts, applies a
dashboard preset, and can create command preapprovals.

The CLI is also the base for direct command-and-control surfaces:

```sh
npm run cli -- status
npm run cli -- doctor
npm run cli -- db status
npm run cli -- repo add ~/dev/neondeck
npm run cli -- watch-pr pandemicsyn/neondeck#123
npm run cli -- tui
```

## Runtime Home And Secrets

Packaged/local app secrets live in the runtime home:

```text
$NEONDECK_HOME/.env
```

For checkout-based development, repo-root `.env` is also supported as a
dev-only fallback when the runtime-home file does not define a value.

```sh
KILOCODE_API_KEY=...
KILOCODE_ORGANIZATION_ID=...
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GITHUB_TOKEN=...
GITHUB_LOGIN=...
```

Neondeck resolves runtime home in this order:

```text
NEONDECK_HOME
XDG_CONFIG_HOME/neondeck
~/.config/neondeck
```

The runtime home contains `.env`, `config.json`, `mcp.json`, `repos.json`,
`dashboard.json`, `SOUL.md`, `skills/`, and separate
`data/neondeck.db` and `data/flue.db` databases. Neondeck app database
migrations are shipped with the package and auto-apply before app code touches
`data/neondeck.db`; pre-migration backups are kept under `data/backups/`.

Initialize or validate the runtime home explicitly without starting the server:

```sh
npm run setup
npm run setup -- --home ./data/dev-home
```

For new installs, prefer `npm run init`; `npm run setup` is the lower-level
non-interactive initializer.

## Local Development

```sh
npm run dev
```

Open `http://127.0.0.1:5173/`.

The dev command runs the Flue/Hono backend and Vite dashboard together. Runtime
home, repository, MCP server/approval, scheduler, and skill state are visible in
the Runtime Overview panel.

Neon command workflows can be run from dashboard controls, typed into chat, or
invoked through Flue:

```sh
curl -X POST 'http://127.0.0.1:5173/api/flue/workflows/command-run?wait=result' \
  -H 'Content-Type: application/json' \
  -d '{"input":{"command":"/briefing"}}'
```

Common commands include `/repo-status`, `/review-queue`, `/review-pr <ref>`,
`/fix-ci [ref]`, `/explain-ci [--report] [ref]`, `/summarize-pr [ref]`,
`/draft-pr-description [repo]`, `/prepare-pr [repo]`, `/review-local [repo]`,
`/briefing`, `/reasoning [level]`, `/memory ...`, `/dev-doctor`,
`/watch-pr <ref>`.

## CLI Surface

From a source checkout, use `npm run cli -- <command>`. After package install,
use `neondeck <command>`.

Available top-level commands:

```sh
npm run cli -- init
npm run cli -- dev
npm run cli -- serve
npm run cli -- open [profile]
npm run cli -- service status
npm run cli -- status
npm run cli -- repo list
npm run cli -- mcp list
npm run cli -- db status
npm run cli -- learning status
npm run cli -- watch-pr <repo#number>
npm run cli -- note "message"
npm run cli -- register-pr <repo#number>
npm run cli -- doctor
npm run cli -- tui
```

The `tui` command exists as the future OpenTUI entrypoint.

## Checks

Fast loop:

```sh
npm run check
```

Individual checks:

```sh
npm run lint
npm run typecheck
npm run test
npm run test:git
npm run test:integration
npm run test:all
npm run format:check
npm run db:check
```

Full verification:

```sh
npm run verify
```

`npm run check` is the fast local loop: lint, import-layer check, database
migration check, typecheck, and the unit Vitest suite. The slower
serial Git/performance/docs-drift group lives under `npm run test:git`; the
workflow-heavy worktree/Kilo/autopilot group lives under
`npm run test:integration`. `npm run test:all` runs every Vitest suite.
`npm run verify` keeps the full pre-release path: lint, import-layer check,
database migration check, typecheck, all tests, production builds, npm package
smoke checks, and format check.

## Database Migrations

Use Drizzle migrations for Neondeck app state:

```sh
npm run db:generate -- --name <migration_name>
npm run db:check
```

Keep Neondeck app state separate from Flue runtime state unless the roadmap says
otherwise.

## Build And Package

```sh
npm run typecheck
npm run build
npm start
```

Production app release helpers:

```sh
npm run release:app
npm run release:npm:check
```

After a production build or package install:

```sh
neondeck service install
neondeck open
neondeck open sidebar
```

`neondeck service install` creates a macOS launchd agent or Linux systemd user
unit with absolute Node and built server entry paths and logs under
runtime-home `data/logs/server.log`. `neondeck open` probes `/api/health`,
starts the installed service when present, falls back to a detached built server
process when no service exists, and opens a dedicated browser app window when a
supported Chromium browser is available.

`neondeck serve` and the login service run the built Flue server entry from
`dist/server.mjs`; from a source checkout, use `npm run dev` for the fast loop
or run `npm run build:server` before testing the packaged path.

## Marketing And Docs Site

The Astro site lives under `docs/` and deploys to Cloudflare for
`neondeck.dev`.

```sh
npm run docs:astro-dev  # hot Astro dev server
npm run docs:dev        # build, then preview
npm run docs:build
npm run docs:preview
npm run docs:deploy
```

The Cloudflare deployment config is `docs/wrangler.jsonc`.

## Publishing

User-facing pull requests should include a concise Changeset:

```sh
npm run changeset
```

Use `patch` for fixes, `minor` for features, and `major` for breaking changes.
The private docs workspace is excluded from package versioning. The committed
Changesets prerelease state keeps versions on the beta channel. After changesets
reach `main`, `.github/workflows/changesets.yml` creates or updates a version PR
containing the package version, changelog, and Changesets release bookkeeping.
The exact file set depends on release mode: a prerelease update may retain the
individual Changeset files and update `.changeset/pre.json`, while a stable
version may consume Changesets or update lockfile metadata.

Merge the version PR, pull `main`, then tag and push the exact package version:

```sh
git switch main
git pull --ff-only
version="$(node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).version")"
git tag -a "v${version}" -m "neondeck v${version}"
git push origin "v${version}"
```

Prerelease tags such as `v1.0.0-beta.1` publish to npm's `next` dist-tag.
Stable tags publish to `latest`. Before creating a tag, the workflow can validate
a branch or commit without publishing:

```sh
gh workflow run npm-publish.yml \
  -f release_ref=main \
  -f npm_tag=auto \
  -f dry_run=true
```

The npm release path is separate from the GitHub app archive release:

- `.github/workflows/npm-package.yml` validates the packed npm artifact on PRs.
- `.github/workflows/changesets.yml` maintains the version PR from changesets
  merged to `main`.
- `.github/workflows/npm-publish.yml` verifies the release tag, runs
  `npm run release:npm:check`, and publishes `neondeck` to npm from `v*` tags.

npm publishing uses trusted publishing for GitHub Actions with workflow
`npm-publish.yml`, environment `npm`, and allowed action `npm publish`. Do not
add a long-lived npm publish token.

## Deeper Runtime Docs

The detailed runtime and configuration material belongs in the docs site:

- `docs/src/pages/docs/getting-started.astro`
- `docs/src/pages/docs/configuration.astro`
- `docs/src/pages/docs/agent-runtime.astro`
- `docs/src/pages/docs/execution.astro`
- `docs/src/pages/docs/mcp.astro`
- `docs/src/pages/docs/memory-learning.astro`
- `docs/src/pages/docs/deployment.astro`
- `docs/src/pages/docs/contributing.astro`

Update those pages when changing user-facing runtime behavior.
