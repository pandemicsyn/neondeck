import { reportDocumentFromSummary } from '../../../shared/report-document';
import * as v from 'valibot';
import type { RuntimePaths } from '../../runtime-home';
import { readReport, type ReportRecord } from '../reports';
import type { PrReviewRecord } from '../pr-reviews';

const untrustedInputSchema = v.unknown();
const recordSchema = v.record(v.string(), untrustedInputSchema);
type UntrustedInput = v.InferInput<typeof untrustedInputSchema>;

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
  paths: RuntimePaths,
) {
  const reports = (
    await Promise.all(
      review.reportIds.slice(0, 8).map((id) => readReport(id, paths)),
    )
  ).filter((report): report is ReportRecord => report !== null);
  return buildPrReviewerHandoff(review, reports);
}

export function buildPrReviewerHandoff(
  review: PrReviewRecord,
  reports: readonly ReportRecord[],
): PrReviewerHandoff {
  const overview = reports.find((report) => {
    const summary = objectRecord(report.summary);
    return (
      summary?.workflow === 'review-pr-for-human' &&
      summary.report === 'overview' &&
      summary.headSha === review.headSha
    );
  });
  const document = overview
    ? reportDocumentFromSummary(overview.summary)
    : null;
  const changeMap = boundedItems(
    document?.sections.find((section) => section.title === 'Change Map')
      ?.items ?? [],
    changeMapBudget,
  );
  const conclusions = boundedItems(
    document?.sections.find(
      (section) => section.title === 'Checks, Risks, And Next Actions',
    )?.items ?? [],
    conclusionsBudget,
  );

  return {
    available: document !== null,
    source: 'review-pr-for-human',
    runId: review.runId,
    headSha: review.headSha,
    completedAt: review.readyAt,
    summary: document?.summary
      ? truncate(document.summary, overviewSummaryLimit)
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

function objectRecord(value: UntrustedInput) {
  const parsed = v.safeParse(recordSchema, value);
  return parsed.success ? parsed.output : null;
}

function truncate(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
