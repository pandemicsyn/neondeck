import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addNotification,
  addWorkflowSummary,
  markNotificationRead,
  resolveNotification,
} from './app-state';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { readRuntimeStatus } from './runtime-status';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('runtime status', () => {
  it('reports missing onboarding requirements', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);

    const status = await readRuntimeStatus(paths, {});

    expect(status.ok).toBe(false);
    expect(status.status).toBe('needs-config');
    expect(status.home).toBe(home);
    expect(status.providers.credentials).toEqual({
      kilo: false,
      github: false,
    });
    expect(status.providers.configs.kilocode).toMatchObject({
      enabled: true,
      apiKeyEnv: 'KILO_API_KEY',
      organizationIdEnv: null,
      apiKeyPresent: false,
      organizationIdPresent: false,
    });
    expect(status.counts.repos).toBe(0);
    expect(status.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'kilo-key',
          ok: false,
          level: 'needs-config',
        }),
        expect.objectContaining({
          id: 'github-token',
          ok: false,
          level: 'needs-config',
        }),
        expect.objectContaining({
          id: 'repos',
          ok: false,
          level: 'needs-config',
        }),
      ]),
    );
  });

  it('returns partial readiness when config files are invalid', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeFile(paths.repos, '{ "repos": [{ "id": "" }] }\n');

    const status = await readRuntimeStatus(paths, {
      KILOCODE_API_KEY: 'kilo',
      GITHUB_TOKEN: 'github',
    });

    expect(status.status).toBe('attention');
    expect(status.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'repos-config',
          ok: false,
          level: 'attention',
        }),
      ]),
    );
    expect(status.counts.repos).toBe(0);
  });

  it('reports unsupported configured model providers', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.config,
      JSON.stringify({
        version: 1,
        models: {
          displayAssistant: 'openai/gpt-5',
        },
      }),
    );
    await writeFile(
      paths.repos,
      JSON.stringify({
        repos: [
          {
            id: 'neondeck',
            github: { owner: 'pandemicsyn', name: 'neondeck' },
            path: home,
            defaultBranch: 'main',
          },
        ],
      }),
    );

    const status = await readRuntimeStatus(paths, {
      KILOCODE_API_KEY: 'kilo',
      GITHUB_TOKEN: 'github',
    });

    expect(status.status).toBe('attention');
    expect(status.models.displayAssistantProvider).toBe('openai');
    expect(status.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'model-providers',
          ok: false,
          level: 'attention',
        }),
      ]),
    );
  });

  it('uses configured provider environment variable references in readiness', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.config,
      JSON.stringify({
        version: 1,
        models: {
          displayAssistant: 'kilocode/kilo/auto',
        },
        providers: {
          kilocode: {
            apiKeyEnv: 'NEONDECK_KILO_KEY',
            organizationIdEnv: 'NEONDECK_KILO_ORG',
          },
        },
      }),
    );
    await writeFile(
      paths.repos,
      JSON.stringify({
        repos: [
          {
            id: 'neondeck',
            github: { owner: 'pandemicsyn', name: 'neondeck' },
            path: home,
            defaultBranch: 'main',
          },
        ],
      }),
    );

    const status = await readRuntimeStatus(paths, {
      NEONDECK_KILO_KEY: 'kilo',
      NEONDECK_KILO_ORG: 'org',
      GITHUB_TOKEN: 'github',
    });

    expect(status.providers.credentials.kilo).toBe(true);
    expect(status.providers.configs.kilocode).toEqual({
      enabled: true,
      apiKeyEnv: 'NEONDECK_KILO_KEY',
      organizationIdEnv: 'NEONDECK_KILO_ORG',
      apiKeyPresent: true,
      organizationIdPresent: true,
    });
    expect(status.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'kilo-key',
          ok: true,
        }),
      ]),
    );
  });

  it('reports configured kilocode models as attention when provider is disabled', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.config,
      JSON.stringify({
        version: 1,
        models: {
          displayAssistant: 'kilocode/kilo/auto',
        },
        providers: {
          kilocode: {
            enabled: false,
          },
        },
      }),
    );
    await writeFile(
      paths.repos,
      JSON.stringify({
        repos: [
          {
            id: 'neondeck',
            github: { owner: 'pandemicsyn', name: 'neondeck' },
            path: home,
            defaultBranch: 'main',
          },
        ],
      }),
    );

    const status = await readRuntimeStatus(paths, {
      KILOCODE_API_KEY: 'kilo',
      GITHUB_TOKEN: 'github',
    });

    expect(status.status).toBe('attention');
    expect(status.providers.credentials.kilo).toBe(false);
    expect(status.providers.configs.kilocode.enabled).toBe(false);
    expect(status.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'kilo-key',
          ok: false,
          level: 'needs-config',
          message: 'Kilo provider is disabled in config.json.',
        }),
        expect.objectContaining({
          id: 'model-providers',
          ok: false,
          level: 'attention',
          message: 'Disabled model provider: kilocode.',
        }),
      ]),
    );
  });

  it('reports configured models, counts, and recent Flue failures', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await writeFile(
      paths.config,
      JSON.stringify({
        version: 1,
        models: {
          displayAssistant: 'kilocode/kilo/auto',
          subagents: {
            ciInvestigator: 'kilocode/kilo/ci',
          },
        },
      }),
    );
    await writeFile(
      paths.repos,
      JSON.stringify({
        repos: [
          {
            id: 'neondeck',
            github: { owner: 'pandemicsyn', name: 'neondeck' },
            path: home,
            defaultBranch: 'main',
          },
        ],
      }),
    );
    await addWorkflowSummary(
      {
        workflow: 'command:review-queue',
        runId: 'run_123',
        status: 'failed',
        summary: { message: 'Review queue failed.' },
      },
      paths,
    );
    await addNotification(
      {
        level: 'attention',
        title: 'Workflow failed',
        message: 'Workflow run run_123 failed.',
        source: 'flue',
        sourceId: 'run_123',
      },
      paths,
    );

    const status = await readRuntimeStatus(paths, {
      KILOCODE_API_KEY: 'kilo',
      GITHUB_TOKEN: 'github',
    });

    expect(status.status).toBe('attention');
    expect(status.providers.credentials).toEqual({
      kilo: true,
      github: true,
    });
    expect(status.models.displayAssistant).toBe('kilocode/kilo/auto');
    expect(status.models.displayAssistantProvider).toBe('kilocode');
    expect(status.models.subagents.ciInvestigator).toBe('kilocode/kilo/ci');
    expect(status.counts.repos).toBe(1);
    expect(status.counts.failedWorkflowSummaries).toBe(1);
    expect(status.counts.flueFailureNotifications).toBe(1);
    expect(status.lastFlueErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'workflow-summary',
          runId: 'run_123',
          message: 'Review queue failed.',
        }),
        expect.objectContaining({
          source: 'notification',
          runId: 'run_123',
        }),
      ]),
    );
  });

  it('keeps read Flue notifications in readiness until resolved', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const summary = await addWorkflowSummary(
      {
        workflow: 'command:review-queue',
        runId: 'run_old',
        status: 'failed',
        summary: { message: 'Old failure.' },
      },
      paths,
    );
    const notification = await addNotification(
      {
        level: 'attention',
        title: 'Workflow failed',
        message: 'Workflow run run_read failed.',
        source: 'flue',
        sourceId: 'run_read',
      },
      paths,
    );
    await markNotificationRead(notification.id, paths);
    const database = new DatabaseSync(paths.neondeckDatabase);
    try {
      database
        .prepare(
          `
          UPDATE workflow_summaries
          SET created_at = datetime('now', '-2 days')
          WHERE id = ?;
        `,
        )
        .run(summary.id);
    } finally {
      database.close();
    }

    const status = await readRuntimeStatus(paths, {});

    expect(status.counts.failedWorkflowSummaries).toBe(0);
    expect(status.counts.flueFailureNotifications).toBe(1);
    expect(status.lastFlueErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'notification',
          runId: 'run_read',
        }),
      ]),
    );
  });

  it('ignores resolved Flue notifications', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const notification = await addNotification(
      {
        level: 'attention',
        title: 'Workflow failed',
        message: 'Workflow run run_resolved failed.',
        source: 'flue',
        sourceId: 'run_resolved',
      },
      paths,
    );
    await resolveNotification(notification.id, paths);

    const status = await readRuntimeStatus(paths, {});

    expect(status.counts.flueFailureNotifications).toBe(0);
    expect(status.lastFlueErrors).toEqual([]);
  });

  it('counts only active PR watches as active watches', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const now = new Date().toISOString();
    const database = new DatabaseSync(paths.neondeckDatabase);
    try {
      const statement = database.prepare(
        `
          INSERT INTO pr_watches (
            id,
            repo_id,
            repo_full_name,
            github_owner,
            github_name,
            pr_number,
            desired_terminal_state,
            status,
            created_at,
            updated_at
          )
          VALUES (?, 'neondeck', 'pandemicsyn/neondeck', 'pandemicsyn', 'neondeck', ?, 'checks-green', ?, ?, ?);
        `,
      );
      statement.run('pandemicsyn/neondeck#1', 1, 'watching', now, now);
      statement.run('pandemicsyn/neondeck#2', 2, 'merged', now, now);
      statement.run('pandemicsyn/neondeck#3', 3, 'attention-needed', now, now);
      statement.run('pandemicsyn/neondeck#4', 4, 'green', now, now);
      statement.run('pandemicsyn/neondeck#5', 5, 'closed', now, now);
    } finally {
      database.close();
    }

    const status = await readRuntimeStatus(paths, {});

    expect(status.counts.activeWatches).toBe(3);
  });
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-status-'));
  tempRoots.push(path);
  return path;
}
