# Human shaping workbench

Increment 3 extends the existing Factory task. It does not launch coding agents or
write to GitHub. Factory remains disabled until the operator enables it.

## Read, compare, and discuss

Select a **Retained version** to read its immutable specification, author, and
source version. **Compare versions** compares the selected document with any other
retained version, in either direction. Equal or empty documents show “No document
changes”; comparison errors retain both readable documents. The document adapter
uses the existing Pierre renderer, worker pool and theme. It has no PR identity,
Git revision, commenting, workspace-edit, or publication capabilities.

Choose **Discuss scope**, **Discuss ac-1**, or a decision's discussion action to
attach that exact version, content hash and stable section/criterion/decision ID to
the next conversation message. The server resolves the reference within this task,
then persists its original text in the normal planning message. The attached
excerpt is limited to 6,000 characters and labels truncation. Older references stay
on their original version when the current brief changes. Clear a reference to send
an ordinary message. Neither reference text nor chat prose changes the canonical
specification; a typed proposal or explicit human save creates a revision. No
client-supplied session identifier or additional planner capability is accepted.

The brief uses the same Markdown and narrative presentation as PR briefings. The
persistent conversation uses the existing chat session view and server-bound
factory planner. Desktop shows both; narrow screens offer Conversation and Brief
views without unmounting either composer/editor.

## Edit, resolve, and release

Only the current version is editable. **Edit draft** edits the canonical Markdown
fields and acceptance criteria; existing criterion IDs remain stable. Answer open
decisions in the editor and **Save new revision**. A nonblank answer resolves that
decision in an immutable human-authored revision; its older unanswered version is
retained. A blocking unanswered decision prevents release.

A concurrent editor or model save never overwrites local input. Review the current
saved document against your unsaved draft, and the current source, then explicitly
choose **Use current save base and keep my text**. This preserves your whole draft;
it is not an automatic merge. The resulting save uses the current concurrency
version and can still conflict again. Changed repository context has a separate
explicit acknowledgement. Cancel intentionally discards local edits. Controls are
disabled while a save is pending to avoid dropping text entered after submission.

**Release vN** names the selected revision and submits its exact hash/version. A
retained older version cannot release the newer current version accidentally. The
backend rechecks version, source, repo, policy and decisions transactionally. A new
revision invalidates the older release while retaining its history. Withdraw returns
a queued task to shaping; pause/reopen retain history and never revive approval.
The queue remains **Released — awaiting coding executor**. Permission covers the
captured isolated implementation/check policy, never publishing, merging or deploy.

Saved revisions/releases survive server restart. Within the same browser tab,
selected views, draft fields (including incomplete criteria), discussion reference,
and unsent conversation text also survive reload through session storage. They are
local drafts, never canonical records or authorization. Background refresh errors
keep the last loaded workbench mounted. Storage failures show a copy-before-reload
warning; closing the browser tab may discard unsaved drafts.

If a saved draft cannot be restored, **Saved draft needs recovery** preserves its
original data and pauses automatic draft saving. Select and copy the saved data
or download it before discarding. **Retry draft recovery** tries reading it again;
discarding requires explicit confirmation. A failed read or schema check never
silently replaces the saved draft with defaults.

## Verification and remaining slice work

Use the focused Factory/domain/document-diff tests and normal `npm run check` /
`npm run verify` gates. The deterministic `scripts/factory-planning-fixture.ts`
server supplies actual UI screenshot data without operator credentials. Screenshot
and verification manifests identify the frozen source separately from review and
publication status. No live-provider spend is required for this increment's
unchanged provider/agent integration.

GitHub ingress, writeback and deployed exposure acceptance remain increments 4/5.
No migrations or dependency changes are required by this workbench.

### Planning requests with an uncertain receipt

The browser stores the exact planning request before sending it, including its
request key, expected task version, message and discussion reference. After a
lost response or reload, **Retry original request** resends that same envelope;
new messages and context refresh remain blocked until it is resolved. A changed
brief, selected reference or lifecycle does not rebind that request. A definitive
rejection requires **Dismiss rejection and review a new request** before a new
send. Storage failure prevents admission; retain browser storage while resolving
uncertain requests. Closing the tab may discard this browser-local recovery data.
