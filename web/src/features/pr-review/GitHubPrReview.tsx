import type { SelectedLineRange } from '@pierre/diffs/react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  type GitHubPrReviewDraftComment,
  type GitHubPrReviewVerdict,
  type GitHubPullRequest,
  type PrReviewReportOnlyFinding,
} from '../../api';
import { Badge, MiniEmpty } from '../../components/ui';
import { queryErrorMessage } from '../../lib/query';
import { firstRenderablePath } from '../diff-viewer/helpers';
import type { DiffFilePatch, DiffReviewAnnotation } from '../diff-viewer/types';
import { PrReviewCommentComposer } from './PrReviewCommentComposer';
import { PrReviewDiffPane } from './PrReviewDiffPane';
import { reportOnlyFindingBody } from './PrReviewFindingsSidebar';
import { PrReviewSubmitBar } from './PrReviewSubmitBar';
import {
  useGitHubPrReviewDraft,
  useGitHubPrReviewMutations,
  useGitHubPrReviewThreads,
  useGitHubPullRequestFileList,
  useGitHubPullRequestFilePatches,
  usePrefetchGitHubPullRequestFilePatch,
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
  checkBadgeClass,
  checkLabel,
  draftCommentIdsWithUnknownPatch,
  firstReviewablePath,
  mergeAnnotations,
  mergePatchResults,
  mutationErrorMessage,
  prDetail,
  reviewFileStats,
  reviewPatchPaths,
  summaryLabel,
} from './review-view-model';
import { usePrReviewRecord } from './usePrReviewRecord';

type ComposerState = {
  path: string;
  selection: SelectedLineRange;
  annotation: DiffReviewAnnotation;
};

type GitHubPrReviewMode = 'embedded' | 'standalone';

export function GitHubPrReview({
  mode = 'embedded',
  pr,
}: {
  mode?: GitHubPrReviewMode;
  pr: GitHubPullRequest;
}) {
  const filesQuery = useGitHubPullRequestFileList(pr);
  const threadsQuery = useGitHubPrReviewThreads(pr);
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
  const [activePath, setActivePath] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [composerBody, setComposerBody] = useState('');
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState('');
  const [replyingThreadId, setReplyingThreadId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
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
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
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
  const eagerPatchPaths = useMemo(
    () =>
      reviewPatchPaths({
        activePath,
        draft,
        files: fileList,
        unresolvedThreads,
      }),
    [activePath, draft, fileList, unresolvedThreads],
  );
  const patchQueries = useGitHubPullRequestFilePatches(pr, eagerPatchPaths);
  const patchQueryByPath = patchQueries.byPath;
  const files = useMemo(
    () => mergePatchResults(fileList, patchQueryByPath),
    [fileList, patchQueryByPath],
  );
  const activePatchQuery = activePath
    ? patchQueryByPath.get(activePath)
    : undefined;
  const prefetchPatch = usePrefetchGitHubPullRequestFilePatch(pr);
  const currentHeadSha = pr.headSha ?? '';
  const patchIndexesByPath = useMemo(
    () => patchAnchorIndexesByPath(files),
    [files],
  );
  const unknownDraftPatchCommentIds = useMemo(
    () => draftCommentIdsWithUnknownPatch(draft, files, patchQueryByPath),
    [draft, files, patchQueryByPath],
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
        annotationsFromThreads(reviewThreads),
        annotationsFromDraft(draft, blockedCommentIds),
        annotationsFromComposer(composer),
      ),
    [blockedCommentIds, composer, draft, reviewThreads],
  );
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
  const reviewBarStatusMessage =
    mutationErrorMessage(
      mutations.submitReview.error ??
        mutations.saveDraft.error ??
        mutations.addComment.error ??
        mutations.updateComment.error ??
        mutations.deleteComment.error ??
        mutations.discardDraft.error ??
        mutations.replyToThread.error ??
        mutations.setThreadResolution.error ??
        startReview.error ??
        restartReview.error ??
        reconcileSubmission.error,
      draft,
    ) ?? statusMessage;
  const fileLoadMessage = filesQuery.isLoading
    ? 'Loading PR files.'
    : filesQuery.error
      ? `PR files unavailable: ${queryErrorMessage(filesQuery.error)}`
      : null;
  const patchErrorMessage = activePatchQuery?.error
    ? `Patch unavailable: ${queryErrorMessage(activePatchQuery.error)}`
    : null;

  useEffect(() => {
    if (activePath && fileList.some((file) => file.path === activePath)) return;
    setActivePath(firstReviewablePath(fileList) ?? null);
  }, [activePath, fileList]);

  useEffect(() => {
    const firstPath = firstReviewablePath(fileList);
    if (firstPath) void prefetchPatch(firstPath);
  }, [fileList, prefetchPatch]);

  useEffect(() => {
    if (!activePath) return;
    const index = fileList.findIndex((file) => file.path === activePath);
    if (index < 0) return;
    for (const file of [fileList[index - 1], fileList[index + 1]]) {
      if (file?.path) void prefetchPatch(file.path);
    }
  }, [activePath, fileList, prefetchPatch]);

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
    setStatusMessage(null);
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
    setComposerBody('');
    setReanchoringCommentId(commentId);
    if (path && files.some((file) => file.path === path)) {
      setActivePath(path);
    } else if (!activePath) {
      setActivePath(firstRenderablePath(files) ?? null);
    }
    setStatusMessage('Select a new diff line to re-anchor the draft comment.');
  };
  const beginAnchorFinding = (finding: PrReviewReportOnlyFinding) => {
    setComposer(null);
    setComposerBody('');
    setReanchoringCommentId(null);
    setAnchoringFinding(finding);
    if (files.some((file) => file.path === finding.path)) {
      setActivePath(finding.path);
    } else if (!activePath) {
      setActivePath(firstRenderablePath(files) ?? null);
    }
    setStatusMessage(
      'Choose a changed diff line or range for this report-only finding.',
    );
  };
  const refreshDraftHead = async () => {
    if (!draft) return;
    setStatusMessage(null);
    try {
      const refreshedHeadSha = await mutations
        .refetchPullRequestHeadSha()
        .catch(() => null);
      const nextHeadSha = refreshedHeadSha ?? currentHeadSha;
      await saveDraft({ reanchorHeadSha: true }, nextHeadSha);
      await mutations.invalidateReviewSources();
      setSubmitFailedCommentIds(new Set());
      setStatusMessage('Draft head updated to the current PR revision.');
    } catch {
      // React Query owns the visible error state.
    }
  };
  const onSelectionChange = (selection: SelectedLineRange | null) => {
    if (!selection || !activePath) return;
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
      setStatusMessage(null);
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
          setStatusMessage('Draft comment re-anchored.');
        })
        .catch(() => undefined);
      return;
    }
    const annotation = annotationFromSelection(selection, index);
    setComposer({ path: activePath, selection, annotation });
    setComposerBody(
      anchoringFinding ? reportOnlyFindingBody(anchoringFinding) : '',
    );
    setAnchoringFinding(null);
    setStatusMessage(null);
  };
  const submitComposer = async (event: FormEvent) => {
    event.preventDefault();
    if (!composer || composerBody.trim().length === 0) return;
    setStatusMessage(null);
    try {
      const nextDraft = await ensureDraft();
      const index = patchIndexesByPath.get(composer.path);
      const input = commentInputFromSelection(composer.selection, index);
      if (index && !commentAnchorExists(index, input)) {
        setStatusMessage('Selected range is not valid for the current patch.');
        return;
      }
      await mutations.addComment.mutateAsync({
        repo: pr.repo,
        number: pr.number,
        draftId: nextDraft.id,
        path: composer.path,
        ...input,
        body: composerBody,
      });
      setComposer(null);
      setComposerBody('');
      setStatusMessage('Draft comment saved.');
    } catch {
      // React Query owns the visible error state.
    }
  };
  const submitEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingCommentId || editingBody.trim().length === 0) return;
    setStatusMessage(null);
    try {
      await mutations.updateComment.mutateAsync({
        repo: pr.repo,
        number: pr.number,
        id: editingCommentId,
        body: editingBody,
      });
      setEditingCommentId(null);
      setEditingBody('');
    } catch {
      // React Query owns the visible error state.
    }
  };
  const submitReply = async (threadId: string, event: FormEvent) => {
    event.preventDefault();
    if (replyBody.trim().length === 0) return;
    setStatusMessage(null);
    try {
      await mutations.replyToThread.mutateAsync({
        repo: pr.repo,
        number: pr.number,
        threadId,
        text: replyBody,
      });
      setReplyingThreadId(null);
      setReplyBody('');
      setStatusMessage('Thread reply posted.');
    } catch {
      // React Query owns the visible error state.
    }
  };
  const renderAnnotation = (annotation: DiffReviewAnnotation) => (
    <PrReviewCommentComposer
      annotation={annotation}
      composerBody={composerBody}
      draft={draft}
      editingBody={editingBody}
      editingCommentId={editingCommentId}
      isAddingComment={mutations.addComment.isPending}
      isDeletingComment={mutations.deleteComment.isPending}
      isReplyingToThread={mutations.replyToThread.isPending}
      isResolvingThread={mutations.setThreadResolution.isPending}
      isSavingDraft={mutations.saveDraft.isPending}
      isUpdatingComment={mutations.updateComment.isPending}
      onCancelComposer={() => {
        setComposer(null);
        setComposerBody('');
      }}
      onCancelEdit={() => {
        setEditingCommentId(null);
        setEditingBody('');
      }}
      onCancelReply={() => {
        setReplyingThreadId(null);
        setReplyBody('');
      }}
      onComposerBodyChange={setComposerBody}
      onDeleteComment={(commentId) => {
        setStatusMessage(null);
        mutations.deleteComment.mutate({
          repo: pr.repo,
          number: pr.number,
          id: commentId,
        });
      }}
      onEditingBodyChange={setEditingBody}
      onReanchorComment={(comment) =>
        beginReanchorComment(comment.id, comment.path)
      }
      onReplyBodyChange={setReplyBody}
      onSetThreadResolution={(thread) => {
        setStatusMessage(null);
        mutations.setThreadResolution.mutate({
          repo: pr.repo,
          number: pr.number,
          threadId: thread.id,
          resolved: !thread.isResolved,
        });
      }}
      onStartEdit={(commentId, body) => {
        setEditingCommentId(commentId);
        setEditingBody(body);
      }}
      onStartReply={(threadId) => {
        setReplyingThreadId(threadId);
        setReplyBody('');
      }}
      onSubmitComposer={submitComposer}
      onSubmitEdit={submitEdit}
      onSubmitReply={submitReply}
      reanchoringCommentId={reanchoringCommentId}
      replyingThreadId={replyingThreadId}
      replyBody={replyBody}
      reviewThreads={reviewThreads}
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
    setStatusMessage(null);
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
      setStatusMessage('Review submitted.');
    } catch (error) {
      const failingIds = failingCommentIdsFromError(error);
      if (failingIds.length > 0) {
        setSubmitFailedCommentIds(new Set(failingIds));
      }
      // React Query owns the visible error state.
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
    setActivePath(next.path);
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
  const isStandalone = mode === 'standalone';
  const findingsSidebar = {
    activePath,
    cleanCommentCount: cleanCommentIds.length,
    draft,
    files,
    isDeleting: mutations.deleteComment.isPending,
    isLoadingThreads: threadsQuery.isLoading,
    onChooseLine: beginAnchorFinding,
    onDelete: (commentId: string) => {
      setStatusMessage(null);
      mutations.deleteComment.mutate({
        repo: pr.repo,
        number: pr.number,
        id: commentId,
      });
    },
    onReanchor: (comment: GitHubPrReviewDraftComment) =>
      beginReanchorComment(comment.id, comment.path),
    review: reviewRecord,
    reviewThreads,
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
                setStatusMessage(null);
                if (reviewRecord.status === 'submitting') {
                  reconcileSubmission.mutate(reviewRecord.id, {
                    onSuccess: (result) => setStatusMessage(result.message),
                  });
                } else {
                  restartReview.mutate(reviewRecord.id);
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
                setStatusMessage(null);
                startReview.mutate();
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
        fileLoadMessage={fileLoadMessage}
        files={files}
        findingsSidebar={findingsSidebar}
        isLoadingPatch={Boolean(activePatchQuery?.isLoading)}
        isStandalone={isStandalone}
        onActivePathChange={setActivePath}
        onSelectedLinesChange={onSelectionChange}
        patchError={patchErrorMessage}
        renderAnnotation={renderAnnotation}
        selectedLines={
          composer?.path === activePath ? composer.selection : null
        }
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
              void saveDraft({ body: normalizedBody })
                .then(() => setHasPendingReviewBodyEdit(false))
                .catch(() => undefined);
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
            setStatusMessage(null);
            const confirmed = window.confirm('Discard this PR review draft?');
            if (confirmed) {
              mutations.discardDraft.mutate({
                repo: pr.repo,
                number: pr.number,
              });
            }
          }}
          onSubmit={submitReview}
          onPendingCountClick={focusNextPendingComment}
          onVerdictChange={(next) => {
            setVerdict(next);
            void saveDraft({ verdict: next }).catch(() => undefined);
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
