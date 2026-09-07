# Slice 5 Linear operator guide

Linear issues use the existing factory inbox, planning conversation, exact human
release, coding configuration and delivery grants. A Linear status or webhook
cannot approve a brief or release work.

## Configure intake

1. Register the local repository and enable the factory inbox at `/factory`.
2. Open **Factory setup → Linear connections → Add Linear connection**.
3. Choose a stable connection ID, the Linear workspace and team IDs, an optional
   project ID, and the registered repository. These are provider IDs, not display
   names. A blank project matches every project in the team. Use separate
   connections for disjoint mappings; overlapping enabled team/project mappings
   are ambiguous and unavailable until corrected.
4. Enter credential **environment variable names**, such as `LINEAR_API_KEY` and
   `FACTORY_LINEAR_WEBHOOK_SECRET`. Put their values in the private runtime-home
   `.env` or service environment, never in the dashboard form or connection JSON.
5. Choose admission for all issues in the mapping, a specific label ID, or a
   specific workflow state ID. New connections start disabled. Enable admission
   only after reviewing the mapping and filter.
6. Save the connection and inspect readiness. Missing credentials, an unknown
   repository and ambiguous mappings remain visible. A configured reference is
   not proof of authenticated access or webhook delivery.

The form retains unsaved changes across refresh and errors. If another client
changes the configuration, saving the stale draft is blocked. Copy the draft,
cancel, reopen the saved connection, and apply the intended changes.

## Webhook exposure

Use the existing separate ingress listener configured with
`NEONDECK_INGRESS_PORT` and `NEONDECK_INGRESS_HOST`. The Linear Issue webhook URL is
`https://<public-ingress>/hooks/linear/<connection-id>`. GitHub and Linear share
this listener; keep the dashboard and `/api/factory/*` on the private app
listener. Route only webhook paths through the public proxy. Match the Linear
webhook signing secret to the connection's secret environment reference.

Signed issue deliveries enqueue durable work. Reconciliation fetches current
provider state, and periodic discovery catches missed events. Inspect connection
sync errors in setup. Inside a task, **Source and repository → Sync Linear
source** requests a fresh reconciliation and refreshes the displayed task.

A temporary provider error or timeout is a synchronization failure, not evidence
that the issue changed. It must not withdraw a release or cancel coding by itself.
Inspect the retained sync error and retry time while provider access recovers.

## Source changes and mapping repair

The source panel shows the Linear issue link, team/project, source version,
status and attention reason. Resolve ambiguous configuration in setup and retry
sync. An already admitted task retains its original source mapping; do not
reassign it to an unrelated repository by changing connection IDs or mappings.
Restore its original mapping when the task reports that mapping changed.
Editing a disjoint project connection leaves unrelated project tasks unchanged;
edits to the task's own connection or an overlapping team/project mapping still
require review.

Meaningful source changes require renewed review. Closure, archive, removal or
loss of admission eligibility withdraws stale authority and cancels factory work
through the existing lifecycle. Reopening an issue does not restore an old
release. Compare and release the current brief explicitly.

## Optional workflow-state writeback

Status writeback is a separate checkbox and defaults off. Map only the factory
lifecycle states you intend to publish (`inbox`, `shaping`, `queued`, `paused`,
`closed`) to actual Linear workflow state IDs for the configured team. Blank
mappings publish nothing. Saving with writeback enabled grants continuing
permission for those configured status updates; it does not permit comments,
questions, assignment changes, issue creation or publishing code.

Review writeback state and errors in the task's source panel. An uncertain
mutation must be reconciled against Linear before another send; do not use a
configuration toggle as an assumed retry receipt. An exact acknowledged status
echo must not invalidate the brief, while independent source edits still do.

Use **Sync Linear source** to recheck retained uncertain effects without resending
the mutation. An exact match can establish the receipt; a mismatch remains visible
for operator review. Configuration changes and new briefs do not retroactively
prove that an older status mutation succeeded.

Linear intake does not create a Linear-specific coding or PR publisher. Draft
GitHub delivery still requires the existing delivery grant and exactly one
enabled GitHub delivery connection matching the registered repository.

## Acceptance status

Synthetic tests and local UI screenshots establish deterministic behavior and
layout only. They do not prove real Linear credentials, public webhook exposure,
workflow-state permissions, live model quality or GitHub publication. Record
those checks separately in the Slice 5 handoff before claiming live acceptance.
