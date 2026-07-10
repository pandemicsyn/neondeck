import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listWorkflowSummaries } from './modules/app-state';
import { runNeonCommand } from './modules/commands';
import { updateAgentModels } from './modules/config';
import { listMemories, upsertMemory } from './modules/memory';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { listRuntimeSkills } from './modules/runtime';
import { readRuntimeStatus } from './modules/runtime';

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

    const skills = await listRuntimeSkills(paths);
    expect(skills.skills).toEqual(
      expect.arrayContaining([
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
        expect.objectContaining({
          id: 'neon-pr-review',
          status: 'active',
          source: 'user',
        }),
        expect.objectContaining({
          id: 'neon-ci-fix',
          status: 'active',
          source: 'user',
        }),
        expect.objectContaining({
          id: 'neon-docs-fix',
          status: 'active',
          source: 'user',
        }),
        expect.objectContaining({
          id: 'neon-issue-triage',
          status: 'active',
          source: 'user',
        }),
      ]),
    );

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
          scope: 'local',
          key: 'smoke',
          value: 'fresh runtime is writable',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      action: 'memory_learn',
    });
    await expect(
      listMemories({ scope: 'local', key: 'smoke' }, paths),
    ).resolves.toMatchObject({
      memories: [
        {
          scope: 'local',
          key: 'smoke',
          value: 'fresh runtime is writable',
        },
      ],
    });

    await expect(
      runNeonCommand({ command: '/memory local' }, paths),
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
      openai: false,
      anthropic: false,
      github: true,
    });
  });
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-fresh-runtime-'));
  tempRoots.push(path);
  return path;
}
