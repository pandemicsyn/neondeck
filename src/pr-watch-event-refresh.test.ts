import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitHubPullRequestEventState } from './modules/github';
import {
  listPrWatchEventWatermarks,
  refreshPrWatchEventState,
} from './modules/pr-events';
import { refreshWatchJobEvents } from './modules/scheduler/pr-watch-events';
import { addPrWatch, listPrWatchRecords } from './modules/watches';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('deterministic PR watch event refresh', () => {
  it('notifies current feedback once on a process-existing first poll without admitting work', async () => {
    const paths = await fixture();
    await writeFile(
      paths.repos,
      `${JSON.stringify(
        {
          repos: [
            {
              id: 'neondeck',
              github: { owner: 'pandemicsyn', name: 'neondeck' },
              path: '/tmp/neondeck',
              defaultBranch: 'main',
              metadata: { autopilot: { mode: 'prepare-only' } },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );

    const state = eventState();
    const dependencies = {
      refreshPrWatchEventState: (
        input: Parameters<typeof refreshPrWatchEventState>[0],
        targetPaths: RuntimePaths,
      ) =>
        refreshPrWatchEventState(input, targetPaths, {
          token: 'test-token',
          fetchPullRequestEventState: async () => state,
        }),
    };
    const target = [{ watch: { id: 'pandemicsyn/neondeck#164' } }] as never;

    const first = await refreshWatchJobEvents(
      target,
      paths,
      dependencies,
      null,
    );
    expect(first).toEqual([
      expect.objectContaining({
        ok: true,
        changed: true,
        changedCategories: expect.arrayContaining([
          'requested_changes_reviews',
        ]),
        notifications: [
          expect.objectContaining({
            title: 'PR watch requested changes',
            data: expect.objectContaining({ mode: 'prepare-only' }),
          }),
        ],
      }),
    ]);
    expect(first[0]).not.toHaveProperty('triage');
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      processExisting: true,
      initialEventProcessedAt: expect.any(String),
    });

    const watermarks = await listPrWatchEventWatermarks(
      { watchId: 'pandemicsyn/neondeck#164' },
      paths,
    );
    expect(watermarks).toMatchObject({
      ok: true,
      data: {
        watermarks: expect.arrayContaining([
          expect.objectContaining({
            category: 'requested_changes_reviews',
            watermark: expect.objectContaining({
              reviews: [
                expect.objectContaining({
                  id: 9001,
                  body: 'Please cover the restart path.',
                  fingerprint: expect.any(String),
                }),
              ],
            }),
          }),
        ]),
      },
    });

    const second = await refreshWatchJobEvents(
      target,
      paths,
      dependencies,
      null,
    );
    expect(second).toEqual([
      expect.objectContaining({ ok: true, changed: false }),
    ]);
  });
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-pr-watch-events-'));
  tempRoots.push(home);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  return paths;
}

function prDetail() {
  return {
    number: 164,
    title: 'Simplify Autopilot',
    body: null,
    repo: 'pandemicsyn/neondeck',
    url: 'https://github.com/pandemicsyn/neondeck/pull/164',
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    headSha: 'a'.repeat(40),
    headRef: 'feature',
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    mergeable: true,
    mergeableState: 'clean',
    maintainerCanModify: true,
    updatedAt: '2026-07-19T00:00:00.000Z',
  };
}

function eventState(): GitHubPullRequestEventState {
  const review = {
    id: 9001,
    nodeId: 'review-9001',
    state: 'CHANGES_REQUESTED',
    authorLogin: 'reviewer',
    authorType: 'User',
    authorIsBot: false,
    submittedAt: '2026-07-19T00:04:00.000Z',
    commitId: 'a'.repeat(40),
    url: 'https://github.com/pandemicsyn/neondeck/pull/164#pullrequestreview-9001',
    body: 'Please cover the restart path.',
    bodyTruncated: false,
  };
  return {
    repo: 'pandemicsyn/neondeck',
    number: 164,
    url: 'https://github.com/pandemicsyn/neondeck/pull/164',
    title: 'Simplify Autopilot',
    body: null,
    state: 'open',
    draft: false,
    merged: false,
    mergeCommitSha: null,
    headSha: 'a'.repeat(40),
    headRef: 'feature',
    headRepoFullName: 'pandemicsyn/neondeck',
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    baseRepoFullName: 'pandemicsyn/neondeck',
    mergeable: true,
    mergeableState: 'clean',
    maintainerCanModify: true,
    commits: [],
    reviewThreads: [],
    requestedChangesReviews: [review],
    requestedChangesState: {
      active: [review],
      latestByReviewer: [review],
      history: [review],
    },
    conversationComments: [],
    checkSuites: [],
    checkRuns: [],
    branchPermissions: {
      headRepoFullName: 'pandemicsyn/neondeck',
      baseRepoFullName: 'pandemicsyn/neondeck',
      isFork: false,
      maintainerCanModify: true,
      headRepoPush: true,
      baseRepoPush: true,
      canLikelyPush: true,
      checkedAt: '2026-07-19T00:09:00.000Z',
    },
    isOutOfDate: false,
    fetchedAt: '2026-07-19T00:10:00.000Z',
  };
}

