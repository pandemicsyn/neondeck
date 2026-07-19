import { useEffect, useMemo, useState, useCallback } from 'react';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import {
  type AutopilotPreparedDiff,
  type DiffSummary,
  type KiloTaskRecord,
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
  useKiloTaskDiff,
  usePreparedDiffFilePatch,
  usePreparedDiffFiles,
  useRepoDiff,
  useRepoDiffFilePatch,
} from './queries';
import type { DiffFilePatch } from './types';
import { usePreparedFindingReview } from './use-prepared-finding-review';
import { DiffWorkerProvider, UnifiedPatchView } from './DiffViewer';
import {
  kiloResultReviewSource,
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
  diff: AutopilotPreparedDiff;
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

export function KiloTaskDiffReview({ task }: { task: KiloTaskRecord }) {
  const sourceIdentity = `${task.id}:${task.repoId ?? ''}:${task.worktreeId ?? ''}`;
  return <KiloTaskDiffReviewSurface key={sourceIdentity} task={task} />;
}

function KiloTaskDiffReviewSurface({ task }: { task: KiloTaskRecord }) {
  const queryClient = useQueryClient();
  const [activePath, setActivePath] = useState<string | null>(null);
  const [isApplyingRevision, setIsApplyingRevision] = useState(false);
  const [refreshOutcome, setRefreshOutcome] = useState<{
    status: 'preserved' | 'degraded' | 'failed';
    message: string;
  } | null>(null);
  const repoDiffQuery = useRepoDiff({
    repoId: task.repoId,
    worktreeId: task.worktreeId,
    enabled: Boolean(task.repoId && task.worktreeId),
  });
  const [appliedRepoData, setAppliedRepoData] = useState(repoDiffQuery.data);
  useEffect(() => {
    if (!appliedRepoData && repoDiffQuery.data) {
      setAppliedRepoData(repoDiffQuery.data);
    }
  }, [appliedRepoData, repoDiffQuery.data]);
  const kiloDiffQuery = useKiloTaskDiff(task.id);
  const repoMetadataFiles = useMemo(
    () => appliedRepoData?.files ?? [],
    [appliedRepoData?.files],
  );
  const fallbackFiles = useMemo(
    () => kiloSummaryFiles(kiloDiffQuery.data?.diff ?? task.diff),
    [kiloDiffQuery.data?.diff, task.diff],
  );
  const appliedRevisionKey = reviewRevisionKey(
    appliedRepoData?.revision ?? {
      state: 'unavailable',
      kind: 'worktree-diff',
      reason: 'Kilo worktree revision has not loaded.',
    },
  );
  const repoPatchQuery = useRepoDiffFilePatch({
    repoId: task.repoId,
    worktreeId: task.worktreeId,
    path: activePath,
    revisionKey: appliedRevisionKey,
  });
  const repoFiles = useMemo(
    () =>
      repoMetadataFiles.map((file) => {
        if (file.path !== activePath) return file;
        const patchFile = repoPatchQuery.data?.files?.find(
          (item) => item.path === file.path,
        );
        return patchFile ? { ...file, ...patchFile } : file;
      }),
    [activePath, repoMetadataFiles, repoPatchQuery.data?.files],
  );
  const files = useMemo(
    () => (repoFiles.length > 0 ? repoFiles : fallbackFiles),
    [fallbackFiles, repoFiles],
  );
  const summary =
    appliedRepoData?.diffSummary ??
    summaryFromKilo(kiloDiffQuery.data?.diff ?? task.diff);
  const source = useMemo(
    () =>
      kiloResultReviewSource(task, files, appliedRepoData?.revision, {
        loadingPaths:
          activePath && repoPatchQuery.isLoading
            ? new Set([activePath])
            : undefined,
        unavailablePaths:
          activePath && repoPatchQuery.error
            ? new Set([activePath])
            : undefined,
      }),
    [
      activePath,
      appliedRepoData?.revision,
      files,
      repoPatchQuery.error,
      repoPatchQuery.isLoading,
      task,
    ],
  );
  useEffect(() => {
    if (activePath && files.some((file) => file.path === activePath)) return;
    setActivePath(firstRenderablePath(files) ?? null);
  }, [activePath, files]);
  const findingReview = usePreparedFindingReview({
    activePath,
    files,
    onActivePathChange: setActivePath,
    source,
  });
  const latestRevisionKey = reviewRevisionKey(
    repoDiffQuery.data?.revision ?? source.revision,
  );
  const hasAvailableRevision = Boolean(
    source.capabilities.includes('refresh') &&
    appliedRevisionKey &&
    latestRevisionKey &&
    appliedRevisionKey !== latestRevisionKey,
  );
  const refreshSafety = useMemo(
    () =>
      evaluateReviewRefreshSafety({
        activeSelection: findingReview.refreshGuards.selectionActive,
        revisionConfirmationOpen:
          findingReview.refreshGuards.revisionConfirmationOpen,
        mutationPending:
          findingReview.refreshGuards.mutationPending || isApplyingRevision,
      }),
    [findingReview.refreshGuards, isApplyingRevision],
  );
  const applyAvailableRevision = useCallback(() => {
    const next = repoDiffQuery.data;
    if (!next || !hasAvailableRevision || isApplyingRevision) return;
    setIsApplyingRevision(true);
    const nextFiles = next.files ?? [];
    const nextSource = kiloResultReviewSource(task, nextFiles, next.revision);
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
    setAppliedRepoData(next);
    if (outcome.activePath) setActivePath(outcome.activePath);
    findingReview.applyRefreshTarget(outcome.target, nextSource);
    setRefreshOutcome({ status: outcome.status, message: outcome.message });
    setIsApplyingRevision(false);
  }, [
    activePath,
    hasAvailableRevision,
    findingReview,
    isApplyingRevision,
    repoDiffQuery.data,
    source.files,
    task,
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
          queryKey: diffViewerQueryKeys.repoDiff({
            repoId: task.repoId,
            worktreeId: task.worktreeId,
          }),
        });
      }),
    [queryClient, source, task.repoId, task.worktreeId],
  );
  const refreshStatus = createReviewRefreshStatus({
    appliedRevision: source.revision,
    availableRevision: hasAvailableRevision
      ? (repoDiffQuery.data?.revision ?? null)
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

  if (repoDiffQuery.isLoading && !appliedRepoData) {
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
    <>
      {hasAvailableRevision ? (
        <ReviewRefreshNotice
          availableLabel="The Kilo worktree changed. Existing approval and recovery state will stay in place."
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
      {!source.capabilities.includes('refresh') ? (
        <StaticReviewNotice label="This retained Kilo result is static; no revision-bound live refresh is available." />
      ) : null}
      <MultiFileView
        activePath={activePath}
        annotationsByPath={findingReview.annotationsByPath}
        detail={summary ? summaryLabel(summary) : task.cwd}
        emptyLabel="No Kilo changes to render."
        files={files}
        inspector={findingReview.inspector}
        inspectorLabel={findingReview.inspectorLabel}
        onActivePathChange={setActivePath}
        onReviewSurfaceFindingsChange={
          findingReview.onReviewSurfaceFindingsChange
        }
        onReviewSurfaceIdChange={findingReview.onReviewSurfaceIdChange}
        patchError={
          repoPatchQuery.error
            ? queryErrorMessage(repoPatchQuery.error)
            : repoDiffQuery.error
              ? queryErrorMessage(repoDiffQuery.error)
              : null
        }
        isLoadingPatch={Boolean(activePath) && repoPatchQuery.isLoading}
        refreshStatus={refreshStatus}
        source={source}
        renderAnnotation={findingReview.renderAnnotation}
        reviewMapByPath={findingReview.reviewMapByPath}
        selectedAnnotationId={findingReview.selectedAnnotationId}
        title={task.title}
        tone="violet"
      />
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

function StaticReviewNotice({ label }: { label: string }) {
  return (
    <p className="border-b border-line bg-field px-2 py-1 font-mono text-[10px] text-muted">
      {label}
    </p>
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
