import { defineAgent } from '@flue/runtime';
import { parsePrReviewerConversationId } from '../../shared/pr-reviewer-session';
import { readLivePrReviewDraft } from '../modules/github';
import { readPrReview } from '../modules/pr-reviews';
import { resolvePrReviewerWorkspace } from '../modules/pr-reviewer';
import { readAgentModelSelectionSync } from '../modules/runtime';
import {
  effectivePrReviewPromptTemplates,
  ensureRuntimeHomeSync,
  parseAppConfig,
  readRuntimeJsonSync,
  renderPrReviewPrompt,
  runtimePaths,
  type RuntimePaths,
} from '../runtime-home';

export const description =
  'Continuing read-only reviewer conversation for one durable Neondeck PR review.';

export async function buildPrReviewerRuntime(
  id: string,
  paths: RuntimePaths = runtimePaths(),
) {
  ensureRuntimeHomeSync(paths);
  const models = readAgentModelSelectionSync(paths);
  const config = readRuntimeJsonSync(paths.config, parseAppConfig);
  const promptTemplate =
    effectivePrReviewPromptTemplates(config)['follow-up-reviewer'];
  const conversation = parsePrReviewerConversationId(id);
  const review = readPrReview(conversation.reviewId, paths);
  if (!review) {
    return unavailableReviewerRuntime(
      models,
      'This reviewer instance is not bound to a durable Neondeck PR review. Explain that the review is unavailable and do not infer repository context.',
    );
  }
  if (conversation.headSha && conversation.headSha !== review.headSha) {
    return unavailableReviewerRuntime(
      models,
      'This reviewer conversation belongs to an older PR revision. Explain that the saved review moved to a new head revision and that a new reviewer conversation must be opened.',
    );
  }

  const workspace = await resolvePrReviewerWorkspace(
    {
      repoFullName: review.repoFullName,
      prNumber: review.prNumber,
      headSha: review.headSha,
      baseSha: review.baseSha,
      baseRef: review.baseRef,
    },
    paths,
  );
  const draft = readLivePrReviewDraft({
    databasePath: paths.neondeckDatabase,
    repo: review.repoFullName,
    prNumber: review.prNumber,
  });

  return {
    model: models.prReview,
    thinkingLevel: models.prReviewThinkingLevel,
    cwd: '/workspace',
    compaction: { reserveTokens: 10_000, keepRecentTokens: 8_000 },
    durability: {
      maxAttempts: 3,
      timeoutMs: models.prReviewTimeoutMs,
    },
    instructions: reviewerInstructions({
      review,
      workspace,
      draft,
      promptTemplate,
    }),
    tools: workspace.tools,
    actions: [],
    subagents: [],
  };
}

export default defineAgent(({ id }) => buildPrReviewerRuntime(id));

function unavailableReviewerRuntime(
  models: ReturnType<typeof readAgentModelSelectionSync>,
  instructions: string,
) {
  return {
    model: models.prReview,
    thinkingLevel: models.prReviewThinkingLevel,
    cwd: '/workspace',
    instructions,
    tools: [],
    actions: [],
    subagents: [],
  };
}

export function reviewerInstructions(input: {
  review: NonNullable<ReturnType<typeof readPrReview>>;
  workspace: Awaited<ReturnType<typeof resolvePrReviewerWorkspace>>;
  draft: ReturnType<typeof readLivePrReviewDraft>;
  promptTemplate: string;
}) {
  const { review, workspace, draft, promptTemplate } = input;
  const context = JSON.stringify({
    review: {
      id: review.id,
      target: `${review.repoFullName}#${review.prNumber}`,
      title: review.title,
      status: review.status,
      headSha: review.headSha,
      baseSha: review.baseSha,
      baseRef: review.baseRef,
      reportOnlyFindings: review.reportOnlyFindings,
    },
    localDraftComments: (draft?.comments ?? []).map((comment) => ({
      id: comment.id,
      path: comment.path,
      line: comment.line,
      startLine: comment.startLine,
      origin: comment.origin,
      body: comment.body.slice(0, 4_000),
    })),
    workspace: workspace.available
      ? {
          available: true,
          access: 'exact-revision-read-only-tools',
          mergeBase: workspace.mergeBase,
          headSha: workspace.headSha,
        }
      : { available: false, reason: workspace.reason },
  });

  return renderPrReviewPrompt(promptTemplate, {
    workspaceInstructions: workspace.available
      ? 'The exact-revision workspace tools are available; do not ask the user to paste repository files that you can inspect yourself.'
      : `The exact-revision workspace is unavailable: ${workspace.reason} Stay within the stored review evidence and be explicit about uncertainty.`,
    reviewContext: context,
  });
}
