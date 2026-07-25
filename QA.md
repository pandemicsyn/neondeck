# Published npm Release QA

Use the npm release QA runner on a persistent Linux host to test Neondeck as a
real npm consumer receives it. The runner does not build or pack the local
checkout.

It resolves a published npm selector, installs that exact release into a fresh
isolated global prefix, runs the installed package's setup command against a
fresh runtime home, validates the generated state, and boots the installed CLI.

## Run the Published `latest` Release

On the QA host:

```sh
cd /home/exedev/neondeck
git pull --ff-only
npm run qa:npm-release
```

The default package selector is `neondeck@latest`.

The current prerelease channel can be tested explicitly:

```sh
npm run qa:npm-release -- neondeck@next
```

A specific published version can also be pinned:

```sh
npm run qa:npm-release -- neondeck@1.0.0-beta.17
```

## What the Runner Proves

For every run, the script:

1. resolves the requested selector with `npm view`;
2. creates a fresh isolated global installation prefix;
3. installs Neondeck globally into that prefix from the npm registry;
4. confirms npm installed the version the registry resolved;
5. runs the installed package's non-interactive `setup` script;
6. verifies the runtime home contains valid config, MCP, repository, dashboard,
   SOUL, SQLite, and local API state;
7. runs the installed CLI's runtime and database status commands;
8. boots `neondeck serve` from the installed package;
9. probes `/api/health`, the compiled dashboard, and runtime status; and
10. verifies the release can load its bundled runtime skills.

No model or GitHub credentials are required. The scheduler is disabled during
the boot probe.

## Results and Artifacts

Runs are retained by default under:

```text
~/.local/state/neondeck-npm-qa/runs/<timestamp>-<pid>/
```

Each run contains:

- the isolated global npm installation;
- the generated Neondeck runtime home;
- CLI runtime and database status JSON;
- the served dashboard HTML;
- API runtime status JSON; and
- the server log.

Retaining failed runs makes package regressions inspectable without rerunning
the release.

## Configuration

```sh
NEONDECK_QA_ROOT=/srv/neondeck/npm-qa \
NEONDECK_QA_PORT=14583 \
npm run qa:npm-release -- neondeck@next
```

Supported environment variables:

- `NEONDECK_QA_PACKAGE`: default package selector when no argument is provided
- `NEONDECK_QA_ROOT`: retained run root
- `NEONDECK_QA_PORT`: local health-probe port, default `13583`
- `NEONDECK_QA_HEALTH_TIMEOUT_SECONDS`: boot timeout, default `20`

The runner requires Node 26 or newer, npm, and curl on `PATH`. It does not
depend on `fnm` or another version manager.

## npm Distribution Tags

`latest` and `next` are independent npm distribution tags. QA should record
which selector and resolved version passed. During prereleases, test `next`
before promotion and test `latest` after promotion.
