import { useEffect, useMemo, useState } from 'react';
import type {
  DiffSummary,
  GitHubPullRequest,
  GitHubPullRequestReviewThread,
} from '../../api';
import { Badge, MiniEmpty } from '../../components/ui';
import { queryErrorMessage } from '../../lib/query';
import { firstRenderablePath, patchHasContent } from '../diff-viewer/helpers';
import { MultiFileView } from '../diff-viewer/MultiFileView';
import type { DiffFilePatch, DiffReviewAnnotation } from '../diff-viewer/types';
import { useGitHubPrReviewThreads, useGitHubPullRequestFiles } from './queries';

export function GitHubPrReview({ pr }: { pr: GitHubPullRequest }) {
  const filesQuery = useGitHubPullRequestFiles(pr);
  const threadsQuery = useGitHubPrReviewThreads(pr);
  const files = useMemo(
    () => (filesQuery.data?.files ?? []) as DiffFilePatch[],
    [filesQuery.data?.files],
  );
  const [activePath, setActivePath] = useState<string | null>(null);
  const reviewThreads = useMemo(
    () => threadsQuery.data?.reviewThreads ?? [],
    [threadsQuery.data?.reviewThreads],
  );
  const unresolvedThreads = useMemo(
    () => threadsQuery.data?.unresolvedReviewThreads ?? [],
    [threadsQuery.data?.unresolvedReviewThreads],
  );
  const annotationsByPath = useMemo(
    () => annotationsFromThreads(unresolvedThreads),
    [unresolvedThreads],
  );
  const selectedThreads = useMemo(
    () => threadsForPath(unresolvedThreads, activePath),
    [activePath, unresolvedThreads],
  );

  useEffect(() => {
    if (activePath && files.some((file) => file.path === activePath)) return;
    setActivePath(firstRenderablePath(files) ?? null);
  }, [activePath, files]);

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
        </div>
      </header>
      {threadsQuery.error ? (
        <MiniEmpty
          label={`Review threads unavailable: ${queryErrorMessage(threadsQuery.error)}`}
        />
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
        onActivePathChange={setActivePath}
        renderAnnotation={renderReviewAnnotation}
        title={pr.title}
        tone="primary"
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
      title: `${thread.comments.length} review comment${thread.comments.length === 1 ? '' : 's'}`,
      body: comment?.body ?? 'Review thread',
      authorLogin: comment?.authorLogin ?? null,
      url: comment?.url ?? null,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
    },
  };
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

function renderReviewAnnotation(annotation: DiffReviewAnnotation) {
  const metadata = annotation.metadata;
  return (
    <div data-neondeck-review-annotation="">
      <div data-neondeck-review-annotation-title="">
        <span>
          {metadata.authorLogin ? `@${metadata.authorLogin}` : 'review'}
        </span>
        <span>{metadata.title}</span>
      </div>
      <p>{metadata.body}</p>
      {metadata.url ? (
        <a href={metadata.url} rel="noreferrer" target="_blank">
          open thread
        </a>
      ) : null}
    </div>
  );
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
      <p className="border-x border-b border-line bg-field px-2 py-1 font-mono text-[10px] text-muted">
        Loading review threads...
      </p>
    );
  }

  if (!activePath || threads.length === 0) {
    return (
      <p className="border-x border-b border-line bg-field px-2 py-1 font-mono text-[10px] text-muted">
        No unresolved review threads for this file.
      </p>
    );
  }

  return (
    <div className="border-x border-b border-line bg-field">
      <div className="flex items-center justify-between border-b border-line px-2 py-1 font-mono text-[10px] text-muted">
        <span>review threads</span>
        <span className="text-primary">{threads.length} unresolved</span>
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
                {comment?.body ?? 'Review thread'}
              </p>
              {comment?.url ? (
                <a
                  className="mt-1 inline-flex font-mono text-[10px] text-primary hover:text-primary-strong"
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
