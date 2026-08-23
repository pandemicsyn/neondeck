import type { RuntimePaths } from '../../runtime-home';
import type { PrReviewRecord } from '../pr-reviews';

const overviewSummaryLimit = 4_000;
const changeMapBudget = 16_000;
const conclusionsBudget = 12_000;
const itemLimit = 50;
const itemLabelLimit = 500;
const itemValueLimit = 2_000;

export type PrReviewerHandoffItem = {
  label: string | null;
  value: string;
};

export type PrReviewerHandoff = {
  available: boolean;
  source: 'review-pr-for-human';
  runId: string | null;
  headSha: string;
  completedAt: string | null;
  summary: string | null;
  changeMap: PrReviewerHandoffItem[];
  changeMapOmitted: number;
  conclusions: PrReviewerHandoffItem[];
  conclusionsOmitted: number;
  findingCounts: {
    total: number;
    seededDrafts: number;
    reportOnly: number;
  };
};

export async function readPrReviewerHandoff(
  review: PrReviewRecord,
  _paths: RuntimePaths,
) {
  return buildPrReviewerHandoff(review);
}

export function buildPrReviewerHandoff(
  review: PrReviewRecord,
): PrReviewerHandoff {
  const overview = review.briefingOverview;
  const changeMap = boundedItems(
    overview?.changeMap.map((item) => ({
      label: item.path,
      value: [item.summary, item.risk].filter(Boolean).join('\n'),
    })) ?? [],
    changeMapBudget,
  );
  const conclusions = boundedItems(
    overview?.risks.map((risk, index) => ({
      label: `risk ${index + 1}`,
      value: risk,
    })) ?? [],
    conclusionsBudget,
  );

  return {
    available: overview !== null,
    source: 'review-pr-for-human',
    runId: review.runId,
    headSha: review.headSha,
    completedAt: review.readyAt,
    summary: overview?.summary
      ? truncate(overview.summary, overviewSummaryLimit)
      : null,
    changeMap: changeMap.items,
    changeMapOmitted: changeMap.omitted,
    conclusions: conclusions.items,
    conclusionsOmitted: conclusions.omitted,
    findingCounts: {
      total: review.findingCount,
      seededDrafts: review.seededCount,
      reportOnly: review.reportOnlyCount,
    },
  };
}

function boundedItems(items: readonly PrReviewerHandoffItem[], budget: number) {
  const selected: PrReviewerHandoffItem[] = [];
  let characters = 0;
  for (const item of items) {
    if (selected.length >= itemLimit) break;
    const next = {
      label: item.label === null ? null : truncate(item.label, itemLabelLimit),
      value: truncate(item.value, itemValueLimit),
    };
    const size = (next.label?.length ?? 0) + next.value.length;
    if (characters + size > budget) break;
    selected.push(next);
    characters += size;
  }
  return {
    items: selected,
    omitted: Math.max(0, items.length - selected.length),
  };
}

function truncate(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
