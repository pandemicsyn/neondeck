# Slice 1 — Boundary and ownership hardening

This follow-up addresses the cumulative architecture audit of the factory stack
through `9bfa7991`. It is a seventh delivery layer above GitHub publishing, within
the existing intake-to-human-released-queue scope. Coding execution, deployment,
and live provider acceptance remain separate work.

## Required outcomes

- Validate persisted planning effects before replay, repository-reference
  authorization, or token accounting. Distinguish proposal receipts, repository
  reads, and triage usage with typed schemas. Existing valid records must remain
  readable through an explicit compatibility decoder; malformed records must not
  silently grant authority or weaken budgets.
- Validate duplicate-candidate records before projecting classifier context.
- Preserve browser draft data when restoration fails. Distinguish an absent draft
  from an unreadable one, block automatic replacement, and offer explicit recovery
  or discard. Keep the human's text available while errors are resolved.
- Validate mutation responses before acknowledging success or clearing input.
  Preserve typed command/payload relationships and enforce the revision invariant
  consumed by the workbench without breaking bounded internal planning snapshots.
- Give configuration and factory state separate owners: configuration owns file
  replacement and history; factory operations own factory tables and revocation.
  Retain synchronous revocation before configuration replacement and conservative
  behavior when replacement fails.
- Separate planning effects, context capture, and Git reads; remove the planning
  store/tool dependency cycle. Extract workbench state and specification editing
  from the task-detail composition component.
- Normalize listener environment settings through schemas while preserving the
  existing loopback restriction, IPv6 support, precedence, and port separation.

Planning-effect compatibility does not rewrite history or require a migration:
the decoder accepts only the exact valid legacy proposal/read shapes. Malformed
retained records fail closed. Invalid reported provider token counts conservatively
exhaust the next-call budget; absent usage retains observed-token semantics and
the independent four-call limit.

## GitHub conditional reads

Reuse the existing GitHub client and its bounded validator cache. Factory issue,
comment, repository, and identity adapters already call that client; this work
must not introduce another client or an independent source of authority.

Authenticated conditional GETs should send the retained ETag and reconstruct a
validated response after `304 Not Modified`, preserving pagination metadata.
Cache identity must distinguish credentials, resource URLs, and representations.
Publication and recovery reads must still contact GitHub; cached data alone must
not authorize an action. Writes, including ambiguous failures, must invalidate
affected reads, and an older in-flight read must not repopulate invalidated state.
Keep memory bounded and avoid retaining partial, oversized, or non-cacheable
responses. Parse retry headers into finite, bounded timestamps with safe fallback.

GitHub documents authenticated conditional reads and rate-limit handling in its
[REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).
Conditional writes are not assumed to be supported. Existing remote-edit race
limitations and explicit publication/repair consent remain in force.

## Delivery and evidence

Implementers own disjoint files. Two independent static reviews and the manager's
implementation/product review must have no outstanding findings before publication.
Any source change after review requires renewed review of the changed candidate.

Verification includes malformed/legacy persistence, draft recovery, response
contracts, configuration revocation, listener behavior, and conditional-read/cache
invalidation regressions. Run the complete Node 26 verification on the integrated
candidate and inspect actual synthetic UI screenshots. Record current results in
the PR; historical results from earlier layers do not certify this layer.

Every commit runs the mandatory secrets-scanning hook. Publish only selected
synthetic screenshots and concise results, never raw private evidence or runtime
configuration. No PR merge or deployment is implied by passing these gates.
