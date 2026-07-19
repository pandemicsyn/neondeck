import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  advanceAutopilotAdmission,
  autopilotAdmissionStates,
  autopilotModeProgression,
  autopilotRetryBackoffMs,
  autopilotRetryDecision,
  claimAutopilotTriageAdmission,
  classifyAutopilotRetry,
  coordinateAutopilotAdmission,
  isLegalAutopilotTransition,
  legalAutopilotTransitions,
  listAutopilotAdmissionEvents,
  listAutopilotAdmissions,
  listAutopilotAdmissionsNeedingAdvance,
  listAutopilotPrOwners,
  listAutopilotStageAttempts,
  reconcileAutopilotStageAttempts,
  recordAutopilotStageTerminalObservation,
  stopAutopilotAdmission,
  supersedeAutopilotAdmission,
  type AutopilotWorkflowInvoker,
} from './modules/autopilot';
import { runtimePaths } from './runtime-home';

const limits = {
  maxAutonomousJobs: 4,
  maxActiveWorkflowRuns: 4,
  maxPerRepoAutonomousJobs: 4,
  singleMutationPerPr: true,
  localExecutionLimit: 1,
};

describe('autopilot transition contract', () => {
  it('exhaustively accepts only table-declared state transitions', () => {
    for (const from of autopilotAdmissionStates) {
      for (const to of autopilotAdmissionStates) {
        expect(isLegalAutopilotTransition(from, to)).toBe(
          legalAutopilotTransitions[from].includes(to as never),
        );
      }
    }
    expect(Object.keys(legalAutopilotTransitions).sort()).toEqual(
      [...autopilotAdmissionStates].sort(),
    );
  });

  it('defines a complete and truthful mode progression table', () => {
    expect(Object.keys(autopilotModeProgression).sort()).toEqual([
      'autofix-push-when-safe',
      'autofix-with-approval',
      'notify-only',
      'prepare-only',
    ]);
    expect(autopilotModeProgression['notify-only'].ownerTurn).toBe(false);
    expect(autopilotModeProgression['prepare-only'].push).toBe(false);
    expect(autopilotModeProgression['autofix-with-approval'].approval).toBe(
      true,
    );
    expect(autopilotModeProgression['autofix-push-when-safe'].push).toBe(
      'when-safe',
    );
  });
});

describe('autopilot retry policy', () => {
  it('classifies permanent, transient, and uncertain failures', () => {
    expect(classifyAutopilotRetry({ code: 'credentials-missing' }).kind).toBe(
      'permanent',
    );
    expect(classifyAutopilotRetry({ code: 'network-error' }).kind).toBe(
      'transient',
    );
    expect(classifyAutopilotRetry({ effectMayHaveCompleted: true }).kind).toBe(
      'uncertain',
    );
  });

  it('uses bounded backoff and stops after five stage attempts', () => {
    const now = new Date('2026-07-19T00:00:00.000Z');
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const decision = autopilotRetryDecision(
        attempt,
        { kind: 'transient', code: 'network-error', reason: 'retry' },
        now,
      );
      expect(decision).toEqual({
        automatic: true,
        nextAttemptAt: new Date(
          now.getTime() + autopilotRetryBackoffMs[attempt - 1],
        ).toISOString(),
        exhausted: false,
      });
    }
    expect(
      autopilotRetryDecision(
        5,
        { kind: 'transient', code: 'network-error', reason: 'retry' },
        now,
      ),
    ).toEqual({ automatic: false, nextAttemptAt: null, exhausted: true });
  });
});

describe('durable autopilot coordination', () => {
  it('preserves watch → triage → prepare through one coordinator and early observations', async () => {
    await withHome(async (paths) => {
      const admitted = await admit(paths, 'watch:one', 'event:one', 1);
      const invocations: string[] = [];
      const invokeWorkflow = vi.fn<AutopilotWorkflowInvoker>(
        async (workflow) => {
          invocations.push(workflow);
          const runId = `run:${workflow}`;
          await recordAutopilotStageTerminalObservation(
            {
              runId,
              observation:
                workflow === 'triage-pr-event'
                  ? { workflow, failed: false, shouldPrepare: true }
                  : {
                      workflow,
                      failed: false,
                      worktreeId: 'worktree:prepared',
                    },
            },
            paths,
          );
          return { runId };
        },
      );

      await coordinateAutopilotAdmission(
        {
          admissionId: admitted.admission.id,
          limits,
          invokeWorkflow,
        },
        paths,
      );

      expect(invocations).toEqual(['triage-pr-event', 'prepare-pr-worktree']);
      await expect(listAutopilotAdmissions(paths)).resolves.toEqual([
        expect.objectContaining({
          state: 'prepared',
          version: 4,
          worktreeId: 'worktree:prepared',
        }),
      ]);
      await expect(
        listAutopilotStageAttempts(
          { admissionId: admitted.admission.id },
          paths,
        ),
      ).resolves.toEqual([
        expect.objectContaining({ stage: 'triage', status: 'completed' }),
        expect.objectContaining({
          stage: 'prepare-worktree',
          status: 'completed',
        }),
      ]);
      const events = await listAutopilotAdmissionEvents(
        admitted.admission.id,
        paths,
      );
      expect(events.map((event) => event.reason)).toEqual(
        expect.arrayContaining([
          'event-admitted',
          'stage-dispatch-claimed',
          'stage-dispatched',
          'triage-completed',
          'triage-requested-prepare',
          'worktree-prepared',
        ]),
      );
    });
  });

  it('lets scheduler and observer race without dispatching a reserved stage twice', async () => {
    await withHome(async (paths) => {
      const admitted = await admit(paths, 'watch:race', 'event:race', 2);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const invokeWorkflow = vi.fn<AutopilotWorkflowInvoker>(async () => {
        await gate;
        return { runId: 'run:race' };
      });

      const scheduler = coordinateAutopilotAdmission(
        { admissionId: admitted.admission.id, limits, invokeWorkflow },
        paths,
      );
      const observer = coordinateAutopilotAdmission(
        { admissionId: admitted.admission.id, limits, invokeWorkflow },
        paths,
      );
      await vi.waitFor(() => expect(invokeWorkflow).toHaveBeenCalledTimes(1));
      release();
      await Promise.all([scheduler, observer]);
      expect(invokeWorkflow).toHaveBeenCalledTimes(1);
      await expect(
        listAutopilotStageAttempts(
          { admissionId: admitted.admission.id },
          paths,
        ),
      ).resolves.toEqual([
        expect.objectContaining({ status: 'running', runId: 'run:race' }),
      ]);
    });
  });

  it('settles the first durable terminal fact when observation precedes receipt registration', async () => {
    await withHome(async (paths) => {
      const admitted = await admit(
        paths,
        'watch:receipt-race',
        'event:receipt-race',
        21,
      );
      await recordAutopilotStageTerminalObservation(
        {
          runId: 'run:receipt-race',
          observation: {
            workflow: 'triage-pr-event',
            failed: false,
            shouldPrepare: true,
          },
        },
        paths,
      );
      await recordAutopilotStageTerminalObservation(
        {
          runId: 'run:receipt-race',
          observation: {
            workflow: 'triage-pr-event',
            failed: true,
            error: 'conflicting duplicate observation',
          },
        },
        paths,
      );
      const invokeWorkflow = vi
        .fn<AutopilotWorkflowInvoker>()
        .mockResolvedValueOnce({ runId: 'run:receipt-race' })
        .mockResolvedValueOnce({ runId: 'run:receipt-prepare' });

      await coordinateAutopilotAdmission(
        { admissionId: admitted.admission.id, limits, invokeWorkflow },
        paths,
      );

      expect(invokeWorkflow).toHaveBeenCalledTimes(2);
      await expect(listAutopilotAdmissions(paths)).resolves.toEqual([
        expect.objectContaining({
          state: 'prepare-admitted',
          currentRunId: 'run:receipt-prepare',
          lastError: null,
        }),
      ]);
    });
  });

  it('does not attach or advance a receipt that loses the stop CAS', async () => {
    await withHome(async (paths) => {
      const admitted = await admit(
        paths,
        'watch:receipt-cas',
        'event:receipt-cas',
        22,
      );
      const invokeWorkflow = vi.fn<AutopilotWorkflowInvoker>(async () => {
        await stopAutopilotAdmission(
          { admissionId: admitted.admission.id },
          paths,
        );
        return { runId: 'run:receipt-cas' };
      });

      const coordination = await coordinateAutopilotAdmission(
        { admissionId: admitted.admission.id, limits, invokeWorkflow },
        paths,
      );
      expect(coordination.dispatched).toMatchObject({
        status: 'orphaned-receipt',
        runId: 'run:receipt-cas',
        attempt: { status: 'cancelled', runId: 'run:receipt-cas' },
      });
      await expect(
        recordAutopilotStageTerminalObservation(
          {
            runId: 'run:receipt-cas',
            observation: {
              workflow: 'triage-pr-event',
              failed: false,
              shouldPrepare: true,
            },
          },
          paths,
        ),
      ).resolves.toMatchObject({ status: 'stale-or-duplicate' });
      await expect(listAutopilotAdmissions(paths)).resolves.toEqual([
        expect.objectContaining({
          state: 'stopped',
          currentRunId: null,
          currentStageAttemptId: null,
        }),
      ]);
    });
  });

  it('moves a current orphaned receipt to manual review instead of stranding it', async () => {
    await withHome(async (paths) => {
      const admitted = await admit(
        paths,
        'watch:orphaned-receipt',
        'event:orphaned-receipt',
        24,
      );
      const invokeWorkflow = vi.fn<AutopilotWorkflowInvoker>(async () => {
        const database = new DatabaseSync(paths.neondeckDatabase);
        try {
          database
            .prepare(
              `UPDATE autopilot_admissions
               SET version = version + 1 WHERE id = ?;`,
            )
            .run(admitted.admission.id);
        } finally {
          database.close();
        }
        return { runId: 'run:orphaned-current' };
      });

      await expect(
        coordinateAutopilotAdmission(
          { admissionId: admitted.admission.id, limits, invokeWorkflow },
          paths,
        ),
      ).resolves.toMatchObject({
        dispatched: {
          status: 'orphaned-receipt',
          admission: {
            state: 'manual-review',
            currentRunId: null,
            currentStageAttemptId: null,
            lastOutcome: {
              errorCode: 'orphaned-dispatch-receipt',
              retryClass: 'uncertain',
            },
          },
        },
      });
      await expect(
        listAutopilotStageAttempts(
          { admissionId: admitted.admission.id },
          paths,
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          status: 'failed',
          runId: 'run:orphaned-current',
        }),
      ]);
      await expect(
        reconcileAutopilotStageAttempts(paths),
      ).resolves.toMatchObject({ reconciledAdmissionIds: [] });
      await expect(
        advanceAutopilotAdmission(
          { admissionId: admitted.admission.id, limits },
          paths,
        ),
      ).resolves.toMatchObject({ status: 'idle' });
    });
  });

  it('expires never-attached terminal facts after the bounded retention window', async () => {
    await withHome(async (paths) => {
      const now = new Date('2026-07-19T00:00:00.000Z');
      await recordAutopilotStageTerminalObservation(
        {
          runId: 'run:never-attached',
          observation: { workflow: 'triage-pr-event', failed: false },
        },
        paths,
        now,
      );

      const reconciliation = await reconcileAutopilotStageAttempts(paths, {
        now: new Date(now.getTime() + 2 * 60 * 60_000),
      });
      expect(reconciliation.removedTerminalFacts).toBe(1);
      const database = new DatabaseSync(paths.neondeckDatabase, {
        readOnly: true,
      });
      try {
        expect(
          database
            .prepare(
              `SELECT COUNT(*) AS count FROM app_metadata
               WHERE key = 'autopilot.stage.terminal:run:never-attached';`,
            )
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        database.close();
      }
    });
  });

  it('reuses one owner and assigns monotonic event sequences across admissions', async () => {
    await withHome(async (paths) => {
      const first = await admit(paths, 'watch:owner', 'event:one', 3);
      await supersedeAutopilotAdmission(
        { admissionId: first.admission.id },
        paths,
      );
      const second = await admit(paths, 'watch:owner', 'event:two', 3);
      expect(second.admission.ownerId).toBe(first.admission.ownerId);
      expect(second.admission.eventSequence).toBe(2);
      await expect(listAutopilotPrOwners(paths)).resolves.toEqual([
        expect.objectContaining({
          id: first.admission.ownerId,
          generation: 1,
        }),
      ]);
    });
  });

  it('enforces one active owner attempt even when the policy hint is disabled', async () => {
    await withHome(async (paths) => {
      await admit(paths, 'watch:owner-invariant', 'event:one', 23);
      const second = await claimAutopilotTriageAdmission(
        {
          ...admissionInput('watch:owner-invariant', 'event:two', 23),
          limits: { ...limits, singleMutationPerPr: false },
        },
        paths,
      );

      expect(second).toMatchObject({
        claimed: false,
        reason: 'limited',
        admission: { state: 'blocked', currentStageAttemptId: null },
      });
      await expect(listAutopilotStageAttempts({}, paths)).resolves.toHaveLength(
        1,
      );
    });
  });

  it('releases terminal capacity and retries a concurrency-blocked admission later', async () => {
    await withHome(async (paths) => {
      const oneAtATime = {
        ...limits,
        maxAutonomousJobs: 1,
        maxActiveWorkflowRuns: 1,
        maxPerRepoAutonomousJobs: 1,
      };
      const first = await claimAutopilotTriageAdmission(
        admissionInput('watch:first', 'event:first', 4, oneAtATime),
        paths,
      );
      const second = await claimAutopilotTriageAdmission(
        admissionInput('watch:second', 'event:second', 5, oneAtATime),
        paths,
      );
      expect(second).toMatchObject({ claimed: false, reason: 'limited' });
      const firstDue = new Date(Date.now() + 31_000);
      await expect(
        advanceAutopilotAdmission(
          {
            admissionId: second.admission.id,
            limits: oneAtATime,
            now: firstDue,
          },
          paths,
        ),
      ).resolves.toMatchObject({
        status: 'limited',
        admission: {
          state: 'blocked',
          nextAttemptAt: new Date(
            firstDue.getTime() + 2 * 60_000,
          ).toISOString(),
          lastOutcome: { concurrencyWaitCount: 2 },
        },
      });
      await expect(
        listAutopilotAdmissionsNeedingAdvance(
          paths,
          new Date(firstDue.getTime() + 30_000),
        ),
      ).resolves.not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: second.admission.id }),
        ]),
      );
      const secondDue = new Date(firstDue.getTime() + 2 * 60_000);
      await expect(
        advanceAutopilotAdmission(
          {
            admissionId: second.admission.id,
            limits: oneAtATime,
            now: secondDue,
          },
          paths,
        ),
      ).resolves.toMatchObject({
        status: 'limited',
        admission: {
          nextAttemptAt: new Date(
            secondDue.getTime() + 10 * 60_000,
          ).toISOString(),
          lastOutcome: { concurrencyWaitCount: 3 },
        },
      });
      await coordinateAutopilotAdmission(
        {
          admissionId: first.admission.id,
          limits: oneAtATime,
          invokeWorkflow: async () => ({ runId: 'run:first' }),
        },
        paths,
      );
      await recordAutopilotStageTerminalObservation(
        {
          runId: 'run:first',
          observation: {
            workflow: 'triage-pr-event',
            failed: false,
            shouldPrepare: false,
          },
        },
        paths,
      );
      const advanced = await advanceAutopilotAdmission(
        {
          admissionId: second.admission.id,
          limits: oneAtATime,
          now: new Date(secondDue.getTime() + 10 * 60_000),
        },
        paths,
      );
      expect(advanced).toMatchObject({
        status: 'reserved',
        admission: { state: 'triage-admitted' },
      });
    });
  });

  it('recovers terminal state after restart and advances preparation once', async () => {
    await withHome(async (paths) => {
      const admitted = await admit(paths, 'watch:restart', 'event:restart', 6);
      await coordinateAutopilotAdmission(
        {
          admissionId: admitted.admission.id,
          limits,
          invokeWorkflow: async () => ({ runId: 'run:restart:triage' }),
        },
        paths,
      );

      const settled = await recordAutopilotStageTerminalObservation(
        {
          runId: 'run:restart:triage',
          observation: {
            workflow: 'triage-pr-event',
            failed: false,
            shouldPrepare: true,
          },
        },
        paths,
      );
      expect(settled).toMatchObject({ status: 'settled' });
      const invokeWorkflow = vi.fn<AutopilotWorkflowInvoker>(async () => ({
        runId: 'run:restart:prepare',
      }));
      await coordinateAutopilotAdmission(
        { admissionId: admitted.admission.id, limits, invokeWorkflow },
        paths,
      );
      await coordinateAutopilotAdmission(
        { admissionId: admitted.admission.id, limits, invokeWorkflow },
        paths,
      );
      expect(invokeWorkflow).toHaveBeenCalledTimes(1);
      expect(invokeWorkflow).toHaveBeenCalledWith(
        'prepare-pr-worktree',
        expect.objectContaining({ eventId: 'event:restart' }),
      );
    });
  });

  it('moves stale attached runs to manual review and ignores late observations', async () => {
    await withHome(async (paths) => {
      const now = new Date('2026-07-19T00:00:00.000Z');
      const admitted = await claimAutopilotTriageAdmission(
        admissionInput('watch:stale', 'event:stale', 7),
        paths,
        now,
      );
      await coordinateAutopilotAdmission(
        {
          admissionId: admitted.admission.id,
          limits,
          now,
          invokeWorkflow: async () => ({ runId: 'run:stale' }),
        },
        paths,
      );
      await reconcileAutopilotStageAttempts(paths, {
        now: new Date(now.getTime() + 31 * 60_000),
      });
      const late = await recordAutopilotStageTerminalObservation(
        {
          runId: 'run:stale',
          observation: {
            workflow: 'triage-pr-event',
            failed: false,
            shouldPrepare: true,
          },
        },
        paths,
      );
      expect(late).toMatchObject({ status: 'stale-or-duplicate' });
      await expect(listAutopilotAdmissions(paths)).resolves.toEqual([
        expect.objectContaining({ state: 'manual-review' }),
      ]);
    });
  });

  it('applies retry backoff and caps automatic workflow admission at five attempts', async () => {
    await withHome(async (paths) => {
      let now = new Date('2026-07-19T00:00:00.000Z');
      const admitted = await claimAutopilotTriageAdmission(
        admissionInput('watch:retry', 'event:retry', 8),
        paths,
        now,
      );
      const invokeWorkflow = vi.fn<AutopilotWorkflowInvoker>(async () => {
        const error = new Error('temporary network unavailable');
        Object.assign(error, { code: 'network-error' });
        throw error;
      });

      const states: string[] = [];
      let current;
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await coordinateAutopilotAdmission(
          {
            admissionId: admitted.admission.id,
            limits,
            now,
            invokeWorkflow,
          },
          paths,
        );
        [current] = await listAutopilotAdmissions(paths);
        states.push(current.state);
        if (attempt < 5) {
          if (!current.nextAttemptAt) {
            throw new Error('Retryable admission did not receive a due time.');
          }
          now = new Date(Date.parse(current.nextAttemptAt) + 1);
        }
      }
      expect(states).toEqual([
        'failed',
        'failed',
        'failed',
        'failed',
        'manual-review',
      ]);
      expect(current?.nextAttemptAt).toBeNull();
      expect(invokeWorkflow).toHaveBeenCalledTimes(5);
      await expect(
        listAutopilotStageAttempts(
          { admissionId: admitted.admission.id },
          paths,
        ),
      ).resolves.toHaveLength(5);
    });
  });

  it('stop and supersession cancel active attempts and block stale completion', async () => {
    await withHome(async (paths) => {
      const stopped = await admit(paths, 'watch:stop', 'event:stop', 9);
      await coordinateAutopilotAdmission(
        {
          admissionId: stopped.admission.id,
          limits,
          invokeWorkflow: async () => ({ runId: 'run:stop' }),
        },
        paths,
      );
      await stopAutopilotAdmission(
        {
          admissionId: stopped.admission.id,
          expectedVersion: stopped.admission.version,
        },
        paths,
      );
      const late = await recordAutopilotStageTerminalObservation(
        {
          runId: 'run:stop',
          observation: {
            workflow: 'triage-pr-event',
            failed: false,
            shouldPrepare: true,
          },
        },
        paths,
      );
      expect(late.status).toBe('stale-or-duplicate');
      const afterStop = await admit(paths, 'watch:stop', 'event:after-stop', 9);
      const postStopInvoker = vi.fn<AutopilotWorkflowInvoker>();
      expect(afterStop).toMatchObject({
        claimed: false,
        reason: 'owner-inactive',
        admission: { state: 'stopped', currentStageAttemptId: null },
      });
      await coordinateAutopilotAdmission(
        {
          admissionId: afterStop.admission.id,
          limits,
          invokeWorkflow: postStopInvoker,
        },
        paths,
      );
      expect(postStopInvoker).not.toHaveBeenCalled();

      const superseded = await admit(
        paths,
        'watch:supersede',
        'event:old-head',
        10,
      );
      await supersedeAutopilotAdmission(
        { admissionId: superseded.admission.id },
        paths,
      );
      await expect(listAutopilotAdmissions(paths)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: stopped.admission.id,
            state: 'stopped',
          }),
          expect.objectContaining({
            id: superseded.admission.id,
            state: 'superseded',
          }),
        ]),
      );
    });
  });
});

async function admit(
  paths: ReturnType<typeof runtimePaths>,
  watchId: string,
  eventFingerprint: string,
  prNumber: number,
) {
  return claimAutopilotTriageAdmission(
    admissionInput(watchId, eventFingerprint, prNumber),
    paths,
  );
}

function admissionInput(
  watchId: string,
  eventFingerprint: string,
  prNumber: number,
  concurrency = limits,
) {
  return {
    watchId,
    eventFingerprint,
    repoId: 'repo',
    prNumber,
    mode: 'prepare-only' as const,
    input: { eventId: eventFingerprint },
    limits: concurrency,
  };
}

async function withHome(
  run: (paths: ReturnType<typeof runtimePaths>) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-admissions-'));
  const paths = runtimePaths(home);
  try {
    await run(paths);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
