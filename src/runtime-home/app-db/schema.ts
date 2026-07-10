import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const appMetadata = sqliteTable('app_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const configHistory = sqliteTable('config_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  action: text('action').notNull(),
  file: text('file').notNull(),
  target: text('target'),
  beforeJson: text('before_json'),
  afterJson: text('after_json'),
  changedAt: text('changed_at').notNull(),
});

export const prWatches = sqliteTable(
  'pr_watches',
  {
    id: text('id').primaryKey(),
    repoId: text('repo_id').notNull(),
    repoFullName: text('repo_full_name').notNull(),
    githubOwner: text('github_owner').notNull(),
    githubName: text('github_name').notNull(),
    prNumber: integer('pr_number').notNull(),
    desiredTerminalState: text('desired_terminal_state').notNull(),
    status: text('status').notNull(),
    prState: text('pr_state'),
    title: text('title'),
    url: text('url'),
    mergeCommitSha: text('merge_commit_sha'),
    lastSnapshotJson: text('last_snapshot_json'),
    lastOutcome: text('last_outcome'),
    lastCheckedAt: text('last_checked_at'),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [unique().on(table.repoFullName, table.prNumber)],
);

export const refWatches = sqliteTable(
  'ref_watches',
  {
    id: text('id').primaryKey(),
    repoId: text('repo_id').notNull(),
    repoFullName: text('repo_full_name').notNull(),
    githubOwner: text('github_owner').notNull(),
    githubName: text('github_name').notNull(),
    ref: text('ref').notNull(),
    status: text('status').notNull(),
    title: text('title'),
    url: text('url'),
    lastSnapshotJson: text('last_snapshot_json'),
    lastOutcome: text('last_outcome'),
    lastCheckedAt: text('last_checked_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [unique().on(table.repoFullName, table.ref)],
);

export const prWatchEventWatermarks = sqliteTable(
  'pr_watch_event_watermarks',
  {
    watchId: text('watch_id').notNull(),
    category: text('category').notNull(),
    watermarkJson: text('watermark_json').notNull(),
    sourceUpdatedAt: text('source_updated_at'),
    checkedAt: text('checked_at').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.watchId, table.category] }),
    index('idx_pr_watch_event_watermarks_watch').on(
      table.watchId,
      sql`${table.updatedAt} DESC`,
    ),
  ],
);

export const scheduledTasks = sqliteTable(
  'scheduled_tasks',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    triggerJson: text('trigger_json').notNull(),
    payloadJson: text('payload_json').notNull(),
    enabled: integer('enabled').default(1).notNull(),
    nextRunAt: text('next_run_at'),
    claimId: text('claim_id'),
    claimExpiresAt: text('claim_expires_at'),
    lastRunAt: text('last_run_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_scheduled_tasks_due').on(
      table.enabled,
      table.nextRunAt,
      table.claimExpiresAt,
    ),
    index('idx_scheduled_tasks_kind').on(table.kind, table.enabled),
  ],
);

export const scheduledTaskRuns = sqliteTable(
  'scheduled_task_runs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    status: text('status').notNull(),
    outcome: text('outcome').notNull(),
    message: text('message').notNull(),
    workflowRunId: text('workflow_run_id'),
    sessionId: text('session_id'),
    resultJson: text('result_json'),
    error: text('error'),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_scheduled_task_runs_task').on(
      table.taskId,
      sql`${table.createdAt} DESC`,
    ),
    index('idx_scheduled_task_runs_status').on(
      table.status,
      sql`${table.updatedAt} DESC`,
    ),
  ],
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    level: text('level').notNull(),
    title: text('title').notNull(),
    message: text('message').notNull(),
    source: text('source'),
    sourceId: text('source_id'),
    dataJson: text('data_json'),
    readAt: text('read_at'),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
    updatedAt: text('updated_at'),
    occurrenceCount: integer('occurrence_count').default(1).notNull(),
  },
  (table) => [
    index('idx_notifications_source_unresolved').on(
      table.source,
      table.sourceId,
      table.resolvedAt,
    ),
    index('idx_notifications_attention').on(
      table.resolvedAt,
      table.readAt,
      table.level,
      sql`${table.createdAt} DESC`,
    ),
  ],
);

export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    valueJson: text('value_json').notNull(),
    repoId: text('repo_id'),
    status: text('status').default('active').notNull(),
    useCount: integer('use_count').default(0).notNull(),
    lastUsedAt: text('last_used_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_memories_active_scope').on(
      table.status,
      table.scope,
      sql`${table.updatedAt} DESC`,
    ),
    uniqueIndex('idx_memories_scope_key_repo').on(
      table.scope,
      table.key,
      sql`COALESCE(${table.repoId}, '')`,
    ),
  ],
);

export const memoryEvents = sqliteTable(
  'memory_events',
  {
    id: text('id').primaryKey(),
    memoryId: text('memory_id'),
    action: text('action').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason'),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_memory_events_changed').on(sql`${table.createdAt} DESC`),
  ],
);

export const learningEvents = sqliteTable(
  'learning_events',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    source: text('source').notNull(),
    sourceId: text('source_id'),
    repoId: text('repo_id'),
    sessionId: text('session_id'),
    prKey: text('pr_key'),
    dataJson: text('data_json'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_learning_events_type').on(
      table.type,
      sql`${table.createdAt} DESC`,
    ),
    uniqueIndex('idx_learning_pr_handled_source')
      .on(table.sourceId)
      .where(
        sql`${table.type} = 'pr_handled' AND ${table.sourceId} IS NOT NULL`,
      ),
  ],
);

export const learningReviews = sqliteTable(
  'learning_reviews',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    model: text('model').notNull(),
    thinkingLevel: text('thinking_level').notNull(),
    triggerJson: text('trigger_json').notNull(),
    inputSummaryJson: text('input_summary_json'),
    resultJson: text('result_json'),
    error: text('error'),
    flueRunId: text('flue_run_id'),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
  },
  (table) => [
    index('idx_learning_reviews_kind').on(
      table.kind,
      table.status,
      sql`${table.startedAt} DESC`,
    ),
  ],
);

export const learningCandidates = sqliteTable(
  'learning_candidates',
  {
    id: text('id').primaryKey(),
    target: text('target').notNull(),
    status: text('status').notNull(),
    action: text('action'),
    scope: text('scope'),
    key: text('key'),
    valueJson: text('value_json'),
    skillId: text('skill_id'),
    patchJson: text('patch_json'),
    repoId: text('repo_id'),
    reason: text('reason'),
    reviewId: text('review_id'),
    createdAt: text('created_at').notNull(),
    decidedAt: text('decided_at'),
  },
  (table) => [
    index('idx_learning_candidates_status').on(
      table.target,
      table.status,
      sql`${table.createdAt} DESC`,
    ),
  ],
);

export const workflowSummaries = sqliteTable('workflow_summaries', {
  id: text('id').primaryKey(),
  workflow: text('workflow').notNull(),
  runId: text('run_id'),
  status: text('status').notNull(),
  summaryJson: text('summary_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const reports = sqliteTable(
  'reports',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    repoId: text('repo_id'),
    sourceRef: text('source_ref'),
    htmlPath: text('html_path').notNull(),
    summaryJson: text('summary_json'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_reports_kind_created').on(
      table.kind,
      sql`${table.createdAt} DESC`,
    ),
    index('idx_reports_repo_created').on(
      table.repoId,
      sql`${table.createdAt} DESC`,
    ),
  ],
);

export const prReviewDrafts = sqliteTable(
  'pr_review_drafts',
  {
    id: text('id').primaryKey(),
    repo: text('repo').notNull(),
    prNumber: integer('pr_number').notNull(),
    headSha: text('head_sha').notNull(),
    verdict: text('verdict'),
    body: text('body'),
    status: text('status').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    submittedAt: text('submitted_at'),
  },
  (table) => [
    uniqueIndex('idx_pr_review_drafts_live')
      .on(table.repo, table.prNumber)
      .where(sql`${table.status} = 'draft'`),
    index('idx_pr_review_drafts_pr').on(
      table.repo,
      table.prNumber,
      sql`${table.updatedAt} DESC`,
    ),
  ],
);

export const prReviewDraftComments = sqliteTable(
  'pr_review_draft_comments',
  {
    id: text('id').primaryKey(),
    draftId: text('draft_id')
      .notNull()
      .references(() => prReviewDrafts.id),
    path: text('path').notNull(),
    side: text('side').notNull(),
    line: integer('line').notNull(),
    startLine: integer('start_line'),
    startSide: text('start_side'),
    body: text('body').notNull(),
    origin: text('origin').default('human').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_pr_review_draft_comments_draft').on(
      table.draftId,
      sql`${table.createdAt} ASC`,
    ),
  ],
);

export const prReviewNeonSeededComments = sqliteTable(
  'pr_review_neon_seeded_comments',
  {
    commentId: text('comment_id').primaryKey(),
    draftId: text('draft_id')
      .notNull()
      .references(() => prReviewDrafts.id),
    repo: text('repo').notNull(),
    prNumber: integer('pr_number').notNull(),
    headSha: text('head_sha').notNull(),
    path: text('path').notNull(),
    side: text('side').notNull(),
    line: integer('line').notNull(),
    startLine: integer('start_line'),
    startSide: text('start_side'),
    severity: text('severity').notNull(),
    summary: text('summary').notNull(),
    source: text('source').notNull(),
    outcome: text('outcome'),
    outcomeAt: text('outcome_at'),
    seededAt: text('seeded_at').notNull(),
  },
  (table) => [
    index('idx_pr_review_neon_seeded_comments_draft').on(
      table.draftId,
      sql`${table.seededAt} ASC`,
    ),
    index('idx_pr_review_neon_seeded_comments_pr').on(
      table.repo,
      table.prNumber,
      sql`${table.seededAt} ASC`,
    ),
  ],
);

export const githubPrFileCache = sqliteTable(
  'github_pr_file_cache',
  {
    repo: text('repo').notNull(),
    prNumber: integer('pr_number').notNull(),
    headSha: text('head_sha').notNull(),
    payload: text('payload').notNull(),
    byteSize: integer('byte_size').notNull(),
    fetchedAt: text('fetched_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.repo, table.prNumber, table.headSha] }),
  ],
);

export const workflowEvents = sqliteTable(
  'workflow_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id'),
    workflow: text('workflow'),
    eventType: text('event_type').notNull(),
    eventIndex: integer('event_index'),
    level: text('level'),
    message: text('message').notNull(),
    name: text('name'),
    operationKind: text('operation_kind'),
    operationId: text('operation_id'),
    durationMs: integer('duration_ms'),
    isError: integer('is_error').default(0).notNull(),
    summaryJson: text('summary_json'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_workflow_events_run').on(table.runId, table.eventIndex),
    index('idx_workflow_events_created').on(sql`${table.createdAt} DESC`),
  ],
);

export const workflowRunObservations = sqliteTable(
  'workflow_run_observations',
  {
    runId: text('run_id').primaryKey(),
    workflow: text('workflow').notNull(),
    status: text('status').notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    lastEventAt: text('last_event_at').notNull(),
    lastMessage: text('last_message').notNull(),
    eventCount: integer('event_count').default(0).notNull(),
    durationMs: integer('duration_ms'),
    isError: integer('is_error').default(0).notNull(),
    updatedAt: text('updated_at').notNull(),
  },
);

export const autopilotAdmissions = sqliteTable(
  'autopilot_admissions',
  {
    id: text('id').primaryKey(),
    watchId: text('watch_id').notNull(),
    eventFingerprint: text('event_fingerprint').notNull(),
    repoId: text('repo_id').notNull(),
    prNumber: integer('pr_number').notNull(),
    mode: text('mode').notNull(),
    state: text('state').notNull(),
    priority: integer('priority').default(0).notNull(),
    currentWorkflow: text('current_workflow'),
    currentRunId: text('current_run_id'),
    worktreeId: text('worktree_id'),
    preparedDiffId: text('prepared_diff_id'),
    attemptCount: integer('attempt_count').default(0).notNull(),
    nextAttemptAt: text('next_attempt_at'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_autopilot_admissions_watch_event').on(
      table.watchId,
      table.eventFingerprint,
    ),
    index('idx_autopilot_admissions_state_due').on(
      table.state,
      table.nextAttemptAt,
      sql`${table.updatedAt} DESC`,
    ),
    index('idx_autopilot_admissions_repo_pr').on(
      table.repoId,
      table.prNumber,
      table.state,
    ),
  ],
);

export const neonSessions = sqliteTable('neon_sessions', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  agentName: text('agent_name').notNull(),
  status: text('status').notNull(),
  reason: text('reason'),
  createdAt: text('created_at').notNull(),
  activatedAt: text('activated_at').notNull(),
  endedAt: text('ended_at'),
  updatedAt: text('updated_at').notNull(),
});

export const chatSessions = sqliteTable(
  'chat_sessions',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    agentName: text('agent_name').notNull(),
    kind: text('kind').notNull(),
    pinned: integer('pinned').default(0).notNull(),
    archivedAt: text('archived_at'),
    linkedRepoId: text('linked_repo_id'),
    linkedWatchId: text('linked_watch_id'),
    linkedTaskId: text('linked_task_id'),
    staleReasonsJson: text('stale_reasons_json'),
    uiMetadataJson: text('ui_metadata_json'),
    summary: text('summary'),
    summaryGeneratedAt: text('summary_generated_at'),
    summarySource: text('summary_source'),
    summaryRefreshNote: text('summary_refresh_note'),
    contextLoadedAt: text('context_loaded_at'),
    contextMemoryIdsJson: text('context_memory_ids_json'),
    learningTurnCount: integer('learning_turn_count').default(0).notNull(),
    lastLearningReviewTurnCount: integer('last_learning_review_turn_count')
      .default(0)
      .notNull(),
    lastLearningReviewAt: text('last_learning_review_at'),
    lastLearningCurationTurnCount: integer('last_learning_curation_turn_count')
      .default(0)
      .notNull(),
    lastLearningCurationAt: text('last_learning_curation_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastActiveAt: text('last_active_at').notNull(),
  },
  (table) => [
    index('idx_chat_sessions_recent').on(
      table.archivedAt,
      sql`${table.pinned} DESC`,
      sql`${table.lastActiveAt} DESC`,
    ),
    index('idx_chat_sessions_kind').on(
      table.kind,
      table.archivedAt,
      sql`${table.lastActiveAt} DESC`,
    ),
  ],
);

export const chatSessionSurfaces = sqliteTable('chat_session_surfaces', {
  surface: text('surface').primaryKey(),
  sessionId: text('session_id').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const chatSessionAudit = sqliteTable(
  'chat_session_audit',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    action: text('action').notNull(),
    sessionId: text('session_id'),
    surface: text('surface'),
    reason: text('reason'),
    metadataJson: text('metadata_json'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_chat_session_audit_session').on(
      table.sessionId,
      sql`${table.createdAt} DESC`,
    ),
  ],
);

export const chatSessionCommandEvents = sqliteTable(
  'chat_session_command_events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    input: text('input').notNull(),
    status: text('status').notNull(),
    resultJson: text('result_json'),
    flueRunId: text('flue_run_id'),
    workflowSummaryId: text('workflow_summary_id'),
    createdAt: text('created_at').notNull(),
    completedAt: text('completed_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_chat_session_command_events_session').on(
      table.sessionId,
      sql`${table.createdAt} DESC`,
    ),
  ],
);

export const executionApprovals = sqliteTable(
  'execution_approvals',
  {
    id: text('id').primaryKey(),
    command: text('command').notNull(),
    backend: text('backend').notNull(),
    cwd: text('cwd'),
    context: text('context').notNull(),
    risk: text('risk').notNull(),
    policyDecision: text('policy_decision').notNull(),
    status: text('status').notNull(),
    approvalDecision: text('approval_decision'),
    approverSurface: text('approver_surface'),
    sessionId: text('session_id'),
    requestContextJson: text('request_context_json'),
    resultJson: text('result_json'),
    exitCode: integer('exit_code'),
    stdoutPreview: text('stdout_preview'),
    stderrPreview: text('stderr_preview'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
    usedAt: text('used_at'),
    executedAt: text('executed_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_execution_approvals_status').on(
      table.status,
      sql`${table.updatedAt} DESC`,
    ),
    index('idx_execution_approvals_updated').on(sql`${table.updatedAt} DESC`),
  ],
);

export const repoEditEvents = sqliteTable(
  'repo_edit_events',
  {
    id: text('id').primaryKey(),
    repoId: text('repo_id').notNull(),
    sessionId: text('session_id'),
    workflowRunId: text('workflow_run_id'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    status: text('status').notNull(),
    reason: text('reason'),
    pathsJson: text('paths_json').notNull(),
    inputHash: text('input_hash'),
    diffSummaryJson: text('diff_summary_json'),
    diffPatch: text('diff_patch'),
    errorJson: text('error_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    worktreeId: text('worktree_id'),
  },
  (table) => [
    index('idx_repo_edit_events_updated').on(sql`${table.updatedAt} DESC`),
    index('idx_repo_edit_events_repo').on(
      table.repoId,
      sql`${table.updatedAt} DESC`,
    ),
  ],
);

export const repoFileReads = sqliteTable(
  'repo_file_reads',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id'),
    repoId: text('repo_id').notNull(),
    worktreeId: text('worktree_id'),
    path: text('path').notNull(),
    mtimeMs: real('mtime_ms').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    partial: integer('partial').default(0).notNull(),
    readAt: text('read_at').notNull(),
  },
  (table) => [
    index('idx_repo_file_reads_lookup').on(
      table.sessionId,
      table.repoId,
      table.worktreeId,
      table.path,
      sql`${table.readAt} DESC`,
    ),
  ],
);

export const worktrees = sqliteTable(
  'worktrees',
  {
    id: text('id').primaryKey(),
    repoId: text('repo_id').notNull(),
    repoFullName: text('repo_full_name').notNull(),
    githubOwner: text('github_owner').notNull(),
    githubName: text('github_name').notNull(),
    prNumber: integer('pr_number'),
    baseRef: text('base_ref').notNull(),
    headOwner: text('head_owner'),
    headName: text('head_name'),
    headRef: text('head_ref').notNull(),
    headSha: text('head_sha'),
    localPath: text('local_path').notNull(),
    storageKind: text('storage_kind').notNull(),
    owningWorkflowRunId: text('owning_workflow_run_id'),
    lifecycleStatus: text('lifecycle_status').notNull(),
    lastSyncedSha: text('last_synced_sha'),
    lastPushedSha: text('last_pushed_sha'),
    cleanupPolicyJson: text('cleanup_policy_json'),
    directPushAllowed: integer('direct_push_allowed').default(0).notNull(),
    adopted: integer('adopted').default(0).notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    unique().on(table.localPath),
    index('idx_worktrees_repo').on(
      table.repoId,
      table.lifecycleStatus,
      sql`${table.updatedAt} DESC`,
    ),
    index('idx_worktrees_pr').on(
      table.repoId,
      table.prNumber,
      table.headRef,
      table.lifecycleStatus,
    ),
  ],
);

export const worktreeLocks = sqliteTable(
  'worktree_locks',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    scopeKey: text('scope_key').notNull(),
    worktreeId: text('worktree_id'),
    repoId: text('repo_id').notNull(),
    prNumber: integer('pr_number'),
    owner: text('owner').notNull(),
    workflowRunId: text('workflow_run_id'),
    expiresAt: text('expires_at').notNull(),
    releasedAt: text('released_at'),
    staleRecoveredAt: text('stale_recovered_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_worktree_locks_active').on(
      table.scopeKey,
      table.releasedAt,
      table.expiresAt,
    ),
    uniqueIndex('idx_worktree_locks_one_active')
      .on(table.scopeKey)
      .where(sql`${table.releasedAt} IS NULL`),
  ],
);

export const worktreeEvents = sqliteTable(
  'worktree_events',
  {
    id: text('id').primaryKey(),
    worktreeId: text('worktree_id').notNull(),
    repoId: text('repo_id').notNull(),
    eventType: text('event_type').notNull(),
    status: text('status').notNull(),
    message: text('message').notNull(),
    dataJson: text('data_json'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_worktree_events_worktree').on(
      table.worktreeId,
      sql`${table.createdAt} DESC`,
    ),
  ],
);

export const worktreeCleanupAttempts = sqliteTable(
  'worktree_cleanup_attempts',
  {
    id: text('id').primaryKey(),
    worktreeId: text('worktree_id').notNull(),
    repoId: text('repo_id').notNull(),
    action: text('action').notNull(),
    outcome: text('outcome').notNull(),
    reason: text('reason').notNull(),
    error: text('error'),
    deleted: integer('deleted').default(0).notNull(),
    attemptedAt: text('attempted_at').notNull(),
  },
  (table) => [
    index('idx_worktree_cleanup_attempts_worktree').on(
      table.worktreeId,
      sql`${table.attemptedAt} DESC`,
    ),
  ],
);

export const preparedDiffs = sqliteTable(
  'prepared_diffs',
  {
    id: text('id').primaryKey(),
    worktreeId: text('worktree_id').notNull(),
    repoId: text('repo_id').notNull(),
    repoFullName: text('repo_full_name').notNull(),
    prNumber: integer('pr_number'),
    title: text('title').notNull(),
    sourceWorktreePath: text('source_worktree_path').notNull(),
    baseRef: text('base_ref').notNull(),
    headRef: text('head_ref').notNull(),
    headSha: text('head_sha'),
    status: text('status').notNull(),
    pushApprovalStatus: text('push_approval_status').notNull(),
    verificationStatus: text('verification_status').notNull(),
    summaryJson: text('summary_json'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    abandonedAt: text('abandoned_at'),
  },
  (table) => [
    unique().on(table.worktreeId),
    index('idx_prepared_diffs_status').on(
      table.status,
      sql`${table.updatedAt} DESC`,
    ),
    index('idx_prepared_diffs_repo').on(
      table.repoId,
      table.prNumber,
      sql`${table.updatedAt} DESC`,
    ),
  ],
);

export const preparedDiffApprovals = sqliteTable(
  'prepared_diff_approvals',
  {
    id: text('id').primaryKey(),
    preparedDiffId: text('prepared_diff_id').notNull(),
    worktreeId: text('worktree_id').notNull(),
    approvalType: text('approval_type').notNull(),
    status: text('status').notNull(),
    reason: text('reason'),
    approverSurface: text('approver_surface'),
    requestedAt: text('requested_at').notNull(),
    resolvedAt: text('resolved_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_prepared_diff_approvals_pending').on(
      table.status,
      sql`${table.updatedAt} DESC`,
    ),
    index('idx_prepared_diff_approvals_diff').on(
      table.preparedDiffId,
      sql`${table.updatedAt} DESC`,
    ),
  ],
);

export const kiloTasks = sqliteTable(
  'kilo_tasks',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    prompt: text('prompt').notNull(),
    repoId: text('repo_id').notNull(),
    repoFullName: text('repo_full_name').notNull(),
    worktreeId: text('worktree_id'),
    lockId: text('lock_id'),
    cwd: text('cwd').notNull(),
    mode: text('mode').notNull(),
    status: text('status').notNull(),
    explicitUserRequest: integer('explicit_user_request').notNull(),
    autoEnabled: integer('auto_enabled').default(0).notNull(),
    cliPath: text('cli_path').notNull(),
    argsJson: text('args_json').notNull(),
    pid: integer('pid'),
    processStartedAt: text('process_started_at'),
    rootSessionId: text('root_session_id'),
    childSessionIdsJson: text('child_session_ids_json').default('[]').notNull(),
    rawLogPath: text('raw_log_path'),
    summary: text('summary'),
    exitCode: integer('exit_code'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    completedAt: text('completed_at'),
  },
  (table) => [
    index('idx_kilo_tasks_status').on(
      table.status,
      sql`${table.updatedAt} DESC`,
    ),
    index('idx_kilo_tasks_repo').on(table.repoId, sql`${table.updatedAt} DESC`),
    index('idx_kilo_tasks_session').on(table.rootSessionId),
  ],
);

export const kiloTaskEvents = sqliteTable(
  'kilo_task_events',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    eventIndex: integer('event_index').notNull(),
    eventType: text('event_type').notNull(),
    stream: text('stream').notNull(),
    sessionId: text('session_id'),
    childSessionId: text('child_session_id'),
    summary: text('summary').notNull(),
    dataJson: text('data_json'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_kilo_task_events_task').on(table.taskId, table.eventIndex),
  ],
);

export const kiloSessionAudit = sqliteTable(
  'kilo_session_audit',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id'),
    sessionId: text('session_id'),
    childSessionId: text('child_session_id'),
    readType: text('read_type').notNull(),
    requesterSurface: text('requester_surface').notNull(),
    reason: text('reason'),
    limitCount: integer('limit_count'),
    offsetCount: integer('offset_count'),
    includeFullTranscript: integer('include_full_transcript')
      .default(0)
      .notNull(),
    includeToolOutput: integer('include_tool_output').default(0).notNull(),
    includeDiff: integer('include_diff').default(0).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_kilo_session_audit_session').on(
      table.sessionId,
      sql`${table.createdAt} DESC`,
    ),
  ],
);

export const kiloResultState = sqliteTable(
  'kilo_result_state',
  {
    taskId: text('task_id').primaryKey(),
    preparedDiffId: text('prepared_diff_id'),
    classification: text('classification').notNull(),
    verificationStatus: text('verification_status').notNull(),
    promotionStatus: text('promotion_status').notNull(),
    diffFingerprint: text('diff_fingerprint'),
    verifiedDiffFingerprint: text('verified_diff_fingerprint'),
    reviewSummaryJson: text('review_summary_json'),
    diffSummaryJson: text('diff_summary_json'),
    policyJson: text('policy_json'),
    verificationJson: text('verification_json'),
    promotionJson: text('promotion_json'),
    pendingApprovalsJson: text('pending_approvals_json')
      .default('[]')
      .notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    reviewedAt: text('reviewed_at'),
    verifiedAt: text('verified_at'),
    promotedAt: text('promoted_at'),
  },
  (table) => [
    index('idx_kilo_result_state_updated').on(sql`${table.updatedAt} DESC`),
  ],
);

export const kiloResultEvents = sqliteTable(
  'kilo_result_events',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    eventType: text('event_type').notNull(),
    summary: text('summary').notNull(),
    dataJson: text('data_json'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_kilo_result_events_task').on(
      table.taskId,
      sql`${table.createdAt} DESC`,
    ),
  ],
);

export const mcpToolCatalog = sqliteTable(
  'mcp_tool_catalog',
  {
    serverId: text('server_id').notNull(),
    toolName: text('tool_name').notNull(),
    adaptedName: text('adapted_name').notNull(),
    description: text('description').notNull(),
    inputSchemaJson: text('input_schema_json'),
    outputSchemaJson: text('output_schema_json'),
    annotationsJson: text('annotations_json'),
    status: text('status').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.serverId, table.toolName] }),
    index('idx_mcp_tool_catalog_status').on(
      table.serverId,
      table.status,
      sql`${table.updatedAt} DESC`,
    ),
  ],
);

export const mcpToolApprovals = sqliteTable(
  'mcp_tool_approvals',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id').notNull(),
    toolName: text('tool_name').notNull(),
    adaptedName: text('adapted_name').notNull(),
    argumentsHash: text('arguments_hash').notNull(),
    argumentsPreview: text('arguments_preview').notNull(),
    status: text('status').notNull(),
    approverSurface: text('approver_surface'),
    sessionId: text('session_id'),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
    usedAt: text('used_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_mcp_tool_approvals_pending').on(
      table.serverId,
      table.toolName,
      table.adaptedName,
      table.argumentsHash,
      table.status,
      table.expiresAt,
    ),
  ],
);

export const mcpToolAudit = sqliteTable(
  'mcp_tool_audit',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id').notNull(),
    toolName: text('tool_name').notNull(),
    adaptedName: text('adapted_name').notNull(),
    argumentsHash: text('arguments_hash').notNull(),
    decision: text('decision').notNull(),
    approvalId: text('approval_id'),
    durationMs: integer('duration_ms'),
    ok: integer('ok').notNull(),
    resultPreview: text('result_preview'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_mcp_tool_audit_created').on(sql`${table.createdAt} DESC`),
  ],
);

export const mcpOauthTokens = sqliteTable('mcp_oauth_tokens', {
  serverId: text('server_id').primaryKey(),
  serverIdentity: text('server_identity'),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  tokenType: text('token_type'),
  idToken: text('id_token'),
  expiresAt: text('expires_at'),
  scopesJson: text('scopes_json'),
  clientInformationJson: text('client_information_json'),
  discoveryStateJson: text('discovery_state_json'),
  codeVerifier: text('code_verifier'),
  updatedAt: text('updated_at').notNull(),
});

export const mcpOauthLogins = sqliteTable('mcp_oauth_logins', {
  id: text('id').primaryKey(),
  serverId: text('server_id').notNull(),
  serverIdentity: text('server_identity'),
  state: text('state').notNull(),
  status: text('status').notNull(),
  redirectUrl: text('redirect_url').notNull(),
  authorizationUrl: text('authorization_url'),
  discoveryStateJson: text('discovery_state_json'),
  codeVerifier: text('code_verifier'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  completedAt: text('completed_at'),
  updatedAt: text('updated_at').notNull(),
});
