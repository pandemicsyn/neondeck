import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import {
  reviewRevisionKey,
  resolvedReviewRevision,
} from '../../../shared/review-source';
import {
  prReviewTourLimits,
  type PrReviewTour,
  type PrReviewTourDraft,
  type PrReviewTourProvenance,
  type ReviewTourChangeEvent,
} from '../../../shared/pr-review-tour';
import { openDb } from '../../lib/sqlite';
import { getGitHubPrFiles } from '../pr-events';
import { readPrReview, type PrReviewRecord } from '../pr-reviews';
import type { RuntimePaths } from '../../runtime-home';
import { prReviewerConversationId } from '../../../shared/pr-reviewer-session';
import { publishReviewTourEvent } from './events';
import { reviewSurfaceRegistry } from '../review-surfaces/registry';
import { prReviewTourDraftSchema } from './schemas';
import {
  readPrReviewTour,
  readPrReviewTourPublication,
  replacePrReviewTourStore,
} from './store';

type ReviewFile = {
  path: string;
  patch: string | null;
  binary: boolean;
  truncated: boolean;
};

export type PrReviewTourServiceDependencies = {
  readReview?: typeof readPrReview;
  loadFiles?: (
    review: PrReviewRecord,
    paths: RuntimePaths,
  ) => Promise<ReviewFile[]>;
  now?: () => Date;
  publishEvent?: typeof publishReviewTourEvent;
  readSurface?: typeof reviewSurfaceRegistry.read;
};

export type ReplacePrReviewTourResult = {
  ok: boolean;
  action: 'replace_pr_tour';
  changed: boolean;
  message: string;
  tour?: PrReviewTour;
  requires?: string[];
};

export async function replacePrReviewTour(
  binding: { reviewId: string; headSha: string },
  draftInput: unknown,
  provenance: Omit<PrReviewTourProvenance, 'createdAt'> & {
    toolCallId: string;
  },
  paths: RuntimePaths,
  dependencies: PrReviewTourServiceDependencies = {},
): Promise<ReplacePrReviewTourResult> {
  const priorPublication = readPrReviewTourPublication(
    provenance.toolCallId,
    paths,
  );
  if (
    priorPublication?.reviewId === binding.reviewId &&
    priorPublication.headSha === binding.headSha
  ) {
    return {
      ok: true,
      action: 'replace_pr_tour',
      changed: false,
      message: 'This guided tour publication was already recorded.',
      tour: priorPublication,
    };
  }
  const readReview = dependencies.readReview ?? readPrReview;
  const review = readReview(binding.reviewId, paths) ?? undefined;
  if (!review) {
    return failure('The bound PR review is no longer available.', [
      'currentReview',
    ]);
  }
  const bound = validateBoundReview(review, binding);
  if (!bound.ok) return bound.result;

  const parsed = v.safeParse(prReviewTourDraftSchema, draftInput);
  if (!parsed.success) {
    return failure('The proposed tour is invalid.', ['validTour']);
  }
  const draft: PrReviewTourDraft = {
    ...parsed.output,
    sourceFindingId: parsed.output.sourceFindingId ?? null,
  };
  const duplicateKeys = duplicateValues(draft.steps.map((step) => step.key));
  if (duplicateKeys.length > 0) {
    return failure('Tour step keys must be unique.', ['uniqueStepKeys']);
  }
  for (const step of draft.steps) {
    if (step.endLine < step.startLine) {
      return failure('A tour step ends before it starts.', [
        'orderedLineRange',
      ]);
    }
    if (
      step.endLine - step.startLine + 1 >
      prReviewTourLimits.maxLineRangeSpan
    ) {
      return failure('A tour step covers too many lines.', [
        'boundedLineRange',
      ]);
    }
  }

  let files: ReviewFile[];
  try {
    files = await (dependencies.loadFiles ?? loadReviewFiles)(review, paths);
  } catch (error) {
    return failure(
      `Could not validate the tour against the exact review revision: ${errorMessage(error)}`,
      ['currentReviewPatch'],
    );
  }
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  for (const step of draft.steps) {
    const file = fileByPath.get(step.file);
    if (!file || file.binary || file.truncated || !file.patch) {
      return failure(
        `Tour step ${step.key} does not resolve to an available changed-file patch.`,
        ['visiblePatchAnchor'],
      );
    }
    const visibleLines = patchLineKeys(file.patch);
    for (let line = step.startLine; line <= step.endLine; line += 1) {
      if (!visibleLines.has(`${step.side}:${line}`)) {
        return failure(
          `Tour step ${step.key} does not resolve to visible ${step.side} lines ${step.startLine}-${step.endLine}.`,
          ['visiblePatchAnchor'],
        );
      }
    }
  }

  const revisionKey = reviewRevisionKey(
    resolvedReviewRevision({
      kind: 'git-commit',
      id: review.headSha,
      baseId: review.baseSha,
    }),
  );
  if (!revisionKey) {
    return failure('The review revision is unavailable.', [
      'currentReviewRevision',
    ]);
  }
  const conversationId = prReviewerConversationId(review.id, review.headSha);
  const createdAt = (dependencies.now ?? (() => new Date()))().toISOString();
  let stored: ReturnType<typeof replacePrReviewTourStore>;
  try {
    stored = replacePrReviewTourStore(
      {
        conversationId,
        reviewId: review.id,
        repoFullName: review.repoFullName,
        headSha: review.headSha,
        revisionKey,
        draft,
        provenance: {
          authorRole: provenance.authorRole,
          model: provenance.model,
          submissionId: provenance.submissionId,
          createdAt,
        },
        toolCallId: provenance.toolCallId,
        assertCurrent: () => {
          const current = readReview(binding.reviewId, paths) ?? undefined;
          const validation = validateBoundReview(current, binding);
          if (!validation.ok) {
            throw new TourBindingChangedError(validation.result);
          }
          if (!sameReviewRevision(current!, review)) {
            throw new TourBindingChangedError(
              failure(
                'The bound PR review repository or base revision changed while the tour was being validated.',
                ['currentReviewRevision'],
              ),
            );
          }
        },
      },
      paths,
    );
  } catch (error) {
    if (error instanceof TourBindingChangedError) return error.result;
    throw error;
  }
  if (stored.changed) {
    (dependencies.publishEvent ?? publishReviewTourEvent)({
      id: randomUUID(),
      action: 'tour-replaced',
      conversationId,
      reviewId: review.id,
      revisionKey,
      tourId: stored.tour.id,
      generation: stored.tour.generation,
      changedAt: createdAt,
    });
  }
  return {
    ok: true,
    action: 'replace_pr_tour',
    changed: stored.changed,
    message: stored.changed
      ? `Published ${stored.tour.steps.length} guided tour step(s).`
      : 'This guided tour publication was already recorded.',
    tour: stored.tour,
  };
}

export function readBoundPrReviewTour(
  reviewId: string,
  headSha: string,
  paths: RuntimePaths,
) {
  return readPrReviewTour(prReviewerConversationId(reviewId, headSha), paths);
}

export function publishReviewTourPresentation(
  event:
    | {
        action: 'tour-activated';
        surfaceId: string;
        tourId: string;
        generation: number;
        stepId: string;
      }
    | {
        action: 'tour-closed';
        surfaceId: string;
        tourId: string;
        generation: number;
      },
  paths: RuntimePaths,
  dependencies: Pick<
    PrReviewTourServiceDependencies,
    'now' | 'publishEvent' | 'readReview' | 'readSurface'
  > = {},
) {
  const tour = findTourForPresentation(event.tourId, paths);
  if (!tour || tour.generation !== event.generation) return false;
  if (
    event.action === 'tour-activated' &&
    !tour.steps.some((step) => step.id === event.stepId)
  ) {
    return false;
  }
  const surface = (
    dependencies.readSurface ??
    ((surfaceId) => reviewSurfaceRegistry.read(surfaceId))
  )(event.surfaceId);
  const review = (dependencies.readReview ?? readPrReview)(
    tour.reviewId,
    paths,
  );
  const expectedSourceId = review
    ? `github-pr:${review.repoFullName.toLowerCase()}#${review.prNumber}`
    : null;
  const currentReviewRevisionKey = review
    ? reviewRevisionKey(
        resolvedReviewRevision({
          kind: 'git-commit',
          id: review.headSha,
          baseId: review.baseSha,
        }),
      )
    : null;
  if (
    !surface ||
    !review ||
    review.headSha !== tour.headSha ||
    currentReviewRevisionKey !== tour.revisionKey ||
    surface.source.kind !== 'github-pr' ||
    surface.source.id !== expectedSourceId ||
    !surface.source.repository.repoFullName ||
    surface.source.repository.repoFullName.toLowerCase() !==
      tour.repoFullName.toLowerCase() ||
    reviewRevisionKey(surface.source.revision) !== tour.revisionKey
  ) {
    return false;
  }
  (dependencies.publishEvent ?? publishReviewTourEvent)({
    ...event,
    id: randomUUID(),
    changedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
  } as ReviewTourChangeEvent);
  return true;
}

function findTourForPresentation(tourId: string, paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT conversation_id FROM pr_review_tours WHERE id = ?;')
      .get(tourId) as { conversation_id: string } | undefined;
    return row ? readPrReviewTour(row.conversation_id, paths) : null;
  } finally {
    database.close();
  }
}

function validateBoundReview(
  review: PrReviewRecord | undefined,
  binding: { reviewId: string; headSha: string },
): { ok: true } | { ok: false; result: ReplacePrReviewTourResult } {
  if (!review) {
    return {
      ok: false,
      result: failure('The bound PR review is no longer available.', [
        'currentReview',
      ]),
    };
  }
  if (review.headSha !== binding.headSha) {
    return {
      ok: false,
      result: failure(
        'The reviewer conversation belongs to an older PR revision.',
        ['currentReviewRevision'],
      ),
    };
  }
  if (review.status !== 'ready') {
    return {
      ok: false,
      result: failure(
        'Guided tours can only be published while the bound PR review is ready.',
        ['readyReview'],
      ),
    };
  }
  return { ok: true };
}

function sameReviewRevision(left: PrReviewRecord, right: PrReviewRecord) {
  return (
    left.repoFullName === right.repoFullName &&
    left.prNumber === right.prNumber &&
    left.headSha === right.headSha &&
    left.baseSha === right.baseSha
  );
}

async function loadReviewFiles(review: PrReviewRecord, paths: RuntimePaths) {
  const result = await getGitHubPrFiles(
    {
      repo: review.repoFullName,
      prNumber: review.prNumber,
      headSha: review.headSha,
      baseSha: review.baseSha,
      baseRef: review.baseRef,
      patches: 'all',
      source: 'auto',
    },
    paths,
  );
  if (!result.ok) throw new Error(result.message);
  const data = asRecord(result.data);
  if (!data || !Array.isArray(data.files))
    throw new Error('PR files were not returned.');
  return data.files.filter(isReviewFile);
}

function isReviewFile(value: unknown): value is ReviewFile {
  const row = asRecord(value);
  return Boolean(
    row &&
    typeof row.path === 'string' &&
    (typeof row.patch === 'string' || row.patch === null) &&
    typeof row.binary === 'boolean' &&
    typeof row.truncated === 'boolean',
  );
}

function patchLineKeys(patch: string) {
  const keys = new Set<string>();
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split('\n')) {
    const hunk = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (!inHunk || line.startsWith('\\ No newline')) continue;
    if (line.startsWith(' ')) {
      keys.add(`deletions:${oldLine}`);
      keys.add(`additions:${newLine}`);
      oldLine += 1;
      newLine += 1;
    } else if (line.startsWith('-')) {
      keys.add(`deletions:${oldLine}`);
      oldLine += 1;
    } else if (line.startsWith('+')) {
      keys.add(`additions:${newLine}`);
      newLine += 1;
    }
  }
  return keys;
}

function duplicateValues(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
}

function failure(
  message: string,
  requires: string[],
): ReplacePrReviewTourResult {
  return {
    ok: false,
    action: 'replace_pr_tour',
    changed: false,
    message,
    requires,
  };
}

class TourBindingChangedError extends Error {
  constructor(readonly result: ReplacePrReviewTourResult) {
    super(result.message);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}
