import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { JsonValue } from '@flue/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { listWorkflowSummaries } from './modules/app-state';
import { runDocsDriftReport, stageDocsDriftFix } from './modules/docs-drift';
import { upsertMemory } from './modules/memory';
import { writeReport } from './modules/reports';
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

    const result = await runDocsDriftReport(
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
  }, 30_000);

  it('injects learning memories into staged docs-fix prompts and summary', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const repoPath = join(home, 'repo-memory');
    await mkdir(repoPath, { recursive: true });
    await writeRepoRegistry(paths.repos, repoPath);
    const memory = await upsertMemory(
      {
        scope: 'project',
        repoId: 'sample',
        key: 'docs-style',
        value: 'Docs fixes should preserve existing heading style.',
      },
      paths,
    );
    const report = await writeReport(
      {
        kind: 'docs-drift',
        title: 'Docs drift: pandemicsyn/sample',
        repoId: 'sample',
        sourceRef: 'base..head',
        createdBy: 'test',
        summary: {
          repo: 'sample',
          repoFullName: 'pandemicsyn/sample',
          base: 'base',
          scannedCommit: 'head',
          attemptedCommit: 'head',
          truncated: false,
          hits: [
            {
              docPath: 'docs/api.md',
              changedPath: 'src/api.ts',
              previousPath: null,
              status: 'M',
              line: 1,
              excerpt: 'oldApi',
            },
          ],
        },
        html: '<p>docs drift</p>',
      },
      paths,
    );
    let prompt = '';

    const result = await stageDocsDriftFix({ reportId: report.id }, paths, {
      createWorktree: async () =>
        ({
          ok: true,
          action: 'worktree_create',
          changed: true,
          message: 'created',
          worktree: {
            id: 'wt-docs',
            localPath: join(home, 'worktree'),
            headSha: 'head',
          },
        }) as never,
      startKiloTask: async (input) => {
        prompt = String((input as { prompt?: unknown }).prompt ?? '');
        return {
          ok: true,
          action: 'kilo_task_start',
          changed: true,
          message: 'started',
          task: { id: 'docs-task' },
        } as never;
      },
    });
    const memoryId = (memory as { memory: { id: string } }).memory.id;

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(prompt).toContain(
      'Docs fixes should preserve existing heading style',
    );
    expect(prompt).toContain('Learning memories background context');
    await expect(listWorkflowSummaries(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflow: 'docs_drift_stage_fix',
          summary: expect.objectContaining({
            reportId: report.id,
            kiloTaskId: 'docs-task',
            memoryIds: [memoryId],
          }),
        }),
      ]),
    );
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

function job(config: Record<string, unknown>) {
  return {
    id: 'schedule:docs',
    config: config as JsonValue,
    lastResult: null,
  };
}

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-docs-drift-'));
  tempRoots.push(path);
  return path;
}

async function writeRepoRegistry(path: string, repoPath: string) {
  await writeFile(
    path,
    JSON.stringify(
      {
        repos: [
          {
            id: 'sample',
            github: { owner: 'pandemicsyn', name: 'sample' },
            path: repoPath,
            defaultBranch: 'main',
          },
        ],
      },
      null,
      2,
    ),
  );
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}
