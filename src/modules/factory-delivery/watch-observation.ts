import type { observeFactoryGitHubPull } from '../github';
import { codingDigest } from '../factory';

type PullFacts = Awaited<ReturnType<typeof observeFactoryGitHubPull>>;
function latestBy<T>(
  items: T[],
  key: (item: T) => string,
  compare: (a: T, b: T) => number,
) {
  const latest = new Map<string, T>();
  for (const item of items) {
    const prior = latest.get(key(item));
    if (!prior || compare(item, prior) > 0) latest.set(key(item), item);
  }
  return [...latest.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, item]) => item);
}
/** Normalize only exact-current-head facts; superseded failures cannot re-trigger repair. */
export function normalizeDeliveryFeedback(
  facts: PullFacts,
  publishedHeadSha: string,
) {
  if (!facts.complete || facts.pull.head.sha !== publishedHeadSha)
    throw new Error('Incomplete or stale feedback');
  // GitHub's check-runs endpoint requests filter=latest. Keep distinct returned
  // checks: names alone cannot identify jobs belonging to different providers.
  const checks = facts.checks.items
    .filter((c) => c.head_sha === publishedHeadSha)
    .sort((a, b) => a.id - b.id);
  const statuses = latestBy(
    facts.statuses.items,
    (s) => s.context,
    (a, b) =>
      Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.id - b.id,
  );
  const reviews = latestBy(
    facts.reviews.items.filter(
      (r) =>
        r.user !== null &&
        r.commit_id === publishedHeadSha &&
        r.state !== 'PENDING',
    ),
    (r) => String(r.user!.id),
    (a, b) =>
      Date.parse(a.submitted_at ?? '1970-01-01T00:00:00.000Z') -
        Date.parse(b.submitted_at ?? '1970-01-01T00:00:00.000Z') || a.id - b.id,
  );
  const inlineComments = facts.inlineComments.items
    .filter(
      (c) =>
        c.user !== null &&
        c.commit_id === publishedHeadSha &&
        c.line !== null &&
        !facts.reviews.items.some(
          (r) =>
            r.id === c.pull_request_review_id &&
            ['DISMISSED', 'PENDING'].includes(r.state),
        ),
    )
    .sort((a, b) => a.id - b.id);
  const issueComments = facts.issueComments.items
    .filter((c) => c.user !== null)
    .sort((a, b) => a.id - b.id);
  const ciFailed =
    checks.some(
      (c) =>
        c.status === 'completed' &&
        ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(
          c.conclusion ?? '',
        ),
    ) || statuses.some((s) => ['failure', 'error'].includes(s.state));
  const hasReviewFeedback =
    reviews.some(
      (r) => r.state === 'CHANGES_REQUESTED' || r.state === 'COMMENTED',
    ) ||
    inlineComments.length > 0 ||
    issueComments.length > 0;
  const normalized = {
    headSha: publishedHeadSha,
    checks,
    statuses,
    reviews,
    inlineComments,
    issueComments,
  };
  return {
    ...normalized,
    ciFailed,
    hasReviewFeedback,
    fingerprint: codingDigest(normalized),
  };
}
