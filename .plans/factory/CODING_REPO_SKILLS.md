# Coding skills belong to the repository

Status: source complete; two independent static reviews clean, September 7, 2026.

The first operator coding rehearsal failed because the frozen context included
Neon's entire active global skill library and supporting files. A focused task
should not inherit unrelated runtime guidance.

## Policy and ownership

- Coding CLIs own native repository skill discovery in their managed worktree.
- New factory contexts do not read or serialize Neon's global runtime skills.
- Factory-specific skill injection must be an explicit exception. None is needed
  today; existing factory execution instructions remain in the handoff prompt.
- Neon's planning and chat skill selection remain unchanged.
- Keep the 95,000-character snapshot cap and Valibot/integrity checks. This cap is
  an application snapshot limit, not the provider's model context window.
- Historical admitted attempts keep their original frozen payloads and legacy
  discovery behavior. Bind native discovery into new release configuration and
  manifests; old authority must require a fresh release before changing behavior.
  Repairs must retain admitted policy or stop for fresh authorization.
- Preserve private CLI homes, credentials, noninteractive operation, and human
  release/publication gates. Native skill discovery is not an OS sandbox.

## Delivery and verification

Use Astra-low implementation agents and two independent static reviewers before
publishing another layer in the existing GitHub stack. The manager reviews scope,
adapter behavior and historical compatibility. Regress a tiny task with an
oversized unrelated global skill library, retain repository instructions and
briefs, and check historical snapshot integrity. Use isolated temporary runtimes.

An offline Codex 0.150.1 `debug prompt-input` probe confirmed native repository
`.codex/skills` and `.agents/skills` discovery with existing ignore flags. Pinned Kilo 7.4.23 and OpenCode 1.18.29 need fixed repository skill
roots supplied through managed configuration while project configuration and
external discovery stay disabled. Their native skill tools need explicit read
permission. Their actual managed launch environments passed offline `debug skill
--pure` probes for all configured roots, including `.claude/skills` and internal
skill-directory symlinks. These were credential-free discovery probes, not model
turns. Kilo/OpenCode production admission remains Linux-only; local macOS probes
do not establish Linux lifecycle acceptance.

Primary source references:

- [Codex 0.150.1 skill loader](https://github.com/openai/codex/tree/rust-v0.150.1/codex-rs/ext/skills/src/loader)
- [Pinned Kilo skill discovery](https://github.com/Kilo-Org/kilocode/blob/40fa10e50a75c4887978d892520d1246515413bf/packages/opencode/src/skill/index.ts)
- [OpenCode 1.18.29 skill discovery](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/skill/index.ts)

The host does not implement skill parsing or recursively validate supporting
files. Native scanners can follow repository symlinks outside the worktree. This
behavior remains part of trusting repository content;
private HOME/config isolation is not a filesystem sandbox. Existing workspace and
permission checks remain. This scope adds no general repository file validator.

Verification record:

- Two independent Astra-low reviewers cleared context assembly, historical policy
  compatibility, adapter discovery, release fingerprints, UI and final fixture fixes.
- 150 focused adapter checks, 133 factory/API/UI checks, and 6 route-lock checks passed.
- Three mock coding integration cases passed: pinned launch, historical inspection,
  and candidate collection. Dashboard/server build and synthetic desktop/mobile
  release-policy visual checks passed.
- Broad unit verification found one fixture using the old raw config fingerprint;
  its helper now uses the effective policy while preserving write-error assertions.
- Full `npm run verify` is running; its final result remains to be recorded.
  Live operator acceptance remains pending after upgrade. A broader token-budget
  redesign, retained artifact transport, and pre-release size diagnostics are
  separate follow-ups; removing global skill injection does not solve every possible
  oversized repository instruction or memory payload.
