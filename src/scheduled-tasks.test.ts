import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FlueObservation } from '@flue/runtime';
import {
  activateScheduledTaskSubmission,
  attachScheduledTaskSubmissionId,
  boundedContent,
  canAdmitScheduledSubmission,
  claimDueScheduledTasks,
  clearScheduledWorkspaceQuarantine,
  createAgentInstructionTask,
  createBriefingTask,
  listTaskRecords,
  nextOccurrence,
  listScheduledRunArtifacts,
  maxPersistedScheduledRunResultBytes,
  maxScheduledArtifactBytes,
  quarantinePhysicalWorkspace,
  sanitizedBoundedContent,
  sanitizedScheduledRunResult,
  scheduleTaskNow,
  readLatestScheduledTaskRun,
  readScheduledTask,
  readScheduledTaskRun,
  releaseUnstartedScheduledTaskClaim,
  removeTask,
  settleScheduledTaskRun,
  settleScheduledTaskSubmission,
  settleScheduledTaskObservation,
  setScheduledTaskEnabled,
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
  it('deletes a pending manual marker with its task before deterministic id reuse', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-manual-delete-'));
    const paths = runtimePaths(home);
    const task = {
      id: 'instruction:manual-delete',
      spec: {
        kind: 'run-agent-instruction' as const,
        prompt: 'Do not leak this occurrence.',
        target: { kind: 'agent' as const },
        skills: [],
        workspace: { kind: 'virtual' as const },
      },
      trigger: { kind: 'interval' as const, everySeconds: 300 },
      enabled: false,
      nextRunAt: '2026-08-17T20:00:00.000Z',
    };
    try {
      await upsertScheduledTask(task, paths);
      await scheduleTaskNow(task.id, paths);
      await expect(removeTask(task.id, paths)).resolves.toMatchObject({
        ok: true,
        changed: true,
      });
      await upsertScheduledTask(task, paths);
      await expect(
        claimDueScheduledTasks(paths, new Date('2026-08-17T19:00:00.000Z')),
      ).resolves.toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('queues a manual occurrence without resuming a paused recurring task', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-manual-paused-'));
    const paths = runtimePaths(home);
    try {
      await upsertScheduledTask(
        {
          id: 'instruction:paused-manual',
          spec: {
            kind: 'run-agent-instruction',
            prompt: 'Run once while paused.',
            target: { kind: 'agent' },
            skills: [],
            workspace: { kind: 'virtual' },
          },
          trigger: { kind: 'interval', everySeconds: 300 },
          enabled: true,
          nextRunAt: '2026-08-17T20:00:00.000Z',
        },
        paths,
      );
      await setScheduledTaskEnabled('instruction:paused-manual', false, paths);
      await expect(
        scheduleTaskNow('instruction:paused-manual', paths),
      ).resolves.toMatchObject({ ok: true, changed: true });
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-08-17T19:00:00.000Z'),
      );
      expect(claim?.run.result).toEqual({ reason: 'manual-occurrence' });
      expect(claim?.task.enabled).toBe(false);
      expect(claim?.task.nextRunAt).toBe('2026-08-17T20:00:00.000Z');
      await expect(
        readScheduledTask('instruction:paused-manual', paths),
      ).resolves.toMatchObject({ enabled: false });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('requires confirmation for recurring shell and network authority', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-confirm-'));
    const paths = runtimePaths(home);
    try {
      await expect(
        createAgentInstructionTask(
          {
            prompt: 'Run arbitrary shell commands.',
            trigger: { kind: 'interval', everySeconds: 300 },
            workspace: {
              kind: 'repository',
              repoId: 'repo',
              providerId: 'local',
              resource: { lifecycle: 'per-run' },
              revision: { ref: 'main', mode: 'latest-each-run' },
              git: { mode: 'run-branch' },
              authority: 'trusted-workspace',
            },
          },
          paths,
        ),
      ).resolves.toMatchObject({ ok: false, requires: ['confirm'] });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('projects the current active run in scheduled task lists', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-active-'));
    const paths = runtimePaths(home);
    try {
      await upsertScheduledTask(
        {
          id: 'instruction:active-list',
          spec: {
            kind: 'run-agent-instruction',
            prompt: 'Stay active.',
            target: { kind: 'agent' },
            skills: [],
          },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-08-16T12:00:00.000Z',
        },
        paths,
      );
      const [claim] = await claimDueScheduledTasks(
        paths,
        new Date('2026-08-16T12:00:00.000Z'),
      );
      await activateScheduledTaskSubmission(
        {
          taskId: claim!.task.id,
          runId: claim!.run.id,
          claimId: claim!.task.claimId ?? '',
          sessionId: 'session:active-list',
          dispatchKey: claim!.run.id,
          dispatchPayload: {
            prompt: 'Stay active.',
            taskId: claim!.task.id,
            runId: claim!.run.id,
          },
        },
        paths,
      );
      await expect(listTaskRecords(paths)).resolves.toMatchObject({
        tasks: [
          {
            id: 'instruction:active-list',
            activeRun: { id: claim!.run.id, status: 'active' },
          },
        ],
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it('bounds UTF-8 output without emitting a partial code point', () => {
    expect(boundedContent('🙂🙂', 5)).toEqual({
      content: '🙂',
      truncated: true,
    });
  });

  it('redacts secrets before UTF-8 byte bounding and reports both facts', () => {
    const result = sanitizedBoundedContent(
      'github_pat_abcdefghijklmnopqrstuvwxyz🙂',
      12,
    );
    expect(result).toMatchObject({ redacted: true, truncated: true });
    expect(result.content).not.toContain('github_pat_');
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(12);
  });

  it('redacts and byte-bounds persisted scheduled run result JSON', () => {
    const secret = 'github_pat_abcdefghijklmnopqrstuvwxyz';
    const result = sanitizedScheduledRunResult({
      error: secret,
      output: '\"\\🙂'.repeat(100_000),
    });
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain(secret);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(
      maxPersistedScheduledRunResultBytes,
    );
    expect(result).toMatchObject({ truncated: true });
  });

  it('rejects duplicate scheduled skill ids at both public and persisted boundaries', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-skills-'));
    const paths = runtimePaths(home);
    try {
      await expect(
        createAgentInstructionTask(
          {
            prompt: 'Use the selected skill.',
            trigger: {
              kind: 'once',
              at: new Date(Date.now() + 60_000).toISOString(),
            },
            skills: ['review', 'review'],
          },
          paths,
        ),
      ).resolves.toMatchObject({ ok: false });
      await expect(
        upsertScheduledTask(
          {
            id: 'instruction:duplicate-skills',
            spec: {
              kind: 'run-agent-instruction',
              prompt: 'Use the selected skill.',
              target: { kind: 'agent' },
              skills: ['review', 'review'],
            },
            trigger: { kind: 'interval', everySeconds: 300 },
          },
          paths,
        ),
      ).rejects.toThrow(/skill ids must be unique/i);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects unknown repository and provider references before saving a task', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduled-refs-'));
    const paths = runtimePaths(home);
    try {
      const workspace = {
        kind: 'repository' as const,
        repoId: 'missing-repo',
        providerId: 'missing-provider',
        resource: { lifecycle: 'per-run' as const },
        revision: { ref: 'main', mode: 'latest-each-run' as const },
        git: { mode: 'run-branch' as const },
        authority: 'read-only' as const,
      };
      await expect(
        createAgentInstructionTask(
          {
            prompt: 'Inspect missing configuration.',
            trigger: {
              kind: 'once',
              at: new Date(Date.now() + 60_000).toISOString(),
            },
            workspace,
          },
          paths,
        ),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining('missing-repo'),
      });
      await writeFile(
        paths.repos,
        JSON.stringify({
          repos: [
            {
              id: 'missing-repo',
              github: { owner: 'example', name: 'repo' },
              path: home,
              defaultBranch: 'main',
            },
          ],
        }),
      );
      await expect(
        createAgentInstructionTask(
          {
            prompt: 'Inspect missing provider.',
            trigger: {
              kind: 'once',
              at: new Date(Date.now() + 60_000).toISOString(),
            },
            workspace,
          },
          paths,
        ),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining('missing-provider'),
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('requires explicit operator attestation before clearing a durable quarantine', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-quarantine-clear-'));
    const paths = runtimePaths(home);
    const physicalResourceKey = 'ssh://runner@example.com:22/workspaces/run';
    try {
      await quarantinePhysicalWorkspace(
        {
          physicalResourceKey,
          providerId: 'build-box',
          source: 'approved-execution',
          sourceId: 'approval-one',
          reason: 'Remote command settlement is uncertain.',
        },
        paths,
      );
      await expect(
        clearScheduledWorkspaceQuarantine({ physicalResourceKey }, paths),
      ).resolves.toMatchObject({ ok: false, requires: ['confirm'] });
      await expect(
        clearScheduledWorkspaceQuarantine(
          { physicalResourceKey, confirm: true },
          paths,
        ),
      ).resolves.toMatchObject({ ok: true, changed: true });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('captures a virtual instruction response before terminal settlement', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-virtual-output-'));
    const paths = runtimePaths(home);
    const oversizedResponse =
      'github_pat_abcdefghijklmnopqrstuvwxyz ' +
      'é'.repeat(maxScheduledArtifactBytes);
    let resolveSettlement:
      ((value: { failed: boolean; response: string }) => void) | undefined;
    try {
      await upsertScheduledTask(
        {
          id: 'instruction:virtual-output',
          spec: {
            kind: 'run-agent-instruction',
            prompt: 'Return a concise answer.',
            target: { kind: 'agent' },
            skills: [],
            workspace: { kind: 'virtual' },
          },
          trigger: { kind: 'interval', everySeconds: 300 },
          nextRunAt: '2026-07-10T00:00:00.000Z',
        },
        paths,
      );
      await runSchedulerTick(paths, new Date('2026-07-10T00:00:00.000Z'), {
        dispatchInstruction: async (input) => ({
          submissionId: 'submission:virtual-output',
          sessionId: input.sessionId,
        }),
        readInstructionSettlement: async () =>
          new Promise((resolve) => {
            resolveSettlement = resolve;
          }),
      });
      await expect(
        settleScheduledTaskObservation(
          { submissionId: 'submission:virtual-output', failed: false },
          paths,
        ),
      ).resolves.toBe(false);
      resolveSettlement?.({
        failed: false,
        response: oversizedResponse,
      });
      await vi.waitFor(async () => {
        expect(
          await readLatestScheduledTaskRun('instruction:virtual-output', paths),
        ).toMatchObject({
          status: 'completed',
          result: expect.objectContaining({
            responseTruncated: true,
            responseRedacted: true,
          }),
        });
      });
      const run = await readLatestScheduledTaskRun(
        'instruction:virtual-output',
        paths,
      );
      expect(
        Buffer.byteLength(JSON.stringify(run!.result), 'utf8'),
      ).toBeLessThanOrEqual(maxPersistedScheduledRunResultBytes);
      expect(
        Buffer.byteLength(
          (run!.result as { response: string | null }).response ?? '',
          'utf8',
        ),
      ).toBeLessThanOrEqual(maxScheduledArtifactBytes);
      expect(
        (run!.result as { response: string | null }).response,
      ).not.toContain('github_pat_');
      expect(await listScheduledRunArtifacts(run!.id, paths)).toEqual([
        expect.objectContaining({
          kind: 'response',
          workspaceId: null,
          truncated: true,
          redacted: true,
        }),
      ]);
      expect(
        Buffer.byteLength(
          (await listScheduledRunArtifacts(run!.id, paths))[0]!.content ?? '',
          'utf8',
        ),
      ).toBeLessThanOrEqual(maxScheduledArtifactBytes);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects legacy repo and cwd fields beside a repository workspace', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-canonical-workspace-'));
    const paths = runtimePaths(home);
    try {
      await expect(
        createAgentInstructionTask(
          {
            prompt: 'Use canonical workspace context.',
            trigger: {
              kind: 'once',
              at: new Date(Date.now() + 60_000).toISOString(),
            },
            repoId: 'legacy-repo',
            cwd: '/legacy/path',
            workspace: {
              kind: 'repository',
              repoId: 'workspace-repo',
              providerId: 'local',
              resource: { lifecycle: 'per-run' },
              revision: { ref: 'main', mode: 'latest-each-run' },
              git: { mode: 'run-branch' },
              authority: 'read-only',
            },
          },
          paths,
        ),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining('workspace.repoId'),
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

  it('drops skipped occurrences while preserving one queued occurrence', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-overlap-policy-'));
    const paths = runtimePaths(home);
    try {
      for (const overlap of ['skip', 'queue-one'] as const) {
        await upsertScheduledTask(
          {
            id: `instruction:${overlap}`,
            spec: {
              kind: 'run-agent-instruction',
              prompt: overlap,
              target: { kind: 'agent' },
              skills: [],
              workspace: {
                kind: 'repository',
                repoId: 'repo',
                providerId: 'local',
                resource: { lifecycle: 'reuse-task' },
                revision: { ref: 'main', mode: 'continue' },
                git: { mode: 'task-branch' },
                authority: 'trusted-workspace',
                overlap,
              },
            },
            trigger: { kind: 'interval', everySeconds: 60 },
            nextRunAt: '2026-07-10T00:00:00.000Z',
          },
          paths,
        );
      }
      const initial = await claimDueScheduledTasks(
        paths,
        new Date('2026-07-10T00:00:00.000Z'),
      );
      expect(initial).toHaveLength(2);
      for (const claim of initial) {
        await activateScheduledTaskSubmission(
          {
            taskId: claim.task.id,
            runId: claim.run.id,
            claimId: claim.task.claimId ?? '',
            sessionId: `session:${claim.task.id}`,
            dispatchKey: claim.run.id,
            dispatchPayload: { prompt: claim.task.id, taskId: claim.task.id },
          },
          paths,
        );
      }

      await expect(
        claimDueScheduledTasks(paths, new Date('2026-07-10T00:01:00.000Z')),
      ).resolves.toEqual([]);
      await expect(
        readScheduledTask('instruction:skip', paths),
      ).resolves.toMatchObject({ nextRunAt: '2026-07-10T00:02:00.000Z' });
      await expect(
        readScheduledTask('instruction:queue-one', paths),
      ).resolves.toMatchObject({ nextRunAt: '2026-07-10T00:01:00.000Z' });
      await expect(
        readLatestScheduledTaskRun('instruction:skip', paths),
      ).resolves.toMatchObject({
        status: 'completed',
        outcome: 'silent',
        result: {
          reason: 'overlap-skip',
          scheduledFor: '2026-07-10T00:01:00.000Z',
        },
      });

      const queuedInitial = initial.find(
        (claim) => claim.task.id === 'instruction:queue-one',
      )!;
      await settleScheduledTaskRun(
        {
          taskId: queuedInitial.task.id,
          runId: queuedInitial.run.id,
          claimId: queuedInitial.task.claimId ?? '',
          status: 'completed',
          outcome: 'recorded',
          message: 'settled',
        },
        paths,
      );
      const queued = await claimDueScheduledTasks(
        paths,
        new Date('2026-07-10T00:01:01.000Z'),
      );
      expect(queued.map((claim) => claim.task.id)).toEqual([
        'instruction:queue-one',
      ]);
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
          dispatchPayload: {
            prompt: 'Daily briefing.',
            taskId: claim.task.id,
            runId: claim.run.id,
            workspaceId: 'workspace:recovery',
            cwd: '/workspace/repo',
            lockOwner: `scheduled-run:${claim.run.id}`,
          },
        },
        paths,
      );
      await attachScheduledTaskSubmissionId(
        { runId: claim.run.id, submissionId: 'workflow:briefing:active' },
        paths,
      );
      await expect(
        readScheduledTaskRun(claim.run.id, paths),
      ).resolves.toMatchObject({
        dispatchPayload: {
          runId: claim.run.id,
          workspaceId: 'workspace:recovery',
          cwd: '/workspace/repo',
          lockOwner: `scheduled-run:${claim.run.id}`,
        },
      });

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
      await writeFile(
        paths.repos,
        JSON.stringify({
          repos: [
            {
              id: 'repo',
              github: { owner: 'example', name: 'repo' },
              path: home,
              defaultBranch: 'main',
            },
          ],
        }),
      );
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
            confirm: true,
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
            confirm: true,
            target: { kind: 'agent-session', sessionId: session.id },
          },
          paths,
        ),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        createAgentInstructionTask(
          {
            prompt: 'Attach a fresh workspace to serialized worker context.',
            trigger: { kind: 'interval', everySeconds: 3_600 },
            confirm: true,
            target: { kind: 'agent-session', sessionId: session.id },
            workspace: {
              kind: 'repository',
              repoId: 'repo',
              providerId: 'local',
              resource: { lifecycle: 'per-run' },
              revision: { ref: 'main', mode: 'latest-each-run' },
              git: { mode: 'run-branch' },
              authority: 'trusted-workspace',
              overlap: 'skip',
            },
          },
          paths,
        ),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        createAgentInstructionTask(
          {
            prompt: 'Do not share a per-run sandbox across continuity.',
            trigger: { kind: 'interval', everySeconds: 3_600 },
            confirm: true,
            target: { kind: 'agent-session', sessionId: session.id },
            workspace: {
              kind: 'repository',
              repoId: 'repo',
              providerId: 'local',
              resource: { lifecycle: 'per-run' },
              revision: { ref: 'main', mode: 'latest-each-run' },
              git: { mode: 'run-branch' },
              authority: 'trusted-workspace',
              overlap: 'allow-parallel',
            },
          },
          paths,
        ),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining('scheduled-worker context'),
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
