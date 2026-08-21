import { openDb, withImmediateTransaction } from '../../lib/sqlite.ts';
import { asJsonValue } from '../../lib/action-result';
import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import type { MemoryMutationSource, MemoryRecord } from './schemas';
import {
  memoryArchiveInputSchema,
  allMemoryScopeSchema,
  jsonValueSchema,
  memoryEventsInputSchema,
  memoryLearnInputSchema,
  memoryListInputSchema,
  memoryMarkUsedInputSchema,
  memoryMergeInputSchema,
  memoryRewriteInputSchema,
  memoryStatusSchema,
} from './schemas';
import {
  boundedRejectedAfter,
  failedMemoryMutation,
  memoryRejectionReason,
  memoryToJson,
  memoryWritePolicyResult,
  readMemoryById,
  readMemoryByScopeKey,
  readMemoryEventRow,
  safeReadMemoryRow,
  recordLearningEvent,
  recordMemoryEvent,
  resolveMemory,
} from './store';

type MemoryMutationOptions = {
  source?: MemoryMutationSource;
  effectId?: string;
};
const appMetadataValueRowSchema = v.object({ value: v.string() });
const replayMemoryRecordSchema = v.object({
  id: v.string(),
  scope: allMemoryScopeSchema,
  key: v.string(),
  value: jsonValueSchema,
  repoId: v.nullable(v.string()),
  status: memoryStatusSchema,
  useCount: v.number(),
  lastUsedAt: v.nullable(v.string()),
  createdAt: v.string(),
  updatedAt: v.string(),
});
const memoryEffectFailureSchema = v.object({
  ok: v.literal(false),
  action: v.string(),
  changed: v.literal(false),
  message: v.string(),
  errors: v.array(v.string()),
  requires: v.optional(v.array(v.string())),
});
const memoryUpsertEffectResultSchema = v.union([
  v.object({
    ok: v.literal(true),
    action: v.literal('memory_learn'),
    changed: v.boolean(),
    message: v.string(),
    memory: replayMemoryRecordSchema,
    appliesAfter: v.literal('new-session'),
  }),
  memoryEffectFailureSchema,
]);
const memoryRewriteEffectResultSchema = v.union([
  v.object({
    ok: v.literal(true),
    action: v.literal('memory_rewrite'),
    changed: v.boolean(),
    message: v.string(),
    memory: replayMemoryRecordSchema,
    appliesAfter: v.literal('new-session'),
  }),
  memoryEffectFailureSchema,
]);
const memoryMergeEffectResultSchema = v.union([
  v.object({
    ok: v.literal(true),
    action: v.literal('memory_merge'),
    changed: v.boolean(),
    message: v.string(),
    memory: replayMemoryRecordSchema,
    archivedSourceIds: v.array(v.string()),
    appliesAfter: v.literal('new-session'),
  }),
  memoryEffectFailureSchema,
]);
const memoryArchiveEffectResultSchema = v.union([
  v.object({
    ok: v.literal(true),
    action: v.literal('memory_archive'),
    changed: v.boolean(),
    message: v.string(),
    memory: v.optional(replayMemoryRecordSchema),
    appliesAfter: v.literal('new-session'),
  }),
  memoryEffectFailureSchema,
]);
type MemoryUpsertEffectResult = v.InferOutput<
  typeof memoryUpsertEffectResultSchema
>;
type MemoryRewriteEffectResult = v.InferOutput<
  typeof memoryRewriteEffectResultSchema
>;
type MemoryMergeEffectResult = v.InferOutput<
  typeof memoryMergeEffectResultSchema
>;
type MemoryArchiveEffectResult = v.InferOutput<
  typeof memoryArchiveEffectResultSchema
>;

function withRecordedMemoryEffect<T>(
  database: ReturnType<typeof openDb>,
  effectId: string | undefined,
  resultSchema: v.GenericSchema<unknown, T>,
  effect: () => T,
): T {
  if (!effectId) return effect();
  const key = `learning-review-effect:${effectId}`;
  const recordedRow = database
    .prepare('SELECT value FROM app_metadata WHERE key = ?;')
    .get(key);
  const recorded = v.safeParse(appMetadataValueRowSchema, recordedRow);
  if (recorded.success) {
    return v.parse(resultSchema, JSON.parse(recorded.output.value));
  }
  const result = effect();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO app_metadata (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO NOTHING;`,
    )
    .run(key, JSON.stringify(result), now);
  return result;
}

function readRecordedMemoryEffect<T>(
  paths: ReturnType<typeof runtimePaths>,
  effectId: string | undefined,
  resultSchema: v.GenericSchema<unknown, T>,
): T | undefined {
  if (!effectId) return undefined;
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const recordedRow = database
      .prepare('SELECT value FROM app_metadata WHERE key = ?;')
      .get(`learning-review-effect:${effectId}`);
    const recorded = v.safeParse(appMetadataValueRowSchema, recordedRow);
    return recorded.success
      ? v.parse(resultSchema, JSON.parse(recorded.output.value))
      : undefined;
  } finally {
    database.close();
  }
}

function withRecordedUpsertEffect(
  database: ReturnType<typeof openDb>,
  effectId: string | undefined,
  effect: () => MemoryUpsertEffectResult,
) {
  return withRecordedMemoryEffect(
    database,
    effectId,
    memoryUpsertEffectResultSchema,
    effect,
  );
}

function withRecordedRewriteEffect(
  database: ReturnType<typeof openDb>,
  effectId: string | undefined,
  effect: () => MemoryRewriteEffectResult,
) {
  return withRecordedMemoryEffect(
    database,
    effectId,
    memoryRewriteEffectResultSchema,
    effect,
  );
}

function withRecordedMergeEffect(
  database: ReturnType<typeof openDb>,
  effectId: string | undefined,
  effect: () => MemoryMergeEffectResult,
) {
  return withRecordedMemoryEffect(
    database,
    effectId,
    memoryMergeEffectResultSchema,
    effect,
  );
}

function withRecordedArchiveEffect(
  database: ReturnType<typeof openDb>,
  effectId: string | undefined,
  effect: () => MemoryArchiveEffectResult,
) {
  return withRecordedMemoryEffect(
    database,
    effectId,
    memoryArchiveEffectResultSchema,
    effect,
  );
}

function nextMemoryUpdatedAt(
  previousUpdatedAt: string | undefined,
  currentTime = new Date().toISOString(),
) {
  if (!previousUpdatedAt) return currentTime;
  const previousTime = Date.parse(previousUpdatedAt);
  const currentTimeMs = Date.parse(currentTime);
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTimeMs)) {
    return currentTime;
  }
  return new Date(Math.max(currentTimeMs, previousTime + 1)).toISOString();
}

export async function listMemories(
  input: v.InferInput<typeof memoryListInputSchema> = {},
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryListInputSchema, input);
  if (!parsed.success) {
    return {
      ok: false,
      action: 'memory_list',
      changed: false,
      memories: [],
      message: v.summarize(parsed.issues),
      errors: [v.summarize(parsed.issues)],
    };
  }

  const database = openDb(paths.neondeckDatabase);

  try {
    const filters: string[] = [];
    const params: string[] = [];
    if (parsed.output.scope) {
      filters.push('scope = ?');
      params.push(parsed.output.scope);
    }
    if (parsed.output.key) {
      filters.push('key = ?');
      params.push(parsed.output.key);
    }
    if (parsed.output.repoId) {
      filters.push('repo_id = ?');
      params.push(parsed.output.repoId);
    }
    if (parsed.output.status === 'active') {
      filters.push("status != 'archived'");
    } else if (parsed.output.status) {
      filters.push('status = ?');
      params.push(parsed.output.status);
    } else if (!parsed.output.includeArchived) {
      filters.push("status != 'archived'");
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const memories = database
      .prepare(
        `
        SELECT *
        FROM memories
        ${where}
        ORDER BY scope ASC, updated_at DESC, key ASC;
      `,
      )
      .all(...params)
      .flatMap(safeReadMemoryRow);

    return {
      ok: true,
      action: 'memory_list',
      changed: false,
      memories,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    database.close();
  }
}

export async function upsertMemory(
  input: v.InferInput<typeof memoryLearnInputSchema>,
  paths = runtimePaths(),
  options: MemoryMutationOptions = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryLearnInputSchema, input);
  if (!parsed.success) {
    return failedMemoryMutation('memory_learn', v.summarize(parsed.issues));
  }
  const recorded = readRecordedMemoryEffect(
    paths,
    options.effectId,
    memoryUpsertEffectResultSchema,
  );
  if (recorded !== undefined) return recorded;
  const mutationSource = options.source ?? 'user';
  const policy = await memoryWritePolicyResult(paths, mutationSource);
  if (!policy.ok) return policy.result;

  const rejection = memoryRejectionReason(parsed.output.value);
  if (rejection) {
    const database = openDb(paths.neondeckDatabase);
    try {
      recordMemoryEvent(database, {
        action: 'rejected',
        actor: parsed.output.actor ?? mutationSource,
        reason: rejection,
        before: null,
        after: boundedRejectedAfter(parsed.output),
        createdAt: new Date().toISOString(),
      });
    } finally {
      database.close();
    }
    return failedMemoryMutation('memory_learn', rejection, ['value']);
  }

  const now = new Date().toISOString();
  const value = asJsonValue(parsed.output.value);
  const database = openDb(paths.neondeckDatabase);

  try {
    return withImmediateTransaction(database, () =>
      withRecordedUpsertEffect(database, options.effectId, () => {
        const existing = readMemoryByScopeKey(
          database,
          parsed.output.scope,
          parsed.output.key,
          parsed.output.repoId ?? null,
        );
        if (
          parsed.output.expectedUpdatedAt !== undefined &&
          (existing?.updatedAt ?? null) !== parsed.output.expectedUpdatedAt
        ) {
          return failedMemoryMutation(
            'memory_learn',
            'Memory changed after editing began. Reload the current memory before saving.',
            ['memory-revision'],
          );
        }
        if (
          existing?.status === 'active' &&
          existing.repoId === (parsed.output.repoId ?? null) &&
          JSON.stringify(existing.value) === JSON.stringify(value)
        ) {
          return {
            ok: true,
            action: 'memory_learn',
            changed: false,
            memory: existing,
            appliesAfter: 'new-session',
            message: 'Durable memory already matched the requested guidance.',
          };
        }
        const before = existing ? memoryToJson(existing) : null;
        const id = existing?.id ?? randomUUID();
        const updatedAt = nextMemoryUpdatedAt(existing?.updatedAt, now);

        if (existing) {
          const update = parsed.output.expectedUpdatedAt
            ? database
                .prepare(
                  `
          UPDATE memories
          SET value_json = ?,
            repo_id = ?,
            status = 'active',
            updated_at = ?
          WHERE id = ? AND updated_at = ?;
        `,
                )
                .run(
                  JSON.stringify(value),
                  parsed.output.repoId ?? null,
                  updatedAt,
                  existing.id,
                  parsed.output.expectedUpdatedAt,
                )
            : database
                .prepare(
                  `
          UPDATE memories
          SET value_json = ?,
            repo_id = ?,
            status = 'active',
            updated_at = ?
          WHERE id = ?;
        `,
                )
                .run(
                  JSON.stringify(value),
                  parsed.output.repoId ?? null,
                  updatedAt,
                  existing.id,
                );
          if (update.changes !== 1) {
            return failedMemoryMutation(
              'memory_learn',
              'Memory changed after editing began. Reload the current memory before saving.',
              ['memory-revision'],
            );
          }
        } else {
          database
            .prepare(
              `
          INSERT INTO memories (
            id,
            scope,
            key,
            value_json,
            repo_id,
            status,
            use_count,
            last_used_at,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, 'active', 0, NULL, ?, ?);
        `,
            )
            .run(
              id,
              parsed.output.scope,
              parsed.output.key,
              JSON.stringify(value),
              parsed.output.repoId ?? null,
              now,
              updatedAt,
            );
        }

        const memory = readMemoryByScopeKey(
          database,
          parsed.output.scope,
          parsed.output.key,
          parsed.output.repoId ?? null,
        );
        if (!memory) {
          return failedMemoryMutation(
            'memory_learn',
            'Memory could not be read after it was saved.',
            ['memory'],
          );
        }
        const after = memory ? memoryToJson(memory) : null;
        const changed = JSON.stringify(before) !== JSON.stringify(after);
        if (memory && changed) {
          recordMemoryEvent(database, {
            memoryId: memory.id,
            action: before ? 'updated' : 'created',
            actor: parsed.output.actor ?? mutationSource,
            reason: parsed.output.reason ?? null,
            before,
            after,
            createdAt: now,
          });
          recordLearningEvent(database, {
            type: 'memory_applied',
            source: parsed.output.actor ?? mutationSource,
            repoId: memory.repoId,
            data: {
              memoryId: memory.id,
              scope: memory.scope,
              key: memory.key,
            },
            createdAt: now,
          });
        }

        return {
          ok: true,
          action: 'memory_learn',
          changed,
          memory,
          appliesAfter: 'new-session',
          message: changed
            ? 'Updated durable memory. Active agent context will pick this up on a new session.'
            : 'Durable memory already matched the requested guidance.',
        };
      }),
    );
  } finally {
    database.close();
  }
}

export async function rewriteMemory(
  input: v.InferInput<typeof memoryRewriteInputSchema>,
  paths = runtimePaths(),
  options: MemoryMutationOptions = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryRewriteInputSchema, input);
  if (!parsed.success) {
    return failedMemoryMutation('memory_rewrite', v.summarize(parsed.issues));
  }
  const recorded = readRecordedMemoryEffect(
    paths,
    options.effectId,
    memoryRewriteEffectResultSchema,
  );
  if (recorded !== undefined) return recorded;
  const mutationSource = options.source ?? 'user';
  const policy = await memoryWritePolicyResult(paths, mutationSource);
  if (!policy.ok) return { ...policy.result, action: 'memory_rewrite' };

  const rejection = memoryRejectionReason(parsed.output.value);
  if (rejection) {
    return failedMemoryMutation('memory_rewrite', rejection, ['value']);
  }

  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();

  try {
    return withImmediateTransaction(database, () =>
      withRecordedRewriteEffect(database, options.effectId, () => {
        const existing = resolveMemory(database, parsed.output);
        if (!existing) {
          return failedMemoryMutation(
            'memory_rewrite',
            'Memory was not found.',
            ['memory'],
          );
        }
        if (
          parsed.output.expectedUpdatedAt !== undefined &&
          existing.updatedAt !== parsed.output.expectedUpdatedAt
        ) {
          return failedMemoryMutation(
            'memory_rewrite',
            'Memory changed after the rewrite was prepared. Refresh the review before applying it.',
            ['memory-revision'],
          );
        }
        const value = asJsonValue(parsed.output.value);
        if (
          existing.status === 'active' &&
          JSON.stringify(existing.value) === JSON.stringify(value)
        ) {
          return {
            ok: true,
            action: 'memory_rewrite',
            changed: false,
            memory: existing,
            appliesAfter: 'new-session',
            message: 'Durable memory already matched the requested rewrite.',
          };
        }

        const before = memoryToJson(existing);
        const updatedAt = nextMemoryUpdatedAt(existing.updatedAt, now);
        const update = parsed.output.expectedUpdatedAt
          ? database
              .prepare(
                `
          UPDATE memories
          SET value_json = ?, status = 'active', updated_at = ?
          WHERE id = ? AND updated_at = ?;
        `,
              )
              .run(
                JSON.stringify(value),
                updatedAt,
                existing.id,
                parsed.output.expectedUpdatedAt,
              )
          : database
              .prepare(
                `
          UPDATE memories
          SET value_json = ?, status = 'active', updated_at = ?
          WHERE id = ?;
        `,
              )
              .run(JSON.stringify(value), updatedAt, existing.id);
        if (update.changes !== 1) {
          return failedMemoryMutation(
            'memory_rewrite',
            'Memory changed after the rewrite was prepared. Refresh the review before applying it.',
            ['memory-revision'],
          );
        }
        const memory = readMemoryById(database, existing.id);
        if (!memory) {
          return failedMemoryMutation(
            'memory_rewrite',
            'Memory was not found.',
            ['memory'],
          );
        }
        recordMemoryEvent(database, {
          memoryId: memory.id,
          action: 'rewritten',
          actor: parsed.output.actor ?? mutationSource,
          reason: parsed.output.reason ?? null,
          before,
          after: memoryToJson(memory),
          createdAt: now,
        });

        return {
          ok: true,
          action: 'memory_rewrite',
          changed: true,
          memory,
          appliesAfter: 'new-session',
          message:
            'Rewrote durable memory. Active agent context will pick this up on a new session.',
        };
      }),
    );
  } finally {
    database.close();
  }
}

export async function mergeMemories(
  input: v.InferInput<typeof memoryMergeInputSchema>,
  paths = runtimePaths(),
  options: MemoryMutationOptions = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryMergeInputSchema, input);
  if (!parsed.success) {
    return failedMemoryMutation('memory_merge', v.summarize(parsed.issues));
  }
  const recorded = readRecordedMemoryEffect(
    paths,
    options.effectId,
    memoryMergeEffectResultSchema,
  );
  if (recorded !== undefined) return recorded;
  const mutationSource = options.source ?? 'user';
  const policy = await memoryWritePolicyResult(paths, mutationSource);
  if (!policy.ok) return { ...policy.result, action: 'memory_merge' };
  if (parsed.output.value !== undefined) {
    const rejection = memoryRejectionReason(parsed.output.value);
    if (rejection) {
      return failedMemoryMutation('memory_merge', rejection, ['value']);
    }
  }

  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();

  try {
    return withImmediateTransaction(database, () =>
      withRecordedMergeEffect(database, options.effectId, () => {
        const target = readMemoryById(database, parsed.output.targetId);
        if (!target) {
          return failedMemoryMutation(
            'memory_merge',
            'Target memory was not found.',
            ['targetId'],
          );
        }

        const sourceIds = [...new Set(parsed.output.sourceIds)].filter(
          (id) => id !== target.id,
        );
        if (parsed.output.expectedUpdatedAts !== undefined) {
          for (const id of [target.id, ...sourceIds]) {
            const memory = readMemoryById(database, id);
            if (
              !memory ||
              parsed.output.expectedUpdatedAts[id] === undefined ||
              memory.updatedAt !== parsed.output.expectedUpdatedAts[id]
            ) {
              return failedMemoryMutation(
                'memory_merge',
                'Memory changed after the merge was prepared. Refresh the review before applying it.',
                ['memory-revision'],
              );
            }
          }
        }
        const existingSources = sourceIds
          .map((id) => readMemoryById(database, id))
          .filter((memory): memory is MemoryRecord => !!memory);
        if (existingSources.length === 0) {
          return failedMemoryMutation(
            'memory_merge',
            'No source memories found.',
            ['sourceIds'],
          );
        }
        const sources = existingSources.filter(
          (memory) => memory.status !== 'archived',
        );
        if (sources.length === 0) {
          return {
            ok: true,
            action: 'memory_merge',
            changed: false,
            memory: target,
            archivedSourceIds: [],
            appliesAfter: 'new-session',
            message: 'Source memories were already merged.',
          };
        }

        const before = memoryToJson(target);
        const targetUpdatedAt = nextMemoryUpdatedAt(target.updatedAt, now);
        if (parsed.output.value !== undefined) {
          database
            .prepare(
              `
          UPDATE memories
          SET value_json = ?, status = 'active', updated_at = ?
          WHERE id = ?;
        `,
            )
            .run(
              JSON.stringify(asJsonValue(parsed.output.value)),
              targetUpdatedAt,
              target.id,
            );
        } else {
          database
            .prepare(
              `
          UPDATE memories
          SET updated_at = ?
          WHERE id = ?;
        `,
            )
            .run(targetUpdatedAt, target.id);
        }
        for (const sourceMemory of sources) {
          const sourceUpdatedAt = nextMemoryUpdatedAt(
            sourceMemory.updatedAt,
            now,
          );
          database
            .prepare(
              `
          UPDATE memories
          SET status = 'archived', updated_at = ?
          WHERE id = ?;
        `,
            )
            .run(sourceUpdatedAt, sourceMemory.id);
          recordMemoryEvent(database, {
            memoryId: sourceMemory.id,
            action: 'archived',
            actor: parsed.output.actor ?? mutationSource,
            reason: parsed.output.reason ?? `Merged into ${target.id}.`,
            before: memoryToJson(sourceMemory),
            after: memoryToJson({
              ...sourceMemory,
              status: 'archived',
              updatedAt: sourceUpdatedAt,
            }),
            createdAt: now,
          });
        }

        const memory = readMemoryById(database, target.id);
        if (!memory) {
          return failedMemoryMutation(
            'memory_merge',
            'Target memory was not found.',
            ['targetId'],
          );
        }
        recordMemoryEvent(database, {
          memoryId: memory.id,
          action: 'merged',
          actor: parsed.output.actor ?? mutationSource,
          reason: parsed.output.reason ?? null,
          before,
          after: memoryToJson(memory),
          createdAt: now,
        });

        return {
          ok: true,
          action: 'memory_merge',
          changed: true,
          memory,
          archivedSourceIds: sources.map((source) => source.id),
          appliesAfter: 'new-session',
          message: `Merged ${sources.length} memory entr${sources.length === 1 ? 'y' : 'ies'}. Active agent context will pick this up on a new session.`,
        };
      }),
    );
  } finally {
    database.close();
  }
}

export async function archiveMemory(
  input: v.InferInput<typeof memoryArchiveInputSchema>,
  paths = runtimePaths(),
  options: MemoryMutationOptions = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryArchiveInputSchema, input);
  if (!parsed.success) {
    return failedMemoryMutation('memory_archive', v.summarize(parsed.issues));
  }
  const recorded = readRecordedMemoryEffect(
    paths,
    options.effectId,
    memoryArchiveEffectResultSchema,
  );
  if (recorded !== undefined) return recorded;
  const source = options.source ?? 'user';
  const policy = await memoryWritePolicyResult(paths, source);
  if (!policy.ok) return { ...policy.result, action: 'memory_archive' };

  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();

  try {
    return withImmediateTransaction(database, () =>
      withRecordedArchiveEffect(database, options.effectId, () => {
        const existing = resolveMemory(database, parsed.output);
        if (!existing) {
          if (parsed.output.expectedUpdatedAt !== undefined) {
            return failedMemoryMutation(
              'memory_archive',
              'Memory changed after archive confirmation began. Reload the current memory before archiving.',
              ['memory-revision'],
            );
          }
          return {
            ok: true,
            action: 'memory_archive',
            changed: false,
            appliesAfter: 'new-session',
            message: 'No matching memory entry existed.',
          };
        }
        if (
          parsed.output.expectedUpdatedAt !== undefined &&
          existing.updatedAt !== parsed.output.expectedUpdatedAt
        ) {
          return failedMemoryMutation(
            'memory_archive',
            'Memory changed after archive confirmation began. Reload the current memory before archiving.',
            ['memory-revision'],
          );
        }
        if (existing.status === 'archived') {
          return {
            ok: true,
            action: 'memory_archive',
            changed: false,
            memory: existing,
            appliesAfter: 'new-session',
            message: 'Memory entry was already archived.',
          };
        }

        const updatedAt = nextMemoryUpdatedAt(existing.updatedAt, now);
        const update = parsed.output.expectedUpdatedAt
          ? database
              .prepare(
                `
        UPDATE memories
        SET status = 'archived', updated_at = ?
        WHERE id = ? AND updated_at = ?;
      `,
              )
              .run(updatedAt, existing.id, parsed.output.expectedUpdatedAt)
          : database
              .prepare(
                `
        UPDATE memories
        SET status = 'archived', updated_at = ?
        WHERE id = ?;
      `,
              )
              .run(updatedAt, existing.id);
        if (update.changes !== 1) {
          return failedMemoryMutation(
            'memory_archive',
            'Memory changed after archive confirmation began. Reload the current memory before archiving.',
            ['memory-revision'],
          );
        }
        const memory = readMemoryById(database, existing.id);
        if (!memory) {
          return failedMemoryMutation(
            'memory_archive',
            'Memory could not be read after it was archived.',
            ['memory'],
          );
        }
        recordMemoryEvent(database, {
          memoryId: memory.id,
          action: 'archived',
          actor: parsed.output.actor ?? source,
          reason: parsed.output.reason ?? null,
          before: memoryToJson(existing),
          after: memoryToJson(memory),
          createdAt: now,
        });

        return {
          ok: true,
          action: 'memory_archive',
          changed: true,
          memory,
          appliesAfter: 'new-session',
          message:
            'Archived durable memory. Active agent context will pick this up on a new session.',
        };
      }),
    );
  } finally {
    database.close();
  }
}

export async function markMemoriesUsed(
  input: v.InferInput<typeof memoryMarkUsedInputSchema>,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryMarkUsedInputSchema, input);
  if (!parsed.success) {
    return failedMemoryMutation('memory_mark_used', v.summarize(parsed.issues));
  }

  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    const ids = [...new Set(parsed.output.ids)];
    let changed = 0;
    for (const id of ids) {
      changed += Number(
        database
          .prepare(
            `
            UPDATE memories
            SET use_count = use_count + 1,
              last_used_at = ?,
              updated_at = updated_at
            WHERE id = ?
              AND status != 'archived'
              AND scope IN ('user', 'local', 'project');
          `,
          )
          .run(now, id).changes,
      );
    }
    return {
      ok: true,
      action: 'memory_mark_used',
      changed: changed > 0,
      marked: changed,
      message: `Marked ${changed} memory entr${changed === 1 ? 'y' : 'ies'} as used.`,
    };
  } finally {
    database.close();
  }
}

export async function listMemoryEvents(
  input: v.InferInput<typeof memoryEventsInputSchema> = {},
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryEventsInputSchema, input);
  if (!parsed.success) {
    return {
      ok: false,
      action: 'memory_events',
      events: [],
      message: v.summarize(parsed.issues),
      errors: [v.summarize(parsed.issues)],
    };
  }

  const database = openDb(paths.neondeckDatabase);
  try {
    const events = database
      .prepare(
        `
        SELECT *
        FROM memory_events
        ${parsed.output.memoryId ? 'WHERE memory_id = ?' : ''}
        ORDER BY created_at DESC
        LIMIT ?;
      `,
      )
      .all(
        ...(parsed.output.memoryId ? [parsed.output.memoryId] : []),
        parsed.output.limit ?? 100,
      )
      .map(readMemoryEventRow);
    return {
      ok: true,
      action: 'memory_events',
      changed: false,
      events,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    database.close();
  }
}
