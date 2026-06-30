import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseEnvFile,
  resolveExeDevCheckoutTarget,
  resolveExeDevForwardedEnv,
} from './exedev-context';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
  delete process.env.NEONDECK_TEST_HOST_SECRET;
});

describe('exe.dev checkout context', () => {
  it('parses dotenv-style values without name-based redaction', () => {
    expect(
      parseEnvFile(`
TOKEN_SECRET=keep-me
export QUOTED="hello world"
QUOTED_HASH="hello # world"
PLAIN=value # comment
`),
    ).toEqual({
      TOKEN_SECRET: 'keep-me',
      QUOTED: 'hello world',
      QUOTED_HASH: 'hello # world',
      PLAIN: 'value',
    });
  });

  it('resolves explicitly enabled repo env sources and audits source names only', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const repoPath = join(paths.home, 'repo');
    await mkdir(repoPath, { recursive: true });
    await writeFile(
      join(repoPath, '.env.exe'),
      'SECRET_TOKEN=file-secret\nPUBLIC_FLAG=file\n',
    );
    process.env.NEONDECK_TEST_HOST_SECRET = 'host-secret';
    await writeFile(
      paths.repos,
      JSON.stringify(
        {
          repos: [
            {
              id: 'app',
              github: { owner: 'pandemicsyn', name: 'neondeck' },
              path: repoPath,
              defaultBranch: 'main',
            },
          ],
        },
        null,
        2,
      ),
    );
    await writeFile(
      paths.config,
      JSON.stringify(
        {
          version: 1,
          execution: {
            exeDev: {
              remoteRoot: '/home/user/sandboxes',
              repos: {
                app: {
                  env: {
                    enabled: true,
                    files: ['.env.exe'],
                    vars: { CONFIG_SECRET: 'config-secret' },
                    hostEnv: {
                      HOST_SECRET: 'NEONDECK_TEST_HOST_SECRET',
                    },
                  },
                },
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const target = await resolveExeDevCheckoutTarget({ repoId: 'app' }, paths);
    expect(target).toMatchObject({
      repoFullName: 'pandemicsyn/neondeck',
      remotePath: '/home/user/sandboxes/pandemicsyn-neondeck-repo',
    });

    const forwarded = await resolveExeDevForwardedEnv({ repoId: 'app' }, paths);
    expect(forwarded.env).toEqual({
      SECRET_TOKEN: 'file-secret',
      PUBLIC_FLAG: 'file',
      CONFIG_SECRET: 'config-secret',
      HOST_SECRET: 'host-secret',
    });
    expect(forwarded.sources).toEqual([
      {
        kind: 'repo-file',
        scope: 'repo',
        id: '.env.exe',
        keys: ['PUBLIC_FLAG', 'SECRET_TOKEN'],
      },
      {
        kind: 'config-vars',
        scope: 'repo',
        id: 'repo:vars',
        keys: ['CONFIG_SECRET'],
      },
      {
        kind: 'host-env',
        scope: 'repo',
        id: 'HOST_SECRET:NEONDECK_TEST_HOST_SECRET',
        keys: ['HOST_SECRET'],
      },
    ]);
    expect(JSON.stringify(forwarded.sources)).not.toContain('file-secret');
    expect(JSON.stringify(forwarded.sources)).not.toContain('config-secret');
    expect(JSON.stringify(forwarded.sources)).not.toContain('host-secret');
  });

  it('rejects symlinked repo env files before forwarding values', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const repoPath = join(paths.home, 'repo');
    const outsidePath = join(paths.home, 'outside.env');
    await mkdir(repoPath, { recursive: true });
    await writeFile(outsidePath, 'SECRET_TOKEN=outside\n');
    await symlink(outsidePath, join(repoPath, '.env.exe'));
    await writeRepo(paths, repoPath);
    await writeExeDevEnvConfig(paths, ['.env.exe']);

    const forwarded = await resolveExeDevForwardedEnv({ repoId: 'app' }, paths);

    expect(forwarded.env).toEqual({});
    expect(forwarded.sources).toEqual([
      {
        kind: 'repo-file',
        scope: 'repo',
        id: '.env.exe',
        keys: [],
        missing: true,
      },
    ]);
  });

  it('rejects repo env files that resolve outside the checkout', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const repoPath = join(paths.home, 'repo');
    const outsideDir = join(paths.home, 'outside');
    await mkdir(repoPath, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, '.env.exe'), 'SECRET_TOKEN=outside\n');
    await symlink(outsideDir, join(repoPath, 'linked-env'));
    await writeRepo(paths, repoPath);
    await writeExeDevEnvConfig(paths, ['linked-env/.env.exe']);

    const forwarded = await resolveExeDevForwardedEnv({ repoId: 'app' }, paths);

    expect(forwarded.env).toEqual({});
    expect(forwarded.sources).toEqual([
      {
        kind: 'repo-file',
        scope: 'repo',
        id: 'linked-env/.env.exe',
        keys: [],
        missing: true,
      },
    ]);
  });

  it('rejects deleted managed worktrees before resolving exe.dev targets', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const repoPath = join(paths.home, 'repo');
    const worktreePath = join(paths.home, 'worktree');
    await mkdir(repoPath, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await writeRepo(paths, repoPath);
    insertWorktree(paths, {
      id: 'wt_deleted',
      localPath: worktreePath,
      lifecycleStatus: 'deleted',
    });

    await expect(
      resolveExeDevCheckoutTarget({ worktreeId: 'wt_deleted' }, paths),
    ).rejects.toThrow('Worktree "wt_deleted" is deleted.');
  });
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-exedev-context-'));
  tempRoots.push(path);
  return path;
}

async function writeRepo(
  paths: ReturnType<typeof runtimePaths>,
  repoPath: string,
) {
  await writeFile(
    paths.repos,
    JSON.stringify(
      {
        repos: [
          {
            id: 'app',
            github: { owner: 'pandemicsyn', name: 'neondeck' },
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

async function writeExeDevEnvConfig(
  paths: ReturnType<typeof runtimePaths>,
  files: string[],
) {
  await writeFile(
    paths.config,
    JSON.stringify(
      {
        version: 1,
        execution: {
          exeDev: {
            repos: {
              app: {
                env: {
                  enabled: true,
                  files,
                },
              },
            },
          },
        },
      },
      null,
      2,
    ),
  );
}

function insertWorktree(
  paths: ReturnType<typeof runtimePaths>,
  input: { id: string; localPath: string; lifecycleStatus: string },
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO worktrees (
          id, repo_id, repo_full_name, github_owner, github_name, pr_number,
          base_ref, head_owner, head_name, head_ref, head_sha, local_path,
          storage_kind, owning_workflow_run_id, lifecycle_status,
          last_synced_sha, last_pushed_sha, cleanup_policy_json,
          direct_push_allowed, adopted, created_by, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        input.id,
        'app',
        'pandemicsyn/neondeck',
        'pandemicsyn',
        'neondeck',
        7,
        'main',
        'pandemicsyn',
        'neondeck',
        'feature',
        'abc123',
        input.localPath,
        'home',
        null,
        input.lifecycleStatus,
        'abc123',
        null,
        JSON.stringify({
          retainFailed: true,
          retainPreparedDiff: true,
          successfulGraceHours: 24,
          staleAgeHours: 168,
        }),
        1,
        0,
        'neondeck',
        now,
        now,
      );
  } finally {
    database.close();
  }
}
