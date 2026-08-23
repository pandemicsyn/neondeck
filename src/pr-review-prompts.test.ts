import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prReviewerConversationId } from '../shared/pr-reviewer-session';
import {
  buildPrReviewAssistantRuntime,
  prReviewAssistantOperationInstructions,
} from './agents/pr-review-assistant';
import { buildPrReviewerRuntime } from './agents/pr-reviewer';
import { updatePrReviewPrompt } from './modules/config';
import {
  addPrReviewDraftComment,
  prReviewBriefingFixture,
  upsertPrReviewDraft,
} from './testing/pr-review-draft-fixtures';
import { completePrReview, startPrReview } from './modules/pr-reviews';
import {
  defaultPrReviewPromptTemplates,
  ensureRuntimeHome,
  renderPrReviewPrompt,
  runtimePaths,
} from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('PR review prompts', () => {
  it('uses the configured full prompt for new initial review sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-review-prompts-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);

    expect(buildPrReviewAssistantRuntime(paths).instructions).toBe(
      defaultPrReviewPromptTemplates['initial-review'],
    );
    expect(defaultPrReviewPromptTemplates['initial-review']).toContain(
      'You may delegate focused, independent investigation questions to the explore subagent.',
    );
    expect(defaultPrReviewPromptTemplates['initial-review']).toContain(
      'Choose one, two, or three based on the number of genuinely independent domains; do not prefer a particular count.',
    );
    expect(defaultPrReviewPromptTemplates['initial-review']).toContain(
      'Question:, Revision:, Scope:, Exclusions:, Known facts:, Expected evidence:, and Thoroughness:',
    );
    expect(defaultPrReviewPromptTemplates['initial-review']).toContain(
      'Treat the durable shared 500-call workspace budget as a safety ceiling, not a target.',
    );
    expect(defaultPrReviewPromptTemplates['initial-review']).toContain(
      'An empty findings array is not, on its own, grounds for approve.',
    );
    expect(defaultPrReviewPromptTemplates['initial-review']).toContain(
      'Set overview.recommendation to approve only when the pull request can merge without a human reading the diff.',
    );
    expect(defaultPrReviewPromptTemplates['initial-review']).toContain(
      'for approve, answer "why is this safe to merge without a human reading the diff?"',
    );
    expect(defaultPrReviewPromptTemplates['initial-review']).toContain(
      'for needs-human, answer "what makes this change hard, dangerous, complex, or load-bearing?"',
    );
    expect(defaultPrReviewPromptTemplates['initial-review']).not.toContain(
      'first slide',
    );
    for (const prompt of Object.values(defaultPrReviewPromptTemplates)) {
      expect(prompt).toContain(
        'To avoid redundant work, do not explore the same problem that Explore has already covered. Typically trust Explore’s results without additional verification. Verify only the smallest evidence\nneeded for a mutation, external effect, security conclusion, or final review\nfinding. You may still inspect the code yourself to gain context needed to synthesize the review, but do not repeat the delegated investigation.',
      );
      expect(prompt).toContain(
        'Answer:\nEvidence:\n- path:line — symbol — observed fact\nUnresolved:\nInspected:\nStop reason: answered | insufficient evidence | blocked',
      );
    }
    expect(defaultPrReviewPromptTemplates['initial-review']).toContain(
      'If Explore did not already establish the exact RIGHT-side changed line, verify only that smallest anchor',
    );
    expect(defaultPrReviewPromptTemplates['follow-up-reviewer']).toContain(
      'Before another investigation wave, decide whether the question is already answerable from verified evidence.',
    );
    expect(prReviewAssistantOperationInstructions).toContain(
      'Typically trust Explore without replaying its investigation; verify only the smallest evidence needed',
    );
    expect(prReviewAssistantOperationInstructions).not.toContain(
      'verify its evidence',
    );

    await updatePrReviewPrompt(
      { kind: 'initial-review', prompt: 'Custom complete review prompt.' },
      paths,
    );

    const runtime = buildPrReviewAssistantRuntime(paths);
    expect(runtime.instructions).toBe('Custom complete review prompt.');
    expect(runtime.skills).toEqual([]);
    expect(runtime.tools).toEqual([]);
    expect(runtime).not.toHaveProperty('sandbox');
  });

  it('suppresses generic sandbox tools for continuing reviewer sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-review-prompts-'));
    tempRoots.push(home);
    const runtime = await buildPrReviewerRuntime(
      'missing-review-record',
      runtimePaths(home),
    );
    const environment = await runtime.sandbox.createSandbox({
      id: 'follow-up-review',
    });

    expect(runtime.sandbox.tools?.(environment, { subagents: {} })).toEqual([]);
  });

  it('keeps reviewer policy stable while refreshing live GitHub review threads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-review-prompts-'));
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
        invokeWorkflow: async () => ({ runId: 'review-live-threads' }),
      },
    );
    completePrReview(
      {
        reviewId: started.reviewId,
        runId: started.runId,
        headSha,
        reportIds: [],
        reviewUrl: started.review.reviewUrl,
        briefingOverview: prReviewBriefingFixture(),
        findingCount: 1,
        seededCount: 1,
        reportOnlyCount: 0,
        reportOnlyFindings: [],
      },
      paths,
    );
    const id = prReviewerConversationId(started.reviewId, headSha);
    let firstReadOptions:
      { signal?: AbortSignal; surface?: boolean; fresh?: boolean } | undefined;
    const first = await buildPrReviewerRuntime(id, paths, {
      getReviewThreads: async (_input, _paths, _dependencies, options) => {
        firstReadOptions = options;
        return reviewThreadsResult('iscekic');
      },
    });
    const second = await buildPrReviewerRuntime(id, paths, {
      getReviewThreads: async () => reviewThreadsResult('second-reviewer'),
    });
    const movedHead = await buildPrReviewerRuntime(id, paths, {
      getReviewThreads: async () =>
        reviewThreadsResult('future-reviewer', 'b'.repeat(40)),
    });
    const newerDraft = upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'other/project',
      prNumber: 42,
      headSha: 'b'.repeat(40),
      reanchorHeadSha: true,
    });
    addPrReviewDraftComment({
      id: 'newer-head-draft-comment',
      databasePath: paths.neondeckDatabase,
      draftId: newerDraft.id,
      path: 'src/newer-head.ts',
      side: 'RIGHT',
      line: 27,
      body: 'This draft belongs to the newer head.',
    });
    const mismatchedDraft = await buildPrReviewerRuntime(id, paths, {
      getReviewThreads: async () => reviewThreadsResult('iscekic'),
    });

    expect(firstReadOptions).toMatchObject({ surface: true, fresh: true });
    expect(first.instructions).toBe(second.instructions);
    expect(first.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'neondeck_pr_review_restart',
        'neondeck_pr_review_draft_comment_create',
        'neondeck_pr_review_draft_comment_update',
        'neondeck_pr_review_draft_comment_delete',
      ]),
    );
    expect(first.instructions).toContain('use the matching mounted draft tool');
    expect(first.instructions).toContain(
      'explicitly asks to re-review the pull request',
    );
    expect(first.instructions).toContain(
      'Flue framework narration signals with reserved types',
    );
    expect(first.instructions).not.toContain('iscekic');
    expect(first.context).toContain('iscekic');
    expect(first.context).toContain('Is the local draft redundant?');
    expect(second.context).toContain('second-reviewer');
    expect(second.context).not.toContain('iscekic');
    expect(JSON.parse(movedHead.context)).toMatchObject({
      liveGitHubReviewThreads: {
        headSha: 'b'.repeat(40),
        revisionMatch: false,
        repositoryCorrelation: 'different-pr-head',
        anchorsIncluded: false,
        threads: [
          {
            path: null,
            line: null,
            comments: [{ path: null, line: null }],
          },
        ],
      },
    });
    expect(JSON.parse(first.context)).toMatchObject({
      available: true,
      liveGitHubReviewThreads: {
        available: true,
        truncated: false,
        totalFetched: 1,
        included: 1,
        headSha,
        revisionMatch: true,
        repositoryCorrelation: 'exact-reviewed-revision',
        anchorsIncluded: true,
        threads: [
          {
            id: 'thread-1',
            comments: [
              {
                authorLogin: 'iscekic',
                body: 'Is the local draft redundant?',
              },
            ],
          },
        ],
      },
    });
    expect(JSON.parse(mismatchedDraft.context)).toMatchObject({
      localDraftRevision: {
        available: true,
        headSha: 'b'.repeat(40),
        revisionMatch: false,
        repositoryCorrelation: 'different-pr-head',
        anchorsIncluded: false,
      },
      localDraftComments: [
        {
          id: 'newer-head-draft-comment',
          path: null,
          line: null,
          startLine: null,
          body: 'This draft belongs to the newer head.',
        },
      ],
    });
  });

  it('renders stable follow-up workspace and context-delivery guidance tokens', () => {
    expect(
      renderPrReviewPrompt(
        'A {{workspaceToolGuidance}} B {{reviewContextDeliveryGuidance}}',
        {
          workspaceToolGuidance: 'workspace-ready',
          reviewContextDeliveryGuidance: 'context-arrives-by-signal',
        },
      ),
    ).toBe('A workspace-ready B context-arrives-by-signal');
  });
});

function reviewThreadsResult(authorLogin: string, headSha = 'a'.repeat(40)) {
  return {
    ok: true,
    action: 'github_pr_review_threads_get',
    changed: false,
    message: 'Fetched review threads.',
    data: {
      headSha,
      reviewThreadsTruncated: false,
      reviewThreads: [
        {
          id: 'thread-1',
          isResolved: true,
          isOutdated: false,
          path: 'src/example.ts',
          line: 12,
          originalLine: 12,
          diffSide: 'RIGHT',
          comments: [
            {
              id: 'comment-1',
              databaseId: 1,
              authorLogin,
              body: 'Is the local draft redundant?',
              url: 'https://github.com/other/project/pull/42#discussion_r1',
              path: 'src/example.ts',
              line: 12,
              originalLine: 12,
              diffHunk: '@@ -1 +1 @@',
              reviewId: 1,
              createdAt: '2026-08-03T15:00:00.000Z',
              updatedAt: '2026-08-03T15:01:00.000Z',
            },
          ],
        },
      ],
    },
  };
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
