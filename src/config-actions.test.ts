import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addRepo,
  addSchedule,
  readConfig,
  removeRepo,
  removeSchedule,
  updateRepo,
  updateSchedule,
  validateConfig,
} from './config-actions';
import {
  parseRepoRegistry,
  parseScheduleConfig,
  runtimePaths,
} from './runtime-home';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('config actions', () => {
  it('adds, updates, and removes a repo through validated config operations', async () => {
    const home = await tempDir('neondeck-home-');
    const repoPath = await tempGitRepo();
    const paths = runtimePaths(home);

    await writeFile(
      join(repoPath, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }),
    );

    await expect(
      addRepo({ path: repoPath, productionTarget: 'cloudflare' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      message: 'Added repository "neondeck".',
    });

    let repos = parseRepoRegistry(
      JSON.parse(await readFile(paths.repos, 'utf8')),
      paths.repos,
    ).repos;
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      id: 'neondeck',
      github: { owner: 'pandemicsyn', name: 'neondeck' },
      defaultBranch: 'main',
      productionTarget: 'cloudflare',
      packageScripts: { test: 'vitest run' },
    });

    await expect(
      updateRepo({ id: 'neondeck', defaultBranch: 'trunk' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      message: 'Updated repository "neondeck".',
    });

    repos = parseRepoRegistry(
      JSON.parse(await readFile(paths.repos, 'utf8')),
      paths.repos,
    ).repos;
    expect(repos[0].defaultBranch).toBe('trunk');

    await expect(removeRepo({ id: 'neondeck' }, paths)).resolves.toMatchObject({
      ok: true,
      changed: true,
      message: 'Removed repository "neondeck".',
    });
    repos = parseRepoRegistry(
      JSON.parse(await readFile(paths.repos, 'utf8')),
      paths.repos,
    ).repos;
    expect(repos).toEqual([]);
  });

  it('asks for required GitHub metadata when a git repo has no GitHub remote', async () => {
    const home = await tempDir('neondeck-home-');
    const repoPath = await tempGitRepo({ remote: false });
    const paths = runtimePaths(home);

    await expect(addRepo({ path: repoPath }, paths)).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['githubOwner', 'githubName'],
    });
  });

  it('adds, updates, and removes schedules through validated config operations', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    await expect(
      addSchedule(
        {
          id: 'morning',
          type: 'morning-briefing',
          preset: 'weekday-morning',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      message: 'Added schedule "morning".',
    });

    await expect(
      updateSchedule({ id: 'morning', enabled: false }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      message: 'Updated schedule "morning".',
    });

    let schedules = parseScheduleConfig(
      JSON.parse(await readFile(paths.schedules, 'utf8')),
      paths.schedules,
    ).schedules;
    expect(schedules).toMatchObject([
      { id: 'morning', type: 'morning-briefing', enabled: false },
    ]);

    await expect(
      removeSchedule({ id: 'morning' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      message: 'Removed schedule "morning".',
    });

    schedules = parseScheduleConfig(
      JSON.parse(await readFile(paths.schedules, 'utf8')),
      paths.schedules,
    ).schedules;
    expect(schedules).toEqual([]);
  });

  it('reads and validates config through explicit action boundaries', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    await expect(readConfig({ target: 'repos' }, paths)).resolves.toMatchObject(
      {
        ok: true,
        changed: false,
        data: { repos: { repos: [] } },
      },
    );

    await writeFile(paths.schedules, '{ "schedules": [{ "id": "" }] }\n');

    await expect(
      validateConfig({ target: 'schedules' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      message: 'Invalid schedules config.',
    });
    expect(existsSync(paths.neondeckDatabase)).toBe(true);
    expect(existsSync(paths.flueDatabase)).toBe(true);
  });
});

async function tempDir(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

async function tempGitRepo(options: { remote?: boolean } = {}) {
  const path = await tempDir('neondeck-repo-');
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: path });

  if (options.remote !== false) {
    await execFileAsync(
      'git',
      ['remote', 'add', 'origin', 'git@github.com:pandemicsyn/neondeck.git'],
      { cwd: path },
    );
  }

  return path;
}
