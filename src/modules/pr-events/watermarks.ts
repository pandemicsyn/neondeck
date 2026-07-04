/* eslint-disable no-unused-vars */
import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import {
  fetchPullRequestEventState,
  postPullRequestComment,
  type GitHubPullRequestEventState,
} from '../github';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import {
  listPrWatchRecords,
  parseWatchPrReference,
  type PrWatch,
} from '../watches';
import {
  watermarkCategories,
  type PrWatchEventWatermarkCategory,
  type PrWatchEventWatermarkRecord,
} from './schemas';
import { isFailingConclusion, maxString } from './utils';

export function watermarksFromEventState(
  watchId: string,
  state: GitHubPullRequestEventState,
) {
  const latestCommit = maxString(
    state.commits.map((commit) => commit.committedAt),
  );
  const latestThreadComment = maxString(
    state.reviewThreads.flatMap((thread) =>
      thread.comments.map((comment) => comment.updatedAt),
    ),
  );
  const latestRequestedChanges = maxString(
    state.requestedChangesReviews.map((review) => review.submittedAt),
  );
  const latestSuiteUpdate = maxString(
    state.checkSuites.map((suite) => suite.updatedAt),
  );
  const latestRunUpdate = maxString(
    state.checkRuns.map((run) => run.completedAt ?? run.startedAt),
  );
  const requestedChangesReviews = state.requestedChangesReviews
    .map((review) => ({
      id: review.id,
      authorLogin: review.authorLogin,
      commitId: review.commitId,
      submittedAt: review.submittedAt,
    }))
    .sort((a, b) => a.id - b.id);
  const latestRequestedChangeStates =
    state.requestedChangesState.latestByReviewer
      .map((review) => ({
        id: review.id,
        state: review.state,
        authorLogin: review.authorLogin,
        commitId: review.commitId,
        submittedAt: review.submittedAt,
      }))
      .sort((a, b) =>
        String(a.authorLogin ?? a.id).localeCompare(
          String(b.authorLogin ?? b.id),
        ),
      );
  const requestedChangeHistory = state.requestedChangesState.history
    .map((review) => ({
      id: review.id,
      state: review.state,
      authorLogin: review.authorLogin,
      commitId: review.commitId,
      submittedAt: review.submittedAt,
    }))
    .sort((a, b) => a.id - b.id);
  const reviewThreads = state.reviewThreads
    .map((thread) => ({
      id: thread.id,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      path: thread.path,
      line: thread.line,
      commentIds: thread.comments
        .map((comment) => comment.databaseId ?? comment.id)
        .sort((a, b) => String(a).localeCompare(String(b))),
      latestCommentUpdatedAt: maxString(
        thread.comments.map((comment) => comment.updatedAt),
      ),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const checkSuites = state.checkSuites
    .map((suite) => ({
      id: suite.id,
      headSha: suite.headSha,
      status: suite.status,
      conclusion: suite.conclusion,
      appSlug: suite.appSlug,
      updatedAt: suite.updatedAt,
    }))
    .sort((a, b) => a.id - b.id);
  const checkRuns = state.checkRuns
    .map((run) => ({
      id: run.id,
      name: run.name,
      headSha: run.headSha,
      status: run.status,
      conclusion: run.conclusion,
      completedAt: run.completedAt,
    }))
    .sort((a, b) => a.id - b.id);

  return [
    categoryWatermark(watchId, 'commits', latestCommit, {
      headSha: state.headSha,
      total: state.commits.length,
      shas: state.commits.map((commit) => commit.sha).sort(),
      latestCommittedAt: latestCommit,
    }),
    categoryWatermark(watchId, 'review_threads', latestThreadComment, {
      total: state.reviewThreads.length,
      unresolvedThreadIds: reviewThreads
        .filter((thread) => !thread.isResolved)
        .map((thread) => thread.id),
      resolvedThreadIds: reviewThreads
        .filter((thread) => thread.isResolved)
        .map((thread) => thread.id),
      outdatedThreadIds: reviewThreads
        .filter((thread) => thread.isOutdated)
        .map((thread) => thread.id),
      latestCommentUpdatedAt: latestThreadComment,
      threads: reviewThreads,
    }),
    categoryWatermark(
      watchId,
      'requested_changes_reviews',
      latestRequestedChanges,
      {
        total: requestedChangesReviews.length,
        reviewIds: requestedChangesReviews.map((review) => review.id),
        latestSubmittedAt: latestRequestedChanges,
        reviews: requestedChangesReviews,
        latestByReviewer: latestRequestedChangeStates,
        history: requestedChangeHistory,
      },
    ),
    categoryWatermark(watchId, 'check_suites', latestSuiteUpdate, {
      total: checkSuites.length,
      suiteIds: checkSuites.map((suite) => suite.id),
      failingSuiteIds: checkSuites
        .filter((suite) => isFailingConclusion(suite.conclusion))
        .map((suite) => suite.id),
      pendingSuiteIds: checkSuites
        .filter((suite) => suite.status !== 'completed')
        .map((suite) => suite.id),
      suites: checkSuites,
    }),
    categoryWatermark(watchId, 'check_runs', latestRunUpdate, {
      total: checkRuns.length,
      runIds: checkRuns.map((run) => run.id),
      failingRunIds: checkRuns
        .filter((run) => isFailingConclusion(run.conclusion))
        .map((run) => run.id),
      pendingRunIds: checkRuns
        .filter((run) => run.status !== 'completed')
        .map((run) => run.id),
      runs: checkRuns,
    }),
    categoryWatermark(watchId, 'mergeability', state.fetchedAt, {
      state: state.state,
      merged: state.merged,
      mergeable: state.mergeable,
      mergeableState: state.mergeableState,
      mergeCommitSha: state.mergeCommitSha,
      headSha: state.headSha,
      baseSha: state.baseSha,
    }),
    categoryWatermark(watchId, 'out_of_date_branch', state.fetchedAt, {
      isOutOfDate: state.isOutOfDate,
      mergeableState: state.mergeableState,
      headSha: state.headSha,
      baseSha: state.baseSha,
      baseRef: state.baseRef,
    }),
  ];
}

export function categoryWatermark(
  watchId: string,
  category: PrWatchEventWatermarkCategory,
  sourceUpdatedAt: string | null,
  value: JsonValue,
) {
  return { watchId, category, sourceUpdatedAt, value };
}

export function readWatermarks(
  paths: RuntimePaths,
  watchId?: string,
): PrWatchEventWatermarkRecord[] {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    const query = watchId
      ? `
        SELECT *
        FROM pr_watch_event_watermarks
        WHERE watch_id = ?
        ORDER BY category ASC;
      `
      : `
        SELECT *
        FROM pr_watch_event_watermarks
        ORDER BY updated_at DESC, watch_id ASC, category ASC;
      `;
    return (
      watchId
        ? database.prepare(query).all(watchId)
        : database.prepare(query).all()
    ).map(readWatermarkRow);
  } finally {
    database.close();
  }
}

export function upsertWatermarks(
  paths: RuntimePaths,
  watchId: string,
  watermarks: ReturnType<typeof watermarksFromEventState>,
) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  const now = new Date().toISOString();

  try {
    database.exec('BEGIN;');
    try {
      for (const watermark of watermarks) {
        database
          .prepare(
            `
            INSERT INTO pr_watch_event_watermarks (
              watch_id,
              category,
              watermark_json,
              source_updated_at,
              checked_at,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(watch_id, category) DO UPDATE SET
              watermark_json = excluded.watermark_json,
              source_updated_at = excluded.source_updated_at,
              checked_at = excluded.checked_at,
              updated_at = excluded.updated_at;
          `,
          )
          .run(
            watchId,
            watermark.category,
            JSON.stringify(watermark.value),
            watermark.sourceUpdatedAt,
            now,
            now,
            now,
          );
      }
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  } finally {
    database.close();
  }
}

export function readWatermarkRow(row: unknown): PrWatchEventWatermarkRecord {
  const record = row as Record<string, unknown>;
  const category = String(record.category);
  return {
    watchId: String(record.watch_id),
    category: watermarkCategories.includes(
      category as PrWatchEventWatermarkCategory,
    )
      ? (category as PrWatchEventWatermarkCategory)
      : 'commits',
    watermark:
      typeof record.watermark_json === 'string'
        ? (JSON.parse(record.watermark_json) as JsonValue)
        : null,
    sourceUpdatedAt:
      typeof record.source_updated_at === 'string'
        ? record.source_updated_at
        : null,
    checkedAt: String(record.checked_at),
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
  };
}
