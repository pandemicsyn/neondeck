import { useEffect, useMemo, useState, useCallback } from 'react';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import {
  type PreparedDiffRecord,
  type LearningCandidate,
  type RepoEditEvent,
  openReviewSourceRevisionEventStream,
} from '../../api';
import { Badge, MiniEmpty } from '../../components/ui';
import { queryErrorMessage } from '../../lib/query';
import {
  firstRenderablePath,
  patchHasContent,
  splitUnifiedPatchFiles,
} from './helpers';
import { MultiFileView } from './MultiFileView';
import {
  diffViewerQueryKeys,
  usePreparedDiffFilePatch,
  usePreparedDiffFiles,
  useRepoDiff,
  useRepoDiffFilePatch,
} from './queries';
import { usePreparedFindingReview } from './use-prepared-finding-review';
import { DiffWorkerProvider, UnifiedPatchView } from './DiffViewer';
import {
  preparedDiffReviewSource,
  repoEditEventReviewSource,
  skillPatchReviewSource,
} from './review-source';
import {
  canExplicitlyApplyReviewRefresh,
  createReviewRefreshStatus,
  evaluateReviewRefreshSafety,
  reconcileReviewOrientation,
  reviewSourceRevisionEventMatches,
} from '../../../../shared/review-refresh';
import { reviewRevisionKey } from '../../../../shared/review-source';
import { ReviewRefreshNotice } from './ReviewRefreshNotice';

export function PreparedDiffReview({
  diff,
  externalRefreshGuard,
}: {
  diff: PreparedDiffRecord;
  externalRefreshGuard?: {
    mutationPending?: boolean;
    revisionConfirmationOpen?: boolean;
  };
}) {
  const queryClient = useQueryClient();
  const surroundingMutationCount = useIsMutating({
    mutationKey: ['prepared-diff', diff.id],
  });
  const filesQuery = usePreparedDiffFiles(diff.id);
  const [appliedData, setAppliedData] = useState(filesQuery.data);
  const [isApplyingRevision, setIsApplyingRevision] = useState(false);
  const [refreshOutcome, setRefreshOutcome] = useState<{
    status: 'preserved' | 'degraded' | 'failed';
    message: string;
  } | null>(null);
  useEffect(() => {
    if (!appliedData && filesQuery.data) setAppliedData(filesQuery.data);
  }, [appliedData, filesQuery.data]);
  const files = useMemo(() => appliedData?.files ?? [], [appliedData?.files]);
  const [activePath, setActivePath] = useState<string | null>(null);

  useEffect(() => {
    if (activePath && files.some((file) => file.path === activePath)) return;
    setActivePath(firstRenderablePath(files) ?? null);
  }, [activePath, files]);

  const appliedRevisionKey = reviewRevisionKey(
    appliedData?.revision ?? {
      state: 'unavailable',
      kind: 'worktree-diff',
      reason: 'Prepared revision has not loaded.',
    },
  );
  const filePatchQuery = usePreparedDiffFilePatch(
    diff.id,
    appliedRevisionKey,
    activePath,
  );
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
      preparedDiffReviewSource(diff, viewFiles, appliedData?.revision, {
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
      appliedData?.revision,
      viewFiles,
    ],
  );
  const findingReview = usePreparedFindingReview({
    activePath,
    files: viewFiles,
    onActivePathChange: setActivePath,
    source,
  });
  const latestRevisionKey = reviewRevisionKey(
    filesQuery.data?.revision ?? source.revision,
  );
  const hasAvailableRevision = Boolean(
    !filesQuery.error &&
    appliedRevisionKey &&
    latestRevisionKey &&
    appliedRevisionKey !== latestRevisionKey,
  );
  const refreshSafety = useMemo(
    () =>
      evaluateReviewRefreshSafety({
        activeSelection: findingReview.refreshGuards.selectionActive,
        revisionConfirmationOpen:
          findingReview.refreshGuards.revisionConfirmationOpen ||
          externalRefreshGuard?.revisionConfirmationOpen,
        mutationPending:
          findingReview.refreshGuards.mutationPending ||
          externalRefreshGuard?.mutationPending ||
          surroundingMutationCount > 0 ||
          isApplyingRevision,
      }),
    [
      externalRefreshGuard?.mutationPending,
      externalRefreshGuard?.revisionConfirmationOpen,
      findingReview.refreshGuards,
      isApplyingRevision,
      surroundingMutationCount,
    ],
  );
  const applyAvailableRevision = useCallback(() => {
    const next = filesQuery.data;
    if (
      filesQuery.error ||
      !next ||
      !hasAvailableRevision ||
      isApplyingRevision
    )
      return;
    setIsApplyingRevision(true);
    const nextFiles = next.files ?? [];
    const nextSource = preparedDiffReviewSource(diff, nextFiles, next.revision);
    const nextFindingProjection = findingReview.projectRefresh(
      nextSource,
      nextFiles,
    );
    const outcome = reconcileReviewOrientation({
      previousFiles: source.files,
      nextFiles: nextSource.files,
      previousOrder: source.files.map((file) => file.path),
      nextOrder: nextSource.files.map((file) => file.path),
      activePath,
      previousTargets: findingReview.refreshProjection.targets,
      nextTargets: nextFindingProjection.targets,
      currentTargetKey: findingReview.refreshProjection.currentTargetKey,
    });
    setAppliedData(next);
    if (outcome.activePath) setActivePath(outcome.activePath);
    findingReview.applyRefreshTarget(outcome.target, nextSource);
    setRefreshOutcome({ status: outcome.status, message: outcome.message });
    setIsApplyingRevision(false);
  }, [
    activePath,
    diff,
    filesQuery.data,
    filesQuery.error,
    findingReview,
    hasAvailableRevision,
    isApplyingRevision,
    source.files,
  ]);
  useEffect(() => {
    if (hasAvailableRevision && refreshSafety.safe) applyAvailableRevision();
  }, [applyAvailableRevision, hasAvailableRevision, refreshSafety.safe]);
  useEffect(
    () =>
      openReviewSourceRevisionEventStream((event) => {
        if (!reviewSourceRevisionEventMatches(source, event)) return;
        void queryClient.invalidateQueries({
          exact: true,
          queryKey: diffViewerQueryKeys.preparedDiffFiles(diff.id),
        });
      }),
    [diff.id, queryClient, source],
  );
  const refreshStatus = createReviewRefreshStatus({
    appliedRevision: source.revision,
    availableRevision: hasAvailableRevision
      ? (filesQuery.data?.revision ?? null)
      : null,
    safety: refreshSafety,
    state: isApplyingRevision
      ? 'applying'
      : hasAvailableRevision
        ? 'available'
        : 'current',
    preservation: refreshOutcome?.status ?? null,
    message: refreshOutcome?.message ?? null,
  });

  if (filesQuery.isLoading && !appliedData) {
    return <MiniEmpty label="Loading changed files." />;
  }

  if (filesQuery.error && !appliedData) {
    return (
      <MiniEmpty
        label={`Prepared diff unavailable: ${queryErrorMessage(filesQuery.error)}`}
      />
    );
  }

  return (
    <>
      {filesQuery.error ? (
        <MiniEmpty
          label={`Prepared diff refresh unavailable: ${queryErrorMessage(filesQuery.error)}`}
        />
      ) : null}
      {hasAvailableRevision ? (
        <ReviewRefreshNotice
          availableLabel="The prepared worktree changed. The approval and recovery context will remain open."
          disabled={!canExplicitlyApplyReviewRefresh(refreshSafety)}
          onApply={applyAvailableRevision}
          safety={refreshSafety}
        />
      ) : null}
      {refreshOutcome ? (
        <output aria-live="polite" className="review-refresh-result">
          {refreshOutcome.message}
        </output>
      ) : null}
      <MultiFileView
        activePath={activePath}
        annotationsByPath={findingReview.annotationsByPath}
        detail={`${diff.verificationStatus} verification - ${diff.pushApprovalStatus} push`}
        emptyLabel="No prepared-diff files."
        files={viewFiles}
        isLoadingPatch={Boolean(activePath) && filePatchQuery.isLoading}
        onActivePathChange={setActivePath}
        onReviewSurfaceFindingsChange={
          findingReview.onReviewSurfaceFindingsChange
        }
        onReviewSurfaceIdChange={findingReview.onReviewSurfaceIdChange}
        patchError={
          filePatchQuery.error ? queryErrorMessage(filePatchQuery.error) : null
        }
        refreshStatus={refreshStatus}
        source={source}
        inspector={findingReview.inspector}
        inspectorLabel={findingReview.inspectorLabel}
        renderAnnotation={findingReview.renderAnnotation}
        reviewMapByPath={findingReview.reviewMapByPath}
        selectedAnnotationId={findingReview.selectedAnnotationId}
        title={diff.title}
        tone="primary"
      />
    </>
  );
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
      <>
        <StaticReviewNotice label="This retained skill patch is static; no revision-bound live refresh is available." />
        <MultiFileView
          detail="Learning candidate patch"
          emptyLabel="No patch content available."
          files={files}
          source={source}
          title={title}
          tone="violet"
        />
      </>
    );
  }

  return (
    <>
      <StaticReviewNotice label="This retained skill patch is static; no revision-bound live refresh is available." />
      <DiffWorkerProvider>
        <UnifiedPatchView
          detail="Learning candidate patch"
          patch={patch}
          source={source}
          title={title}
          tone="violet"
        />
      </DiffWorkerProvider>
    </>
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
        <>
          <StaticReviewNotice label="This historical repo-edit patch is static; no live refresh is available." />
          <MultiFileView
            detail={event.reason ?? event.action}
            emptyLabel="No repo-edit patch available."
            files={storedFiles}
            source={source}
            title={`${event.repoId} - ${event.action}`}
            tone={event.status === 'failed' ? 'accent' : 'primary'}
          />
        </>
      );
    }

    return (
      <>
        <StaticReviewNotice label="This historical repo-edit patch is static; no live refresh is available." />
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
      </>
    );
  }

  return (
    <MiniEmpty label="No captured repo-edit patch is available for this historical event." />
  );
}

export type WorktreeDiffReviewState = {
  status: 'loading' | 'unavailable' | 'empty' | 'reviewable';
  revisionKey: string | null;
};

export function WorktreeDiffReview({
  repoId,
  worktreeId,
  base,
  title,
  detail,
  onReviewStateChange,
}: {
  repoId: string;
  worktreeId: string;
  base: string;
  title: string;
  detail?: string;
  onReviewStateChange?: (state: WorktreeDiffReviewState) => void;
}) {
  const [activePath, setActivePath] = useState<string | null>(null);
  const diffQuery = useRepoDiff({ repoId, worktreeId, base });
  const files = useMemo(() => diffQuery.data?.files ?? [], [diffQuery.data]);
  useEffect(() => {
    if (activePath && files.some((file) => file.path === activePath)) return;
    setActivePath(firstRenderablePath(files) ?? null);
  }, [activePath, files]);
  const revisionKey = reviewRevisionKey(
    diffQuery.data?.revision ?? {
      state: 'unavailable',
      kind: 'worktree-diff',
      reason: 'The managed worktree diff has not loaded.',
    },
  );
  const reviewState = useMemo<WorktreeDiffReviewState>(() => {
    if (diffQuery.isLoading) return { status: 'loading', revisionKey: null };
    if (diffQuery.error || !diffQuery.data?.ok || !revisionKey) {
      return { status: 'unavailable', revisionKey: null };
    }
    if (files.length === 0) return { status: 'empty', revisionKey: null };
    return { status: 'reviewable', revisionKey };
  }, [
    diffQuery.data?.ok,
    diffQuery.error,
    diffQuery.isLoading,
    files.length,
    revisionKey,
  ]);
  useEffect(() => {
    onReviewStateChange?.(reviewState);
  }, [onReviewStateChange, reviewState]);
  const patchQuery = useRepoDiffFilePatch({
    repoId,
    worktreeId,
    base,
    path: activePath,
    revisionKey,
  });
  const renderedFiles = useMemo(
    () =>
      files.map((file) => {
        if (file.path !== activePath) return file;
        const patch = patchQuery.data?.files?.find(
          (candidate) => candidate.path === file.path,
        );
        return patch ? { ...file, ...patch } : file;
      }),
    [activePath, files, patchQuery.data?.files],
  );

  if (diffQuery.isLoading) return <MiniEmpty label="Loading Autopilot diff." />;
  if (diffQuery.error) {
    return (
      <MiniEmpty
        label={`Autopilot diff unavailable: ${queryErrorMessage(diffQuery.error)}`}
      />
    );
  }
  if (!diffQuery.data?.ok) {
    return (
      <MiniEmpty
        label={`Autopilot diff unavailable: ${diffQuery.data?.message ?? 'The current revision could not be loaded.'}`}
      />
    );
  }
  return (
    <MultiFileView
      activePath={activePath}
      detail={detail ?? 'Committed change held in the managed worktree'}
      emptyLabel="No managed worktree changes to render."
      files={renderedFiles}
      isLoadingPatch={Boolean(activePath) && patchQuery.isLoading}
      onActivePathChange={setActivePath}
      patchError={patchQuery.error ? queryErrorMessage(patchQuery.error) : null}
      title={title}
      tone="primary"
    />
  );
}

function StaticReviewNotice({ label }: { label: string }) {
  return (
    <p className="border-b border-line bg-field px-2 py-1 font-mono text-[10px] text-muted">
      {label}
    </p>
  );
}
