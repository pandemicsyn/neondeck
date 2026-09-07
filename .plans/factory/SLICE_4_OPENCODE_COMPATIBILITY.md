# Slice 4 OpenCode compatibility

Verified September 6, 2026: adapter contract 1 targets **OpenCode 1.18.29 only**,
with Linux as the supported production platform. OpenCode is opt-in; Codex
defaults and historical identities are unchanged. This is protocol and synthetic
test evidence, not live factory acceptance.

## Official evidence

- [Release v1.18.29](https://github.com/anomalyco/opencode/releases/tag/v1.18.29)
  and [tagged package dependencies](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/package.json)
  identify the inspected release. The official temporary macOS binary printed
  `1.18.29`; `run --help` confirmed `--format`, `--model`, `--agent`, and `--pure`.
  No system installation, login, provider request, or model run was performed.
- [Tagged run implementation](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/cli/cmd/run.ts)
  reads piped stdin, creates a session when no resume flags are supplied, and
  emits JSONL root-session parts. Local execution uses an in-process HTTP
  application; this adapter does not manage a separate `serve` process.
- [Wire schemas](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/schema/src/v1/session.ts)
  define step, text, tool, cost, and token fields. The parser uses these shapes,
  independently of Codex and Kilo fixtures.
- [CLI documentation](https://opencode.ai/docs/cli/) describes installation-time
  discovery and noninteractive use. PATH non-resolution in one shell is not
  proof of absence on the intended execution host. Target installation and
  readiness remain separately unverified.

## Invocation and isolation

The host launches `run --format json --model <provider>/<model> --agent build --pure`
in its owned worktree and sends the prompt over stdin. There are no prompt or
credential argv values, resume/attach flags, public share flags, or automatic
fallbacks. Every attempt gets a fresh private HOME, XDG data/config/cache/state,
scratch directory and provider session.

[Configuration loading](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/config/config.ts)
and [directory discovery](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/config/paths.ts)
verify `OPENCODE_DISABLE_PROJECT_CONFIG=true` suppresses project JSON config and
project `.opencode` directories. The private global directory supplies no
operator MCP, agents, plugins, or instructions. Inline configuration disables
MCP, LSP, formatters, sharing and updates, and enables exactly the provider in the pinned model prefix.

[Runtime flags](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/effect/runtime-flags.ts)
verify disabling external skills, Claude Code compatibility discovery, default
plugins and LSP downloads.
[Plugin loading](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/plugin/index.ts)
verifies `--pure` excludes external plugins.
[Core flags](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/core/src/flag/flag.ts)
verify disabling model-catalog fetches and automatic updates. The upstream
configuration loader can install its pinned plugin package into the private
configuration directory; real execution may therefore require package-registry
access as well as the selected provider. Neondeck adds no SDK dependency.

[Managed configuration](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/config/managed.ts)
supports the source-verified `OPENCODE_TEST_MANAGED_CONFIG_DIR` override. On Linux
it points into the attempt's private config tree. This version also reads macOS
managed preference plists independently of HOME/XDG with no suppression flag.
Consequently Darwin is unsupported, enforced by the shared host's declarative
platform guard, including mock runs. The internal override is pinned to this
release and must be reverified before expanding support.

Tool permissions default to deny, allowing read/glob/grep and, for the writable
profile, edit/bash. Delegation, interactive questions and external-directory
tools remain denied. These are provider permissions, **not an OS sandbox**;
shell execution can access the host account's resources. Host cancellation,
finite budgets, process death, ownership and workspace evidence stay authoritative.

## Authentication

[Tagged authentication](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/auth/index.ts)
and [global paths](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/core/src/global.ts)
establish `XDG_DATA_HOME/opencode/auth.json`. The adapter accepts one selected API key for `opencode` (OpenCode Zen),
`anthropic`, or `openai`, or strict JSON containing exactly that provider entry
with `{ type: "api", key }`. The selected model prefix binds both the credential
entry and enabled provider; mismatched or multi-provider files are rejected.
It declares `home/.local/share/opencode/auth.json` relative to the attempt for
host-owned private writes, restart redaction and cleanup. Keys are bounded to
16 KiB; JSON input is bounded to 128 KiB. OAuth, additional providers/custom gateways, arbitrary
metadata, inherited environment credentials and well-known auth are unsupported.
Credential structure/presence does not establish authenticated execution.

## Event and terminal contract

The bounded parser validates root session identity, matching part identities,
model-step sequencing and known payloads. Tool failures may lead to another
model turn. `step_finish` with `tool-calls` remains intermediate; only `stop`
maps to provider completion. Other finish reasons map to failure. Root error
events map to failure, including errors before the first step. Child sessions
are not exposed as independent provenance; delegation is disabled.

Unknown informational events never imply success. Missing terminal evidence
remains incomplete. Malformed, truncated, foreign, duplicate or contradictory
evidence poisons the parser. Limits are 1 MiB per line, 64 MiB aggregate, 100,000
events, and 32 nesting levels; the host may impose smaller transport limits.
Provider completion alone does not authorize candidate collection: exit status,
signed host receipt, actual process death and Git evidence remain required.
Restart reconciliation validates signed receipt or heartbeat evidence and
authenticated process-group death. After credential cleanup it records a
conservative `supervisor-lost` or cancellation outcome; missing or uncertain
evidence remains reconciliation attention. It does not replay retained JSONL or
instantiate the adapter parser. The adapter never resumes, replaces, spawns, or
inspects a live provider session.

## Verification and remaining acceptance

Owned tests use `scripts/mock-opencode.mjs`, a synthetic CLI with independent
OpenCode event shapes and fresh random session IDs. They exercise registry
registration, version/model selection, stdin and private credential handoff,
multiple tool/model turns, absent/duplicate/contradictory terminals, foreign or
malformed records, nesting/line bounds and nonzero process exit. The mock also
provides stall, child-process, oversized-output and stderr-flood scenarios for
shared-host lifecycle tests.

Commands (Node 26.4.0 selected with `fnm exec --using 26.4.0`):

```sh
npx vitest run --config vitest.unit.config.ts src/modules/coding-runs/adapters/opencode.test.ts src/modules/coding-runs/adapters/opencode-process.test.ts
npx tsc --noEmit
```

The first command covers adapter/transport conformance only. Linux production
host lifecycle, factory admission/repair routing, cancellation and cleanup matrix
are tracked by the parent integration ledger. They are not established by this
macOS transport fixture. Admission uses an exact-version and executable-identity
check against this manually verified flag contract; it does not run `--help`
each time. Live Linux installation/authentication, model/tool behavior, repairs,
GitHub delivery, cancellation/restart and operator acceptance remain **NOT RUN**.

Implementation checkpoint: **38 tests passed** across the two owned test files;
`tsc --noEmit` passed on the shared tree at this checkpoint. Focused Oxlint and
Prettier checks passed. Subprocess tests ran with execution escalation and only
synthetic credentials. The adapter declares exact literal/private-path/JSON
environment rules, including strict Valibot configuration schemas, through the
shared host contract. Registry wiring and cumulative checks belong to parent
integration and are not claimed complete here.

[Tagged provider loading](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/provider/provider.ts)
verifies native Zen authentication and the API-key loading loop for built-in
providers. [Zen documentation](https://opencode.ai/docs/zen/) confirms API-key
authentication. Provider choice is independent of CLI choice; no OpenAI-only
restriction applies. OAuth remains deferred because default auth plugins are
disabled for isolation and refresh behavior has not been verified. Synthetic
transport tests cover all three supported provider prefixes without contacting
any provider.
