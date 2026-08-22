import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { FlueObservation } from '@flue/runtime';
import {
  activateScheduledTaskSubmission,
  attachScheduledTaskSubmissionId,
  canAdmitScheduledSubmission,
  claimDueScheduledTasks,
  createAgentInstructionTask,
  createBriefingTask,
  listRecoverableScheduledBriefingRuns,
  nextOccurrence,
  readLatestScheduledTaskRun,
  readScheduledTask,
  releaseUnstartedScheduledTaskClaim,
  settleScheduledTaskRun,
  settleScheduledTaskSubmission,
  upsertScheduledTask,
  validateAutomationTrigger,
} from './modules/scheduled-tasks';
import {
  runSchedulerTick,
  type SchedulerDependencies,
} from './modules/scheduler';
import { createChatSession } from './modules/sessions';
import {
  admitBriefing,
  BriefingAdmissionConflictError,
  settleBriefingObservation,
} from './modules/briefings';
import { runtimePaths } from './runtime-home';

describe('scheduled task triggers', () => {
  it('calculates five-field cron occurrences in the requested IANA timezone across DST', () => {
    const trigger = {
      kind: 'cron' as const,
      expression: '0 9 * * *',
      timezone: 'America/Chicago',
    };

    expect(validateAutomationTrigger(trigger)).toMatchObject({ ok: true });
    expect(nextOccurrence(trigger, new Date('2026-03-08T12:00:00.000Z'))).toBe(
      '2026-03-08T14:00:00.000Z',
    );
  });

  it('rejects a cron trigger with an invalid timezone', () => {
    expect(
      validateAutomationTrigger({
        kind: 'cron',
        expression: '0 9 * * *',
        timezone: 'Mars/Olympus',
      }),
    ).toMatchObject({ ok: false });
  });
});

describe('scheduled task storage', () => {
  it('skips a malformed active briefing run without hiding valid recovery work', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-tasks-'));
    const paths = runtimePaths(home);
    try {
      for (const id of ['briefing:valid-recovery', 'briefing:malformed']) {
        await upsertScheduledTask(
          {
            id,
            spec: { kind: 'run-briefing', briefingId: id },
            trigger: { kind: 'interval', everySeconds: 3_600 },
            nextRunAt: '2026-07-10T00:00:00.000Z',
          },
          paths,
        );
      }
      const claims = await claimDueScheduledTasks(
        paths,
        new Date('2026-07-10T00:00:00.000Z'),
      );
      const malformed = claims.find(
        (claim) => claim.task.id === 'briefing:malformed',
      );
      expect(malformed).toBeDefined();
      const database = new DatabaseSync(paths.neondeckDatabase);
      try {
        database
          .prepare(
            'UPDATE scheduled_task_runs SET dispatch_payload_json = ? WHERE id = ?;',
          )
          .run('{', malformed?.run.id ?? 'missing');
      } finally {
        database.close();
      }

      await expect(
        listRecoverableScheduledBriefingRuns(paths),
      ).resolves.toEqual([
        expect.objectContaining({
          run: expect.objectContaining({ taskId: 'briefing:valid-recovery' }),
        }),
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('uses a stable snapshot and tie-breaker while finding the latest valid run', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-tasks-'));
    const paths = runtimePaths(home);
    try {
      await upsertScheduledTask(
        {
          id: 'instruction:stable-latest',
          spec: {
            kind: 'run-agent-instruction',
            prompt: 'Report health.',
            target: { kind: 'agent' },
            skills: [],
          },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-08-22T00:05:00.000Z',
        },
        paths,
      );
      const database = new DatabaseSync(paths.neondeckDatabase);
      const createdAt = '2026-08-22T00:00:00.000Z';
      try {
        const insert = database.prepare(
          `INSERT INTO scheduled_task_runs (
             id, task_id, status, outcome, message, result_json,
             started_at, completed_at, created_at, updated_at
           ) VALUES (?, ?, 'completed', 'recorded', ?, ?, ?, ?, ?, ?);`,
        );
        insert.run(
          'run-a-valid',
          'instruction:stable-latest',
          'valid result',
          JSON.stringify({ ok: true }),
          createdAt,
          createdAt,
          createdAt,
          createdAt,
        );
        insert.run(
          'run-z-malformed',
          'instruction:stable-latest',
          'malformed result',
          '{',
          createdAt,
          createdAt,
          createdAt,
          createdAt,
        );
      } finally {
        database.close();
      }

      await expect(
        readLatestScheduledTaskRun('instruction:stable-latest', paths),
      ).resolves.toMatchObject({
        id: 'run-a-valid',
        result: { ok: true },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('dispatches agent instructions once and settles by Flue submission id', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-tasks-'));
    const paths = runtimePaths(home);
    try {
      await upsertScheduledTask(
        {
          id: 'instruction:daily-health',
          spec: {
            kind: 'run-agent-instruction',
            prompt: 'Report repository health.',
            target: { kind: 'agent' },
            skills: [],
          },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-07-10T00:00:00.000Z',
        },
        paths,
      );
      const dispatchInstruction = vi.fn<
        NonNullable<SchedulerDependencies['dispatchInstruction']>
      >(async (input) => ({
        submissionId: 'submission:scheduled-health',
        sessionId: input.sessionId,
      }));

      await expect(
        runSchedulerTick(paths, new Date('2026-07-10T00:00:00.000Z'), {
          dispatchInstruction,
        }),
      ).resolves.toMatchObject({ ok: true, changed: true });
      expect(dispatchInstruction).toHaveBeenCalledOnce();
      expect(dispatchInstruction).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'instruction:daily-health',
          sessionId: expect.stringContaining(
            'scheduled-instruction:scheduled-task-run:',
          ),
          idempotencyKey: expect.stringContaining('scheduled-task-run:'),
        }),
      );
      await expect(
        readLatestScheduledTaskRun('instruction:daily-health', paths),
      ).resolves.toBeUndefined();

      await settleScheduledTaskSubmission(
        { submissionId: 'submission:scheduled-health', failed: false },
        paths,
      );
      await expect(
        readLatestScheduledTaskRun('instruction:daily-health', paths),
      ).resolves.toMatchObject({
        status: 'completed',
        submissionId: 'submission:scheduled-health',
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('claims one due occurrence, advances it before work, and records its terminal result', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-tasks-'));
    const paths = runtimePaths(home);
    try {
      await upsertScheduledTask(
        {
          id: 'watch:example#1',
          spec: { kind: 'poll-pr-watch', watchId: 'example#1' },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-07-10T00:00:00.000Z',
        },
        paths,
      );

      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-07-10T00:00:00.000Z'),
      );
      expect(claim).toMatchObject({
        task: {
          id: 'watch:example#1',
          nextRunAt: '2026-07-10T00:05:00.000Z',
          claimId: expect.any(String),
        },
        run: { taskId: 'watch:example#1', status: 'claimed' },
      });

      await settleScheduledTaskRun(
        {
          taskId: claim.task.id,
          runId: claim.run.id,
          claimId: claim.task.claimId ?? '',
          status: 'completed',
          outcome: 'recorded',
          message: 'Watch poll completed.',
          result: { changed: true },
        },
        paths,
      );

      await expect(
        readScheduledTask(claim.task.id, paths),
      ).resolves.toMatchObject({
        claimId: null,
        nextRunAt: '2026-07-10T00:05:00.000Z',
      });
      await expect(
        readLatestScheduledTaskRun(claim.task.id, paths),
      ).resolves.toMatchObject({
        id: claim.run.id,
        status: 'completed',
        result: { changed: true },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not overwrite a terminal run during repeated settlement', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-tasks-'));
    const paths = runtimePaths(home);
    try {
      await upsertScheduledTask(
        {
          id: 'watch:terminal-settlement',
          spec: { kind: 'poll-pr-watch', watchId: 'terminal-settlement' },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-07-10T00:00:00.000Z',
        },
        paths,
      );
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-07-10T00:00:00.000Z'),
      );
      if (!claim) throw new Error('Expected the due task to be claimed.');

      await expect(
        settleScheduledTaskRun(
          {
            taskId: claim.task.id,
            runId: claim.run.id,
            claimId: claim.task.claimId ?? '',
            status: 'completed',
            outcome: 'recorded',
            message: 'Original successful result.',
          },
          paths,
        ),
      ).resolves.toBe(true);
      await expect(
        settleScheduledTaskRun(
          {
            taskId: claim.task.id,
            runId: claim.run.id,
            claimId: claim.task.claimId ?? '',
            status: 'failed',
            outcome: 'failed',
            message: 'Late failure.',
            error: 'Late failure.',
          },
          paths,
        ),
      ).resolves.toBe(false);
      await expect(
        readLatestScheduledTaskRun(claim.task.id, paths),
      ).resolves.toMatchObject({
        status: 'completed',
        outcome: 'recorded',
        message: 'Original successful result.',
        error: null,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('disables a claimed one-shot task after recording the attempt', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-tasks-'));
    const paths = runtimePaths(home);
    try {
      await upsertScheduledTask(
        {
          id: 'briefing:once',
          spec: { kind: 'run-briefing', briefingId: 'morning' },
          trigger: { kind: 'once', at: '2026-07-10T00:00:00.000Z' },
          nextRunAt: '2026-07-10T00:00:00.000Z',
        },
        paths,
      );
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-07-10T00:00:00.000Z'),
      );
      expect(claim?.task).toMatchObject({ enabled: false, nextRunAt: null });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('recomputes the next occurrence when an existing trigger changes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-tasks-'));
    const paths = runtimePaths(home);
    try {
      await upsertScheduledTask(
        {
          id: 'briefing:change-trigger',
          spec: { kind: 'run-briefing', briefingId: 'daily' },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2030-01-01T00:00:00.000Z',
        },
        paths,
      );

      const updated = await upsertScheduledTask(
        {
          id: 'briefing:change-trigger',
          spec: { kind: 'run-briefing', briefingId: 'daily' },
          trigger: { kind: 'interval', everySeconds: 3_600 },
        },
        paths,
      );

      expect(updated.nextRunAt).not.toBe('2030-01-01T00:00:00.000Z');
      expect(Date.parse(updated.nextRunAt ?? '')).toBeGreaterThan(Date.now());
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('releases an unstarted claim back to its original task state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-tasks-'));
    const paths = runtimePaths(home);
    try {
      await upsertScheduledTask(
        {
          id: 'briefing:released',
          spec: { kind: 'run-briefing', briefingId: 'daily' },
          trigger: { kind: 'once', at: '2026-07-10T00:00:00.000Z' },
          nextRunAt: '2026-07-10T00:00:00.000Z',
        },
        paths,
      );
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-07-10T00:00:00.000Z'),
      );
      if (!claim) throw new Error('Expected the due task to be claimed.');
      await releaseUnstartedScheduledTaskClaim(
        {
          ...claim,
          message: 'Lease was lost before this task started.',
        },
        paths,
      );

      await expect(
        readScheduledTask(claim.task.id, paths),
      ).resolves.toMatchObject({
        enabled: true,
        nextRunAt: '2026-07-10T00:00:00.000Z',
        claimId: null,
      });
      await expect(
        readLatestScheduledTaskRun(claim.task.id, paths),
      ).resolves.toMatchObject({
        id: claim.run.id,
        status: 'failed',
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('retries an expired one-shot claim instead of discarding its only occurrence', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-tasks-'));
    const paths = runtimePaths(home);
    try {
      await upsertScheduledTask(
        {
          id: 'briefing:expired-claim',
          spec: { kind: 'run-briefing', briefingId: 'daily' },
          trigger: { kind: 'once', at: '2026-07-10T00:00:00.000Z' },
          nextRunAt: '2026-07-10T00:00:00.000Z',
        },
        paths,
      );
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-07-10T00:00:00.000Z'),
        10,
        1_000,
      );
      if (!claim) throw new Error('Expected the due task to be claimed.');

      const [retry] = await claimDueScheduledTasks(
        paths,
        new Date('2026-07-10T00:00:02.000Z'),
        10,
        1_000,
      );
      expect(retry).toMatchObject({
        task: { id: claim.task.id, claimId: expect.any(String) },
        run: { status: 'claimed' },
      });
      expect(retry?.run.id).not.toBe(claim.run.id);
      await expect(
        readScheduledTask(claim.task.id, paths),
      ).resolves.toMatchObject({
        enabled: false,
        claimId: expect.any(String),
      });
      await expect(
        readLatestScheduledTaskRun(claim.task.id, paths),
      ).resolves.toMatchObject({
        id: claim.run.id,
        status: 'failed',
        outcome: 'failed',
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('retries a persisted keyed admission without creating a second occurrence', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-tasks-'));
    const paths = runtimePaths(home);
    try {
      await upsertScheduledTask(
        {
          id: 'instruction:outbox-recovery',
          spec: {
            kind: 'run-agent-instruction',
            prompt: 'Inspect the repository.',
            target: { kind: 'agent' },
            skills: [],
          },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-07-10T00:00:00.000Z',
        },
        paths,
      );
      const attempts: Array<
        Parameters<NonNullable<SchedulerDependencies['dispatchInstruction']>>[0]
      > = [];
      const dispatchInstruction = vi.fn<
        NonNullable<SchedulerDependencies['dispatchInstruction']>
      >(async (input) => {
        attempts.push(input);
        if (attempts.length === 1)
          throw new Error('connection closed after accept');
        return {
          submissionId: 'submission:outbox-recovery',
          sessionId: input.sessionId,
        };
      });
      const readInstructionSettlement = vi.fn<
        NonNullable<SchedulerDependencies['readInstructionSettlement']>
      >(async () => ({ failed: false }));

      await runSchedulerTick(paths, new Date('2026-07-10T00:00:00.000Z'), {
        dispatchInstruction,
        readInstructionSettlement,
      });
      await expect(
        canAdmitScheduledSubmission('instruction:outbox-recovery', paths),
      ).resolves.toBe(false);

      await runSchedulerTick(paths, new Date('2026-07-10T00:00:01.000Z'), {
        dispatchInstruction,
        readInstructionSettlement,
      });
      expect(dispatchInstruction).toHaveBeenCalledTimes(2);
      expect(attempts[1]).toEqual(attempts[0]);
      expect(attempts[0]?.idempotencyKey).toMatch(/^scheduled-task-run:/);
      await vi.waitFor(async () => {
        await expect(
          readLatestScheduledTaskRun('instruction:outbox-recovery', paths),
        ).resolves.toMatchObject({
          status: 'completed',
          submissionId: 'submission:outbox-recovery',
          sessionId: attempts[0]?.sessionId,
          result: {
            submissionId: 'submission:outbox-recovery',
            sessionId: attempts[0]?.sessionId,
          },
        });
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('holds workflow capacity until the terminal Flue observation settles it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-tasks-'));
    const paths = runtimePaths(home);
    try {
      await upsertScheduledTask(
        {
          id: 'briefing:active-workflow',
          spec: { kind: 'run-briefing', briefingId: 'daily' },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-07-10T00:00:00.000Z',
        },
        paths,
      );
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-07-10T00:00:00.000Z'),
      );
      if (!claim) throw new Error('Expected the due task to be claimed.');
      await activateScheduledTaskSubmission(
        {
          taskId: claim.task.id,
          runId: claim.run.id,
          claimId: claim.task.claimId ?? '',
          sessionId: 'briefing-daily',
          dispatchKey: claim.run.id,
          dispatchPayload: { prompt: 'Daily briefing.', taskId: claim.task.id },
        },
        paths,
      );
      await attachScheduledTaskSubmissionId(
        { runId: claim.run.id, submissionId: 'workflow:briefing:active' },
        paths,
      );

      await expect(
        canAdmitScheduledSubmission(claim.task.id, paths),
      ).resolves.toBe(false);
      await expect(
        canAdmitScheduledSubmission('briefing:another-task', paths, 1),
      ).resolves.toBe(false);
      await settleScheduledTaskSubmission(
        { submissionId: 'workflow:briefing:active', failed: false },
        paths,
      );
      await expect(
        canAdmitScheduledSubmission(claim.task.id, paths),
      ).resolves.toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('admits due briefings and retains submission correlation until settlement', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-tasks-'));
    const paths = runtimePaths(home);
    try {
      await upsertScheduledTask(
        {
          id: 'briefing:daily',
          spec: { kind: 'run-briefing', briefingId: 'daily' },
          trigger: { kind: 'interval', everySeconds: 3_600 },
          nextRunAt: '2026-07-10T00:00:00.000Z',
        },
        paths,
      );
      await expect(
        runSchedulerTick(paths, new Date('2026-07-10T00:00:00.000Z'), {
          admitBriefing: (async (
            input: {
              profileId: string;
              trigger: 'scheduled';
              scheduledTaskRunId: string;
            },
            actualPaths: ReturnType<typeof runtimePaths>,
          ) => {
            expect(input).toMatchObject({
              profileId: 'daily',
              trigger: 'scheduled',
              scheduledTaskRunId: expect.stringMatching(/^scheduled-task-run:/),
            });
            expect(actualPaths).toBe(paths);
            return {
              id: 'briefing:daily:1',
              dispatchId: 'submission:briefing:1',
              sessionId: 'briefing-session',
            };
          }) as never,
        }),
      ).resolves.toMatchObject({
        ok: true,
        changed: true,
        outcome: 'updated',
        tasks: [expect.objectContaining({ id: 'briefing:daily' })],
      });
      await expect(
        canAdmitScheduledSubmission('briefing:daily', paths),
      ).resolves.toBe(false);
      await settleScheduledTaskSubmission(
        { submissionId: 'submission:briefing:1', failed: false },
        paths,
      );
      await expect(
        readLatestScheduledTaskRun('briefing:daily', paths),
      ).resolves.toMatchObject({
        status: 'completed',
        outcome: 'recorded',
        submissionId: 'submission:briefing:1',
        sessionId: 'briefing-session',
        result: {
          briefingRunId: 'briefing:daily:1',
          submissionId: 'submission:briefing:1',
        },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('recovers a scheduled briefing admitted before scheduler correlation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-tasks-'));
    const paths = runtimePaths(home);
    try {
      await upsertScheduledTask(
        {
          id: 'briefing:morning',
          spec: { kind: 'run-briefing', briefingId: 'morning' },
          trigger: { kind: 'interval', everySeconds: 3_600 },
          nextRunAt: '2026-07-10T00:00:00.000Z',
        },
        paths,
      );
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-07-10T00:00:00.000Z'),
      );
      const briefing = await admitBriefing(
        {
          profileId: 'morning',
          trigger: 'scheduled',
          scheduledTaskRunId: claim.run.id,
        },
        paths,
        {
          dispatchAgent: async () => ({
            submissionId: 'submission:briefing:recovered',
            acceptedAt: new Date().toISOString(),
            uid: 'briefing-recovery-test',
          }),
        },
      );

      await runSchedulerTick(paths, new Date('2026-07-10T00:00:01.000Z'));
      await expect(
        canAdmitScheduledSubmission('briefing:morning', paths),
      ).resolves.toBe(false);

      await settleBriefingObservation(
        {
          type: 'submission_settled',
          v: 3,
          eventIndex: 1,
          timestamp: new Date().toISOString(),
          instanceId: briefing.sessionId,
          submissionId: briefing.dispatchId!,
          outcome: 'completed',
        } as Extract<FlueObservation, { type: 'submission_settled' }>,
        paths,
      );
      await expect(
        readLatestScheduledTaskRun('briefing:morning', paths),
      ).resolves.toMatchObject({
        status: 'completed',
        submissionId: 'submission:briefing:recovered',
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('defers a scheduled briefing when its conversation is already active', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-tasks-'));
    const paths = runtimePaths(home);
    try {
      await upsertScheduledTask(
        {
          id: 'briefing:morning',
          spec: { kind: 'run-briefing', briefingId: 'morning' },
          trigger: { kind: 'once', at: '2026-07-10T00:00:00.000Z' },
          nextRunAt: '2026-07-10T00:00:00.000Z',
        },
        paths,
      );

      await runSchedulerTick(paths, new Date('2026-07-10T00:00:00.000Z'), {
        admitBriefing: (async () => {
          throw new BriefingAdmissionConflictError(
            'briefing:active',
            'briefing-session',
          );
        }) as never,
      });

      await expect(
        readLatestScheduledTaskRun('briefing:morning', paths),
      ).resolves.toMatchObject({
        status: 'completed',
        outcome: 'silent',
        message: expect.stringContaining('was deferred'),
      });
      await expect(
        readScheduledTask('briefing:morning', paths),
      ).resolves.toMatchObject({
        enabled: true,
        nextRunAt: expect.any(String),
        claimId: null,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps a successful task terminal when notification persistence fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-tasks-'));
    const paths = runtimePaths(home);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await upsertScheduledTask(
        {
          id: 'watch:notification-failure',
          spec: { kind: 'poll-pr-watch', watchId: 'notification-failure' },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-07-10T00:00:00.000Z',
        },
        paths,
      );

      await expect(
        runSchedulerTick(paths, new Date('2026-07-10T00:00:00.000Z'), {
          addNotification: async () => {
            throw new Error('notification database write failed');
          },
          refreshPrWatch: async () => ({
            ok: true,
            action: 'watch_pr_refresh',
            changed: true,
            outcome: 'updated',
            id: 'notification-failure',
            message: 'Watch changed.',
            watch: {
              id: 'notification-failure',
              repoFullName: 'pandemicsyn/neondeck',
              prNumber: 157,
              status: 'green',
              prState: 'open',
              lastSnapshot: {
                merged: false,
                checks: {
                  status: 'success',
                  total: 1,
                  failed: 0,
                  pending: 0,
                },
              },
            },
          }),
          refreshPrWatchEventState: async () =>
            ({ ok: true, changed: false, message: 'No changes.' }) as never,
        }),
      ).resolves.toMatchObject({ ok: true, outcome: 'updated' });
      await expect(
        readLatestScheduledTaskRun('watch:notification-failure', paths),
      ).resolves.toMatchObject({
        status: 'completed',
        outcome: 'recorded',
        message: 'Updated 1 PR watch.',
      });
      expect(warn).toHaveBeenCalledWith(
        '[neondeck] failed to persist scheduled task notification',
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('creates only validated typed briefing and instruction payloads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-tasks-'));
    const paths = runtimePaths(home);
    try {
      await expect(
        createBriefingTask(
          {
            id: 'morning',
            trigger: {
              kind: 'cron',
              expression: '0 9 * * 1-5',
              timezone: 'America/Chicago',
            },
          },
          paths,
        ),
      ).resolves.toMatchObject({
        ok: true,
        task: {
          id: 'briefing:morning',
          spec: { kind: 'run-briefing', briefingId: 'morning' },
        },
      });
      await expect(
        createAgentInstructionTask(
          {
            prompt:
              'Inspect the configured repository and report stale branches.',
            trigger: { kind: 'interval', everySeconds: 43_200 },
            target: { kind: 'agent' },
            skills: [],
          },
          paths,
        ),
      ).resolves.toMatchObject({
        ok: true,
        task: {
          id: expect.stringMatching(/^instruction:/),
          spec: {
            kind: 'run-agent-instruction',
            target: { kind: 'agent' },
          },
        },
      });
      await expect(
        createAgentInstructionTask(
          {
            prompt: 'Use continuity for this scheduled check.',
            trigger: { kind: 'interval', everySeconds: 3_600 },
            target: { kind: 'agent-session', sessionId: 'missing-session' },
          },
          paths,
        ),
      ).resolves.toMatchObject({ ok: false, requires: ['activeChatSession'] });
      const sessionResult = await createChatSession(
        { title: 'Scheduled instruction continuity', activate: false },
        paths,
      );
      const session = (sessionResult as { session: { id: string } }).session;
      await expect(
        createAgentInstructionTask(
          {
            prompt: 'Use continuity for this scheduled check.',
            trigger: { kind: 'interval', everySeconds: 3_600 },
            target: { kind: 'agent-session', sessionId: session.id },
          },
          paths,
        ),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
