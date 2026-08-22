import { openDb } from '../../lib/sqlite.ts';
import { defineTool, type JsonValue } from '@flue/runtime';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import * as v from 'valibot';
import { isJsonValue } from '../execution';
import {
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  resolveLearningConfig,
  runtimePaths,
} from '../../runtime-home';

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const boundedLimitSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(100),
);
const learningOperatorInputSchema = v.object({
  limit: v.optional(boundedLimitSchema),
  reviewKind: v.optional(v.picklist(['conversation', 'curation', 'pr-batch'])),
  reviewStatus: v.optional(v.picklist(['running', 'completed', 'failed'])),
  candidateStatus: v.optional(
    v.picklist(['proposed', 'applied', 'rejected', 'archived']),
  ),
  candidateTarget: v.optional(v.picklist(['memory', 'skill'])),
  memoryId: v.optional(nonEmptyStringSchema),
});

const learningCountMapSchema = v.record(v.string(), v.number());
const jsonValueSchema = v.pipe(
  v.unknown(),
  v.check(isJsonValue, 'Expected a JSON value.'),
);
const jsonObjectSchema = v.pipe(
  v.unknown(),
  v.check((value) => !Array.isArray(value), 'Expected a JSON object.'),
  v.record(v.string(), jsonValueSchema),
);
const learningOperatorOutputSchema = v.variant('ok', [
  v.object({
    ok: v.literal(false),
    action: v.literal('learning_operator_state'),
    changed: v.literal(false),
    message: v.string(),
    errors: v.array(v.string()),
  }),
  v.object({
    ok: v.literal(true),
    action: v.literal('learning_operator_state'),
    changed: v.literal(false),
    config: v.unknown(),
    summary: v.object({
      reviews: learningCountMapSchema,
      candidates: learningCountMapSchema,
      targets: learningCountMapSchema,
      activeMemories: v.number(),
      archivedMemories: v.number(),
      handledPrEvents: v.number(),
      pendingDecisions: v.number(),
      failedReviews: v.number(),
    }),
    reviews: v.array(v.unknown()),
    candidates: v.array(v.unknown()),
    memoryCandidates: v.array(v.unknown()),
    skillPatchCandidates: v.array(v.unknown()),
    memoryEvents: v.array(v.unknown()),
    learningEvents: v.array(v.unknown()),
    fetchedAt: v.string(),
  }),
]);

export const learningOperatorStateAction = defineTool({
  name: 'neondeck_learning_operator_state',
  description:
    'Read consolidated learning operator state: reviews, candidates, memory decisions, skill patch decisions, and audit history.',
  input: learningOperatorInputSchema,
  output: learningOperatorOutputSchema,
  async run({ data: input }) {
    return { output: await readLearningOperatorState(input) };
  },
});

export const learningOperatorStateLookupTool = defineTool({
  name: 'neondeck_learning_operator_state_lookup',
  description:
    'Read consolidated learning status, review history, memory decisions, skill patch decisions, and audit history without mutating state.',
  input: learningOperatorInputSchema,
  output: learningOperatorOutputSchema,
  async run({ data: input }) {
    return { output: await readLearningOperatorState(input) };
  },
});

export const neondeckLearningOperatorActions = [learningOperatorStateAction];
export const neondeckLearningOperatorTools = [learningOperatorStateLookupTool];

export async function readLearningOperatorState(
  input: v.InferInput<typeof learningOperatorInputSchema> = {},
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(learningOperatorInputSchema, input);
  if (!parsed.success) {
    return {
      ok: false as const,
      action: 'learning_operator_state' as const,
      changed: false as const,
      message: v.summarize(parsed.issues),
      errors: [v.summarize(parsed.issues)],
    };
  }

  const limit = parsed.output.limit ?? 25;
  const config = resolveLearningConfig(
    await readRuntimeJson(paths.config, parseAppConfig),
  );
  const database = openDb(paths.neondeckDatabase);
  try {
    const summary = readLearningSummary(database);
    const reviews = readReviews(database, {
      kind: parsed.output.reviewKind,
      status: parsed.output.reviewStatus,
      limit,
    });
    const candidates = readCandidates(database, {
      target: parsed.output.candidateTarget,
      status: parsed.output.candidateStatus,
      limit,
    });
    const memoryCandidates =
      parsed.output.candidateTarget === 'skill'
        ? []
        : readCandidates(database, {
            target: 'memory',
            status: parsed.output.candidateStatus,
            limit,
          });
    const skillPatchCandidates =
      parsed.output.candidateTarget === 'memory'
        ? []
        : readCandidates(database, {
            target: 'skill',
            status: parsed.output.candidateStatus,
            limit,
          });
    const memoryEvents = readMemoryEvents(database, {
      memoryId: parsed.output.memoryId,
      limit,
    });
    const learningEvents = readLearningEvents(database, { limit });

    return {
      ok: true as const,
      action: 'learning_operator_state' as const,
      changed: false as const,
      config,
      summary,
      reviews,
      candidates,
      memoryCandidates,
      skillPatchCandidates,
      memoryEvents,
      learningEvents,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    database.close();
  }
}

function readLearningSummary(database: DatabaseSync) {
  const candidateCounts = countsBy(database, 'learning_candidates', 'status');
  const reviewCounts = countsBy(database, 'learning_reviews', 'status');
  const targetCounts = countsBy(database, 'learning_candidates', 'target');
  const activeMemories = scalarCount(
    database,
    "SELECT COUNT(*) AS count FROM memories WHERE status != 'archived';",
  );
  const archivedMemories = scalarCount(
    database,
    "SELECT COUNT(*) AS count FROM memories WHERE status = 'archived';",
  );
  const handledPrEvents = scalarCount(
    database,
    "SELECT COUNT(*) AS count FROM learning_events WHERE type = 'pr_handled';",
  );

  return {
    reviews: reviewCounts,
    candidates: candidateCounts,
    targets: targetCounts,
    activeMemories,
    archivedMemories,
    handledPrEvents,
    pendingDecisions: candidateCounts.proposed ?? 0,
    failedReviews: reviewCounts.failed ?? 0,
  };
}

function readReviews(
  database: DatabaseSync,
  input: { kind?: string; status?: string; limit: number },
) {
  const filters: string[] = [];
  const params: Array<string | number> = [];
  if (input.kind) {
    filters.push('kind = ?');
    params.push(input.kind);
  }
  if (input.status) {
    filters.push('status = ?');
    params.push(input.status);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return database
    .prepare(
      `
      SELECT *
      FROM learning_reviews
      ${where}
      ORDER BY started_at DESC
      LIMIT ?;
    `,
    )
    .all(...params, input.limit)
    .map((row) => {
      const record = row;
      return {
        id: String(record.id),
        kind: String(record.kind),
        status: String(record.status),
        model: String(record.model),
        thinkingLevel: String(record.thinking_level),
        trigger: parseJson(record.trigger_json),
        inputSummary: parseJson(record.input_summary_json),
        result: parseJson(record.result_json),
        error: stringOrNull(record.error),
        agentId: stringOrNull(record.agent_id),
        submissionId: stringOrNull(record.submission_id),
        dispatchError: stringOrNull(record.dispatch_error),
        startedAt: String(record.started_at),
        completedAt: stringOrNull(record.completed_at),
      };
    });
}

function readCandidates(
  database: DatabaseSync,
  input: { target?: string; status?: string; limit: number },
) {
  const filters: string[] = [];
  const params: Array<string | number> = [];
  if (input.target) {
    filters.push('target = ?');
    params.push(input.target);
  }
  if (input.status) {
    filters.push('status = ?');
    params.push(input.status);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return database
    .prepare(
      `
      SELECT *
      FROM learning_candidates
      ${where}
      ORDER BY created_at DESC
      LIMIT ?;
    `,
    )
    .all(...params, input.limit)
    .map(readCandidateRow);
}

function readCandidateRow(row: Record<string, SQLOutputValue>) {
  const record = row;
  const target = String(record.target);
  const patch = parseJson(record.patch_json);
  return {
    id: String(record.id),
    target,
    status: String(record.status),
    action: stringOrNull(record.action),
    scope: stringOrNull(record.scope),
    key: stringOrNull(record.key),
    value: parseJson(record.value_json),
    skillId: stringOrNull(record.skill_id),
    repoId: stringOrNull(record.repo_id),
    reason: stringOrNull(record.reason),
    reviewId: stringOrNull(record.review_id),
    patch: target === 'skill' ? summarizeSkillPatch(patch) : patch,
    createdAt: String(record.created_at),
    decidedAt: stringOrNull(record.decided_at),
  };
}

function readMemoryEvents(
  database: DatabaseSync,
  input: { memoryId?: string; limit: number },
) {
  const where = input.memoryId ? 'WHERE memory_id = ?' : '';
  const params = input.memoryId ? [input.memoryId] : [];
  return database
    .prepare(
      `
      SELECT *
      FROM memory_events
      ${where}
      ORDER BY created_at DESC
      LIMIT ?;
    `,
    )
    .all(...params, input.limit)
    .map((row) => {
      const record = row;
      return {
        id: String(record.id),
        memoryId: stringOrNull(record.memory_id),
        action: String(record.action),
        actor: String(record.actor),
        reason: stringOrNull(record.reason),
        before: parseJson(record.before_json),
        after: parseJson(record.after_json),
        createdAt: String(record.created_at),
      };
    });
}

function readLearningEvents(database: DatabaseSync, input: { limit: number }) {
  return database
    .prepare(
      `
      SELECT *
      FROM learning_events
      ORDER BY created_at DESC
      LIMIT ?;
    `,
    )
    .all(input.limit)
    .map((row) => {
      const record = row;
      return {
        id: String(record.id),
        type: String(record.type),
        source: String(record.source),
        sourceId: stringOrNull(record.source_id),
        repoId: stringOrNull(record.repo_id),
        sessionId: stringOrNull(record.session_id),
        prKey: stringOrNull(record.pr_key),
        data: parseJson(record.data_json),
        createdAt: String(record.created_at),
      };
    });
}

function summarizeSkillPatch(value: JsonValue | null) {
  const parsedPatch = v.safeParse(jsonObjectSchema, value);
  if (!parsedPatch.success) return value;
  // SAFETY: jsonObjectSchema validates every property before this record is read.
  const patch = parsedPatch.output as Record<string, JsonValue>;
  const operation = patch.operation;
  const parsedOperation = v.safeParse(jsonObjectSchema, operation);
  // SAFETY: jsonObjectSchema validates operation properties before reading its type.
  const operationRecord = parsedOperation.success
    ? (parsedOperation.output as Record<string, JsonValue>)
    : null;
  const operationType = operationRecord
    ? String(operationRecord.type ?? '')
    : null;
  return {
    skillId: stringOrNull(patch.skillId),
    skillSource: stringOrNull(patch.skillSource),
    path: stringOrNull(patch.path),
    operationType,
    summary: stringOrNull(patch.summary),
    beforeHash: stringOrNull(patch.beforeHash),
    afterHash: stringOrNull(patch.afterHash),
    diff: stringOrNull(patch.diff),
    proposedAt: stringOrNull(patch.proposedAt),
    appliesAfter: stringOrNull(patch.appliesAfter),
    restoreFromAudit: Boolean(patch.beforeContent && patch.afterContent),
  };
}

function countsBy(database: DatabaseSync, table: string, column: string) {
  return Object.fromEntries(
    database
      .prepare(
        `
        SELECT ${column} AS name, COUNT(*) AS count
        FROM ${table}
        GROUP BY ${column};
      `,
      )
      .all()
      .map((row) => {
        const record = row;
        return [String(record.name), Number(record.count ?? 0)];
      }),
  );
}

function scalarCount(database: DatabaseSync, sql: string) {
  const row = database.prepare(sql).get();
  return Number(row?.count ?? 0);
}

function parseJson(value: SQLOutputValue | undefined): JsonValue | null {
  const text = v.safeParse(v.string(), value);
  if (!text.success) return null;
  try {
    const parsed = v.safeParse(jsonValueSchema, JSON.parse(text.output));
    // SAFETY: jsonValueSchema validates the parsed input is JSON-safe before this result crosses the boundary.
    return parsed.success ? (parsed.output as JsonValue) : null;
  } catch {
    return null;
  }
}

function stringOrNull(value: JsonValue | SQLOutputValue | undefined) {
  const parsed = v.safeParse(v.string(), value);
  return parsed.success ? parsed.output : null;
}
