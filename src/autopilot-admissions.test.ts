import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  beginAutopilotAdmissionPrepare,
  claimAutopilotTriageAdmission,
  recordAutopilotAdmissionRun,
  recordAutopilotAdmissionTerminalFact,
  listAutopilotAdmissionsAwaitingPreparation,
  listAutopilotAdmissions,
  reconcileAutopilotAdmissions,
  settleAutopilotAdmissionTriage,
} from './modules/autopilot';
import { runtimePaths } from './runtime-home';

const limits = {
  maxAutonomousJobs: 1,
  maxActiveWorkflowRuns: 1,
  maxPerRepoAutonomousJobs: 1,
  singleMutationPerPr: true,
  localExecutionLimit: 1,
};

describe('autopilot admissions', () => {
  it('atomically deduplicates events and releases capacity at triage completion', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-admissions-'));
    const paths = runtimePaths(home);
    try {
      const first = await claimAutopilotTriageAdmission(
        {
          watchId: 'watch:one',
          eventFingerprint: 'event:one',
          repoId: 'repo',
          prNumber: 1,
          mode: 'prepare-only',
          input: {},
          limits,
        },
        paths,
      );
      expect(first.claimed).toBe(true);
      const blocked = await claimAutopilotTriageAdmission(
        {
          watchId: 'watch:two',
          eventFingerprint: 'event:two',
          repoId: 'repo',
          prNumber: 2,
          mode: 'prepare-only',
          input: {},
          limits,
        },
        paths,
      );
      expect(blocked).toMatchObject({ claimed: false, reason: 'limited' });
      await expect(
        claimAutopilotTriageAdmission(
          {
            watchId: 'watch:one',
            eventFingerprint: 'event:one',
            repoId: 'repo',
            prNumber: 1,
            mode: 'prepare-only',
            input: {},
            limits,
          },
          paths,
        ),
      ).resolves.toMatchObject({ claimed: false, reason: 'duplicate' });
      await recordAutopilotAdmissionRun(
        { id: first.admission.id, runId: 'flue:triage:one' },
        paths,
      );
      await settleAutopilotAdmissionTriage(
        { runId: 'flue:triage:one', failed: false },
        paths,
      );
      await expect(
        claimAutopilotTriageAdmission(
          {
            watchId: 'watch:two',
            eventFingerprint: 'event:two',
            repoId: 'repo',
            prNumber: 2,
            mode: 'prepare-only',
            input: {},
            limits,
          },
          paths,
        ),
      ).resolves.toMatchObject({ claimed: true, reason: 'retry' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('counts manually started active autopilot workflows against admission limits', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-admissions-'));
    const paths = runtimePaths(home);
    try {
      await claimAutopilotTriageAdmission(
        {
          watchId: 'watch:bootstrap',
          eventFingerprint: 'event:bootstrap',
          repoId: 'repo',
          prNumber: 1,
          mode: 'prepare-only',
          input: {},
          limits: {
            ...limits,
            maxAutonomousJobs: 2,
            maxActiveWorkflowRuns: 2,
            maxPerRepoAutonomousJobs: 2,
          },
        },
        paths,
      );
      const now = new Date().toISOString();
      const database = new DatabaseSync(paths.neondeckDatabase);
      try {
        database
          .prepare(
            `INSERT INTO workflow_run_observations (
               run_id, workflow, status, started_at, last_event_at,
               last_message, event_count, is_error, updated_at
             ) VALUES (?, 'verify-pr-worktree', 'active', ?, ?, ?, 1, 0, ?);`,
          )
          .run('manual:verify', now, now, 'Manual autopilot run.', now);
      } finally {
        database.close();
      }

      await expect(
        claimAutopilotTriageAdmission(
          {
            watchId: 'watch:limited',
            eventFingerprint: 'event:limited',
            repoId: 'repo',
            prNumber: 2,
            mode: 'prepare-only',
            input: {},
            limits: {
              ...limits,
              maxAutonomousJobs: 2,
              maxActiveWorkflowRuns: 2,
              maxPerRepoAutonomousJobs: 2,
            },
          },
          paths,
        ),
      ).resolves.toMatchObject({ claimed: false, reason: 'limited' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('recovers an early terminal triage run and enforces same-PR preparation admission', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-admissions-'));
    const paths = runtimePaths(home);
    const twoJobLimits = {
      ...limits,
      maxAutonomousJobs: 2,
      maxActiveWorkflowRuns: 2,
    };
    try {
      const first = await claimAutopilotTriageAdmission(
        {
          watchId: 'watch:one',
          eventFingerprint: 'event:one',
          repoId: 'repo',
          prNumber: 1,
          mode: 'prepare-only',
          input: {},
          limits: twoJobLimits,
        },
        paths,
      );
      await recordAutopilotAdmissionTerminalFact(
        {
          runId: 'flue:triage:one',
          fact: {
            workflow: 'triage-pr-event',
            failed: false,
            shouldPrepare: true,
          },
        },
        paths,
      );
      await expect(
        recordAutopilotAdmissionRun(
          { id: first.admission.id, runId: 'flue:triage:one' },
          paths,
        ),
      ).resolves.toMatchObject({
        admission: { state: 'triaged', currentRunId: 'flue:triage:one' },
        terminal: { shouldPrepare: true },
      });
      await reconcileAutopilotAdmissions(paths);
      await expect(
        listAutopilotAdmissionsAwaitingPreparation(paths),
      ).resolves.toMatchObject([
        expect.objectContaining({ id: first.admission.id }),
      ]);

      const competing = await claimAutopilotTriageAdmission(
        {
          watchId: 'watch:two',
          eventFingerprint: 'event:two',
          repoId: 'repo',
          prNumber: 1,
          mode: 'prepare-only',
          input: {},
          limits: twoJobLimits,
        },
        paths,
      );
      expect(competing.claimed).toBe(true);
      await expect(
        beginAutopilotAdmissionPrepare(
          { triageRunId: 'flue:triage:one', limits: twoJobLimits },
          paths,
        ),
      ).resolves.toBeUndefined();

      await recordAutopilotAdmissionRun(
        { id: competing.admission.id, runId: 'flue:triage:two' },
        paths,
      );
      await settleAutopilotAdmissionTriage(
        { runId: 'flue:triage:two', failed: false },
        paths,
      );
      await expect(
        beginAutopilotAdmissionPrepare(
          { triageRunId: 'flue:triage:one', limits: twoJobLimits },
          paths,
        ),
      ).resolves.toMatchObject({ state: 'prepare-admitted' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preserves the worktree linked by a recovered terminal prepare run', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-admissions-'));
    const paths = runtimePaths(home);
    try {
      const triage = await claimAutopilotTriageAdmission(
        {
          watchId: 'watch:prepare-recovery',
          eventFingerprint: 'event:prepare-recovery',
          repoId: 'repo',
          prNumber: 1,
          mode: 'prepare-only',
          input: {},
          limits: { ...limits, maxAutonomousJobs: 2, maxActiveWorkflowRuns: 2 },
        },
        paths,
      );
      await recordAutopilotAdmissionRun(
        { id: triage.admission.id, runId: 'flue:triage:recovery' },
        paths,
      );
      await settleAutopilotAdmissionTriage(
        { runId: 'flue:triage:recovery', failed: false },
        paths,
      );
      const prepare = await beginAutopilotAdmissionPrepare(
        {
          triageRunId: 'flue:triage:recovery',
          limits: { ...limits, maxAutonomousJobs: 2, maxActiveWorkflowRuns: 2 },
        },
        paths,
      );
      if (!prepare) throw new Error('Expected prepare admission.');
      await recordAutopilotAdmissionRun(
        { id: prepare.id, runId: 'flue:prepare:recovery' },
        paths,
      );
      const now = new Date().toISOString();
      const database = new DatabaseSync(paths.neondeckDatabase);
      try {
        database
          .prepare(
            `INSERT INTO workflow_run_observations (
               run_id, workflow, status, started_at, ended_at, last_event_at,
               last_message, event_count, is_error, updated_at
             ) VALUES (?, 'prepare-pr-worktree', 'completed', ?, ?, ?, ?, 1, 0, ?);`,
          )
          .run('flue:prepare:recovery', now, now, now, 'Completed.', now);
      } finally {
        database.close();
      }
      await expect(
        recordAutopilotAdmissionRun(
          { id: prepare.id, runId: 'flue:prepare:recovery' },
          paths,
        ),
      ).resolves.toMatchObject({
        admission: { state: 'prepare-admitted' },
      });
      await recordAutopilotAdmissionTerminalFact(
        {
          runId: 'flue:prepare:recovery',
          fact: {
            workflow: 'prepare-pr-worktree',
            failed: false,
            worktreeId: 'worktree:recovered',
          },
        },
        paths,
      );

      await reconcileAutopilotAdmissions(paths);
      await expect(listAutopilotAdmissions(paths)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: prepare.id,
            state: 'prepared',
            worktreeId: 'worktree:recovered',
          }),
        ]),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
