/* eslint-disable no-unused-vars */
import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { openDb, rollbackQuietly } from '../../lib/sqlite';
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
  const latestConversationComment = maxString(
    (state.conversationComments ?? []).map((comment) => comment.updatedAt),
  );
  const latestSuiteUpdate = maxString(
    state.checkSuites.map((suite) => suite.updatedAt),
  );
  const latestRunUpdate = maxString(
    state.checkRuns.map((run) => run.completedAt ?? run.startedAt),
  );
  const requestedChangesReviews = state.requestedChangesReviews
    .map((review) => feedbackReviewWatermark(review))
    .sort((a, b) => a.id - b.id);
  const latestRequestedChangeStates =
    state.requestedChangesState.latestByReviewer
      .map((review) => ({
        id: review.id,
        state: review.state,
        authorLogin: review.authorLogin,
        commitId: review.commitId,
        submittedAt: review.submittedAt,
        body: boundedFeedbackBody(review.body).body,
        bodyTruncated:
          review.bodyTruncated || boundedFeedbackBody(review.body).truncated,
        fingerprint: feedbackFingerprint({
          id: review.id,
          state: review.state,
          authorLogin: review.authorLogin,
          commitId: review.commitId,
          submittedAt: review.submittedAt,
          body: review.body,
        }),
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
      body: boundedFeedbackBody(review.body).body,
      bodyTruncated:
        review.bodyTruncated || boundedFeedbackBody(review.body).truncated,
      fingerprint: feedbackFingerprint({
        id: review.id,
        state: review.state,
        authorLogin: review.authorLogin,
        commitId: review.commitId,
        submittedAt: review.submittedAt,
        body: review.body,
      }),
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
      commentsTruncated: thread.commentsTruncated ?? false,
      comments: thread.comments.map((comment) => {
        const bounded = boundedFeedbackBody(comment.body);
        const ignoredReason = feedbackIgnoredReason(
          comment.authorLogin,
          comment.body,
          comment.authorIsBot,
          comment.authorType,
        );
        return {
          id: comment.databaseId ?? comment.id,
          nodeId: comment.id,
          authorLogin: comment.authorLogin,
          authorType: comment.authorType ?? null,
          authorIsBot: comment.authorIsBot ?? null,
          body: bounded.body,
          bodyTruncated: comment.bodyTruncated || bounded.truncated,
          url: comment.url,
          path: comment.path ?? thread.path,
          line: comment.line ?? thread.line,
          originalLine: comment.originalLine,
          diffHunk: boundedFeedbackBody(comment.diffHunk).body,
          reviewId: comment.reviewId,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
          actionable: ignoredReason === null,
          ignoredReason,
          fingerprint: feedbackFingerprint({
            id: comment.databaseId ?? comment.id,
            authorLogin: comment.authorLogin,
            body: comment.body,
            path: comment.path ?? thread.path,
            line: comment.line ?? thread.line,
            updatedAt: comment.updatedAt,
            isResolved: thread.isResolved,
            isOutdated: thread.isOutdated,
          }),
        };
      }),
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
      fingerprint: feedbackFingerprint(suite),
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
      fingerprint: feedbackFingerprint(run),
    }))
    .sort((a, b) => a.id - b.id);

  return [
    categoryWatermark(watchId, 'commits', latestCommit, {
      headSha: state.headSha,
      total: state.commits.length,
      truncated: state.commitsTruncated ?? false,
      shas: state.commits.map((commit) => commit.sha).sort(),
      latestCommittedAt: latestCommit,
    }),
    categoryWatermark(watchId, 'review_threads', latestThreadComment, {
      total: state.reviewThreads.length,
      truncated: state.reviewThreadsTruncated ?? false,
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
        truncated: state.reviewsTruncated ?? false,
        reviewIds: requestedChangesReviews.map((review) => review.id),
        latestSubmittedAt: latestRequestedChanges,
        reviews: requestedChangesReviews,
        latestByReviewer: latestRequestedChangeStates,
        history: requestedChangeHistory,
      },
    ),
    categoryWatermark(
      watchId,
      'conversation_comments',
      latestConversationComment,
      {
        total: (state.conversationComments ?? []).length,
        truncated: state.conversationCommentsTruncated ?? false,
        latestUpdatedAt: latestConversationComment,
        comments: (state.conversationComments ?? [])
          .map((comment) => {
            const bounded = boundedFeedbackBody(comment.body);
            const ignoredReason = feedbackIgnoredReason(
              comment.authorLogin,
              comment.body,
              comment.authorIsBot,
              comment.authorType,
            );
            return {
              id: comment.id,
              nodeId: comment.nodeId,
              authorLogin: comment.authorLogin,
              authorType: comment.authorType ?? null,
              authorIsBot: comment.authorIsBot ?? null,
              body: bounded.body,
              bodyTruncated: bounded.truncated,
              url: comment.url,
              createdAt: comment.createdAt,
              updatedAt: comment.updatedAt,
              actionable: ignoredReason === null,
              ignoredReason,
              fingerprint: feedbackFingerprint({
                id: comment.id,
                authorLogin: comment.authorLogin,
                body: comment.body,
                updatedAt: comment.updatedAt,
              }),
            };
          })
          .sort((a, b) => a.id - b.id),
      },
    ),
    categoryWatermark(watchId, 'check_suites', latestSuiteUpdate, {
      total: checkSuites.length,
      truncated: state.checkSuitesTruncated ?? false,
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
      truncated: state.checkRunsTruncated ?? false,
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
      draft: state.draft,
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

const maxFeedbackBodyLength = 65_536;

function boundedFeedbackBody(value: string | null | undefined) {
  if (value === null || value === undefined) {
    return { body: null, truncated: false };
  }
  return value.length <= maxFeedbackBodyLength
    ? { body: value, truncated: false }
    : {
        body: value.slice(0, maxFeedbackBodyLength),
        truncated: true,
      };
}

function feedbackReviewWatermark(
  review: GitHubPullRequestEventState['requestedChangesReviews'][number],
) {
  const bounded = boundedFeedbackBody(review.body);
  const ignoredReason = feedbackIgnoredReason(
    review.authorLogin,
    review.body ?? null,
    review.authorIsBot,
    review.authorType,
  );
  return {
    id: review.id,
    authorLogin: review.authorLogin,
    authorType: review.authorType ?? null,
    authorIsBot: review.authorIsBot ?? null,
    commitId: review.commitId,
    submittedAt: review.submittedAt,
    url: review.url,
    body: bounded.body,
    bodyTruncated: review.bodyTruncated || bounded.truncated,
    actionable: ignoredReason === null,
    ignoredReason,
    fingerprint: feedbackFingerprint({
      id: review.id,
      state: review.state,
      authorLogin: review.authorLogin,
      commitId: review.commitId,
      submittedAt: review.submittedAt,
      body: review.body,
    }),
  };
}

function feedbackIgnoredReason(
  authorLogin: string | null,
  body: string | null,
  authorIsBot?: boolean,
  authorType?: string | null,
) {
  if (authorIsBot === true || authorType?.toLowerCase() === 'bot') {
    return 'bot-author';
  }
  if (authorIsBot === false || authorType) {
    if (body?.includes('<!-- neondeck:')) return 'neondeck-authored';
    return null;
  }
  const login = authorLogin?.toLowerCase() ?? '';
  if (login.endsWith('[bot]') || login.endsWith('-bot')) return 'bot-author';
  if (body?.includes('<!-- neondeck:')) return 'neondeck-authored';
  return null;
}

function feedbackFingerprint(value: unknown) {
  return createHash('sha256').update(stableFeedbackJson(value)).digest('hex');
}

function stableFeedbackJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableFeedbackJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${stableFeedbackJson(item)}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
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
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
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
  const database = openDb(paths.neondeckDatabase);
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
      rollbackQuietly(database);
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
