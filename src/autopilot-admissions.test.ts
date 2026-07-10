import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  beginAutopilotAdmissionPrepare,
  claimAutopilotTriageAdmission,
  recordAutopilotAdmissionRun,
  recordAutopilotAdmissionTerminalFact,
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
            limits,
          },
          paths,
        ),
      ).resolves.toMatchObject({ claimed: true, reason: 'retry' });
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

      const competing = await claimAutopilotTriageAdmission(
        {
          watchId: 'watch:two',
          eventFingerprint: 'event:two',
          repoId: 'repo',
          prNumber: 1,
          mode: 'prepare-only',
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
});
