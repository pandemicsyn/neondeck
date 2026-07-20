import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configurePrAutopilot, controlPrAutopilot } from './modules/autopilot';
import {
  bindWatchAutopilotOwner,
  claimWatchAutopilotTurn,
  readWatch,
  transitionWatchAutopilot,
} from './modules/watches';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { emptyPrWatchInitialEventBaseline } from './testing/pr-watch-event-baseline';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('minimal Autopilot watch loop', () => {
  it('configures one watch and retains its stable owner/worktree binding across reloads', async () => {
    const paths = await fixturePaths();
    const result = await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'autofix-with-approval',
        processExisting: false,
      },
      paths,
      fixtureDependencies(),
    );

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      watch: {
        id: 'pandemicsyn/neondeck#123',
        autopilotMode: 'autofix-with-approval',
        autopilotStatus: 'watching',
        ownerInstanceId: null,
        worktreeId: null,
      },
    });

    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: 'pr-owner-stable',
      worktreeId: 'worktree-stable',
    });
    await ensureRuntimeHome(paths);
    await ensureRuntimeHome(paths);

    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      ownerInstanceId: 'pr-owner-stable',
      worktreeId: 'worktree-stable',
    });
    expect(() =>
      bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
        ownerInstanceId: 'pr-owner-replacement',
        worktreeId: 'worktree-stable',
      }),
    ).toThrow(/already bound/);
  });

  it('claims only one turn per fingerprint and exposes an explicit blocked retry', async () => {
    const paths = await fixturePaths();
    await configurePrAutopilot(
      {
        ref: 'neondeck#123',
        mode: 'prepare-only',
        processExisting: false,
      },
      paths,
      fixtureDependencies(),
    );

    expect(
      claimWatchAutopilotTurn(paths, 'pandemicsyn/neondeck#123', 'event-1'),
    ).toMatchObject({ autopilotStatus: 'working' });
    expect(
      claimWatchAutopilotTurn(paths, 'pandemicsyn/neondeck#123', 'event-1'),
    ).toBeUndefined();

    transitionWatchAutopilot(paths, 'pandemicsyn/neondeck#123', {
      from: 'working',
      to: 'blocked',
    });
    await expect(
      controlPrAutopilot(
        { id: 'pandemicsyn/neondeck#123', operation: 'retry' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      watch: { autopilotStatus: 'watching' },
    });
  });
});

async function fixturePaths() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-autopilot-loop-'));
  tempRoots.push(home);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  await writeFile(
    paths.repos,
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
  return paths;
}

function fixtureDependencies() {
  return {
    async fetcher() {
      return {
        number: 123,
        title: 'Minimal Autopilot loop',
        repo: 'pandemicsyn/neondeck',
        url: 'https://github.com/pandemicsyn/neondeck/pull/123',
        state: 'open',
        merged: false,
        mergeCommitSha: null,
        headSha: 'a'.repeat(40),
        baseRef: 'main',
        updatedAt: '2026-07-20T00:00:00.000Z',
      };
    },
    async checkFetcher() {
      return {
        status: 'none' as const,
        total: 0,
        successful: 0,
        failed: 0,
        pending: 0,
        checkedAt: '2026-07-20T00:00:00.000Z',
      };
    },
    initialEventBaselineFetcher: emptyPrWatchInitialEventBaseline,
  };
}
