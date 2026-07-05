import type { SelectedLineRange } from '@pierre/diffs/react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ApiError,
  type DiffSummary,
  type GitHubPrReviewDraft,
  type GitHubPrReviewDraftComment,
  type GitHubPrReviewVerdict,
  type GitHubPullRequest,
  type GitHubPullRequestReviewThread,
} from '../../api';
import type {
  GitHubPrReviewDraftResponse,
  GitHubPrReviewSubmitResponse,
  GitHubPrThreadMutationResponse,
} from '../../api';
import { Badge, MiniEmpty } from '../../components/ui';
import { queryErrorMessage } from '../../lib/query';
import { firstRenderablePath, patchHasContent } from '../diff-viewer/helpers';
import { MultiFileView } from '../diff-viewer/MultiFileView';
import type { DiffFilePatch, DiffReviewAnnotation } from '../diff-viewer/types';
import {
  useGitHubPrReviewDraft,
  useGitHubPrReviewMutations,
  useGitHubPrReviewThreads,
  useGitHubPullRequestFiles,
} from './queries';
import {
  commentInputFromSelection,
  patchAnchorIndexesByPath,
  staleDraftCommentIds,
} from './review-helpers';

type ComposerState = {
  path: string;
  selection: SelectedLineRange;
  annotation: DiffReviewAnnotation;
};

export function GitHubPrReview({ pr }: { pr: GitHubPullRequest }) {
  const filesQuery = useGitHubPullRequestFiles(pr);
  const threadsQuery = useGitHubPrReviewThreads(pr);
  const draftQuery = useGitHubPrReviewDraft(pr);
  const mutations = useGitHubPrReviewMutations(pr);
  const files = useMemo(
    () => (filesQuery.data?.files ?? []) as DiffFilePatch[],
    [filesQuery.data?.files],
  );
  const [activePath, setActivePath] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [composerBody, setComposerBody] = useState('');
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState('');
  const [replyingThreadId, setReplyingThreadId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [reviewBody, setReviewBody] = useState('');
  const [verdict, setVerdict] = useState<GitHubPrReviewVerdict>('comment');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const reviewThreads = useMemo(
    () => threadsQuery.data?.reviewThreads ?? [],
    [threadsQuery.data?.reviewThreads],
  );
  const unresolvedThreads = useMemo(
    () => threadsQuery.data?.unresolvedReviewThreads ?? [],
    [threadsQuery.data?.unresolvedReviewThreads],
  );
  const draft = draftQuery.data ?? null;
  const currentHeadSha = pr.headSha ?? '';
  const patchIndexesByPath = useMemo(
    () => patchAnchorIndexesByPath(files),
    [files],
  );
  const staleCommentIds = useMemo(
    () => staleDraftCommentIds(draft, patchIndexesByPath),
    [draft, patchIndexesByPath],
  );
  const cleanCommentIds = useMemo(
    () =>
      draft?.comments
        .filter((comment) => !staleCommentIds.has(comment.id))
        .map((comment) => comment.id) ?? [],
    [draft, staleCommentIds],
  );
  const annotationsByPath = useMemo(
    () =>
      mergeAnnotations(
        annotationsFromThreads(reviewThreads),
        annotationsFromDraft(draft, staleCommentIds),
        annotationsFromComposer(composer),
      ),
    [composer, draft, reviewThreads, staleCommentIds],
  );
  const selectedThreads = useMemo(
    () => threadsForPath(reviewThreads, activePath),
    [activePath, reviewThreads],
  );
  const fileStats = useMemo(() => reviewFileStats(files), [files]);
  const reviewBarStatusMessage =
    mutationErrorMessage(
      mutations.submitReview.error ??
        mutations.saveDraft.error ??
        mutations.addComment.error ??
        mutations.updateComment.error ??
        mutations.deleteComment.error ??
        mutations.discardDraft.error ??
        mutations.replyToThread.error ??
        mutations.setThreadResolution.error,
    ) ?? statusMessage;

  useEffect(() => {
    if (activePath && files.some((file) => file.path === activePath)) return;
    setActivePath(firstRenderablePath(files) ?? null);
  }, [activePath, files]);

  useEffect(() => {
    setReviewBody(draft?.body ?? '');
    setVerdict(draft?.verdict ?? 'comment');
  }, [draft?.body, draft?.verdict]);

  if (filesQuery.isLoading) {
    return <MiniEmpty label="Loading PR files." />;
  }

  if (filesQuery.error) {
    return (
      <MiniEmpty
        label={`PR files unavailable: ${queryErrorMessage(filesQuery.error)}`}
      />
    );
  }

  const summary = filesQuery.data?.diffSummary;
  const saveDraft = async (
    next: Partial<{
      body: string | null;
      verdict: GitHubPrReviewVerdict | null;
    }> = {},
  ) => {
    setStatusMessage(null);
    if (!currentHeadSha) throw new Error('PR head SHA is unavailable.');
    return mutations.saveDraft.mutateAsync({
      repo: pr.repo,
      number: pr.number,
      headSha: currentHeadSha,
      ...('verdict' in next ? { verdict: next.verdict } : {}),
      ...('body' in next ? { body: next.body } : {}),
    });
  };
  const ensureDraft = async () => draft ?? (await saveDraft());
  const onSelectionChange = (selection: SelectedLineRange | null) => {
    if (!selection || !activePath) return;
    const annotation = annotationFromSelection(selection);
    setComposer({ path: activePath, selection, annotation });
    setComposerBody('');
    setStatusMessage(null);
  };
  const submitComposer = async (event: FormEvent) => {
    event.preventDefault();
    if (!composer || composerBody.trim().length === 0) return;
    setStatusMessage(null);
    const nextDraft = await ensureDraft();
    await mutations.addComment.mutateAsync({
      repo: pr.repo,
      number: pr.number,
      draftId: nextDraft.id,
      path: composer.path,
      ...commentInputFromSelection(composer.selection),
      body: composerBody,
    });
    setComposer(null);
    setComposerBody('');
    setStatusMessage('Draft comment saved.');
  };
  const submitEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingCommentId || editingBody.trim().length === 0) return;
    setStatusMessage(null);
    await mutations.updateComment.mutateAsync({
      repo: pr.repo,
      number: pr.number,
      id: editingCommentId,
      body: editingBody,
    });
    setEditingCommentId(null);
    setEditingBody('');
  };
  const submitReply = async (threadId: string, event: FormEvent) => {
    event.preventDefault();
    if (replyBody.trim().length === 0) return;
    setStatusMessage(null);
    await mutations.replyToThread.mutateAsync({
      repo: pr.repo,
      number: pr.number,
      threadId,
      text: replyBody,
    });
    setReplyingThreadId(null);
    setReplyBody('');
    setStatusMessage('Thread reply posted.');
  };
  const renderAnnotation = (annotation: DiffReviewAnnotation) => {
    const metadata = annotation.metadata;
    if (metadata.kind === 'composer') {
      return (
        <form
          className="pr-review-composer"
          data-neondeck-review-annotation=""
          onSubmit={submitComposer}
        >
          <label className="sr-only" htmlFor="pr-review-new-comment">
            Draft review comment
          </label>
          <textarea
            id="pr-review-new-comment"
            onChange={(event) => setComposerBody(event.currentTarget.value)}
            placeholder="Draft an inline review comment"
            value={composerBody}
          />
          <div className="pr-review-composer-actions">
            <button
              disabled={
                composerBody.trim().length === 0 ||
                mutations.addComment.isPending ||
                mutations.saveDraft.isPending
              }
              type="submit"
            >
              Save
            </button>
            <button
              onClick={() => {
                setComposer(null);
                setComposerBody('');
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      );
    }

    if (metadata.kind === 'draft') {
      const comment = draft?.comments.find((item) => item.id === metadata.id);
      const isEditing = editingCommentId === metadata.id;
      return (
        <div
          className={metadata.isStale ? 'pr-review-draft-stale' : undefined}
          data-neondeck-review-annotation=""
        >
          <div data-neondeck-review-annotation-title="">
            <span>{metadata.isStale ? 'stale draft' : 'draft'}</span>
            <span>{metadata.title}</span>
          </div>
          {isEditing ? (
            <form className="pr-review-composer" onSubmit={submitEdit}>
              <textarea
                onChange={(event) => setEditingBody(event.currentTarget.value)}
                value={editingBody}
              />
              <div className="pr-review-composer-actions">
                <button
                  disabled={
                    editingBody.trim().length === 0 ||
                    mutations.updateComment.isPending
                  }
                  type="submit"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setEditingCommentId(null);
                    setEditingBody('');
                  }}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <p>{metadata.body}</p>
              <div className="pr-review-inline-actions">
                <button
                  onClick={() => {
                    setEditingCommentId(metadata.id);
                    setEditingBody(comment?.body ?? metadata.body);
                  }}
                  type="button"
                >
                  Edit
                </button>
                <button
                  disabled={mutations.deleteComment.isPending}
                  onClick={() => {
                    setStatusMessage(null);
                    mutations.deleteComment.mutate({
                      repo: pr.repo,
                      number: pr.number,
                      id: metadata.id,
                    });
                  }}
                  type="button"
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      );
    }

    const thread = reviewThreads.find((item) => item.id === metadata.id);
    const isReplying = replyingThreadId === metadata.id;
    return (
      <div data-neondeck-review-annotation="">
        <div data-neondeck-review-annotation-title="">
          <span>
            {metadata.authorLogin ? `@${metadata.authorLogin}` : 'review'}
          </span>
          <span>{metadata.title}</span>
        </div>
        <p>{metadata.body}</p>
        {isReplying ? (
          <form
            className="pr-review-composer"
            onSubmit={(event) => submitReply(metadata.id, event)}
          >
            <textarea
              onChange={(event) => setReplyBody(event.currentTarget.value)}
              placeholder="Reply to this thread"
              value={replyBody}
            />
            <div className="pr-review-composer-actions">
              <button
                disabled={
                  replyBody.trim().length === 0 ||
                  mutations.replyToThread.isPending
                }
                type="submit"
              >
                Reply
              </button>
              <button
                onClick={() => {
                  setReplyingThreadId(null);
                  setReplyBody('');
                }}
                type="button"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="pr-review-inline-actions">
            <button
              onClick={() => {
                setReplyingThreadId(metadata.id);
                setReplyBody('');
              }}
              type="button"
            >
              Reply
            </button>
            {thread ? (
              <button
                disabled={mutations.setThreadResolution.isPending}
                onClick={() => {
                  setStatusMessage(null);
                  mutations.setThreadResolution.mutate({
                    repo: pr.repo,
                    number: pr.number,
                    threadId: thread.id,
                    resolved: !thread.isResolved,
                  });
                }}
                type="button"
              >
                {thread.isResolved ? 'Unresolve' : 'Resolve'}
              </button>
            ) : null}
            {metadata.url ? (
              <a href={metadata.url} rel="noreferrer" target="_blank">
                open thread
              </a>
            ) : null}
          </div>
        )}
      </div>
    );
  };
  const submitReview = async () => {
    if (!currentHeadSha) return;
    setStatusMessage(null);
    const savedDraft =
      !draft ||
      draft.body !== reviewBody ||
      draft.verdict !== verdict ||
      draft.headSha !== currentHeadSha
        ? await saveDraft({ body: reviewBody, verdict })
        : draft;
    await mutations.submitReview.mutateAsync({
      repo: pr.repo,
      number: pr.number,
      draftId: savedDraft.id,
      headSha: currentHeadSha,
      commentIds: cleanCommentIds,
    });
    setStatusMessage('Review submitted.');
  };

  return (
    <section className="pr-review-shell">
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
        </div>
      </header>
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
          PR updated since your draft. {staleCommentIds.size} comment
          {staleCommentIds.size === 1 ? '' : 's'} need re-anchoring or will be
          skipped on submit.
        </div>
      ) : null}
      <MultiFileView
        activePath={activePath}
        annotationsByPath={annotationsByPath}
        detail={prDetail(pr, summary)}
        emptyLabel="No PR file patches available."
        files={files}
        footer={
          <ReviewThreadPanel
            activePath={activePath}
            isLoading={threadsQuery.isLoading}
            threads={selectedThreads}
          />
        }
        onSelectedLinesChange={onSelectionChange}
        onActivePathChange={setActivePath}
        renderAnnotation={renderAnnotation}
        selectedLines={
          composer?.path === activePath ? composer.selection : null
        }
        title={pr.title}
        tone="primary"
      />
      <ReviewBar
        cleanCommentCount={cleanCommentIds.length}
        draft={draft}
        isBusy={
          mutations.saveDraft.isPending ||
          mutations.submitReview.isPending ||
          mutations.discardDraft.isPending
        }
        onBodyBlur={() => {
          if (reviewBody.trim().length > 0 || draft) {
            void saveDraft({ body: reviewBody });
          }
        }}
        onBodyChange={setReviewBody}
        onDiscard={() => {
          if (!draft) return;
          setStatusMessage(null);
          const confirmed = window.confirm('Discard this PR review draft?');
          if (confirmed) {
            mutations.discardDraft.mutate({ repo: pr.repo, number: pr.number });
          }
        }}
        onSubmit={submitReview}
        onVerdictChange={(next) => {
          setVerdict(next);
          void saveDraft({ verdict: next });
        }}
        reviewBody={reviewBody}
        staleCommentCount={staleCommentIds.size}
        statusMessage={reviewBarStatusMessage}
        verdict={verdict}
      />
    </section>
  );
}

function annotationsFromThreads(threads: GitHubPullRequestReviewThread[]) {
  const annotations: Record<string, DiffReviewAnnotation[]> = {};
  for (const thread of threads) {
    const path = threadPath(thread);
    if (!path) continue;
    const annotation = annotationFromThread(thread);
    annotations[path] = [...(annotations[path] ?? []), annotation];
  }
  return annotations;
}

function annotationFromThread(
  thread: GitHubPullRequestReviewThread,
): DiffReviewAnnotation {
  const comment = latestComment(thread);
  const anchor = threadAnchor(thread);
  return {
    ...anchor,
    metadata: {
      id: thread.id,
      kind: 'thread',
      title: `${thread.comments.length} review comment${thread.comments.length === 1 ? '' : 's'}`,
      body: reviewCommentPreview(comment?.body ?? 'Review thread'),
      authorLogin: comment?.authorLogin ?? null,
      url: comment?.url ?? null,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
    },
  };
}

function annotationsFromDraft(
  draft: GitHubPrReviewDraft | null,
  staleCommentIds: Set<string>,
) {
  const annotations: Record<string, DiffReviewAnnotation[]> = {};
  for (const comment of draft?.comments ?? []) {
    const annotation = annotationFromDraftComment(
      comment,
      staleCommentIds.has(comment.id),
    );
    annotations[comment.path] = [
      ...(annotations[comment.path] ?? []),
      annotation,
    ];
  }
  return annotations;
}

function annotationsFromComposer(composer: ComposerState | null) {
  if (!composer) return {};
  return { [composer.path]: [composer.annotation] };
}

function annotationFromDraftComment(
  comment: GitHubPrReviewDraftComment,
  isStale: boolean,
): DiffReviewAnnotation {
  return {
    side: comment.side === 'LEFT' ? 'deletions' : 'additions',
    lineNumber: comment.line,
    metadata: {
      id: comment.id,
      kind: 'draft',
      title: commentAnchorLabel(comment),
      body: reviewCommentPreview(comment.body),
      isStale,
    },
  };
}

function mergeAnnotations(
  ...groups: Array<Record<string, DiffReviewAnnotation[]> | null | undefined>
) {
  const merged: Record<string, DiffReviewAnnotation[]> = {};
  for (const group of groups) {
    for (const [path, annotations] of Object.entries(group ?? {})) {
      merged[path] = [...(merged[path] ?? []), ...annotations];
    }
  }
  return merged;
}

function annotationFromSelection(
  selection: SelectedLineRange,
): DiffReviewAnnotation {
  const input = commentInputFromSelection(selection);
  return {
    side: input.side === 'LEFT' ? 'deletions' : 'additions',
    lineNumber: input.line,
    metadata: {
      id: 'composer',
      kind: 'composer',
      title: selectionLabel(selection),
      body: '',
    },
  };
}

function selectionLabel(selection: SelectedLineRange) {
  const input = commentInputFromSelection(selection);
  if (input.startLine) {
    return `${input.startSide} L${input.startLine} -> ${input.side} L${input.line}`;
  }
  return `${input.side} L${input.line}`;
}

function commentAnchorLabel(comment: GitHubPrReviewDraftComment) {
  if (comment.startLine) {
    return `${comment.startSide ?? comment.side} L${comment.startLine} -> ${comment.side} L${comment.line}`;
  }
  return `${comment.side} L${comment.line}`;
}

function threadAnchor(thread: GitHubPullRequestReviewThread) {
  const side: DiffReviewAnnotation['side'] =
    thread.diffSide === 'LEFT' ? 'deletions' : 'additions';
  if (side === 'deletions') {
    const line =
      positiveLine(thread.originalLine) ??
      positiveLine(latestComment(thread)?.originalLine) ??
      positiveLine(thread.line) ??
      positiveLine(latestComment(thread)?.line);
    return { side, lineNumber: line ?? 0 };
  }

  const line =
    positiveLine(thread.line) ?? positiveLine(latestComment(thread)?.line);
  return { side, lineNumber: line ?? 0 };
}

function threadsForPath(
  threads: GitHubPullRequestReviewThread[],
  path: string | null,
) {
  if (!path) return [];
  return threads.filter((thread) => threadPath(thread) === path);
}

function threadPath(thread: GitHubPullRequestReviewThread) {
  return (
    thread.path ?? thread.comments.find((comment) => comment.path)?.path ?? null
  );
}

function latestComment(thread: GitHubPullRequestReviewThread) {
  return thread.comments.at(-1) ?? thread.comments[0] ?? null;
}

function positiveLine(value: number | null | undefined) {
  return typeof value === 'number' && value > 0 ? value : null;
}

function ReviewBar({
  cleanCommentCount,
  draft,
  isBusy,
  onBodyBlur,
  onBodyChange,
  onDiscard,
  onSubmit,
  onVerdictChange,
  reviewBody,
  staleCommentCount,
  statusMessage,
  verdict,
}: {
  cleanCommentCount: number;
  draft: GitHubPrReviewDraft | null;
  isBusy: boolean;
  onBodyBlur: () => void;
  onBodyChange: (value: string) => void;
  onDiscard: () => void;
  onSubmit: () => void;
  onVerdictChange: (value: GitHubPrReviewVerdict) => void;
  reviewBody: string;
  staleCommentCount: number;
  statusMessage: string | null;
  verdict: GitHubPrReviewVerdict;
}) {
  const hasBody = reviewBody.trim().length > 0;
  const canSubmit =
    !isBusy && (verdict === 'approve' || cleanCommentCount > 0 || hasBody);

  return (
    <aside className="pr-review-bar">
      <div className="pr-review-bar-main">
        <button className="pr-review-count" type="button">
          {cleanCommentCount} pending
        </button>
        {staleCommentCount > 0 ? (
          <span className="pr-review-stale-count">
            {staleCommentCount} stale skipped
          </span>
        ) : null}
        <fieldset className="pr-review-verdicts">
          <legend className="sr-only">Review verdict</legend>
          {(['comment', 'approve', 'request-changes'] as const).map((item) => (
            <button
              aria-pressed={verdict === item}
              key={item}
              onClick={() => onVerdictChange(item)}
              type="button"
            >
              {verdictLabel(item)}
            </button>
          ))}
        </fieldset>
      </div>
      <label className="sr-only" htmlFor="pr-review-summary-body">
        Review summary
      </label>
      <textarea
        id="pr-review-summary-body"
        onBlur={onBodyBlur}
        onChange={(event) => onBodyChange(event.currentTarget.value)}
        placeholder="Review summary"
        value={reviewBody}
      />
      <div className="pr-review-bar-actions">
        <button disabled={!canSubmit} onClick={onSubmit} type="button">
          Submit
        </button>
        <button disabled={!draft || isBusy} onClick={onDiscard} type="button">
          Discard
        </button>
      </div>
      {statusMessage ? <p>{statusMessage}</p> : null}
    </aside>
  );
}

function verdictLabel(value: GitHubPrReviewVerdict) {
  if (value === 'approve') return 'Approve';
  if (value === 'request-changes') return 'Request changes';
  return 'Comment';
}

function mutationErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const data = error.data as
      | GitHubPrReviewDraftResponse
      | GitHubPrReviewSubmitResponse
      | GitHubPrThreadMutationResponse
      | undefined;
    const details = [
      ...(data?.errors ?? []),
      ...(data?.requires?.length
        ? [`Requires: ${data.requires.join(', ')}`]
        : []),
      ...(data?.data &&
      'failingCommentIds' in data.data &&
      Array.isArray(data.data.failingCommentIds) &&
      data.data.failingCommentIds.length > 0
        ? [`Failing comments: ${data.data.failingCommentIds.join(', ')}`]
        : []),
    ];
    return details.length > 0
      ? `${error.message} ${details.join(' ')}`
      : error.message;
  }
  return error ? queryErrorMessage(error) : null;
}

function ReviewThreadPanel({
  activePath,
  isLoading,
  threads,
}: {
  activePath: string | null;
  isLoading: boolean;
  threads: GitHubPullRequestReviewThread[];
}) {
  if (isLoading) {
    return (
      <p
        aria-live="polite"
        className="border-x border-b border-line bg-field px-2 py-1 font-mono text-[10px] text-muted"
      >
        Loading review threads...
      </p>
    );
  }

  if (!activePath || threads.length === 0) {
    return (
      <p className="border-x border-b border-line bg-field px-2 py-1 font-mono text-[10px] text-muted">
        No review threads for this file.
      </p>
    );
  }

  return (
    <div className="border-x border-b border-line bg-field">
      <div className="flex items-center justify-between border-b border-line px-2 py-1 font-mono text-[10px] text-muted">
        <span>review threads</span>
        <span className="text-primary">
          {threads.filter((thread) => !thread.isResolved).length}/
          {threads.length} unresolved
        </span>
      </div>
      <ul className="max-h-40 overflow-auto">
        {threads.map((thread) => {
          const comment = latestComment(thread);
          return (
            <li
              className="border-b border-line px-2 py-2 last:border-b-0"
              key={thread.id}
            >
              <div className="mb-1 flex items-center justify-between gap-2 font-mono text-[10px] text-muted">
                <span>
                  {comment?.authorLogin ? `@${comment.authorLogin}` : 'review'}
                </span>
                <span>
                  {thread.line
                    ? `L${thread.line}`
                    : comment?.originalLine
                      ? `old L${comment.originalLine}`
                      : 'file'}
                </span>
              </div>
              <p className="line-clamp-3 text-[11px] leading-4 text-ink">
                {reviewCommentPreview(comment?.body ?? 'Review thread')}
              </p>
              {comment?.url ? (
                <a
                  className="mt-1 inline-flex font-mono text-[10px] text-primary hover:text-primary-strong focus:outline-none focus:ring-1 focus:ring-primary"
                  href={comment.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  open thread
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function prDetail(pr: GitHubPullRequest, summary: DiffSummary | undefined) {
  const sha = pr.headSha ? pr.headSha.slice(0, 7) : 'head unknown';
  const files = summary ? `${summary.files} files` : 'files';
  return `${pr.baseRef ?? 'base'} <- ${sha} - ${files}`;
}

function summaryLabel(summary: DiffSummary) {
  return `+${summary.additions} -${summary.deletions}`;
}

function reviewFileStats(files: DiffFilePatch[]) {
  return {
    binary: files.filter((file) => file.binary).length,
    truncated: files.filter((file) => file.truncated).length,
  };
}

function reviewCommentPreview(value: string) {
  const preview = value
    .split(/\n\s*Useful\? React with/i)[0]
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return preview || 'Review thread';
}

function checkLabel(pr: GitHubPullRequest) {
  if (pr.checkError) return 'checks unknown';
  if (!pr.checks) return 'checks unknown';
  if (pr.checks.status === 'success') return 'checks pass';
  if (pr.checks.status === 'failure') return `${pr.checks.failed} failed`;
  if (pr.checks.status === 'pending') return `${pr.checks.pending} pending`;
  return 'no checks';
}

function checkBadgeClass(pr: GitHubPullRequest) {
  if (pr.checks?.status === 'failure') return 'border-accent text-accent';
  if (pr.checks?.status === 'pending') return 'border-violet text-violet';
  if (pr.checks?.status === 'success') return 'border-primary text-primary';
  return '';
}

export function hasRenderablePrPatch(files: DiffFilePatch[]) {
  return files.some((file) => patchHasContent(file.patch));
}
