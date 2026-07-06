import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addWorkflowSummary } from './modules/app-state';
import {
  readAutomationHealth,
  loadAutomationLearningMemoryContext,
} from './modules/learning';
import { upsertMemory } from './modules/memory';
import { writeReport } from './modules/reports';
import { openDb } from './lib/sqlite';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('learning automation context', () => {
  it('bounds repo-scoped learning memories by count and excludes global routine context', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);
    const created = [];
    for (let index = 0; index < 4; index += 1) {
      created.push(
        await upsertMemory(
          {
            scope: 'project',
            repoId: 'neondeck',
            key: `repo-memory-${index}`,
            value: `Repo memory ${index}`,
          },
          paths,
        ),
      );
    }
    await upsertMemory(
      { scope: 'local', key: 'global-local', value: 'Local convention' },
      paths,
    );
    await upsertMemory(
      {
        scope: 'project',
        repoId: 'other',
        key: 'other-repo',
        value: 'Other repo convention',
      },
      paths,
    );

    const bounded = await loadAutomationLearningMemoryContext(paths, {
      repoId: 'neondeck',
      includeGlobal: true,
      maxCount: 2,
      maxBytes: 4_096,
    });
    expect(bounded.memories).toHaveLength(2);
    expect(bounded.truncated).toBe(true);
    expect(
      bounded.memories.every((memory) => memory.repoId === 'neondeck'),
    ).toBe(true);
    expect(JSON.stringify(bounded)).not.toContain('other-repo');

    const routineScoped = await loadAutomationLearningMemoryContext(paths, {
      repoId: 'neondeck',
      includeGlobal: false,
      maxCount: 8,
      maxBytes: 4_096,
    });
    expect(routineScoped.memories.map((memory) => memory.scope)).toEqual([
      'project',
      'project',
      'project',
      'project',
    ]);
    expect(JSON.stringify(routineScoped)).not.toContain('Local convention');
    expect((created[0] as { memory: { id: string } }).memory.id).toEqual(
      expect.any(String),
    );
  });

  it('keeps global learning memories when no repo scope is configured', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);
    const local = await upsertMemory(
      { scope: 'local', key: 'review-tone', value: 'Keep review notes terse.' },
      paths,
    );
    await upsertMemory(
      {
        scope: 'project',
        repoId: 'other',
        key: 'other-repo',
        value: 'Other repo guidance.',
      },
      paths,
    );

    const globalOnly = await loadAutomationLearningMemoryContext(paths, {
      repoId: null,
      includeGlobal: true,
    });

    expect(globalOnly.memoryIds).toEqual([
      (local as { memory: { id: string } }).memory.id,
    ]);
    expect(globalOnly.text).toContain('Keep review notes terse');
    expect(globalOnly.text).not.toContain('Other repo guidance');
  });

  it('computes automation health rates from fixture rows', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);
    const now = '2026-07-06T12:00:00.000Z';
    seedReviewAssistRows(paths.neondeckDatabase, now);
    seedRevisionRows(paths.neondeckDatabase, now);
    seedRoutineRows(paths.neondeckDatabase, now);
    const docsReport = await writeReport(
      {
        kind: 'docs-drift',
        title: 'Docs drift',
        html: '<p>docs</p>',
        createdBy: 'test',
        createdAt: now,
      },
      paths,
    );
    await writeReport(
      {
        kind: 'issue-triage',
        title: 'Issue triage',
        html: '<p>issues</p>',
        createdBy: 'test',
        createdAt: now,
      },
      paths,
    );
    const docsSummary = await addWorkflowSummary(
      {
        workflow: 'docs_drift_stage_fix',
        status: 'started',
        summary: { reportId: docsReport.id, outcome: 'kilo-started' },
      },
      paths,
    );
    updateWorkflowSummaryCreatedAt(paths.neondeckDatabase, docsSummary.id, now);
    const retriedDocsSummary = await addWorkflowSummary(
      {
        workflow: 'docs_drift_stage_fix',
        status: 'started',
        summary: { reportId: docsReport.id, outcome: 'kilo-started' },
      },
      paths,
    );
    updateWorkflowSummaryCreatedAt(
      paths.neondeckDatabase,
      retriedDocsSummary.id,
      now,
    );

    const health = await readAutomationHealth(paths, {
      now: new Date(now),
      windowDays: 30,
    });

    expect(health.reviewAssist).toMatchObject({
      seeded: 4,
      submitted: 2,
      deleted: 1,
      pending: 1,
      survivalRate: 0.5,
      editedBeforeSubmitRate: 0.5,
    });
    expect(health.reviewAssist.bySeverity.major).toMatchObject({
      seeded: 2,
      submitted: 1,
      deleted: 1,
      survivalRate: 0.5,
    });
    expect(health.revisionLoop).toMatchObject({
      runs: 3,
      approved: 1,
      reRevised: 1,
      approvalRate: 0.3333,
      reRevisionRate: 0.3333,
      failedOrAborted: 2,
    });
    expect(health.routines).toMatchObject({
      runs: 2,
      failures: 1,
      failureRate: 0.5,
      autoPauses: 1,
      silentOutputs: 1,
      silentOutputRate: 0.5,
    });
    expect(health.driftTriage).toMatchObject({
      docsDriftReports: 1,
      docsDriftStagedFixes: 1,
      docsDriftActedOnRate: 1,
      issueTriageReports: 1,
      issueTriageActedOn: 0,
      issueTriageActedOnRate: 0,
    });
  });

  it('returns zero counts and null rates for empty automation-health windows', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);

    const health = await readAutomationHealth(paths, {
      now: new Date('2026-07-06T12:00:00.000Z'),
      windowDays: 30,
    });

    expect(health.reviewAssist).toMatchObject({
      seeded: 0,
      submitted: 0,
      survivalRate: null,
      editedBeforeSubmitRate: null,
    });
    expect(health.revisionLoop).toMatchObject({
      runs: 0,
      approvalRate: null,
    });
    expect(health.routines).toMatchObject({
      runs: 0,
      failureRate: null,
      silentOutputRate: null,
    });
    expect(health.driftTriage).toMatchObject({
      docsDriftReports: 0,
      docsDriftActedOnRate: null,
      issueTriageReports: 0,
      issueTriageActedOnRate: null,
    });
  });

  it('keeps docs drift health tied to the report creation cohort', async () => {
    const paths = runtimePaths(await tempHome());
    await ensureRuntimeHome(paths);
    const now = '2026-07-06T12:00:00.000Z';
    const currentActed = await writeHealthReport(paths, {
      kind: 'docs-drift',
      title: 'Current acted docs drift',
      createdAt: now,
    });
    const oldActed = await writeHealthReport(paths, {
      kind: 'docs-drift',
      title: 'Old acted docs drift',
      createdAt: '2026-06-26T12:00:00.000Z',
    });
    await writeHealthReport(paths, {
      kind: 'docs-drift',
      title: 'Old unacted docs drift',
      createdAt: '2026-06-25T12:00:00.000Z',
    });
    await writeHealthReport(paths, {
      kind: 'issue-triage',
      title: 'Old unacted issue triage',
      createdAt: '2026-06-25T12:00:00.000Z',
    });
    const outsideWindowActed = await writeHealthReport(paths, {
      kind: 'docs-drift',
      title: 'Outside window acted docs drift',
      createdAt: '2026-06-01T12:00:00.000Z',
    });
    await stageDocsFixSummary(paths.neondeckDatabase, currentActed.id, now);
    await stageDocsFixSummary(paths.neondeckDatabase, currentActed.id, now);
    await stageDocsFixSummary(paths.neondeckDatabase, oldActed.id, now);
    await stageDocsFixSummary(
      paths.neondeckDatabase,
      outsideWindowActed.id,
      now,
    );

    const health = await readAutomationHealth(paths, {
      now: new Date(now),
      windowDays: 30,
    });

    expect(health.driftTriage).toMatchObject({
      docsDriftReports: 3,
      docsDriftStagedFixes: 2,
      docsDriftActedOnRate: 0.6667,
      issueTriageReports: 1,
      agedOutReports: 2,
    });
  });
});

async function tempHome() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-learning-automation-'));
  tempRoots.push(path);
  return path;
}

function seedReviewAssistRows(databasePath: string, now: string) {
  const database = openDb(databasePath);
  try {
    database
      .prepare(
        `
        INSERT INTO pr_review_drafts (
          id, repo, pr_number, head_sha, body, verdict, submitted_at,
          status, created_at, updated_at
        )
        VALUES ('draft-health', 'pandemicsyn/neondeck', 10, 'head', NULL, NULL, NULL, 'draft', ?, ?);
      `,
      )
      .run(now, now);
    for (const [commentId, severity, outcome] of [
      ['seed-submitted-major', 'major', 'submitted'],
      ['seed-submitted-minor', 'minor', 'submitted'],
      ['seed-deleted-major', 'major', 'deleted'],
      ['seed-pending-minor', 'minor', null],
    ] as const) {
      database
        .prepare(
          `
          INSERT INTO pr_review_neon_seeded_comments (
            comment_id, draft_id, repo, pr_number, head_sha, path, side, line,
            start_line, start_side, severity, summary, source, outcome,
            outcome_at, seeded_at
          )
          VALUES (?, 'draft-health', 'pandemicsyn/neondeck', 10, 'head', 'src/app.ts', 'RIGHT', 1,
            NULL, NULL, ?, 'summary', 'test', ?, ?, ?);
        `,
        )
        .run(commentId, severity, outcome, outcome ? now : null, now);
    }
    database
      .prepare(
        `
        INSERT INTO workflow_summaries (
          id, workflow, run_id, status, summary_json, created_at, updated_at
        )
        VALUES (
          'summary-github-review',
          'github_pr_review',
          'run-review',
          'submitted',
          ?,
          ?,
          ?
        );
      `,
      )
      .run(
        JSON.stringify({
          neonDraftOutcome: {
            submittedNeonCommentCount: 2,
            editedSubmittedNeonCommentCount: 1,
          },
        }),
        now,
        now,
      );
  } finally {
    database.close();
  }
}

function seedRevisionRows(databasePath: string, now: string) {
  const database = openDb(databasePath);
  try {
    for (const [id, status, pushApprovalStatus, outcome] of [
      ['pd-approved', 'push-approved', 'approved', 'completed'],
      ['pd-revised', 'revision-requested', 'rejected', 'failed'],
      [
        'pd-stale-aborted',
        'prepared',
        'pending',
        'aborted-after-stale-transition',
      ],
    ] as const) {
      database
        .prepare(
          `
          INSERT INTO prepared_diffs (
            id, worktree_id, repo_id, repo_full_name, pr_number, title,
            source_worktree_path, base_ref, head_ref, head_sha, status,
            push_approval_status, verification_status, summary_json,
            created_by, created_at, updated_at, abandoned_at
          )
          VALUES (?, ?, 'neondeck', 'pandemicsyn/neondeck', 10, 'Diff',
            '/tmp/worktree', 'main', 'feature', 'head', ?, ?, 'passed', NULL,
            'test', ?, ?, NULL);
        `,
        )
        .run(id, `wt-${id}`, status, pushApprovalStatus, now, now);
      database
        .prepare(
          `
          INSERT INTO workflow_summaries (
            id, workflow, run_id, status, summary_json, created_at, updated_at
          )
          VALUES (?, 'prepared_diff_revision_run', ?, ?, ?, ?, ?);
        `,
        )
        .run(
          `summary-${id}`,
          `run-${id}`,
          outcome === 'completed' ? 'completed' : 'failed',
          JSON.stringify({
            preparedDiffId: id,
            outcome,
          }),
          now,
          now,
        );
    }
    database
      .prepare(
        `
        INSERT INTO workflow_summaries (
          id, workflow, run_id, status, summary_json, created_at, updated_at
        )
        VALUES (
          'summary-pd-revised-retry',
          'prepared_diff_revision_run',
          'run-pd-revised-retry',
          'failed',
          ?,
          ?,
          ?
        );
      `,
      )
      .run(
        JSON.stringify({
          preparedDiffId: 'pd-revised',
          outcome: 'failed',
        }),
        now,
        now,
      );
  } finally {
    database.close();
  }
}

async function writeHealthReport(
  paths: ReturnType<typeof runtimePaths>,
  input: {
    kind: string;
    title: string;
    createdAt: string;
  },
) {
  return writeReport(
    {
      kind: input.kind,
      title: input.title,
      html: '<p>health</p>',
      createdBy: 'test',
      createdAt: input.createdAt,
    },
    paths,
  );
}

function stageDocsFixSummary(
  databasePath: string,
  reportId: string,
  createdAt: string,
) {
  const database = openDb(databasePath);
  try {
    const id = randomUUID();
    database
      .prepare(
        `
        INSERT INTO workflow_summaries (
          id, workflow, run_id, status, summary_json, created_at, updated_at
        )
        VALUES (?, 'docs_drift_stage_fix', ?, 'started', ?, ?, ?);
      `,
      )
      .run(
        `summary-docs-${id}`,
        `run-docs-${id}`,
        JSON.stringify({ reportId, outcome: 'kilo-started' }),
        createdAt,
        createdAt,
      );
  } finally {
    database.close();
  }
}

function seedRoutineRows(databasePath: string, now: string) {
  const database = openDb(databasePath);
  try {
    database
      .prepare(
        `
        INSERT INTO routines (
          id, name, prompt, schedule_kind, schedule, skills_json, scope_repo_id,
          scope_cwd, delivery, session_id, repeat_limit, run_count,
          consecutive_failures, running_run_id, enabled, created_by,
          created_at, updated_at, last_run_at, next_run_at
        )
        VALUES (
          'routine-paused', 'Paused', 'prompt', 'interval', '900', '[]', NULL,
          NULL, 'report', NULL, NULL, 3, 3, NULL, 0, 'test',
          ?, ?, ?, NULL
        );
      `,
      )
      .run(now, now, now);
    database
      .prepare(
        `
        INSERT INTO routine_events (
          id, routine_id, run_id, event_type, message, actor,
          before_json, after_json, created_at
        )
        VALUES (
          'routine-event-auto-pause', 'routine-paused', 'routine-failed',
          'routine_auto_paused', 'Routine auto-paused.', 'system',
          NULL, NULL, ?
        );
      `,
      )
      .run(now);
    for (const [id, status, outcome, summary] of [
      ['routine-ok', 'completed', 'recorded', { silent: true }],
      ['routine-failed', 'failed', 'failed', { silent: false }],
    ] as const) {
      database
        .prepare(
          `
          INSERT INTO routine_runs (
            id, routine_id, status, outcome, message, report_id, session_id,
            command_event_id, dispatch_id, summary_json, error, started_at,
            completed_at, created_at, updated_at
          )
          VALUES (?, 'routine-paused', ?, ?, 'message', NULL, NULL,
            NULL, NULL, ?, NULL, ?, ?, ?, ?);
        `,
        )
        .run(id, status, outcome, JSON.stringify(summary), now, now, now, now);
    }
  } finally {
    database.close();
  }
}

function updateWorkflowSummaryCreatedAt(
  databasePath: string,
  id: string,
  createdAt: string,
) {
  const database = openDb(databasePath);
  try {
    database
      .prepare(
        'UPDATE workflow_summaries SET created_at = ?, updated_at = ? WHERE id = ?;',
      )
      .run(createdAt, createdAt, id);
  } finally {
    database.close();
  }
}
