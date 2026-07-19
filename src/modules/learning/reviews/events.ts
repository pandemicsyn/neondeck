import { openDb } from '../../../lib/sqlite.ts';
import type { JsonValue } from '@flue/runtime';
import { randomUUID } from 'node:crypto';
import { ensureRuntimeHome, runtimePaths } from '../../../runtime-home';
import type {
  ConversationReviewInput,
  CurationReviewInput,
  PrBatchReviewInput,
} from './schemas';
import { readLearningConfig } from './context';
import {
  compactJson,
  errorMessage,
  markLearningCadenceAdmitted,
  recordLearningEvent,
  truncate,
} from './store';
import { markPrRetrospectiveAdmitted, prRetrospectiveDue } from './pr-cadence';
import { extractHandledPrEvent } from './pr-context';

export async function recordConversationTurnAndMaybeQueueLearning(
  sessionId: string,
  paths = runtimePaths(),
  dependencies: {
    invokeConversationReview?: (input: ConversationReviewInput) => Promise<{
      runId: string;
    }>;
    invokeCurationReview?: (input: CurationReviewInput) => Promise<{
      runId: string;
    }>;
  } = {},
) {
  await ensureRuntimeHome(paths);
  const configResult = await readLearningConfig(paths);
  if (!configResult.ok) {
    return { queued: [], turnCount: 0, message: configResult.message };
  }
  const config = configResult.config;
  if (!config.enabled) {
    return { queued: [], turnCount: 0, message: 'Learning is disabled.' };
  }

  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  let turnCount = 0;
  let queueConversation = false;
  let queueCuration = false;
  try {
    const row = database
      .prepare(
        `
        SELECT learning_turn_count, last_learning_review_turn_count, last_learning_curation_turn_count
        FROM chat_sessions
        WHERE id = ? AND agent_name = 'display-assistant';
      `,
      )
      .get(sessionId) as
      | {
          learning_turn_count?: number;
          last_learning_review_turn_count?: number;
          last_learning_curation_turn_count?: number;
        }
      | undefined;
    if (!row)
      return { queued: [], turnCount: 0, message: 'Session was not indexed.' };
    turnCount = Number(row.learning_turn_count ?? 0) + 1;
    const lastReview = Number(row.last_learning_review_turn_count ?? 0);
    const lastCuration = Number(row.last_learning_curation_turn_count ?? 0);
    queueConversation =
      turnCount - lastReview >= config.conversationReviewTurnInterval;
    queueCuration =
      config.memoryCurationEnabled &&
      config.memoryCurationMode !== 'off' &&
      turnCount - lastCuration >= config.memoryCurationTurnInterval;
    database
      .prepare(
        `
        UPDATE chat_sessions
        SET learning_turn_count = ?,
          last_active_at = ?,
          updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(turnCount, now, now, sessionId);
  } finally {
    database.close();
  }

  const queued = [];
  if (queueConversation && dependencies.invokeConversationReview) {
    try {
      const receipt = await dependencies.invokeConversationReview({
        sessionId,
        trigger: 'turn-threshold',
        turnCount,
      });
      markLearningCadenceAdmitted(paths, sessionId, 'conversation', turnCount);
      queued.push({ workflow: 'review_conversation_for_learning', ...receipt });
    } catch (error) {
      recordLearningEvent(paths, {
        type: 'reflection_failed',
        source: 'workflow',
        sessionId,
        data: { turnCount, admissionError: errorMessage(error) },
      });
    }
  }
  if (queueCuration && dependencies.invokeCurationReview) {
    try {
      const receipt = await dependencies.invokeCurationReview({
        trigger: 'turn-threshold',
        turnCount,
      });
      markLearningCadenceAdmitted(paths, sessionId, 'curation', turnCount);
      queued.push({ workflow: 'curate_learning_store', ...receipt });
    } catch (error) {
      recordLearningEvent(paths, {
        type: 'curation_failed',
        source: 'workflow',
        sessionId,
        data: { turnCount, admissionError: errorMessage(error) },
      });
    }
  }

  return {
    queued,
    turnCount,
    message:
      queued.length > 0
        ? `Queued ${queued.length} learning workflow${queued.length === 1 ? '' : 's'}.`
        : 'No learning workflow was due.',
  };
}

export async function recordHandledPrEventAndMaybeQueueLearning(
  input: {
    eventType: string;
    source: string;
    sourceId: string;
    repoId?: string | null;
    repoFullName?: string | null;
    prNumber?: number | null;
    summary?: string | null;
    data?: JsonValue | null;
  },
  paths = runtimePaths(),
  dependencies: {
    invokePrBatchReview?: (input: PrBatchReviewInput) => Promise<{
      runId: string;
    }>;
  } = {},
) {
  await ensureRuntimeHome(paths);
  const configResult = await readLearningConfig(paths);
  if (!configResult.ok) {
    return {
      recorded: false,
      duplicate: false,
      queued: [],
      message: configResult.message,
    };
  }
  const config = configResult.config;
  if (!config.enabled) {
    return {
      recorded: false,
      duplicate: false,
      queued: [],
      message: 'Learning is disabled.',
    };
  }
  const prKey =
    input.repoFullName && input.prNumber
      ? `${input.repoFullName}#${input.prNumber}`
      : input.prNumber && input.repoId
        ? `${input.repoId}#${input.prNumber}`
        : null;
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  let recorded = false;
  try {
    const existing = database
      .prepare(
        `
        SELECT id
        FROM learning_events
        WHERE type = 'pr_handled'
          AND source_id = ?
        LIMIT 1;
      `,
      )
      .get(input.sourceId);
    if (existing) {
      return {
        recorded: false,
        duplicate: true,
        queued: [],
        message: 'Handled PR event was already recorded.',
      };
    }
    database
      .prepare(
        `
        INSERT INTO learning_events (
          id,
          type,
          source,
          source_id,
          repo_id,
          pr_key,
          data_json,
          created_at
        )
        VALUES (?, 'pr_handled', ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        randomUUID(),
        input.source,
        input.sourceId,
        input.repoId ?? null,
        prKey,
        JSON.stringify(
          compactJson({
            eventType: input.eventType,
            repoFullName: input.repoFullName ?? null,
            prNumber: input.prNumber ?? null,
            summary: truncate(input.summary ?? '', 500),
            data: input.data ?? null,
          }),
        ),
        now,
      );
    recorded = true;
  } finally {
    database.close();
  }

  const queued = [];
  const due = prRetrospectiveDue(paths, config.prRetrospectiveThreshold);
  if (
    due.due &&
    !due.activeAdmission &&
    dependencies.invokePrBatchReview &&
    markPrRetrospectiveAdmitted(paths, {
      repoId: null,
      count: due.count,
      threshold: config.prRetrospectiveThreshold,
    })
  ) {
    try {
      const receipt = await dependencies.invokePrBatchReview({
        trigger: 'threshold',
        reason: `Handled PR threshold reached with ${due.count} event${due.count === 1 ? '' : 's'} since the last retrospective.`,
      });
      queued.push({ workflow: 'review_pr_batch_for_learning', ...receipt });
    } catch (error) {
      recordLearningEvent(paths, {
        type: 'pr_retrospective_failed',
        source: 'workflow',
        repoId: input.repoId ?? null,
        data: { admissionError: errorMessage(error), threshold: due.count },
      });
    }
  }

  return {
    recorded,
    duplicate: false,
    queued,
    handledCountSinceReview: due.count,
    threshold: config.prRetrospectiveThreshold,
    activeAdmission: due.activeAdmission,
    message:
      queued.length > 0
        ? 'Recorded handled PR event and queued PR retrospective.'
        : 'Recorded handled PR event.',
  };
}

export async function recordHandledPrFromWorkflowResult(
  input: {
    workflow?: string | null;
    runId?: string | null;
    result: unknown;
  },
  paths = runtimePaths(),
  dependencies: {
    invokePrBatchReview?: (input: PrBatchReviewInput) => Promise<{
      runId: string;
    }>;
  } = {},
) {
  const event = extractHandledPrEvent(input);
  if (!event) {
    return {
      recorded: false,
      duplicate: false,
      queued: [],
      message: 'Workflow result did not contain handled PR evidence.',
    };
  }
  return recordHandledPrEventAndMaybeQueueLearning(event, paths, dependencies);
}
