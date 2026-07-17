import { useQuery } from '@tanstack/react-query';
import type { CSSProperties } from 'react';
import {
  getGitHubPullRequest,
  type DashboardDensity,
  type GitHubPullRequest,
} from '../../api';
import { EmptyState } from '../../components/ui';
import { queryErrorMessage, queryKeys } from '../../lib/query';
import { GitHubPrReview } from './GitHubPrReview';

export type ReviewPopoutTarget = {
  repo: string;
  number: number;
  headSha?: string | null;
  baseSha?: string | null;
  baseRef?: string | null;
  title?: string | null;
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
    queryFn: ({ signal }) => getGitHubPullRequest(target, { signal }),
    refetchInterval: 5 * 60_000,
  });
  const pullRequest = prQuery.data ?? optimisticPullRequest(target);
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
      {prQuery.error ? (
        <ReviewPopoutState
          detail={queryErrorMessage(prQuery.error)}
          title="GitHub PR detail unavailable"
        />
      ) : null}
      <GitHubPrReview
        mode="standalone"
        pr={pullRequest}
        reviewThreadsActivityVersion={prQuery.data?.updatedAt ?? null}
      />
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
      <EmptyState detail={detail} title={title} tone="alert" />
    </div>
  );
}

function optimisticPullRequest(target: ReviewPopoutTarget): GitHubPullRequest {
  const now = new Date().toISOString();
  return {
    id: target.number,
    title: target.title?.trim() || `${target.repo}#${target.number}`,
    repo: target.repo,
    number: target.number,
    url: `https://github.com/${target.repo}/pull/${target.number}`,
    state: 'open',
    draft: false,
    author: 'unknown',
    labels: [],
    comments: 0,
    updatedAt: now,
    createdAt: now,
    relations: [],
    ageDays: 0,
    stale: false,
    headSha: target.headSha ?? null,
    baseSha: target.baseSha ?? null,
    baseRef: target.baseRef ?? null,
    checks: null,
  };
}
