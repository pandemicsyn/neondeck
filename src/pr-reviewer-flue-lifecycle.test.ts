import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { init, type ConversationStreamChunk } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { afterEach, expect, it } from 'vitest';
import { prReviewerConversationId } from '../shared/pr-reviewer-session';
import {
  addPrReviewDraftComment,
  upsertPrReviewDraft,
} from './testing/pr-review-draft-fixtures';
import { completePrReview, startPrReview } from './modules/pr-reviews';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('mounts fresh reviewer context before each Flue model turn without instruction churn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-reviewer-flue-'));
  tempRoots.push(home);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  const headSha = 'a'.repeat(40);
  const started = await startPrReview(
    { ref: 'other/project#42', origin: 'api' },
    paths,
    {
      resolveTarget: async () => ({
        repoFullName: 'other/project',
        owner: 'other',
        repo: 'project',
        number: 42,
      }),
      fetchDetail: async () => reviewDetail(headSha),
      invokeWorkflow: async () => ({ runId: 'reviewer-flue-lifecycle' }),
    },
  );
  completePrReview(
    {
      reviewId: started.reviewId,
      runId: started.runId,
      headSha,
      reportIds: [],
      reviewUrl: started.review.reviewUrl,
      findingCount: 0,
      seededCount: 0,
      reportOnlyCount: 0,
      reportOnlyFindings: [],
    },
    paths,
  );
  const draft = upsertPrReviewDraft({
    databasePath: paths.neondeckDatabase,
    repo: 'other/project',
    prNumber: 42,
    headSha,
  });
  addPrReviewDraftComment({
    id: 'first-draft-comment',
    databasePath: paths.neondeckDatabase,
    draftId: draft.id,
    path: 'src/first.ts',
    side: 'RIGHT',
    line: 12,
    body: 'First live draft context.',
  });

  const previousHome = process.env.NEONDECK_HOME;
  const previousModel = process.env.FLUE_PR_REVIEW_MODEL;
  const previousGitHubToken = process.env.GITHUB_TOKEN;
  process.env.NEONDECK_HOME = home;
  process.env.FLUE_PR_REVIEW_MODEL = 'faux/faux-1';
  delete process.env.GITHUB_TOKEN;

  const capturedModelContexts: string[] = [];
  const faux = fauxProvider();
  faux.setResponses([
    (context) => {
      capturedModelContexts.push(JSON.stringify(context));
      return fauxAssistantMessage('First answer.');
    },
    (context) => {
      capturedModelContexts.push(JSON.stringify(context));
      return fauxAssistantMessage('Second answer.');
    },
  ]);

  const { PrReviewer } = await import('./agents/pr-reviewer');
  let flue: Awaited<ReturnType<typeof start>> | undefined;
  try {
    flue = await start({
      agents: [PrReviewer],
      providers: [faux.provider],
    });
    const handle = init(PrReviewer, {
      id: prReviewerConversationId(started.reviewId, headSha),
    });
    const chunks: ConversationStreamChunk[] = [];
    const firstReceipt = await handle.dispatch('What did the review find?');
    await expect(
      handle.read(firstReceipt, { onEvent: (chunk) => chunks.push(chunk) }),
    ).resolves.toMatchObject({ text: 'First answer.' });

    addPrReviewDraftComment({
      id: 'second-draft-comment',
      databasePath: paths.neondeckDatabase,
      draftId: draft.id,
      path: 'src/second.ts',
      side: 'RIGHT',
      line: 24,
      body: 'Second delivery has refreshed context.',
    });
    const secondReceipt = await handle.dispatch('What changed in the drafts?');
    await expect(
      handle.read(secondReceipt, { onEvent: (chunk) => chunks.push(chunk) }),
    ).resolves.toMatchObject({ text: 'Second answer.' });

    expect(capturedModelContexts).toHaveLength(2);
    expect(capturedModelContexts[0]).toContain('First live draft context.');
    expect(capturedModelContexts[0]).not.toContain(
      'Second delivery has refreshed context.',
    );
    expect(capturedModelContexts[1]).toContain(
      'Second delivery has refreshed context.',
    );

    const systemText = chunks
      .filter(
        (
          chunk,
        ): chunk is Extract<
          ConversationStreamChunk,
          { type: 'message-appended' }
        > =>
          chunk.type === 'message-appended' && chunk.message.role === 'system',
      )
      .flatMap((chunk) => chunk.message.parts)
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    expect(systemText).toContain('First live draft context.');
    expect(systemText).toContain('Second delivery has refreshed context.');
    expect(systemText).not.toContain('System instructions updated.');
  } finally {
    await flue?.stop();
    restoreEnv('NEONDECK_HOME', previousHome);
    restoreEnv('FLUE_PR_REVIEW_MODEL', previousModel);
    restoreEnv('GITHUB_TOKEN', previousGitHubToken);
  }
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function reviewDetail(headSha: string) {
  return {
    number: 42,
    title: 'Review this change',
    body: null,
    repo: 'other/project',
    url: 'https://github.com/other/project/pull/42',
    state: 'open' as const,
    draft: false,
    author: 'contributor',
    labels: [],
    comments: 0,
    merged: false,
    mergeCommitSha: null,
    headSha,
    headRef: 'feature',
    headOwner: 'other',
    headName: 'project',
    headRepoFullName: 'other/project',
    baseRef: 'main',
    baseSha: 'base',
    baseRepoFullName: 'other/project',
    mergeable: true,
    mergeableState: 'clean',
    maintainerCanModify: true,
    createdAt: '2026-07-14T20:00:00.000Z',
    updatedAt: '2026-07-14T20:00:00.000Z',
  };
}
