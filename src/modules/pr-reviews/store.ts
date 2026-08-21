import { openDb } from '../../lib/sqlite';
import * as v from 'valibot';
import type { RuntimePaths } from '../../runtime-home';
import { pruneExpiredSubmittedPrReviewRows } from '../../runtime-home/app-db/reconcile';
import type {
  PrReviewOrigin,
  PrReviewRecord,
  PrReviewReportOnlyFinding,
  PrReviewStatus,
  PrReviewVerdict,
} from './types';
import { prReviewFindingSourceId } from './finding-id';

const untrustedInputSchema = v.unknown();
const sqliteRowSchema = v.record(v.string(), untrustedInputSchema);
const reportOnlyFindingSchema = v.object({
  severity: v.picklist(['critical', 'major', 'minor', 'nit']),
  path: v.string(),
  line: v.nullable(v.number()),
  summary: v.string(),
  suggestedFix: v.string(),
  reason: v.string(),
  sourceId: v.optional(v.string()),
});
const numberOrStringSchema = v.union([v.number(), v.string()]);

type UntrustedInput = v.InferInput<typeof untrustedInputSchema>;
type SqliteRow = v.InferOutput<typeof sqliteRowSchema>;

export function readPrReview(id: string, paths: RuntimePaths) {
  return readOne('id = ?', id.trim(), paths);
}

export function readPrReviewAdmissionBinding(id: string, paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase);
  try {
    const row = database
      .prepare(
        `SELECT id, ref, repo_full_name, pr_number, attempt_id, run_id, status,
                head_sha, base_sha, base_ref
         FROM pr_reviews WHERE id = ? LIMIT 1;`,
      )
      .get(id.trim());
    const value = objectValue(row);
    if (!value) return null;
    return {
      id: stringValue(value.id),
      ref: stringValue(value.ref),
      repoFullName: stringValue(value.repo_full_name),
      prNumber: numberValue(value.pr_number),
      attemptId: nullableString(value.attempt_id),
      runId: nullableString(value.run_id),
      status: statusValue(value.status),
      headSha: stringValue(value.head_sha),
      baseSha: nullableString(value.base_sha),
      baseRef: nullableString(value.base_ref),
    };
  } finally {
    database.close();
  }
}

export function readPrReviewByRunId(runId: string, paths: RuntimePaths) {
  return readOne('run_id = ?', runId.trim(), paths);
}

export function listPrReviewAssistSettlementCandidates(paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase);
  try {
    return database
      .prepare(
        `SELECT id, repo_full_name, pr_number, attempt_id, run_id, status,
                head_sha, base_sha, base_ref
         FROM pr_reviews
         WHERE status IN ('reviewing', 'ready')
           AND attempt_id IS NOT NULL
         ORDER BY updated_at ASC;`,
      )
      .all()
      .flatMap((row) => {
        const value = objectValue(row);
        if (!value) return [];
        return {
          reviewId: stringValue(value.id),
          ref: `${stringValue(value.repo_full_name)}#${numberValue(value.pr_number)}`,
          attemptId: stringValue(value.attempt_id),
          submissionId: nullableString(value.run_id),
          status: statusValue(value.status),
          repoFullName: stringValue(value.repo_full_name),
          prNumber: numberValue(value.pr_number),
          headSha: stringValue(value.head_sha),
          baseSha: nullableString(value.base_sha),
          baseRef: nullableString(value.base_ref),
        };
      });
  } finally {
    database.close();
  }
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
             WHERE archived_at IS NOT NULL
                OR status != 'submitted'
                OR submitted_at >= ?
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

export function pruneExpiredSubmittedPrReviews(
  paths: RuntimePaths,
  now = Date.now(),
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    return pruneExpiredSubmittedPrReviewRows(database, now);
  } finally {
    database.close();
  }
}

export function readPrReviewRow(row: UntrustedInput): PrReviewRecord {
  const value = objectValue(row) ?? {};
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
    baseSha: nullableString(value.base_sha),
    baseRef: nullableString(value.base_ref),
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
    archivedAt: nullableString(value.archived_at),
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

function objectValue(value: UntrustedInput): SqliteRow | null {
  const parsed = v.safeParse(sqliteRowSchema, value);
  return parsed.success ? parsed.output : null;
}

function stringValue(value: UntrustedInput) {
  const parsed = v.safeParse(v.string(), value);
  return parsed.success ? parsed.output : '';
}

function nullableString(value: UntrustedInput) {
  const parsed = v.safeParse(v.string(), value);
  return parsed.success ? parsed.output : null;
}

function numberValue(value: UntrustedInput) {
  const parsed = v.safeParse(numberOrStringSchema, value);
  return parsed.success ? Number(parsed.output) || 0 : 0;
}

function statusValue(value: UntrustedInput): PrReviewStatus {
  const parsed = v.safeParse(
    v.picklist(['ready', 'submitting', 'submitted', 'failed', 'reviewing']),
    value,
  );
  return parsed.success ? parsed.output : 'failed';
}

function originValue(value: UntrustedInput): PrReviewOrigin {
  const parsed = v.safeParse(v.picklist(['chat', 'panel', 'api']), value);
  return parsed.success ? parsed.output : 'api';
}

function verdictValue(value: UntrustedInput): PrReviewVerdict | null {
  const parsed = v.safeParse(
    v.picklist(['comment', 'approve', 'request-changes']),
    value,
  );
  return parsed.success ? parsed.output : null;
}

function stringArray(value: UntrustedInput): string[] {
  try {
    const parsed: UntrustedInput = JSON.parse(stringValue(value));
    const array = v.safeParse(v.array(untrustedInputSchema), parsed);
    if (!array.success) return [];
    return array.output.flatMap((item) => {
      const itemParsed = v.safeParse(v.string(), item);
      return itemParsed.success ? [itemParsed.output] : [];
    });
  } catch {
    return [];
  }
}

function reportOnlyFindings(
  value: UntrustedInput,
): PrReviewReportOnlyFinding[] {
  try {
    const parsed: UntrustedInput = JSON.parse(stringValue(value));
    const array = v.safeParse(v.array(untrustedInputSchema), parsed);
    if (!array.success) return [];
    return array.output.flatMap((item) => {
      const finding = reportOnlyFinding(item);
      return finding ? [finding] : [];
    });
  } catch {
    return [];
  }
}

function reportOnlyFinding(
  value: UntrustedInput,
): PrReviewReportOnlyFinding | null {
  const parsed = v.safeParse(reportOnlyFindingSchema, value);
  if (!parsed.success) return null;
  const item = parsed.output;
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
    sourceId: item.sourceId?.trim()
      ? item.sourceId
      : prReviewFindingSourceId(finding),
  };
}
