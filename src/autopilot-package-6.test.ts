import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureAutopilotWatch,
  configureAutopilotWatchAction,
  controlAutopilotWatchAction,
  controlAutopilotWatch,
  ensureAutopilotPrOwner,
  listAutopilotWatchBindings,
  readAutopilotState,
  readAutopilotPrOwnerByWatch,
} from './modules/autopilot';
import { isAutopilotSetupBlocked } from './modules/autopilot/setup-transactions';
import { leaseOwnerIsAlive } from './modules/autopilot/lease-owner';
import { updateRepoAutopilotWatchOverride } from './modules/config';
import { executeScheduledTask } from './modules/scheduled-tasks/dispatch';
import {
  watchPrAddAction,
  watchPrPollingAction,
} from './modules/watches/actions';
import { insertWatch } from './modules/watches';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { createAutopilotRoutes } from './server/routes/autopilot';

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Autopilot Package 6 setup contract', () => {
  it('does not treat a reused PID with a different process identity as a live lease owner', async () => {
    await expect(
      leaseOwnerIsAlive(
        JSON.stringify({
          pid: process.pid,
          processStart: 'different-process-generation',
          token: 'stale-owner',
        }),
      ),
    ).resolves.toBe(false);
  });

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

    const confirmationRequest = await configureAutopilotWatch(
      { ref: 'neondeck#123', mode: 'prepare-only' },
      paths,
      { addPrWatch: add },
    );
    expect(confirmationRequest).toMatchObject({
      ok: false,
      requires: ['confirm'],
      confirmation: { intent: setupConfirmation() },
    });
    expect(add).not.toHaveBeenCalled();

    await expect(
      configureAutopilotWatch(
        {
          ref: 'neondeck#123',
          mode: 'prepare-only',
          processExisting: true,
          confirm: true,
          confirmation: setupConfirmation(),
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

  it('requires confirmation for an unbound watch even when a repo default is more authoritative', async () => {
    const paths = await fixture({ mode: 'autofix-push-when-safe' });
    const add = vi.fn(async () => setupWatchResult());

    await expect(
      configureAutopilotWatch(
        { ref: 'neondeck#123', mode: 'prepare-only' },
        paths,
        { addPrWatch: add },
      ),
    ).resolves.toMatchObject({ ok: false, requires: ['confirm'] });
    expect(add).not.toHaveBeenCalled();
  });

  it('rejects a confirmation token when any setup intent field changes', async () => {
    const paths = await fixture();
    const first = await configureAutopilotWatch(
      { ref: 'neondeck#123', mode: 'prepare-only' },
      paths,
    );
    const intent = confirmationIntentFrom(first);
    await expect(
      configureAutopilotWatch(
        {
          ref: 'neondeck#123',
          mode: 'autofix-with-approval',
          confirm: true,
          confirmation: intent,
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['confirm'],
      confirmation: {
        intent: setupConfirmation('autofix-with-approval'),
      },
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

  it('preserves sibling overrides when two separate processes configure watches together', async () => {
    const paths = await fixture();
    const moduleUrl = pathToFileURL(
      fileURLToPath(
        new URL('./modules/config/mutations/repos.ts', import.meta.url),
      ),
    ).href;
    const pathsUrl = pathToFileURL(
      fileURLToPath(new URL('./runtime-home/paths.ts', import.meta.url)),
    ).href;
    const command = (watchId: string, prNumber: number) => `
      import { updateRepoAutopilotWatchOverride } from ${JSON.stringify(moduleUrl)};
      import { runtimePaths } from ${JSON.stringify(pathsUrl)};
      const result = await updateRepoAutopilotWatchOverride({
        repoId: 'neondeck', watchId: ${JSON.stringify(watchId)}, prNumber: ${prNumber},
        mode: 'prepare-only', confirm: true,
      }, runtimePaths(${JSON.stringify(paths.home)}));
      if (!result.ok) throw new Error(result.message);
    `;
    await Promise.all([
      execFileAsync(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        command('pandemicsyn/neondeck#123', 123),
      ]),
      execFileAsync(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        command('pandemicsyn/neondeck#124', 124),
      ]),
    ]);
    const config = JSON.parse(await readFile(paths.repos, 'utf8'));
    expect(config.repos[0].metadata.autopilot.watchOverrides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ watchId: 'pandemicsyn/neondeck#123' }),
        expect.objectContaining({ watchId: 'pandemicsyn/neondeck#124' }),
      ]),
    );
  });

  it('fails closed when override or owner binding cannot complete', async () => {
    const paths = await fixture();
    const add = vi.fn(async () => setupWatchResult());
    await expect(
      configureAutopilotWatch(confirmedSetupInput(), paths, {
        addPrWatch: add,
        updateRepoAutopilotWatchOverride: async () =>
          ({ ok: false, message: 'override write failed' }) as never,
      }),
    ).resolves.toMatchObject({ ok: false, requires: ['retrySetup'] });
    await expect(
      isAutopilotSetupBlocked('pandemicsyn/neondeck#123', paths),
    ).resolves.toBe(true);
    await expect(
      controlAutopilotWatch(
        { operation: 'pause', watchId: 'pandemicsyn/neondeck#123' },
        paths,
      ),
    ).resolves.toMatchObject({ ok: false, requires: ['retrySetup'] });
    const previousHome = process.env.NEONDECK_HOME;
    process.env.NEONDECK_HOME = paths.home;
    try {
      await expect(
        watchPrPollingAction.run({
          input: { id: 'pandemicsyn/neondeck#123', enabled: true },
        } as never),
      ).resolves.toMatchObject({ ok: false, requires: ['retrySetup'] });
      await expect(
        watchPrAddAction.run({
          input: { ref: 'neondeck#123', processExisting: true },
        } as never),
      ).resolves.toMatchObject({ ok: false, requires: ['retrySetup'] });
    } finally {
      if (previousHome === undefined) delete process.env.NEONDECK_HOME;
      else process.env.NEONDECK_HOME = previousHome;
    }
    await expect(
      configureAutopilotWatch(confirmedSetupInput(), paths, {
        addPrWatch: async () =>
          ({
            ok: false,
            action: 'watch_pr_add',
            message: 'retry failed',
          }) as never,
      }),
    ).resolves.toMatchObject({ ok: false, message: 'retry failed' });
    await expect(
      isAutopilotSetupBlocked('pandemicsyn/neondeck#123', paths),
    ).resolves.toBe(true);
    await expect(
      executeScheduledTask(
        {
          id: 'watch:pandemicsyn/neondeck#123',
          spec: { kind: 'poll-pr-watch', watchId: 'pandemicsyn/neondeck#123' },
          trigger: { kind: 'interval', everySeconds: 300 },
          enabled: true,
          nextRunAt: null,
          claimId: null,
          claimExpiresAt: null,
          lastRunAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        null,
        paths,
      ),
    ).resolves.toMatchObject({
      outcome: 'silent',
      message: expect.stringContaining('setup recovery'),
    });

    await expect(
      configureAutopilotWatch(confirmedSetupInput(), paths, {
        addPrWatch: add,
        updateRepoAutopilotWatchOverride: async () =>
          ({ ok: true, changed: true, message: 'override' }) as never,
        ensureAutopilotPrOwner: async () => {
          throw new Error('owner write failed');
        },
      }),
    ).resolves.toMatchObject({ ok: false, requires: ['retrySetup'] });
    await expect(
      isAutopilotSetupBlocked('pandemicsyn/neondeck#123', paths),
    ).resolves.toBe(true);
  });

  it('keeps an add failure free of a blocked partial setup', async () => {
    const paths = await fixture();
    await expect(
      configureAutopilotWatch(confirmedSetupInput(), paths, {
        addPrWatch: async () =>
          ({
            ok: false,
            action: 'watch_pr_add',
            message: 'watch failed',
          }) as never,
      }),
    ).resolves.toMatchObject({ ok: false, message: 'watch failed' });
    await expect(
      isAutopilotSetupBlocked('pandemicsyn/neondeck#123', paths),
    ).resolves.toBe(false);
  });

  it('fails closed when durable setup recovery state is malformed', async () => {
    const paths = await fixture();
    await writeFile(
      join(paths.data, 'autopilot-setup-transactions.json'),
      '{not valid json',
    );
    await expect(
      isAutopilotSetupBlocked('pandemicsyn/neondeck#123', paths),
    ).resolves.toBe(true);
    await expect(
      configureAutopilotWatch(confirmedSetupInput(), paths, {
        addPrWatch: async () => setupWatchResult() as never,
      }),
    ).rejects.toThrow('recovery state');
  });

  it('does not expose an ordinary PR watch through Autopilot status or controls', async () => {
    const paths = await fixture({
      watchOverrides: [
        {
          watchId: 'pandemicsyn/neondeck#123',
          prNumber: 123,
          mode: 'prepare-only',
        },
      ],
    });
    const now = new Date().toISOString();
    insertWatch(paths, {
      id: 'pandemicsyn/neondeck#123',
      repoId: 'neondeck',
      repoFullName: 'pandemicsyn/neondeck',
      githubOwner: 'pandemicsyn',
      githubName: 'neondeck',
      prNumber: 123,
      desiredTerminalState: 'checks',
      status: 'watching',
      prState: 'open',
      title: 'Ordinary watch',
      url: null,
      mergeCommitSha: null,
      lastSnapshot: null,
      lastOutcome: 'created',
      lastCheckedAt: null,
      createdBy: 'watch-pr-add',
      processExisting: false,
      initialEventProcessedAt: now,
      eventWatermarkVersion: 2,
      eventGenerationId: 'ordinary-watch',
      createdAt: now,
      updatedAt: now,
    });
    await expect(listAutopilotWatchBindings(paths)).resolves.toEqual([]);
    await expect(readAutopilotState(paths)).resolves.toMatchObject({
      summary: { activeWatches: 0 },
      policies: { watches: [] },
    });
    await expect(
      controlAutopilotWatch(
        { operation: 'status', watchId: 'pandemicsyn/neondeck#123' },
        paths,
      ),
    ).resolves.toMatchObject({ ok: false, requires: ['autopilotWatch'] });
    const response = await createAutopilotRoutes(paths).request(
      'http://localhost/autopilot/watches/control',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'status',
          watchId: 'pandemicsyn/neondeck#123',
        }),
      },
    );
    expect(response.status).toBe(404);

    await ensureAutopilotPrOwner(
      {
        watchId: 'pandemicsyn/neondeck#123',
        repoId: 'neondeck',
        prNumber: 123,
      },
      paths,
    );
    await expect(listAutopilotWatchBindings(paths)).resolves.toHaveLength(1);
    await expect(
      controlAutopilotWatch(
        {
          operation: 'stop',
          watchId: 'pandemicsyn/neondeck#123',
          confirm: true,
        },
        paths,
      ),
    ).resolves.toMatchObject({ ok: true });
    insertWatch(paths, {
      id: 'pandemicsyn/neondeck#123',
      repoId: 'neondeck',
      repoFullName: 'pandemicsyn/neondeck',
      githubOwner: 'pandemicsyn',
      githubName: 'neondeck',
      prNumber: 123,
      desiredTerminalState: 'checks',
      status: 'watching',
      prState: 'open',
      title: 'Ordinary re-watch',
      url: null,
      mergeCommitSha: null,
      lastSnapshot: null,
      lastOutcome: 'created',
      lastCheckedAt: null,
      createdBy: 'watch-pr-add',
      processExisting: false,
      initialEventProcessedAt: now,
      eventWatermarkVersion: 2,
      eventGenerationId: 'ordinary-rewatch',
      createdAt: now,
      updatedAt: now,
    });
    await expect(listAutopilotWatchBindings(paths)).resolves.toEqual([]);
  });

  it('exposes the single setup and control actions to chat instead of separate surface-specific actions', () => {
    expect(configureAutopilotWatchAction.name).toBe(
      'neondeck_autopilot_watch_configure',
    );
    expect(controlAutopilotWatchAction.name).toBe(
      'neondeck_autopilot_watch_control',
    );
  });

  it('gives the typed chat action the same confirmation contract as the setup service', async () => {
    const paths = await fixture();
    const previousHome = process.env.NEONDECK_HOME;
    process.env.NEONDECK_HOME = paths.home;
    try {
      await expect(
        configureAutopilotWatchAction.run({
          input: { ref: 'neondeck#123', mode: 'prepare-only' },
        } as never),
      ).resolves.toMatchObject({
        ok: false,
        action: 'autopilot_watch_configure',
        requires: ['confirm'],
      });
    } finally {
      if (previousHome === undefined) delete process.env.NEONDECK_HOME;
      else process.env.NEONDECK_HOME = previousHome;
    }
  });

  it('returns the shared confirmation result through HTTP and CLI setup surfaces', async () => {
    const paths = await fixture();
    const routeResponse = await createAutopilotRoutes(paths).request(
      'http://localhost/autopilot/watches/configure',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: 'neondeck#123', mode: 'prepare-only' }),
      },
    );
    await expect(routeResponse.json()).resolves.toMatchObject({
      ok: false,
      action: 'autopilot_watch_configure',
      requires: ['confirm'],
    });
    const stdout = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli/index.ts',
      '--home',
      paths.home,
      '--json',
      'autopilot',
      'watch',
      'neondeck#123',
      '--mode',
      'prepare-only',
    ])
      .then((result) => result.stdout)
      .catch((error: { stdout?: string; code?: number }) => {
        expect(error.code).toBe(1);
        return error.stdout ?? '';
      });
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      action: 'autopilot_watch_configure',
      requires: ['confirm'],
    });

    const legacyStdout = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli/index.ts',
      '--home',
      paths.home,
      '--json',
      'autopilot',
      'neondeck#124',
      '--mode',
      'prepare-only',
      '--process-existing',
      '--interval',
      '120',
      '--reason',
      'legacy-script',
    ])
      .then((result) => result.stdout)
      .catch((error: { stdout?: string; code?: number }) => {
        expect(error.code).toBe(1);
        return error.stdout ?? '';
      });
    expect(JSON.parse(legacyStdout)).toMatchObject({
      ok: false,
      action: 'autopilot_watch_configure',
      requires: ['confirm'],
      confirmation: {
        intent: {
          processExisting: true,
          intervalSeconds: 120,
          reason: 'legacy-script',
        },
      },
    });

    const legacyDefaultStdout = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli/index.ts',
      '--home',
      paths.home,
      '--json',
      'autopilot',
      'neondeck#125',
      '--mode',
      'prepare-only',
    ])
      .then((result) => result.stdout)
      .catch((error: { stdout?: string; code?: number }) => {
        expect(error.code).toBe(1);
        return error.stdout ?? '';
      });
    expect(JSON.parse(legacyDefaultStdout)).toMatchObject({
      ok: false,
      action: 'autopilot_watch_configure',
      requires: ['confirm'],
      confirmation: { intent: { processExisting: false } },
    });

    const reorderedLegacyStdout = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli/index.ts',
      'autopilot',
      '--json',
      '--home',
      paths.home,
      'neondeck#126',
      '--mode',
      'prepare-only',
    ])
      .then((result) => result.stdout)
      .catch((error: { stdout?: string; code?: number }) => {
        expect(error.code).toBe(1);
        return error.stdout ?? '';
      });
    expect(JSON.parse(reorderedLegacyStdout)).toMatchObject({
      ok: false,
      action: 'autopilot_watch_configure',
      requires: ['confirm'],
      confirmation: { intent: { processExisting: false } },
    });

    const equalsLegacyStdout = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli/index.ts',
      '--home',
      paths.home,
      '--json',
      'autopilot',
      '--mode=prepare-only',
      'neondeck#127',
    ])
      .then((result) => result.stdout)
      .catch((error: { stdout?: string; code?: number }) => {
        expect(error.code).toBe(1);
        return error.stdout ?? '';
      });
    expect(JSON.parse(equalsLegacyStdout)).toMatchObject({
      ok: false,
      action: 'autopilot_watch_configure',
      requires: ['confirm'],
      confirmation: { intent: { processExisting: false } },
    });

    const terminatorLegacyStdout = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/cli/index.ts',
      '--home',
      paths.home,
      '--json',
      'autopilot',
      '--mode',
      'prepare-only',
      '--',
      'neondeck#128',
    ])
      .then((result) => result.stdout)
      .catch((error: { stdout?: string; code?: number }) => {
        expect(error.code).toBe(1);
        return error.stdout ?? '';
      });
    expect(JSON.parse(terminatorLegacyStdout)).toMatchObject({
      ok: false,
      action: 'autopilot_watch_configure',
      requires: ['confirm'],
      confirmation: { intent: { processExisting: false } },
    });
  });
});

function setupWatchResult() {
  return {
    ok: true,
    action: 'watch_pr_add',
    changed: true,
    message: 'watch',
    watch: {
      id: 'pandemicsyn/neondeck#123',
      repoId: 'neondeck',
      repoFullName: 'pandemicsyn/neondeck',
      prNumber: 123,
      processExisting: false,
      initialEventProcessedAt: null,
    },
  };
}

function setupConfirmation(
  mode: 'prepare-only' | 'autofix-with-approval' = 'prepare-only',
  processExisting = true,
) {
  return {
    watchId: 'pandemicsyn/neondeck#123',
    currentMode: 'notify-only' as const,
    mode,
    processExisting,
  };
}

function confirmedSetupInput() {
  return {
    ref: 'neondeck#123',
    mode: 'prepare-only' as const,
    confirm: true,
    confirmation: setupConfirmation(),
  };
}

function confirmationIntentFrom(result: unknown) {
  const intent =
    result &&
    typeof result === 'object' &&
    (result as { confirmation?: { intent?: unknown } }).confirmation?.intent;
  if (!intent) throw new Error('Expected a setup confirmation intent.');
  return intent;
}

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
