import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claimDueScheduledTasks,
  createAgentInstructionTask,
  createBriefingTask,
  nextOccurrence,
  readLatestScheduledTaskRun,
  readScheduledTask,
  releaseUnstartedScheduledTaskClaim,
  settleScheduledTaskRun,
  upsertScheduledTask,
  validateAutomationTrigger,
} from './modules/scheduled-tasks';
import { runSchedulerTick } from './modules/scheduler';
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

  it('admits due briefings through Flue and settles the scheduling attempt', async () => {
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
          invokeWorkflow: async (workflow, input) => {
            expect(workflow).toBe('briefing');
            expect(input).toEqual({});
            return { runId: 'workflow:briefing:1' };
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        changed: true,
        outcome: 'updated',
        tasks: [expect.objectContaining({ id: 'briefing:daily' })],
      });
      await expect(
        readLatestScheduledTaskRun('briefing:daily', paths),
      ).resolves.toMatchObject({
        status: 'completed',
        workflowRunId: 'workflow:briefing:1',
      });
    } finally {
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
            id: 'instruction:nightly',
            prompt:
              'Inspect the configured repository and report stale branches.',
            trigger: { kind: 'interval', everySeconds: 43_200 },
            target: { kind: 'workflow' },
            skills: [],
          },
          paths,
        ),
      ).resolves.toMatchObject({
        ok: true,
        task: {
          id: 'instruction:nightly',
          spec: {
            kind: 'run-agent-instruction',
            target: { kind: 'workflow' },
          },
        },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
