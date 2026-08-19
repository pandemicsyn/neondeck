import { openDb } from '../../../lib/sqlite.ts';
import type { JsonValue } from '@flue/runtime';
import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../../runtime-home';
import type {
  ConversationReviewInput,
  CurationReviewInput,
  PrBatchReviewInput,
} from './schemas';
import {
  conversationReviewInputSchema,
  curationReviewInputSchema,
  prBatchReviewInputSchema,
} from './schemas';
import { readLearningConfig } from './context';
import {
  claimLearningReviewAdmissionIntent,
  compactJson,
  errorMessage,
  insertLearningReviewAdmissionIntent,
  listPendingLearningReviewAdmissionIntents,
  markLearningReviewAdmissionIntentAdmitted,
  recordLearningEvent,
  recordLearningReviewAdmissionIntentError,
  truncate,
} from './store';
import {
  markPrRetrospectiveAdmittedInDatabase,
  prRetrospectiveDueInDatabase,
} from './pr-cadence';
import { extractHandledPrEvent } from './pr-context';
import { readRepoRegistrySnapshot, repoFullName } from '../../repos';
import {
  admitConversationLearningReview,
  admitCurationLearningReview,
  admitPrBatchLearningReview,
  recoverPendingLearningReviewAdmissions,
  type LearningReviewAdmission,
} from './admission';

type LearningReviewInvoker<T> = (input: T) => Promise<LearningReviewAdmission>;

export async function recordConversationTurnAndMaybeQueueLearning(
  sessionId: string,
  paths = runtimePaths(),
  dependencies: {
    invokeConversationReview?: LearningReviewInvoker<ConversationReviewInput>;
    invokeCurationReview?: LearningReviewInvoker<CurationReviewInput>;
  } = {},
  sourceId?: string,
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
    database.exec('BEGIN IMMEDIATE;');
    if (
      sourceId &&
      database
        .prepare(
          `SELECT id FROM learning_events WHERE type = 'conversation_turn_settled' AND source_id = ? LIMIT 1;`,
        )
        .get(sourceId)
    ) {
      database.exec('ROLLBACK;');
      return {
        queued: [],
        turnCount: 0,
        duplicate: true,
        message: 'Conversation submission was already recorded.',
      };
    }
    const row = v.parse(
      v.optional(
        v.object({
          learning_turn_count: v.optional(v.number()),
          last_learning_review_turn_count: v.optional(v.number()),
          last_learning_review_at: v.optional(v.nullable(v.string())),
          last_learning_curation_turn_count: v.optional(v.number()),
          last_learning_curation_at: v.optional(v.nullable(v.string())),
        }),
      ),
      database
        .prepare(
          `
        SELECT learning_turn_count,
          last_learning_review_turn_count,
          last_learning_review_at,
          last_learning_curation_turn_count,
          last_learning_curation_at
        FROM chat_sessions
        WHERE id = ? AND agent_name = 'display-assistant';
      `,
        )
        .get(sessionId),
    );
    if (!row) {
      database.exec('ROLLBACK;');
      return { queued: [], turnCount: 0, message: 'Session was not indexed.' };
    }
    turnCount = Number(row.learning_turn_count ?? 0) + 1;
    const previousReviewCount = Number(
      row.last_learning_review_turn_count ?? 0,
    );
    const previousCurationCount = Number(
      row.last_learning_curation_turn_count ?? 0,
    );
    const pendingKinds = new Set(
      database
        .prepare(
          `SELECT kind FROM learning_review_admissions WHERE status != 'admitted' AND session_id = ?;`,
        )
        .all(sessionId)
        .flatMap((entry) => {
          const parsed = v.safeParse(v.object({ kind: v.string() }), entry);
          return parsed.success ? [parsed.output.kind] : [];
        }),
    );
    queueConversation =
      !pendingKinds.has('conversation') &&
      turnCount - previousReviewCount >= config.conversationReviewTurnInterval;
    queueCuration =
      !pendingKinds.has('curation') &&
      config.memoryCurationEnabled &&
      config.memoryCurationMode !== 'off' &&
      turnCount - previousCurationCount >= config.memoryCurationTurnInterval;
    database
      .prepare(
        `
        UPDATE chat_sessions
        SET learning_turn_count = ?,
          last_learning_review_turn_count = CASE WHEN ? THEN ? ELSE last_learning_review_turn_count END,
          last_learning_review_at = CASE WHEN ? THEN ? ELSE last_learning_review_at END,
          last_learning_curation_turn_count = CASE WHEN ? THEN ? ELSE last_learning_curation_turn_count END,
          last_learning_curation_at = CASE WHEN ? THEN ? ELSE last_learning_curation_at END,
          last_active_at = ?,
          updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(
        turnCount,
        queueConversation ? 1 : 0,
        turnCount,
        queueConversation ? 1 : 0,
        now,
        queueCuration ? 1 : 0,
        turnCount,
        queueCuration ? 1 : 0,
        now,
        now,
        now,
        sessionId,
      );
    if (sourceId) {
      database
        .prepare(
          `
          INSERT INTO learning_events (
            id, type, source, source_id, session_id, data_json, created_at
          )
          VALUES (?, 'conversation_turn_settled', 'flue', ?, ?, ?, ?);
        `,
        )
        .run(
          randomUUID(),
          sourceId,
          sessionId,
          JSON.stringify({ submissionId: sourceId }),
          now,
        );
    }
    if (queueConversation) {
      insertLearningReviewAdmissionIntent(database, {
        kind: 'conversation',
        sessionId,
        reviewInput: {
          sessionId,
          trigger: 'turn-threshold',
          turnCount,
        },
        createdAt: now,
      });
    }
    if (queueCuration) {
      insertLearningReviewAdmissionIntent(database, {
        kind: 'curation',
        sessionId,
        reviewInput: { trigger: 'turn-threshold', turnCount },
        createdAt: now,
      });
    }
    database.exec('COMMIT;');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }

  const queued = await processPendingLearningIntents(
    paths,
    dependencies,
    sessionId,
  );

  return {
    queued,
    turnCount,
    message:
      queued.length > 0
        ? `Queued ${queued.length} learning review${queued.length === 1 ? '' : 's'}.`
        : 'No learning review was due.',
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
    invokePrBatchReview?: LearningReviewInvoker<PrBatchReviewInput>;
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
  const repoId =
    input.repoId ??
    (input.repoFullName
      ? await registeredRepoId(input.repoFullName, paths)
      : null);
  const prKey =
    input.repoFullName && input.prNumber
      ? `${input.repoFullName}#${input.prNumber}`
      : input.prNumber && repoId
        ? `${repoId}#${input.prNumber}`
        : null;
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  let recorded = false;
  let due = {
    due: false,
    count: 0,
    activeAdmission: false,
  };
  try {
    database.exec('BEGIN IMMEDIATE;');
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
      database.exec('ROLLBACK;');
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
        repoId,
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
    due = prRetrospectiveDueInDatabase(
      database,
      config.prRetrospectiveThreshold,
    );
    if (
      due.due &&
      !due.activeAdmission &&
      markPrRetrospectiveAdmittedInDatabase(
        database,
        {
          repoId: null,
          count: due.count,
          threshold: config.prRetrospectiveThreshold,
        },
        now,
      )
    ) {
      insertLearningReviewAdmissionIntent(database, {
        kind: 'pr-batch',
        reviewInput: {
          trigger: 'threshold',
          reason: `Handled PR threshold reached with ${due.count} event${due.count === 1 ? '' : 's'} since the last retrospective.`,
        },
        createdAt: now,
      });
    }
    database.exec('COMMIT;');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }

  if (!dependencies.invokePrBatchReview) {
    const recovered = await recoverPendingLearningReviewAdmissions(
      paths,
      {},
      undefined,
      'pr-batch',
    );
    const queued = recovered.admissions.map((receipt) => ({
      operation: 'learning-review' as const,
      ...receipt,
    }));
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

  const queued = [];
  for (const intent of listPendingLearningReviewAdmissionIntents(paths).filter(
    (candidate) => candidate.kind === 'pr-batch',
  )) {
    if (!claimLearningReviewAdmissionIntent(intent.id, paths)) continue;
    try {
      const admit =
        dependencies.invokePrBatchReview ??
        ((input: PrBatchReviewInput) =>
          admitPrBatchLearningReview(input, paths, {
            reviewId: intent.id,
          }).then(requireLearningReviewAdmission));
      const input = v.parse(prBatchReviewInputSchema, intent.input);
      const receipt = await admit(input);
      markLearningReviewAdmissionIntentAdmitted(intent.id, paths);
      queued.push({ operation: 'learning-review', ...receipt });
    } catch (error) {
      const message = errorMessage(error);
      recordLearningReviewAdmissionIntentError(intent.id, message, paths);
      recordLearningEvent(paths, {
        type: 'pr_retrospective_failed',
        source: 'learning-admission',
        repoId,
        data: {
          admissionId: intent.id,
          admissionError: message,
          threshold: due.count,
        },
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

async function registeredRepoId(
  fullName: string,
  paths: Parameters<typeof readRepoRegistrySnapshot>[0],
) {
  try {
    const registry = await readRepoRegistrySnapshot(paths);
    return (
      registry.repos.find(
        (repo) => repoFullName(repo).toLowerCase() === fullName.toLowerCase(),
      )?.id ?? null
    );
  } catch {
    return null;
  }
}

export async function recordHandledPrFromWorkflowResult(
  input: {
    workflow?: string | null;
    runId?: string | null;
    result: unknown;
  },
  paths = runtimePaths(),
  dependencies: {
    invokePrBatchReview?: LearningReviewInvoker<PrBatchReviewInput>;
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

export async function recordHandledPrFromOperationResult(
  input: {
    operation: string;
    submissionId?: string | null;
    result: unknown;
  },
  paths = runtimePaths(),
  dependencies: {
    invokePrBatchReview?: LearningReviewInvoker<PrBatchReviewInput>;
  } = {},
) {
  const event = extractHandledPrEvent({
    workflow: input.operation,
    submissionId: input.submissionId,
    result: input.result,
  });
  if (!event) {
    return {
      recorded: false,
      duplicate: false,
      queued: [],
      message: 'Operation result did not contain handled PR evidence.',
    };
  }
  return recordHandledPrEventAndMaybeQueueLearning(event, paths, dependencies);
}

function requireLearningReviewAdmission(
  result: LearningReviewAdmission | { ok: false; message: string },
) {
  if (result.ok) return result;
  throw new Error(result.message);
}

async function processPendingLearningIntents(
  paths: RuntimePaths,
  dependencies: {
    invokeConversationReview?: LearningReviewInvoker<ConversationReviewInput>;
    invokeCurationReview?: LearningReviewInvoker<CurationReviewInput>;
  },
  sessionId: string,
) {
  if (
    !dependencies.invokeConversationReview &&
    !dependencies.invokeCurationReview
  ) {
    const recovered = await recoverPendingLearningReviewAdmissions(
      paths,
      {},
      sessionId,
    );
    return recovered.admissions.map((receipt) => ({
      operation: 'learning-review' as const,
      ...receipt,
    }));
  }
  const queued = [];
  for (const intent of listPendingLearningReviewAdmissionIntents(
    paths,
    sessionId,
  )) {
    if (!claimLearningReviewAdmissionIntent(intent.id, paths)) continue;
    try {
      const receipt =
        intent.kind === 'conversation'
          ? await (
              dependencies.invokeConversationReview ??
              ((input: ConversationReviewInput) =>
                admitConversationLearningReview(input, paths, {
                  reviewId: intent.id,
                }).then(requireLearningReviewAdmission))
            )(v.parse(conversationReviewInputSchema, intent.input))
          : await (
              dependencies.invokeCurationReview ??
              ((input: CurationReviewInput) =>
                admitCurationLearningReview(input, paths, {
                  reviewId: intent.id,
                }).then(requireLearningReviewAdmission))
            )(v.parse(curationReviewInputSchema, intent.input));
      markLearningReviewAdmissionIntentAdmitted(intent.id, paths);
      queued.push({ operation: 'learning-review', ...receipt });
    } catch (error) {
      const message = errorMessage(error);
      recordLearningReviewAdmissionIntentError(intent.id, message, paths);
      recordLearningEvent(paths, {
        type:
          intent.kind === 'conversation'
            ? 'reflection_failed'
            : 'curation_failed',
        source: 'learning-admission',
        sessionId,
        data: { admissionId: intent.id, admissionError: message },
      });
    }
  }
  return queued;
}
