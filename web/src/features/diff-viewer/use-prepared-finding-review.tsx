import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import type { NeonReviewFinding } from '../../../../shared/review-finding';
import {
  createReviewNavigationModel,
  reviewCursorTargets,
  type ReviewCursorTarget,
} from '../../../../shared/review-navigation';
import {
  reviewRevisionKey,
  type ReviewSourceSnapshot,
} from '../../../../shared/review-source';
import {
  dismissReviewSurfaceFindings,
  promoteReviewSurfaceFinding,
} from '../../api';
import { queryErrorMessage, queryKeys } from '../../lib/query';
import {
  PrReviewNeonFindingAnnotation,
  PrReviewNeonFindingsPanel,
} from '../pr-review/PrReviewNeonFinding';
import {
  annotationsFromNeonFindings,
  currentActiveNeonFindings,
  neonFindingAnnotationId,
  resolveNeonFindingAnchor,
} from '../pr-review/review-findings';
import { patchAnchorIndexesByPath } from '../pr-review/review-helpers';
import { prReviewMapByPath } from '../pr-review/review-view-model';
import { PreparedRevisionComposer } from './PreparedRevisionComposer';
import type { DiffFilePatch, DiffReviewAnnotation } from './types';

export function usePreparedFindingReview({
  activePath,
  files,
  onActivePathChange,
  source,
}: {
  activePath: string | null;
  files: DiffFilePatch[];
  onActivePathChange: (path: string) => void;
  source: ReviewSourceSnapshot;
}) {
  const queryClient = useQueryClient();
  const [surfaceId, setSurfaceId] = useState<string | null>(null);
  const [findings, setFindings] = useState<NeonReviewFinding[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<
    string | null
  >(null);
  const [revisionFinding, setRevisionFinding] =
    useState<NeonReviewFinding | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const revisionKey = reviewRevisionKey(source.revision);
  const promotionAvailable =
    source.capabilities.includes('request-revision') &&
    source.promotionTargets.some(
      (target) => target.destination === 'prepared-diff-revision',
    );
  const patchIndexes = useMemo(() => patchAnchorIndexesByPath(files), [files]);
  const filesByPath = useMemo(
    () => new Map(files.map((file) => [file.path, file])),
    [files],
  );
  const activeFindings = useMemo(
    () => currentActiveNeonFindings(findings, source.id, revisionKey),
    [findings, revisionKey, source.id],
  );
  const refreshProjection = useMemo(
    () =>
      preparedFindingRefreshProjection({
        files,
        findings,
        selectedAnnotationId,
        source,
      }),
    [files, findings, selectedAnnotationId, source],
  );
  const projectRefresh = useCallback(
    (nextSource: ReviewSourceSnapshot, nextFiles: DiffFilePatch[]) =>
      preparedFindingRefreshProjection({
        files: nextFiles,
        findings,
        selectedAnnotationId,
        source: nextSource,
      }),
    [findings, selectedAnnotationId],
  );
  const applyRefreshTarget = useCallback(
    (target: ReviewCursorTarget | null, nextSource: ReviewSourceSnapshot) => {
      setFindings((current) => findingsForMountedSource(current, nextSource));
      setSelectedAnnotationId(
        target?.kind === 'finding' ? neonFindingAnnotationId(target.id) : null,
      );
    },
    [],
  );
  const resolutionFor = useCallback(
    (finding: NeonReviewFinding) =>
      resolveNeonFindingAnchor(
        finding,
        filesByPath.get(finding.file),
        patchIndexes.get(finding.file),
        source.id,
        revisionKey,
      ),
    [filesByPath, patchIndexes, revisionKey, source.id],
  );
  const annotationsByPath = useMemo(
    () =>
      annotationsFromNeonFindings({
        files,
        findings,
        indexes: patchIndexes,
        revisionKey,
        sourceId: source.id,
      }),
    [files, findings, patchIndexes, revisionKey, source.id],
  );
  const reviewMapByPath = useMemo(
    () =>
      prReviewMapByPath({
        draft: null,
        files,
        findings: [],
        neonFindings: activeFindings,
        staleCommentIds: new Set(),
        unresolvedThreads: [],
      }),
    [activeFindings, files],
  );
  const dismissMutation = useMutation({
    mutationFn: (finding: NeonReviewFinding) => {
      if (!surfaceId || !revisionKey)
        throw new Error('Review surface is not ready.');
      return dismissReviewSurfaceFindings(surfaceId, {
        sourceId: source.id,
        revisionKey,
        findingIds: [finding.id],
        reason: `Dismissed locally from the ${source.kind === 'kilo-result' ? 'Kilo-result' : 'prepared-diff'} review surface.`,
      });
    },
    onError: (error) => setStatus(queryErrorMessage(error)),
    onSuccess: (result) => setStatus(result.message),
  });
  const promotionMutation = useMutation({
    mutationFn: ({
      finding,
      reason,
    }: {
      finding: NeonReviewFinding;
      reason: string;
    }) => {
      if (!promotionAvailable)
        throw new Error('This source keeps findings local-only.');
      if (!surfaceId || !revisionKey)
        throw new Error('Review surface is not ready.');
      const resolution = resolutionFor(finding);
      if (resolution.state !== 'anchored') throw new Error(resolution.reason);
      return promoteReviewSurfaceFinding(surfaceId, {
        sourceId: source.id,
        revisionKey,
        findingId: finding.id,
        requestId: createPromotionRequestId(),
        destination: 'prepared-diff-revision',
        anchor: {
          side: resolution.side,
          startLine: Math.min(
            resolution.selection.start,
            resolution.selection.end,
          ),
          endLine: Math.max(
            resolution.selection.start,
            resolution.selection.end,
          ),
        },
        confirm: true,
        reason,
      });
    },
    onError: (error) => setStatus(queryErrorMessage(error)),
    onSuccess: (result, variables) => {
      setStatus(result.message);
      setRevisionFinding((current) =>
        current?.id === variables.finding.id ? null : current,
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.autopilotState,
      });
    },
  });
  const promotionDisabledReason = useCallback(
    (finding: NeonReviewFinding) => {
      if (!promotionAvailable) return 'This source keeps findings local-only.';
      if (!surfaceId || !revisionKey)
        return 'The review surface is still connecting.';
      if (promotionMutation.isPending)
        return 'Another finding promotion is in progress.';
      if (revisionFinding)
        return 'Confirm or cancel the open revision request first.';
      const resolution = resolutionFor(finding);
      return resolution.state === 'anchored' ? null : resolution.reason;
    },
    [
      promotionAvailable,
      promotionMutation.isPending,
      resolutionFor,
      revisionFinding,
      revisionKey,
      surfaceId,
    ],
  );
  const actionsLocked = useCallback(
    (_findingId: string) =>
      promotionMutation.isPending || revisionFinding !== null,
    [promotionMutation.isPending, revisionFinding],
  );
  const isDismissing = useCallback(
    (findingId: string) =>
      dismissMutation.isPending && dismissMutation.variables?.id === findingId,
    [dismissMutation.isPending, dismissMutation.variables],
  );
  const isPromoting = useCallback(
    (findingId: string) =>
      promotionMutation.isPending &&
      promotionMutation.variables?.finding.id === findingId,
    [promotionMutation.isPending, promotionMutation.variables],
  );
  const openRevisionFinding = useCallback(
    (finding: NeonReviewFinding) => {
      if (
        !promotionAvailable ||
        promotionMutation.isPending ||
        dismissMutation.isPending ||
        revisionFinding
      ) {
        return;
      }
      setRevisionFinding(finding);
    },
    [
      dismissMutation.isPending,
      promotionAvailable,
      promotionMutation.isPending,
      revisionFinding,
    ],
  );
  const dismissFinding = useCallback(
    (finding: NeonReviewFinding) => {
      if (promotionMutation.isPending || revisionFinding) return;
      dismissMutation.mutate(finding);
    },
    [dismissMutation, promotionMutation.isPending, revisionFinding],
  );
  const selectFinding = useCallback(
    (finding: NeonReviewFinding) => {
      onActivePathChange(finding.file);
      setSelectedAnnotationId(neonFindingAnnotationId(finding.id));
    },
    [onActivePathChange],
  );
  const promotionProps = promotionAvailable
    ? {
        onPromote: openRevisionFinding,
        promoteLabel: 'Request prepared revision',
        promotionDisabledReason,
      }
    : {};
  const inspector = (
    <div className="pr-review-inspector">
      <section className="pr-review-inspector-section">
        <div className="pr-review-inspector-heading">
          <span>Neon findings</span>
          <span>{activeFindings.length} active</span>
        </div>
        <p className="pr-review-inspector-copy">
          {promotionAvailable
            ? 'Findings stay local. Promotion creates a prepared revision request; the existing authority and execution steps remain separate.'
            : 'This source does not support prepared revision requests. Findings remain local-only.'}
        </p>
      </section>
      <PrReviewNeonFindingsPanel
        actionsLocked={actionsLocked}
        activePath={activePath}
        findings={findings}
        isDismissing={isDismissing}
        isPromoting={isPromoting}
        onDismiss={dismissFinding}
        onSelect={selectFinding}
        resolutionFor={resolutionFor}
        selectedAnnotationId={selectedAnnotationId}
        {...promotionProps}
      />
      {revisionFinding ? (
        <PreparedRevisionComposer
          actionLabel="Request revision"
          defaultReason={findingReason(revisionFinding)}
          description="Confirm a prepared revision request. This records the request only; it does not run or apply a revision."
          isPending={promotionMutation.isPending}
          key={revisionFinding.id}
          onCancel={() => setRevisionFinding(null)}
          onConfirm={({ reason }) => {
            if (!promotionMutation.isPending) {
              promotionMutation.mutate({ finding: revisionFinding, reason });
            }
          }}
          requireReason
          showRunNow={false}
        />
      ) : null}
      {status ? (
        <output
          aria-live="polite"
          className="block px-2 py-1.5 text-[10px] leading-4 text-muted"
        >
          {status}
        </output>
      ) : null}
    </div>
  );
  const renderAnnotation = (annotation: DiffReviewAnnotation) => {
    const finding = annotation.metadata.finding;
    return finding ? (
      <PrReviewNeonFindingAnnotation
        actionsLocked={actionsLocked(finding.id)}
        compact
        finding={finding}
        isDismissing={isDismissing(finding.id)}
        isPromoting={isPromoting(finding.id)}
        onDismiss={dismissFinding}
        selected={selectedAnnotationId === annotation.metadata.id}
        {...(promotionAvailable
          ? {
              onPromote: openRevisionFinding,
              promoteLabel: 'Request prepared revision',
              promotionDisabledReason: promotionDisabledReason(finding),
            }
          : {})}
      />
    ) : null;
  };

  return {
    annotationsByPath,
    inspector,
    inspectorLabel:
      source.kind === 'kilo-result'
        ? 'Kilo-result findings'
        : 'Prepared-diff findings',
    onReviewSurfaceFindingsChange: (
      _surfaceId: string,
      nextFindings: NeonReviewFinding[],
    ) => setFindings(nextFindings),
    onReviewSurfaceIdChange: setSurfaceId,
    renderAnnotation,
    reviewMapByPath,
    selectedAnnotationId,
    refreshProjection,
    projectRefresh,
    applyRefreshTarget,
    refreshGuards: {
      mutationPending: dismissMutation.isPending || promotionMutation.isPending,
      revisionConfirmationOpen: revisionFinding !== null,
      selectionActive: selectedAnnotationId !== null,
    },
  };
}

export function preparedFindingRefreshProjection(input: {
  files: DiffFilePatch[];
  findings: NeonReviewFinding[];
  selectedAnnotationId: string | null;
  source: ReviewSourceSnapshot;
}) {
  const revisionKey = reviewRevisionKey(input.source.revision);
  const indexes = patchAnchorIndexesByPath(input.files);
  const filesByPath = new Map(input.files.map((file) => [file.path, file]));
  const current = currentActiveNeonFindings(
    input.findings,
    input.source.id,
    revisionKey,
  );
  const items = current.flatMap((finding) => {
    if (!filesByPath.has(finding.file)) return [];
    const resolution = resolveNeonFindingAnchor(
      finding,
      filesByPath.get(finding.file),
      indexes.get(finding.file),
      input.source.id,
      revisionKey,
    );
    return [
      {
        kind: 'finding' as const,
        id: finding.id,
        path: finding.file,
        line:
          resolution.state === 'anchored'
            ? resolution.lineNumber
            : finding.anchor.kind === 'line-range'
              ? finding.anchor.startLine
              : null,
        severity: finding.severity,
        summary: finding.title,
      },
    ];
  });
  const targets = reviewCursorTargets(
    createReviewNavigationModel({ files: input.source.files, items }),
    'finding',
  );
  const selectedFinding = current.find(
    (finding) =>
      neonFindingAnnotationId(finding.id) === input.selectedAnnotationId,
  );
  return {
    currentTargetKey:
      targets.find((target) => target.id === selectedFinding?.id)?.key ?? null,
    targets,
  };
}

function findingsForMountedSource(
  findings: NeonReviewFinding[],
  source: ReviewSourceSnapshot,
) {
  const revisionKey = reviewRevisionKey(source.revision);
  return findings.map((finding) =>
    finding.sourceId === source.id &&
    finding.revisionKey !== revisionKey &&
    finding.lifecycle.state === 'active'
      ? {
          ...finding,
          lifecycle: {
            ...finding.lifecycle,
            state: 'stale' as const,
            changedAt: new Date().toISOString(),
            reason: 'The review source advanced to a newer revision.',
          },
        }
      : finding,
  );
}

function findingReason(finding: NeonReviewFinding) {
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

function createPromotionRequestId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `finding-promotion:${crypto.randomUUID()}`
    : `finding-promotion:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}
