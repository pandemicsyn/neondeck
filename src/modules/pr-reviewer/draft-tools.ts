import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
  prReviewerDraftToolNames,
  type PrReviewerDraftToolName,
} from '../../../shared/pr-reviewer-session';
import {
  readLivePrReviewDraft,
  readPrReviewDraftForComment,
  type GitHubPrReviewDraft,
  type GitHubPrReviewDraftComment,
} from '../github';
import {
  deleteGitHubPrReviewDraftComment,
  patchGitHubPrReviewDraftComment,
  postGitHubPrReviewDraftComment,
  putGitHubPrReviewDraft,
  type PrEventActionResult,
} from '../pr-events';
import {
  nonEmptyStringSchema,
  prEventOutputSchema,
  prReviewDraftCommentUpdateInputSchema,
} from '../pr-events/schemas';
import { readPrReview, type PrReviewRecord } from '../pr-reviews';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { asJsonValue } from '../../lib/action-result';

const draftCommentSideSchema = v.picklist(['RIGHT', 'LEFT']);
const draftCommentBodySchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(65_536),
);
const draftCommentLineSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const untrustedInputSchema = v.unknown();
const looseObjectSchema = v.looseObject({});
const draftCommentSchema = v.object({
  id: v.string(),
  draftId: v.string(),
  path: v.string(),
  side: draftCommentSideSchema,
  line: draftCommentLineSchema,
  startLine: v.nullable(draftCommentLineSchema),
  startSide: v.nullable(draftCommentSideSchema),
  body: v.string(),
  origin: v.picklist(['human', 'neon']),
  sourceFindingId: v.nullable(v.string()),
  createdAt: v.string(),
  updatedAt: v.string(),
});
const draftSchema = v.object({
  id: v.string(),
  repo: v.string(),
  prNumber: v.number(),
  headSha: v.string(),
  verdict: v.nullable(v.picklist(['comment', 'approve', 'request-changes'])),
  body: v.nullable(v.string()),
  status: v.picklist(['draft', 'submitted', 'discarded']),
  createdAt: v.string(),
  updatedAt: v.string(),
  submittedAt: v.nullable(v.string()),
  comments: v.array(draftCommentSchema),
});

type UntrustedInput = v.InferInput<typeof untrustedInputSchema>;
type LooseObject = v.InferOutput<typeof looseObjectSchema>;

const createDraftCommentInputSchema = v.object({
  path: nonEmptyStringSchema,
  side: draftCommentSideSchema,
  line: draftCommentLineSchema,
  startLine: v.optional(v.nullable(draftCommentLineSchema)),
  startSide: v.optional(v.nullable(draftCommentSideSchema)),
  body: draftCommentBodySchema,
});

const updateDraftCommentInputSchema = v.object({
  commentId: nonEmptyStringSchema,
  body: v.optional(draftCommentBodySchema),
  path: v.optional(nonEmptyStringSchema),
  side: v.optional(draftCommentSideSchema),
  line: v.optional(draftCommentLineSchema),
  startLine: v.optional(v.nullable(draftCommentLineSchema)),
  startSide: v.optional(v.nullable(draftCommentSideSchema)),
});

const deleteDraftCommentInputSchema = v.object({
  commentId: nonEmptyStringSchema,
});

export type PrReviewerDraftToolBinding = {
  reviewId: string;
  headSha: string;
};

type PrReviewerDraftToolDependencies = {
  readReview: typeof readPrReview;
  readLiveDraft: typeof readLivePrReviewDraft;
  readDraftForComment: typeof readPrReviewDraftForComment;
  putDraft: typeof putGitHubPrReviewDraft;
  postComment: typeof postGitHubPrReviewDraftComment;
  patchComment: typeof patchGitHubPrReviewDraftComment;
  deleteComment: typeof deleteGitHubPrReviewDraftComment;
};

const defaultDependencies: PrReviewerDraftToolDependencies = {
  readReview: readPrReview,
  readLiveDraft: readLivePrReviewDraft,
  readDraftForComment: readPrReviewDraftForComment,
  putDraft: putGitHubPrReviewDraft,
  postComment: postGitHubPrReviewDraftComment,
  patchComment: patchGitHubPrReviewDraftComment,
  deleteComment: deleteGitHubPrReviewDraftComment,
};

export function createPrReviewerDraftTools(
  binding: PrReviewerDraftToolBinding,
  paths: RuntimePaths = runtimePaths(),
  dependencyOverrides: Partial<PrReviewerDraftToolDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const [createName, updateName, deleteName] = prReviewerDraftToolNames;

  return [
    defineTool({
      name: createName,
      description:
        'Create one local PR review draft comment for the current bound review and exact head. Use only a verified diff anchor. This never posts to GitHub or submits the review.',
      input: createDraftCommentInputSchema,
      output: prEventOutputSchema,
      durable: true,
      async run({ data, toolCallId, step }) {
        const output = await step.do(
          'create-local-review-draft-comment',
          async () => {
            const bound = boundReview(createName, binding, paths, dependencies);
            if (!bound.ok) return bound.result;
            let draft = dependencies.readLiveDraft({
              databasePath: paths.neondeckDatabase,
              repo: bound.review.repoFullName,
              prNumber: bound.review.prNumber,
            });
            if (draft && !draftMatchesReview(draft, bound.review)) {
              return failure(
                createName,
                'The live local draft belongs to a different PR revision.',
                ['currentReviewDraft'],
              );
            }
            if (!draft) {
              const created = await dependencies.putDraft(
                reviewTarget(bound.review),
                { headSha: bound.review.headSha },
                paths,
              );
              if (!created.ok) return reframeResult(createName, created);
              draft = draftFromResult(created);
            }
            if (!draft || !draftMatchesReview(draft, bound.review)) {
              return failure(
                createName,
                'Could not establish a local draft for the bound review revision.',
                ['currentReviewDraft'],
              );
            }

            const commentId = `reviewer-draft:${toolCallId}`;
            const result = await dependencies.postComment(
              reviewTarget(bound.review),
              {
                draftId: draft.id,
                path: data.path,
                side: data.side,
                line: data.line,
                startLine: data.startLine ?? null,
                startSide: data.startSide ?? null,
                body: data.body,
              },
              paths,
              {},
              {
                expectedHeadSha: bound.review.headSha,
                id: commentId,
                origin: 'neon',
              },
            );
            return compactResult(createName, result, commentId);
          },
        );
        return { output };
      },
    }),
    defineTool({
      name: updateName,
      description:
        'Edit or re-anchor one local PR review draft comment from the current review context. Pass its exact commentId; omit body to preserve the current text while changing the anchor. This never writes to GitHub.',
      input: updateDraftCommentInputSchema,
      output: prEventOutputSchema,
      durable: true,
      async run({ data, step }) {
        const output = await step.do(
          'update-local-review-draft-comment',
          async () => {
            const bound = boundReview(updateName, binding, paths, dependencies);
            if (!bound.ok) return bound.result;
            const comment = boundComment(
              updateName,
              data.commentId,
              bound.review,
              paths,
              dependencies,
            );
            if (!comment.ok) return comment.result;

            const patch: v.InferInput<
              typeof prReviewDraftCommentUpdateInputSchema
            > = {
              body: data.body ?? comment.comment.body,
            };
            if ('path' in data) patch.path = data.path;
            if ('side' in data) patch.side = data.side;
            if ('line' in data) patch.line = data.line;
            if ('startLine' in data) patch.startLine = data.startLine ?? null;
            if ('startSide' in data) patch.startSide = data.startSide ?? null;
            const result = await dependencies.patchComment(
              reviewTarget(bound.review),
              data.commentId,
              patch,
              paths,
              {},
              {
                expectedHeadSha: bound.review.headSha,
                origin:
                  data.body === undefined ? comment.comment.origin : 'neon',
              },
            );
            return compactResult(updateName, result, data.commentId);
          },
        );
        return { output };
      },
    }),
    defineTool({
      name: deleteName,
      description:
        'Delete one local PR review draft comment from the current bound review using its exact commentId. This never deletes a GitHub comment or submits the review.',
      input: deleteDraftCommentInputSchema,
      output: prEventOutputSchema,
      durable: true,
      async run({ data, step }) {
        const output = await step.do(
          'delete-local-review-draft-comment',
          async () => {
            const bound = boundReview(deleteName, binding, paths, dependencies);
            if (!bound.ok) return bound.result;
            const draft = dependencies.readDraftForComment({
              databasePath: paths.neondeckDatabase,
              commentId: data.commentId,
            });
            const comment = draft?.comments.find(
              (item) => item.id === data.commentId,
            );
            if (!draft || !comment) {
              const liveDraft = dependencies.readLiveDraft({
                databasePath: paths.neondeckDatabase,
                repo: bound.review.repoFullName,
                prNumber: bound.review.prNumber,
              });
              if (liveDraft && !draftMatchesReview(liveDraft, bound.review)) {
                return failure(
                  deleteName,
                  'The live local draft belongs to a different PR revision.',
                  ['currentReviewDraft'],
                );
              }
              return idempotentDeleteResult(deleteName, liveDraft);
            }
            if (!draftMatchesReview(draft, bound.review)) {
              return failure(
                deleteName,
                'The local draft comment does not belong to the bound PR review revision.',
                ['commentId'],
              );
            }

            const result = await dependencies.deleteComment(
              reviewTarget(bound.review),
              data.commentId,
              paths,
              { expectedHeadSha: bound.review.headSha },
            );
            return compactResult(deleteName, result);
          },
        );
        return { output };
      },
    }),
  ];
}

function boundReview(
  action: PrReviewerDraftToolName,
  binding: PrReviewerDraftToolBinding,
  paths: RuntimePaths,
  dependencies: PrReviewerDraftToolDependencies,
):
  | { ok: true; review: PrReviewRecord }
  | { ok: false; result: PrEventActionResult } {
  const review = dependencies.readReview(binding.reviewId, paths);
  if (!review) {
    return {
      ok: false,
      result: failure(action, 'The bound PR review is no longer available.', [
        'currentReview',
      ]),
    };
  }
  if (review.headSha !== binding.headSha) {
    return {
      ok: false,
      result: failure(
        action,
        'The reviewer conversation belongs to an older PR revision.',
        ['currentReviewRevision'],
      ),
    };
  }
  if (review.status !== 'ready') {
    return {
      ok: false,
      result: failure(
        action,
        'Local draft comments can only be changed while the bound PR review is ready.',
        ['readyReview'],
      ),
    };
  }
  return { ok: true, review };
}

function boundComment(
  action: PrReviewerDraftToolName,
  commentId: string,
  review: PrReviewRecord,
  paths: RuntimePaths,
  dependencies: PrReviewerDraftToolDependencies,
):
  | { ok: true; comment: GitHubPrReviewDraftComment }
  | { ok: false; result: PrEventActionResult } {
  const draft = dependencies.readDraftForComment({
    databasePath: paths.neondeckDatabase,
    commentId,
  });
  const comment = draft?.comments.find((item) => item.id === commentId);
  if (!draft || !comment || !draftMatchesReview(draft, review)) {
    return {
      ok: false,
      result: failure(
        action,
        'The local draft comment does not belong to the bound PR review revision.',
        ['commentId'],
      ),
    };
  }
  return { ok: true, comment };
}

function draftMatchesReview(
  draft: GitHubPrReviewDraft,
  review: PrReviewRecord,
) {
  return (
    draft.status === 'draft' &&
    draft.repo.toLowerCase() === review.repoFullName.toLowerCase() &&
    draft.prNumber === review.prNumber &&
    draft.headSha === review.headSha
  );
}

function reviewTarget(review: PrReviewRecord) {
  return { repo: review.repoFullName, prNumber: review.prNumber };
}

function draftFromResult(result: PrEventActionResult) {
  const data = asRecord(result.data);
  const parsed = v.safeParse(draftSchema, data?.draft);
  return parsed.success ? parsed.output : null;
}

function compactResult(
  action: PrReviewerDraftToolName,
  result: PrEventActionResult,
  commentId?: string,
): PrEventActionResult {
  if (!result.ok) return reframeResult(action, result);
  const draft = draftFromResult(result);
  const comment = commentId
    ? draft?.comments.find((item) => item.id === commentId)
    : null;
  return {
    ok: true,
    action,
    changed: result.changed,
    message: result.message,
    data: {
      draftId: draft?.id ?? null,
      headSha: draft?.headSha ?? null,
      commentCount: draft?.comments.length ?? null,
      comment: comment ? asJsonValue(comment) : null,
    },
  };
}

function idempotentDeleteResult(
  action: PrReviewerDraftToolName,
  draft: GitHubPrReviewDraft | null,
): PrEventActionResult {
  return {
    ok: true,
    action,
    changed: false,
    message: 'The local PR review draft comment is already deleted.',
    data: {
      draftId: draft?.id ?? null,
      headSha: draft?.headSha ?? null,
      commentCount: draft?.comments.length ?? null,
      comment: null,
    },
  };
}

function reframeResult(
  action: PrReviewerDraftToolName,
  result: PrEventActionResult,
): PrEventActionResult {
  return { ...result, action };
}

function failure(
  action: PrReviewerDraftToolName,
  message: string,
  requires?: string[],
): PrEventActionResult {
  const base = {
    ok: false,
    action,
    changed: false,
    message,
  };
  return requires ? { ...base, requires } : base;
}

function asRecord(value: UntrustedInput): LooseObject | null {
  const parsed = v.safeParse(looseObjectSchema, value);
  return parsed.success ? parsed.output : null;
}
