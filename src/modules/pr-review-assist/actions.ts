import { defineAction } from '@flue/runtime';
import { currentFlueExecutionContext } from '../flue';
import { completePrReview, failPrReview } from '../pr-reviews';
import {
  prReviewAssistInputSchema,
  prReviewAssistOutputSchema,
  reviewAssistStructuredOutputSchema,
} from './schemas';
import {
  reviewPrForHuman,
  type ReviewAssistFacts,
  type ReviewAssistPromptContext,
} from './service';

export const reviewPrForHumanAction = defineAction({
  name: 'neondeck_pr_review_for_human',
  description:
    'Prepare local PR review reports and Neon-origin draft comments for human review without submitting anything to GitHub.',
  input: prReviewAssistInputSchema,
  output: prReviewAssistOutputSchema,
  async run({ harness, input, log }) {
    const runId = currentFlueExecutionContext()?.runId;
    let result: Awaited<ReturnType<typeof reviewPrForHuman>>;
    try {
      result = await reviewPrForHuman(input, undefined, {
        workflowRunId: runId,
        reviewer: async (facts, context) => {
          const session = await harness.session();
          const response = await session.skill('neon-pr-review', {
            args: {
              task: 'Review the pull request facts and return only the requested structured review output.',
              facts: reviewFactsForPrompt(facts, context),
            },
            result: reviewAssistStructuredOutputSchema,
            signal: AbortSignal.timeout(180_000),
          });
          return response.data;
        },
      });
    } catch (error) {
      if (input.reviewId) {
        failPrReview({
          reviewId: input.reviewId,
          attemptId: input.attemptId,
          runId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
    if (input.reviewId) {
      if (result.ok && 'data' in result) {
        completePrReview({
          reviewId: input.reviewId,
          attemptId: input.attemptId,
          runId,
          headSha: result.data.headSha,
          reportIds: result.data.reports.map((report) => report.id),
          reviewUrl: result.data.reviewUrl,
          findingCount: result.data.findingCount,
          seededCount: result.data.seededCount,
          reportOnlyCount: result.data.reportOnlyCount,
          reportOnlyFindings: result.data.reportOnlyFindings,
        });
      } else {
        failPrReview({
          reviewId: input.reviewId,
          attemptId: input.attemptId,
          runId,
          message: result.message,
        });
      }
    }
    if (result.ok) {
      log.info('Prepared PR review assist artifacts', {
        message: result.message,
      });
    } else {
      log.warn('PR review assist failed', {
        message: result.message,
        requires: 'requires' in result ? result.requires : undefined,
      });
    }
    return result;
  },
});

export function reviewFactsForPrompt(
  facts: ReviewAssistFacts,
  context?: ReviewFactsPromptContext,
) {
  const backgroundContext = reviewBackgroundContext(context);
  return {
    target: {
      repoFullName: facts.target.repoFullName,
      number: facts.target.number,
    },
    ...(backgroundContext ? { backgroundContext } : {}),
    memories: (context?.learningMemoryContext?.memories ?? []).map(
      (memory) => ({
        id: memory.id,
        scope: memory.scope,
        key: memory.key,
        repoId: memory.repoId,
        value: memory.value,
      }),
    ),
    pullRequest: {
      title: facts.state.title,
      body: truncate(facts.state.body ?? '', 20_000),
      state: facts.state.state,
      url: facts.state.url,
      baseRef: facts.state.baseRef,
      baseSha: facts.state.baseSha,
      headRef: facts.state.headRef,
      headSha: facts.state.headSha,
      draft: facts.state.draft,
      merged: facts.state.merged,
      mergeCommitSha: facts.state.mergeCommitSha,
      mergeable: facts.state.mergeable,
      mergeableState: facts.state.mergeableState,
      maintainerCanModify: facts.state.maintainerCanModify,
      isOutOfDate: facts.state.isOutOfDate,
    },
    linkedIssueReferenceHints: issueReferenceHints(
      `${facts.state.title}\n${facts.state.body ?? ''}`,
    ),
    diffSummary: facts.diffSummary,
    checks: {
      suites: facts.state.checkSuites.map((suite) => ({
        id: suite.id,
        status: suite.status,
        conclusion: suite.conclusion,
        appSlug: suite.appSlug,
        htmlUrl: suite.htmlUrl,
      })),
      runs: facts.state.checkRuns.map((check) => ({
        id: check.id,
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        htmlUrl: check.htmlUrl,
      })),
    },
    commits: facts.state.commits.map((commit) => ({
      sha: commit.sha,
      url: commit.url,
      authorLogin: commit.authorLogin,
      committedAt: commit.committedAt,
    })),
    reviewThreads: facts.state.reviewThreads.map((thread) => ({
      id: thread.id,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      path: thread.path,
      line: thread.line,
      originalLine: thread.originalLine ?? null,
      diffSide: thread.diffSide ?? null,
      comments: thread.comments.map((comment) => ({
        id: comment.id,
        authorLogin: comment.authorLogin,
        body: truncate(comment.body, 4_000),
        path: comment.path,
        line: comment.line,
        originalLine: comment.originalLine,
        diffHunk: truncate(comment.diffHunk ?? '', 4_000),
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      })),
    })),
    requestedChangesState: {
      active: facts.state.requestedChangesState.active,
      latestByReviewer: facts.state.requestedChangesState.latestByReviewer,
      history: facts.state.requestedChangesState.history,
    },
    requestedChangesReviews: facts.state.requestedChangesReviews,
    branchPermissions: facts.state.branchPermissions,
    files: facts.files.map((file) => ({
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      binary: file.binary,
      generatedLike: file.generatedLike,
      truncated: file.truncated,
      patch: truncate(file.patch ?? '', 12_000),
      message: file.message,
    })),
    limitations: [
      'Linked issue relationships are not currently typed separately in GitHubPullRequestEventState; linkedIssueReferenceHints are extracted from PR title/body text only.',
    ],
  };
}

type ReviewFactsPromptContext = Partial<
  Pick<ReviewAssistPromptContext, 'learningMemoryContext'>
> & {
  memoryContext?: {
    text: string;
    memoryIds: string[];
  };
};

function reviewBackgroundContext(context?: ReviewFactsPromptContext) {
  if (!context?.memoryContext && !context?.learningMemoryContext) return null;
  return {
    ...(context.memoryContext
      ? {
          structuredMemory: context.memoryContext.text,
          memoryIds: context.memoryContext.memoryIds,
        }
      : {}),
    ...(context.learningMemoryContext
      ? {
          learningMemories: context.learningMemoryContext.text,
          learningMemoryIds: context.learningMemoryContext.memoryIds,
        }
      : {}),
    usage:
      'Treat memory as durable background guidance, not current PR evidence. Fetched PR facts and workflow bounds win on conflict.',
  };
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n[truncated]`;
}

function issueReferenceHints(value: string) {
  const matches = new Set<string>();
  const pattern =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+((?:[\w.-]+\/[\w.-]+)?#\d+)/gi;
  for (const match of value.matchAll(pattern)) {
    if (typeof match[1] === 'string') matches.add(match[1]);
  }
  return [...matches].slice(0, 20);
}
