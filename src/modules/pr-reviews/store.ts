import { openDb } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';
import type {
  PrReviewOrigin,
  PrReviewRecord,
  PrReviewReportOnlyFinding,
  PrReviewStatus,
  PrReviewVerdict,
} from './types';
import { prReviewFindingSourceId } from './finding-id';

export function readPrReview(id: string, paths: RuntimePaths) {
  return readOne('id = ?', id.trim(), paths);
}

export function readPrReviewByRunId(runId: string, paths: RuntimePaths) {
  return readOne('run_id = ?', runId.trim(), paths);
}

export function readPrReviewForTarget(
  repoFullName: string,
  prNumber: number,
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    const row = database
      .prepare(
        `SELECT * FROM pr_reviews
         WHERE lower(repo_full_name) = lower(?) AND pr_number = ?
         LIMIT 1;`,
      )
      .get(repoFullName.trim(), prNumber);
    return row ? readPrReviewRow(row) : null;
  } finally {
    database.close();
  }
}

export function listPrReviews(
  paths: RuntimePaths,
  options: { submittedSince?: string; limit?: number } = {},
) {
  const database = openDb(paths.neondeckDatabase);
  const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
  try {
    const rows = options.submittedSince
      ? database
          .prepare(
            `SELECT * FROM pr_reviews
             WHERE status != 'submitted' OR submitted_at >= ?
             ORDER BY updated_at DESC
             LIMIT ?;`,
          )
          .all(options.submittedSince, limit)
      : database
          .prepare(
            `SELECT * FROM pr_reviews
             ORDER BY updated_at DESC
             LIMIT ?;`,
          )
          .all(limit);
    return rows.map(readPrReviewRow);
  } finally {
    database.close();
  }
}

export function readPrReviewRow(row: unknown): PrReviewRecord {
  const value = row as Record<string, unknown>;
  return {
    id: stringValue(value.id),
    ref: stringValue(value.ref),
    repoFullName: stringValue(value.repo_full_name),
    prNumber: numberValue(value.pr_number),
    title: stringValue(value.title),
    author: nullableString(value.author),
    prUrl: stringValue(value.pr_url),
    status: statusValue(value.status),
    runId: nullableString(value.run_id),
    headSha: stringValue(value.head_sha),
    origin: originValue(value.origin),
    reviewUrl: stringValue(value.review_url),
    reportIds: stringArray(value.report_ids_json),
    findingCount: numberValue(value.finding_count),
    seededCount: numberValue(value.seeded_count),
    reportOnlyCount: numberValue(value.report_only_count),
    reportOnlyFindings: reportOnlyFindings(value.report_only_findings_json),
    trustBoundary: stringValue(value.trust_boundary),
    verdict: verdictValue(value.verdict),
    previousVerdict: verdictValue(value.previous_verdict),
    githubReviewUrl: nullableString(value.github_review_url),
    failureMessage: nullableString(value.failure_message),
    createdAt: stringValue(value.created_at),
    updatedAt: stringValue(value.updated_at),
    readyAt: nullableString(value.ready_at),
    submittedAt: nullableString(value.submitted_at),
    failedAt: nullableString(value.failed_at),
  };
}

function readOne(where: string, value: string, paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase);
  try {
    const row = database
      .prepare(`SELECT * FROM pr_reviews WHERE ${where} LIMIT 1;`)
      .get(value);
    return row ? readPrReviewRow(row) : null;
  } finally {
    database.close();
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function nullableString(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === 'number' ? value : Number(value) || 0;
}

function statusValue(value: unknown): PrReviewStatus {
  return value === 'ready' ||
    value === 'submitting' ||
    value === 'submitted' ||
    value === 'failed' ||
    value === 'reviewing'
    ? value
    : 'failed';
}

function originValue(value: unknown): PrReviewOrigin {
  return value === 'chat' || value === 'panel' || value === 'api'
    ? value
    : 'api';
}

function verdictValue(value: unknown): PrReviewVerdict | null {
  return value === 'comment' ||
    value === 'approve' ||
    value === 'request-changes'
    ? value
    : null;
}

function stringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(stringValue(value));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function reportOnlyFindings(value: unknown): PrReviewReportOnlyFinding[] {
  try {
    const parsed = JSON.parse(stringValue(value));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const finding = reportOnlyFinding(item);
      return finding ? [finding] : [];
    });
  } catch {
    return [];
  }
}

function reportOnlyFinding(value: unknown): PrReviewReportOnlyFinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    !(
      item.severity === 'critical' ||
      item.severity === 'major' ||
      item.severity === 'minor' ||
      item.severity === 'nit'
    ) ||
    typeof item.path !== 'string' ||
    !(item.line === null || typeof item.line === 'number') ||
    typeof item.summary !== 'string' ||
    typeof item.suggestedFix !== 'string' ||
    typeof item.reason !== 'string'
  ) {
    return null;
  }
  const finding: Omit<PrReviewReportOnlyFinding, 'sourceId'> = {
    severity: item.severity,
    path: item.path,
    line: item.line,
    summary: item.summary,
    suggestedFix: item.suggestedFix,
    reason: item.reason,
  };
  return {
    ...finding,
    sourceId:
      typeof item.sourceId === 'string' && item.sourceId.trim().length > 0
        ? item.sourceId
        : prReviewFindingSourceId(finding),
  };
}
