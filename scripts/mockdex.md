# mockdex: test-only Codex exec fixture

`mockdex.mjs` is an executable subprocess fixture for factory slice 2 tests.
Select it explicitly by absolute executable path in a test harness. Never install
it as `codex`, add a production default, or use it as a fallback when real Codex is
missing. It does not load Codex config, credentials, providers, hooks or prompts
as executable instructions. It never starts Codex, GitHub, SSH or shell commands.
It is omitted from the package's existing `files` allowlist.

Use Node 26.4.0. From the repository root, with a fresh temporary cwd:

```sh
printf 'fixture prompt' | MOCKDEX_SCENARIO=success node scripts/mockdex.mjs exec --json -C /absolute/test/cwd -
node node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts scripts/mockdex.test.ts
```

Tests use real child processes and temporary directories, with an allowlisted
fixture environment containing only `MOCKDEX_SCENARIO`. They need no provider
secrets. The server test requires permission to bind loopback. It runs on POSIX
and is explicitly skipped on Windows, where negative-PID process groups differ.

## Input contract

Requires `exec --json` and an explicitly valid `MOCKDEX_SCENARIO`. There is no
default scenario. A prompt can be one argument, `-` for stdin, or omitted for
stdin. Positional prompts may accompany stdin. Input is validated but never
executed, echoed or persisted. Positional prompt and stdin each have a 64 KiB
limit; piped stdin must reach EOF within two seconds, including with a positional
prompt. An empty combined prompt fails. `--` ends option parsing.

`-C`/`--cd` selects an existing directory (default: process cwd). Success creates
`mockdex-result.txt` with exactly `mockdex deterministic test change\n`. Reuse a
fresh directory for each success. Existing files, symlinks and hardlinks are
refused using exclusive creation. Optional `-o`/`--output-last-message` creates a
new leaf filename directly within cwd, containing `mockdex test fixture
completed.\n`; paths, `.`/`..`, and the reserved result filename are refused.
All filesystem writes stay in the selected cwd. A failure writing the optional
last-message file can leave the already-created result file. This is a fixture
for a harness-controlled directory, not an isolation boundary against concurrent
hostile directory renames.

Accepted inert switches: `--ephemeral`, `--skip-git-repo-check`,
`--ignore-user-config`, `--ignore-rules`, `--strict-config`, `--full-auto`,
`--approve-for-me`, `--dangerously-bypass-approvals-and-sandbox`.
Accepted inert value flags: `-m`/`--model`, `-s`/`--sandbox`, `-c`/`--config`,
`-p`/`--profile`, `--color`, `--enable`, `--disable`, `--thread-source`.
Sandbox/color enums and config `key=value` syntax are validated. Long value flags
support `--flag=value`; short attached values are unsupported. Inert flags never
change fixture authority or invoke a provider. This is a deliberately limited
parser, not full Codex emulation: unknown flags, image/schema inputs, additional
writable directories and resume/fork/review subcommands fail closed. Standalone
`--help`/`-h` prints test-only usage. Standalone `--version` prints exactly
`mockdex codex-contract 0.150.1` followed by a newline and exits zero, without
requiring a scenario or prompt. The host may accept this readiness marker only
when an explicit mock scenario is configured; it is not a real Codex version.

## Scenarios and outputs

All valid scenarios begin with `thread.started` (fixed synthetic UUID) and
`turn.started`. Output uses newline-delimited JSON except the malformed fixture.

| Scenario           | Behavior                                                                                                               | Exit                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `success`          | Creates deterministic file; completed file-change and agent-message items; `turn.completed` with synthetic token usage | 0                                   |
| `failure`          | Emits `turn.failed` with `{ error: { message } }`; no writes                                                           | 1                                   |
| `malformed`        | Emits `{not-json}` after valid start events; no terminal event                                                         | 0                                   |
| `oversized`        | Emits one valid agent-message JSONL item containing exactly 2 MiB of `x`; no terminal event                            | 0                                   |
| `stall`            | Emits starts, then waits for cancellation                                                                              | 124 after 30 seconds if uncancelled |
| `child-dev-server` | Spawns a native Node HTTP server on `127.0.0.1:0`, emits an in-progress command item, then waits                       | 124 after 30 seconds if uncancelled |

Invalid inputs/setup emit `turn.failed` and exit 2 without fabricating completion.
Malformed/oversized scenarios intentionally exit zero: a consumer must validate
protocol completion and bounded output rather than trusting exit status alone.
The fixture is not configurable to allocate unbounded output.

For `child-dev-server`, `item.started.item.aggregated_output` is a JSON string
`{"pid":123,"port":456}` with actual validated readiness data. The child inherits
the parent's process group, has an empty environment and serves a fixed response.
Spawn the fixture with `detached: true` on POSIX, wait for readiness, then signal
`-parentPid` to cancel the entire group. The fixture intentionally does not forward
parent signals, so killing only the parent leaves the child listening until its
30-second escape hatch. Each test harness must arrange unconditional group cleanup
and a deadline. Child startup is bounded at two seconds; no terminal success event
is emitted for this scenario. Tests prove the endpoint responds before cancellation
and becomes unreachable afterward, and the parent closes with SIGKILL.

## Contract provenance and handoff

Inspected the installed `codex exec --help` locally (help only, no model run) and
[official non-interactive JSONL documentation](https://learn.chatgpt.com/docs/non-interactive-mode).
The documented event names and shapes guide these fixtures; fixed IDs, token
counts, file contents and child readiness payload are intentionally synthetic.
No live-provider compatibility claim is made.

Owned files: `scripts/mockdex.mjs`, `scripts/mockdex.test.ts`, `scripts/mockdex.md`.
No production configuration, dependency, package script or changeset is required.
Manager integration should wire the executable only through explicit test
injection. Two clean static reviews and manager approval remain a prerequisite
before any PR; fixture test success does not constitute those approvals.
