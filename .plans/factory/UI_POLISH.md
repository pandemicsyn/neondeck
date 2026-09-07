# Factory UI polish

September 7, 2026. Implementation, independent source review and the recorded
synthetic browser verification are complete after Slice 4 merged in PRs #406–#409.

## Scope and ownership

The operator requested a usability pass over the new factory surfaces: intake,
configuration, shaping chat, brief editing/review, coding evidence, candidate
review, delivery, progress supervision and feedback. Related shared chat behavior
is included where the factory uses it. Preserve the existing flat dashboard design
and all release, delivery, draft-retention and execution-authority boundaries.

The parent owns orchestration, product review and evidence bookkeeping. Astra low
implementers own intake/layout, planning/chat and execution/review respectively.
A separate Astra low QA agent exercises the rendered UI. Two independent Astra
low static reviewers must return clean before any PR is created.

## Verification plan

- Exercise the full application shell and global styles with synthetic API data.
  Isolated component captures cannot establish route scrolling.
- Cover desktop, 2560×720 companion display and narrow mobile layouts, including
  dark/light themes, long text, empty/loading/error/stale states and busy actions.
- Verify page and transcript scrolling, reachable composers and actions, readable
  evidence, keyboard navigation, visible focus and activity indications.
- Add focused behavior regressions for actual bugs; run relevant UI tests,
  typechecking, lint, formatting and the dashboard build.
- Capture public-safe screenshots and record actual observations and limitations.
  Browser fixture verification does not establish live model/provider acceptance.

## Initial findings

- The application body suppresses scrolling for the fixed dashboard, while the
  factory route initially has only a minimum height and no scroll owner. Verify
  and repair this route boundary without changing dashboard behavior.

## Results

The implemented changes establish a factory-owned viewport scroll area and a
bounded inbox, move setup behind a disclosure, preserve setup drafts, and expose
selected task content after navigation. Shared chat retains its mounted
transcript, follows late layout changes only while following the latest message,
and supports a growing, scrollable multiline composer. Factory planning restores
pending activity and retains exact composer identity beside uncertain requests.
Coding and delivery expose clearer activity, keyboard-reachable evidence,
backward log navigation and older publishing receipts.

Both independent reviewers cleared the final source after correcting two P2
findings: local draft recovery must leave Pause/Withdraw available, and replaying
an evidence-bearing request after reload must consume only the exact original
composer text. Recovery metadata is Valibot-validated and confined to that task's
draft namespace. Legacy requests remain readable without guessing their content.

- Standard `npm run check`: 259 files / 2,561 tests passed before the final
  recovery corrections, including lint, layers, migration consistency and types.
- Final focused factory/shared-chat/PR-chat run: 26 files / 262 tests passed after
  the corrections. App typechecking, dashboard build and changed-file formatting
  also passed. Existing lint/build warnings do not constitute clean warning-free
  output.
- Full-App browser fixtures established page and transcript wheel/key scrolling
  at companion, desktop and mobile sizes. Light/dark entry-state captures showed
  no document horizontal overflow or JavaScript page errors in the tested cases.
  Early captures with incomplete Tailwind source scanning are invalid and are
  excluded from evidence. No untouched pre-change visual baseline is claimed.
- Core ink, muted, primary, strong-primary and accent tokens exceed 4.5:1 against
  both page and field backgrounds in both themes (minimum measured 4.76:1).
  This is token-pair verification, not a complete accessibility certification.

Focused browser follow-up exercised:

- Native planning history, pending/streaming activity, accepted send and composer
  clearing, version comparison, editing and saving a new brief revision.
- Uncertain evidence-bearing send, reload and byte-identical request replay,
  preserving its request key and version. Recovery actions now precede collapsed
  original content; its expanded region scrolls by keyboard on desktop/mobile.
- Prepared worktree diff, retained metadata through polling, wheel scrolling,
  and actual Tab/PageDown navigation (0 to 378 px on companion, 0 to 450 px on
  mobile). Long lines wrap without horizontal page overflow. Log navigation
  exercised next, previous, terminal-page disabling and return to the start.
- GitHub source/comment scrolling and pagination; explicit publishing preview,
  pending/error draft retention, stable retry keys, stale-version protection,
  older receipts and connection draft retention through disclosure/save failure.
- Dashboard fixed-viewport and shared-chat regression checks in both themes at
  all three sizes. Compact session actions now wrap without clipped labels;
  all five actions and the composer remain reachable.

All browser activity used real application components and the full global CSS
with synthetic API/provider responses. No real GitHub publication, credentials,
model completion or deployed acceptance is claimed. Dashboard metrics/review
panels intentionally used unavailable fixtures; populated unrelated dashboard
features were outside this pass. Screen-reader testing, physical touch keyboards
and a cross-browser/device matrix remain unverified. These limits do not replace
the recorded positive interactions with a blanket accessibility certification.

The parent visually inspected intake, mobile conversation, light-theme delivery,
judge, publishing, prepared diff and the corrected recovery/toolbar captures.
Private QA reports distinguish invalid early captures from final evidence;
public PR screenshots use only synthetic data. The publication gate requires
both clean independent static reviews, including the final evidence record.
The stack separates shared chat from factory integration and compact UI styling.
The prior live acceptance obligations and executable-binding deferral remain
unchanged by this presentation-layer work.
