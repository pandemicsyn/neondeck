# Scheduler Tick Concurrency Plan

## Problem

`runSchedulerTick()` currently syncs schedules, reads all due jobs, executes them, then records each result. The local interval loop and the Flue action/API path can call the same tick function at the same time. Two overlapping ticks can observe the same due job set before either call advances `next_run_at`, which can duplicate workflow admissions, watch refreshes, notifications, and job result writes.

This should be fixed without making the scheduler heavy or adding user-facing friction.

## Goals

- Keep scheduler ticks deterministic and low-friction.
- Prevent duplicate due-job execution from overlapping tick callers in one backend process.
- Prevent duplicate due-job execution across multiple local callers/processes when they share the same runtime home.
- Keep the implementation small and local to scheduler/app-state persistence.
- Return a normal skipped/silent result when another tick owns the lease; do not surface this as an error.
- Do not introduce a separate scheduler service, queue system, or long-lived Flue workflow supervisor.

## Non-Goals

- Do not redesign schedule blueprints.
- Do not add per-job distributed leasing in the first fix unless the global lease proves insufficient.
- Do not hold Flue runs open to supervise background scheduler state.
- Do not add approval gates or operator prompts.

## Proposed Fix

Use a lightweight global tick lease stored in the existing `app_metadata` table.

Lease key:

```text
scheduler.tick.lease
```

Lease value:

```json
{
  "owner": "pid-host-random",
  "acquiredAt": "2026-07-01T00:00:00.000Z",
  "expiresAt": "2026-07-01T00:05:00.000Z"
}
```

Acquisition semantics:

- `runSchedulerTick()` calls `tryAcquireSchedulerTickLease()` before syncing schedules or reading due jobs.
- Acquisition runs inside a SQLite `BEGIN IMMEDIATE` transaction so the read/check/write is atomic for one runtime database.
- If no lease exists, acquire it.
- If the lease is expired, replace it.
- If the lease is active, return a successful scheduler result with `changed: false`, `outcome: "silent"`, and a message like `Scheduler tick skipped because another tick is active.`
- On completion, release the lease only if the stored owner still matches this tick owner.
- Always release in `finally`.
- Use a conservative default TTL, e.g. 5 minutes. This is long enough for current bounded watch/workflow admission work and short enough to recover from a crashed process.

In-process loop guard:

- `startSchedulerLoop()` should also keep a local `tickInFlight` boolean.
- If the interval fires while the previous loop tick promise is still pending, skip that interval.
- This avoids needless lease contention and log noise in the common single-process case.
- Manual/action-triggered ticks still go through the durable lease, so they are protected too.

## Minimal Code Shape

Add scheduler-local helpers:

```ts
type SchedulerTickLease = {
  owner: string;
  acquiredAt: string;
  expiresAt: string;
};

async function withSchedulerTickLease<T>(
  paths: RuntimePaths,
  now: Date,
  run: () => Promise<T>,
): Promise<{ acquired: true; result: T } | { acquired: false }>;
```

The helper can use `DatabaseSync` directly or small app-state functions. Keep it private to `src/scheduler.ts` unless another scheduler module needs it later.

Recommended owner:

```ts
`${process.pid}:${randomUUID()}`;
```

## Failure Behavior

- If lease acquisition fails because SQLite is busy, return a skipped/silent result rather than throwing.
- If job execution throws after acquiring the lease, current scheduler failure behavior should remain intact and the lease should still release in `finally`.
- If the process crashes, the TTL expires and the next tick can recover.
- If a tick runs longer than the TTL, a later tick could acquire the lease. If this becomes realistic, extend the lease before each job or add per-job claims. For current bounded jobs, a 5-minute TTL is acceptable.

## Tests

Add focused unit tests in `src/scheduler.test.ts`:

- Two concurrent `runSchedulerTick()` calls with one due workflow job should admit the workflow once; the other call should skip.
- A stale lease in `app_metadata` is replaced and the due job runs.
- An active lease returns `ok: true`, `changed: false`, and `outcome: "silent"`.
- The loop guard does not dispatch a second tick while the first tick is pending. This can use an injected slow tick function if the loop API is adjusted, or it can be covered indirectly by the lease test if keeping the loop signature unchanged.

## Implementation Order

1. Add private lease parse/read/write/release helpers in `src/scheduler.ts`.
2. Wrap `runSchedulerTick()` with the lease before `syncScheduledJobs()`.
3. Add the local `tickInFlight` guard to `startSchedulerLoop()`.
4. Add the focused scheduler tests.
5. Run:

```sh
npm run typecheck:app
npm run test -- src/scheduler.test.ts
npm run lint
```

## Future Refinement

If Neondeck later supports multiple backend processes doing heavier scheduler work, add per-job claims:

- mark each due job as claimed before execution,
- store claim owner/expiry in job result metadata or a small job lease table,
- release/advance each job independently.

Do not start there. The global tick lease is the right lightweight fix for the current local-first scheduler.
