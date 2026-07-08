import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, type CSSProperties } from 'react';
import { getGitHubPullRequest, type DashboardDensity } from '../../api';
import { EmptyState } from '../../components/ui';
import { queryErrorMessage, queryKeys } from '../../lib/query';

const GitHubPrReview = lazy(() =>
  import('./GitHubPrReview').then((module) => ({
    default: module.GitHubPrReview,
  })),
);

export type ReviewPopoutTarget = {
  repo: string;
  number: number;
};

export type ReviewPopoutAppearance = {
  density: DashboardDensity;
  textScale: number;
};

export function PrReviewPopoutPage({
  appearance,
  target,
}: {
  appearance: ReviewPopoutAppearance;
  target: ReviewPopoutTarget;
}) {
  const prQuery = useQuery({
    queryKey: queryKeys.githubPr(target.repo, target.number),
    queryFn: () => getGitHubPullRequest(target),
    refetchInterval: 5 * 60_000,
  });
  const style = {
    '--deck-text-scale': appearance.textScale.toString(),
  } as CSSProperties;

  return (
    <section
      className={`dashboard-grid deck-density-${appearance.density} pr-review-popout-page`}
      data-deck-arrangement="review-popout"
      data-deck-profile="review-popout"
      data-display-preset="review-popout"
      style={style}
    >
      {prQuery.isLoading ? (
        <ReviewPopoutState
          detail={`Loading ${target.repo}#${target.number}.`}
          title="Loading PR review"
        />
      ) : null}
      {prQuery.error ? (
        <ReviewPopoutState
          detail={queryErrorMessage(prQuery.error)}
          title="GitHub PR unavailable"
        />
      ) : null}
      {prQuery.data ? (
        <Suspense
          fallback={
            <ReviewPopoutState
              detail="Loading the review workbench."
              title="Loading PR review"
            />
          }
        >
          <GitHubPrReview mode="standalone" pr={prQuery.data} />
        </Suspense>
      ) : null}
    </section>
  );
}

export function PrReviewPopoutErrorPage({
  appearance,
  detail,
  title,
}: {
  appearance: ReviewPopoutAppearance;
  detail: string;
  title: string;
}) {
  const style = {
    '--deck-text-scale': appearance.textScale.toString(),
  } as CSSProperties;
  return (
    <section
      className={`dashboard-grid deck-density-${appearance.density} pr-review-popout-page`}
      data-deck-arrangement="review-popout"
      data-deck-profile="review-popout"
      data-display-preset="review-popout"
      style={style}
    >
      <ReviewPopoutState detail={detail} title={title} />
    </section>
  );
}

function ReviewPopoutState({
  detail,
  title,
}: {
  detail: string;
  title: string;
}) {
  return (
    <div className="pr-review-popout-state">
      <EmptyState detail={detail} title={title} />
    </div>
  );
}
