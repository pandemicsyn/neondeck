import { createHash } from 'node:crypto';
import {
  neonReviewFindingLimits,
  type NeonReviewFinding,
  type NeonReviewFindingPromotion,
  type ReviewSurfaceFindingPromoteRequest,
} from '../../../shared/review-finding';
import type { ReviewSourcePromotionTarget } from '../../../shared/review-source';
import {
  getGitHubPrFileDiff,
  getGitHubPrReviewDraft,
  postGitHubPrReviewDraftComment,
  putGitHubPrReviewDraft,
} from '../pr-events';
import {
  readPreparedDiffFileDiff,
  requestPreparedDiffRevision,
} from '../prepared-diffs';
import {
  buildPatchAnchorIndex,
  commentAnchorExists,
} from '../../../shared/patch-anchors';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import {
  type ReviewSurfaceFindingResult,
  type ValidatedReviewSurfaceFindingPromotion,
  ReviewSurfaceRegistry,
} from './registry';

export type ReviewSurfacePromotionTargetResult =
  | {
      ok: true;
      promotion: Omit<NeonReviewFindingPromotion, 'requestId'>;
    }
  | { ok: false; message: string };

export type ReviewSurfacePromotionTarget = (
  candidate: ValidatedReviewSurfaceFindingPromotion,
) => Promise<ReviewSurfacePromotionTargetResult>;

export type ReviewSurfacePromotionDependencies = {
  getGitHubDraft?: typeof getGitHubPrReviewDraft;
  putGitHubDraft?: typeof putGitHubPrReviewDraft;
  postGitHubDraftComment?: typeof postGitHubPrReviewDraftComment;
  readGitHubFileDiff?: typeof getGitHubPrFileDiff;
  readPreparedFileDiff?: typeof readPreparedDiffFileDiff;
  requestPreparedRevision?: typeof requestPreparedDiffRevision;
};

export class ReviewSurfaceFindingPromotionService {
  private readonly pending = new Map<
    string,
    {
      surfaceId: string;
      requestId: string;
      fingerprint: string;
      promise: Promise<ReviewSurfaceFindingResult>;
    }
  >();
  private readonly completed = new Map<
    string,
    { fingerprint: string; result: ReviewSurfaceFindingResult }
  >();

  constructor(
    private readonly registry: ReviewSurfaceRegistry,
    private readonly promoteTarget: ReviewSurfacePromotionTarget = createDefaultReviewSurfacePromotionTarget(),
  ) {}

  promote(
    surfaceId: string,
    request: ReviewSurfaceFindingPromoteRequest,
  ): Promise<ReviewSurfaceFindingResult> {
    const completedKey = promotionRequestKey(surfaceId, request.requestId);
    const fingerprint = promotionRequestFingerprint(request);
    const completed = this.completed.get(completedKey);
    if (completed) {
      return Promise.resolve(
        completed.fingerprint === fingerprint
          ? completed.result
          : promotionError(
              surfaceId,
              request.revisionKey,
              'promotion-request-conflict',
              'This promotion request id is already bound to different input.',
            ),
      );
    }

    const validated = this.registry.validateFindingPromotion(
      surfaceId,
      request,
    );
    if (!validated.ok) return Promise.resolve(validated.result);

    const findingKey = promotionFindingKey(validated.value);
    const pending = this.pending.get(findingKey);
    if (pending) {
      return pending.surfaceId === surfaceId &&
        pending.requestId === request.requestId &&
        pending.fingerprint === fingerprint
        ? pending.promise
        : Promise.resolve(
            promotionError(
              surfaceId,
              request.revisionKey,
              pending.requestId === request.requestId
                ? 'promotion-request-conflict'
                : 'promotion-pending',
              pending.requestId === request.requestId
                ? 'This promotion request id is already bound to different input.'
                : 'This finding promotion is already in progress.',
            ),
          );
    }

    const promise = this.runPromotion(
      surfaceId,
      request,
      fingerprint,
      validated.value,
    );
    this.pending.set(findingKey, {
      surfaceId,
      requestId: request.requestId,
      fingerprint,
      promise,
    });
    void promise.finally(() => {
      const current = this.pending.get(findingKey);
      if (
        current?.surfaceId === surfaceId &&
        current.requestId === request.requestId
      ) {
        this.pending.delete(findingKey);
      }
    });
    return promise;
  }

  private async runPromotion(
    surfaceId: string,
    request: ReviewSurfaceFindingPromoteRequest,
    fingerprint: string,
    candidate: ValidatedReviewSurfaceFindingPromotion,
  ) {
    let target: ReviewSurfacePromotionTargetResult;
    try {
      target = await this.promoteTarget(candidate);
    } catch (error) {
      target = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (!target.ok) {
      return promotionError(
        surfaceId,
        request.revisionKey,
        'promotion-target-failed',
        target.message ||
          'The durable promotion destination could not be created.',
      );
    }
    if (!validTargetPromotion(request, target.promotion)) {
      return promotionError(
        surfaceId,
        request.revisionKey,
        'promotion-target-failed',
        'The durable promotion destination returned invalid metadata.',
      );
    }
    const result = this.registry.completeFindingPromotion(surfaceId, request, {
      ...target.promotion,
      requestId: request.requestId,
    });
    if (result.ok) {
      this.completed.set(promotionRequestKey(surfaceId, request.requestId), {
        fingerprint,
        result,
      });
      if (this.completed.size > 400) {
        this.completed.delete(this.completed.keys().next().value as string);
      }
    }
    return result;
  }
}

export function createDefaultReviewSurfacePromotionTarget(
  paths: RuntimePaths = runtimePaths(),
  dependencies: ReviewSurfacePromotionDependencies = {},
): ReviewSurfacePromotionTarget {
  return async (candidate) => {
    if (candidate.target.destination === 'github-review-draft') {
      return promoteToGitHubDraft(
        candidate,
        candidate.target,
        paths,
        dependencies,
      );
    }
    return promoteToPreparedDiffRevision(
      candidate,
      candidate.target,
      paths,
      dependencies,
    );
  };
}

async function promoteToGitHubDraft(
  candidate: ValidatedReviewSurfaceFindingPromotion,
  target: Extract<
    ReviewSourcePromotionTarget,
    { destination: 'github-review-draft' }
  >,
  paths: RuntimePaths,
  dependencies: ReviewSurfacePromotionDependencies,
): Promise<ReviewSurfacePromotionTargetResult> {
  const revision = candidate.surface.source.revision;
  if (revision.state !== 'resolved' || revision.kind !== 'git-commit') {
    return {
      ok: false,
      message: 'The GitHub pull request revision is unavailable.',
    };
  }
  const targetInput = {
    repo: target.repoFullName,
    prNumber: target.prNumber,
  };
  const patchResult = await (
    dependencies.readGitHubFileDiff ?? getGitHubPrFileDiff
  )(
    {
      ...targetInput,
      headSha: revision.id,
      baseSha: revision.baseId,
      path: candidate.finding.file,
    },
    paths,
  );
  if (
    !patchResult.ok ||
    !promotionAnchorExists(
      candidate,
      stringField(objectField(patchResult.data).diff),
    )
  ) {
    return {
      ok: false,
      message: patchResult.ok
        ? 'The finding anchor is unavailable on the current GitHub revision.'
        : patchResult.message,
    };
  }
  const currentDraftResult = await (
    dependencies.getGitHubDraft ?? getGitHubPrReviewDraft
  )(targetInput, paths);
  if (!currentDraftResult.ok) {
    return { ok: false, message: currentDraftResult.message };
  }
  let draft = objectField(objectField(currentDraftResult.data).draft);
  if (stringField(draft.id)) {
    if (stringField(draft.headSha) !== revision.id) {
      return {
        ok: false,
        message:
          'The local GitHub review draft is for an older PR head. Refresh and re-anchor the draft, then retry promotion.',
      };
    }
  } else {
    const draftResult = await (
      dependencies.putGitHubDraft ?? putGitHubPrReviewDraft
    )(targetInput, { headSha: revision.id }, paths);
    if (!draftResult.ok) return { ok: false, message: draftResult.message };
    draft = objectField(objectField(draftResult.data).draft);
  }
  const draftId = stringField(draft.id);
  if (!draftId || stringField(draft.headSha) !== revision.id)
    return {
      ok: false,
      message:
        'The local GitHub review draft is not anchored to the current PR head. Refresh and re-anchor the draft, then retry promotion.',
    };
  const sourceFindingId = durableFindingSourceId(candidate);
  const existing = arrayField(draft.comments)
    .map(objectField)
    .find(
      (comment) => stringField(comment.sourceFindingId) === sourceFindingId,
    );
  if (existing) {
    const commentId = stringField(existing.id);
    if (commentId) {
      return {
        ok: true,
        promotion: {
          destination: 'github-review-draft',
          targetId: commentId,
          containerId: draftId,
        },
      };
    }
  }

  const side = candidate.request.anchor.side === 'deletions' ? 'LEFT' : 'RIGHT';
  const commentResult = await (
    dependencies.postGitHubDraftComment ?? postGitHubPrReviewDraftComment
  )(
    targetInput,
    {
      draftId,
      path: candidate.finding.file,
      side,
      line: candidate.request.anchor.endLine,
      startLine:
        candidate.request.anchor.startLine === candidate.request.anchor.endLine
          ? null
          : candidate.request.anchor.startLine,
      startSide:
        candidate.request.anchor.startLine === candidate.request.anchor.endLine
          ? null
          : side,
      body: findingReason(candidate.finding),
      sourceFindingId,
    },
    paths,
    {},
    { origin: 'neon' },
  );
  if (!commentResult.ok) return { ok: false, message: commentResult.message };
  const savedDraft = objectField(objectField(commentResult.data).draft);
  const comment = arrayField(savedDraft.comments)
    .map(objectField)
    .find((item) => stringField(item.sourceFindingId) === sourceFindingId);
  const commentId = stringField(comment?.id);
  if (!commentId)
    return { ok: false, message: 'The local draft comment was not retained.' };
  return {
    ok: true,
    promotion: {
      destination: 'github-review-draft',
      targetId: commentId,
      containerId: draftId,
    },
  };
}

async function promoteToPreparedDiffRevision(
  candidate: ValidatedReviewSurfaceFindingPromotion,
  target: Extract<
    ReviewSourcePromotionTarget,
    { destination: 'prepared-diff-revision' }
  >,
  paths: RuntimePaths,
  dependencies: ReviewSurfacePromotionDependencies,
): Promise<ReviewSurfacePromotionTargetResult> {
  const sourceFindingId = durableFindingSourceId(candidate);
  const patchResult = await (
    dependencies.readPreparedFileDiff ?? readPreparedDiffFileDiff
  )(
    {
      preparedDiffId: target.preparedDiffId,
      path: candidate.finding.file,
    },
    paths,
  );
  if (!patchResult.ok || !promotionAnchorExists(candidate, patchResult.diff)) {
    return {
      ok: false,
      message: patchResult.ok
        ? 'The finding anchor is unavailable on the current prepared diff.'
        : patchResult.message,
    };
  }
  const result = await (
    dependencies.requestPreparedRevision ?? requestPreparedDiffRevision
  )(
    {
      preparedDiffId: target.preparedDiffId,
      reason: preparedFindingReason(candidate),
      approverSurface: candidate.surface.surfaceId,
      findingPromotion: {
        sourceFindingId,
        surfaceId: candidate.surface.surfaceId,
        sourceId: candidate.finding.sourceId,
        revisionKey: candidate.finding.revisionKey,
        findingId: candidate.finding.id,
      },
    },
    paths,
  );
  if (!result.ok) return { ok: false, message: result.message };
  const revisionApproval = result.approvals?.find(
    (approval) => approval.approvalType === 'revision',
  );
  return {
    ok: true,
    promotion: {
      destination: 'prepared-diff-revision',
      targetId: revisionApproval?.id ?? target.preparedDiffId,
      containerId: target.preparedDiffId,
    },
  };
}

export function findingReason(finding: NeonReviewFinding) {
  return [
    finding.title,
    finding.explanation,
    finding.suggestedAction
      ? `Suggested action: ${finding.suggestedAction}`
      : null,
    `Neon provenance: role ${finding.provenance.authorRole}; model ${finding.provenance.model ?? 'unavailable'}; run ${finding.provenance.workflowRunId ?? 'unavailable'}; finding ${finding.id}.`,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n\n');
}

function preparedFindingReason(
  candidate: ValidatedReviewSurfaceFindingPromotion,
) {
  const sourceReason = findingReason(candidate.finding);
  const userReason = candidate.request.reason?.trim();
  return userReason && userReason !== sourceReason
    ? `${userReason}\n\nSource Neon finding:\n${sourceReason}`
    : sourceReason;
}

function durableFindingSourceId(
  candidate: ValidatedReviewSurfaceFindingPromotion,
) {
  const digest = createHash('sha256')
    .update(
      [
        candidate.finding.sourceId,
        candidate.finding.revisionKey,
        candidate.finding.id,
      ].join('\0'),
    )
    .digest('hex')
    .slice(0, 32);
  return `neon_surface_${digest}`;
}

function promotionAnchorExists(
  candidate: ValidatedReviewSurfaceFindingPromotion,
  patch: string | null | undefined,
) {
  if (!patch?.trim()) return false;
  const side = candidate.request.anchor.side === 'deletions' ? 'LEFT' : 'RIGHT';
  if (
    !commentAnchorExists(buildPatchAnchorIndex(patch), {
      side,
      line: candidate.request.anchor.endLine,
      startLine:
        candidate.request.anchor.startLine === candidate.request.anchor.endLine
          ? null
          : candidate.request.anchor.startLine,
      startSide:
        candidate.request.anchor.startLine === candidate.request.anchor.endLine
          ? null
          : side,
    })
  ) {
    return false;
  }
  if (candidate.finding.anchor.kind !== 'hunk') return true;
  const hunkId = candidate.finding.anchor.hunkId;
  const hunk = patchHunks(patch).find((item) => item.id === hunkId);
  if (!hunk) return false;
  const line = side === 'LEFT' ? hunk.oldStart : hunk.newStart;
  const count = side === 'LEFT' ? hunk.oldCount : hunk.newCount;
  return (
    count > 0 &&
    candidate.request.anchor.startLine === line &&
    candidate.request.anchor.endLine === line
  );
}

function patchHunks(patch: string) {
  const result: Array<{
    id: string;
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
  }> = [];
  const pattern = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;
  for (const line of patch.split('\n')) {
    const match = line.match(pattern);
    if (!match) continue;
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    result.push({
      id: `${result.length}:${oldStart}:${newStart}`,
      oldStart,
      oldCount,
      newStart,
      newCount,
    });
  }
  return result;
}

function promotionFindingKey(
  candidate: ValidatedReviewSurfaceFindingPromotion,
) {
  return [
    candidate.request.destination,
    candidate.finding.sourceId,
    candidate.finding.revisionKey,
    candidate.finding.id,
  ].join('\0');
}

function promotionRequestKey(surfaceId: string, requestId: string) {
  return `${surfaceId}\0${requestId}`;
}

function promotionRequestFingerprint(
  request: ReviewSurfaceFindingPromoteRequest,
) {
  return JSON.stringify({
    sourceId: request.sourceId,
    revisionKey: request.revisionKey,
    findingId: request.findingId,
    destination: request.destination,
    anchor: {
      side: request.anchor.side,
      startLine: request.anchor.startLine,
      endLine: request.anchor.endLine,
    },
    confirm: request.confirm,
    reason: request.reason,
  });
}

function validTargetPromotion(
  request: ReviewSurfaceFindingPromoteRequest,
  promotion: Omit<NeonReviewFindingPromotion, 'requestId'>,
) {
  return (
    promotion.destination === request.destination &&
    boundedTargetId(promotion.targetId) &&
    (promotion.containerId === null || boundedTargetId(promotion.containerId))
  );
}

function boundedTargetId(value: string) {
  return (
    value.length > 0 &&
    value.length <= neonReviewFindingLimits.maxPromotionTargetIdLength
  );
}

function promotionError(
  surfaceId: string,
  revisionKey: string,
  code: Extract<
    NonNullable<ReviewSurfaceFindingResult['error']>['code'],
    | 'promotion-pending'
    | 'promotion-request-conflict'
    | 'promotion-target-failed'
  >,
  message: string,
): ReviewSurfaceFindingResult {
  return {
    ok: false,
    action: 'promote',
    changed: false,
    message,
    surfaceId,
    revisionKey,
    error: { code, message },
  };
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayField(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringField(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
