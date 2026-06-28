import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listWorkflowSummaries } from './app-state';
import { runNeonCommand } from './commands';
import { updateAgentModels } from './config-actions';
import { listMemories, upsertMemory } from './memory-actions';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { listRuntimeSkills } from './runtime-skills';
import { readRuntimeStatus } from './runtime-status';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('fresh runtime smoke test', () => {
  it('boots a clean runtime home and exercises core setup surfaces', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);

    await ensureRuntimeHome(paths);
    expect(existsSync(paths.config)).toBe(true);
    expect(existsSync(paths.repos)).toBe(true);
    expect(existsSync(paths.schedules)).toBe(true);
    expect(existsSync(paths.neondeckDatabase)).toBe(true);
    expect(existsSync(paths.flueDatabase)).toBe(true);

    const initialStatus = await readRuntimeStatus(paths, {});
    expect(initialStatus).toMatchObject({
      ok: false,
      service: 'neondeck',
      status: 'needs-config',
      home,
    });
    expect(initialStatus.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'kilo-key', ok: false }),
        expect.objectContaining({ id: 'github-token', ok: false }),
        expect.objectContaining({ id: 'repos', ok: false }),
      ]),
    );

    await expect(listRuntimeSkills(paths)).resolves.toMatchObject({
      skills: [
        expect.objectContaining({
          id: 'github-gh',
          status: 'active',
          source: 'built-in',
        }),
        expect.objectContaining({
          id: 'neondeck',
          status: 'active',
          source: 'built-in',
        }),
      ],
    });

    await expect(
      updateAgentModels(
        {
          displayAssistant: 'kilocode/kilo/smoke',
          subagents: {
            repoResearcher: 'kilocode/kilo/repo-smoke',
          },
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      action: 'config_update_agent_models',
    });

    await expect(
      upsertMemory(
        {
          scope: 'session',
          key: 'smoke',
          value: 'fresh runtime is writable',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      action: 'memory_upsert',
    });
    await expect(
      listMemories({ scope: 'session', key: 'smoke' }, paths),
    ).resolves.toMatchObject({
      memories: [
        {
          scope: 'session',
          key: 'smoke',
          value: 'fresh runtime is writable',
        },
      ],
    });

    await expect(
      runNeonCommand({ command: '/memory session' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      command: 'memory',
      status: 'completed',
      workflowSummary: {
        workflow: 'command:memory',
        status: 'completed',
      },
    });
    await expect(listWorkflowSummaries(paths)).resolves.toEqual([
      expect.objectContaining({
        workflow: 'command:memory',
        status: 'completed',
      }),
    ]);

    const configuredStatus = await readRuntimeStatus(paths, {
      KILOCODE_API_KEY: 'present',
      GITHUB_TOKEN: 'present',
    });
    expect(configuredStatus.models).toMatchObject({
      displayAssistant: 'kilocode/kilo/smoke',
      subagents: {
        repoResearcher: 'kilocode/kilo/repo-smoke',
      },
    });
    expect(configuredStatus.providers.credentials).toEqual({
      kilo: true,
      github: true,
    });
  });
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-fresh-runtime-'));
  tempRoots.push(path);
  return path;
}
