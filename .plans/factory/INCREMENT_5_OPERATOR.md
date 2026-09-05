# GitHub publishing — slice 1, increment 5

Historical acceptance: the original slice 1 stack was reviewed through feature
`a0c0cf31c8a6693863e1f975eb61f8ff1bb85fa3` and documentation head
`ff3a69033ae866aaf47dd0a6c3384544e5eb1e6a`. Those reviews and verification apply
to those candidates. See the [handoff ledger](SLICE_1_HANDOFF.md) for incorporated
feedback parents and [PR #387](https://github.com/pandemicsyn/neondeck/pull/387)
for current feedback reviews and CI. Each publication requires its own verification,
two clean dedicated static reviews and manager acceptance. Nothing is merged,
deployed or live-accepted.

## Human publication boundaries

Open an admitted GitHub task, expand **Source and repository**, and use **GitHub
publishing**. Writeback starts off. **Review writeback policy** previews exactly
which statuses the connection may publish, then **Enable these status updates**
records the local human's consent. Consent applies to one maintained status comment
per admitted issue on that connection. No issue title/body, labels, assignments,
state changes or private workbench URLs are written. The template says no coding
executor has started. An eligible released state reads **Released — awaiting coding executor**. If repo
context invalidates an otherwise queued task, the public template instead says
**Review needed — release is not currently eligible**, without private blocker text.

Use **Review public summary** to edit and preview the exact scope text before
approving it for the current specification and source version. Only that approved
summary may appear in the maintained comment. New source/spec revisions do not
inherit approval; status may continue without the old scope text. Public summaries
also require their captured repo fingerprint to match both the current repo and
retained specification context. Raw draft
internals, chat, model prompts, logs and private repo context are never copied into
the template. A human must still ensure their explicitly supplied public text is
appropriate to share.

**Ask on GitHub** starts an editable question. An unresolved decision can seed it,
but neither model prose, a decision, status consent nor release authorizes sending.
The human previews the exact body and target, then selects **Send this question to
GitHub**. The immutable approval binds the request key, body/hash, task, issue,
spec/hash, source version, optional decision, local actor and timestamp. Changed
text needs new approval. A hidden random ownership marker is appended as disclosed
in the preview. Question publication also requires connection writeback to be on.

Ordinary release remains independent: publishing errors cannot make a valid local
release fail. External replies remain attributed, untrusted context and cannot
approve, release, change policy or silently modify the brief. Source links identify
the exact remote comment and retained local revision. GitHub issue comments do not
provide a reliable reply-to relationship; Neon does not guess that later comments
answer a particular outbound question.

## Consent and recovery

Consent is app SQLite state, separate from ordinary configuration and unavailable
to planning tools. It is bound to the connection fingerprint and a fresh epoch.
Changing factory configuration revokes consent conservatively; restore the intended
mapping and explicitly re-enable publishing. Revocation persists before the config
file replacement; if replacement fails, revoked authority stays revoked. Pending
and pre-dispatch failed effects are cancelled. A revoked repair returns to required
review; re-enabling consent cannot convert it into an ordinary status update. Already dispatched requests may
finish; Neon records/reconciles their receipts without authorizing another write.

The existing single GitHub recovery loop performs bounded writeback continuations;
it does not start another scheduler, Flue runtime, agent harness or executor. App
SQLite retains validated consent, approvals, status ownership, repair previews and
effects in one additive table. No credential value is stored in effect payloads.
The configured token environment reference is resolved by the existing transport.
The initial implementation requires a token supporting authenticated-user identity
and Issues write access; GitHub App installation/OAuth setup remains out of scope.

Ordinary status changes coalesce only before dispatch. Repair payloads never
coalesce: changed task, context, consent or replacement requires a new exact repair
review. Dispatched payloads are immutable.
A final synchronous fence rechecks consent, epoch, mapping, task/spec/source version
repo fingerprint, and pending state immediately before invoking the provider. Current remote repository
and issue identity/content are read before a new write. One owner serializes all
writes per runtime home, which also serializes each issue. Multi-process concurrent
runtime owners are unsupported, matching the existing deployment contract.

**Pending**, **sent**, **failed**, **sync uncertain**, **repair** and **cancelled**
are separate states. Pre-dispatch failures and definite rejections of the actual
write request can be retried explicitly under still-valid authority. A rejection
of a recovery GET cannot establish that the earlier write failed: it remains
uncertain, including HTTP 401/403/422/429. A timeout, interrupted send or lost receipt never causes a blind
second POST. Recovery reads the known remote ID, or scans issue comments for an
exact unique author/marker/body receipt and re-reads that candidate. Scan progress
and candidate IDs persist, four 25-comment pages per pass. Incomplete pages cannot
prove absence. Even a complete scan with no unique result remains uncertain.
Read failures/rate limits retain progress and visible errors with a five-minute
minimum retry interval. Recheck requests can wake eligible read reconciliation;
a bounded pass cannot monopolize the loop. Provider timestamps/pagination are not
claimed to be a snapshot or an exactly-once external transport.

A confirmed receipt includes the remote ID, authenticated numeric actor identity,
body and updated revision. Echo suppression uses those facts together. If ingress
arrives before the receipt, an exact in-flight candidate is shown as awaiting receipt
and held from planner delivery; it is not labelled a confirmed echo. Receipt arrival
classifies only the same retained revision. Other bots, copied markers, and edited
owned comments remain external context. Ambiguous matching candidates stay visible
until reconciliation or relinquishment; no raw marker alone hides discussion.

## Remote edits, deletion and repair

Before updating a managed comment, Neon checks its confirmed remote content and
revision. An edit or unavailable comment stops automatic overwrite/recreation.
Incoming changes to a known owned status also flag repair. A permission error or
incomplete list does not establish deletion. **Review remote comment repair** first
validates the accessible issue and reads the individual known comment, then previews
its actual content (or confirmed absence) and the exact replacement. The preview lasts
five minutes and binds current task/consent. A changed/expired preview conflicts.
Approving a repair records an immutable replacement and observed precondition; it
does not adopt human-edited text as the confirmed managed baseline. Only a confirmed
write receipt advances that baseline. A stale or revoked repair remains blocked
until a new preview is approved, including across restart and opt-out/re-enable.
Neon checks the remote revision again before replacement; deleted-comment recreation
also rechecks absence. **Relinquish status management** leaves the remote comment
and local audit intact and stops further management rather than recreating it.

The [GitHub issue-comment API](https://docs.github.com/en/rest/issues/comments)
documents body replacement without a conditional compare-and-set contract. Another
remote edit can race the final read/write window. Neon does not claim atomic remote
replacement. Repair is explicit and this limitation is displayed in its preview.
Authenticated author identity comes from [the user endpoint](https://docs.github.com/en/rest/users/users#get-the-authenticated-user).

## Verification and remaining acceptance

Tests cover consent and source/config races, immutable approvals, coalescing, lost
receipts/restart, durable pagination, copied markers/other bots, ingress-before-
receipt, remote edits/deletion/repair and release independence. UI tests cover exact
preview, stale drafts, pending failures and captured policy fingerprints. Existing
Flue, source lifecycle, migration and packaged listener suites remain part of final
stack verification. Evidence manifests record frozen source hashes and actual
commands/results; passing a synthetic test is not live provider evidence.

The accepted feature commit `a0c0cf31c8a6693863e1f975eb61f8ff1bb85fa3` is open in PR #387
after both independent static reviews and manager acceptance of V4 identity
`8fe4f4d530cad8c775b55de0af34e7efa9ad178888cc70122a47950c0d1a7264`. All final Node 26.4.0 commands exited
0: 99 focused tests, 1,597-test check, and 1,735-test full verification; builds,
package contents (1,066 files), installed CLI smoke and formatting passed.
Fresh-process recovery, repo-context ABA and remove/re-add checks also passed.
The 243 UI files were unchanged from V3; 22 retained V2/V3 screenshots were
hash-checked, and the manager uploaded and verified six screenshots on PR #387.
These are local/synthetic acceptance results. PR #387 CI was pending at feature publication; final-head CI is tracked in the PR.

For reproducible actual UI evidence, build the dashboard then run the existing
standalone fixture with `FACTORY_GITHUB_FIXTURE=1` and
`FACTORY_WRITEBACK_FIXTURE=1`. Its synthetic provider and fixture-only controls make
no GitHub requests. Those controls are absent from the production app.

Final-stack checks use explicit Node 26.4.0, an initialized synthetic runtime home,
and a writable package cache. No lockfile/dependency upgrade is included. Every
manager commit must run the unchanged gitleaks hook; it is never bypassed.

Code completion is separate from review acceptance, PR publication, merging and
deployment. An authorized real GitHub test issue, final live-model conversation,
VM restart and anonymous external exposure probes remain pending operator
selection/authorization. Earlier increment 2 live-provider probes predated its final
budget guard and are not final-stack live acceptance. No VM/SSH/webhook setup or
external issue writes were performed in this increment. Slice 2 owns the coding
executor; no additional coding functionality is introduced here.
