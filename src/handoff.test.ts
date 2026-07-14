import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listNotifications, listWorkflowSummaries } from './modules/app-state';
import {
  createHandoffNote,
  normalizeHandoffSource,
  registerHandoffPr,
  registerHandoffWatchPr,
  type HandoffDependencies,
} from './modules/handoff';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import type {
  addPrWatch as addPrWatchFunction,
  WatchActionResult,
} from './modules/watches';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('agent handoff service', () => {
  it('normalizes external source attribution', () => {
    expect(normalizeHandoffSource(undefined)).toBe('external:cli');
    expect(normalizeHandoffSource('codex')).toBe('external:codex');
    expect(normalizeHandoffSource('ci:github-actions')).toBe(
      'ci:github-actions',
    );
  });

  it('creates bounded attributed notes and caps urgent to attention', async () => {
    const paths = await tempPaths();
    await writeRepoRegistry(paths.repos);

    await expect(
      createHandoffNote(
        {
          text: 'Refactor finished.',
          source: 'codex',
          pr: 'neondeck#123',
          level: 'urgent',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      action: 'handoff_note_create',
      changed: true,
      id: expect.any(String),
      deckUrl: '/',
      notification: {
        level: 'attention',
        source: 'external:codex',
        data: {
          repoId: 'neondeck',
          repoFullName: 'pandemicsyn/neondeck',
          prNumber: 123,
        },
      },
    });

    await expect(listNotifications(paths)).resolves.toEqual([
      expect.objectContaining({
        level: 'attention',
        source: 'external:codex',
        message: 'Refactor finished.',
      }),
    ]);
  });

  it('rejects PR note links for unconfigured repositories', async () => {
    const paths = await tempPaths();
    await writeRepoRegistry(paths.repos);

    await expect(
      createHandoffNote(
        {
          text: 'Wrong repo.',
          source: 'codex',
          pr: 'somebody/else#1',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      action: 'handoff_pr_reference',
      requires: ['repo'],
    });
  });

  it('registers a PR with watch attribution, note, review admission, and audit', async () => {
    const paths = await tempPaths();
    await writeRepoRegistry(paths.repos);
    const addPrWatch = vi.fn<NonNullable<HandoffDependencies['addPrWatch']>>(
      async (
        input: Parameters<typeof addPrWatchFunction>[0],
      ): Promise<WatchActionResult> => {
        expect(input).toMatchObject({
          ref: 'pandemicsyn/neondeck#123',
          desiredTerminalState: 'checks',
          createdBy: 'external:codex',
        });
        return fakePrWatchResult({
          ref: 'pandemicsyn/neondeck#123',
          createdBy: 'external:codex',
        });
      },
    );
    const invokeReviewPrWorkflow = vi.fn<
      NonNullable<HandoffDependencies['invokeReviewPrWorkflow']>
    >(async () => ({ runId: 'run-123' }));

    await expect(
      registerHandoffPr(
        {
          ref: 'neondeck#123',
          source: 'codex',
          note: 'Adds retry logic.',
          review: true,
        },
        paths,
        { addPrWatch, invokeReviewPrWorkflow },
      ),
    ).resolves.toMatchObject({
      ok: true,
      action: 'handoff_pr_register',
      changed: true,
      id: 'pandemicsyn/neondeck#123',
      review: {
        workflow: 'review-pr-for-human',
        runId: 'run-123',
      },
      audit: {
        workflow: 'agent_handoff',
        status: 'completed',
      },
    });
    expect(invokeReviewPrWorkflow).toHaveBeenCalledWith({
      ref: 'pandemicsyn/neondeck#123',
    });
    await expect(listWorkflowSummaries(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflow: 'agent_handoff',
          runId: 'run-123',
        }),
        expect.objectContaining({ workflow: 'agent_handoff' }),
      ]),
    );
  });

  it('does not create a PR watch when register note validation fails', async () => {
    const paths = await tempPaths();
    await writeRepoRegistry(paths.repos);
    const addPrWatch = vi.fn<NonNullable<HandoffDependencies['addPrWatch']>>();

    await expect(
      registerHandoffPr(
        {
          ref: 'somebody/else#1',
          source: 'codex',
          note: 'This should not mutate watch state.',
        },
        paths,
        { addPrWatch },
      ),
    ).resolves.toMatchObject({
      ok: false,
      action: 'handoff_pr_reference',
      requires: ['repo'],
    });
    expect(addPrWatch).not.toHaveBeenCalled();
  });

  it('audits failed review workflow dispatch after bounded side effects', async () => {
    const paths = await tempPaths();
    await writeRepoRegistry(paths.repos);
    const addPrWatch = vi.fn<NonNullable<HandoffDependencies['addPrWatch']>>(
      async () =>
        fakePrWatchResult({
          ref: 'pandemicsyn/neondeck#123',
          createdBy: 'external:codex',
        }),
    );
    const invokeReviewPrWorkflow = vi.fn<
      NonNullable<HandoffDependencies['invokeReviewPrWorkflow']>
    >(async () => {
      throw new Error('workflow runtime unavailable');
    });

    await expect(
      registerHandoffPr(
        {
          ref: 'neondeck#123',
          source: 'codex',
          note: 'Ready for review.',
          review: true,
        },
        paths,
        { addPrWatch, invokeReviewPrWorkflow },
      ),
    ).resolves.toMatchObject({
      ok: false,
      action: 'handoff_pr_register',
      changed: true,
      watch: { id: 'pandemicsyn/neondeck#123' },
      notification: { source: 'external:codex' },
      audit: {
        workflow: 'agent_handoff',
        status: 'failed',
        summary: {
          event: 'register-pr',
          ref: 'pandemicsyn/neondeck#123',
          error: 'workflow runtime unavailable',
        },
      },
      errors: ['workflow runtime unavailable'],
      requires: ['workflowDispatch'],
    });
  });

  it('registers audited PR watches through the handoff surface', async () => {
    const paths = await tempPaths();
    await writeRepoRegistry(paths.repos);
    const addPrWatch = vi.fn<NonNullable<HandoffDependencies['addPrWatch']>>(
      async (
        input: Parameters<typeof addPrWatchFunction>[0],
      ): Promise<WatchActionResult> => {
        expect(input).toMatchObject({
          ref: 'pandemicsyn/neondeck#123',
          desiredTerminalState: 'merged',
          intervalSeconds: 120,
          createdBy: 'external:codex',
        });
        return fakePrWatchResult({
          ref: 'pandemicsyn/neondeck#123',
          desiredTerminalState: 'merged',
          createdBy: 'external:codex',
        });
      },
    );

    await expect(
      registerHandoffWatchPr(
        {
          ref: 'neondeck#123',
          source: 'codex',
          desiredTerminalState: 'merged',
          intervalSeconds: 120,
        },
        paths,
        { addPrWatch },
      ),
    ).resolves.toMatchObject({
      ok: true,
      action: 'handoff_pr_watch',
      audit: {
        workflow: 'agent_handoff',
        summary: {
          event: 'watch-pr',
          source: 'external:codex',
          ref: 'pandemicsyn/neondeck#123',
          desiredTerminalState: 'merged',
        },
      },
    });
  });

  it('blocks external PR review queueing when config disables it', async () => {
    const paths = await tempPaths();
    await writeFile(
      paths.config,
      `${JSON.stringify({
        version: 1,
        localApi: { token: 'a'.repeat(32) },
        handoff: { allowExternalReviewQueue: false },
      })}\n`,
    );
    const invokeReviewPrWorkflow =
      vi.fn<NonNullable<HandoffDependencies['invokeReviewPrWorkflow']>>();

    await expect(
      registerHandoffPr(
        {
          ref: 'neondeck#123',
          source: 'codex',
          review: true,
          watch: false,
        },
        paths,
        { invokeReviewPrWorkflow },
      ),
    ).resolves.toMatchObject({
      ok: false,
      action: 'handoff_pr_register',
      requires: ['handoff.allowExternalReviewQueue'],
    });
    expect(invokeReviewPrWorkflow).not.toHaveBeenCalled();
  });
});

async function tempPaths() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-handoff-'));
  tempRoots.push(home);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  return paths;
}

function fakePrWatchResult(input: {
  ref: 'pandemicsyn/neondeck#123' | 'pandemicsyn/other#123';
  desiredTerminalState?: 'checks' | 'merged';
  createdBy: string;
}): WatchActionResult {
  const [repoFullName, prNumber] = input.ref.split('#') as [string, string];
  const [githubOwner, githubName] = repoFullName.split('/') as [string, string];
  const repoId = githubName;
  return {
    ok: true,
    action: 'watch_pr_add',
    changed: true,
    outcome: 'created',
    message: `Watching ${input.ref}.`,
    watch: {
      id: input.ref,
      repoId,
      repoFullName,
      githubOwner,
      githubName,
      prNumber: Number(prNumber),
      desiredTerminalState: input.desiredTerminalState ?? 'checks',
      status: 'watching',
      prState: 'open',
      title: 'Test',
      url: null,
      mergeCommitSha: null,
      lastSnapshot: null,
      lastOutcome: 'created',
      lastCheckedAt: null,
      createdBy: input.createdBy,
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
    },
  };
}

async function writeRepoRegistry(
  path: string,
  options: { includeOtherRepo?: boolean } = {},
) {
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
        ...(options.includeOtherRepo
          ? [
              {
                id: 'other',
                github: { owner: 'pandemicsyn', name: 'other' },
                path: '/src/other',
                defaultBranch: 'main',
              },
            ]
          : []),
      ],
    })}\n`,
  );
}
