import type {
  GitHubPrReviewDraft,
  GitHubPrReviewDraftComment,
  GitHubPullRequestReviewThread,
  PrReviewRecord,
  PrReviewReportOnlyFinding,
} from '../../api';
import { Badge } from '../../components/ui';
import type { DiffFilePatch } from '../diff-viewer/types';
import { reviewCommentPreview } from './review-helpers';
import {
  commentAnchorLabel,
  latestThreadComment,
  threadPath,
} from './review-ui-helpers';

export type PrReviewFindingsSidebarProps = {
  activePath: string | null;
  cleanCommentCount: number;
  draft: GitHubPrReviewDraft | null;
  files: DiffFilePatch[];
  isDeleting: boolean;
  isLoadingThreads: boolean;
  onChooseLine: (finding: PrReviewReportOnlyFinding) => void;
  onDelete: (commentId: string) => void;
  onReanchor: (comment: GitHubPrReviewDraftComment) => void;
  review: PrReviewRecord | null;
  reviewThreads: GitHubPullRequestReviewThread[];
  staleCommentCount: number;
  staleDraftComments: GitHubPrReviewDraftComment[];
  unresolvedThreads: GitHubPullRequestReviewThread[];
};

export function PrReviewFindingsSidebar({
  variant,
  ...props
}: PrReviewFindingsSidebarProps & {
  variant: 'compact' | 'embedded' | 'inspector';
}) {
  const panels = <FindingsPanels {...props} />;

  if (variant === 'embedded') return panels;
  if (variant === 'compact') {
    return (
      <div
        aria-label="Collapsed PR review details"
        className="pr-review-compact-panels"
      >
        {panels}
      </div>
    );
  }

  const reviewedFileCount = new Set([
    ...props.reviewThreads
      .map(threadPath)
      .filter((path): path is string => Boolean(path)),
    ...(props.draft?.comments.map((comment) => comment.path) ?? []),
  ]).size;
  return (
    <div className="pr-review-inspector">
      <section className="pr-review-inspector-section">
        <div className="pr-review-inspector-heading">
          <span>Review focus</span>
          <span>{props.activePath ? 'active file' : 'no file'}</span>
        </div>
        <p className="pr-review-inspector-path">
          {props.activePath ?? 'Select a changed file to review.'}
        </p>
        <div className="pr-review-inspector-metrics">
          <span>{props.files.length} files</span>
          <span>{reviewedFileCount} touched</span>
          <span>
            {props.unresolvedThreads.length}/{props.reviewThreads.length}{' '}
            threads
          </span>
          <span>{props.cleanCommentCount} pending</span>
          {props.staleCommentCount > 0 ? (
            <span>{props.staleCommentCount} stale</span>
          ) : null}
        </div>
      </section>
      <section className="pr-review-inspector-section">
        <div className="pr-review-inspector-heading">
          <span>Line review</span>
          <span>select diff lines</span>
        </div>
        <p className="pr-review-inspector-copy">
          Select a changed line or range in the diff to draft an inline review
          comment. Saved drafts stay local until the review is submitted.
        </p>
      </section>
      {panels}
    </div>
  );
}

function FindingsPanels(props: PrReviewFindingsSidebarProps) {
  return (
    <>
      <ReviewThreadPanel
        activePath={props.activePath}
        isLoading={props.isLoadingThreads}
        threads={threadsForPath(props.reviewThreads, props.activePath)}
      />
      <StaleDraftCommentPanel
        comments={props.staleDraftComments}
        isDeleting={props.isDeleting}
        onDelete={props.onDelete}
        onReanchor={props.onReanchor}
      />
      <ReportOnlyFindingPanel
        draft={props.draft}
        onChooseLine={props.onChooseLine}
        review={props.review}
      />
    </>
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
          const comment = latestThreadComment(thread);
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

function StaleDraftCommentPanel({
  comments,
  isDeleting,
  onDelete,
  onReanchor,
}: {
  comments: GitHubPrReviewDraftComment[];
  isDeleting: boolean;
  onDelete: (commentId: string) => void;
  onReanchor: (comment: GitHubPrReviewDraftComment) => void;
}) {
  if (comments.length === 0) return null;

  return (
    <div className="border-x border-b border-line bg-field">
      <div className="flex items-center justify-between border-b border-line px-2 py-1 font-mono text-[10px] text-muted">
        <span>stale draft comments</span>
        <span className="text-accent">{comments.length} skipped</span>
      </div>
      <ul className="max-h-40 overflow-auto">
        {comments.map((comment) => (
          <li
            className="border-b border-line px-2 py-2 last:border-b-0"
            key={comment.id}
          >
            <div className="mb-1 flex items-center justify-between gap-2 font-mono text-[10px] text-muted">
              <span className="min-w-0 truncate">
                {comment.origin === 'neon' ? 'neon · ' : ''}
                {comment.path}
              </span>
              <span className="shrink-0">{commentAnchorLabel(comment)}</span>
            </div>
            <p className="line-clamp-2 text-[11px] leading-4 text-ink">
              {reviewCommentPreview(comment.body)}
            </p>
            <div className="pr-review-inline-actions mt-1.5">
              <button onClick={() => onReanchor(comment)} type="button">
                Re-anchor
              </button>
              <button
                disabled={isDeleting}
                onClick={() => onDelete(comment.id)}
                type="button"
              >
                {isDeleting ? 'Deleting' : 'Delete'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReportOnlyFindingPanel({
  draft,
  onChooseLine,
  review,
}: {
  draft: GitHubPrReviewDraft | null;
  onChooseLine: (finding: PrReviewReportOnlyFinding) => void;
  review: PrReviewRecord | null;
}) {
  if (!review?.reportOnlyFindings.length) return null;
  return (
    <section className="pr-review-inspector-section">
      <div className="pr-review-inspector-heading">
        <span>Report-only — couldn&apos;t anchor to a line</span>
        <Badge>{review.reportOnlyFindings.length}</Badge>
      </div>
      <div className="divide-y divide-line border-t border-line">
        {review.reportOnlyFindings.map((finding, index) => {
          const drafted = isReportOnlyFindingDrafted(draft, finding);
          return (
            <article
              className="py-2"
              key={
                finding.sourceId ?? `${finding.path}:${finding.line}:${index}`
              }
            >
              <p className="font-mono text-[10px] text-primary">
                {finding.severity} · {finding.path}
                {finding.line ? `:${finding.line}` : ''}
              </p>
              <p className="mt-1 text-[10.5px] leading-4 text-ink">
                {finding.summary}
              </p>
              <p className="mt-1 text-[10px] leading-4 text-muted">
                Suggested fix: {finding.suggestedFix}
              </p>
              <p className="mt-1 font-mono text-[9.5px] leading-4 text-muted">
                Unanchored: {finding.reason}
              </p>
              <button
                className="mt-1.5 border border-line px-1.5 py-1 font-mono text-[10px] text-muted hover:border-primary hover:text-primary disabled:opacity-50"
                disabled={drafted}
                onClick={() => onChooseLine(finding)}
                type="button"
              >
                {drafted ? 'drafted inline' : 'choose line'}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function threadsForPath(
  threads: GitHubPullRequestReviewThread[],
  path: string | null,
) {
  if (!path) return [];
  return threads.filter((thread) => threadPath(thread) === path);
}

export function reportOnlyFindingBody(finding: PrReviewReportOnlyFinding) {
  return [
    `Neon review finding (${finding.severity}): ${finding.summary}`,
    '',
    `Suggested fix: ${finding.suggestedFix}`,
    '',
    'Manually anchored from a report-only finding. Edit or delete before submitting the review.',
  ].join('\n');
}

export function isReportOnlyFindingDrafted(
  draft: GitHubPrReviewDraft | null,
  finding: PrReviewReportOnlyFinding,
) {
  const generatedBody = reportOnlyFindingBody(finding);
  return Boolean(
    draft?.comments.some(
      (comment) =>
        comment.path === finding.path &&
        (finding.sourceId
          ? comment.sourceFindingId === finding.sourceId
          : comment.body === generatedBody),
    ),
  );
}
