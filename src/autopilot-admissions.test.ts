import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  advanceAutopilotAdmission,
  admitTerminalAutopilotOwnerCleanup,
  autopilotAdmissionStates,
  autopilotModeProgression,
  autopilotRetryBackoffMs,
  autopilotRetryDecision,
  claimAutopilotTriageAdmission,
  classifyAutopilotRetry,
  coordinateAutopilotAdmission,
  dispatchReservedAutopilotStage,
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
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { openDb } from './lib/sqlite';
import {
  claimAutopilotSubmissionProcessLease,
  releaseAutopilotSubmissionProcessLease,
} from './modules/autopilot/owner/submission-lease';

const execFileAsync = promisify(execFile);

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
  it('preserves watch → triage → prepare and defers disabled owner dispatch without a stranded reservation', async () => {
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

      await expect(
        coordinateAutopilotAdmission(
          {
            admissionId: admitted.admission.id,
            limits,
            invokeWorkflow,
          },
          paths,
        ),
      ).resolves.toMatchObject({
        advanced: {
          status: 'deferred',
          reason: 'owner-dispatch-disabled',
          admission: {
            state: 'prepared',
            currentStageAttemptId: null,
          },
        },
        dispatched: null,
      });
      await expect(
        listAutopilotStageAttempts(
          { admissionId: admitted.admission.id },
          paths,
        ),
      ).resolves.toHaveLength(2);

      const reserved = await advanceAutopilotAdmission(
        { admissionId: admitted.admission.id, limits },
        paths,
      );
      if (reserved.status !== 'reserved') {
        throw new Error(
          `Expected owner reservation, received ${reserved.status}.`,
        );
      }
      await expect(
        dispatchReservedAutopilotStage(
          {
            attemptId: reserved.attempt.id,
            invokeWorkflow,
          },
          paths,
        ),
      ).resolves.toMatchObject({
        status: 'unsupported-transport',
        attempt: { status: 'cancelled' },
        admission: {
          state: 'prepared',
          currentStageAttemptId: null,
        },
      });
      await expect(
        dispatchReservedAutopilotStage(
          {
            attemptId: reserved.attempt.id,
            invokeWorkflow,
          },
          paths,
        ),
      ).resolves.toMatchObject({
        status: 'not-reserved',
        attempt: { status: 'cancelled' },
        admission: {
          state: 'prepared',
          currentStageAttemptId: null,
        },
      });
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

  it('recovers a pre-effect push intent only after the remote has the exact SHA', async () => {
    await withHome(async (paths) => {
      const admitted = await admit(
        paths,
        'watch:push-receipt',
        'event:push',
        61,
      );
      const now = '2026-07-19T00:00:00.000Z';
      const preparedDiffId = 'prepared:push-receipt';
      const worktreeId = 'worktree:push-receipt';
      const attemptId = admitted.admission.currentStageAttemptId!;
      const sourcePath = join(paths.home, 'push-source');
      const deletedPreparedWorktreePath = join(
        paths.home,
        'deleted-push-worktree',
      );
      const remotePath = join(paths.home, 'push-remote.git');
      await mkdir(sourcePath, { recursive: true });
      await runGit(sourcePath, ['init', '-b', 'main']);
      await runGit(sourcePath, ['config', 'user.email', 'test@example.com']);
      await runGit(sourcePath, ['config', 'user.name', 'Test User']);
      await writeFile(
        join(sourcePath, 'push.txt'),
        'recover this push intent\n',
      );
      await runGit(sourcePath, ['add', 'push.txt']);
      await runGit(sourcePath, ['commit', '-m', 'fixture push']);
      const pushedSha = await runGitOutput(sourcePath, ['rev-parse', 'HEAD']);
      await runGit(paths.home, ['init', '--bare', remotePath]);
      await runGit(sourcePath, ['remote', 'add', 'origin', remotePath]);
      await runGit(sourcePath, ['push', 'origin', 'HEAD:feature']);
      const database = new DatabaseSync(paths.neondeckDatabase);
      try {
        database
          .prepare(
            `INSERT INTO worktrees (
               id, repo_id, repo_full_name, github_owner, github_name, pr_number,
               base_ref, head_ref, head_sha, local_path, storage_kind,
               lifecycle_status, created_by, created_at, updated_at
             ) VALUES (?, 'repo', 'example/repo', 'example', 'repo', 61,
               'main', 'feature', 'before-push', ?, 'managed',
               'prepared-diff', 'test', ?, ?);`,
          )
          .run(worktreeId, sourcePath, now, now);
        database
          .prepare(
            `INSERT INTO prepared_diffs (
               id, worktree_id, repo_id, repo_full_name, pr_number, title,
               source_worktree_path, base_ref, head_ref, head_sha, status,
               push_approval_status, verification_status, created_by,
               created_at, updated_at
             ) VALUES (?, ?, 'repo', 'example/repo', 61, 'Push receipt',
               ?, 'main', 'feature', 'before-push', 'push-approved',
               'approved', 'passed', 'test', ?, ?);`,
          )
          // Simulate terminal cleanup deleting the prepared worktree in the
          // small window after Git accepted the push but before the local
          // receipt was committed. Recovery must query the remote directly.
          .run(
            preparedDiffId,
            worktreeId,
            deletedPreparedWorktreePath,
            now,
            now,
          );
        database
          .prepare(
            `UPDATE autopilot_stage_attempts
             SET stage = 'push', workflow = 'push-pr-autofix', status = 'running',
                 input_fingerprint = 'push-receipt', started_at = ?
             WHERE id = ?;`,
          )
          .run(now, attemptId);
        database
          .prepare(
            `UPDATE autopilot_admissions
             SET state = 'push-admitted', prepared_diff_id = ?, worktree_id = ?,
                 current_stage_attempt_id = ?, current_workflow = 'push-pr-autofix',
                 current_run_id = 'run:push-receipt', updated_at = ?
             WHERE id = ?;`,
          )
          .run(
            preparedDiffId,
            worktreeId,
            attemptId,
            now,
            admitted.admission.id,
          );
        database
          .prepare(
            `INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?);`,
          )
          .run(
            `autopilot.push-reconciliation:${preparedDiffId}:${attemptId}`,
            JSON.stringify({
              preparedDiffId,
              commitSha: pushedSha,
              remote: remotePath,
              branch: 'feature',
              admissionId: admitted.admission.id,
              attemptId,
              phase: 'push-intent',
            }),
            now,
          );
      } finally {
        database.close();
      }

      await expect(
        reconcileAutopilotStageAttempts(paths, {
          now: new Date('2026-07-19T00:01:00.000Z'),
        }),
      ).resolves.toMatchObject({
        reconciledAdmissionIds: [admitted.admission.id],
      });
      await expect(listAutopilotAdmissions(paths)).resolves.toEqual([
        expect.objectContaining({
          state: 'pushed',
          pushedCommitSha: pushedSha,
        }),
      ]);
      await expect(
        listAutopilotStageAttempts(
          { admissionId: admitted.admission.id },
          paths,
        ),
      ).resolves.toEqual([
        expect.objectContaining({ id: attemptId, status: 'completed' }),
      ]);
      await expect(
        reconcileAutopilotStageAttempts(paths),
      ).resolves.toMatchObject({
        reconciledAdmissionIds: [],
      });
      const retryAttemptId = 'attempt:push-receipt-retry';
      const retryDatabase = new DatabaseSync(paths.neondeckDatabase);
      try {
        retryDatabase
          .prepare(
            `INSERT INTO autopilot_stage_attempts (
               id, admission_id, owner_id, stage, attempt_number, workflow,
               event_sequence, status, input_fingerprint, artifact_json,
               created_at, started_at
             ) VALUES (?, ?, ?, 'push', 2, 'push-pr-autofix', 1, 'running',
               'push-receipt-retry', '{}', ?, ?);`,
          )
          .run(
            retryAttemptId,
            admitted.admission.id,
            admitted.admission.ownerId,
            now,
            now,
          );
        retryDatabase
          .prepare(
            `UPDATE autopilot_admissions
             SET state = 'push-admitted', current_stage_attempt_id = ?,
                 current_workflow = 'push-pr-autofix', current_run_id = 'run:retry'
             WHERE id = ?;`,
          )
          .run(retryAttemptId, admitted.admission.id);
        retryDatabase
          .prepare(
            `INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?);`,
          )
          .run(
            `autopilot.push-reconciliation:${preparedDiffId}:${attemptId}`,
            JSON.stringify({
              preparedDiffId,
              commitSha: 'late-old-push',
              remote: remotePath,
              branch: 'feature',
              admissionId: admitted.admission.id,
              attemptId,
              phase: 'push-receipt',
            }),
            now,
          );
      } finally {
        retryDatabase.close();
      }
      await expect(
        reconcileAutopilotStageAttempts(paths, {
          now: new Date('2026-07-19T00:01:00.000Z'),
        }),
      ).resolves.toMatchObject({
        reconciledAdmissionIds: [],
      });
      await expect(
        listAutopilotStageAttempts(
          { admissionId: admitted.admission.id },
          paths,
        ),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: retryAttemptId, status: 'running' }),
        ]),
      );

      // If terminal handling wins the local race after Git accepted an exact
      // intent, reconciliation records the delivered SHA without reviving the
      // stopped admission or its cleanup lifecycle.
      const terminalDatabase = new DatabaseSync(paths.neondeckDatabase);
      try {
        terminalDatabase
          .prepare(
            `UPDATE autopilot_stage_attempts
             SET status = 'cancelled', finished_at = ? WHERE id = ?;`,
          )
          .run(now, retryAttemptId);
        terminalDatabase
          .prepare(
            `UPDATE autopilot_admissions
             SET state = 'stopped', current_stage_attempt_id = NULL,
                 current_workflow = NULL, current_run_id = NULL,
                 stop_requested_at = ?, updated_at = ? WHERE id = ?;`,
          )
          .run(now, now, admitted.admission.id);
        terminalDatabase
          .prepare(
            `INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
          )
          .run(
            `autopilot.push-reconciliation:${preparedDiffId}:${retryAttemptId}`,
            JSON.stringify({
              preparedDiffId,
              commitSha: pushedSha,
              remote: remotePath,
              branch: 'feature',
              admissionId: admitted.admission.id,
              attemptId: retryAttemptId,
              phase: 'push-intent',
            }),
            now,
          );
      } finally {
        terminalDatabase.close();
      }
      await expect(
        reconcileAutopilotStageAttempts(paths),
      ).resolves.toMatchObject({
        reconciledAdmissionIds: [admitted.admission.id],
      });
      await expect(listAutopilotAdmissions(paths)).resolves.toEqual([
        expect.objectContaining({
          state: 'stopped',
          pushedCommitSha: pushedSha,
        }),
      ]);
    });
  });

  it('retries an active durable result-delivery lease instead of escalating it to manual review', async () => {
    await withHome(async (paths) => {
      const admitted = await admit(
        paths,
        'watch:delivery-lease',
        'event:delivery-lease',
        62,
      );
      const attemptId = admitted.admission.currentStageAttemptId!;
      const database = openDb(paths.neondeckDatabase);
      try {
        database
          .prepare(
            `UPDATE autopilot_stage_attempts
             SET stage = 'comment-result', workflow = 'comment-pr-autofix-result',
                 status = 'running', run_id = 'run:delivery-lease', started_at = ?
             WHERE id = ?;`,
          )
          .run('2026-07-19T00:00:00.000Z', attemptId);
        database
          .prepare(
            `UPDATE autopilot_admissions
             SET state = 'comment-admitted', current_workflow = 'comment-pr-autofix-result',
                 current_run_id = 'run:delivery-lease' WHERE id = ?;`,
          )
          .run(admitted.admission.id);
        database
          .prepare(
            `UPDATE autopilot_pr_owners SET last_dispatched_sequence = 1 WHERE id = ?;`,
          )
          .run(admitted.admission.ownerId);
      } finally {
        database.close();
      }

      await recordAutopilotStageTerminalObservation(
        {
          runId: 'run:delivery-lease',
          observation: {
            workflow: 'comment-pr-autofix-result',
            failed: true,
            errorCode: 'delivery-lease-active',
            error: 'Result delivery is held by an active delivery lease.',
          },
        },
        paths,
        new Date('2026-07-19T00:00:00.000Z'),
      );
      await expect(listAutopilotAdmissions(paths)).resolves.toEqual([
        expect.objectContaining({
          id: admitted.admission.id,
          state: 'failed',
          lastOutcome: expect.objectContaining({
            retryClass: 'transient',
            retryStage: 'comment-result',
          }),
        }),
      ]);
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

  it('holds terminal cleanup behind a cancelled owner submission lease', async () => {
    await withHome(async (paths) => {
      const admitted = await admit(
        paths,
        'watch:terminal-lease',
        'event:terminal-lease',
        10,
      );
      const attemptId = 'attempt:terminal-lease';
      const database = openDb(paths.neondeckDatabase);
      try {
        database
          .prepare(
            `UPDATE autopilot_admissions
             SET state = 'completed', worktree_id = 'worktree:terminal-lease',
                 current_stage_attempt_id = ?, current_workflow = 'autopilot-owner-turn',
                 updated_at = ? WHERE id = ?;`,
          )
          .run(attemptId, '2026-07-19T00:00:00.000Z', admitted.admission.id);
        database
          .prepare(
            `UPDATE autopilot_pr_owners SET worktree_id = ? WHERE id = ?;`,
          )
          .run('worktree:terminal-lease', admitted.admission.ownerId);
        database
          .prepare(
            `INSERT INTO worktrees (
               id, repo_id, repo_full_name, github_owner, github_name, pr_number,
               base_ref, head_ref, head_sha, local_path, storage_kind,
               lifecycle_status, created_by, created_at, updated_at
             ) VALUES (?, 'repo', 'example/repo', 'example', 'repo', 10,
                       'main', 'feature', 'head', ?, 'managed', 'ready',
                       'test', ?, ?);`,
          )
          .run(
            'worktree:terminal-lease',
            join(paths.home, 'terminal-lease-worktree'),
            '2026-07-19T00:00:00.000Z',
            '2026-07-19T00:00:00.000Z',
          );
        database
          .prepare(
            `UPDATE autopilot_stage_attempts
             SET id = ?, stage = 'owner-turn', workflow = 'autopilot-owner-turn',
                 status = 'running', started_at = ?
             WHERE admission_id = ?;`,
          )
          .run(attemptId, '2026-07-19T00:00:00.000Z', admitted.admission.id);
      } finally {
        database.close();
      }

      claimAutopilotSubmissionProcessLease(attemptId);
      try {
        const cleanup = admitTerminalAutopilotOwnerCleanup(
          { watchId: 'watch:terminal-lease', reason: 'terminal-lease' },
          paths,
          new Date('2026-07-19T00:00:00.000Z'),
        );
        await vi.waitFor(async () => {
          await expect(listAutopilotAdmissions(paths)).resolves.toEqual([
            expect.objectContaining({ state: 'cleanup-pending' }),
          ]);
        });
        await expect(
          advanceAutopilotAdmission(
            { admissionId: admitted.admission.id, limits },
            paths,
          ),
        ).resolves.toMatchObject({ status: 'idle' });
        releaseAutopilotSubmissionProcessLease(attemptId);
        await expect(cleanup).resolves.toMatchObject({ status: 'admitted' });
        const check = openDb(paths.neondeckDatabase, { readOnly: true });
        try {
          expect(
            check
              .prepare('SELECT lifecycle_status FROM worktrees WHERE id = ?;')
              .get('worktree:terminal-lease'),
          ).toEqual({ lifecycle_status: 'succeeded' });
        } finally {
          check.close();
        }
      } finally {
        releaseAutopilotSubmissionProcessLease(attemptId);
      }
    });
  });

  it('keeps terminal-owner cleanup admission durable through grace and archives only after deletion', async () => {
    await withHome(async (paths) => {
      const admitted = await admit(
        paths,
        'watch:terminal',
        'event:terminal',
        11,
      );
      const database = openDb(paths.neondeckDatabase);
      try {
        database
          .prepare(
            `UPDATE autopilot_admissions
             SET state = 'completed', worktree_id = 'worktree:terminal',
                 current_stage_attempt_id = NULL, current_workflow = NULL,
                 completed_at = ?, updated_at = ? WHERE id = ?;`,
          )
          .run(
            '2026-07-19T00:00:00.000Z',
            '2026-07-19T00:00:00.000Z',
            admitted.admission.id,
          );
        database
          .prepare(
            `UPDATE autopilot_stage_attempts
             SET status = 'cancelled', finished_at = ? WHERE admission_id = ?;`,
          )
          .run('2026-07-19T00:00:00.000Z', admitted.admission.id);
        database
          .prepare(
            `UPDATE autopilot_pr_owners
             SET worktree_id = 'worktree:terminal' WHERE id = ?;`,
          )
          .run(admitted.admission.ownerId);
      } finally {
        database.close();
      }

      const cleanup = await admitTerminalAutopilotOwnerCleanup(
        { watchId: 'watch:terminal', reason: 'pull-request-terminal-state' },
        paths,
        new Date('2026-07-19T00:00:00.000Z'),
      );
      expect(cleanup).toMatchObject({
        status: 'admitted',
        admissionId: admitted.admission.id,
      });

      const invoke = vi.fn<AutopilotWorkflowInvoker>(async () => ({
        runId: 'run:terminal:grace',
      }));
      await coordinateAutopilotAdmission(
        {
          admissionId: admitted.admission.id,
          limits,
          now: new Date('2026-07-19T00:00:00.000Z'),
          invokeWorkflow: invoke,
        },
        paths,
      );
      await expect(
        admitTerminalAutopilotOwnerCleanup(
          { watchId: 'watch:terminal', reason: 'duplicate-terminal-state' },
          paths,
          new Date('2026-07-19T00:00:00.500Z'),
        ),
      ).resolves.toMatchObject({
        status: 'already-admitted',
        admissionId: admitted.admission.id,
      });
      await expect(
        listAutopilotStageAttempts(
          { admissionId: admitted.admission.id },
          paths,
        ),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: 'cleanup',
            status: 'running',
            runId: 'run:terminal:grace',
          }),
        ]),
      );
      await recordAutopilotStageTerminalObservation(
        {
          runId: 'run:terminal:grace',
          observation: {
            workflow: 'cleanup-autopilot-worktree',
            failed: false,
            artifact: { cleanupDeleted: false },
          },
        },
        paths,
        new Date('2026-07-19T00:00:01.000Z'),
      );
      await expect(listAutopilotAdmissions(paths)).resolves.toEqual([
        expect.objectContaining({ state: 'cleanup-pending' }),
      ]);
      await coordinateAutopilotAdmission(
        {
          admissionId: admitted.admission.id,
          limits,
          now: new Date('2026-07-19T00:01:00.000Z'),
          invokeWorkflow: invoke,
        },
        paths,
      );
      expect(invoke).toHaveBeenCalledTimes(1);

      const [pending] = await listAutopilotAdmissions(paths);
      await coordinateAutopilotAdmission(
        {
          admissionId: admitted.admission.id,
          limits,
          now: new Date(Date.parse(pending.nextAttemptAt!) + 1),
          invokeWorkflow: async () => ({ runId: 'run:terminal:failed' }),
        },
        paths,
      );
      await recordAutopilotStageTerminalObservation(
        {
          runId: 'run:terminal:failed',
          observation: {
            workflow: 'cleanup-autopilot-worktree',
            failed: false,
            artifact: {
              cleanupDeleted: false,
              cleanupFailed: true,
              cleanupError: 'temporary worktree cleanup failure',
            },
          },
        },
        paths,
        new Date(Date.parse(pending.nextAttemptAt!) + 2),
      );
      const [failedCleanup] = await listAutopilotAdmissions(paths);
      expect(failedCleanup).toMatchObject({
        state: 'failed',
        lastOutcome: { retryStage: 'cleanup' },
      });
      await expect(
        listAutopilotAdmissionsNeedingAdvance(
          paths,
          new Date(Date.parse(failedCleanup.nextAttemptAt!) + 1),
        ),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: admitted.admission.id }),
        ]),
      );
      await coordinateAutopilotAdmission(
        {
          admissionId: admitted.admission.id,
          limits,
          now: new Date(Date.parse(failedCleanup.nextAttemptAt!) + 1),
          invokeWorkflow: async () => ({ runId: 'run:terminal:deleted' }),
        },
        paths,
      );
      await recordAutopilotStageTerminalObservation(
        {
          runId: 'run:terminal:deleted',
          observation: {
            workflow: 'cleanup-autopilot-worktree',
            failed: false,
            artifact: { cleanupDeleted: true },
          },
        },
        paths,
        new Date(Date.parse(failedCleanup.nextAttemptAt!) + 2),
      );
      await expect(listAutopilotAdmissions(paths)).resolves.toEqual([
        expect.objectContaining({ state: 'archived' }),
      ]);
      await expect(listAutopilotPrOwners(paths)).resolves.toEqual([
        expect.objectContaining({ status: 'archived' }),
      ]);
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
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.repos,
      JSON.stringify({
        repos: [
          {
            id: 'repo',
            github: { owner: 'example', name: 'repo' },
            path: '/fixture/primary',
            defaultBranch: 'main',
            metadata: { autopilot: { mode: 'prepare-only' } },
          },
        ],
      }),
    );
    await run(paths);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function runGit(cwd: string, args: string[]) {
  await execFileAsync('git', args, { cwd });
}

async function runGitOutput(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}
