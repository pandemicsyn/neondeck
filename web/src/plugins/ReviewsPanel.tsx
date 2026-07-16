import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  getPrReviews,
  openPrReviewEventStream,
  reconcilePrReviewSubmission,
  restartPrReview,
  startPrReview,
  type PrReviewAwaitingItem,
  type PrReviewRecord,
  type PrReviewsResponse,
} from '../api';
import { Badge, Button, EmptyState, ScrollArea } from '../components/ui';
import { PrReviewArtifactsOverlay } from '../features/pr-review/PrReviewArtifactsOverlay';
import { relativeTime } from '../lib/format';
import { queryErrorMessage, queryKeys } from '../lib/query';
import type { DisplayPlugin } from '../types';

export const ReviewsPanelPlugin = {
  id: 'reviews-panel',
  title: 'Reviews',
  kind: 'data',
  defaultConfig: {},
  Component() {
    const queryClient = useQueryClient();
    const [adding, setAdding] = useState(false);
    const [ref, setRef] = useState('');
    const { data, error, isLoading } = useQuery({
      queryKey: queryKeys.prReviews,
      queryFn: ({ signal }) => getPrReviews({}, { signal }),
    });
    const startMutation = useMutation({
      mutationFn: (reviewRef: string) =>
        startPrReview({ ref: reviewRef, origin: 'panel' }),
      onSuccess(result) {
        queryClient.setQueryData<PrReviewsResponse>(
          queryKeys.prReviews,
          (current) => applyPrReviewChange(current, result.review),
        );
        setRef('');
        setAdding(false);
      },
    });
    const restartMutation = useMutation({
      mutationFn: (id: string) => restartPrReview(id),
      onSuccess(result) {
        queryClient.setQueryData<PrReviewsResponse>(
          queryKeys.prReviews,
          (current) => applyPrReviewChange(current, result.review),
        );
      },
    });
    const reconcileMutation = useMutation({
      mutationFn: (id: string) => reconcilePrReviewSubmission(id),
      onSuccess(result) {
        queryClient.setQueryData<PrReviewsResponse>(
          queryKeys.prReviews,
          (current) => applyPrReviewChange(current, result.review),
        );
      },
    });

    useEffect(
      () =>
        openPrReviewEventStream(
          (event) => {
            queryClient.setQueryData<PrReviewsResponse>(
              queryKeys.prReviews,
              (current) => applyPrReviewChange(current, event.review),
            );
          },
          undefined,
          () => {
            void queryClient.invalidateQueries({
              queryKey: queryKeys.prReviews,
            });
          },
        ),
      [queryClient],
    );

    const submit = (event: FormEvent) => {
      event.preventDefault();
      const value = ref.trim();
      if (value) startMutation.mutate(value);
    };

    return (
      <div className="terminal-list flex h-full min-h-0 flex-col">
        <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3 font-mono text-[10.5px] tracking-[0.12em]">
          <span className="flex items-center gap-2 text-primary">
            <span className="h-1.5 w-1.5 bg-primary" />
            REVIEWS
          </span>
          <Button
            aria-expanded={adding}
            className="min-h-[24px] bg-transparent px-2 py-0 text-[10px]"
            onClick={() => setAdding((value) => !value)}
            type="button"
          >
            {adding ? 'cancel' : '+ review a PR'}
          </Button>
        </header>
        {adding ? (
          <form
            className="flex gap-2 border-b border-line bg-field p-2"
            onSubmit={submit}
          >
            <label className="sr-only" htmlFor="pr-review-ref">
              Pull request URL or reference
            </label>
            <input
              className="h-7 min-w-0 flex-1 border border-line bg-canvas px-2 font-mono text-[11px] text-ink outline-none placeholder:text-muted focus:border-primary"
              id="pr-review-ref"
              onChange={(event) => setRef(event.currentTarget.value)}
              placeholder="owner/repo#101 or GitHub URL"
              value={ref}
            />
            <Button
              disabled={!ref.trim() || startMutation.isPending}
              type="submit"
            >
              {startMutation.isPending ? 'starting' : 'start'}
            </Button>
          </form>
        ) : null}
        {startMutation.error ||
        restartMutation.error ||
        reconcileMutation.error ? (
          <p className="border-b border-accent/60 px-3 py-1.5 font-mono text-[10px] text-accent">
            {queryErrorMessage(
              startMutation.error ??
                restartMutation.error ??
                reconcileMutation.error,
            )}
          </p>
        ) : null}
        {isLoading ? (
          <EmptyState
            title="Reviews loading"
            detail="Reading the local review inbox."
          />
        ) : null}
        {error ? (
          <EmptyState
            title="Reviews unavailable"
            detail={queryErrorMessage(error)}
            tone="alert"
          />
        ) : null}
        {data ? (
          <ScrollArea className="flex-1">
            <div className="divide-y divide-line">
              <ReviewSection
                empty="No pull requests are requesting your review."
                title="AWAITING YOUR REVIEW"
              >
                {data.groups.awaiting.map((item) => (
                  <AwaitingRow
                    item={item}
                    key={`${item.pullRequest.repo}#${item.pullRequest.number}`}
                    onRestart={(id) => restartMutation.mutate(id)}
                    onStart={(reviewRef) => startMutation.mutate(reviewRef)}
                    pending={
                      startMutation.isPending || restartMutation.isPending
                    }
                  />
                ))}
              </ReviewSection>
              <ReviewSection
                empty="No reviews are running."
                title="IN PROGRESS"
              >
                {data.groups.inProgress.map((review) => (
                  <ReviewRow
                    key={review.id}
                    onReconcile={(id) => reconcileMutation.mutate(id)}
                    pending={reconcileMutation.isPending}
                    review={review}
                  />
                ))}
              </ReviewSection>
              <ReviewSection
                empty="No prepared reviews need action."
                title="NEEDS ACTION"
              >
                {data.groups.needsAction.map((review) => (
                  <ReviewRow
                    key={review.id}
                    onRestart={(id) => restartMutation.mutate(id)}
                    pending={restartMutation.isPending}
                    review={review}
                  />
                ))}
              </ReviewSection>
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 font-mono text-[10px] tracking-[0.08em] text-muted focus:outline-none focus:ring-1 focus:ring-primary">
                  <span>SUBMITTED</span>
                  <Badge>{data.groups.submitted.length} · 7D</Badge>
                </summary>
                <div className="border-t border-line">
                  {data.groups.submitted.length ? (
                    data.groups.submitted.map((review) => (
                      <ReviewRow key={review.id} review={review} />
                    ))
                  ) : (
                    <p className="px-3 py-2 text-[10.5px] text-muted">
                      No reviews submitted in the last seven days.
                    </p>
                  )}
                </div>
              </details>
            </div>
          </ScrollArea>
        ) : null}
      </div>
    );
  },
} satisfies DisplayPlugin<Record<string, never>>;

function ReviewSection({
  children,
  empty,
  title,
}: {
  children: ReactNode;
  empty: string;
  title: string;
}) {
  const count = Array.isArray(children) ? children.length : children ? 1 : 0;
  return (
    <section>
      <div className="flex items-center justify-between bg-field px-3 py-1.5 font-mono text-[10px] tracking-[0.08em] text-muted">
        <h3>{title}</h3>
        <span className="tabular-nums">{count}</span>
      </div>
      <div className="divide-y divide-line">
        {count ? (
          children
        ) : (
          <p className="px-3 py-2 text-[10.5px] text-muted">{empty}</p>
        )}
      </div>
    </section>
  );
}

function AwaitingRow({
  item,
  onRestart,
  onStart,
  pending,
}: {
  item: PrReviewAwaitingItem;
  onRestart: (id: string) => void;
  onStart: (ref: string) => void;
  pending: boolean;
}) {
  const { pullRequest, review } = item;
  const headAdvanced = Boolean(
    review?.headSha &&
    pullRequest.headSha &&
    review.headSha !== pullRequest.headSha,
  );
  return (
    <article className="px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {pullRequest.repo}#{pullRequest.number}
          </p>
          <p className="mt-0.5 truncate text-[10.5px] text-muted">
            @{pullRequest.author} · {pullRequest.title}
          </p>
          <p className="mt-1 font-mono text-[10px] text-primary">
            {review?.status === 'ready'
              ? `Neon draft ready · ${review.seededCount}`
              : review?.status === 'reviewing'
                ? 'Neon is reviewing…'
                : review?.status === 'submitting'
                  ? 'Submitting review to GitHub…'
                  : headAdvanced
                    ? 'New commits since your review'
                    : 'No Neon draft yet'}
          </p>
        </div>
        {review?.status === 'ready' && !headAdvanced ? (
          <OpenReviewButton review={review} />
        ) : review &&
          review.status !== 'reviewing' &&
          review.status !== 'submitting' &&
          headAdvanced ? (
          <Button
            disabled={pending}
            onClick={() => onRestart(review.id)}
            type="button"
          >
            re-review
          </Button>
        ) : review?.status === 'reviewing' ||
          review?.status === 'submitting' ? (
          <Badge>{review.status}</Badge>
        ) : (
          <Button
            disabled={pending}
            onClick={() => onStart(`${pullRequest.repo}#${pullRequest.number}`)}
            type="button"
          >
            review
          </Button>
        )}
      </div>
    </article>
  );
}

function ReviewRow({
  onReconcile,
  onRestart,
  pending = false,
  review,
}: {
  onReconcile?: (id: string) => void;
  onRestart?: (id: string) => void;
  pending?: boolean;
  review: PrReviewRecord;
}) {
  const [artifactIndex, setArtifactIndex] = useState<number | null>(null);
  return (
    <article className="px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {review.repoFullName}#{review.prNumber}
          </p>
          <p className="mt-0.5 truncate text-[10.5px] text-muted">
            {review.title}
          </p>
          <p className="mt-1 font-mono text-[10px] text-primary">
            {reviewStatusLine(review)}
          </p>
          {review.status === 'ready' ? (
            <p className="mt-1 max-w-[65ch] text-[10px] leading-4 text-muted">
              {review.trustBoundary}
            </p>
          ) : null}
        </div>
        <Badge>{review.status}</Badge>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center justify-end gap-1.5 font-mono text-[10px]">
        {review.reportIds.map((reportId, index) => (
          <button
            className="border border-line px-1.5 py-1 text-muted hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary"
            key={reportId}
            onClick={() => setArtifactIndex(index)}
            type="button"
          >
            {index === 0
              ? 'overview'
              : index === 1
                ? 'issues'
                : `report ${index + 1}`}
          </button>
        ))}
        {review.status === 'ready' || review.status === 'submitted' ? (
          <OpenReviewButton review={review} />
        ) : null}
        {review.status === 'failed' && onRestart ? (
          <Button
            disabled={pending}
            onClick={() => onRestart(review.id)}
            type="button"
          >
            retry
          </Button>
        ) : null}
        {review.status === 'submitting' && onReconcile ? (
          <Button
            disabled={pending}
            onClick={() => onReconcile(review.id)}
            type="button"
          >
            {pending ? 'checking' : 'recover submission'}
          </Button>
        ) : null}
      </div>
      {artifactIndex !== null ? (
        <PrReviewArtifactsOverlay
          initialReportIndex={artifactIndex}
          onClose={() => setArtifactIndex(null)}
          reportIds={review.reportIds}
          reviewLabel={`${review.repoFullName}#${review.prNumber}`}
          reviewUrl={review.reviewUrl}
        />
      ) : null}
    </article>
  );
}

function OpenReviewButton({ review }: { review: PrReviewRecord }) {
  return (
    <a
      className="inline-flex min-h-[26px] items-center border border-primary px-2 py-1 font-mono text-[10px] text-primary focus:outline-none focus:ring-1 focus:ring-primary"
      href={review.reviewUrl}
      rel="noreferrer"
      target="_blank"
    >
      open review
    </a>
  );
}

function reviewStatusLine(review: PrReviewRecord) {
  if (review.status === 'reviewing') return 'reviewing…';
  if (review.status === 'submitting') return 'submitting to GitHub…';
  if (review.status === 'failed')
    return review.failureMessage ?? 'Review failed.';
  if (review.status === 'submitted') {
    return `${review.verdict ?? 'submitted'} · ${relativeTime(review.submittedAt ?? review.updatedAt)}`;
  }
  return `${review.findingCount} findings · ${review.seededCount} drafts${review.reportOnlyCount ? ` · ${review.reportOnlyCount} report-only` : ''}`;
}

export function applyPrReviewChange(
  current: PrReviewsResponse | undefined,
  review: PrReviewRecord,
): PrReviewsResponse {
  const items = current
    ? [review, ...current.items.filter((item) => item.id !== review.id)].sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      )
    : [review];
  const awaiting = (current?.groups.awaiting ?? []).map((item) =>
    item.pullRequest.repo.toLowerCase() === review.repoFullName.toLowerCase() &&
    item.pullRequest.number === review.prNumber
      ? { ...item, review }
      : item,
  );
  return {
    ok: true,
    action: 'pr_reviews_list',
    changed: false,
    items,
    groups: {
      awaiting,
      inProgress: items.filter(
        (item) => item.status === 'reviewing' || item.status === 'submitting',
      ),
      needsAction: items.filter(
        (item) => item.status === 'ready' || item.status === 'failed',
      ),
      submitted: items.filter((item) => item.status === 'submitted'),
    },
    queueIssues: current?.queueIssues,
  };
}
