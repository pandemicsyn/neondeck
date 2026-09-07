# Slice 4 operator guidance

Implementation published in stack #410: draft [#406](https://github.com/pandemicsyn/neondeck/pull/406) → [#407](https://github.com/pandemicsyn/neondeck/pull/407) → [#408](https://github.com/pandemicsyn/neondeck/pull/408) → [#409](https://github.com/pandemicsyn/neondeck/pull/409). Published-source CI passed at the September 6 checkpoint in the [handoff](SLICE_4_HANDOFF.md); follow-up documentation CI remains specific to its PR head. Live acceptance is **NOT RUN**; compatibility limits remain explicit.

The Local coding setup selects a registered coding CLI: Codex by default,
OpenCode or Kilo by explicit choice. Configure the executable and model in the
private local setup. Credentials use an environment-variable reference only;
never enter a credential value in the dashboard. Version/help compatibility and
authentication readiness are separate facts.

Saving a selection does not itself execute code or publish a PR. Enabling
automatic coding permits eligible human-released briefs to dispatch. Review the
exact brief and selected harness before releasing. Admission pins the CLI,
version, model and configuration; later settings changes cannot change an
existing grant or running attempt. Repairs retain pinned authority and cumulative
budgets, with a fresh private home and session per attempt. The originally
admitted executable identity is checked before any version probe and carried into
repairs; a mismatch observed at an identity checkpoint blocks the attempt even if
version text matches. These checks do not guarantee immutable executed bytes.

Historical attempts without a captured executable identity can still be inspected
and reconciled. Starting a new repair pauses for a fresh human release through
the existing planning/release/consent flow. This does not permit replacement of
uncertain compute, erase retained work or reset an existing grant's consumed
budget. Corrected credential references are rechecked; invalid credential
failures are not cached.

The latest foundation correction is implemented with source held and both
independent source reviews CLEAN, including the FIFO correction. Verified tests
and their scope are recorded in the handoff; new exact-head CI remains pending.
It requires a SHA-256 digest of the configured entrypoint file for
new preparation, launch and repair. Existing stat-only records remain readable
and reconcilable, but new execution or repair pauses for fresh human release;
today's binary is not repinned into historical authority. Descriptor-based hashing
uses a 1 MiB buffer, a 512 MiB file bound, a 10-second limit and pre/post stat
checks. Nonblocking open precedes regular-file validation, avoiding a hang on a
FIFO with no writer. Digest comparisons detect entrypoint byte mismatches observed
at checkpoints, not changes throughout transitive
packages, and does not establish filesystem isolation or an OS sandbox.

The hash descriptor closes before pathname-based spawn, leaving a check-to-spawn
race. The original hash remains pinned between runs, but cancellation gates do
not protect filesystem contents. Keep the trusted CLI installation, interpreter
and dependencies stable throughout each attempt. Pause admission and stop active
writers before updating them.

The manager accepted deferring atomic binding within the user's explicitly naive,
trusted localhost scope; the race is not fixed, and this does not represent the
user personally accepting a new risk. Portable copying or descriptor execution
does not by itself preserve CLI wrapper, interpreter and package-asset behavior.
The follow-up is opt-in immutable execution artifacts preserving that layout with
host write protection; moving to a remote VM alone does not resolve it. See the
[tracked review thread](https://github.com/pandemicsyn/neondeck/pull/406#discussion_r3946295354)
and [deviations ledger](../DEVIATIONS.md#2026-09-06---slice-4-executable-check-to-spawn-race).

The accompanying public factory run harness projection is limited to provider,
version and model; resolved canonical path, device/inode and digest are excluded.
The configured executable remains visible in the authorized private operator
release configuration. See the [handoff](SLICE_4_HANDOFF.md) for current review
and CI checkpoints.

Use the existing stop control to request cancellation. Ownership remains held
until the process and its children are confirmed dead. An uncertain run requires
reconciliation, never replacement or fallback to another CLI. Preserve retained
work, candidate evidence and cleanup attention. Review independent checks,
progress decisions and human scope interventions through the existing evidence
and planning surfaces. Provider completion alone does not establish acceptance.

Draft publication requires its existing explicit authority. Human merge and
existing retention/cleanup rules remain in force. No remote execution, managed
coding server, conversation resumption or automatic provider switching is added.

## Compatibility evidence and limits

[OpenCode 1.18.29](SLICE_4_OPENCODE_COMPATIBILITY.md) was verified using a
temporary official binary's version/help and tagged source, without a system
installation or provider request. It accepts a selected native `opencode`
(OpenCode Zen), `anthropic` or `openai` API key. Model prefix, enabled provider
and private credential entry must agree. Additional providers, custom gateways
and OAuth are unsupported.

[Kilo 7.4.23](SLICE_4_KILO_COMPATIBILITY.md) accepts native Kilo Gateway API keys
only, with a `kilo/` model prefix. It has no OpenAI credential dependency. Both
adapters accept the selected API-key reference or a strict single-provider API
auth-JSON reference, never credential values entered in the dashboard. Structural
credential validity does not prove live authentication or model availability.
Both providers require exactly one private authentication snapshot at supervisor
startup; this correction has passed focused tests and both independent reviews.

Kilo Code 7.4.23 is locally verified by read-only native `--version` and
`run --help` inspection. An older 7.1.20 installation also exists; this does not
make it a supported factory baseline. Installation is distinct from admission
readiness. The intended Linux execution host's Kilo availability and all live
auth/model execution remain unverified.

OpenCode and Kilo currently fail closed on Darwin because managed operating-system
preferences outside HOME/XDG have not been isolated by a verified mechanism.
Initial optional-adapter admission targets Linux. Codex support is unchanged.
See [the deviations ledger](../DEVIATIONS.md) for the reason and follow-up.

Kilo's inspected project configuration autoload can affect MCP, modes and rules
despite its project-config disable setting. Adapter-declared workspace guards
reject incompatible configuration before preparation and launch, without deleting
repository files. The 7.4.23 adapter rejects 24 exact autoload paths:

- Under each of `.kilo/` and `.kilocode/`: `mcp.json`, `workflows`, `rules`,
  `rules-code`, `rules-architect`, `rules-ask`, `rules-debug`, `rules-orchestrator`.
- At the workspace root: `.kilocodemodes`, `.kilocodeignore`, `.kilocoderules`,
  `.kilocoderules-code`, `.kilocoderules-architect`, `.kilocoderules-ask`,
  `.kilocoderules-debug`, `.kilocoderules-orchestrator`.

Harmless `.kilo/skills` is permitted. These are absence checks, including dangling
links, not whole-directory bans. The [adapter declaration](../../src/modules/coding-runs/adapters/kilo.ts)
is authoritative for this version. A globally ready CLI still
needs workspace admission checks and has no implied OS sandbox.
