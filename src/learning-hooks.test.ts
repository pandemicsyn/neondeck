import type { FlueObservation, FlueObservationSubscriber } from '@flue/runtime';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addWorkflowSummary, listWorkflowSummaries } from './modules/app-state';
import { extractHandledPrEvent } from './modules/learning/reviews/pr-context';
import {
  claimAutopilotTriageAdmission,
  coordinateAutopilotAdmission,
  listAutopilotAdmissions,
  listAutopilotStageAttempts,
  type AutopilotWorkflowInvoker,
} from './modules/autopilot';
import {
  activateScheduledTaskWorkflowRun,
  attachScheduledTaskWorkflowRunId,
  claimDueScheduledTasks,
  readLatestScheduledTaskRun,
  upsertScheduledTask,
} from './modules/scheduled-tasks';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import {
  attachCommandRunSummaryRunId,
  autopilotOwnerTerminalFact,
  installFlueObservationHandlers,
  resetFlueObservationHandlersForTests,
} from './server/learning-hooks';

const tempRoots: string[] = [];

afterEach(async () => {
  resetFlueObservationHandlersForTests();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Flue learning hooks', () => {
  it('accepts a correlated owner terminal fact when optional agentName is omitted', () => {
    expect(
      autopilotOwnerTerminalFact({
        v: 3,
        type: 'agent_end',
        eventIndex: 2,
        timestamp: '2026-07-19T00:00:01.000Z',
        dispatchId: 'dispatch:owner',
        instanceId: 'instance:owner',
        durationMs: 100,
        messages: [],
      } as FlueObservation & { type: 'agent_end' }),
    ).toMatchObject({
      instanceId: 'instance:owner',
      dispatchId: 'dispatch:owner',
      failed: false,
    });
  });

  it('installs one observation subscriber per runtime home', () => {
    const subscribers: unknown[] = [];
    const unsubscribers = [vi.fn<() => void>(), vi.fn<() => void>()];
    const observe = vi.fn<
      (subscriber: FlueObservationSubscriber) => () => void
    >((subscriber: FlueObservationSubscriber): (() => void) => {
      subscribers.push(subscriber);
      return unsubscribers[subscribers.length - 1] ?? vi.fn<() => void>();
    });

    installFlueObservationHandlers(runtimePaths('/tmp/neondeck-a'), {
      observe,
    });
    installFlueObservationHandlers(runtimePaths('/tmp/neondeck-a'), {
      observe,
    });
    installFlueObservationHandlers(runtimePaths('/tmp/neondeck-b'), {
      observe,
    });

    expect(observe).toHaveBeenCalledTimes(2);
    expect(subscribers).toHaveLength(2);

    resetFlueObservationHandlersForTests();

    expect(unsubscribers[0]).toHaveBeenCalledTimes(1);
    expect(unsubscribers[1]).toHaveBeenCalledTimes(1);
  });

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

  it('uses the actual Flue run id for ci_fix_run summaries', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-learning-hooks-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const summary = await addWorkflowSummary(
      {
        workflow: 'ci_fix_run',
        runId: 'ci-fix-synthetic-kilo-task',
        status: 'completed',
        summary: {
          outcome: 'no-op',
          kiloTaskId: 'ci-fix-synthetic-kilo-task',
        },
      },
      paths,
    );

    await attachCommandRunSummaryRunId(
      ciFixRunEndObservation({
        workflowSummary: {
          id: summary.id,
          workflow: 'ci_fix_run',
          runId: 'ci-fix-synthetic-kilo-task',
        },
      }),
      paths,
    );

    await expect(listWorkflowSummaries(paths)).resolves.toEqual([
      expect.objectContaining({
        id: summary.id,
        workflow: 'ci_fix_run',
        runId: 'actual-fix-pr-ci-run',
      }),
    ]);
  });

  it('extracts handled PR learning events from ci_fix_run workflow results', () => {
    expect(
      extractHandledPrEvent({
        workflow: 'fix-pr-ci',
        runId: 'actual-fix-pr-ci-run',
        result: {
          ok: true,
          action: 'ci_fix_run',
          changed: true,
          message: 'Queued CI fix for pandemicsyn/neondeck#88.',
          data: {
            workflow: 'fix-pr-ci',
            outcome: 'kilo-started',
            dossier: {
              repo: 'pandemicsyn/neondeck',
              prNumber: 88,
              headSha: 'abc123',
              failedCheckCount: 1,
            },
            kiloTaskId: 'ci-fix-task-1',
            worktreeId: 'worktree-1',
          },
        },
      }),
    ).toMatchObject({
      eventType: 'ci-failure-workflow-completed',
      source: 'fix-pr-ci',
      sourceId:
        'pandemicsyn/neondeck#88:ci-failure-workflow-completed:ci-fix-task-1',
      repoFullName: 'pandemicsyn/neondeck',
      prNumber: 88,
      data: expect.objectContaining({
        action: 'ci_fix_run',
        workflow: 'fix-pr-ci',
        taskId: 'ci-fix-task-1',
        worktreeId: 'worktree-1',
      }),
    });
  });

  it('settles a scheduled workflow even when observation persistence fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-learning-hooks-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    await upsertScheduledTask(
      {
        id: 'briefing:observation-failure',
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
    await activateScheduledTaskWorkflowRun(
      {
        taskId: claim.task.id,
        runId: claim.run.id,
        claimId: claim.task.claimId ?? '',
      },
      paths,
    );
    await attachScheduledTaskWorkflowRunId(
      {
        runId: claim.run.id,
        workflowRunId: 'workflow:observation-failure',
      },
      paths,
    );

    let subscriber: FlueObservationSubscriber | undefined;
    installFlueObservationHandlers(paths, {
      observe(next) {
        subscriber = next;
        return vi.fn<() => void>();
      },
      recordFlueObservation: vi.fn<() => Promise<never>>(async () => {
        throw new Error('observation write failed');
      }),
    });

    subscriber?.(
      {
        v: 3,
        type: 'run_end',
        eventIndex: 2,
        timestamp: '2026-07-10T00:00:01.000Z',
        runId: 'workflow:observation-failure',
        workflow: 'briefing',
        durationMs: 1_000,
        isError: false,
        result: { ok: true },
      } as FlueObservation,
      {} as never,
    );

    await vi.waitFor(async () => {
      await expect(
        readLatestScheduledTaskRun(claim.task.id, paths),
      ).resolves.toMatchObject({ id: claim.run.id, status: 'completed' });
    });
  });

  it('routes observer and scheduler continuation races through one prepare reservation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-learning-hooks-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    const limits = {
      maxAutonomousJobs: 2,
      maxActiveWorkflowRuns: 2,
      maxPerRepoAutonomousJobs: 2,
      singleMutationPerPr: true,
      localExecutionLimit: 1,
    };
    const admitted = await claimAutopilotTriageAdmission(
      {
        watchId: 'watch:observer-race',
        eventFingerprint: 'event:observer-race',
        repoId: 'repo',
        prNumber: 42,
        mode: 'prepare-only',
        input: { eventId: 'event:observer-race' },
        limits,
      },
      paths,
    );
    await coordinateAutopilotAdmission(
      {
        admissionId: admitted.admission.id,
        limits,
        invokeWorkflow: async () => ({ runId: 'run:observer-triage' }),
      },
      paths,
    );

    let subscriber: FlueObservationSubscriber | undefined;
    const invokeAutopilotWorkflow = vi.fn<AutopilotWorkflowInvoker>(
      async () => ({ runId: 'run:observer-prepare' }),
    );
    installFlueObservationHandlers(paths, {
      observe(next) {
        subscriber = next;
        return vi.fn<() => void>();
      },
      invokeAutopilotWorkflow,
      autopilotConcurrency: limits,
    });

    subscriber?.(
      {
        v: 3,
        type: 'run_end',
        eventIndex: 2,
        timestamp: '2026-07-19T00:00:01.000Z',
        runId: 'run:observer-triage',
        workflow: 'triage-pr-event',
        durationMs: 1_000,
        isError: false,
        result: {
          ok: true,
          data: { shouldPrepareWorktree: true },
        },
      } as FlueObservation,
      {} as never,
    );
    await coordinateAutopilotAdmission(
      {
        admissionId: admitted.admission.id,
        limits,
        invokeWorkflow: invokeAutopilotWorkflow,
      },
      paths,
    );

    await vi.waitFor(() =>
      expect(invokeAutopilotWorkflow).toHaveBeenCalledTimes(1),
    );
    await expect(
      listAutopilotStageAttempts({ admissionId: admitted.admission.id }, paths),
    ).resolves.toEqual([
      expect.objectContaining({ stage: 'triage', status: 'completed' }),
      expect.objectContaining({
        stage: 'prepare-worktree',
        status: 'running',
        runId: 'run:observer-prepare',
      }),
    ]);
  });

  it('preserves bounded action failure details for autopilot retry classification', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-learning-hooks-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    const limits = {
      maxAutonomousJobs: 2,
      maxActiveWorkflowRuns: 2,
      maxPerRepoAutonomousJobs: 2,
      singleMutationPerPr: true,
      localExecutionLimit: 1,
    };
    const admitted = await claimAutopilotTriageAdmission(
      {
        watchId: 'watch:action-failure',
        eventFingerprint: 'event:action-failure',
        repoId: 'repo',
        prNumber: 43,
        mode: 'prepare-only',
        input: { eventId: 'event:action-failure' },
        limits,
      },
      paths,
    );
    const errors = Array.from({ length: 10_000 }, () => ({}));
    errors[7] = 'x'.repeat(5_000);
    await coordinateAutopilotAdmission(
      {
        admissionId: admitted.admission.id,
        limits,
        invokeWorkflow: async () => ({ runId: 'run:action-failure' }),
      },
      paths,
    );

    let subscriber: FlueObservationSubscriber | undefined;
    installFlueObservationHandlers(paths, {
      observe(next) {
        subscriber = next;
        return vi.fn<() => void>();
      },
      autopilotConcurrency: limits,
    });
    subscriber?.(
      {
        v: 3,
        type: 'run_end',
        eventIndex: 2,
        timestamp: '2026-07-19T00:00:01.000Z',
        runId: 'run:action-failure',
        workflow: 'triage-pr-event',
        durationMs: 1_000,
        isError: false,
        result: {
          ok: false,
          error: {
            code: 'credentials-missing',
          },
          errors,
        },
      } as FlueObservation,
      {} as never,
    );

    await vi.waitFor(async () => {
      await expect(listAutopilotAdmissions(paths)).resolves.toEqual([
        expect.objectContaining({
          id: admitted.admission.id,
          state: 'blocked',
          lastOutcome: expect.objectContaining({
            errorCode: 'credentials-missing',
            message: 'x'.repeat(4_096),
          }),
        }),
      ]);
    });
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

function ciFixRunEndObservation(result: unknown): FlueObservation {
  return {
    v: 3,
    type: 'run_end',
    eventIndex: 2,
    timestamp: '2026-07-05T20:30:00.000Z',
    runId: 'actual-fix-pr-ci-run',
    workflow: 'fix-pr-ci',
    durationMs: 1_000,
    isError: false,
    result,
  } as unknown as FlueObservation;
}
