# Slice 5 — Linear intake

Status: source implementation and independent static/manager architecture reviews
complete; verification passed and [PR #423](https://github.com/pandemicsyn/neondeck/pull/423)
published ready for review, September 7, 2026. Merge/live acceptance remain pending.
Base: `51a5caea`.

The operator requested implementation of the next numbered factory slice after
Slice 4 and the onboarding/observability work. Development and independent static
review agents use Astra at low effort. The parent manages scope, integration,
verification and final architecture review. No PR is created before independent
static reviews are clean. Published PRs must be ready for review; merge is separate.

## Outcome and scope

An operator can connect a Linear workspace/team/project to a registered repository,
admit selected issues into the existing factory inbox, shape and release them
through the existing human controls, and optionally reflect factory lifecycle in
configured Linear workflow states. Linear remains the source of task intent;
GitHub remains the delivery target. Slice 6 remote execution is unchanged.

- Typed, explicit organization/team and optional project mappings; credential and
  webhook-secret environment references, enabled state and label/state admission.
  Multiple matching repositories require operator clarification, never a guessed
  repository or duplicate competing task.
- Signed, bounded Issue create/update/remove webhook ingestion on the separate
  public listener, with timestamp validation and durable delivery deduplication.
  No provider fetch or model reasoning in the webhook request.
- Current-state reconciliation, paginated discovery and restart-safe retries.
  Stable workspace/issue identities survive duplicate and reordered deliveries.
  Mapping changes, removal, closure/archive and loss of admission eligibility
  withdraw stale authority and fence running work through existing factory paths.
  Reopening never resurrects an old release.
- Optional workflow-state writeback using explicit per-lifecycle state IDs.
  Default off. Persist bounded intent/receipt/recovery state and reconcile uncertain
  mutations before retrying. Recognize exact authorized echoes without suppressing
  independent source changes or creating feedback loops. No automatic Linear
  comments, questions, issue creation or assignment changes in this slice.
- Private typed configuration/state/retry APIs and operator UI for mappings,
  readiness, source provenance, sync failures and writeback consent. Preserve
  unsaved drafts, accessible controls and existing companion-display layouts.

## Architecture and ownership

| Area                                  | Owner              | Boundary                                                                                                                                    |
| ------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider transport and public ingress | `linear_transport` | Fixed official GraphQL endpoint, validated bounded IO, provider errors, signature verification and server lifecycle wiring                  |
| Factory contracts and lifecycle       | `linear_domain`    | Shared Valibot contracts, config, SQLite migration/store, reconciliation, authority invalidation, workflow-state effects and private routes |
| Operator UI                           | `linear_ui`        | Web API adapters, setup/source views, useful failure states, focused tests and synthetic browser evidence                                   |
| Plan and final review                 | Parent             | Progress/deviations, integrated verification, independent static review coordination, architecture review and ready PR publication          |

Reuse the existing factory service's transaction and authority primitives, coding
fences, planning conversations, execution adapters, delivery grants and GitHub
publication. Keep provider transport, source domain reconciliation, persistence,
effect reconciliation and UI separate. Do not introduce another coordinator,
model selection path or Flue runtime. App records belong in Neondeck SQLite;
Flue continues to own conversations and submissions. Add a forward generated
migration where persistence requires it. Validate external and persisted data
with Valibot; do not use broad `any` or unchecked provider casts.

Provider details are verified against the official Linear GraphQL, webhook,
pagination and schema documentation. Existing packages and native fetch are
preferred when they provide the required bounded transport; no new SDK is needed
solely to perform a small set of queries and mutations.

## Verification and acceptance

- Cover signature/freshness/org binding, bounded IO, duplicate IDs, reordered
  updates, pagination/restart, ambiguous mappings and operator repair.
- Cover meaningful source updates and removal while released/running, preserved
  human authority, config races, writeback off, uncertain effects and exact echo
  handling, and independent edits accompanying a status change.
- Cover typed routes/config changes, backward-compatible existing installations,
  Linear provenance and setup draft/error behavior. Exercise actual synthetic UI
  at desktop and companion/mobile widths.
- Run focused tests during implementation, then `npm run check` and integrated
  `npm run verify`. Record exact outcomes and environmental limits separately.
- Two independent static reviews must report no remaining findings before PR
  creation. The manager then reviews plan adherence, package/model use and module
  boundaries. Fix findings and re-review affected source before publication.
- Real Linear credentials, public webhook deployment and live Linear/GitHub/model
  acceptance are separate from synthetic tests. Existing earlier-slice accepted
  deferrals and pending live acceptance remain unchanged.

## Progress

- [x] Confirm scope against the roadmap and original factory proposal.
- [x] Assign development to Astra low agents with distinct file ownership.
- [x] Implement provider transport, webhook ingestion and persistence.
- [x] Implement reconciliation, authority invalidation and configured writeback.
- [x] Implement and verify private API and operator UI.
- [x] Complete integrated verification and record acceptance limits.
- [x] Obtain two clean independent static reviews, including final corrections.
- [x] Complete manager architecture review, including cooldown and triage fixes.
- [x] Publish ready PR after final review and verification: #423.

See [the handoff ledger](SLICE_5_HANDOFF.md) for delivered evidence and
[the deviations ledger](../DEVIATIONS.md) for actual deviations or deferrals.
