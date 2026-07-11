# In-App Toast Notifications Plan

Status: proposed
Written: 2026-07-11
Related: `.plans/ROADMAP.md` Phase 14, `.plans/AUTOPILOT_LOOP_WIRING_PLAN.md`

## Purpose

Neondeck has a durable notification store, a Runtime Overview notification
feed, an Autopilot attention banner, and macOS delivery through `osascript`.
It does not have an application-level toast or snackbar surface. New events can
therefore arrive while the relevant panel is hidden without producing any
immediate foreground feedback.

This plan adds a compact in-app toast layer over the existing durable
notification system and removes the current AppleScript-based macOS delivery
path. Toasts are a transient projection of notification state, not a second
notification store and not a replacement for the owning workflow or operator
surface.

```text
watcher / workflow / autopilot event
                  |
                  v
       durable notification record
                  |
       notification SSE event stream
                  |
      +-----------+------------+
      |                        |
      v                        v
foreground toast       query invalidation / panels
```

## Current State

- `src/modules/app-state/notifications.ts` persists notifications, reconciles
  unresolved rows by `source` and `sourceId`, publishes change events, and
  attempts native delivery.
- `src/server/events/notification-stream.ts` exposes created, reconciled,
  read, and resolved changes over SSE.
- `web/src/features/runtime-overview/plugin.tsx` subscribes to the stream only
  while Runtime Overview is mounted and invalidates notification/runtime
  queries.
- `web/src/features/runtime-overview/components/setup-rows.tsx` exposes read
  and resolve controls in the durable notification list.
- `web/src/plugins/AutopilotPanel.tsx` shows aggregate attention counts and
  includes autopilot notifications in recent activity, but does not interrupt
  the foreground UI.
- `src/modules/app-state/native-notifications.ts` sends `attention` and
  `urgent` rows to macOS through `osascript`. These alerts lack Neondeck app
  identity, deep links, grouping, buttons, and rich target context.
- There is no shared toast provider, toast reducer, snackbar component, or
  application-level notification subscription in the web client.

## Product Decisions

### Remove the current native notification path

The `osascript` implementation is removed as part of this work, not disabled
behind a new default and not retained as a fallback. Neondeck should not keep a
low-quality secondary delivery channel whose messages have vague attribution,
no reliable navigation, and behavior that differs from the in-app notification
policy.

This slice removes:

- `src/modules/app-state/native-notifications.ts`;
- native-delivery calls from the durable notification writer;
- `NEONDECK_NATIVE_NOTIFICATIONS` behavior and documentation;
- the dedicated native-notification policy tests;
- any readiness/status claims that Neondeck sends macOS notifications.

The durable store, SSE stream, in-app toast stack, Runtime Overview feed, and
owning operator surfaces become the complete supported notification path.
Future system-level notifications require a separately approved design with
proper Neondeck identity, permissions, navigation, and user controls; they do
not preserve or wrap the AppleScript implementation.

### Durable state remains authoritative

A toast never owns notification lifecycle. Reloading the dashboard may clear
the transient toast stack, but it does not read or resolve the durable row.
Runtime Overview and owning surfaces remain the complete history and recovery
interfaces.

### Toast behavior by level

| Level       | Default foreground behavior                                  |
| ----------- | ------------------------------------------------------------ |
| `info`      | No toast; remains available in the durable notification feed |
| `ready`     | Quiet toast; automatically closes after about six seconds    |
| `attention` | Persistent until opened or acknowledged                      |
| `urgent`    | Persistent with assertive accessibility announcement         |

The policy is configurable, but these are the defaults. Passive scheduler
admission messages should not compete with active development work.

### Read, resolve, dismiss, and acknowledge are different

- `Open` marks the row read and navigates to the owning surface.
- `Acknowledge` marks the row read and removes its toast.
- Automatic timeout removes only the toast; it does not mark the row read.
- `Resolve` remains an explicit action in the owning surface or durable
  notification list. A transient overlay should not close operational state.
- A local close icon, if included, behaves like timeout rather than silently
  changing durable state. The labeled `Acknowledge` control is the only toast
  action that marks read without navigation.

### Reconciliation updates instead of stacking

When an unresolved notification with the same id is reconciled, the visible
toast updates its title, message, level, occurrence count, and timestamp in
place. It does not add a second item. If the new level is more severe, the
toast becomes persistent and uses the higher-severity accessibility behavior.

Read and resolved SSE events remove the corresponding toast immediately.

### The UI stays calm and glanceable

The toast surface follows the existing Lit Cockpit design system:

- flat field/panel surfaces with square corners;
- one-pixel hairlines and no shadow;
- IBM Plex Mono for structural metadata and IBM Plex Sans for the message;
- cyan/teal for ready state, with pink reserved for attention and urgent;
- no decorative glow, glass, floating-card treatment, or stacked animation;
- at most three visible items, with remaining events queued;
- a width capped around 380px and bounded for narrow column layouts;
- 150–200ms transform/fade transitions that become an instant crossfade when
  reduced motion is requested.

The initial placement is the logical end/bottom edge with safe inset from the
viewport and status line. It must be visually tested against top and bottom
status-line configurations before being finalized.

## Architecture

### Application-level notification controller

Add a global notification controller at the dashboard shell rather than inside
any display plugin. It owns one SSE connection for the active web application
and performs both query invalidation and transient toast projection.

Suggested structure:

```text
web/src/features/notifications/
  controller.tsx       provider, application-level SSE subscription
  policy.ts            level policy and event-to-toast decisions
  reducer.ts           deterministic queue/deduplication state
  targets.ts           notification target resolution
  toast-viewport.tsx   portal/live regions/stack
  toast-row.tsx        one toast and its actions
  types.ts
```

Mount the controller in `web/src/App.tsx` around the normal dashboard shell so
delivery does not depend on Runtime Overview being installed, active, or
visible. Popout routes should not subscribe unless they need full-dashboard
notifications; default to excluding review popouts to avoid duplicate alerts.

Once the global controller owns the stream, remove the duplicate subscription
from Runtime Overview. That plugin should consume React Query state only.

### Event admission and baseline rules

The controller must not turn initial query data into toasts. Only live SSE
`created` and eligible `reconciled` events after connection are admitted.

Rules:

1. Ignore `info` by default.
2. Admit `ready`, `attention`, and `urgent` created events.
3. Reconcile an existing queued or visible toast by notification id.
4. If a reconciled event was not already present, admit it only when it is
   unread and its level qualifies. This covers a dashboard that connected
   after the original create event without replaying the entire notification
   list.
5. Remove on `read` or `resolved`.
6. Do not replay the current notification query on reconnect.
7. Bound the queue to prevent an extended disconnected/reconnected producer
   burst from consuming unbounded memory.

The reducer should remain pure and use explicit timestamps supplied by events
or the controller so timer behavior is straightforward to test.

### Notification target resolution

Add a typed target resolver over `notification.source` and `notification.data`.
It should not scrape identifiers from title/message strings.

Initial target families:

- autopilot prepared diff or recovery surface;
- pending execution or MCP approval;
- Kilo task;
- briefing chat session;
- watched PR or release;
- Flue run inspection;
- Runtime Overview notification list as a safe fallback.

The target result should be an internal navigation command, not a raw URL
assembled inside the toast component. Where a plugin/tab must become active,
reuse or add one dashboard navigation event surface that can select the owning
region and tab. Session targets switch the active chat session through the
existing session API.

Notification producers missing stable target metadata should be upgraded as
part of the corresponding family integration. Unknown targets retain a useful
`Open notifications` fallback.

### Accessibility

- Ready messages use a polite `role="status"` live region.
- Attention and urgent messages use an assertive `role="alert"` region.
- Updated reconciled content is announced once, not once per rendered field.
- Toast arrival never steals focus.
- Actions use normal buttons with existing focus treatment.
- Automatic dismissal pauses while the toast is hovered or contains focus.
- Escape may close the currently focused transient toast locally, but does not
  alter durable notification state.
- Reduced motion is covered by both CSS and component timing tests.

### Dashboard configuration

Add a typed appearance/behavior section to dashboard configuration:

```jsonc
{
  "notifications": {
    "toasts": {
      "enabled": true,
      "minimumLevel": "ready",
      "readyDurationMs": 6000,
      "maxVisible": 3
    }
  }
}
```

Clamp durations and counts during parsing. Provide safe defaults for existing
dashboard files. Configuration should eventually be mutable through the typed
Neondeck config surface; implementation must not require manual JSON editing.

## Delivery Plan

### Phase 1 — Pure toast state and policy

- Define toast state, event policy, level ordering, queue bounds, and timer
  semantics.
- Implement reducer tests for created, reconcile, escalation, read, resolve,
  timeout, acknowledgement, queue overflow, and duplicate events.
- Add typed dashboard defaults and parsing.

### Phase 2 — Global controller and base UI

- Mount the notification controller at the dashboard application level.
- Move the SSE invalidation responsibility out of Runtime Overview.
- Render the viewport through a portal outside panel overflow contexts.
- Implement ready, attention, and urgent presentation in both themes and all
  density modes.
- Add accessible announcements, focus behavior, paused timers, and reduced
  motion handling.

### Phase 3 — Actions and deep navigation

- Implement `Open` and `Acknowledge`.
- Add the target resolver and generic Runtime Overview fallback.
- Integrate autopilot prepared diffs, approvals, Kilo tasks, Flue runs, and
  briefing sessions.
- Add stable target metadata to producers where required.

### Phase 4 — Content quality

Review high-value producers so a toast answers:

1. What changed?
2. Which repo, PR, task, or workflow does it concern?
3. Why does it need attention?
4. What can the user do next?

For example, prefer:

> Verification failed · neondeck #418
>
> `npm run typecheck` failed after Neon prepared the CI fix. The worktree was
> retained.

over a generic `Autopilot verification failed` message without subject or next
step. Rich content belongs in the durable notification payload so every
delivery channel benefits.

### Phase 5 — Remove AppleScript delivery

- Delete the `osascript` delivery module and its process-spawning behavior.
- Remove native delivery calls from notification creation and reconciliation.
- Remove `NEONDECK_NATIVE_NOTIFICATIONS`, its tests, and related documentation.
- Verify notification persistence and SSE publication remain unchanged after
  native delivery is removed.
- Confirm backend notification creation no longer spawns detached processes.

Do not replace AppleScript with `node-notifier`, `terminal-notifier`, another
shell command, or an unbranded browser alert in this slice. A future system
notification project may evaluate PWA Notifications/Web Push or a proper
`UNUserNotificationCenter` application helper, but it starts from a new product
contract rather than carrying forward this implementation.

## Verification

- Unit tests for reducer, policy, timer, queue, and target resolution.
- Component tests for accessible roles, keyboard actions, paused timeout, and
  reduced motion.
- Integration test proving one backend SSE event produces one toast and one
  query invalidation even when Runtime Overview is absent.
- Integration test proving reconciled autopilot retries update one toast.
- Navigation tests for prepared diff, approval, briefing session, and fallback.
- Visual QA at 2560x720 plus narrow column layout, light/dark themes, and each
  density setting.
- Verify popout windows do not duplicate full-dashboard toast delivery.

## Acceptance Criteria

- A new eligible notification becomes visible immediately from any dashboard
  layout, independent of Runtime Overview mounting.
- Repeated occurrences reconcile into one visible toast.
- Opening a supported toast reaches its owning work and marks it read.
- Acknowledgement marks read without resolving the condition.
- Automatic timeout does not mutate durable notification state.
- Reloading or reconnecting does not replay the active notification list as
  new toasts.
- The stack never exceeds the configured visible limit and remains usable on
  the 2560x720 companion display.
- Toasts do not cover chat input permanently, steal focus, or violate reduced
  motion and live-region expectations.
- Notification creation and reconciliation never invoke `osascript` or spawn a
  native-notification subprocess.
- `NEONDECK_NATIVE_NOTIFICATIONS` and the current native delivery module no
  longer exist.

## Non-Goals

- Replacing the durable Notifications panel.
- Resolving operational conditions automatically because a toast was seen.
- Making every `info` event interrupt the user.
- Shipping Web Push, browser system notifications, or a signed native helper
  in the toast slice.
- Parsing notification prose to infer navigation targets.
