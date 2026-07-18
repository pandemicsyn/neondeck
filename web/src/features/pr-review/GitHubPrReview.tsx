import type { SelectedLineRange } from '@pierre/diffs/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  reconcileReviewCursor,
  reviewCursorTargets,
  type ReviewCursorDirection,
  type ReviewCursorKind,
  type ReviewCursorTarget,
} from '../../../../shared/review-navigation';
import { reviewRevisionKey } from '../../../../shared/review-source';
import type { NeonReviewFinding } from '../../../../shared/review-finding';
import {
  dismissReviewSurfaceFindings,
  type GitHubPrReviewDraftComment,
  type GitHubPrReviewVerdict,
  type GitHubPullRequest,
  type PrReviewReportOnlyFinding,
} from '../../api';
import { Badge, MiniEmpty } from '../../components/ui';
import { queryErrorMessage } from '../../lib/query';
import { firstRenderablePath, patchHasContent } from '../diff-viewer/helpers';
import type { DiffFilePatch, DiffReviewAnnotation } from '../diff-viewer/types';
import { githubPrReviewSource } from '../diff-viewer/review-source';
import { PrReviewCommentComposer } from './PrReviewCommentComposer';
import { PrReviewDiffPane } from './PrReviewDiffPane';
import { PrReviewNavigationBar } from './PrReviewNavigationBar';
import { PrReviewNeonFindingAnnotation } from './PrReviewNeonFinding';
import { reportOnlyFindingBody } from './PrReviewFindingsSidebar';
import { PrReviewSubmitBar } from './PrReviewSubmitBar';
import {
  useGitHubPrReviewDraft,
  useGitHubPrReviewMutations,
  useGitHubPrReviewThreads,
  useGitHubPullRequestFileList,
  useGitHubPullRequestFilePatches,
} from './queries';
import {
  commentAnchorExists,
  commentInputFromSelection,
  failingCommentIdsFromError,
  normalizeReviewBody,
  patchAnchorIndexesByPath,
  staleDraftCommentIds,
} from './review-helpers';
import {
  annotationFromSelection,
  annotationsFromComposer,
  annotationsFromDraft,
  annotationsFromThreads,
  backgroundReviewPatchPaths,
  checkBadgeClass,
  checkLabel,
  draftCommentIdsWithUnknownPatch,
  firstReviewablePath,
  mergeAnnotations,
  mergePatchResults,
  mutationErrorMessage,
  prDetail,
  prReviewMapByPath,
  reviewFileStats,
  reviewPatchQuerySettled,
  summaryLabel,
} from './review-view-model';
import {
  clearCompletedEditor,
  isCurrentReviewOperation,
} from './review-ui-helpers';
import { usePrReviewRecord } from './usePrReviewRecord';
import {
  createImperativeReviewPathJump,
  createPrReviewNavigationData,
  moveReviewCursorFromPath,
  resolveHunkTraversal,
  reviewNavigationAnnouncement,
  reviewNavigationKindLabel,
  reviewNavigationPublication,
  reviewNavigationPublicationMatches,
  selectedReviewContext,
  type ReviewNavigationAuthority,
  type ReviewNavigationSelection,
  type ReviewPatchNavigationState,
} from './review-navigation';
import {
  annotationsFromNeonFindings,
  currentActiveNeonFindings,
  resolveNeonFindingAnchor,
  type NeonFindingAnchorResolution,
} from './review-findings';

type ComposerState = {
  body: string;
  path: string;
  selection: SelectedLineRange;
  annotation: DiffReviewAnnotation;
  sourceFindingId: string | null;
  token: number;
};

type CommentEditorState = {
  body: string;
  commentId: string;
  token: number;
};

type ReplyEditorState = {
  body: string;
  threadId: string;
  token: number;
};

type GitHubPrReviewMode = 'embedded' | 'standalone';

type PendingHunkNavigation = {
  direction: ReviewCursorDirection;
  remainingLoads: number;
};

const maxLazyHunkLoadsPerMove = 8;

export function GitHubPrReview({
  mode = 'embedded',
  pr,
  reviewThreadsActivityVersion,
}: {
  mode?: GitHubPrReviewMode;
  pr: GitHubPullRequest;
  reviewThreadsActivityVersion?: string | null;
}) {
  const filesQuery = useGitHubPullRequestFileList(pr);
  const threadsQuery = useGitHubPrReviewThreads(
    pr,
    reviewThreadsActivityVersion === undefined
      ? pr.updatedAt
      : reviewThreadsActivityVersion,
  );
  const draftQuery = useGitHubPrReviewDraft(pr);
  const mutations = useGitHubPrReviewMutations(pr);
  const {
    isDurableReviewReady,
    query: reviewRecordQuery,
    reconcileSubmission,
    restart: restartReview,
    review: reviewRecord,
    start: startReview,
  } = usePrReviewRecord(pr);
  const nextEditorToken = useRef(0);
  const nextOperationToken = useRef(0);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [commentEditor, setCommentEditor] = useState<CommentEditorState | null>(
    null,
  );
  const [replyEditor, setReplyEditor] = useState<ReplyEditorState | null>(null);
  const [reviewBody, setReviewBody] = useState('');
  const [isReviewBodyFocused, setIsReviewBodyFocused] = useState(false);
  const [hasPendingReviewBodyEdit, setHasPendingReviewBodyEdit] =
    useState(false);
  const [seededDraftId, setSeededDraftId] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<GitHubPrReviewVerdict>('comment');
  const [reanchoringCommentId, setReanchoringCommentId] = useState<
    string | null
  >(null);
  const [anchoringFinding, setAnchoringFinding] =
    useState<PrReviewReportOnlyFinding | null>(null);
  const [submitFailedCommentIds, setSubmitFailedCommentIds] = useState<
    Set<string>
  >(() => new Set());
  const [statusMessage, setStatusMessageState] = useState<string | null>(null);
  const [reviewSurfaceId, setReviewSurfaceId] = useState<string | null>(null);
  const [neonFindings, setNeonFindings] = useState<NeonReviewFinding[]>([]);
  const [dismissingFindingIds, setDismissingFindingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [navigationKind, setNavigationKind] =
    useState<ReviewCursorKind>('file');
  const [navigationTargetKey, setNavigationTargetKey] = useState<string | null>(
    null,
  );
  const [navigationAuthority, setNavigationAuthority] =
    useState<ReviewNavigationAuthority>('automatic');
  const [navigationSelection, setNavigationSelection] =
    useState<ReviewNavigationSelection | null>(null);
  const [navigationAnnotationId, setNavigationAnnotationId] = useState<
    string | null
  >(null);
  const [navigationBoundary, setNavigationBoundary] = useState<
    'start' | 'end' | null
  >(null);
  const [navigationAnnouncement, setNavigationAnnouncement] = useState('');
  const [navigationStatus, setNavigationStatus] = useState<string | null>(null);
  const [fileFilter, setFileFilter] = useState<{
    paths: string[] | null;
    query: string | null;
  }>({ paths: null, query: null });
  const [pendingHunkNavigation, setPendingHunkNavigation] =
    useState<PendingHunkNavigation | null>(null);
  const createEditorToken = () => {
    nextEditorToken.current += 1;
    return nextEditorToken.current;
  };
  const beginOperation = () => {
    nextOperationToken.current += 1;
    setStatusMessageState(null);
    return nextOperationToken.current;
  };
  const finishOperation = (token: number, message: string) => {
    if (isCurrentReviewOperation(nextOperationToken.current, token)) {
      setStatusMessageState(message);
    }
  };
  const failOperation = (token: number, error: unknown) => {
    if (!isCurrentReviewOperation(nextOperationToken.current, token)) return;
    setStatusMessageState(
      mutationErrorMessage(error, draft) ?? 'The operation failed.',
    );
  };
  const setStatusMessage = (message: string | null) => {
    nextOperationToken.current += 1;
    setStatusMessageState(message);
  };
  const fileList = useMemo(
    () => (filesQuery.data?.files ?? []) as DiffFilePatch[],
    [filesQuery.data?.files],
  );
  const reviewThreads = useMemo(
    () => threadsQuery.data?.reviewThreads ?? [],
    [threadsQuery.data?.reviewThreads],
  );
  const unresolvedThreads = useMemo(
    () => threadsQuery.data?.unresolvedReviewThreads ?? [],
    [threadsQuery.data?.unresolvedReviewThreads],
  );
  const draft = draftQuery.data ?? null;
  const isStandalone = mode === 'standalone';
  const activePatchPaths = useMemo(
    () => (activePath ? [activePath] : []),
    [activePath],
  );
  const activePatchQueries = useGitHubPullRequestFilePatches(
    pr,
    activePatchPaths,
  );
  const activePatchQuery = activePath
    ? activePatchQueries.byPath.get(activePath)
    : undefined;
  const backgroundPatchCandidates = useMemo(
    () =>
      backgroundReviewPatchPaths({
        activePath,
        draft,
        files: fileList,
        unresolvedThreads,
      }),
    [activePath, draft, fileList, unresolvedThreads],
  );
  const shouldLoadBackgroundPatches =
    !pendingHunkNavigation && reviewPatchQuerySettled(activePatchQuery);
  const backgroundPatchPaths = useMemo(
    () => (shouldLoadBackgroundPatches ? backgroundPatchCandidates : []),
    [backgroundPatchCandidates, shouldLoadBackgroundPatches],
  );
  const deferredPatchPaths = useMemo(
    () =>
      shouldLoadBackgroundPatches
        ? new Set<string>()
        : new Set(backgroundPatchCandidates),
    [backgroundPatchCandidates, shouldLoadBackgroundPatches],
  );
  const backgroundPatchQueries = useGitHubPullRequestFilePatches(
    pr,
    backgroundPatchPaths,
  );
  const patchQueryByPath = useMemo(
    () =>
      new Map([...backgroundPatchQueries.byPath, ...activePatchQueries.byPath]),
    [activePatchQueries.byPath, backgroundPatchQueries.byPath],
  );
  const files = useMemo(
    () => mergePatchResults(fileList, patchQueryByPath),
    [fileList, patchQueryByPath],
  );
  const currentHeadSha = pr.headSha ?? '';
  const patchIndexesByPath = useMemo(
    () => patchAnchorIndexesByPath(files),
    [files],
  );
  const filesByPath = useMemo(
    () => new Map(files.map((file) => [file.path, file])),
    [files],
  );
  const reviewSource = useMemo(
    () =>
      githubPrReviewSource(pr, files, {
        localSource: filesQuery.data?.source === 'local',
        loadingPaths:
          activePath && activePatchQuery?.isLoading
            ? new Set([activePath])
            : undefined,
        unavailablePaths:
          activePath && activePatchQuery?.isError
            ? new Set([activePath])
            : undefined,
      }),
    [
      activePatchQuery?.isError,
      activePatchQuery?.isLoading,
      activePath,
      files,
      filesQuery.data?.source,
      pr,
    ],
  );
  const currentReviewRevisionKey = reviewRevisionKey(reviewSource.revision);
  const activeNeonFindings = useMemo(
    () =>
      currentActiveNeonFindings(
        neonFindings,
        reviewSource.id,
        currentReviewRevisionKey,
      ),
    [currentReviewRevisionKey, neonFindings, reviewSource.id],
  );
  const neonFindingResolutions = useMemo(() => {
    const result = new Map<string, NeonFindingAnchorResolution>();
    for (const finding of neonFindings) {
      result.set(
        finding.id,
        resolveNeonFindingAnchor(
          finding,
          filesByPath.get(finding.file),
          patchIndexesByPath.get(finding.file),
          reviewSource.id,
          currentReviewRevisionKey,
        ),
      );
    }
    return result;
  }, [
    currentReviewRevisionKey,
    filesByPath,
    neonFindings,
    patchIndexesByPath,
    reviewSource.id,
  ]);
  const neonAnnotationsByPath = useMemo(
    () =>
      annotationsFromNeonFindings({
        files,
        findings: neonFindings,
        indexes: patchIndexesByPath,
        revisionKey: currentReviewRevisionKey,
        sourceId: reviewSource.id,
      }),
    [
      currentReviewRevisionKey,
      files,
      neonFindings,
      patchIndexesByPath,
      reviewSource.id,
    ],
  );
  const unknownDraftPatchCommentIds = useMemo(
    () =>
      draftCommentIdsWithUnknownPatch(
        draft,
        files,
        patchQueryByPath,
        deferredPatchPaths,
      ),
    [deferredPatchPaths, draft, files, patchQueryByPath],
  );
  const staleCommentIds = useMemo(() => {
    const stale = staleDraftCommentIds(draft, patchIndexesByPath);
    for (const commentId of unknownDraftPatchCommentIds)
      stale.delete(commentId);
    return stale;
  }, [draft, patchIndexesByPath, unknownDraftPatchCommentIds]);
  const blockedCommentIds = useMemo(
    () => new Set([...staleCommentIds, ...submitFailedCommentIds]),
    [staleCommentIds, submitFailedCommentIds],
  );
  const cleanCommentIds = useMemo(
    () =>
      draft?.comments
        .filter((comment) => !blockedCommentIds.has(comment.id))
        .map((comment) => comment.id) ?? [],
    [blockedCommentIds, draft],
  );
  const staleDraftComments = useMemo(
    () =>
      draft?.comments.filter((comment) => blockedCommentIds.has(comment.id)) ??
      [],
    [blockedCommentIds, draft],
  );
  const annotationsByPath = useMemo(
    () =>
      mergeAnnotations(
        annotationsFromThreads(reviewThreads, fileList),
        annotationsFromDraft(draft, blockedCommentIds, fileList),
        annotationsFromComposer(composer),
        neonAnnotationsByPath,
      ),
    [
      blockedCommentIds,
      composer,
      draft,
      fileList,
      neonAnnotationsByPath,
      reviewThreads,
    ],
  );
  const reviewMapByPath = useMemo(
    () =>
      prReviewMapByPath({
        draft,
        files: fileList,
        findings: reviewRecord?.reportOnlyFindings ?? [],
        neonFindings: activeNeonFindings,
        staleCommentIds,
        unresolvedThreads,
      }),
    [
      draft,
      fileList,
      reviewRecord?.reportOnlyFindings,
      activeNeonFindings,
      staleCommentIds,
      unresolvedThreads,
    ],
  );
  const navigationData = useMemo(
    () =>
      createPrReviewNavigationData({
        draft,
        files,
        findings: reviewRecord?.reportOnlyFindings ?? [],
        neonFindingResolutions,
        neonFindings,
        staleCommentIds,
        threads: reviewThreads,
      }),
    [
      draft,
      files,
      neonFindingResolutions,
      neonFindings,
      reviewRecord?.reportOnlyFindings,
      reviewThreads,
      staleCommentIds,
    ],
  );
  const navigationTargets = useMemo<ReviewCursorTarget[]>(() => {
    const options = {
      filter: fileFilter.paths ? { paths: fileFilter.paths } : undefined,
    };
    return navigationKind === 'attention'
      ? [...reviewCursorTargets(navigationData.model, 'attention', options)]
      : [...reviewCursorTargets(navigationData.model, navigationKind, options)];
  }, [fileFilter.paths, navigationData.model, navigationKind]);
  const selectedNavigationTarget =
    navigationTargets.find((target) => target.key === navigationTargetKey) ??
    null;
  const selectedContext = selectedReviewContext({
    activePath,
    composer: composer
      ? {
          annotationId: composer.annotation.metadata.id,
          path: composer.path,
          selection: composer.selection,
        }
      : null,
    navigationAuthority,
    navigationAnnotationId,
    navigationSelection,
  });
  const navigationCurrentIndex = selectedNavigationTarget
    ? navigationTargets.indexOf(selectedNavigationTarget)
    : -1;
  const patchNavigationState = useMemo(() => {
    const result = new Map<string, ReviewPatchNavigationState>();
    for (const file of files) {
      const query = patchQueryByPath.get(file.path);
      const state: ReviewPatchNavigationState = patchHasContent(file.patch)
        ? 'loaded'
        : file.binary || file.truncated || query?.isError || query?.hasData
          ? 'unavailable'
          : query?.isLoading
            ? 'loading'
            : 'unloaded';
      result.set(file.path, state);
    }
    return result;
  }, [files, patchQueryByPath]);
  const fileStats = useMemo(() => reviewFileStats(files), [files]);
  const isDraftMutationPending =
    mutations.saveDraft.isPending ||
    mutations.addComment.isPending ||
    mutations.updateComment.isPending ||
    mutations.deleteComment.isPending ||
    mutations.submitReview.isPending ||
    mutations.discardDraft.isPending;
  const isThreadMutationPending =
    mutations.replyToThread.isPending ||
    mutations.setThreadResolution.isPending;
  const reviewBarStatusMessage = statusMessage;
  const fileLoadMessage = filesQuery.isLoading
    ? 'Loading PR files.'
    : filesQuery.error
      ? `PR files unavailable: ${queryErrorMessage(filesQuery.error)}`
      : null;
  const patchErrorMessage = activePatchQuery?.error
    ? `Patch unavailable: ${queryErrorMessage(activePatchQuery.error)}`
    : null;
  const navigationFiles = useMemo(
    () =>
      fileFilter.paths
        ? files.filter((file) => fileFilter.paths?.includes(file.path))
        : files,
    [fileFilter.paths, files],
  );
  const jumpToReviewPath = useMemo(
    () =>
      createImperativeReviewPathJump({
        setActivePath,
        setNavigationAnnouncement,
        setNavigationAnnotationId,
        setNavigationAuthority,
        setNavigationBoundary,
        setNavigationSelection,
        setNavigationStatus,
        setNavigationTargetKey,
        setPendingHunkNavigation,
      }),
    [],
  );
  const selectPathFromWorkbench = useCallback(
    (path: string) => {
      jumpToReviewPath(path);
      setNavigationAnnouncement(`${path}, file selected from the file tree.`);
    },
    [jumpToReviewPath],
  );
  const handleFileFilterChange = useCallback(
    (query: string | null, paths: string[] | null) => {
      setFileFilter((current) => {
        if (current.query === query && sameStringArray(current.paths, paths)) {
          return current;
        }
        return { paths, query };
      });
    },
    [],
  );
  const handleReviewSurfaceIdChange = useCallback(
    (surfaceId: string | null) => {
      setReviewSurfaceId(surfaceId);
      if (!surfaceId) setNeonFindings([]);
    },
    [],
  );
  const handleReviewSurfaceFindingsChange = useCallback(
    (_surfaceId: string, findings: NeonReviewFinding[]) => {
      setNeonFindings(findings);
    },
    [],
  );
  const activateNavigationTarget = useCallback(
    (
      target: ReviewCursorTarget,
      targets: readonly ReviewCursorTarget[],
      status?: string | null,
      selectionAuthority: ReviewNavigationAuthority = 'explicit',
    ) => {
      const publication = reviewNavigationPublication(
        target,
        navigationData.anchors,
      );
      const index = targets.findIndex((item) => item.key === target.key);
      setActivePath(publication.activePath);
      setNavigationTargetKey(target.key);
      setNavigationAuthority(selectionAuthority);
      setNavigationSelection(publication.selection);
      setNavigationAnnotationId(publication.annotationId);
      setNavigationBoundary(null);
      setNavigationStatus(status ?? null);
      setNavigationAnnouncement(
        reviewNavigationAnnouncement(
          target,
          Math.max(0, index),
          targets.length,
          status,
        ),
      );
    },
    [navigationData.anchors],
  );
  const performHunkTraversal = useCallback(
    (direction: ReviewCursorDirection, remainingLoads: number) => {
      const result = resolveHunkTraversal({
        activePath,
        availability: patchNavigationState,
        currentKey: navigationTargetKey,
        direction,
        files: navigationFiles,
        targets: navigationTargets,
      });
      if (result.kind === 'target') {
        setPendingHunkNavigation(null);
        activateNavigationTarget(result.target, navigationTargets);
        return;
      }
      if (result.kind === 'load') {
        if (remainingLoads <= 0) {
          setPendingHunkNavigation(null);
          setNavigationStatus(
            `Paused after ${maxLazyHunkLoadsPerMove} lazy patch reads; activate ${direction} again to continue.`,
          );
          setNavigationAnnouncement(
            `${result.path}, hunk position unavailable, lazy traversal paused after ${maxLazyHunkLoadsPerMove} files.`,
          );
          return;
        }
        setActivePath(result.path);
        setNavigationTargetKey(null);
        setNavigationSelection(null);
        setNavigationAnnotationId(null);
        setNavigationBoundary(null);
        setNavigationStatus(
          `Loading hunks for ${result.path} · one patch request at a time.`,
        );
        setNavigationAnnouncement(
          `${result.path}, hunk position unavailable, loading patch one file at a time.`,
        );
        setPendingHunkNavigation({
          direction,
          remainingLoads: remainingLoads - 1,
        });
        return;
      }
      setPendingHunkNavigation(null);
      if (result.kind === 'empty') {
        setNavigationBoundary(null);
        setNavigationStatus('No hunk targets are available.');
        setNavigationAnnouncement('No hunk targets are available.');
        return;
      }
      setNavigationBoundary(result.boundary);
      const boundary = `${result.boundary} boundary`;
      setNavigationStatus(boundary);
      if (selectedNavigationTarget) {
        setNavigationAnnouncement(
          reviewNavigationAnnouncement(
            selectedNavigationTarget,
            navigationCurrentIndex,
            navigationTargets.length,
            boundary,
          ),
        );
      } else {
        setNavigationAnnouncement(
          `${activePath ?? 'Review'}, hunk position unavailable, ${boundary}.`,
        );
      }
    },
    [
      activePath,
      activateNavigationTarget,
      navigationCurrentIndex,
      navigationFiles,
      navigationTargetKey,
      navigationTargets,
      patchNavigationState,
      selectedNavigationTarget,
    ],
  );
  const navigateReview = useCallback(
    (direction: ReviewCursorDirection) => {
      if (pendingHunkNavigation) return;
      if (navigationKind === 'hunk') {
        setNavigationAuthority('explicit');
        performHunkTraversal(direction, maxLazyHunkLoadsPerMove);
        return;
      }
      const activeOrderIndex = activePath
        ? navigationData.model.canonicalFilePaths.indexOf(activePath)
        : -1;
      const result = moveReviewCursorFromPath(
        navigationTargets,
        navigationTargetKey,
        activePath,
        activeOrderIndex,
        direction,
      );
      if (!result.target) {
        setNavigationBoundary(null);
        const message = `No ${reviewNavigationKindLabel(navigationKind)} targets${
          fileFilter.query ? ' match the file-tree filter' : ''
        }.`;
        setNavigationStatus(message);
        setNavigationAnnouncement(message);
        return;
      }
      activateNavigationTarget(result.target, navigationTargets);
      if (result.boundary) {
        const boundary = `${result.boundary} boundary`;
        setNavigationBoundary(result.boundary);
        setNavigationStatus(boundary);
        setNavigationAnnouncement(
          reviewNavigationAnnouncement(
            result.target,
            result.index,
            result.total,
            boundary,
          ),
        );
      }
    },
    [
      activePath,
      activateNavigationTarget,
      fileFilter.query,
      navigationData.model.canonicalFilePaths,
      navigationKind,
      navigationTargetKey,
      navigationTargets,
      pendingHunkNavigation,
      performHunkTraversal,
    ],
  );
  const selectNeonFinding = useCallback(
    (finding: NeonReviewFinding) => {
      setPendingHunkNavigation(null);
      setNavigationKind('finding');
      const targets = reviewCursorTargets(navigationData.model, 'finding', {
        filter: fileFilter.paths ? { paths: fileFilter.paths } : undefined,
      });
      const target = targets.find((candidate) => candidate.id === finding.id);
      if (target) {
        activateNavigationTarget(target, targets);
        return;
      }
      if (files.some((file) => file.path === finding.file)) {
        setActivePath(finding.file);
        setNavigationTargetKey(null);
        setNavigationAuthority('explicit');
        setNavigationSelection(null);
        setNavigationAnnotationId(finding.id);
        setNavigationBoundary(null);
        setNavigationStatus(
          'Finding anchor is not available on this revision.',
        );
        setNavigationAnnouncement(
          `${finding.file}, Neon finding ${finding.lifecycle.state}, anchor unavailable on this revision.`,
        );
      }
    },
    [activateNavigationTarget, fileFilter.paths, files, navigationData.model],
  );
  const previousNavigationTargets = useRef<readonly ReviewCursorTarget[]>([]);

  useEffect(() => {
    if (navigationKind !== 'file' || !activePath) return;
    const activeFileTarget = navigationTargets.find(
      (target) => target.kind === 'file' && target.path === activePath,
    );
    if (activeFileTarget && navigationTargetKey !== activeFileTarget.key) {
      setNavigationTargetKey(activeFileTarget.key);
    }
  }, [activePath, navigationKind, navigationTargetKey, navigationTargets]);

  useEffect(() => {
    const previous = previousNavigationTargets.current;
    previousNavigationTargets.current = navigationTargets;
    if (!navigationTargetKey) return;
    const reconciled = reconcileReviewCursor(
      previous,
      navigationTargets,
      navigationTargetKey,
    );
    if (reconciled.resolution === 'exact' && reconciled.target) {
      const publication = reviewNavigationPublication(
        reconciled.target,
        navigationData.anchors,
      );
      if (
        reviewNavigationPublicationMatches(
          {
            activePath,
            annotationId: navigationAnnotationId,
            selection: navigationSelection,
          },
          publication,
        )
      ) {
        return;
      }
      activateNavigationTarget(
        reconciled.target,
        navigationTargets,
        'Target location updated.',
        navigationAuthority,
      );
      return;
    }
    if (!reconciled.target) {
      setNavigationTargetKey(null);
      setNavigationAuthority('automatic');
      setNavigationSelection(null);
      setNavigationAnnotationId(null);
      setNavigationBoundary(null);
      setNavigationStatus('The current target is outside the active filter.');
      setNavigationAnnouncement(
        `No ${reviewNavigationKindLabel(navigationKind)} target remains in the active filter.`,
      );
      return;
    }
    activateNavigationTarget(
      reconciled.target,
      navigationTargets,
      'Nearest available target selected.',
      navigationAuthority,
    );
  }, [
    activePath,
    activateNavigationTarget,
    navigationAnnotationId,
    navigationData.anchors,
    navigationKind,
    navigationAuthority,
    navigationSelection,
    navigationTargetKey,
    navigationTargets,
  ]);

  useEffect(() => {
    if (!pendingHunkNavigation || !activePath) return;
    const state = patchNavigationState.get(activePath);
    if (state !== 'loaded' && state !== 'unavailable') return;
    performHunkTraversal(
      pendingHunkNavigation.direction,
      pendingHunkNavigation.remainingLoads,
    );
  }, [
    activePath,
    patchNavigationState,
    pendingHunkNavigation,
    performHunkTraversal,
  ]);

  useEffect(() => {
    if (activePath && fileList.some((file) => file.path === activePath)) return;
    setActivePath(firstReviewablePath(fileList) ?? null);
  }, [activePath, fileList]);

  useEffect(() => {
    const nextDraftId = draft?.id ?? null;
    if (seededDraftId !== nextDraftId) {
      setReviewBody(draft?.body ?? '');
      setSeededDraftId(nextDraftId);
      setHasPendingReviewBodyEdit(false);
    } else if (!isReviewBodyFocused && !hasPendingReviewBodyEdit) {
      setReviewBody(draft?.body ?? '');
    }
    setVerdict(draft?.verdict ?? 'comment');
  }, [
    draft?.body,
    draft?.id,
    draft?.verdict,
    hasPendingReviewBodyEdit,
    isReviewBodyFocused,
    seededDraftId,
  ]);

  useEffect(() => {
    setSubmitFailedCommentIds((current) => {
      if (current.size === 0) return current;
      const liveIds = new Set(draft?.comments.map((comment) => comment.id));
      const next = new Set([...current].filter((id) => liveIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [draft?.comments]);

  const summary = filesQuery.data?.diffSummary;
  const saveDraft = async (
    next: Partial<{
      body: string | null;
      verdict: GitHubPrReviewVerdict | null;
      reanchorHeadSha: boolean;
    }> = {},
    headSha = currentHeadSha,
  ) => {
    if (!headSha) throw new Error('PR head SHA is unavailable.');
    return mutations.saveDraft.mutateAsync({
      repo: pr.repo,
      number: pr.number,
      headSha,
      ...('verdict' in next ? { verdict: next.verdict } : {}),
      ...('body' in next ? { body: next.body } : {}),
      ...(next.reanchorHeadSha ? { reanchorHeadSha: true } : {}),
    });
  };
  const ensureDraft = async () => draft ?? (await saveDraft());
  const beginReanchorComment = (commentId: string, path: string | null) => {
    setAnchoringFinding(null);
    setComposer(null);
    setReanchoringCommentId(commentId);
    jumpToReviewPath(
      path && files.some((file) => file.path === path)
        ? path
        : (activePath ?? firstRenderablePath(files) ?? null),
    );
    setStatusMessage('Select a new diff line to re-anchor the draft comment.');
  };
  const beginAnchorFinding = (finding: PrReviewReportOnlyFinding) => {
    setComposer(null);
    setReanchoringCommentId(null);
    setAnchoringFinding(finding);
    jumpToReviewPath(
      files.some((file) => file.path === finding.path)
        ? finding.path
        : (activePath ?? firstRenderablePath(files) ?? null),
    );
    setStatusMessage(
      'Choose a changed diff line or range for this report-only finding.',
    );
  };
  const refreshDraftHead = async () => {
    if (!draft) return;
    const operationToken = beginOperation();
    try {
      const refreshedHeadSha = await mutations
        .refetchPullRequestHeadSha()
        .catch(() => null);
      const nextHeadSha = refreshedHeadSha ?? currentHeadSha;
      await saveDraft({ reanchorHeadSha: true }, nextHeadSha);
      await mutations.invalidateReviewSources();
      setSubmitFailedCommentIds(new Set());
      finishOperation(
        operationToken,
        'Draft head updated to the current PR revision.',
      );
    } catch (error) {
      failOperation(operationToken, error);
    }
  };
  const onSelectionChange = (selection: SelectedLineRange | null) => {
    if (!selection || !activePath) return;
    setPendingHunkNavigation(null);
    setNavigationTargetKey(null);
    setNavigationAuthority('automatic');
    setNavigationSelection(null);
    setNavigationAnnotationId(null);
    setNavigationBoundary(null);
    setNavigationStatus(null);
    const index = patchIndexesByPath.get(activePath);
    const input = commentInputFromSelection(selection, index);
    if (index && !commentAnchorExists(index, input)) {
      setStatusMessage('Selected range is not valid for the current patch.');
      return;
    }
    if (reanchoringCommentId) {
      const comment = draft?.comments.find(
        (item) => item.id === reanchoringCommentId,
      );
      if (!comment) {
        setReanchoringCommentId(null);
        return;
      }
      const operationToken = beginOperation();
      mutations.updateComment
        .mutateAsync({
          repo: pr.repo,
          number: pr.number,
          id: reanchoringCommentId,
          path: activePath,
          ...input,
          body: comment.body,
        })
        .then(() => {
          setSubmitFailedCommentIds((current) => {
            const next = new Set(current);
            next.delete(reanchoringCommentId);
            return next;
          });
          setReanchoringCommentId(null);
          finishOperation(operationToken, 'Draft comment re-anchored.');
        })
        .catch((error) => failOperation(operationToken, error));
      return;
    }
    const annotation = annotationFromSelection(selection, index);
    setComposer({
      annotation,
      body: anchoringFinding ? reportOnlyFindingBody(anchoringFinding) : '',
      path: activePath,
      selection,
      sourceFindingId: anchoringFinding?.sourceId ?? null,
      token: createEditorToken(),
    });
    setAnchoringFinding(null);
    setStatusMessage(null);
  };
  const submitComposer = async (event: FormEvent) => {
    event.preventDefault();
    const submittedComposer = composer;
    if (!submittedComposer || submittedComposer.body.trim().length === 0)
      return;
    const operationToken = beginOperation();
    try {
      const nextDraft = await ensureDraft();
      const index = patchIndexesByPath.get(submittedComposer.path);
      const input = commentInputFromSelection(
        submittedComposer.selection,
        index,
      );
      if (index && !commentAnchorExists(index, input)) {
        finishOperation(
          operationToken,
          'Selected range is not valid for the current patch.',
        );
        return;
      }
      await mutations.addComment.mutateAsync({
        repo: pr.repo,
        number: pr.number,
        draftId: nextDraft.id,
        path: submittedComposer.path,
        ...input,
        body: submittedComposer.body,
        sourceFindingId: submittedComposer.sourceFindingId,
      });
      setComposer((current) =>
        clearCompletedEditor(current, submittedComposer.token),
      );
      finishOperation(operationToken, 'Draft comment saved.');
    } catch (error) {
      failOperation(operationToken, error);
    }
  };
  const submitEdit = async (event: FormEvent) => {
    event.preventDefault();
    const submittedEditor = commentEditor;
    if (!submittedEditor || submittedEditor.body.trim().length === 0) return;
    const operationToken = beginOperation();
    try {
      await mutations.updateComment.mutateAsync({
        repo: pr.repo,
        number: pr.number,
        id: submittedEditor.commentId,
        body: submittedEditor.body,
      });
      setCommentEditor((current) =>
        clearCompletedEditor(current, submittedEditor.token),
      );
      finishOperation(operationToken, 'Draft comment updated.');
    } catch (error) {
      failOperation(operationToken, error);
    }
  };
  const submitReply = async (threadId: string, event: FormEvent) => {
    event.preventDefault();
    const submittedEditor = replyEditor;
    if (
      !submittedEditor ||
      submittedEditor.threadId !== threadId ||
      submittedEditor.body.trim().length === 0
    )
      return;
    const operationToken = beginOperation();
    try {
      await mutations.replyToThread.mutateAsync({
        repo: pr.repo,
        number: pr.number,
        threadId,
        text: submittedEditor.body,
      });
      setReplyEditor((current) =>
        clearCompletedEditor(current, submittedEditor.token),
      );
      finishOperation(operationToken, 'Thread reply posted.');
    } catch (error) {
      failOperation(operationToken, error);
    }
  };
  const deleteDraftComment = (commentId: string) => {
    const operationToken = beginOperation();
    mutations.deleteComment.mutate(
      {
        repo: pr.repo,
        number: pr.number,
        id: commentId,
      },
      {
        onError: (error) => failOperation(operationToken, error),
        onSuccess: () =>
          finishOperation(operationToken, 'Draft comment deleted.'),
      },
    );
  };
  const dismissNeonFinding = async (finding: NeonReviewFinding) => {
    if (!reviewSurfaceId || !currentReviewRevisionKey) {
      setStatusMessage(
        'The focused review surface is not ready for dismissal.',
      );
      return;
    }
    const operationToken = beginOperation();
    setDismissingFindingIds((current) => new Set(current).add(finding.id));
    try {
      const result = await dismissReviewSurfaceFindings(reviewSurfaceId, {
        sourceId: reviewSource.id,
        revisionKey: currentReviewRevisionKey,
        findingIds: [finding.id],
        reason: 'Dismissed locally from the focused PR review workbench.',
      });
      finishOperation(operationToken, result.message);
    } catch (error) {
      failOperation(operationToken, error);
    } finally {
      setDismissingFindingIds((current) => {
        const next = new Set(current);
        next.delete(finding.id);
        return next;
      });
    }
  };
  const renderAnnotation = (annotation: DiffReviewAnnotation) =>
    annotation.metadata.kind === 'finding' && annotation.metadata.finding ? (
      <PrReviewNeonFindingAnnotation
        compact={!isStandalone}
        finding={annotation.metadata.finding}
        isDismissing={dismissingFindingIds.has(annotation.metadata.finding.id)}
        onDismiss={dismissNeonFinding}
        selected={
          selectedContext.selectedAnnotationId === annotation.metadata.id
        }
      />
    ) : (
      <PrReviewCommentComposer
        annotation={annotation}
        composerBody={composer?.body ?? ''}
        draft={draft}
        editingBody={commentEditor?.body ?? ''}
        editingCommentId={commentEditor?.commentId ?? null}
        isAddingComment={mutations.addComment.isPending}
        isDeletingComment={mutations.deleteComment.isPending}
        isReplyingToThread={mutations.replyToThread.isPending}
        isResolvingThread={mutations.setThreadResolution.isPending}
        isSavingDraft={mutations.saveDraft.isPending}
        isUpdatingComment={mutations.updateComment.isPending}
        onCancelComposer={() => {
          setComposer(null);
        }}
        onCancelEdit={() => {
          setCommentEditor(null);
        }}
        onCancelReply={() => {
          setReplyEditor(null);
        }}
        onComposerBodyChange={(body) =>
          setComposer((current) => (current ? { ...current, body } : current))
        }
        onDeleteComment={deleteDraftComment}
        onEditingBodyChange={(body) =>
          setCommentEditor((current) =>
            current ? { ...current, body } : current,
          )
        }
        onReanchorComment={(comment) =>
          beginReanchorComment(comment.id, comment.path)
        }
        onReplyBodyChange={(body) =>
          setReplyEditor((current) =>
            current ? { ...current, body } : current,
          )
        }
        onSetThreadResolution={(thread) => {
          const operationToken = beginOperation();
          const resolved = !thread.isResolved;
          mutations.setThreadResolution.mutate(
            {
              repo: pr.repo,
              number: pr.number,
              threadId: thread.id,
              resolved,
            },
            {
              onError: (error) => failOperation(operationToken, error),
              onSuccess: () =>
                finishOperation(
                  operationToken,
                  resolved ? 'Thread resolved.' : 'Thread reopened.',
                ),
            },
          );
        }}
        onStartEdit={(commentId, body) => {
          setCommentEditor({
            body,
            commentId,
            token: createEditorToken(),
          });
        }}
        onStartReply={(threadId) => {
          setReplyEditor({ body: '', threadId, token: createEditorToken() });
        }}
        onSubmitComposer={submitComposer}
        onSubmitEdit={submitEdit}
        onSubmitReply={submitReply}
        reanchoringCommentId={reanchoringCommentId}
        replyingThreadId={replyEditor?.threadId ?? null}
        replyBody={replyEditor?.body ?? ''}
        reviewThreads={reviewThreads}
        selected={
          selectedContext.selectedAnnotationId === annotation.metadata.id
        }
      />
    );
  const submitReview = async () => {
    if (!currentHeadSha) return;
    if (!isDurableReviewReady) {
      setStatusMessage(
        'Wait for the durable Neon review to be ready before submitting.',
      );
      return;
    }
    const operationToken = beginOperation();
    try {
      const normalizedBody = normalizeReviewBody(reviewBody);
      await mutations.submitReview.mutateAsync({
        repo: pr.repo,
        number: pr.number,
        headSha: currentHeadSha,
        body: normalizedBody,
        verdict,
        commentIds: cleanCommentIds,
      });
      setSubmitFailedCommentIds(new Set());
      finishOperation(operationToken, 'Review submitted.');
    } catch (error) {
      const failingIds = failingCommentIdsFromError(error);
      if (failingIds.length > 0) {
        setSubmitFailedCommentIds(new Set(failingIds));
      }
      failOperation(operationToken, error);
    }
  };
  const focusNextPendingComment = () => {
    const comments =
      draft?.comments.filter((comment) => !blockedCommentIds.has(comment.id)) ??
      [];
    if (comments.length === 0) return;
    const currentIndex = comments.findIndex(
      (comment) => comment.path === activePath,
    );
    const next = comments[(currentIndex + 1) % comments.length] ?? comments[0];
    jumpToReviewPath(next.path);
    setStatusMessage(`Showing draft comment on ${next.path} L${next.line}.`);
  };
  const openPopout = () => {
    const url = new URL('/review', window.location.origin);
    url.searchParams.set('repo', pr.repo);
    url.searchParams.set('number', String(pr.number));
    if (pr.headSha) url.searchParams.set('head', pr.headSha);
    if (pr.baseSha) url.searchParams.set('base', pr.baseSha);
    if (pr.baseRef) url.searchParams.set('baseRef', pr.baseRef);
    if (pr.title) url.searchParams.set('title', pr.title);
    window.open(
      url.toString(),
      `neondeck-pr-review-${pr.number}`,
      'popup,width=1440,height=940',
    );
  };
  const findingsSidebar = {
    activePath,
    cleanCommentCount: cleanCommentIds.length,
    draft,
    files,
    isDeleting: mutations.deleteComment.isPending,
    isDismissingFinding: (findingId: string) =>
      dismissingFindingIds.has(findingId),
    isLoadingThreads: threadsQuery.isLoading,
    findingResolution: (finding: NeonReviewFinding) =>
      neonFindingResolutions.get(finding.id) ?? {
        state: 'unavailable' as const,
        reason: 'Finding anchor metadata is unavailable.',
      },
    neonFindings,
    onChooseLine: beginAnchorFinding,
    onDelete: deleteDraftComment,
    onDismissFinding: dismissNeonFinding,
    onReanchor: (comment: GitHubPrReviewDraftComment) =>
      beginReanchorComment(comment.id, comment.path),
    onSelectFinding: selectNeonFinding,
    review: reviewRecord,
    reviewThreads,
    selectedAnnotationId: selectedContext.selectedAnnotationId,
    staleCommentCount: blockedCommentIds.size,
    staleDraftComments,
    unresolvedThreads,
  };

  return (
    <section
      className={
        isStandalone
          ? 'pr-review-shell pr-review-shell-standalone'
          : 'pr-review-shell'
      }
    >
      <header className="pr-review-header">
        <div className="min-w-0">
          <p className="truncate font-mono text-[10px] tracking-[0.12em] text-primary">
            PR REVIEW · {pr.repo}#{pr.number}
          </p>
          <p className="mt-0.5 line-clamp-1 text-[12px] font-semibold text-ink">
            {pr.title}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          <Badge className={checkBadgeClass(pr)}>{checkLabel(pr)}</Badge>
          <Badge>{pr.baseRef ?? 'base unknown'}</Badge>
          <Badge>
            {unresolvedThreads.length}/{reviewThreads.length} threads
          </Badge>
          {summary ? <Badge>{summaryLabel(summary)}</Badge> : null}
          {activeNeonFindings.length > 0 ? (
            <Badge>{activeNeonFindings.length} Neon findings</Badge>
          ) : null}
          {fileStats.truncated > 0 ? (
            <Badge>{fileStats.truncated} truncated</Badge>
          ) : null}
          {fileStats.binary > 0 ? (
            <Badge>{fileStats.binary} binary</Badge>
          ) : null}
          {reviewRecord &&
          (reviewRecord.status !== 'submitted' ||
            (currentHeadSha && reviewRecord.headSha !== currentHeadSha)) ? (
            <button
              className="pr-review-popout-button"
              disabled={
                restartReview.isPending ||
                reconcileSubmission.isPending ||
                reviewRecord.status === 'reviewing'
              }
              onClick={() => {
                const operationToken = beginOperation();
                if (reviewRecord.status === 'submitting') {
                  reconcileSubmission.mutate(reviewRecord.id, {
                    onError: (error) => failOperation(operationToken, error),
                    onSuccess: (result) =>
                      finishOperation(operationToken, result.message),
                  });
                } else {
                  restartReview.mutate(reviewRecord.id, {
                    onError: (error) => failOperation(operationToken, error),
                    onSuccess: () =>
                      finishOperation(operationToken, 'Neon review restarted.'),
                  });
                }
              }}
              title={
                reviewRecord.status === 'submitting'
                  ? 'Check GitHub and recover an interrupted review submission'
                  : currentHeadSha && reviewRecord.headSha !== currentHeadSha
                    ? 'Run Neon again for the current PR head'
                    : 'Refresh Neon findings from current GitHub facts'
              }
              type="button"
            >
              {reconcileSubmission.isPending
                ? 'checking GitHub'
                : reviewRecord.status === 'submitting'
                  ? 'recover submission'
                  : restartReview.isPending ||
                      reviewRecord.status === 'reviewing'
                    ? 'reviewing'
                    : reviewRecord.status === 'submitted'
                      ? 'review new changes'
                      : 're-review'}
            </button>
          ) : null}
          {!reviewRecord && reviewRecordQuery.isSuccess ? (
            <button
              className="pr-review-popout-button"
              disabled={startReview.isPending}
              onClick={() => {
                const operationToken = beginOperation();
                startReview.mutate(undefined, {
                  onError: (error) => failOperation(operationToken, error),
                  onSuccess: () =>
                    finishOperation(operationToken, 'Neon review started.'),
                });
              }}
              title="Run Neon review assistance for this pull request"
              type="button"
            >
              {startReview.isPending ? 'starting' : 'run Neon'}
            </button>
          ) : null}
          {isStandalone ? (
            <a
              className="pr-review-popout-button"
              href={pr.url}
              rel="noreferrer"
              target="_blank"
            >
              GitHub
            </a>
          ) : (
            <button
              className="pr-review-popout-button"
              onClick={openPopout}
              title="Open this review in a focused review window"
              type="button"
            >
              pop out
            </button>
          )}
        </div>
      </header>
      {isStandalone ? (
        <PrReviewNavigationBar
          announcement={navigationAnnouncement}
          boundary={navigationBoundary}
          canMove={
            navigationKind === 'hunk'
              ? navigationFiles.length > 0
              : navigationTargets.length > 0
          }
          currentIndex={navigationCurrentIndex}
          currentTarget={selectedNavigationTarget}
          filter={fileFilter.query}
          isBusy={Boolean(pendingHunkNavigation)}
          kind={navigationKind}
          onClearFilter={() => setFileFilter({ paths: null, query: null })}
          onKindChange={(nextKind) => {
            setPendingHunkNavigation(null);
            setNavigationKind(nextKind);
            setNavigationTargetKey(null);
            setNavigationAuthority('automatic');
            setNavigationSelection(null);
            setNavigationAnnotationId(null);
            setNavigationBoundary(null);
            setNavigationStatus(null);
            setNavigationAnnouncement(
              `${reviewNavigationKindLabel(nextKind)} traversal selected.`,
            );
          }}
          onMove={navigateReview}
          status={navigationStatus}
          total={navigationTargets.length}
        />
      ) : null}
      {reanchoringCommentId ? (
        <div className="pr-review-stale-banner">
          Re-anchor mode is active. Select the new diff line or range for this
          draft comment.
        </div>
      ) : null}
      {anchoringFinding ? (
        <div className="pr-review-stale-banner">
          Choose-line mode is active for {anchoringFinding.path}. Select a
          changed line or range to draft the finding inline.
        </div>
      ) : null}
      {threadsQuery.error ? (
        <MiniEmpty
          label={`Review threads unavailable: ${queryErrorMessage(threadsQuery.error)}`}
        />
      ) : null}
      {draftQuery.error ? (
        <MiniEmpty
          label={`Review draft unavailable: ${queryErrorMessage(draftQuery.error)}`}
        />
      ) : null}
      {draft && draft.headSha !== currentHeadSha ? (
        <div className="pr-review-stale-banner">
          <span>
            PR updated since your draft. {staleCommentIds.size} comment
            {staleCommentIds.size === 1 ? '' : 's'} need re-anchoring or will be
            skipped on submit.
          </span>
          <button
            disabled={mutations.saveDraft.isPending}
            onClick={refreshDraftHead}
            type="button"
          >
            Update draft head
          </button>
        </div>
      ) : null}
      <PrReviewDiffPane
        activePath={activePath}
        annotationsByPath={annotationsByPath}
        detail={prDetail(pr, summary)}
        fileFilter={fileFilter.query}
        fileLoadMessage={fileLoadMessage}
        files={files}
        findingsSidebar={findingsSidebar}
        isLoadingPatch={Boolean(activePatchQuery?.isLoading)}
        isStandalone={isStandalone}
        onActivePathChange={selectPathFromWorkbench}
        onFileFilterChange={handleFileFilterChange}
        onReviewSurfaceFindingsChange={handleReviewSurfaceFindingsChange}
        onReviewSurfaceIdChange={handleReviewSurfaceIdChange}
        onSelectedLinesChange={onSelectionChange}
        patchError={patchErrorMessage}
        renderAnnotation={renderAnnotation}
        reviewMapByPath={reviewMapByPath}
        reviewOrder={navigationData.model.guidedFilePaths}
        selectedLines={selectedContext.selectedLines}
        selectedAnnotationId={selectedContext.selectedAnnotationId}
        source={reviewSource}
        title={pr.title}
      />
      {fileLoadMessage ? null : (
        <PrReviewSubmitBar
          cleanCommentCount={cleanCommentIds.length}
          draft={draft}
          isBusy={isDraftMutationPending || isThreadMutationPending}
          isDurableReviewReady={isDurableReviewReady}
          isHeadAvailable={currentHeadSha.length > 0}
          onBodyBlur={() => {
            setIsReviewBodyFocused(false);
            const normalizedBody = normalizeReviewBody(reviewBody);
            if ((draft?.body ?? null) !== normalizedBody) {
              const operationToken = beginOperation();
              void saveDraft({ body: normalizedBody })
                .then(() => {
                  setHasPendingReviewBodyEdit(false);
                  finishOperation(operationToken, 'Review summary saved.');
                })
                .catch((error) => failOperation(operationToken, error));
            } else {
              setHasPendingReviewBodyEdit(false);
            }
          }}
          onBodyChange={(value) => {
            setReviewBody(value);
            setHasPendingReviewBodyEdit(true);
          }}
          onBodyFocus={() => setIsReviewBodyFocused(true)}
          onDiscard={() => {
            if (!draft) return;
            const confirmed = window.confirm('Discard this PR review draft?');
            if (confirmed) {
              const operationToken = beginOperation();
              mutations.discardDraft.mutate(
                {
                  repo: pr.repo,
                  number: pr.number,
                },
                {
                  onError: (error) => failOperation(operationToken, error),
                  onSuccess: () =>
                    finishOperation(operationToken, 'Review draft discarded.'),
                },
              );
            }
          }}
          onSubmit={submitReview}
          onPendingCountClick={focusNextPendingComment}
          onVerdictChange={(next) => {
            setVerdict(next);
            const operationToken = beginOperation();
            void saveDraft({ verdict: next })
              .then(() => finishOperation(operationToken, 'Verdict saved.'))
              .catch((error) => failOperation(operationToken, error));
          }}
          isSubmitting={mutations.submitReview.isPending}
          reviewBody={reviewBody}
          staleCommentCount={blockedCommentIds.size}
          statusMessage={reviewBarStatusMessage}
          verdict={verdict}
          trustBoundary={reviewRecord?.trustBoundary ?? null}
        />
      )}
    </section>
  );
}

export { hasRenderablePrPatch } from './review-view-model';

function sameStringArray(
  left: readonly string[] | null,
  right: readonly string[] | null,
) {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
