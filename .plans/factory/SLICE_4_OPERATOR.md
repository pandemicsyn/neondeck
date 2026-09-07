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
repairs; replacing the binary blocks the attempt even if its version text matches.

Historical attempts without a captured executable identity can still be inspected
and reconciled. Starting a new repair pauses for a fresh human release through
the existing planning/release/consent flow. This does not permit replacement of
uncertain compute, erase retained work or reset an existing grant's consumed
budget. Corrected credential references are rechecked; invalid credential
failures are not cached.

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
