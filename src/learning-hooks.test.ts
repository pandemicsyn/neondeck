import type { FlueObservation } from '@flue/runtime';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addWorkflowSummary, listWorkflowSummaries } from './modules/app-state';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { attachCommandRunSummaryRunId } from './server/learning-hooks';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Flue learning hooks', () => {
  it('preserves the admitted review workflow run id for review-pr command summaries', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-learning-hooks-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const summary = await addWorkflowSummary(
      {
        workflow: 'command:review-pr',
        runId: 'review-pr-for-human-run',
        status: 'completed',
        summary: { message: 'Queued review workflow.' },
      },
      paths,
    );

    await attachCommandRunSummaryRunId(
      commandRunEndObservation({
        workflowSummary: {
          id: summary.id,
          runId: 'review-pr-for-human-run',
        },
        data: { runId: 'review-pr-for-human-run' },
      }),
      paths,
    );

    await expect(listWorkflowSummaries(paths)).resolves.toEqual([
      expect.objectContaining({
        id: summary.id,
        workflow: 'command:review-pr',
        runId: 'review-pr-for-human-run',
      }),
    ]);
  });

  it('uses command result run id when the summary row has not been linked yet', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-learning-hooks-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const summary = await addWorkflowSummary(
      {
        workflow: 'command:review-pr',
        status: 'completed',
        summary: { message: 'Queued review workflow.' },
      },
      paths,
    );

    await attachCommandRunSummaryRunId(
      commandRunEndObservation({
        workflowSummary: { id: summary.id },
        data: { runId: 'review-pr-for-human-run' },
      }),
      paths,
    );

    await expect(listWorkflowSummaries(paths)).resolves.toEqual([
      expect.objectContaining({
        id: summary.id,
        workflow: 'command:review-pr',
        runId: 'review-pr-for-human-run',
      }),
    ]);
  });
});

function commandRunEndObservation(result: unknown): FlueObservation {
  return {
    v: 3,
    type: 'run_end',
    eventIndex: 2,
    timestamp: '2026-07-05T20:30:00.000Z',
    runId: 'outer-command-run',
    workflow: 'command-run',
    durationMs: 1_000,
    isError: false,
    result,
  } as unknown as FlueObservation;
}
