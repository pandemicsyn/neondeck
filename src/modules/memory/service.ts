import { asJsonValue } from '../../lib/action-result';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import type { MemoryMutationSource, MemoryRecord } from './schemas';
import {
  memoryArchiveInputSchema,
  memoryEventsInputSchema,
  memoryLearnInputSchema,
  memoryListInputSchema,
  memoryMarkUsedInputSchema,
  memoryMergeInputSchema,
  memoryRewriteInputSchema,
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
  readMemoryRow,
  recordLearningEvent,
  recordMemoryEvent,
  resolveMemory,
} from './store';

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
