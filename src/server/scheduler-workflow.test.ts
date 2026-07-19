import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readWorkflowObservability,
  recordFlueObservation,
} from '../modules/learning/observability';
import { runtimePaths } from '../runtime-home';
import {
  errorMessageWithCauses,
  runObservedSchedulerTick,
} from './scheduler-workflow';

describe('observed scheduler workflow', () => {
  it('expires a stale app projection before admitting a replacement tick', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduler-workflow-'));
    const paths = runtimePaths(home);
    try {
      await recordFlueObservation(
        {
          v: 3,
          type: 'run_start',
          eventIndex: 1,
          timestamp: '2026-07-10T00:00:00.000Z',
          runId: 'scheduler-run:stale',
          workflowName: 'scheduler-tick',
          input: { runtimeHome: paths.home },
        } as never,
        paths,
      );

      await expect(
        runObservedSchedulerTick(paths, {
          activeRunTtlMs: 1_000,
          now: () => new Date('2026-07-10T00:10:00.000Z'),
          listRuns: (async () => ({
            runs: [{ runId: 'scheduler-run:stale' }],
          })) as never,
          getRun: (async (runId: string) =>
            runId === 'scheduler-run:stale'
              ? {
                  runId,
                  workflowName: 'scheduler-tick',
                  status: 'active',
                  startedAt: '2026-07-10T00:00:00.000Z',
                  input: { runtimeHome: paths.home },
                }
              : {
                  runId,
                  workflowName: 'scheduler-tick',
                  status: 'completed',
                  startedAt: '2026-07-10T00:10:00.000Z',
                  completedAt: '2026-07-10T00:10:00.010Z',
                  input: { runtimeHome: paths.home },
                  result: {
                    ok: true,
                    action: 'scheduler_tick',
                    changed: false,
                    outcome: 'silent',
                    message: 'No scheduled tasks were due.',
                  },
                }) as never,
          invokeWorkflow: async () =>
            ({ runId: 'scheduler-run:replacement' }) as never,
        }),
      ).resolves.toMatchObject({
        ok: true,
        runId: 'scheduler-run:replacement',
      });

      await expect(readWorkflowObservability(paths)).resolves.toMatchObject({
        activeRuns: [],
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preserves nested workflow admission causes for diagnostics', () => {
    expect(
      errorMessageWithCauses(
        new Error('Workflow admission failed.', {
          cause: new Error('database is locked'),
        }),
      ),
    ).toBe('Workflow admission failed.: database is locked');
  });
});
