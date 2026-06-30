import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-exedev-context-'));
  tempRoots.push(path);
  return path;
}
