import type { JsonValue } from '@flue/runtime';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { listRuntimeSkills } from '../../../runtime-skills';
import type { RuntimePaths } from '../../../runtime-home';
import {
  latestPrRetrospectiveCheckpoint,
  type HandledPrEventRecord,
} from './pr-cadence';
import { listActiveLearningMemories } from './context';
import { compactJson, parseNullableJson, truncate } from './store';

export function listHandledPrEventsForReview(
  input: { repoId?: string; limit: number; sinceLastReview: boolean },
  paths: RuntimePaths,
) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    const filters = ["type = 'pr_handled'"];
    const params: Array<string | number> = [];
    if (input.repoId) {
      filters.push('repo_id = ?');
      params.push(input.repoId);
    }
    if (input.sinceLastReview) {
      const checkpoint = latestPrRetrospectiveCheckpoint(database);
      if (checkpoint) {
        filters.push('created_at > ?');
        params.push(checkpoint);
      }
    }
    return database
      .prepare(
        `
        SELECT *
        FROM learning_events
        WHERE ${filters.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT ?;
      `,
      )
      .all(...params, input.limit)
      .map(readHandledPrEventRow)
      .reverse();
  } finally {
    database.close();
  }
}

export function summarizeHandledPrEvent(event: HandledPrEventRecord) {
  const data = dataRecord(event.data);
  return {
    id: event.id,
    source: event.source,
    sourceId: event.sourceId,
    repoId: event.repoId,
    prKey: event.prKey,
    eventType: data.eventType ?? null,
    repoFullName: data.repoFullName ?? null,
    prNumber: data.prNumber ?? null,
    summary: truncate(String(data.summary ?? ''), 500),
    createdAt: event.createdAt,
  };
}

export async function listPrLearningMemories(
  repoIds: Array<string | null>,
  paths: RuntimePaths,
) {
  const memories = await listActiveLearningMemories(paths);
  const repos = new Set(repoIds);
  return memories.filter((memory) => {
    if (memory.scope === 'user') return false;
    if (memory.scope === 'local') return true;
    return memory.repoId === null || repos.has(memory.repoId);
  });
}

export async function readLearningSkillSnippets(paths: RuntimePaths) {
  const inventory = await listRuntimeSkills(paths);
  const neondeck = inventory.skills.find(
    (skill) => skill.id === 'neondeck' && skill.status === 'active',
  );
  if (!neondeck) return [];
  return [
    {
      id: neondeck.id,
      source: neondeck.source,
      path: neondeck.path,
      content: truncate(await readFile(neondeck.path, 'utf8'), 6_000),
    },
  ];
}

export function listRelatedWorkflowSummaries(
  events: HandledPrEventRecord[],
  paths: RuntimePaths,
) {
  const needles = eventNeedles(events);
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    return database
      .prepare(
        `
        SELECT *
        FROM workflow_summaries
        ORDER BY created_at DESC
        LIMIT 80;
      `,
      )
      .all()
      .map(readWorkflowSummaryLikeRow)
      .filter((summary) => containsAnyNeedle(summary, needles))
      .slice(0, 20);
  } finally {
    database.close();
  }
}

export function listRelatedPreparedDiffSummaries(
  events: HandledPrEventRecord[],
  paths: RuntimePaths,
) {
  const keys = prEventKeys(events);
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    return database
      .prepare(
        `
        SELECT id, repo_id, repo_full_name, pr_number, status,
          push_approval_status, verification_status, summary_json,
          created_by, created_at, updated_at, abandoned_at
        FROM prepared_diffs
        ORDER BY updated_at DESC
        LIMIT 80;
      `,
      )
      .all()
      .map((row) => {
        const record = row as Record<string, unknown>;
        return {
          id: String(record.id),
          repoId: String(record.repo_id),
          repoFullName: String(record.repo_full_name),
          prNumber:
            typeof record.pr_number === 'number' ? record.pr_number : null,
          status: String(record.status),
          pushApprovalStatus: String(record.push_approval_status),
          verificationStatus: String(record.verification_status),
          summary: summarizeJson(parseNullableJson(record.summary_json), 2_000),
          createdBy: String(record.created_by),
          createdAt: String(record.created_at),
          updatedAt: String(record.updated_at),
          abandonedAt:
            typeof record.abandoned_at === 'string'
              ? record.abandoned_at
              : null,
        };
      })
      .filter((item) => keys.has(`${item.repoId}#${item.prNumber}`))
      .slice(0, 20);
  } finally {
    database.close();
  }
}

export function listRelatedVerificationSummaries(
  events: HandledPrEventRecord[],
  paths: RuntimePaths,
) {
  return listRelatedWorkflowSummaries(events, paths)
    .filter((summary) => /verify|check|ci/i.test(summary.workflow))
    .slice(0, 12);
}

export function listRelatedNotificationSummaries(
  events: HandledPrEventRecord[],
  paths: RuntimePaths,
) {
  const needles = eventNeedles(events);
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    return database
      .prepare(
        `
        SELECT level, title, message, source, source_id, data_json,
          occurrence_count, created_at, updated_at, resolved_at
        FROM notifications
        ORDER BY updated_at DESC
        LIMIT 80;
      `,
      )
      .all()
      .map((row) => {
        const record = row as Record<string, unknown>;
        return {
          level: String(record.level),
          title: truncate(String(record.title), 200),
          message: truncate(String(record.message), 400),
          source: typeof record.source === 'string' ? record.source : null,
          sourceId:
            typeof record.source_id === 'string' ? record.source_id : null,
          data: summarizeJson(parseNullableJson(record.data_json), 1_000),
          occurrenceCount: Number(record.occurrence_count ?? 1),
          createdAt: String(record.created_at),
          updatedAt: String(record.updated_at),
          resolvedAt:
            typeof record.resolved_at === 'string' ? record.resolved_at : null,
        };
      })
      .filter((item) => containsAnyNeedle(item, needles))
      .slice(0, 20);
  } finally {
    database.close();
  }
}

export function listRelatedKiloResultSummaries(
  events: HandledPrEventRecord[],
  paths: RuntimePaths,
) {
  const needles = eventNeedles(events);
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    return database
      .prepare(
        `
        SELECT krs.task_id, kt.repo_id, kt.repo_full_name, wt.pr_number,
          krs.prepared_diff_id, krs.classification, krs.verification_status,
          krs.promotion_status, krs.review_summary_json, krs.diff_summary_json,
          krs.verification_json, krs.promotion_json, krs.updated_at
        FROM kilo_result_state krs
        LEFT JOIN kilo_tasks kt ON kt.id = krs.task_id
        LEFT JOIN worktrees wt ON wt.id = kt.worktree_id
        ORDER BY krs.updated_at DESC
        LIMIT 80;
      `,
      )
      .all()
      .map((row) => {
        const record = row as Record<string, unknown>;
        return {
          taskId: String(record.task_id),
          repoId: typeof record.repo_id === 'string' ? record.repo_id : null,
          repoFullName:
            typeof record.repo_full_name === 'string'
              ? record.repo_full_name
              : null,
          prNumber:
            typeof record.pr_number === 'number' ? record.pr_number : null,
          preparedDiffId:
            typeof record.prepared_diff_id === 'string'
              ? record.prepared_diff_id
              : null,
          classification: String(record.classification),
          verificationStatus: String(record.verification_status),
          promotionStatus: String(record.promotion_status),
          reviewSummary: summarizeJson(
            parseNullableJson(record.review_summary_json),
            1_000,
          ),
          diffSummary: summarizeJson(
            parseNullableJson(record.diff_summary_json),
            1_000,
          ),
          verification: summarizeJson(
            parseNullableJson(record.verification_json),
            1_000,
          ),
          promotion: summarizeJson(
            parseNullableJson(record.promotion_json),
            1_000,
          ),
          updatedAt: String(record.updated_at),
        };
      })
      .filter((item) => containsAnyNeedle(item, needles))
      .slice(0, 20);
  } finally {
    database.close();
  }
}

export function extractHandledPrEvent(input: {
  workflow?: string | null;
  runId?: string | null;
  result: unknown;
}) {
  const result = objectRecord(input.result);
  if (!result) return null;
  const action = typeof result.action === 'string' ? result.action : null;
  const data = objectRecord(result.data) ?? {};
  const recoveryAction = firstString(data.recoveryAction);
  const nestedResult =
    objectRecord(data.verification) ??
    objectRecord(data.promotion) ??
    objectRecord(data.result) ??
    objectRecord(result.result);
  const nestedData = objectRecord(nestedResult?.data) ?? {};
  const task = objectRecord(result.task) ?? objectRecord(data.task);
  const resultState =
    objectRecord(result.resultState) ?? objectRecord(data.resultState);
  const preparedDiff =
    objectRecord(result.preparedDiff) ??
    objectRecord(data.preparedDiff) ??
    objectRecord(nestedResult?.preparedDiff) ??
    objectRecord(nestedData.preparedDiff) ??
    objectRecord(result.preparedDiffVerification) ??
    objectRecord(data.preparedDiffVerification) ??
    objectRecord(nestedResult?.preparedDiffVerification) ??
    objectRecord(nestedData.preparedDiffVerification);
  const worktree =
    objectRecord(result.worktree) ??
    objectRecord(data.worktree) ??
    objectRecord(nestedResult?.worktree) ??
    objectRecord(nestedData.worktree);
  const repoId = firstString(
    result.repoId,
    data.repoId,
    nestedResult?.repoId,
    nestedData.repoId,
    preparedDiff?.repoId,
    worktree?.repoId,
    task?.repoId,
  );
  const repoFullName = firstString(
    result.repoFullName,
    data.repoFullName,
    nestedResult?.repoFullName,
    nestedData.repoFullName,
    preparedDiff?.repoFullName,
    worktree?.repoFullName,
    task?.repoFullName,
  );
  const prNumber = firstNumber(
    result.prNumber,
    data.prNumber,
    nestedResult?.prNumber,
    nestedData.prNumber,
    preparedDiff?.prNumber,
    worktree?.prNumber,
  );
  if ((!repoId && !repoFullName) || !prNumber) return null;

  const preparedDiffId = firstString(
    result.preparedDiffId,
    data.preparedDiffId,
    nestedResult?.preparedDiffId,
    nestedData.preparedDiffId,
    preparedDiff?.id,
  );
  const worktreeId = firstString(
    result.worktreeId,
    data.worktreeId,
    nestedResult?.worktreeId,
    nestedData.worktreeId,
    worktree?.id,
  );
  const taskId = firstString(
    result.taskId,
    data.taskId,
    nestedResult?.taskId,
    nestedData.taskId,
    task?.id,
    resultState?.taskId,
  );
  const resultOk = firstBoolean(
    result.ok,
    data.ok,
    nestedResult?.ok,
    nestedData.ok,
  );
  const changed = firstBoolean(
    result.changed,
    data.changed,
    nestedResult?.changed,
    nestedData.changed,
  );
  const blocked = hasRequires(
    result.requires,
    data.requires,
    nestedResult?.requires,
    nestedData.requires,
  );
  if (action === 'prepared_diff_run_verification') return null;
  if (
    action === 'autopilot_recovery_run' &&
    !countedRecoveryAction(recoveryAction)
  ) {
    return null;
  }
  if (isAutopilotFixOutcome(action, input.workflow) && resultOk !== false) {
    if (!preparedDiff && changed !== true) return null;
  }
  const eventType = handledEventType(
    action,
    input.workflow,
    preparedDiff ?? undefined,
    { ok: resultOk, blocked },
  );
  if (!eventType) return null;
  const stableSource =
    [
      preparedDiffId ??
        taskId ??
        worktreeId ??
        firstString(result.id, data.id) ??
        input.runId ??
        'unknown',
      recoveryAction,
    ]
      .filter(Boolean)
      .join(':') || 'unknown';
  const sourceId = `${repoFullName ?? repoId}#${prNumber}:${eventType}:${stableSource}`;
  return {
    eventType,
    source: input.workflow ?? action ?? 'workflow',
    sourceId,
    repoId: repoId ?? null,
    repoFullName: repoFullName ?? null,
    prNumber,
    summary: firstString(result.message, data.message, result.summary) ?? null,
    data: compactJson({
      action,
      workflow: input.workflow ?? null,
      runId: input.runId ?? null,
      preparedDiffId: preparedDiffId ?? null,
      worktreeId: worktreeId ?? null,
      taskId: taskId ?? null,
      ok: resultOk,
      changed,
      blocked,
      recoveryAction: recoveryAction ?? null,
      status: firstString(result.status, data.status, preparedDiff?.status),
    }),
  };
}

export function countedRecoveryAction(value: string | null | undefined) {
  return (
    value === 'retry-after-new-commit' ||
    value === 'rebase-resync-worktree' ||
    value === 'retry-verify' ||
    value === 'retry-push' ||
    value === 'retry-comment' ||
    value === 'request-revision' ||
    value === 'cleanup-worktree' ||
    value === 'abandon'
  );
}

export function isAutopilotFixOutcome(
  action: string | null,
  workflow?: string | null,
) {
  const value = `${workflow ?? ''}:${action ?? ''}`.toLowerCase();
  return (
    value.includes('fix_pr_review') ||
    value.includes('review-feedback') ||
    value.includes('fix_pr_ci') ||
    value.includes('ci-failure')
  );
}

export function handledEventType(
  action: string | null,
  workflow?: string | null,
  preparedDiff?: Record<string, unknown>,
  outcome: { ok: boolean | null; blocked: boolean } = {
    ok: null,
    blocked: false,
  },
) {
  const value = `${workflow ?? ''}:${action ?? ''}`.toLowerCase();
  const outcomeLabel = (completed: string, blocked: string, failed: string) =>
    outcome.ok === false ? (outcome.blocked ? blocked : failed) : completed;
  if (value.includes('fix_pr_review') || value.includes('review-feedback')) {
    return outcomeLabel(
      'review-feedback-workflow-completed',
      'review-feedback-workflow-blocked',
      'review-feedback-workflow-failed',
    );
  }
  if (value.includes('fix_pr_ci') || value.includes('ci-failure')) {
    return outcomeLabel(
      'ci-failure-workflow-completed',
      'ci-failure-workflow-blocked',
      'ci-failure-workflow-failed',
    );
  }
  if (value.includes('verify_pr') || value.includes('verification')) {
    return outcomeLabel(
      'prepared-diff-verified',
      'prepared-diff-verification-blocked',
      'prepared-diff-verification-failed',
    );
  }
  if (value.includes('push_pr') || value.includes('push_autofix')) {
    return outcomeLabel(
      'prepared-diff-pushed',
      'prepared-diff-push-blocked',
      'prepared-diff-push-failed',
    );
  }
  if (value.includes('comment_pr')) {
    return outcomeLabel(
      'result-comment-completed',
      'result-comment-blocked',
      'result-comment-failed',
    );
  }
  if (value.includes('recovery')) {
    return outcomeLabel(
      'notification-recovery-completed',
      'notification-recovery-blocked',
      'notification-recovery-failed',
    );
  }
  if (value.includes('kilo_result_review')) {
    return outcomeLabel(
      'kilo-result-reviewed',
      'kilo-result-review-blocked',
      'kilo-result-review-failed',
    );
  }
  if (value.includes('kilo_result_promote')) {
    return outcomeLabel(
      'kilo-result-promoted',
      'kilo-result-promotion-blocked',
      'kilo-result-promotion-failed',
    );
  }
  if (value.includes('kilo_result_verify')) {
    return outcomeLabel(
      'kilo-result-verified',
      'kilo-result-verification-blocked',
      'kilo-result-verification-failed',
    );
  }
  const status =
    typeof preparedDiff?.status === 'string' ? preparedDiff.status : null;
  if (status === 'abandoned') return 'prepared-diff-abandoned';
  if (preparedDiff) {
    return outcomeLabel(
      'prepared-diff-created',
      'prepared-diff-blocked',
      'prepared-diff-failed',
    );
  }
  return null;
}

export function readHandledPrEventRow(row: unknown): HandledPrEventRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    source: String(record.source),
    sourceId: typeof record.source_id === 'string' ? record.source_id : null,
    repoId: typeof record.repo_id === 'string' ? record.repo_id : null,
    prKey: typeof record.pr_key === 'string' ? record.pr_key : null,
    data: parseNullableJson(record.data_json),
    createdAt: String(record.created_at),
  };
}

export function readWorkflowSummaryLikeRow(row: unknown) {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    workflow: String(record.workflow),
    runId: typeof record.run_id === 'string' ? record.run_id : null,
    status: String(record.status),
    summary: summarizeJson(parseNullableJson(record.summary_json), 2_000),
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
  };
}

export function prEventKeys(events: HandledPrEventRecord[]) {
  return new Set(
    events
      .map((event) => {
        const data = dataRecord(event.data);
        const prNumber =
          typeof data.prNumber === 'number'
            ? data.prNumber
            : event.prKey?.split('#').at(-1);
        return event.repoId && prNumber ? `${event.repoId}#${prNumber}` : null;
      })
      .filter((key): key is string => !!key),
  );
}

export function eventNeedles(events: HandledPrEventRecord[]) {
  const values = new Set<string>();
  for (const event of events) {
    if (event.sourceId) values.add(event.sourceId);
    if (event.repoId) values.add(event.repoId);
    if (event.prKey) values.add(event.prKey);
    const data = dataRecord(event.data);
    for (const key of ['repoFullName', 'preparedDiffId', 'taskId']) {
      if (typeof data[key] === 'string') values.add(data[key]);
    }
    if (typeof data.prNumber === 'number') values.add(`#${data.prNumber}`);
  }
  return values;
}

export function containsAnyNeedle(value: unknown, needles: Set<string>) {
  const serialized = JSON.stringify(value);
  for (const needle of needles) {
    if (needle && serialized.includes(needle)) return true;
  }
  return false;
}

export function dataRecord(value: JsonValue | null) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function objectRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === 'string');
}

export function firstNumber(...values: unknown[]) {
  return values.find(
    (value): value is number =>
      typeof value === 'number' && Number.isFinite(value),
  );
}

export function firstBoolean(...values: unknown[]) {
  return (
    values.find((value): value is boolean => typeof value === 'boolean') ?? null
  );
}

export function hasRequires(...values: unknown[]) {
  return values.some((value) => Array.isArray(value) && value.length > 0);
}

export function summarizeJson(value: JsonValue | null, maxLength: number) {
  if (value === null) return null;
  return truncate(JSON.stringify(value), maxLength);
}
