import { DatabaseSync } from 'node:sqlite';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';

export const automationHealthDefaultWindowDays = 30;

export type AutomationHealthSnapshot = {
  window: {
    days: number;
    since: string;
    until: string;
  };
  reviewAssist: {
    seeded: number;
    submitted: number;
    skipped: number;
    deleted: number;
    pending: number;
    survivalRate: number | null;
    editedBeforeSubmitRate: number | null;
    editedSubmitted: number;
    bySeverity: Record<
      string,
      {
        seeded: number;
        submitted: number;
        skipped: number;
        deleted: number;
        pending: number;
        survivalRate: number | null;
      }
    >;
  };
  revisionLoop: {
    runs: number;
    approved: number;
    reRevised: number;
    abandoned: number;
    pendingReview: number;
    failedOrAborted: number;
    approvalRate: number | null;
    reRevisionRate: number | null;
    abandonedRate: number | null;
  };
  routines: {
    runs: number;
    failures: number;
    failureRate: number | null;
    autoPauses: number;
    silentOutputs: number;
    silentOutputRate: number | null;
  };
  driftTriage: {
    docsDriftReports: number;
    docsDriftStagedFixes: number;
    docsDriftActedOnRate: number | null;
    issueTriageReports: number;
    issueTriageActedOn: number;
    issueTriageActedOnRate: number | null;
    agedOutReports: number;
  };
};

export async function readAutomationHealth(
  paths = runtimePaths(),
  options: {
    windowDays?: number;
    now?: Date;
  } = {},
): Promise<AutomationHealthSnapshot> {
  await ensureRuntimeHome(paths);
  const days = Math.max(
    1,
    Math.floor(options.windowDays ?? automationHealthDefaultWindowDays),
  );
  const untilDate = options.now ?? new Date();
  const sinceDate = new Date(untilDate.getTime() - days * 24 * 60 * 60 * 1000);
  const window = {
    days,
    since: sinceDate.toISOString(),
    until: untilDate.toISOString(),
  };
  const database = new DatabaseSync(paths.neondeckDatabase, {
    readOnly: true,
  });
  try {
    return {
      window,
      reviewAssist: reviewAssistHealth(database, window),
      revisionLoop: revisionLoopHealth(database, window),
      routines: routinesHealth(database, window),
      driftTriage: driftTriageHealth(database, window),
    };
  } finally {
    database.close();
  }
}

function reviewAssistHealth(
  database: DatabaseSync,
  window: AutomationHealthSnapshot['window'],
): AutomationHealthSnapshot['reviewAssist'] {
  const rows = database
    .prepare(
      `
      SELECT severity, outcome, COUNT(*) AS count
      FROM pr_review_neon_seeded_comments
      WHERE seeded_at >= ? AND seeded_at <= ?
      GROUP BY severity, outcome;
    `,
    )
    .all(window.since, window.until) as Array<{
    severity: string;
    outcome: string | null;
    count: number;
  }>;
  const bySeverity: AutomationHealthSnapshot['reviewAssist']['bySeverity'] = {};
  const totals = {
    seeded: 0,
    submitted: 0,
    skipped: 0,
    deleted: 0,
    pending: 0,
  };

  for (const row of rows) {
    const severity = row.severity || 'unknown';
    const bucket =
      bySeverity[severity] ??
      (bySeverity[severity] = {
        seeded: 0,
        submitted: 0,
        skipped: 0,
        deleted: 0,
        pending: 0,
        survivalRate: null,
      });
    const outcome = seedOutcome(row.outcome);
    const count = Number(row.count ?? 0);
    bucket.seeded += count;
    bucket[outcome] += count;
    totals.seeded += count;
    totals[outcome] += count;
  }
  for (const bucket of Object.values(bySeverity)) {
    bucket.survivalRate = rate(bucket.submitted, bucket.seeded);
  }

  const reviewOutcomes = githubReviewOutcomeSummaries(database, window).map(
    (summary) => objectField(summary.neonDraftOutcome),
  );
  const editedSubmitted = reviewOutcomes.reduce(
    (sum, outcome) =>
      sum + numberField(outcome.editedSubmittedNeonCommentCount),
    0,
  );
  const submittedInReviewOutcomes = reviewOutcomes.reduce(
    (sum, outcome) => sum + numberField(outcome.submittedNeonCommentCount),
    0,
  );

  return {
    ...totals,
    survivalRate: rate(totals.submitted, totals.seeded),
    editedBeforeSubmitRate: rate(editedSubmitted, submittedInReviewOutcomes),
    editedSubmitted,
    bySeverity,
  };
}

function revisionLoopHealth(
  database: DatabaseSync,
  window: AutomationHealthSnapshot['window'],
): AutomationHealthSnapshot['revisionLoop'] {
  const revisionRows = database
    .prepare(
      `
      SELECT summary_json
      FROM workflow_summaries
      WHERE workflow = 'prepared_diff_revision_run'
        AND created_at >= ? AND created_at <= ?;
    `,
    )
    .all(window.since, window.until) as Array<{ summary_json: string | null }>;
  const preparedDiffIds = [
    ...new Set(
      revisionRows
        .map((row) =>
          stringField(objectField(parseJson(row.summary_json)).preparedDiffId),
        )
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const statuses = preparedDiffIds.map((id) =>
    preparedDiffRevisionStatus(database, id),
  );
  const approved = statuses.filter(
    (status) =>
      ['push-approved', 'pushed'].includes(status.status) ||
      status.pushApprovalStatus === 'approved',
  ).length;
  const reRevised = statuses.filter((status) =>
    ['revision-requested', 'revision-in-progress'].includes(status.status),
  ).length;
  const abandoned = statuses.filter(
    (status) => status.status === 'abandoned',
  ).length;
  const pendingReview = statuses.filter((status) =>
    ['prepared', 'verification-requested', 'push-blocked'].includes(
      status.status,
    ),
  ).length;
  const failedOrAborted = revisionRows.reduce((ids, row) => {
    const summary = objectField(parseJson(row.summary_json));
    const id = stringField(summary.preparedDiffId);
    if (
      id &&
      ['failed', 'aborted', 'abort-failed-after-stale-transition'].includes(
        stringField(summary.outcome) ?? '',
      )
    ) {
      ids.add(id);
    }
    return ids;
  }, new Set<string>()).size;
  const runs = preparedDiffIds.length;

  return {
    runs,
    approved,
    reRevised,
    abandoned,
    pendingReview,
    failedOrAborted,
    approvalRate: rate(approved, runs),
    reRevisionRate: rate(reRevised, runs),
    abandonedRate: rate(abandoned, runs),
  };
}

function routinesHealth(
  database: DatabaseSync,
  window: AutomationHealthSnapshot['window'],
): AutomationHealthSnapshot['routines'] {
  const rows = database
    .prepare(
      `
      SELECT status, outcome, summary_json
      FROM routine_runs
      WHERE created_at >= ? AND created_at <= ?;
    `,
    )
    .all(window.since, window.until) as Array<{
    status: string;
    outcome: string | null;
    summary_json: string | null;
  }>;
  const runs = rows.length;
  const failures = rows.filter(
    (row) => row.status === 'failed' || row.outcome === 'failed',
  ).length;
  const silentOutputs = rows.filter((row) =>
    Boolean(objectField(parseJson(row.summary_json)).silent),
  ).length;
  const autoPauses =
    (
      database
        .prepare(
          `
        SELECT COUNT(*) AS count
        FROM routine_events
        WHERE event_type = 'routine_auto_paused'
          AND created_at >= ? AND created_at <= ?;
      `,
        )
        .get(window.since, window.until) as { count?: number } | undefined
    )?.count ?? 0;

  return {
    runs,
    failures,
    failureRate: rate(failures, runs),
    autoPauses,
    silentOutputs,
    silentOutputRate: rate(silentOutputs, runs),
  };
}

function driftTriageHealth(
  database: DatabaseSync,
  window: AutomationHealthSnapshot['window'],
): AutomationHealthSnapshot['driftTriage'] {
  const docsDriftReportIds = reportIds(database, 'docs-drift', window);
  const issueTriageReportIds = reportIds(database, 'issue-triage', window);
  const actedDocsReportIds = distinctWorkflowSummaryFieldValuesUntil(
    database,
    'docs_drift_stage_fix',
    'reportId',
    window.until,
  );
  const docsDriftStagedFixes = intersectionCount(
    docsDriftReportIds,
    actedDocsReportIds,
  );
  const agedCutoff = new Date(
    Date.parse(window.until) - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const agedDocsReportIds = reportIds(database, 'docs-drift', {
    since: window.since,
    until: agedCutoff,
  });
  const agedIssueReportIds = reportIds(database, 'issue-triage', {
    since: window.since,
    until: agedCutoff,
  });
  const agedOutReports =
    [...agedDocsReportIds].filter((id) => !actedDocsReportIds.has(id)).length +
    agedIssueReportIds.size;

  return {
    docsDriftReports: docsDriftReportIds.size,
    docsDriftStagedFixes,
    docsDriftActedOnRate: rate(docsDriftStagedFixes, docsDriftReportIds.size),
    issueTriageReports: issueTriageReportIds.size,
    issueTriageActedOn: 0,
    issueTriageActedOnRate: rate(0, issueTriageReportIds.size),
    agedOutReports,
  };
}

function githubReviewOutcomeSummaries(
  database: DatabaseSync,
  window: AutomationHealthSnapshot['window'],
) {
  return (
    database
      .prepare(
        `
        SELECT summary_json
        FROM workflow_summaries
        WHERE workflow = 'github_pr_review'
          AND created_at >= ? AND created_at <= ?;
      `,
      )
      .all(window.since, window.until) as Array<{ summary_json: string | null }>
  ).map((row) => objectField(parseJson(row.summary_json)));
}

function preparedDiffRevisionStatus(database: DatabaseSync, id: string) {
  const row = database
    .prepare(
      `
      SELECT status, push_approval_status
      FROM prepared_diffs
      WHERE id = ?
      LIMIT 1;
    `,
    )
    .get(id) as { status?: string; push_approval_status?: string } | undefined;
  return {
    status: row?.status ?? 'missing',
    pushApprovalStatus: row?.push_approval_status ?? 'missing',
  };
}

function reportIds(
  database: DatabaseSync,
  kind: string,
  window: Pick<AutomationHealthSnapshot['window'], 'since' | 'until'>,
) {
  const rows = database
    .prepare(
      `
      SELECT id
      FROM reports
      WHERE kind = ?
        AND created_at >= ? AND created_at <= ?;
    `,
    )
    .all(kind, window.since, window.until) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id).filter(Boolean));
}

function distinctWorkflowSummaryFieldValuesUntil(
  database: DatabaseSync,
  workflow: string,
  field: string,
  until: string,
) {
  const rows = database
    .prepare(
      `
      SELECT summary_json
      FROM workflow_summaries
      WHERE workflow = ?
        AND created_at <= ?;
    `,
    )
    .all(workflow, until) as Array<{
    summary_json: string | null;
  }>;
  return new Set(
    rows
      .map((row) =>
        stringField(objectField(parseJson(row.summary_json))[field]),
      )
      .filter((value): value is string => Boolean(value)),
  );
}

function intersectionCount(left: Set<string>, right: Set<string>) {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}

function seedOutcome(
  value: string | null,
): 'submitted' | 'skipped' | 'deleted' | 'pending' {
  if (value === 'submitted' || value === 'skipped' || value === 'deleted') {
    return value;
  }
  return 'pending';
}

function rate(numerator: number, denominator: number) {
  if (denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

function parseJson(value: string | null | undefined) {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberField(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
