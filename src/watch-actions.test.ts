import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listJobs } from './modules/app-state';
import {
  addRefWatch,
  addPrWatch,
  listRefWatches,
  listPrWatches,
  parseWatchRefReference,
  parseWatchPrReference,
  refreshRefWatch,
  refreshPrWatch,
  removePrWatch,
  setPrWatchPolling,
} from './modules/watches';
import { runtimePaths } from './runtime-home';
import type {
  GitHubCheckSummary,
  GitHubPullRequestDetail,
} from './modules/github';

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
        createdBy: null,
      },
    });

    await expect(listPrWatches(paths)).resolves.toMatchObject({
      ok: true,
      changed: false,
      watches: [{ id: 'pandemicsyn/neondeck#123' }],
    });
    await expect(listJobs(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'watch:pandemicsyn/neondeck#123',
          type: 'watch-pr',
          enabled: true,
        }),
      ]),
    );

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
    await expect(listJobs(paths)).resolves.not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'watch:pandemicsyn/neondeck#123' }),
      ]),
    );
  });

  it('returns an existing PR watch as an idempotent no-op with attribution preserved', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await expect(
      addPrWatch(
        { ref: 'neondeck#123', createdBy: 'external:codex' },
        paths,
        async () => prDetail(),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'created',
      watch: {
        id: 'pandemicsyn/neondeck#123',
        createdBy: 'external:codex',
      },
    });

    await expect(
      addPrWatch(
        { ref: 'neondeck#123', createdBy: 'external:claude-code' },
        paths,
        async () => {
          throw new Error('duplicate registrations must not fetch');
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      outcome: 'silent',
      watch: {
        id: 'pandemicsyn/neondeck#123',
        createdBy: 'external:codex',
      },
    });
  });

  it('updates existing PR watch targets and polling intervals without refetching', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await expect(
      addPrWatch(
        { ref: 'neondeck#123' },
        paths,
        async () => prDetail(),
        async () => checkSummary('pending'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'created',
      watch: {
        id: 'pandemicsyn/neondeck#123',
        desiredTerminalState: 'checks',
      },
    });

    await expect(
      addPrWatch(
        {
          ref: 'neondeck#123',
          desiredTerminalState: 'prod',
          intervalSeconds: 120,
        },
        paths,
        async () => {
          throw new Error('existing watch updates must not fetch');
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      watch: {
        id: 'pandemicsyn/neondeck#123',
        desiredTerminalState: 'prod',
        status: 'watching',
        lastOutcome: 'updated',
      },
    });

    await expect(listPrWatches(paths)).resolves.toMatchObject({
      watches: [
        {
          id: 'pandemicsyn/neondeck#123',
          desiredTerminalState: 'prod',
          pollIntervalSeconds: 120,
        },
      ],
    });
    await expect(listJobs(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'watch:pandemicsyn/neondeck#123',
          intervalSeconds: 120,
        }),
        expect.objectContaining({
          id: 'release:neondeck',
          type: 'release-watch',
          config: expect.objectContaining({
            source: 'watch-pr-until-prod',
            sourceWatchId: 'pandemicsyn/neondeck#123',
          }),
        }),
      ]),
    );
  });

  it('marks refresh changed when PR state changes', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addPrWatch({ ref: 'neondeck#123' }, paths, async () =>
      prDetail({ state: 'open', updatedAt: '2026-06-27T20:00:00Z' }),
    );

    await expect(
      refreshPrWatch(
        { id: 'pandemicsyn/neondeck#123' },
        paths,
        async () =>
          prDetail({
            state: 'closed',
            merged: true,
            mergeCommitSha: 'abc123',
            updatedAt: '2026-06-27T20:05:00Z',
          }),
        async () => checkSummary('success'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      watch: {
        status: 'green',
        mergeCommitSha: 'abc123',
        lastSnapshot: {
          checks: { status: 'success' },
        },
      },
    });
  });

  it('marks merged PR watches attention-needed when checks fail', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addPrWatch({ ref: 'neondeck#123' }, paths, async () =>
      prDetail({ state: 'open', updatedAt: '2026-06-27T20:00:00Z' }),
    );

    await expect(
      refreshPrWatch(
        { id: 'pandemicsyn/neondeck#123' },
        paths,
        async () =>
          prDetail({
            state: 'closed',
            merged: true,
            mergeCommitSha: 'abc123',
            updatedAt: '2026-06-27T20:05:00Z',
          }),
        async () => checkSummary('failure'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      watch: {
        status: 'attention-needed',
        mergeCommitSha: 'abc123',
        lastSnapshot: {
          checks: { status: 'failure' },
        },
      },
    });
  });

  it('keeps default checks watches active while merge checks are pending', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addPrWatch({ ref: 'neondeck#123' }, paths, async () =>
      prDetail({ state: 'open', updatedAt: '2026-06-27T20:00:00Z' }),
    );

    await expect(
      refreshPrWatch(
        { id: 'pandemicsyn/neondeck#123' },
        paths,
        async () =>
          prDetail({
            state: 'closed',
            merged: true,
            mergeCommitSha: 'abc123',
            updatedAt: '2026-06-27T20:05:00Z',
          }),
        async () => checkSummary('pending'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      watch: {
        status: 'watching',
        mergeCommitSha: 'abc123',
        lastSnapshot: {
          checks: { status: 'pending' },
        },
      },
    });
  });

  it('marks explicit merged-target watches ready when the PR merges', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addPrWatch({ ref: 'neondeck#123 until merged' }, paths, async () =>
      prDetail({ state: 'open', updatedAt: '2026-06-27T20:00:00Z' }),
    );

    await expect(
      refreshPrWatch(
        { id: 'pandemicsyn/neondeck#123' },
        paths,
        async () =>
          prDetail({
            state: 'closed',
            merged: true,
            mergeCommitSha: 'abc123',
            updatedAt: '2026-06-27T20:05:00Z',
          }),
        async () => checkSummary('pending'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      watch: {
        desiredTerminalState: 'merged',
        status: 'merged',
        mergeCommitSha: 'abc123',
      },
    });
  });

  it('creates a linked release watch job for until prod PR watches', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addPrWatch({ ref: 'neondeck#123 until prod' }, paths, async () =>
      prDetail({ state: 'open', updatedAt: '2026-06-27T20:00:00Z' }),
    );

    await expect(listJobs(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'release:neondeck',
          type: 'release-watch',
          enabled: true,
          config: expect.objectContaining({
            repo: 'neondeck',
            source: 'watch-pr-until-prod',
            sourceWatchId: 'pandemicsyn/neondeck#123',
          }),
        }),
      ]),
    );
  });

  it('pauses and resumes linked release watch jobs for until prod PR watches', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addPrWatch({ ref: 'neondeck#123 until prod' }, paths, async () =>
      prDetail({ state: 'open', updatedAt: '2026-06-27T20:00:00Z' }),
    );

    await setPrWatchPolling(
      { id: 'pandemicsyn/neondeck#123', enabled: false },
      paths,
    );

    await expect(listJobs(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'watch:pandemicsyn/neondeck#123',
          enabled: false,
        }),
        expect.objectContaining({
          id: 'release:neondeck',
          enabled: false,
        }),
      ]),
    );

    await setPrWatchPolling(
      { id: 'pandemicsyn/neondeck#123', enabled: true },
      paths,
    );

    await expect(listJobs(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'watch:pandemicsyn/neondeck#123',
          enabled: true,
        }),
        expect.objectContaining({
          id: 'release:neondeck',
          enabled: true,
        }),
      ]),
    );
  });

  it('removes linked release watch jobs when an until prod PR watch is removed', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addPrWatch({ ref: 'neondeck#123 until prod' }, paths, async () =>
      prDetail({ state: 'open', updatedAt: '2026-06-27T20:00:00Z' }),
    );
    await removePrWatch(
      { id: 'pandemicsyn/neondeck#123', confirm: true },
      paths,
    );

    await expect(listJobs(paths)).resolves.not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'release:neondeck' }),
      ]),
    );
  });
});

describe('ref watch actions', () => {
  it('parses supported ref watch reference forms', () => {
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
      parseWatchRefReference(
        { target: 'pandemicsyn/neondeck@feature/raycast' },
        registry,
      ),
    ).toMatchObject({
      ok: true,
      reference: {
        id: 'pandemicsyn/neondeck@feature/raycast',
        ref: 'feature/raycast',
      },
    });
    expect(
      parseWatchRefReference({ target: 'neondeck@abc123' }, registry),
    ).toMatchObject({
      ok: true,
      reference: {
        repoId: 'neondeck',
        id: 'pandemicsyn/neondeck@abc123',
      },
    });
    expect(
      parseWatchRefReference(
        {
          target:
            'https://github.com/pandemicsyn/neondeck/tree/feature%2Fraycast',
        },
        registry,
      ),
    ).toMatchObject({
      ok: true,
      reference: {
        id: 'pandemicsyn/neondeck@feature/raycast',
        ref: 'feature/raycast',
      },
    });
  });

  it('adds, lists, and silently refreshes ref watches', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await expect(
      addRefWatch(
        { repo: 'neondeck', ref: 'feature/raycast' },
        paths,
        async () => checkSummary('pending'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'created',
      watch: {
        id: 'pandemicsyn/neondeck@feature/raycast',
        status: 'watching',
        ref: 'feature/raycast',
      },
    });

    await expect(listRefWatches(paths)).resolves.toMatchObject({
      ok: true,
      changed: false,
      watches: [{ id: 'pandemicsyn/neondeck@feature/raycast' }],
    });
    await expect(listJobs(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'watch-ref:pandemicsyn/neondeck@feature/raycast',
          type: 'watch-ref',
          enabled: true,
        }),
      ]),
    );

    await expect(
      refreshRefWatch(
        { id: 'pandemicsyn/neondeck@feature/raycast' },
        paths,
        async () => checkSummary('pending'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      outcome: 'silent',
    });
  });

  it('marks ref refresh changed when checks change', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addRefWatch({ target: 'neondeck@feature/raycast' }, paths, async () =>
      checkSummary('pending'),
    );

    await expect(
      refreshRefWatch({ target: 'neondeck@feature/raycast' }, paths, async () =>
        checkSummary('success'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      watch: {
        id: 'pandemicsyn/neondeck@feature/raycast',
        status: 'green',
        lastSnapshot: {
          checks: { status: 'success' },
        },
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

function checkSummary(
  status: GitHubCheckSummary['status'],
): GitHubCheckSummary {
  return {
    status,
    total: 1,
    successful: status === 'success' ? 1 : 0,
    failed: status === 'failure' ? 1 : 0,
    pending: status === 'pending' ? 1 : 0,
    checkedAt: '2026-06-27T20:05:30Z',
  };
}
