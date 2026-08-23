import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Children,
  useCallback,
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  archivePrReview,
  getPrReviews,
  openPrReviewEventStream,
  restartPrReview,
  restorePrReview,
  startPrReview,
  type PrReviewAwaitingItem,
  type PrReviewRecord,
  type PrReviewsResponse,
} from '../api';
import { Badge, Button, EmptyState, ScrollArea } from '../components/ui';
import { PrReviewBriefingOverlay } from '../features/pr-review/PrReviewBriefing';
import {
  prReviewDraftQueryOptions,
  useGitHubPrReviewDraft,
} from '../features/pr-review/queries';
import {
  synchronizePrReviewSubmissionLock,
  usePrReviewBriefingActions,
} from '../features/pr-review/usePrReviewBriefingActions';
import { useTransientPrReviewReconciliation } from '../features/pr-review/useTransientPrReviewReconciliation';
import { reviewRecommendationLabel as briefingRecommendationLabel } from '../features/pr-review/review-ui-helpers';
import { relativeTime } from '../lib/format';
import { useDashboardEventConnectionState } from '../lib/dashboard-connection';
import { actionErrorMessage, queryErrorMessage, queryKeys } from '../lib/query';
import type { DisplayPlugin } from '../types';

export const ReviewsPanelPlugin = {
  id: 'reviews-panel',
  title: 'Reviews',
  kind: 'data',
  defaultConfig: {},
  Component() {
    const queryClient = useQueryClient();
    const eventConnection = useDashboardEventConnectionState();
    const [adding, setAdding] = useState(false);
    const [ref, setRef] = useState('');
    const [briefingReviewId, setBriefingReviewId] = useState<string | null>(
      null,
    );
    const [actionError, setActionError] = useState<PanelActionError | null>(
      null,
    );
    const { data, error, isLoading } = useQuery({
      queryKey: queryKeys.prReviews,
      queryFn: ({ signal }) => getPrReviews({}, { signal }),
    });
    const { data: localData } = useQuery({
      queryKey: queryKeys.prReviewsLocal,
      queryFn: ({ signal }) => getPrReviews({ localOnly: true }, { signal }),
      refetchInterval: eventConnection === 'open' ? false : 5_000,
      refetchIntervalInBackground: eventConnection !== 'open',
    });
    useEffect(() => {
      if (!localData) return;
      queryClient.setQueryData<PrReviewsResponse>(
        queryKeys.prReviews,
        (current) => applyPrReviewSnapshot(current, localData),
      );
    }, [localData, queryClient]);
    useEffect(() => {
      for (const review of data?.items ?? []) {
        synchronizePrReviewSubmissionLock(review);
      }
    }, [data?.items]);

    const updateReviewCaches = useCallback(
      (review: PrReviewRecord) => {
        for (const queryKey of [
          queryKeys.prReviews,
          queryKeys.prReviewsLocal,
        ]) {
          queryClient.setQueryData<PrReviewsResponse>(queryKey, (current) =>
            applyPrReviewChange(current, review),
          );
        }
      },
      [queryClient],
    );
    const clearActionError = useCallback(
      (action: PanelMutationAction, variables: string) => {
        const targetKey = panelMutationTargetKey(action, variables);
        setActionError((current) =>
          current?.targetKey === targetKey ? null : current,
        );
      },
      [],
    );
    const recordActionError = useCallback(
      (action: PanelMutationAction, variables: string, error: unknown) => {
        setActionError({
          error,
          targetKey: panelMutationTargetKey(action, variables),
        });
      },
      [],
    );
    const startMutation = useMutation({
      mutationKey: panelMutationKey('start'),
      mutationFn: (reviewRef: string) =>
        startPrReview({ ref: reviewRef, origin: 'panel' }),
      async onMutate(reviewRef) {
        clearActionError('start', reviewRef);
        await Promise.all([
          queryClient.cancelQueries({ queryKey: queryKeys.prReviews }),
          queryClient.cancelQueries({ queryKey: queryKeys.prReviewsLocal }),
        ]);
      },
      onError(error, reviewRef) {
        recordActionError('start', reviewRef, error);
      },
      onSuccess(result) {
        updateReviewCaches(result.review);
        setRef('');
        setAdding(false);
      },
    });
    const restartMutation = useMutation({
      mutationKey: panelMutationKey('restart'),
      mutationFn: (id: string) => restartPrReview(id),
      onMutate(id) {
        clearActionError('restart', id);
      },
      onError(error, id) {
        recordActionError('restart', id, error);
      },
      onSuccess(result) {
        updateReviewCaches(result.review);
      },
    });
    const archiveMutation = useMutation({
      mutationKey: panelMutationKey('archive'),
      mutationFn: (id: string) => archivePrReview(id),
      onMutate(id) {
        clearActionError('archive', id);
      },
      onError(error, id) {
        recordActionError('archive', id, error);
      },
      onSuccess(result) {
        updateReviewCaches(result.review);
      },
    });
    const restoreMutation = useMutation({
      mutationKey: panelMutationKey('restore'),
      mutationFn: (id: string) => restorePrReview(id),
      onMutate(id) {
        clearActionError('restore', id);
      },
      onError(error, id) {
        recordActionError('restore', id, error);
      },
      onSuccess(result) {
        updateReviewCaches(result.review);
      },
    });
    const pendingStartRefs = usePendingVariables(panelMutationKey('start'));
    const pendingRestartIds = usePendingVariables(panelMutationKey('restart'));
    const pendingArchiveIds = usePendingVariables(panelMutationKey('archive'));
    const pendingRestoreIds = usePendingVariables(panelMutationKey('restore'));
    const pendingStartKeys = new Set(pendingStartRefs.map(prReviewRefKey));
    const uniquePendingStartRefs = uniqueReviewRefs(pendingStartRefs);
    const briefingReview =
      data?.items.find((review) => review.id === briefingReviewId) ?? null;
    useTransientPrReviewReconciliation(
      data?.items ?? emptyPrReviewRecords,
      updateReviewCaches,
    );

    useEffect(
      () =>
        openPrReviewEventStream((event) => {
          updateReviewCaches(event.review);
        }),
      [queryClient, updateReviewCaches],
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
              disabled={
                !ref.trim() || pendingStartKeys.has(prReviewRefKey(ref))
              }
              type="submit"
            >
              {ref.trim() && pendingStartKeys.has(prReviewRefKey(ref))
                ? 'starting'
                : 'start'}
            </Button>
          </form>
        ) : null}
        {actionError ? (
          <p
            className="border-b border-accent/60 px-3 py-1.5 font-mono text-[10px] text-accent"
            role="alert"
          >
            {actionErrorMessage(actionError.error)}
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
                      pendingStartKeys.has(
                        prReviewTargetKey(
                          item.pullRequest.repo,
                          item.pullRequest.number,
                        ),
                      ) ||
                      (item.review !== null &&
                        pendingRestartIds.includes(item.review.id))
                    }
                  />
                ))}
              </ReviewSection>
              <ReviewSection
                empty="No reviews are running."
                title="IN PROGRESS"
              >
                {uniquePendingStartRefs
                  .filter(
                    (reviewRef) =>
                      !data.groups.inProgress.some(
                        (review) =>
                          prReviewRefKey(review.ref) ===
                          prReviewRefKey(reviewRef),
                      ),
                  )
                  .map((reviewRef) => (
                    <StartingReviewRow key={reviewRef} reviewRef={reviewRef} />
                  ))}
                {data.groups.inProgress.map((review) => (
                  <ReviewRow
                    key={review.id}
                    onOpenBriefing={setBriefingReviewId}
                    onReviewChange={updateReviewCaches}
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
                    onArchive={(id) => archiveMutation.mutate(id)}
                    onOpenBriefing={setBriefingReviewId}
                    onReviewChange={updateReviewCaches}
                    onRestart={(id) => restartMutation.mutate(id)}
                    pending={
                      pendingRestartIds.includes(review.id) ||
                      pendingArchiveIds.includes(review.id)
                    }
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
                      <ReviewRow
                        key={review.id}
                        onArchive={(id) => archiveMutation.mutate(id)}
                        onOpenBriefing={setBriefingReviewId}
                        onReviewChange={updateReviewCaches}
                        pending={pendingArchiveIds.includes(review.id)}
                        review={review}
                      />
                    ))
                  ) : (
                    <p className="px-3 py-2 text-[10.5px] text-muted">
                      No reviews submitted in the last seven days.
                    </p>
                  )}
                </div>
              </details>
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 font-mono text-[10px] tracking-[0.08em] text-muted focus:outline-none focus:ring-1 focus:ring-primary">
                  <span>ARCHIVED</span>
                  <Badge>{data.groups.archived.length}</Badge>
                </summary>
                <div className="border-t border-line">
                  {data.groups.archived.length ? (
                    data.groups.archived.map((review) => (
                      <ReviewRow
                        key={review.id}
                        onOpenBriefing={setBriefingReviewId}
                        onReviewChange={updateReviewCaches}
                        onRestore={(id) => restoreMutation.mutate(id)}
                        pending={pendingRestoreIds.includes(review.id)}
                        review={review}
                      />
                    ))
                  ) : (
                    <p className="px-3 py-2 text-[10.5px] text-muted">
                      Archived reviews stay available here.
                    </p>
                  )}
                </div>
              </details>
            </div>
          </ScrollArea>
        ) : null}
        {briefingReview?.briefingOverview ? (
          <PrReviewBriefingOverlay
            onClose={() => setBriefingReviewId(null)}
            onReviewChange={updateReviewCaches}
            review={briefingReview}
          />
        ) : null}
      </div>
    );
  },
} satisfies DisplayPlugin<Record<string, never>>;

const emptyPrReviewRecords: readonly PrReviewRecord[] = [];

type PanelMutationAction = 'archive' | 'restart' | 'restore' | 'start';

type PanelActionError = {
  error: unknown;
  targetKey: string;
};

function panelMutationKey(action: PanelMutationAction) {
  return ['reviews-panel', action];
}

function usePendingVariables(mutationKey: ReturnType<typeof panelMutationKey>) {
  const variables = useMutationState<string | undefined>({
    filters: { mutationKey, status: 'pending' },
    select: (mutation) =>
      typeof mutation.state.variables === 'string'
        ? mutation.state.variables
        : undefined,
  });
  return variables.filter((value): value is string => value !== undefined);
}

function panelMutationTargetKey(
  action: PanelMutationAction,
  variables: string,
) {
  return `${action}:${action === 'start' ? prReviewRefKey(variables) : variables}`;
}

export function prReviewRefKey(ref: string) {
  const trimmed = ref.trim();
  const url = trimmed.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i);
  if (url) {
    return prReviewTargetKey(
      `${url[1]}/${url[2].replace(/\.git$/i, '')}`,
      Number(url[3]),
    );
  }

  const hash = trimmed.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/);
  if (hash) return prReviewTargetKey(hash[1], Number(hash[2]));

  return trimmed.toLowerCase();
}

function prReviewTargetKey(repo: string, number: number) {
  return `${repo.toLowerCase()}#${number}`;
}

function uniqueReviewRefs(refs: string[]) {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = prReviewRefKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ReviewSection({
  children,
  empty,
  title,
}: {
  children: ReactNode;
  empty: string;
  title: string;
}) {
  const content = Children.toArray(children);
  const count = content.length;
  return (
    <section>
      <div className="flex items-center justify-between bg-field px-3 py-1.5 font-mono text-[10px] tracking-[0.08em] text-muted">
        <h3>{title}</h3>
        <span className="tabular-nums">{count}</span>
      </div>
      <div className="divide-y divide-line">
        {count ? (
          content
        ) : (
          <p className="px-3 py-2 text-[10.5px] text-muted">{empty}</p>
        )}
      </div>
    </section>
  );
}

function StartingReviewRow({ reviewRef }: { reviewRef: string }) {
  return (
    <article className="px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">{reviewRef}</p>
          <p className="mt-1 font-mono text-[10px] text-primary">
            resolving PR and starting review…
          </p>
        </div>
        <Badge>starting</Badge>
      </div>
    </article>
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
            {pending ? 'starting…' : 're-review'}
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
            {pending ? 'starting…' : 'review'}
          </Button>
        )}
      </div>
    </article>
  );
}

function ReviewRow({
  onArchive,
  onOpenBriefing,
  onReviewChange,
  onRestart,
  onRestore,
  pending = false,
  review,
}: {
  onArchive?: (id: string) => void;
  onOpenBriefing: (id: string) => void;
  onReviewChange: (review: PrReviewRecord) => void;
  onRestart?: (id: string) => void;
  onRestore?: (id: string) => void;
  pending?: boolean;
  review: PrReviewRecord;
}) {
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
          <p
            className={`mt-1 font-mono text-[10px] font-semibold tracking-[0.04em] ${reviewRecommendationTone(review)}`}
          >
            {reviewRecommendationLabel(review)}
          </p>
          {review.recommendationReason ? (
            <p className="mt-1 line-clamp-3 max-w-[65ch] text-[10px] leading-4 text-muted">
              {review.recommendationReason}
            </p>
          ) : review.status === 'ready' && !review.archivedAt ? (
            <p className="mt-1 line-clamp-3 max-w-[65ch] text-[10px] leading-4 text-muted">
              {reviewReadyDetail(review)}
            </p>
          ) : null}
          {review.status === 'ready' && review.previousVerdict ? (
            <Badge className="mt-1 border-primary text-primary">
              {previousReviewLabel(review.previousVerdict)}
            </Badge>
          ) : null}
        </div>
        <Badge>{review.status}</Badge>
      </div>
      <div className="mt-1.5 flex flex-nowrap items-center justify-end gap-1 font-mono text-[10px]">
        {review.status === 'submitted' ? (
          <ReviewRowReceipt review={review} />
        ) : null}
        {review.briefingOverview && review.status !== 'submitted' ? (
          <button
            className={reviewRowActionClass}
            onClick={() => onOpenBriefing(review.id)}
            type="button"
          >
            briefing
          </button>
        ) : null}
        {review.status === 'ready' ? (
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
        {review.status === 'submitting' ? (
          <ReviewRowRecoverSubmission
            onReviewChange={onReviewChange}
            review={review}
          />
        ) : null}
        {onArchive ? (
          <button
            className={reviewRowActionClass}
            disabled={pending}
            onClick={() => onArchive(review.id)}
            type="button"
          >
            archive
          </button>
        ) : null}
        {onRestore ? (
          <button
            className={reviewRowActionClass}
            disabled={pending}
            onClick={() => onRestore(review.id)}
            type="button"
          >
            restore
          </button>
        ) : null}
        {review.status === 'ready' &&
        !review.archivedAt &&
        review.recommendation === 'approve' &&
        review.briefingOverview ? (
          <ReviewRowQuickApprove
            onReviewChange={onReviewChange}
            review={review}
          />
        ) : null}
      </div>
    </article>
  );
}

function ReviewRowRecoverSubmission({
  onReviewChange,
  review,
}: {
  onReviewChange: (review: PrReviewRecord) => void;
  review: PrReviewRecord;
}) {
  const [error, setError] = useState<unknown>(null);
  const draftQuery = useGitHubPrReviewDraft(
    { repo: review.repoFullName, number: review.prNumber },
    { ...prReviewDraftQueryOptions(review), live: false },
  );
  const actions = usePrReviewBriefingActions(review, draftQuery, {
    onReviewChange,
  });
  return (
    <>
      {error ? (
        <span className="text-accent" role="alert">
          {queryErrorMessage(error)}
        </span>
      ) : null}
      <button
        className={reviewRowActionClass}
        disabled={actions.busy}
        onClick={() => {
          setError(null);
          void actions.recoverSubmission().catch(setError);
        }}
        type="button"
      >
        {actions.busy ? 'checking GitHub…' : 'recover submission'}
      </button>
    </>
  );
}

function ReviewRowQuickApprove({
  onReviewChange,
  review,
}: {
  onReviewChange: (review: PrReviewRecord) => void;
  review: PrReviewRecord;
}) {
  const [error, setError] = useState<unknown>(null);
  const unavailableReasonId = useId();
  const draftQuery = useGitHubPrReviewDraft(
    { repo: review.repoFullName, number: review.prNumber },
    { ...prReviewDraftQueryOptions(review), live: false },
  );
  const actions = usePrReviewBriefingActions(review, draftQuery, {
    onReviewChange,
  });
  const draftKnown =
    !draftQuery.isLoading && !draftQuery.isError && !draftQuery.isRefetchError;
  const draft = draftKnown ? (draftQuery.data ?? null) : null;
  const draftMatches =
    !draft || (draft.status === 'draft' && draft.headSha === review.headSha);
  const commentCount = draftKnown ? (draft?.comments.length ?? 0) : null;
  const unavailableReason =
    draftQuery.isError || draftQuery.isRefetchError
      ? queryErrorMessage(draftQuery.error)
      : draftKnown && draft && draft.status !== 'draft'
        ? `The local draft is ${draft.status}; quick approval requires an editable draft.`
        : draftKnown && !draftMatches
          ? 'The local draft does not match this ready review.'
          : null;
  const queryUnavailable = draftQuery.isError || draftQuery.isRefetchError;
  const approvalUnavailable = queryUnavailable || (draftKnown && !draftMatches);
  const rejectedCommentCount = Math.min(
    actions.rejectedCommentCount,
    commentCount ?? 0,
  );
  const submittedCommentCount =
    commentCount === null ? null : commentCount - rejectedCommentCount;
  const label = approvalUnavailable
    ? 'approval unavailable'
    : submittedCommentCount === null
      ? 'loading draft…'
      : `${
          submittedCommentCount === 0
            ? 'approve with no comments'
            : `approve & submit ${submittedCommentCount}`
        }${
          rejectedCommentCount ? ` · omit ${rejectedCommentCount} rejected` : ''
        }`;

  return (
    <>
      {error ? (
        <span className="text-accent" role="alert">
          {queryErrorMessage(error)}
        </span>
      ) : null}
      {unavailableReason ? (
        <span
          className="max-w-[34ch] text-right text-accent"
          id={unavailableReasonId}
          role={queryUnavailable ? 'alert' : undefined}
        >
          quick approval unavailable: {unavailableReason}
        </span>
      ) : null}
      <button
        aria-label={actions.submitting ? 'submitting review' : label}
        aria-describedby={unavailableReason ? unavailableReasonId : undefined}
        className={`${reviewRowActionClass} border-primary bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] font-semibold text-primary hover:bg-[color-mix(in_srgb,var(--primary)_22%,transparent)]`}
        disabled={!draftKnown || !draftMatches || actions.busy}
        onClick={() => {
          setError(null);
          void actions.submitApproval('').catch(setError);
        }}
        type="button"
      >
        {actions.submitting ? 'submitting…' : label}
      </button>
    </>
  );
}

function ReviewRowReceipt({ review }: { review: PrReviewRecord }) {
  return (
    <>
      <span className="mr-auto text-primary">
        {submittedActionLabel(review.verdict)}{' '}
        {relativeTime(review.submittedAt ?? review.updatedAt)} · receipt
        recorded
      </span>
      <a
        className={`${reviewRowActionClass} border-primary text-primary`}
        href={review.githubReviewUrl ?? review.prUrl}
        rel="noreferrer"
        target="_blank"
      >
        view on GitHub
      </a>
    </>
  );
}

function OpenReviewButton({ review }: { review: PrReviewRecord }) {
  return (
    <a
      className={reviewRowActionClass}
      href={review.reviewUrl}
      rel="noreferrer"
      target="_blank"
    >
      open
    </a>
  );
}

export function reviewRecommendationLabel(review: PrReviewRecord) {
  return briefingRecommendationLabel(review) ?? reviewStatusLine(review);
}

const reviewRowActionClass =
  'inline-flex min-h-[26px] shrink-0 items-center justify-center whitespace-nowrap border border-line bg-soft px-[7px] py-1 font-mono text-[10px] font-normal leading-[1.2] text-muted hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50';

function reviewRecommendationTone(review: PrReviewRecord) {
  if (review.status === 'submitted') {
    return review.verdict === 'request-changes'
      ? 'text-accent'
      : 'text-primary';
  }
  if (review.recommendation === 'needs-human') return 'text-accent';
  return 'text-primary';
}

function submittedActionLabel(verdict: PrReviewRecord['verdict']) {
  if (verdict === 'approve') return 'approved';
  if (verdict === 'request-changes') return 'requested changes';
  if (verdict === 'comment') return 'commented';
  return 'submitted';
}

export function reviewStatusLine(review: PrReviewRecord) {
  if (review.status === 'reviewing') return 'reviewing…';
  if (review.status === 'submitting') return 'submitting to GitHub…';
  if (review.status === 'failed')
    return review.failureMessage ?? 'Review failed.';
  if (review.status === 'submitted') {
    return `${review.verdict ?? 'submitted'} · ${relativeTime(review.submittedAt ?? review.updatedAt)}`;
  }
  return `${review.findingCount} findings · ${review.seededCount} drafts${review.reportOnlyCount ? ` · ${review.reportOnlyCount} report-only` : ''}`;
}

export function reviewReadyDetail(review: PrReviewRecord) {
  if (!review.previousVerdict) return review.trustBoundary;
  const previous = previousReviewClause(review.previousVerdict);
  if (review.seededCount > 0) {
    return `You previously ${previous} on GitHub. ${review.seededCount} local draft comment${review.seededCount === 1 ? ' is' : 's are'} not submitted.`;
  }
  if (review.reportOnlyCount > 0) {
    return `You previously ${previous} on GitHub. ${review.reportOnlyCount} report-only finding${review.reportOnlyCount === 1 ? ' remains' : 's remain'} to inspect.`;
  }
  return `You previously ${previous} on GitHub. Nothing new is pending locally.`;
}

function previousReviewLabel(
  verdict: NonNullable<PrReviewRecord['previousVerdict']>,
) {
  if (verdict === 'approve') return 'previously approved';
  if (verdict === 'request-changes') return 'previously requested changes';
  return 'previously commented';
}

function previousReviewClause(
  verdict: NonNullable<PrReviewRecord['previousVerdict']>,
) {
  if (verdict === 'approve') return 'approved this PR';
  if (verdict === 'request-changes') return 'requested changes on this PR';
  return 'commented on this PR';
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
  const awaiting = (current?.groups.awaiting ?? [])
    .map((item) =>
      item.pullRequest.repo.toLowerCase() ===
        review.repoFullName.toLowerCase() &&
      item.pullRequest.number === review.prNumber
        ? { ...item, review: review.archivedAt ? null : review }
        : item,
    )
    .filter((item) => !item.review);
  return {
    ok: true,
    action: 'pr_reviews_list',
    changed: false,
    items,
    groups: {
      awaiting,
      inProgress: items.filter(
        (item) =>
          !item.archivedAt &&
          (item.status === 'reviewing' || item.status === 'submitting'),
      ),
      needsAction: items.filter(
        (item) =>
          !item.archivedAt &&
          (item.status === 'ready' || item.status === 'failed'),
      ),
      submitted: items.filter(
        (item) => !item.archivedAt && item.status === 'submitted',
      ),
      archived: items.filter((item) => Boolean(item.archivedAt)),
    },
    queueIssues: current?.queueIssues,
  };
}

export function applyPrReviewSnapshot(
  current: PrReviewsResponse | undefined,
  snapshot: PrReviewsResponse,
): PrReviewsResponse {
  const awaiting = (current?.groups.awaiting ?? [])
    .map((item) => ({
      ...item,
      review:
        snapshot.items.find(
          (review) =>
            !review.archivedAt &&
            review.repoFullName.toLowerCase() ===
              item.pullRequest.repo.toLowerCase() &&
            review.prNumber === item.pullRequest.number,
        ) ?? null,
    }))
    .filter((item) => !item.review);
  return {
    ...snapshot,
    groups: {
      ...snapshot.groups,
      awaiting,
    },
    queueIssues: current?.queueIssues,
  };
}
