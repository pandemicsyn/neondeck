import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addPrWatch,
  listPrWatches,
  parseWatchPrReference,
  refreshPrWatch,
  removePrWatch,
} from './watch-actions';
import { runtimePaths } from './runtime-home';
import type { GitHubPullRequestDetail } from './github';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('PR watch actions', () => {
  it('parses supported PR watch reference forms', () => {
    const registry = {
      repos: [
        {
          id: 'neondeck',
          github: { owner: 'pandemicsyn', name: 'neondeck' },
          path: '/src/neondeck',
          defaultBranch: 'main',
        },
      ],
    };

    expect(
      parseWatchPrReference('pandemicsyn/neondeck#123', registry),
    ).toMatchObject({
      ok: true,
      reference: {
        id: 'pandemicsyn/neondeck#123',
        desiredTerminalState: 'checks',
      },
    });
    expect(
      parseWatchPrReference('neondeck#123 until prod', registry),
    ).toMatchObject({
      ok: true,
      reference: {
        repoId: 'neondeck',
        id: 'pandemicsyn/neondeck#123',
        desiredTerminalState: 'prod',
      },
    });
    expect(
      parseWatchPrReference(
        'https://github.com/pandemicsyn/neondeck/pull/123',
        registry,
      ),
    ).toMatchObject({
      ok: true,
      reference: { id: 'pandemicsyn/neondeck#123' },
    });
    expect(parseWatchPrReference('#123', registry)).toMatchObject({
      ok: true,
      reference: { id: 'pandemicsyn/neondeck#123' },
    });
  });

  it('requires repo context for bare PR numbers when registry is ambiguous', () => {
    const registry = {
      repos: [
        {
          id: 'neondeck',
          github: { owner: 'pandemicsyn', name: 'neondeck' },
          path: '/src/neondeck',
          defaultBranch: 'main',
        },
        {
          id: 'flue',
          github: { owner: 'pandemicsyn', name: 'flue' },
          path: '/src/flue',
          defaultBranch: 'main',
        },
      ],
    };

    expect(parseWatchPrReference('#123', registry)).toMatchObject({
      ok: false,
      result: { requires: ['repo'] },
    });
  });

  it('adds, lists, silently refreshes, and removes PR watches', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    const detail = prDetail({
      state: 'open',
      updatedAt: '2026-06-27T20:00:00Z',
    });
    const fetcher = async () => detail;

    await expect(
      addPrWatch({ ref: 'neondeck#123' }, paths, fetcher),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'created',
      watch: {
        id: 'pandemicsyn/neondeck#123',
        status: 'watching',
        prState: 'open',
      },
    });

    await expect(listPrWatches(paths)).resolves.toMatchObject({
      ok: true,
      changed: false,
      watches: [{ id: 'pandemicsyn/neondeck#123' }],
    });

    await expect(
      refreshPrWatch({ id: 'pandemicsyn/neondeck#123' }, paths, fetcher),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      outcome: 'silent',
    });

    await expect(
      removePrWatch({ id: 'pandemicsyn/neondeck#123' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['confirm'],
    });
    await expect(
      removePrWatch({ id: 'pandemicsyn/neondeck#123', confirm: true }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'removed',
    });
  });

  it('marks refresh changed when PR state changes', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addPrWatch({ ref: 'neondeck#123' }, paths, async () =>
      prDetail({ state: 'open', updatedAt: '2026-06-27T20:00:00Z' }),
    );

    await expect(
      refreshPrWatch({ id: 'pandemicsyn/neondeck#123' }, paths, async () =>
        prDetail({
          state: 'closed',
          merged: true,
          mergeCommitSha: 'abc123',
          updatedAt: '2026-06-27T20:05:00Z',
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      watch: {
        status: 'merged',
        mergeCommitSha: 'abc123',
      },
    });
  });
});

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
  tempRoots.push(home);
  return home;
}

async function writeRepoRegistry(path: string) {
  await writeFile(
    path,
    `${JSON.stringify({
      repos: [
        {
          id: 'neondeck',
          github: { owner: 'pandemicsyn', name: 'neondeck' },
          path: '/src/neondeck',
          defaultBranch: 'main',
        },
      ],
    })}\n`,
  );
}

function prDetail(
  overrides: Partial<GitHubPullRequestDetail> = {},
): GitHubPullRequestDetail {
  return {
    number: 123,
    title: 'Test PR',
    repo: 'pandemicsyn/neondeck',
    url: 'https://github.com/pandemicsyn/neondeck/pull/123',
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    headSha: 'head123',
    baseRef: 'main',
    updatedAt: '2026-06-27T20:00:00Z',
    ...overrides,
  };
}
