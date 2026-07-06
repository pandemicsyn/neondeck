import { defineAction } from '@flue/runtime';
import {
  prReviewAssistInputSchema,
  prReviewAssistOutputSchema,
  reviewAssistStructuredOutputSchema,
} from './schemas';
import { reviewPrForHuman, type ReviewAssistFacts } from './service';

export const reviewPrForHumanAction = defineAction({
  name: 'neondeck_pr_review_for_human',
  description:
    'Prepare local PR review reports and Neon-origin draft comments for human review without submitting anything to GitHub.',
  input: prReviewAssistInputSchema,
  output: prReviewAssistOutputSchema,
  async run({ harness, input, log }) {
    const result = await reviewPrForHuman(input, undefined, {
      reviewer: async (facts) => {
        const session = await harness.session();
        const response = await session.skill('neon-pr-review', {
          args: {
            task: 'Review the pull request facts and return only the requested structured review output.',
            facts: reviewFactsForPrompt(facts),
          },
          result: reviewAssistStructuredOutputSchema,
          signal: AbortSignal.timeout(180_000),
        });
        return response.data;
      },
    });
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

function reviewFactsForPrompt(facts: ReviewAssistFacts) {
  return {
    target: {
      repoFullName: facts.target.repoFullName,
      number: facts.target.number,
    },
    pullRequest: {
      title: facts.state.title,
      state: facts.state.state,
      url: facts.state.url,
      baseRef: facts.state.baseRef,
      headRef: facts.state.headRef,
      headSha: facts.state.headSha,
      mergeableState: facts.state.mergeableState,
      isOutOfDate: facts.state.isOutOfDate,
    },
    diffSummary: facts.diffSummary,
    checks: facts.state.checkRuns.map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      htmlUrl: check.htmlUrl,
    })),
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
  };
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n[truncated]`;
}
