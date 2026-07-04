import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRepoRegistrySnapshot, repoFullName } from './modules/repos';
import { runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('repo registry foundation', () => {
  it('reads a validated runtime repo registry snapshot', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);

    await writeFile(
      paths.repos,
      `${JSON.stringify({
        repos: [
          {
            id: 'neondeck',
            github: { owner: 'pandemicsyn', name: 'neondeck' },
            path: '/src/neondeck',
            defaultBranch: 'main',
            productionTarget: 'neondeck.dev',
            packageScripts: { check: 'npm run check' },
          },
        ],
      })}\n`,
    );

    const snapshot = await readRepoRegistrySnapshot(paths);

    expect(snapshot).toMatchObject({
      home,
      path: paths.repos,
      count: 1,
      repos: [
        {
          id: 'neondeck',
          github: { owner: 'pandemicsyn', name: 'neondeck' },
          defaultBranch: 'main',
        },
      ],
    });
    expect(snapshot.fetchedAt).toBeTruthy();
    expect(await readFile(paths.repos, 'utf8')).toContain('neondeck');
  });

  it('formats a configured GitHub repo full name', () => {
    expect(
      repoFullName({
        github: { owner: 'pandemicsyn', name: 'neondeck' },
      }),
    ).toBe('pandemicsyn/neondeck');
  });
});
