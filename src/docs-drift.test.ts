import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobRecord } from './modules/app-state';
import { runDocsDriftJob } from './modules/docs-drift';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('docs drift job', () => {
  it('scans fetched default-branch docs instead of stale local HEAD', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const remote = join(home, 'origin.git');
    const repo = join(home, 'repo');
    await setupRemoteRepo(remote, repo);
    await writeFile(
      paths.repos,
      JSON.stringify(
        {
          repos: [
            {
              id: 'sample',
              github: { owner: 'pandemicsyn', name: 'sample' },
              path: repo,
              defaultBranch: 'main',
            },
          ],
        },
        null,
        2,
      ),
    );

    const result = await runDocsDriftJob(
      job({
        repo: 'sample',
        docsGlobs: ['docs/**/*.md'],
        sourceGlobs: ['src/**/*.ts'],
      }),
      paths,
    );
    const summary = result.result as Record<string, unknown>;

    expect(result).toMatchObject({
      outcome: 'updated',
      result: {
        repo: 'sample',
        repoFullName: 'pandemicsyn/sample',
        headSource: 'origin/main',
        truncated: true,
        sourceOffset: 0,
        docOffset: 0,
        cursor: expect.objectContaining({
          sourceOffset: 200,
          docOffset: 0,
        }),
        hitCount: 2,
        hits: [
          expect.objectContaining({
            docPath: 'docs/api.md',
            changedPath: 'src/new.ts',
            previousPath: 'src/old.ts',
            excerpt: expect.stringContaining('src/old.ts'),
          }),
          expect.objectContaining({
            docPath: 'docs/api.md',
            changedPath: 'src/api.ts',
            previousPath: null,
            excerpt: expect.stringContaining('oldApi'),
          }),
        ],
      },
    });
    expect(summary.scannedCommit).not.toBe(summary.attemptedCommit);
  });
});

async function setupRemoteRepo(remote: string, repo: string) {
  await git(dirname(remote), ['init', '--bare', remote]);
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'neon@example.test']);
  await git(repo, ['config', 'user.name', 'Neon Test']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  await git(repo, ['remote', 'add', 'origin', remote]);
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, 'docs'), { recursive: true });
  await writeFile(
    join(repo, 'src', 'old.ts'),
    'export const oldName = true;\n',
  );
  await writeFile(join(repo, 'src', 'api.ts'), 'export const oldApi = true;\n');
  await writeFile(join(repo, 'docs', 'api.md'), 'No stale reference here.\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'initial docs']);
  const firstCommit = await git(repo, ['rev-parse', 'HEAD']);
  await git(repo, ['push', '-u', 'origin', 'main']);

  await git(repo, ['mv', 'src/old.ts', 'src/new.ts']);
  await writeFile(join(repo, 'src', 'api.ts'), 'export const newApi = true;\n');
  for (let index = 0; index < 201; index += 1) {
    await writeFile(
      join(repo, 'src', `zzz-extra-${String(index).padStart(3, '0')}.ts`),
      `export const extra${index} = true;\n`,
    );
  }
  await writeFile(
    join(repo, 'docs', 'api.md'),
    `Remote docs still mention src/old.ts.\nRemote docs still mention oldApi.\n\n${'x'.repeat(300_000)}\n`,
  );
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'rename source']);
  await git(repo, ['push', 'origin', 'main']);
  await git(repo, ['reset', '--hard', firstCommit]);
}

function job(config: Record<string, unknown>): JobRecord {
  const now = new Date().toISOString();
  return {
    id: 'schedule:docs',
    type: 'docs-drift',
    blueprint: 'docs-drift',
    enabled: true,
    intervalSeconds: 600,
    config: config as JobRecord['config'],
    nextRunAt: now,
    lastRunAt: null,
    lastOutcome: null,
    lastMessage: null,
    lastResult: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-docs-drift-'));
  tempRoots.push(path);
  return path;
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}
