import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { NeonReviewFinding } from '../../../../shared/review-finding';
import { reviewRevisionKey } from '../../../../shared/review-source';
import {
  dismissReviewSurfaceFindings,
  promoteReviewSurfaceFinding,
  type AutopilotPreparedDiff,
  type DiffSummary,
  type KiloTaskRecord,
  type LearningCandidate,
  type RepoEditEvent,
} from '../../api';
import { Badge, MiniEmpty } from '../../components/ui';
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
import {
  firstRenderablePath,
  patchHasContent,
  splitUnifiedPatchFiles,
} from './helpers';
import { MultiFileView } from './MultiFileView';
import { PreparedRevisionComposer } from './PreparedRevisionComposer';
import {
  useKiloTaskDiff,
  usePreparedDiffFilePatch,
  usePreparedDiffFiles,
  useRepoDiff,
} from './queries';
import type { DiffFilePatch } from './types';
import { DiffWorkerProvider, UnifiedPatchView } from './DiffViewer';
import {
  kiloResultReviewSource,
  preparedDiffReviewSource,
  repoEditEventReviewSource,
  skillPatchReviewSource,
} from './review-source';

export function PreparedDiffReview({ diff }: { diff: AutopilotPreparedDiff }) {
  const queryClient = useQueryClient();
  const filesQuery = usePreparedDiffFiles(diff.id);
  const files = useMemo(
    () => filesQuery.data?.files ?? [],
    [filesQuery.data?.files],
  );
  const [activePath, setActivePath] = useState<string | null>(null);
  const [surfaceId, setSurfaceId] = useState<string | null>(null);
  const [findings, setFindings] = useState<NeonReviewFinding[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<
    string | null
  >(null);
  const [revisionFinding, setRevisionFinding] =
    useState<NeonReviewFinding | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (activePath && files.some((file) => file.path === activePath)) return;
    setActivePath(firstRenderablePath(files) ?? null);
  }, [activePath, files]);

  const filePatchQuery = usePreparedDiffFilePatch(diff.id, activePath);
  const activePatch =
    filePatchQuery.data?.diff ?? filePatchQuery.data?.file?.patch;
  const viewFiles = useMemo(
    () =>
      files.map((file) =>
        file.path === activePath
          ? {
              ...file,
              message: filePatchQuery.data?.message,
              patch: activePatch ?? null,
              truncated: filePatchQuery.data?.file?.truncated ?? file.truncated,
            }
          : file,
      ),
    [
      activePatch,
      activePath,
      filePatchQuery.data?.file?.truncated,
      filePatchQuery.data?.message,
      files,
    ],
  );
  const source = useMemo(
    () =>
      preparedDiffReviewSource(diff, viewFiles, filesQuery.data?.revision, {
        loadingPaths:
          activePath && filePatchQuery.isLoading
            ? new Set([activePath])
            : undefined,
        unavailablePaths:
          activePath && filePatchQuery.error
            ? new Set([activePath])
            : undefined,
      }),
    [
      activePath,
      diff,
      filePatchQuery.error,
      filePatchQuery.isLoading,
      filesQuery.data?.revision,
      viewFiles,
    ],
  );
  const revisionKey = reviewRevisionKey(source.revision);
  const patchIndexes = useMemo(
    () => patchAnchorIndexesByPath(viewFiles),
    [viewFiles],
  );
  const filesByPath = useMemo(
    () => new Map(viewFiles.map((file) => [file.path, file])),
    [viewFiles],
  );
  const activeFindings = useMemo(
    () => currentActiveNeonFindings(findings, source.id, revisionKey),
    [findings, revisionKey, source.id],
  );
  const resolutionFor = (finding: NeonReviewFinding) =>
    resolveNeonFindingAnchor(
      finding,
      filesByPath.get(finding.file),
      patchIndexes.get(finding.file),
      source.id,
      revisionKey,
    );
  const annotationsByPath = useMemo(
    () =>
      annotationsFromNeonFindings({
        files: viewFiles,
        findings,
        indexes: patchIndexes,
        revisionKey,
        sourceId: source.id,
      }),
    [findings, patchIndexes, revisionKey, source.id, viewFiles],
  );
  const reviewMapByPath = useMemo(
    () =>
      prReviewMapByPath({
        draft: null,
        files: viewFiles,
        findings: [],
        neonFindings: activeFindings,
        staleCommentIds: new Set(),
        unresolvedThreads: [],
      }),
    [activeFindings, viewFiles],
  );
  const dismissMutation = useMutation({
    mutationFn: (finding: NeonReviewFinding) => {
      if (!surfaceId || !revisionKey)
        throw new Error('Review surface is not ready.');
      return dismissReviewSurfaceFindings(surfaceId, {
        sourceId: source.id,
        revisionKey,
        findingIds: [finding.id],
        reason: 'Dismissed locally from the prepared-diff review surface.',
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
    onSuccess: (result) => {
      setStatus(result.message);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.autopilotState,
      });
    },
  });
  const promotionDisabledReason = (finding: NeonReviewFinding) => {
    if (!surfaceId || !revisionKey)
      return 'The review surface is still connecting.';
    const resolution = resolutionFor(finding);
    return resolution.state === 'anchored' ? null : resolution.reason;
  };
  const inspector = (
    <div className="pr-review-inspector">
      <section className="pr-review-inspector-section">
        <div className="pr-review-inspector-heading">
          <span>Neon findings</span>
          <span>{activeFindings.length} active</span>
        </div>
        <p className="pr-review-inspector-copy">
          Findings stay local. Promotion creates a prepared revision request;
          the existing authority and execution steps remain separate.
        </p>
      </section>
      <PrReviewNeonFindingsPanel
        activePath={activePath}
        findings={findings}
        isDismissing={(findingId) =>
          dismissMutation.isPending &&
          dismissMutation.variables?.id === findingId
        }
        isPromoting={(findingId) =>
          promotionMutation.isPending &&
          promotionMutation.variables?.finding.id === findingId
        }
        onDismiss={(finding) => dismissMutation.mutate(finding)}
        onPromote={setRevisionFinding}
        onSelect={(finding) => {
          setActivePath(finding.file);
          setSelectedAnnotationId(neonFindingAnnotationId(finding.id));
        }}
        promoteLabel="Request prepared revision"
        promotionDisabledReason={promotionDisabledReason}
        resolutionFor={resolutionFor}
        selectedAnnotationId={selectedAnnotationId}
      />
      {revisionFinding ? (
        <PreparedRevisionComposer
          actionLabel="Request revision"
          defaultReason={findingReason(revisionFinding)}
          description="Confirm a prepared revision request. This records the request only; it does not run or apply a revision."
          isPending={promotionMutation.isPending}
          onCancel={() => setRevisionFinding(null)}
          onConfirm={({ reason }) => {
            promotionMutation.mutate({ finding: revisionFinding, reason });
            setRevisionFinding(null);
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

  if (filesQuery.isLoading) {
    return <MiniEmpty label="Loading changed files." />;
  }

  if (filesQuery.error) {
    return (
      <MiniEmpty
        label={`Prepared diff unavailable: ${queryErrorMessage(filesQuery.error)}`}
      />
    );
  }

  return (
    <MultiFileView
      activePath={activePath}
      annotationsByPath={annotationsByPath}
      detail={`${diff.verificationStatus} verification - ${diff.pushApprovalStatus} push`}
      emptyLabel="No prepared-diff files."
      files={viewFiles}
      isLoadingPatch={Boolean(activePath) && filePatchQuery.isLoading}
      onActivePathChange={setActivePath}
      onReviewSurfaceFindingsChange={(_surfaceId, nextFindings) =>
        setFindings(nextFindings)
      }
      onReviewSurfaceIdChange={setSurfaceId}
      patchError={
        filePatchQuery.error ? queryErrorMessage(filePatchQuery.error) : null
      }
      source={source}
      inspector={inspector}
      inspectorLabel="Prepared-diff findings"
      renderAnnotation={(annotation) => {
        const finding = annotation.metadata.finding;
        return finding ? (
          <PrReviewNeonFindingAnnotation
            compact
            finding={finding}
            isDismissing={
              dismissMutation.isPending &&
              dismissMutation.variables?.id === finding.id
            }
            isPromoting={
              promotionMutation.isPending &&
              promotionMutation.variables?.finding.id === finding.id
            }
            onDismiss={(item) => dismissMutation.mutate(item)}
            onPromote={setRevisionFinding}
            promoteLabel="Request prepared revision"
            promotionDisabledReason={promotionDisabledReason(finding)}
            selected={selectedAnnotationId === annotation.metadata.id}
          />
        ) : null;
      }}
      reviewMapByPath={reviewMapByPath}
      selectedAnnotationId={selectedAnnotationId}
      title={diff.title}
      tone="primary"
    />
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

export function SkillPatchDiffReview({
  afterHash,
  candidate,
  patch,
  title = 'Skill patch',
}: {
  afterHash?: string | null;
  candidate: Pick<LearningCandidate, 'id' | 'repoId' | 'skillId'>;
  patch: string | null | undefined;
  title?: string;
}) {
  const files = useMemo(() => splitUnifiedPatchFiles(patch), [patch]);
  const source = useMemo(
    () => skillPatchReviewSource(candidate, files, afterHash, title),
    [afterHash, candidate, files, title],
  );

  if (files.length > 1) {
    return (
      <MultiFileView
        detail="Learning candidate patch"
        emptyLabel="No patch content available."
        files={files}
        source={source}
        title={title}
        tone="violet"
      />
    );
  }

  return (
    <DiffWorkerProvider>
      <UnifiedPatchView
        detail="Learning candidate patch"
        patch={patch}
        source={source}
        title={title}
        tone="violet"
      />
    </DiffWorkerProvider>
  );
}

export function KiloTaskDiffReview({ task }: { task: KiloTaskRecord }) {
  const repoDiffQuery = useRepoDiff({
    repoId: task.repoId,
    worktreeId: task.worktreeId,
    enabled: Boolean(task.repoId),
  });
  const kiloDiffQuery = useKiloTaskDiff(task.id);
  const repoFiles = useMemo(
    () => repoDiffQuery.data?.files ?? [],
    [repoDiffQuery.data?.files],
  );
  const fallbackFiles = useMemo(
    () => kiloSummaryFiles(kiloDiffQuery.data?.diff ?? task.diff),
    [kiloDiffQuery.data?.diff, task.diff],
  );
  const files = useMemo(
    () => (repoFiles.length > 0 ? repoFiles : fallbackFiles),
    [fallbackFiles, repoFiles],
  );
  const summary =
    repoDiffQuery.data?.diffSummary ??
    summaryFromKilo(kiloDiffQuery.data?.diff ?? task.diff);
  const source = useMemo(
    () => kiloResultReviewSource(task, files, repoDiffQuery.data?.revision),
    [files, repoDiffQuery.data?.revision, task],
  );

  if (repoDiffQuery.isLoading) {
    return <MiniEmpty label="Loading Kilo diff." />;
  }

  if (repoDiffQuery.error && files.length === 0) {
    return (
      <MiniEmpty
        label={`Kilo diff unavailable: ${queryErrorMessage(repoDiffQuery.error)}`}
      />
    );
  }

  return (
    <MultiFileView
      detail={summary ? summaryLabel(summary) : task.cwd}
      emptyLabel="No Kilo changes to render."
      files={files}
      patchError={
        repoDiffQuery.error ? queryErrorMessage(repoDiffQuery.error) : null
      }
      source={source}
      title={task.title}
      tone="violet"
    />
  );
}

export function RepoEditEventDiffReview({ event }: { event: RepoEditEvent }) {
  const hasStoredPatch = patchHasContent(event.diffPatch);
  const storedFiles = useMemo(
    () => splitUnifiedPatchFiles(event.diffPatch),
    [event.diffPatch],
  );
  const source = useMemo(
    () => repoEditEventReviewSource(event, storedFiles),
    [event, storedFiles],
  );

  if (hasStoredPatch) {
    if (storedFiles.length > 1) {
      return (
        <MultiFileView
          detail={event.reason ?? event.action}
          emptyLabel="No repo-edit patch available."
          files={storedFiles}
          source={source}
          title={`${event.repoId} - ${event.action}`}
          tone={event.status === 'failed' ? 'accent' : 'primary'}
        />
      );
    }

    return (
      <DiffWorkerProvider>
        <UnifiedPatchView
          detail={event.reason ?? event.action}
          meta={<Badge>{event.status}</Badge>}
          patch={event.diffPatch}
          source={source}
          title={`${event.repoId} - ${event.action}`}
          tone={event.status === 'failed' ? 'accent' : 'primary'}
        />
      </DiffWorkerProvider>
    );
  }

  return (
    <MiniEmpty label="No captured repo-edit patch is available for this historical event." />
  );
}

function kiloSummaryFiles(
  diff: KiloTaskRecord['diff'] | undefined,
): DiffFilePatch[] {
  if (!diff?.ok) return [];
  return diff.files.map((file) => ({
    ...file,
    binary: false,
    generatedLike: false,
    message: 'The Kilo diff route returned summary metadata only.',
    patch: null,
  }));
}

function summaryFromKilo(
  diff: KiloTaskRecord['diff'] | undefined,
): DiffSummary | null {
  if (!diff?.ok) return null;
  return {
    additions: diff.additions,
    binaryFiles: diff.binaryFiles,
    deletions: diff.deletions,
    files: diff.fileCount,
  };
}

function summaryLabel(summary: DiffSummary) {
  return `${summary.files} files - +${summary.additions} -${summary.deletions} - ${summary.binaryFiles} binary`;
}
