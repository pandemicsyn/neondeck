import { defineAction, type JsonValue } from '@flue/runtime';
import { asJsonValue } from './lib/action-result';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import {
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  readRuntimeJsonSync,
  resolveLearningConfig,
  runtimePaths,
  type RuntimePaths,
} from './runtime-home';

export type ActiveMemoryScope = 'user' | 'local' | 'project';
export type LegacyMemoryScope = 'session' | 'watch';
export type MemoryScope = ActiveMemoryScope | LegacyMemoryScope;
export type MemoryStatus = 'active' | 'archived';
type MemoryMutationSource = 'user' | 'neon' | 'workflow';

export type MemoryRecord = {
  id: string;
  scope: MemoryScope;
  key: string;
  value: JsonValue;
  repoId: string | null;
  status: MemoryStatus;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemoryEventRecord = {
  id: string;
  memoryId: string | null;
  action:
    'created' | 'updated' | 'rewritten' | 'merged' | 'archived' | 'rejected';
  actor: 'user' | 'neon' | 'workflow';
  reason: string | null;
  before: JsonValue | null;
  after: JsonValue | null;
  createdAt: string;
};

export type MemoryCandidateRecord = {
  id: string;
  target: 'memory';
  status: 'proposed' | 'applied' | 'rejected' | 'archived';
  action: 'upsert' | 'rewrite' | 'merge' | 'archive';
  scope: ActiveMemoryScope | null;
  key: string | null;
  value: JsonValue | null;
  repoId: string | null;
  reason: string | null;
  reviewId: string | null;
  patch: JsonValue | null;
  createdAt: string;
  decidedAt: string | null;
};

const allMemoryScopeSchema = v.picklist([
  'user',
  'local',
  'project',
  'session',
  'watch',
]);
const activeMemoryScopeSchema = v.picklist(['user', 'local', 'project']);
const memoryStatusSchema = v.picklist(['active', 'archived']);
const memoryActorSchema = v.picklist(['user', 'neon', 'workflow']);
const memoryCandidateActionSchema = v.picklist([
  'upsert',
  'rewrite',
  'merge',
  'archive',
]);
const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const memoryIdentifierSchema = v.object({
  id: v.optional(nonEmptyStringSchema),
  scope: v.optional(allMemoryScopeSchema),
  key: v.optional(nonEmptyStringSchema),
  repoId: v.optional(nonEmptyStringSchema),
});
const jsonValueSchema = v.pipe(
  v.unknown(),
  v.check(isJsonValue, 'Value must be JSON-safe.'),
);

const memoryListInputSchema = v.object({
  scope: v.optional(allMemoryScopeSchema),
  key: v.optional(nonEmptyStringSchema),
  status: v.optional(memoryStatusSchema),
  includeArchived: v.optional(v.boolean()),
  repoId: v.optional(nonEmptyStringSchema),
});
const memoryLearnInputSchema = v.object({
  scope: activeMemoryScopeSchema,
  key: nonEmptyStringSchema,
  value: jsonValueSchema,
  repoId: v.optional(nonEmptyStringSchema),
  reason: v.optional(v.string()),
  actor: v.optional(memoryActorSchema),
});
const memoryRewriteInputSchema = v.object({
  id: v.optional(nonEmptyStringSchema),
  scope: v.optional(allMemoryScopeSchema),
  key: v.optional(nonEmptyStringSchema),
  repoId: v.optional(nonEmptyStringSchema),
  value: jsonValueSchema,
  reason: v.optional(v.string()),
  actor: v.optional(memoryActorSchema),
});
const memoryMergeInputSchema = v.object({
  targetId: nonEmptyStringSchema,
  sourceIds: v.pipe(v.array(nonEmptyStringSchema), v.minLength(1)),
  value: v.optional(jsonValueSchema),
  reason: v.optional(v.string()),
  actor: v.optional(memoryActorSchema),
});
const memoryArchiveInputSchema = v.object({
  id: v.optional(nonEmptyStringSchema),
  scope: v.optional(allMemoryScopeSchema),
  key: v.optional(nonEmptyStringSchema),
  repoId: v.optional(nonEmptyStringSchema),
  reason: v.optional(v.string()),
  actor: v.optional(memoryActorSchema),
  confirm: v.optional(v.boolean()),
});
const memoryMarkUsedInputSchema = v.object({
  ids: v.pipe(v.array(nonEmptyStringSchema), v.minLength(1)),
});
const memoryEventsInputSchema = v.object({
  memoryId: v.optional(nonEmptyStringSchema),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
const memoryCandidateCreateInputSchema = v.object({
  action: memoryCandidateActionSchema,
  scope: v.optional(activeMemoryScopeSchema),
  key: v.optional(nonEmptyStringSchema),
  value: v.optional(jsonValueSchema),
  repoId: v.optional(nonEmptyStringSchema),
  reason: v.optional(v.string()),
  reviewId: v.optional(nonEmptyStringSchema),
  patch: v.optional(jsonValueSchema),
});
const memoryCandidateListInputSchema = v.object({
  status: v.optional(
    v.picklist(['proposed', 'applied', 'rejected', 'archived']),
  ),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
const memoryCandidateDecideInputSchema = v.object({
  id: nonEmptyStringSchema,
  decision: v.picklist(['apply', 'reject', 'archive']),
  reason: v.optional(v.string()),
  actor: v.optional(memoryActorSchema),
});
const memoryCurateInputSchema = v.object({
  mode: v.optional(v.picklist(['off', 'review', 'auto'])),
  reason: v.optional(v.string()),
});

const memoryActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

export const memoryListAction = defineAction({
  name: 'neondeck_memory_list',
  description:
    'List durable Neondeck structured memories by optional scope, key, status, and repo id. Legacy session/watch memories are readable but not writable.',
  input: memoryListInputSchema,
  output: v.looseObject({
    ok: v.boolean(),
    action: v.string(),
    memories: v.array(v.unknown()),
  }),
  async run({ input }) {
    return listMemories(input);
  },
});

export const memoryLearnAction = defineAction({
  name: 'neondeck_memory_learn',
  description:
    'Learn or update current durable guidance in user, local, or project memory with audit history.',
  input: memoryLearnInputSchema,
  output: memoryActionOutputSchema,
  async run({ input }) {
    return upsertMemory(input, runtimePaths(), { source: 'neon' });
  },
});

export const memoryUpsertAction = defineAction({
  name: 'neondeck_memory_upsert',
  description:
    'Compatibility alias for neondeck_memory_learn. New writes are restricted to user, local, and project memory.',
  input: memoryLearnInputSchema,
  output: memoryActionOutputSchema,
  async run({ input }) {
    return upsertMemory(input, runtimePaths(), { source: 'neon' });
  },
});

export const memoryRewriteAction = defineAction({
  name: 'neondeck_memory_rewrite',
  description:
    'Rewrite one active memory into clearer current guidance while preserving before/after audit history.',
  input: memoryRewriteInputSchema,
  output: memoryActionOutputSchema,
  async run({ input }) {
    return rewriteMemory(input, runtimePaths(), { source: 'neon' });
  },
});

export const memoryMergeAction = defineAction({
  name: 'neondeck_memory_merge',
  description:
    'Merge duplicate memory rows by rewriting the target and archiving source rows with audit history.',
  input: memoryMergeInputSchema,
  output: memoryActionOutputSchema,
  async run({ input }) {
    return mergeMemories(input, runtimePaths(), { source: 'neon' });
  },
});

export const memoryArchiveAction = defineAction({
  name: 'neondeck_memory_archive',
  description:
    'Archive one memory entry. Archived memories stay in audit/history but do not load into new session prompt snapshots.',
  input: memoryArchiveInputSchema,
  output: memoryActionOutputSchema,
  async run({ input }) {
    return archiveMemory(input, runtimePaths(), { source: 'neon' });
  },
});

export const memoryDeleteAction = defineAction({
  name: 'neondeck_memory_delete',
  description:
    'Compatibility alias that archives one durable memory entry after explicit confirmation.',
  input: memoryArchiveInputSchema,
  output: memoryActionOutputSchema,
  async run({ input }) {
    return deleteMemory(input, runtimePaths(), { source: 'neon' });
  },
});

export const memoryMarkUsedAction = defineAction({
  name: 'neondeck_memory_mark_used',
  description:
    'Increment usage counters for memories loaded into a deliberate prompt snapshot.',
  input: memoryMarkUsedInputSchema,
  output: memoryActionOutputSchema,
  async run({ input }) {
    return markMemoriesUsed(input);
  },
});

export const memoryEventsAction = defineAction({
  name: 'neondeck_memory_events',
  description: 'List recent memory audit events.',
  input: memoryEventsInputSchema,
  output: v.looseObject({
    ok: v.boolean(),
    action: v.string(),
    events: v.array(v.unknown()),
  }),
  async run({ input }) {
    return listMemoryEvents(input);
  },
});

export const memoryCandidateCreateAction = defineAction({
  name: 'neondeck_memory_candidate_create',
  description:
    'Create a review-mode memory curation candidate for later approval or rejection.',
  input: memoryCandidateCreateInputSchema,
  output: memoryActionOutputSchema,
  async run({ input }) {
    return createMemoryCandidate(input, runtimePaths(), { source: 'neon' });
  },
});

export const memoryCandidateListAction = defineAction({
  name: 'neondeck_memory_candidate_list',
  description: 'List memory curation candidates awaiting review or history.',
  input: memoryCandidateListInputSchema,
  output: v.looseObject({
    ok: v.boolean(),
    action: v.string(),
    candidates: v.array(v.unknown()),
  }),
  async run({ input }) {
    return listMemoryCandidates(input);
  },
});

export const memoryCandidateDecideAction = defineAction({
  name: 'neondeck_memory_candidate_decide',
  description:
    'Apply, reject, or archive one memory curation candidate with audit history.',
  input: memoryCandidateDecideInputSchema,
  output: memoryActionOutputSchema,
  async run({ input }) {
    return decideMemoryCandidate(input, runtimePaths(), { source: 'neon' });
  },
});

export const memoryCurateAction = defineAction({
  name: 'neondeck_memory_curate',
  description:
    'Run bounded memory curation. Review mode proposes candidates; auto mode applies safe archive-only overflow cleanup through typed audited actions.',
  input: memoryCurateInputSchema,
  output: v.looseObject({
    ok: v.boolean(),
    action: v.string(),
    changed: v.boolean(),
    mode: v.optional(v.string()),
    message: v.string(),
  }),
  async run({ input }) {
    return curateMemoryStore(input, runtimePaths(), { source: 'neon' });
  },
});

export const neondeckMemoryActions = [
  memoryListAction,
  memoryLearnAction,
  memoryUpsertAction,
  memoryRewriteAction,
  memoryMergeAction,
  memoryArchiveAction,
  memoryDeleteAction,
  memoryMarkUsedAction,
  memoryEventsAction,
  memoryCandidateCreateAction,
  memoryCandidateListAction,
  memoryCandidateDecideAction,
  memoryCurateAction,
];

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

  const database = new DatabaseSync(paths.neondeckDatabase);

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
    if (parsed.output.status) {
      filters.push('status = ?');
      params.push(parsed.output.status);
    } else if (!parsed.output.includeArchived) {
      filters.push("status = 'active'");
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
      .map(readMemoryRow);

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
  options: { source?: MemoryMutationSource } = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryLearnInputSchema, input);
  if (!parsed.success) {
    return failedMemoryMutation('memory_upsert', v.summarize(parsed.issues));
  }
  const mutationSource = options.source ?? 'user';
  const policy = await memoryWritePolicyResult(paths, mutationSource);
  if (!policy.ok) return policy.result;

  const rejection = memoryRejectionReason(parsed.output.value);
  if (rejection) {
    const database = new DatabaseSync(paths.neondeckDatabase);
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
    return failedMemoryMutation('memory_upsert', rejection, ['value']);
  }

  const now = new Date().toISOString();
  const value = asJsonValue(parsed.output.value);
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    const existing = readMemoryByScopeKey(
      database,
      parsed.output.scope,
      parsed.output.key,
      parsed.output.repoId ?? null,
    );
    const before = existing ? memoryToJson(existing) : null;
    const id = existing?.id ?? randomUUID();

    if (existing) {
      database
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
          now,
          existing.id,
        );
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
          now,
        );
    }

    const memory = readMemoryByScopeKey(
      database,
      parsed.output.scope,
      parsed.output.key,
      parsed.output.repoId ?? null,
    );
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
        data: { memoryId: memory.id, scope: memory.scope, key: memory.key },
        createdAt: now,
      });
    }

    return {
      ok: true,
      action: 'memory_upsert',
      changed,
      memory,
      appliesAfter: 'new-session',
      message: changed
        ? 'Updated durable memory. Active agent context will pick this up on a new session.'
        : 'Durable memory already matched the requested guidance.',
    };
  } finally {
    database.close();
  }
}

export async function rewriteMemory(
  input: v.InferInput<typeof memoryRewriteInputSchema>,
  paths = runtimePaths(),
  options: { source?: MemoryMutationSource } = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryRewriteInputSchema, input);
  if (!parsed.success) {
    return failedMemoryMutation('memory_rewrite', v.summarize(parsed.issues));
  }
  const mutationSource = options.source ?? 'user';
  const policy = await memoryWritePolicyResult(paths, mutationSource);
  if (!policy.ok) return { ...policy.result, action: 'memory_rewrite' };

  const rejection = memoryRejectionReason(parsed.output.value);
  if (rejection) {
    return failedMemoryMutation('memory_rewrite', rejection, ['value']);
  }

  const database = new DatabaseSync(paths.neondeckDatabase);
  const now = new Date().toISOString();

  try {
    const existing = resolveMemory(database, parsed.output);
    if (!existing) {
      return failedMemoryMutation('memory_rewrite', 'Memory was not found.', [
        'memory',
      ]);
    }

    const before = memoryToJson(existing);
    database
      .prepare(
        `
        UPDATE memories
        SET value_json = ?, status = 'active', updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(JSON.stringify(asJsonValue(parsed.output.value)), now, existing.id);
    const memory = readMemoryById(database, existing.id);
    if (!memory) {
      return failedMemoryMutation('memory_rewrite', 'Memory was not found.', [
        'memory',
      ]);
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
  } finally {
    database.close();
  }
}

export async function mergeMemories(
  input: v.InferInput<typeof memoryMergeInputSchema>,
  paths = runtimePaths(),
  options: { source?: MemoryMutationSource } = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryMergeInputSchema, input);
  if (!parsed.success) {
    return failedMemoryMutation('memory_merge', v.summarize(parsed.issues));
  }
  const mutationSource = options.source ?? 'user';
  const policy = await memoryWritePolicyResult(paths, mutationSource);
  if (!policy.ok) return { ...policy.result, action: 'memory_merge' };
  if (parsed.output.value !== undefined) {
    const rejection = memoryRejectionReason(parsed.output.value);
    if (rejection) {
      return failedMemoryMutation('memory_merge', rejection, ['value']);
    }
  }

  const database = new DatabaseSync(paths.neondeckDatabase);
  const now = new Date().toISOString();

  try {
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
    const sources = sourceIds
      .map((id) => readMemoryById(database, id))
      .filter((memory): memory is MemoryRecord => !!memory);
    if (sources.length === 0) {
      return failedMemoryMutation('memory_merge', 'No source memories found.', [
        'sourceIds',
      ]);
    }

    const before = memoryToJson(target);
    if (parsed.output.value !== undefined) {
      database
        .prepare(
          `
          UPDATE memories
          SET value_json = ?, status = 'active', updated_at = ?
          WHERE id = ?;
        `,
        )
        .run(JSON.stringify(asJsonValue(parsed.output.value)), now, target.id);
    }
    for (const sourceMemory of sources) {
      database
        .prepare(
          `
          UPDATE memories
          SET status = 'archived', updated_at = ?
          WHERE id = ?;
        `,
        )
        .run(now, sourceMemory.id);
      recordMemoryEvent(database, {
        memoryId: sourceMemory.id,
        action: 'archived',
        actor: parsed.output.actor ?? mutationSource,
        reason: parsed.output.reason ?? `Merged into ${target.id}.`,
        before: memoryToJson(sourceMemory),
        after: memoryToJson({
          ...sourceMemory,
          status: 'archived',
          updatedAt: now,
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
  } finally {
    database.close();
  }
}

export async function archiveMemory(
  input: v.InferInput<typeof memoryArchiveInputSchema>,
  paths = runtimePaths(),
  options: { source?: MemoryMutationSource } = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryArchiveInputSchema, input);
  if (!parsed.success) {
    return failedMemoryMutation('memory_archive', v.summarize(parsed.issues));
  }
  const source = options.source ?? 'user';
  const policy = await memoryWritePolicyResult(paths, source);
  if (!policy.ok) return { ...policy.result, action: 'memory_archive' };

  const database = new DatabaseSync(paths.neondeckDatabase);
  const now = new Date().toISOString();

  try {
    const existing = resolveMemory(database, parsed.output);
    if (!existing) {
      return {
        ok: true,
        action: 'memory_archive',
        changed: false,
        appliesAfter: 'new-session',
        message: 'No matching memory entry existed.',
      };
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

    database
      .prepare(
        `
        UPDATE memories
        SET status = 'archived', updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(now, existing.id);
    const memory = readMemoryById(database, existing.id);
    if (memory) {
      recordMemoryEvent(database, {
        memoryId: memory.id,
        action: 'archived',
        actor: parsed.output.actor ?? source,
        reason: parsed.output.reason ?? null,
        before: memoryToJson(existing),
        after: memoryToJson(memory),
        createdAt: now,
      });
    }

    return {
      ok: true,
      action: 'memory_archive',
      changed: true,
      memory,
      appliesAfter: 'new-session',
      message:
        'Archived durable memory. Active agent context will pick this up on a new session.',
    };
  } finally {
    database.close();
  }
}

export async function deleteMemory(
  input: v.InferInput<typeof memoryArchiveInputSchema>,
  paths = runtimePaths(),
  options: { source?: MemoryMutationSource } = {},
) {
  const parsed = v.safeParse(memoryArchiveInputSchema, input);
  if (!parsed.success) {
    return failedMemoryMutation('memory_delete', v.summarize(parsed.issues));
  }

  if (parsed.output.confirm !== true) {
    const label =
      'id' in parsed.output
        ? parsed.output.id
        : `${parsed.output.scope}:${parsed.output.key}`;
    return {
      ok: false,
      action: 'memory_delete',
      changed: false,
      requires: ['confirm'],
      message: `Archiving memory "${label}" requires confirmation.`,
    };
  }

  const result = await archiveMemory(
    {
      ...parsed.output,
      reason: parsed.output.reason ?? 'Archived through memory delete alias.',
    },
    paths,
    options,
  );

  return {
    ...result,
    action: 'memory_delete',
    message: result.changed
      ? 'Archived durable memory. Active agent context will pick this up on a new session.'
      : result.message,
  };
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
  const database = new DatabaseSync(paths.neondeckDatabase);
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
              AND status = 'active';
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

  const database = new DatabaseSync(paths.neondeckDatabase);
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

export async function createMemoryCandidate(
  input: v.InferInput<typeof memoryCandidateCreateInputSchema>,
  paths = runtimePaths(),
  options: { source?: MemoryMutationSource } = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryCandidateCreateInputSchema, input);
  if (!parsed.success) {
    return failedMemoryMutation(
      'memory_candidate_create',
      v.summarize(parsed.issues),
    );
  }
  const policy = await memoryCandidatePolicyResult(
    paths,
    options.source ?? 'user',
  );
  if (!policy.ok) {
    return { ...policy.result, action: 'memory_candidate_create' };
  }

  const now = new Date().toISOString();
  if (parsed.output.value !== undefined) {
    const rejection = memoryRejectionReason(parsed.output.value);
    if (rejection) {
      const database = new DatabaseSync(paths.neondeckDatabase);
      try {
        recordMemoryEvent(database, {
          action: 'rejected',
          actor: options.source ?? 'user',
          reason: rejection,
          before: null,
          after: boundedRejectedCandidateAfter(parsed.output),
          createdAt: now,
        });
      } finally {
        database.close();
      }
      return failedMemoryMutation('memory_candidate_create', rejection, [
        'value',
      ]);
    }
  }

  const candidate: MemoryCandidateRecord = {
    id: randomUUID(),
    target: 'memory',
    status: 'proposed',
    action: parsed.output.action,
    scope: parsed.output.scope ?? null,
    key: parsed.output.key ?? null,
    value:
      parsed.output.value === undefined
        ? null
        : asJsonValue(parsed.output.value),
    repoId: parsed.output.repoId ?? null,
    reason: parsed.output.reason ?? null,
    reviewId: parsed.output.reviewId ?? null,
    patch:
      parsed.output.patch === undefined
        ? null
        : asJsonValue(parsed.output.patch),
    createdAt: now,
    decidedAt: null,
  };

  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    insertMemoryCandidate(database, candidate);
    recordLearningEvent(database, {
      type: 'memory_candidate_created',
      source: 'workflow',
      repoId: candidate.repoId,
      data: { candidateId: candidate.id, action: candidate.action },
      createdAt: now,
    });
    return {
      ok: true,
      action: 'memory_candidate_create',
      changed: true,
      candidate,
      message: `Created memory ${candidate.action} candidate.`,
    };
  } finally {
    database.close();
  }
}

export async function listMemoryCandidates(
  input: v.InferInput<typeof memoryCandidateListInputSchema> = {},
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryCandidateListInputSchema, input);
  if (!parsed.success) {
    return {
      ok: false,
      action: 'memory_candidate_list',
      changed: false,
      candidates: [],
      message: v.summarize(parsed.issues),
      errors: [v.summarize(parsed.issues)],
    };
  }

  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    const candidates = database
      .prepare(
        `
        SELECT *
        FROM learning_candidates
        WHERE target = 'memory'
          ${parsed.output.status ? 'AND status = ?' : ''}
        ORDER BY created_at DESC
        LIMIT ?;
      `,
      )
      .all(
        ...(parsed.output.status ? [parsed.output.status] : []),
        parsed.output.limit ?? 100,
      )
      .map(readMemoryCandidateRow);
    return {
      ok: true,
      action: 'memory_candidate_list',
      changed: false,
      candidates,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    database.close();
  }
}

export async function decideMemoryCandidate(
  input: v.InferInput<typeof memoryCandidateDecideInputSchema>,
  paths = runtimePaths(),
  options: { source?: MemoryMutationSource } = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryCandidateDecideInputSchema, input);
  if (!parsed.success) {
    return failedMemoryMutation(
      'memory_candidate_decide',
      v.summarize(parsed.issues),
    );
  }
  if ((options.source ?? 'user') !== 'user') {
    return failedMemoryMutation(
      'memory_candidate_decide',
      'Memory candidates require an explicit user/API decision before they can be applied, rejected, or archived.',
      ['explicit-user-decision'],
    );
  }

  const database = new DatabaseSync(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    const candidateRow = database
      .prepare(
        `
        SELECT *
        FROM learning_candidates
        WHERE id = ?
          AND target = 'memory';
      `,
      )
      .get(parsed.output.id);
    if (!candidateRow) {
      return failedMemoryMutation(
        'memory_candidate_decide',
        'Memory candidate was not found.',
        ['id'],
      );
    }
    const candidate = readMemoryCandidateRow(candidateRow);
    if (candidate.status !== 'proposed') {
      return failedMemoryMutation(
        'memory_candidate_decide',
        'Memory candidate was already decided.',
        ['id'],
      );
    }

    if (parsed.output.decision !== 'apply') {
      const status =
        parsed.output.decision === 'reject' ? 'rejected' : 'archived';
      database
        .prepare(
          `
          UPDATE learning_candidates
          SET status = ?, decided_at = ?
          WHERE id = ?;
        `,
        )
        .run(status, now, candidate.id);
      recordMemoryEvent(database, {
        action: parsed.output.decision === 'reject' ? 'rejected' : 'archived',
        actor: parsed.output.actor ?? 'user',
        reason: parsed.output.reason ?? candidate.reason,
        before: null,
        after: { candidateId: candidate.id },
        createdAt: now,
      });
      return {
        ok: true,
        action: 'memory_candidate_decide',
        changed: true,
        decision: parsed.output.decision,
        message: `Memory candidate ${status}.`,
      };
    }

    const applyResult = await applyMemoryCandidate(candidate, paths, 'user');
    if (!applyResult.ok) return applyResult;

    database
      .prepare(
        `
        UPDATE learning_candidates
        SET status = 'applied', decided_at = ?
        WHERE id = ?;
      `,
      )
      .run(now, candidate.id);
    return {
      ok: true,
      action: 'memory_candidate_decide',
      changed: true,
      decision: 'apply',
      applied: applyResult,
      message: 'Applied memory candidate.',
    };
  } finally {
    database.close();
  }
}

export async function curateMemoryStore(
  input: v.InferInput<typeof memoryCurateInputSchema> = {},
  paths = runtimePaths(),
  options: { source?: MemoryMutationSource } = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryCurateInputSchema, input);
  if (!parsed.success) {
    return failedMemoryMutation('memory_curate', v.summarize(parsed.issues));
  }

  const config = await readRuntimeJson(paths.config, parseAppConfig)
    .then((value) => resolveLearningConfig(value))
    .catch(() => resolveLearningConfig());
  const mode = parsed.output.mode ?? config.memoryCurationMode;
  const source = options.source ?? 'user';
  if (!config.enabled && source !== 'user') {
    return {
      ok: false,
      action: 'memory_curate',
      changed: false,
      mode,
      message: 'Learning is disabled; autonomous memory curation is blocked.',
      errors: ['Learning is disabled.'],
    };
  }
  if ((source !== 'user' && !config.memoryCurationEnabled) || mode === 'off') {
    return {
      ok: true,
      action: 'memory_curate',
      changed: false,
      mode,
      message: 'Memory curation is disabled.',
      proposals: [],
      applied: [],
    };
  }

  const active = (
    await listMemories(
      {
        status: 'active',
        includeArchived: false,
      },
      paths,
    )
  ).memories.filter(isActiveLearningMemory);
  const proposals = curationProposals(active, config.memoryMaxActiveItems);
  if (mode === 'review') {
    const candidates = [];
    for (const proposal of proposals) {
      const result = await createMemoryCandidate(
        {
          ...proposal,
          reason: proposal.reason ?? parsed.output.reason,
        },
        paths,
        { source: source === 'user' ? 'user' : 'workflow' },
      );
      if (result.ok && 'candidate' in result) candidates.push(result.candidate);
    }
    return {
      ok: true,
      action: 'memory_curate',
      changed: candidates.length > 0,
      mode,
      proposals,
      candidates,
      message:
        candidates.length > 0
          ? `Created ${candidates.length} memory curation candidate${candidates.length === 1 ? '' : 's'}.`
          : 'No memory curation candidates were needed.',
    };
  }

  const applied = [];
  for (const proposal of proposals) {
    if (proposal.action !== 'archive') continue;
    const memoryId = patchString(proposal.patch as JsonValue, 'memoryId');
    if (!memoryId) continue;
    const result = await archiveMemory(
      {
        id: memoryId,
        actor: 'workflow',
        reason: proposal.reason ?? parsed.output.reason,
      },
      paths,
      { source: source === 'user' ? 'user' : 'workflow' },
    );
    if (result.changed) applied.push(result);
  }

  return {
    ok: true,
    action: 'memory_curate',
    changed: applied.length > 0,
    mode,
    proposals,
    applied,
    message:
      applied.length > 0
        ? `Applied ${applied.length} safe memory curation action${applied.length === 1 ? '' : 's'}.`
        : 'No safe automatic memory curation actions were needed.',
  };
}

export function memoryInstructionsSync(
  paths = runtimePaths(),
  options: { repoId?: string | null } = {},
) {
  try {
    const snapshot = buildMemoryPromptSnapshotSync(paths, options);
    return snapshot.instructions;
  } catch {
    return 'Structured memory: unavailable for this session.';
  }
}

export function buildMemoryPromptSnapshotSync(
  paths = runtimePaths(),
  options: { repoId?: string | null } = {},
) {
  const database = new DatabaseSync(paths.neondeckDatabase, {
    readOnly: true,
  });

  try {
    const config = readLearningConfigSync(paths);
    const repoId = options.repoId ?? null;
    const memories = database
      .prepare(
        `
        SELECT *
        FROM memories
        WHERE status = 'active'
          AND scope IN ('user', 'local', 'project')
          AND (
            scope != 'project'
            OR repo_id IS NULL
            OR repo_id = ?
          )
        ORDER BY
          CASE scope
            WHEN 'user' THEN 0
            WHEN 'local' THEN 1
            WHEN 'project' THEN 2
            ELSE 3
          END,
          use_count DESC,
          updated_at DESC,
          key ASC
        LIMIT ?;
      `,
      )
      .all(repoId, config.memoryMaxActiveItems)
      .map(readMemoryRow);

    if (memories.length === 0) {
      return {
        memoryIds: [],
        instructions:
          'Structured memory: no active user, local, or project memories are currently loaded for this session.',
      };
    }

    const budgets = {
      total: config.memoryPromptBudgetChars,
      user: config.userMemoryBudgetChars,
      local: config.localMemoryBudgetChars,
      project: config.projectMemoryBudgetChars,
    };
    const selected: Array<MemoryRecord & { scope: ActiveMemoryScope }> = [];
    const usedByScope: Record<ActiveMemoryScope, number> = {
      user: 0,
      local: 0,
      project: 0,
    };
    let usedTotal = 0;

    for (const memory of memories) {
      if (!isActiveLearningMemory(memory)) continue;
      const line = memoryLine(memory);
      const length = line.length + 1;
      if (usedTotal + length > budgets.total) continue;
      if (usedByScope[memory.scope] + length > budgets[memory.scope]) continue;
      selected.push(memory);
      usedTotal += length;
      usedByScope[memory.scope] += length;
    }

    const byScope = new Map<ActiveMemoryScope, MemoryRecord[]>();
    for (const memory of selected) {
      byScope.set(memory.scope, [...(byScope.get(memory.scope) ?? []), memory]);
    }

    const lines = ['Structured memory loaded at session start:'];
    for (const scope of ['user', 'local', 'project'] as const) {
      const scoped = byScope.get(scope);
      if (!scoped?.length) continue;
      lines.push(`${scope}:`);
      for (const memory of scoped) {
        lines.push(memoryLine(memory));
      }
    }
    lines.push(
      `Loaded memory ids: ${selected.map((item) => item.id).join(', ')}`,
    );
    lines.push(
      'Memory updates during this session are durable immediately but do not change this loaded context until a new session or explicit context refresh.',
    );
    return {
      memoryIds: selected.map((memory) => memory.id),
      instructions: lines.join('\n'),
    };
  } finally {
    database.close();
  }
}

function failedMemoryMutation(
  action: string,
  message: string,
  requires?: string[],
) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    ...(requires ? { requires } : {}),
  };
}

function resolveMemory(
  database: DatabaseSync,
  input: v.InferOutput<typeof memoryIdentifierSchema>,
) {
  if (input.id) return readMemoryById(database, input.id);
  if (input.scope && input.key) {
    return readMemoryByScopeKey(
      database,
      input.scope,
      input.key,
      input.repoId ?? null,
    );
  }
  return undefined;
}

function readMemoryById(database: DatabaseSync, id: string) {
  const row = database
    .prepare(
      `
      SELECT *
      FROM memories
      WHERE id = ?;
    `,
    )
    .get(id);
  return row ? readMemoryRow(row) : undefined;
}

function readMemoryByScopeKey(
  database: DatabaseSync,
  scope: MemoryScope,
  key: string,
  repoId: string | null = null,
) {
  const row = database
    .prepare(
      `
      SELECT *
      FROM memories
      WHERE scope = ?
        AND key = ?
        AND COALESCE(repo_id, '') = COALESCE(?, '');
    `,
    )
    .get(scope, key, repoId);
  return row ? readMemoryRow(row) : undefined;
}

function recordMemoryEvent(
  database: DatabaseSync,
  input: {
    memoryId?: string | null;
    action: MemoryEventRecord['action'];
    actor: MemoryEventRecord['actor'];
    reason?: string | null;
    before?: JsonValue | null;
    after?: JsonValue | null;
    createdAt: string;
  },
) {
  database
    .prepare(
      `
      INSERT INTO memory_events (
        id,
        memory_id,
        action,
        actor,
        reason,
        before_json,
        after_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `,
    )
    .run(
      randomUUID(),
      input.memoryId ?? null,
      input.action,
      input.actor,
      input.reason ?? null,
      input.before === undefined || input.before === null
        ? null
        : JSON.stringify(input.before),
      input.after === undefined || input.after === null
        ? null
        : JSON.stringify(input.after),
      input.createdAt,
    );
}

function recordLearningEvent(
  database: DatabaseSync,
  input: {
    type: string;
    source: string;
    repoId?: string | null;
    sessionId?: string | null;
    data?: JsonValue | null;
    createdAt: string;
  },
) {
  database
    .prepare(
      `
      INSERT INTO learning_events (
        id,
        type,
        source,
        repo_id,
        session_id,
        data_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?);
    `,
    )
    .run(
      randomUUID(),
      input.type,
      input.source,
      input.repoId ?? null,
      input.sessionId ?? null,
      input.data === undefined || input.data === null
        ? null
        : JSON.stringify(input.data),
      input.createdAt,
    );
}

function insertMemoryCandidate(
  database: DatabaseSync,
  candidate: MemoryCandidateRecord,
) {
  database
    .prepare(
      `
      INSERT INTO learning_candidates (
        id,
        target,
        status,
        action,
        scope,
        key,
        value_json,
        repo_id,
        reason,
        review_id,
        patch_json,
        created_at,
        decided_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
    )
    .run(
      candidate.id,
      candidate.target,
      candidate.status,
      candidate.action,
      candidate.scope,
      candidate.key,
      candidate.value === null ? null : JSON.stringify(candidate.value),
      candidate.repoId,
      candidate.reason,
      candidate.reviewId,
      candidate.patch === null ? null : JSON.stringify(candidate.patch),
      candidate.createdAt,
      candidate.decidedAt,
    );
}

async function applyMemoryCandidate(
  candidate: MemoryCandidateRecord,
  paths: RuntimePaths,
  source: MemoryMutationSource,
) {
  if (candidate.action === 'upsert') {
    if (!candidate.scope || !candidate.key || candidate.value === null) {
      return failedMemoryMutation(
        'memory_candidate_apply',
        'Memory upsert candidate is missing scope, key, or value.',
      );
    }
    return upsertMemory(
      {
        scope: candidate.scope,
        key: candidate.key,
        value: candidate.value,
        repoId: candidate.repoId ?? undefined,
        reason: candidate.reason ?? undefined,
        actor: 'workflow',
      },
      paths,
      { source },
    );
  }

  if (candidate.action === 'rewrite') {
    const memoryId = patchString(candidate.patch, 'memoryId');
    if (!memoryId || candidate.value === null) {
      return failedMemoryMutation(
        'memory_candidate_apply',
        'Memory rewrite candidate is missing memory id or value.',
      );
    }
    return rewriteMemory(
      {
        id: memoryId,
        value: candidate.value,
        reason: candidate.reason ?? undefined,
        actor: 'workflow',
      },
      paths,
      { source },
    );
  }

  if (candidate.action === 'archive') {
    const memoryId = patchString(candidate.patch, 'memoryId');
    if (!memoryId) {
      return failedMemoryMutation(
        'memory_candidate_apply',
        'Memory archive candidate is missing memory id.',
      );
    }
    return archiveMemory(
      {
        id: memoryId,
        reason: candidate.reason ?? undefined,
        actor: 'workflow',
      },
      paths,
      { source },
    );
  }

  const targetId = patchString(candidate.patch, 'targetId');
  const sourceIds = patchStringArray(candidate.patch, 'sourceIds');
  if (!targetId || sourceIds.length === 0) {
    return failedMemoryMutation(
      'memory_candidate_apply',
      'Memory merge candidate is missing target or source ids.',
    );
  }
  return mergeMemories(
    {
      targetId,
      sourceIds,
      ...(candidate.value === null ? {} : { value: candidate.value }),
      reason: candidate.reason ?? undefined,
      actor: 'workflow',
    },
    paths,
    { source },
  );
}

async function memoryWritePolicyResult(
  paths: RuntimePaths,
  source: MemoryMutationSource,
) {
  if (source === 'user') return { ok: true as const };
  const config = await readRuntimeJson(paths.config, parseAppConfig)
    .then((value) => resolveLearningConfig(value))
    .catch(() => resolveLearningConfig());
  if (!config.enabled) {
    return {
      ok: false as const,
      result: failedMemoryMutation(
        'memory_upsert',
        'Learning is disabled; autonomous memory writes are blocked.',
        ['learning-enabled'],
      ),
    };
  }
  if (config.memoryWriteMode === 'off') {
    return {
      ok: false as const,
      result: failedMemoryMutation(
        'memory_upsert',
        'Memory write mode is off; autonomous memory writes are blocked.',
        ['memory-write-mode'],
      ),
    };
  }
  if (config.memoryWriteMode === 'review') {
    return {
      ok: false as const,
      result: failedMemoryMutation(
        'memory_upsert',
        'Memory write mode is review; create a memory candidate instead of mutating memory directly.',
        ['memory-candidate'],
      ),
    };
  }
  return { ok: true as const };
}

async function memoryCandidatePolicyResult(
  paths: RuntimePaths,
  source: MemoryMutationSource,
) {
  if (source === 'user') return { ok: true as const };
  const config = await readRuntimeJson(paths.config, parseAppConfig)
    .then((value) => resolveLearningConfig(value))
    .catch(() => resolveLearningConfig());
  if (!config.enabled) {
    return {
      ok: false as const,
      result: failedMemoryMutation(
        'memory_candidate_create',
        'Learning is disabled; autonomous memory candidates are blocked.',
        ['learning-enabled'],
      ),
    };
  }
  if (config.memoryWriteMode === 'off') {
    return {
      ok: false as const,
      result: failedMemoryMutation(
        'memory_candidate_create',
        'Memory write mode is off; autonomous memory candidates are blocked.',
        ['memory-write-mode'],
      ),
    };
  }
  return { ok: true as const };
}

function curationProposals(
  memories: MemoryRecord[],
  maxActiveItems: number,
): Array<v.InferInput<typeof memoryCandidateCreateInputSchema>> {
  const proposals: Array<
    v.InferInput<typeof memoryCandidateCreateInputSchema>
  > = [];
  const sortedOldest = [...memories].sort(
    (a, b) =>
      a.useCount - b.useCount ||
      Date.parse(a.updatedAt) - Date.parse(b.updatedAt),
  );
  const overflowCount = Math.max(0, sortedOldest.length - maxActiveItems);
  for (const memory of sortedOldest.slice(0, overflowCount)) {
    proposals.push({
      action: 'archive',
      scope: isActiveLearningMemory(memory) ? memory.scope : undefined,
      key: memory.key,
      reason: `Active memory count exceeds configured memoryMaxActiveItems (${maxActiveItems}).`,
      patch: { memoryId: memory.id },
    });
  }

  const byValue = new Map<string, MemoryRecord[]>();
  for (const memory of memories) {
    const key = `${memory.scope}:${memory.repoId ?? ''}:${memoryValuePreview(memory.value).toLowerCase()}`;
    byValue.set(key, [...(byValue.get(key) ?? []), memory]);
  }
  for (const group of byValue.values()) {
    if (group.length < 2) continue;
    const [target, ...sources] = group;
    if (!target) continue;
    proposals.push({
      action: 'merge',
      scope: isActiveLearningMemory(target) ? target.scope : undefined,
      key: target.key,
      value: target.value,
      repoId: target.repoId ?? undefined,
      reason: 'Multiple active memories contain duplicate guidance.',
      patch: {
        targetId: target.id,
        sourceIds: sources.map((source) => source.id),
      },
    });
  }

  return proposals;
}

function readMemoryRow(row: unknown): MemoryRecord {
  if (!row || typeof row !== 'object') {
    throw new Error('Memory row is missing.');
  }
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    scope: v.parse(allMemoryScopeSchema, record.scope),
    key: String(record.key),
    value: JSON.parse(String(record.value_json)) as JsonValue,
    repoId: typeof record.repo_id === 'string' ? record.repo_id : null,
    status:
      record.status === 'archived' || record.status === 'active'
        ? record.status
        : 'active',
    useCount: Number(record.use_count ?? 0),
    lastUsedAt:
      typeof record.last_used_at === 'string' ? record.last_used_at : null,
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
  };
}

function readMemoryEventRow(row: unknown): MemoryEventRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    memoryId: typeof record.memory_id === 'string' ? record.memory_id : null,
    action: v.parse(
      v.picklist([
        'created',
        'updated',
        'rewritten',
        'merged',
        'archived',
        'rejected',
      ]),
      record.action,
    ),
    actor: v.parse(memoryActorSchema, record.actor),
    reason: typeof record.reason === 'string' ? record.reason : null,
    before:
      typeof record.before_json === 'string'
        ? (JSON.parse(record.before_json) as JsonValue)
        : null,
    after:
      typeof record.after_json === 'string'
        ? (JSON.parse(record.after_json) as JsonValue)
        : null,
    createdAt: String(record.created_at),
  };
}

function readMemoryCandidateRow(row: unknown): MemoryCandidateRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    target: 'memory',
    status: v.parse(
      v.picklist(['proposed', 'applied', 'rejected', 'archived']),
      record.status,
    ),
    action: v.parse(memoryCandidateActionSchema, record.action),
    scope:
      typeof record.scope === 'string'
        ? v.parse(activeMemoryScopeSchema, record.scope)
        : null,
    key: typeof record.key === 'string' ? record.key : null,
    value:
      typeof record.value_json === 'string'
        ? (JSON.parse(record.value_json) as JsonValue)
        : null,
    repoId: typeof record.repo_id === 'string' ? record.repo_id : null,
    reason: typeof record.reason === 'string' ? record.reason : null,
    reviewId: typeof record.review_id === 'string' ? record.review_id : null,
    patch:
      typeof record.patch_json === 'string'
        ? (JSON.parse(record.patch_json) as JsonValue)
        : null,
    createdAt: String(record.created_at),
    decidedAt: typeof record.decided_at === 'string' ? record.decided_at : null,
  };
}

function memoryToJson(memory: MemoryRecord): JsonValue {
  return {
    id: memory.id,
    scope: memory.scope,
    key: memory.key,
    value: memory.value,
    repoId: memory.repoId,
    status: memory.status,
    useCount: memory.useCount,
    lastUsedAt: memory.lastUsedAt,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

function boundedRejectedAfter(input: {
  scope: ActiveMemoryScope;
  key: string;
  repoId?: string;
}): JsonValue {
  return {
    scope: input.scope,
    key: input.key,
    repoId: input.repoId ?? null,
    rejected: true,
  };
}

function boundedRejectedCandidateAfter(input: {
  action: v.InferOutput<typeof memoryCandidateActionSchema>;
  scope?: ActiveMemoryScope;
  key?: string;
  repoId?: string;
  reviewId?: string;
}): JsonValue {
  return {
    candidateAction: input.action,
    scope: input.scope ?? null,
    key: input.key ?? null,
    repoId: input.repoId ?? null,
    reviewId: input.reviewId ?? null,
    rejected: true,
  };
}


function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return Number.isFinite(value) || typeof value !== 'number';
  }

  if (Array.isArray(value)) return value.every(isJsonValue);

  if (typeof value === 'object') {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}

function isActiveLearningMemory(
  memory: MemoryRecord,
): memory is MemoryRecord & {
  scope: ActiveMemoryScope;
} {
  return (
    memory.status === 'active' &&
    (memory.scope === 'user' ||
      memory.scope === 'local' ||
      memory.scope === 'project')
  );
}

function memoryValuePreview(value: JsonValue) {
  const text = memoryValueText(value);
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function memoryValueText(value: JsonValue) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function memoryLine(memory: MemoryRecord) {
  const repo = memory.repoId ? ` (${memory.repoId})` : '';
  return `- ${memory.key}${repo}: ${memoryValuePreview(memory.value)}`;
}

function memoryRejectionReason(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/(api[_-]?key|token|secret|password)\s*[:=]/i.test(text)) {
    return 'Rejected memory because it appears to contain a secret or credential.';
  }
  if (
    /(ignore|override|bypass).{0,40}(previous|system|developer|instructions)/i.test(
      text,
    )
  ) {
    return 'Rejected memory because it resembles prompt-injection guidance.';
  }
  if (text.length > 8000) {
    return 'Rejected memory because it exceeds the bounded memory size limit.';
  }
  return null;
}

function patchString(value: JsonValue | null, key: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const item = (value as Record<string, unknown>)[key];
  return typeof item === 'string' ? item : undefined;
}

function patchStringArray(value: JsonValue | null, key: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  const item = (value as Record<string, unknown>)[key];
  return Array.isArray(item)
    ? item.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function readLearningConfigSync(paths: RuntimePaths) {
  try {
    return resolveLearningConfig(
      readRuntimeJsonSync(paths.config, parseAppConfig),
    );
  } catch {
    return resolveLearningConfig();
  }
}
