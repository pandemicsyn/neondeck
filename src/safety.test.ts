import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSafetyPolicy } from './safety';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('safety policy', () => {
  it('classifies destructive mutations and host execution boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neondeck-safety-'));
    tempRoots.push(root);
    const paths = runtimePaths(root);
    await ensureRuntimeHome(paths);
    const policy = readSafetyPolicy(paths);

    expect(policy).toMatchObject({
      ok: true,
      action: 'safety_policy_read',
      version: 3,
    });
    expect(policy.summary.destructiveMutation).toBeGreaterThanOrEqual(4);
    expect(policy.summary.hostExecution).toBe(1);
    expect(policy.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'neondeck_command_run',
          primitive: 'action',
          class: 'safe-mutation',
          audited: true,
        }),
        expect.objectContaining({
          id: 'neondeck_scheduler_tick',
          primitive: 'action',
          class: 'safe-mutation',
          audited: true,
        }),
        expect.objectContaining({
          id: 'neondeck_skills_reload',
          primitive: 'action',
          class: 'safe-mutation',
          audited: true,
        }),
        expect.objectContaining({
          id: 'neondeck_dev_doctor_run',
          primitive: 'action',
          class: 'read-only',
          unattended: true,
        }),
        expect.objectContaining({
          id: 'neondeck_config_remove_repo',
          primitive: 'action',
          class: 'destructive-mutation',
          requiresConfirmation: true,
          audited: true,
          auditTarget: 'config_history',
        }),
        expect.objectContaining({
          id: 'neondeck_config_remove_schedule',
          class: 'destructive-mutation',
          requiresConfirmation: true,
          audited: true,
          auditTarget: 'config_history',
        }),
        expect.objectContaining({
          id: 'neondeck_watch_pr_remove',
          class: 'destructive-mutation',
          requiresConfirmation: true,
          audited: true,
        }),
        expect.objectContaining({
          id: 'neondeck_memory_delete',
          class: 'destructive-mutation',
          requiresConfirmation: true,
          audited: true,
        }),
        expect.objectContaining({
          id: 'neondeck_execution_policy_check',
          primitive: 'action',
          class: 'read-only',
          unattended: true,
        }),
        expect.objectContaining({
          id: 'neondeck_config_update_execution_policy',
          primitive: 'action',
          class: 'safe-mutation',
          audited: true,
          auditTarget: 'config_history',
        }),
        expect.objectContaining({
          id: 'future_host_shell_or_code_action',
          class: 'host-execution',
          unattended: false,
          requiresConfirmation: true,
        }),
      ]),
    );
    expect(policy.hostExecutionPolicy).toContain('local');
    expect(policy.executionPolicy).toMatchObject({
      defaultBackend: 'local',
      enabledBackends: ['local'],
      supportedBackends: ['local', 'exe.dev'],
      approvalMode: 'manual',
      unattended: 'deny',
      defaultLocalAccess: true,
      exeDevPlanned: true,
    });
  });
});
