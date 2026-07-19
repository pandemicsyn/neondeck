import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureAutopilotWatch,
  configureAutopilotWatchAction,
  controlAutopilotWatchAction,
  readAutopilotPrOwnerByWatch,
} from './modules/autopilot';
import { updateRepoAutopilotWatchOverride } from './modules/config';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Autopilot Package 6 setup contract', () => {
  it('requires confirmation before creating a higher-authority watch, then creates only the awaiting-event owner', async () => {
    const paths = await fixture();
    const add = vi.fn(async () => ({
      ok: true,
      action: 'watch_pr_add',
      changed: true,
      outcome: 'created' as const,
      message: 'Watching pandemicsyn/neondeck#123.',
      watch: {
        id: 'pandemicsyn/neondeck#123',
        repoId: 'neondeck',
        repoFullName: 'pandemicsyn/neondeck',
        prNumber: 123,
        processExisting: true,
        initialEventProcessedAt: null,
      },
    }));

    await expect(
      configureAutopilotWatch(
        { ref: 'neondeck#123', mode: 'prepare-only' },
        paths,
        { addPrWatch: add },
      ),
    ).resolves.toMatchObject({ ok: false, requires: ['confirm'] });
    expect(add).not.toHaveBeenCalled();

    await expect(
      configureAutopilotWatch(
        {
          ref: 'neondeck#123',
          mode: 'prepare-only',
          processExisting: true,
          confirm: true,
        },
        paths,
        {
          addPrWatch: add,
          readAutopilotReadiness: async () =>
            ({ ok: true, message: 'ready' }) as never,
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      action: 'autopilot_watch_configure',
      owner: {
        status: 'awaiting-event',
        flueInstanceId: null,
        worktreeId: null,
      },
    });
    await expect(
      readAutopilotPrOwnerByWatch('pandemicsyn/neondeck#123', paths),
    ).resolves.toMatchObject({
      status: 'awaiting-event',
      flueInstanceId: null,
      worktreeId: null,
    });
  });

  it('upserts one stable watch override without replacing sibling overrides', async () => {
    const paths = await fixture({
      watchOverrides: [
        {
          watchId: 'pandemicsyn/neondeck#122',
          prNumber: 122,
          mode: 'prepare-only',
        },
      ],
    });
    await expect(
      updateRepoAutopilotWatchOverride(
        {
          repoId: 'neondeck',
          watchId: 'pandemicsyn/neondeck#123',
          prNumber: 123,
          mode: 'prepare-only',
          confirm: true,
        },
        paths,
      ),
    ).resolves.toMatchObject({ ok: true, changed: true });
    const config = JSON.parse(
      await (await import('node:fs/promises')).readFile(paths.repos, 'utf8'),
    );
    expect(config.repos[0].metadata.autopilot.watchOverrides).toEqual([
      {
        watchId: 'pandemicsyn/neondeck#122',
        prNumber: 122,
        mode: 'prepare-only',
      },
      {
        watchId: 'pandemicsyn/neondeck#123',
        prNumber: 123,
        mode: 'prepare-only',
      },
    ]);
  });

  it('serializes concurrent watch override upserts', async () => {
    const paths = await fixture();
    await Promise.all([
      updateRepoAutopilotWatchOverride(
        {
          repoId: 'neondeck',
          watchId: 'pandemicsyn/neondeck#123',
          prNumber: 123,
          mode: 'prepare-only',
          confirm: true,
        },
        paths,
      ),
      updateRepoAutopilotWatchOverride(
        {
          repoId: 'neondeck',
          watchId: 'pandemicsyn/neondeck#124',
          prNumber: 124,
          mode: 'prepare-only',
          confirm: true,
        },
        paths,
      ),
    ]);
    const config = JSON.parse(await readFile(paths.repos, 'utf8'));
    expect(config.repos[0].metadata.autopilot.watchOverrides).toHaveLength(2);
  });

  it('exposes the single setup and control actions to chat instead of separate surface-specific actions', () => {
    expect(configureAutopilotWatchAction.name).toBe(
      'neondeck_autopilot_watch_configure',
    );
    expect(controlAutopilotWatchAction.name).toBe(
      'neondeck_autopilot_watch_control',
    );
  });

  it('keeps API, CLI, and dashboard setup surfaces pointed at the shared service', async () => {
    const files = [
      'src/server/routes/autopilot.ts',
      'src/cli/index.ts',
      'web/src/api/watches.ts',
      'web/src/plugins/GitHubPrList.tsx',
    ];
    await Promise.all(
      files.map(async (file) => {
        await expect(readFile(file, 'utf8')).resolves.toContain(
          'configureAutopilotWatch',
        );
      }),
    );
  });
});

async function fixture(autopilot: Record<string, unknown> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-autopilot-package-6-'));
  roots.push(home);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  await writeFile(
    paths.repos,
    JSON.stringify({
      version: 1,
      repos: [
        {
          id: 'neondeck',
          path: '/tmp/neondeck',
          github: { owner: 'pandemicsyn', name: 'neondeck' },
          defaultBranch: 'main',
          metadata: { autopilot },
        },
      ],
    }),
  );
  return paths;
}
