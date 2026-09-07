# Slice 4 — Pluggable local coding CLIs: OpenCode and Kilo Code

Status: **SOURCE AND RECORDED DETERMINISTIC VERIFICATION COMPLETE**, September 6, 2026. Both independent source/docs reviews are clean; published stack #410: draft [#406](https://github.com/pandemicsyn/neondeck/pull/406) → [#407](https://github.com/pandemicsyn/neondeck/pull/407) → [#408](https://github.com/pandemicsyn/neondeck/pull/408) → [#409](https://github.com/pandemicsyn/neondeck/pull/409). All nine checks passed on each exact published source head at the September 6 checkpoint in the handoff; later documentation commits have separate CI. Slice 4 live acceptance: **NOT RUN**. See [handoff](SLICE_4_HANDOFF.md) for ownership, verification and review evidence.

Slice 3.1 merged on September 6, 2026, in PRs [#403](https://github.com/pandemicsyn/neondeck/pull/403) and [#404](https://github.com/pandemicsyn/neondeck/pull/404), through source head `00c3e3e565a63ebc24411eabdf34f23d94efe6ef`. The manager verified the merge against GitHub and the main tree. Slice 3.1 real model/Codex/GitHub acceptance remains **NOT RUN**.

## Direction and sequencing

Expand Slice 4 from OpenCode alone to **both OpenCode and Kilo Code as first-class, explicitly selectable factory coding adapters**. Codex remains the default. Preserve the same human-released brief, durable coding-run host, independent checks, candidate review, progress checkpoint and guarded draft publication for all three harnesses. Adding another CLI should be a small adapter integration, not a rewrite of the factory.

Read the [roadmap](../ROADMAP.md), [Slice 1 plan](SLICE_1_IMPLEMENTATION_PLAN.md) and [handoff](SLICE_1_HANDOFF.md), [Slice 2 plan](SLICE_2_IMPLEMENTATION_PLAN.md), [Slice 3 plan](SLICE_3_IMPLEMENTATION_PLAN.md) and [handoff](SLICE_3_HANDOFF.md), and [Slice 3.1 plan](SLICE_3_1_PROGRESS_REVIEW_PLAN.md) and [handoff](SLICE_3_1_HANDOFF.md). Product context also comes from the repository README, SOUL and [Hermes research](../research/HERMES_RESEARCH.md).

Recommend a combined Slice 2/3/3.1 live exercise before feature expansion: real Codex admission and candidate collection, independent verification, bounded judged repair, authorized draft delivery, watched feedback and human outcome. This is a sequencing recommendation, **not a new merge gate**. Slice 1's operator-accepted deferrals and Slice 2/3/3.1's pending live obligations remain pending, not failed or passed by this plan. Synthetic verification cannot establish real model judgment quality.

Slice 5 remains Linear intake. Slice 6 remains remote execution. This slice introduces no new workflow engine, coding agent, managed server, SDK/ACP transport, remote provisioning or dynamic third-party plugin platform.

## Current evidence and compatibility discovery

Compatibility discovery now has version-pinned local evidence:

- **Kilo 7.4.23:** installed native binary version and `run --help` verified;
  tagged source inspected at `40fa10e50a75c4887978d892520d1246515413bf`.
  The separately discovered 7.1.20 installation is outside the supported contract.
- **OpenCode 1.18.29:** temporary official binary version and `run --help`
  verified against tagged source. No system installation or provider call was made.
- **Codex:** support remains `codex-cli 0.150.1`; the read-only intended-host
  probe found 0.144.6, which does not establish compatible admission.

See the [OpenCode compatibility record](SLICE_4_OPENCODE_COMPATIBILITY.md) and
[Kilo compatibility record](SLICE_4_KILO_COMPATIBILITY.md) for invocation,
permissions, private state, output/session semantics, source references and
synthetic verification. OpenCode supports selected native `opencode` (Zen),
`anthropic` and `openai` API keys. Kilo supports native Kilo Gateway API keys only.
Both optional adapters initially support Linux; Darwin fails closed on unisolated
managed preference loading. Kilo additionally requires absence of 24 exact legacy
autoload paths; harmless `.kilo/skills` remains permitted.

Target Linux optional-CLI availability and live authentication/model execution
remain unverified. Earlier PATH/common-location misses do not establish missing
installations. Local help/source checks and synthetic tests are completed
categories of evidence, not live factory acceptance. The Linux host 49/49 and factory 6/6 runs passed on corrected source; final
source reviews are clean, with documentation/publication obligations tracked in
[the handoff](SLICE_4_HANDOFF.md); final totals are recorded in the handoff.

Readiness must distinguish disabled, unconfigured, executable unresolved on the selected host, unsupported version/capability, authentication unverified or unavailable, and ready under a verified contract. Version/help inspection is not proof of authenticated execution. An incompatible provider remains unavailable with an actionable reason; never compensate by silently removing isolation or changing providers.

## Inspected seams: reuse, adapt and retain

The following observations come from source inspection, not execution:

| Existing seam                                                                                                           | Planned treatment                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/coding-runs.ts` and `src/modules/coding-runs/schemas.ts`, store and queries                                     | Reuse durable run/attempt identities, immutable snapshots, ownership/version guards, session identity, dead proof and candidate evidence. The shared snapshot already carries provider/version/model and fresh-session mode. Add only necessary typed adapter identity/capability data.                                                                                           |
| `src/modules/coding-runs/host-contract.ts`                                                                              | Separate common host limits/workspace/receipts from provider configuration. Current preparation/auth, sandbox fields and version-1 manifests have Codex assumptions. Use explicit versioned decoding so old manifests and receipts remain inspectable.                                                                                                                            |
| `local-host.ts`, `local-supervisor.ts`, `local-anchor.ts`, `host-output.ts`                                             | Reuse private preparation, permanent launch claim, authenticated anchor/process group, watchdog, signed receipts, bounded output and cancellation gates. Replace direct Codex readiness/auth/argument/environment/parser dependencies through the small adapter registry. Do not duplicate the supervisor per CLI.                                                                |
| `host-process.ts`, `host-workspace.ts`, `host-launch-gate.ts`, collection and reconciliation helpers                    | Retain host ownership, canonical path checks, launch fencing, actual process-death verification and evidence collection. Provider reconciliation supplies facts; it cannot release ownership or restart a writer.                                                                                                                                                                 |
| `codex-adapter.ts`, `codex-readiness.ts`, `codex-auth.ts`                                                               | Fit Codex to the same adapter contract first while preserving its existing behavior, redaction and credential cleanup. Keep provider-specific authentication parsing within the adapter boundary.                                                                                                                                                                                 |
| `shared/factory-coding.ts`; factory `coding-readiness.ts`, `coding-context.ts`, `coding-service.ts`, `coding-handle.ts` | Adapt currently Codex-oriented config/readiness, snapshot construction and `local-codex` host identity checks. Preserve old identities explicitly; separate host transport from adapter identity for new records. Centralize compatibility handling outside phase logic.                                                                                                          |
| `src/modules/kilo/service.ts`                                                                                           | Retain standalone Kilo handoff. It currently launches directly, inherits `process.env`, stores Kilo tasks and has its own workspace/auto policy. Factory must not call `startKiloTask`, inherit that environment/policy, or create a parallel legacy task owner. Prompt constraints are useful references, not execution enforcement.                                             |
| `src/modules/kilo/process.ts`                                                                                           | Retain legacy process maps, completion/session discovery, notifications and reconciliation for existing Kilo tasks. Do not import this lifecycle into factory: direct-child cancellation and heuristic persisted-process matching are not the shared host's death-proof contract.                                                                                                 |
| `src/modules/kilo/utils.ts`                                                                                             | Adapt useful pure JSON parsing/event-summary/session normalization ideas only after version-specific validation. Existing permissive extraction and recursive session scanning need explicit byte/depth/count bounds; never reuse them as terminal or ownership authority.                                                                                                        |
| `src/modules/kilo/sessions-adapters.ts`                                                                                 | Retain legacy CLI/optional SDK/disk session lookup. Factory records exact attempt session IDs and only inspects its private state through verified bounded adapters. No broad operator-home database discovery, heuristic attachment, SDK fallback or last-session resume.                                                                                                        |
| `scripts/kilo-smoke.mjs`                                                                                                | Retain as legacy synthetic service coverage. It creates a fake CLI, explicitly updates completion and approval database rows, and exercises legacy review/promotion. It proves neither real Kilo compatibility nor factory supervisor/death/publication behavior. Reuse isolated-fixture ideas; create separate factory provider fixtures that settle through real host receipts. |

Do not start the legacy Kilo supervisor/lifecycle inside factory, register a factory attempt in legacy task ownership, or revive the removed PR Autopilot coordinator. Existing standalone Kilo sessions, result inspection and legacy watch behavior remain compatible; factory-owned worktrees/PRs retain exactly one mutation owner.

## Small typed adapter contract and registry

Use a compiled-in registry with stable IDs `codex`, `opencode` and `kilo`, precise Valibot-backed configuration variants and declarative readiness/UI metadata. No arbitrary executable plugin modules, free-form adapter IDs, runtime imports supplied by users, or provider-specific branches in factory phases, coordinator or progress judge. Explicit executable configuration selects a verified implementation of a registered CLI; it does not create a new adapter.

Keep three responsibility boundaries:

| Owner              | Responsibilities                                                                                                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coding CLI adapter | Readiness/capability and installed-version checks; version-aware command, prompt and environment construction; credential handoff description; bounded event normalization; root/child session identity; terminal-result mapping; provider-specific read-only reconciliation of retained session/output facts. |
| Execution host     | Workspace and private directories, validated spawn, transport/process observation, environment isolation enforcement, IO bounds, deadlines, durable cancel intent, TERM/KILL, process-death proof, credential removal and cleanup. It executes bounded readiness/inspection requests declared by adapters.     |
| Factory            | Persisted release/admission authority, immutable snapshots, ownership reservations, attempt lineage, cumulative budgets, independent checks/review, progress judge, feedback, delivery effects and outcomes.                                                                                                   |

The adapter returns a typed launch description and consumes validated observations; it does not own spawning, leases, retries, GitHub effects or application persistence. The host checks environment keys, private destinations and limits rather than trusting an adapter to disable safeguards. Provider-specific reconciliation may classify retained evidence or request bounded read-only inspection through the host, never resume or replace a session. Host death proof remains required regardless of a provider's completion claim.

Keep host transport and CLI identity distinct. A later existing-VM/`exe.dev` host should carry the same launch/event contract with host-resolved paths and capabilities without rewriting adapters or phase modules. Implement only the local host now; do not promise remote compatibility without future acceptance.

Capabilities must be honest, typed supported/unsupported/unknown facts with reasons. Do not call provider approval modes an OS sandbox or claim all CLIs support Codex sandbox semantics. Required private-state, bounded noninteractive execution and cancellation capabilities must be verified for admission. Optional child-session details may be unavailable without fabricating data. Keep separate parsers and fixtures; normalize outcomes, not an assumed common wire protocol.

**Pluggability acceptance:** adding a CLI requires a new adapter registration, its Valibot schemas, version/capability/readiness metadata and contract fixtures. After extracting the common seam, adding OpenCode and then Kilo must require no provider branches in factory phase/coordinator/judge modules. Codex must pass the same conformance suite. The parent accepted replacing a
fourth unique test-only adapter subprocess case with pure typed registry
conformance/unknown-ID rejection, the real fake-CLI production-path matrix for
Codex/OpenCode/Kilo, and static checks for provider branches in phase modules.
The child supervisor retains compiled registration and closed schema IDs; no
dynamic loader or OS bypass is added for tests. No fourth-ID child-process
coverage is claimed. See the [deviation ledger](../DEVIATIONS.md).

## Selection, snapshots and compatibility

Expose all three harnesses in private setup/readiness and release controls, with Codex selected by default and OpenCode/Kilo opt-in. Missing optional-provider readiness must not block a configured Codex path. Saving credentials, changing selection or inspecting readiness does not execute code or publish anything.

Bind the human-selected harness/config reference to exact release authority; admission resolves and persists adapter ID, contract version, executable identity and version, model, supported capabilities, permission profile and stable context. Persist references to credentials, never their values. Repairs inherit the grant's pinned selection. Persist exact attempt identity so controller restart dispatches to the same adapter and host, never the current global default. Compare the originally admitted executable identity before any executable probe, including `--version`, and preserve it through repair lineage. Revalidate readiness before spawning; a changed or unsupported binary blocks launch rather than accepting a silent version upgrade.

No mid-session switching, failure fallback, automatic replacement or resumption of a provider's last session. Each initial or repair attempt gets a fresh provider session and private home. A deliberate harness/model change follows explicit new release/admission and any required candidate delivery consent; it cannot reset consumed budgets on existing authority or take over uncertain compute.

Review A's P1/P2 fixes pin the original executable identity from admission through
repairs and reject identity drift before `--version`. Invalid credential failures
are no longer cached, allowing corrected selected references to be re-evaluated.
These fixes have focused regression tests and are included in both clean final v4 source reviews. Transitional UI/registry variants and all four changesets are also clean; final documentation was also cleared by both reviewers before publication.

Legacy attempts without a captured executable identity remain inspectable and
reconcilable. **New repairs pause for a fresh human release** instead of silently
capturing a replacement binary identity. This explicitly narrows historical
repair compatibility; it does not discard evidence or change uncertain ownership.
The deviation and operator recovery path are recorded in the linked ledger.

Old config without a selector continues to mean Codex. Preserve old run snapshots, version-1 manifests/receipts, `local-codex` host references, candidate lineage, grants and in-flight recovery semantics through explicit compatible decoders. Do not rewrite historical identities. Unknown adapter IDs/versions fail closed with retained evidence and reconciliation attention, never a default fallback. Legacy `publish:false` records gain no authority on upgrade. Prefer existing JSON contracts where sufficient; no speculative database schema or migration work is needed for this plan. Load the Drizzle skills before any later Drizzle work.

## Execution, trust and retention invariants

- Reserve durable ownership before resources or launch. Preserve one active factory writer globally and per repo, exact release/spec/base binding and managed-worktree isolation. Keep ownership through collection and verified death, including child servers; primary checkouts remain untouched.
- Use the shared supervisor, permanent launch fence, signed heartbeat/receipt and authenticated process group. Cancellation persists across restart and completes only after actual process/group death, not after sending a signal, a lease expiry or receiving a provider terminal event. Lost ownership, missing/contradictory receipts and crash windows remain `needs-reconcile`; never automatically launch a replacement.
- Use private per-attempt HOME/XDG/config/cache/scratch/session state and an allowlisted environment. Hand off only explicitly selected provider credentials, using the verified provider mechanism; never inherit control-plane GitHub/webhook/deployment secrets or operator plugins/MCP/config. Credentials stay out of argv, public snapshots, logs and UI; store references, enforce private permissions, redact bounded output and persist cleanup outcomes. Cleanup failure remains visible.
- Validate all IO as `unknown` with Valibot: API/config, persisted records, manifest/IPC/receipt, filesystem/process observations, CLI JSONL and model results. Use precise inferred types, no `any`, unchecked casts or broad escape hatches. Bound both stdout and stderr, individual lines, aggregate bytes, event/session counts, nesting, retained summaries and inspection calls. Unknown informational events cannot imply success; malformed, truncated or contradictory terminal evidence fails closed.
- Enforce existing finite time/output limits independently of controller survival. Candidate status requires host receipt, session provenance, dead proof and Git evidence including dirty/untracked content. Provider success is not independent task acceptance.
- Preserve failed, cancelled, uncertain, dirty and unpublished work. Reuse current explicit cleanup/discard controls and Slice 3's narrow latest-published-checkout eligibility after its 24-hour grace and exact outcome/root/head/cleanliness/death checks. Earlier coding/repair workspaces, frozen refs and evidence remain retained. Existing seven-day attention/30-day retention fields do not authorize blanket deletion; automatic evidence pruning remains deferred. Credential removal is separate from deleting useful work. Cleanup is idempotent, cannot discard valuable changes implicitly, and never automatically deletes remote branches.

## Same delivery policy for every harness

Both initial candidate repair and watched-PR feedback repair must use the same selected adapter, admission guards, independent supervised checks, frozen revision evidence and fresh read-only model review. Keep the current verification command host distinct from a coding CLI; do not move checks into provider self-certification.

Carry Slice 3.1's revision-bound progress packet and continue/change-approach/escalate decision through both repair paths for Codex, OpenCode and Kilo. Preserve two repairs and the three-hour cumulative grant ceiling, including judge/check/review execution and reservations for unknown usage. Preserve one judge call per prospective repair ordinal, at most two per grant, and the three-minute or smaller remaining deadline. Restart, changed approach and provider failure do not refill budgets. The judge cannot edit, execute, grant permission or publish; passing candidates receive no new judgment gate.

Keep exact candidate-delivery grants, commit/tree equality, hooks/author checks, durable push/PR effect intent and uncertain-effect reconciliation. Reuse the existing GitHub transport with ETag/conditional-cache reads, semantic feedback deduplication and mutation invalidation. Never add provider-specific direct GitHub clients or duplicate publication paths. Unknown/partial checks are not green; an absent read after an uncertain create does not authorize another PR. Preserve draft state, human body edits, exclusive factory watch ownership, revocation and external-head fences. No automatic mark-ready, approval, merge, deployment or unrelated messages.

## Proposed implementation stack and review process

The parent orchestrator owns assignments, integration, existing status/deviation documents and publication. Development and both independent static reviewers use **Astra, medium effort**. Use stacked PRs with disjoint file ownership and explicit lower-layer contracts; serialize edits to shared contracts.

| Layer                                 | Complete deliverable and boundary                                                                                                                                          | Required evidence before publication                                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Core and generic factory contract | Typed registry/metadata, shared host, Codex baseline, compatible decoding, release fingerprint binding, original executable identity and generic admission/repair routing. | Old-record fixtures, Codex conformance, host death/credential checks and complete lower-layer typecheck without new UI.                                          |
| 2 — OpenCode                          | Version-pinned descriptor, private auth/config, parser and independent fake-provider fixtures.                                                                             | OpenCode conformance and Linux shared-host lifecycle; no provider branches in phases.                                                                            |
| 3 — Kilo                              | Separate pinned descriptor/parser, precise workspace guards and independent fixtures; retain standalone Kilo ownership.                                                    | Kilo conformance, Linux shared-host lifecycle and intermediate typecheck.                                                                                        |
| 4 — UI and handoff                    | Registry-driven setup/readiness, exact release selection, pinned run identity, evidence/planning controls and operator documentation.                                      | Three-CLI factory matrix, accepted registry/static conformance substitute, synthetic UI screenshots, cumulative checks and two clean independent static reviews. |

The current proposal is four complete layers. Integrate concrete corrections into
their owning layers; change the stack only when dependency evidence requires it.
The parent coordinates and publishes; implementation remains with assigned agents.

Before **any PR creation**, both independent reviewers must clear the exact
publication candidate and the parent completes implementation/product-plan review.
Final v4 source is clean with both reviewers on manifest
`10d35b26816b5840d6e5f06d26bf2e643183c7309377a30ea847478bdaf5070c`
(1,335 manifest files plus Kilo mode 755). Lower transitional variants and four
changesets and final documentation are also clean. All PRs were created afterward.
The parent post-publication architecture review is clean on the exact published
heads and main → #406 → #407 → #408 → #409 bases. All nine checks passed on each exact published source head at the September 6 checkpoint in the handoff; later documentation commits have separate CI.

## Acceptance checklist

Recorded deterministic runs are complete: check v3 passed 256 unit files/2,511
tests; Linux host 49/49 (37 Codex, 6 OpenCode, 6 Kilo), factory matrix 6/6; final
three lower-layer typechecks and post-fix dashboard/package/smoke passed. Earlier
legacy 9, other integration 103 and Git 47 passes retain their baseline scope.
See [handoff](SLICE_4_HANDOFF.md) and [acceptance](SLICE_4_ACCEPTANCE.md) for
counts, durations, failure/recheck history and limits. No full per-harness
Cartesian matrix or single all-inclusive `npm run verify` pass is claimed.

### Contract and deterministic integration

- [x] Separate pinned OpenCode/Kilo help/source contracts, Valibot parsers and
      source-derived synthetic JSONL/fake executables; Codex default retained.
- [x] Three-CLI Linux host suite and initial/pre-publication plus
      initial/watched-feedback repair routing through actual fake subprocesses
      and signed receipts. Typed registry/static phase checks replace the fourth
      unique subprocess adapter under the accepted deviation.
- [x] Release configuration and original executable identity remain pinned;
      identity is checked before `--version`. Credential failures are not cached.
      Focused regression fixes and final source review are clean.
- [x] Legacy inspection/reconciliation retained. Explicit compatibility narrowing:
      new repairs without captured executable identity pause for human release.
- [x] Registry-driven setup/readiness, selected-versus-pinned identity, stale-read
      controls and retained evidence/planning UI verified with focused tests and
      twelve actual synthetic desktop/mobile screenshots.
- [x] Named deterministic suites, final lower-layer typechecks and package/build
      checks completed with exact evidence and prior-baseline distinctions recorded.
- [ ] Expanded per-harness combinations of all crash windows, judge failure
      patterns, publication uncertainty, feedback edges and cleanup outcomes:
      not established as a complete matrix by shared suites and six routing cases.
      This remaining matrix obligation does not imply the named runs are pending.
- [x] Both independent final source/docs reviews, PR publication and separate
      post-PR parent architecture review completed. Four synthetic images verified in #409.
- [x] All nine checks passed on each exact published source head at the September 6 checkpoint in the handoff; later documentation commits have separate CI.

### Separately authorized live acceptance

- [ ] Record combined Slice 2/3/3.1 real Codex acceptance and actual model judgment observations, preserving all earlier deferred cases that remain unexercised.
- [ ] On the intended execution host, establish installed version, flags, capabilities, selected model and auth readiness separately for Codex, OpenCode and Kilo. Kilo's verified local installation and OpenCode's temporary official-binary checks remain distinct from target-host authenticated readiness.
- [ ] For each harness, release a bounded task explicitly and observe private managed-worktree execution, actual JSONL/session/terminal evidence, independent checks/review, one bounded judged repair and unchanged primary checkout.
- [ ] Under explicit delivery authority, exercise one draft PR, watched feedback, human outcome and retained/cleaned work for each harness; record recovery/cancellation observations and their precise limits. Do not manufacture a real-provider success from fixtures or a legacy Kilo smoke.
- [ ] Record date, tested source/CLI versions, finite limits, sanitized outcomes, failures/rechecks and operator/parent signoff. Store raw sessions, credentials, private executable paths and execution-host details outside public docs/screenshots/PRs. Unrun scenarios remain pending; no new premerge live gate is introduced.

## Deferred scope

Managed `serve` processes and SDK clients, ACP, resuming or reattaching coding conversations, remote hosts/provisioning, dynamic external adapters, parallel writers, automatic harness switching, a new workflow engine, legacy Kilo handoff/promotion redesign and PR Autopilot revival are excluded. Observing and reconciling already-admitted running processes and retained receipts remains required; deferring conversation resume/reattachment does not defer recovery. Linear remains Slice 5 and remote execution Slice 6. Broad retention automation remains deferred; preserve existing safe cleanup behavior. Record actual later deviations in the existing ledger.
