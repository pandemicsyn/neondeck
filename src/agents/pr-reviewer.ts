'use agent';

import {
  type AgentProps,
  useAgentStart,
  useModel,
  usePersistentState,
  useSandbox,
  useTool,
} from '@flue/runtime';
import type { MiddlewareHandler } from 'hono';
import { parsePrReviewerConversationId } from '../../shared/pr-reviewer-session';
import { readLivePrReviewDraft } from '../modules/github';
import { readPrReview } from '../modules/pr-reviews';
import {
  readPrReviewerHandoff,
  createPrReviewerWorkspaceTools,
  prReviewerWorkspaceToolCallLimit,
  resolvePrReviewerWorkspace,
  type PrReviewerHandoff,
} from '../modules/pr-reviewer';
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
import { noWorkspace } from '../sandboxes/no-workspace';

export const description =
  'Continuing read-only reviewer conversation for one durable Neondeck PR review.';

export function createPrReviewerRoute(
  paths: RuntimePaths = runtimePaths(),
): MiddlewareHandler {
  return async (context, next) => {
    if (context.req.method !== 'POST') return next();
    const id = reviewerConversationIdFromPath(context.req.path);
    if (!id) return next();
    const conversation = parsePrReviewerConversationId(id);
    if (!conversation.headSha) {
      return context.json(
        {
          error: {
            type: 'review_revision_required',
            message: 'Reviewer conversations must name a PR revision.',
            details:
              'Open the reviewer conversation from the completed review so its conversation id includes the reviewed head revision.',
            meta: {
              reviewId: conversation.reviewId,
            },
          },
        },
        409,
      );
    }
    const review = readPrReview(conversation.reviewId, paths);
    if (!review || conversation.headSha === review.headSha) return next();
    return context.json(
      {
        error: {
          type: 'review_revision_stale',
          message:
            'This reviewer conversation belongs to an older PR revision.',
          details:
            'Open the reviewer conversation for the current completed review before asking revision-bound questions.',
          meta: {
            currentHeadSha: review.headSha,
            conversationHeadSha: conversation.headSha,
            reviewId: review.id,
          },
        },
      },
      409,
    );
  };
}

export const route = createPrReviewerRoute();

type PreparedReviewerContext = {
  instructions: string;
  workspace:
    | {
        available: true;
        repoPath: string;
        headSha: string;
        mergeBase: string | null;
      }
    | { available: false };
};

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
  const handoff = await readPrReviewerHandoff(review, paths);

  return {
    model: models.prReview,
    thinkingLevel: models.prReviewThinkingLevel,
    sandbox: noWorkspace(),
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
      handoff,
      promptTemplate,
    }),
    reviewerWorkspace: workspace,
    tools: workspace.tools,
    actions: [],
    subagents: [],
  };
}

export function PrReviewer({ id }: AgentProps) {
  const models = readAgentModelSelectionSync();
  const [prepared, setPrepared] =
    usePersistentState<PreparedReviewerContext | null>(
      'prepared-reviewer-context',
      null,
    );
  const [, setWorkspaceToolCallsUsed] = usePersistentState(
    'workspace-tool-calls-used',
    0,
  );

  useModel(models.prReview, {
    thinkingLevel: models.prReviewThinkingLevel,
    compaction: { reserveTokens: 10_000, keepRecentTokens: 8_000 },
  });
  useSandbox(noWorkspace(), { cwd: '/workspace' });
  useAgentStart(async () => {
    const runtime = await buildPrReviewerRuntime(id);
    const workspace = runtime.reviewerWorkspace;
    setPrepared({
      instructions: runtime.instructions,
      workspace: workspace.available
        ? {
            available: true,
            repoPath: workspace.repoPath,
            headSha: workspace.headSha,
            mergeBase: workspace.mergeBase,
          }
        : { available: false },
    });
  });

  if (prepared?.workspace.available) {
    const consumeToolCall = () => {
      let remaining: number | null = null;
      setWorkspaceToolCallsUsed((used) => {
        if (used >= prReviewerWorkspaceToolCallLimit) return used;
        remaining = prReviewerWorkspaceToolCallLimit - used - 1;
        return used + 1;
      });
      return remaining;
    };
    for (const tool of createPrReviewerWorkspaceTools(prepared.workspace, {
      consumeToolCall,
    })) {
      useTool(tool);
    }
  }

  return (
    prepared?.instructions ??
    'Prepare the exact-revision reviewer context before answering. If the context is unavailable, explain that the saved review cannot be opened and do not infer repository facts.'
  );
}

PrReviewer.agentName = 'pr-reviewer';
PrReviewer.durability = {
  maxAttempts: 3,
  timeoutMs: readAgentModelSelectionSync().prReviewTimeoutMs,
};

function unavailableReviewerRuntime(
  models: ReturnType<typeof readAgentModelSelectionSync>,
  instructions: string,
) {
  return {
    model: models.prReview,
    thinkingLevel: models.prReviewThinkingLevel,
    sandbox: noWorkspace(),
    cwd: '/workspace',
    instructions,
    reviewerWorkspace: {
      available: false as const,
      reason: instructions,
      tools: [] as [],
    },
    tools: [],
    actions: [],
    subagents: [],
  };
}

function reviewerConversationIdFromPath(path: string) {
  const marker = '/api/flue/agents/pr-reviewer/';
  const markerIndex = path.indexOf(marker);
  if (markerIndex < 0) return null;
  const suffix = path.slice(markerIndex + marker.length);
  if (!suffix || suffix.includes('/')) return null;
  try {
    return decodeURIComponent(suffix);
  } catch {
    return null;
  }
}

export function reviewerInstructions(input: {
  review: NonNullable<ReturnType<typeof readPrReview>>;
  workspace: Awaited<ReturnType<typeof resolvePrReviewerWorkspace>>;
  draft: ReturnType<typeof readLivePrReviewDraft>;
  handoff: PrReviewerHandoff;
  promptTemplate: string;
}) {
  const { review, workspace, draft, handoff, promptTemplate } = input;
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
    initialReviewHandoff: handoff,
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
