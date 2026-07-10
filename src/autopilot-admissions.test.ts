import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claimAutopilotTriageAdmission,
  recordAutopilotAdmissionRun,
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
      ).resolves.toMatchObject({ claimed: true });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
