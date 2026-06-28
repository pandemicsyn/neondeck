import { defineAction, type JsonValue } from '@flue/runtime';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

export type MemoryScope = 'user' | 'project' | 'session' | 'watch';

export type MemoryRecord = {
  id: string;
  scope: MemoryScope;
  key: string;
  value: JsonValue;
  createdAt: string;
  updatedAt: string;
};

const memoryScopeSchema = v.picklist(['user', 'project', 'session', 'watch']);
const memoryListInputSchema = v.object({
  scope: v.optional(memoryScopeSchema),
  key: v.optional(v.pipe(v.string(), v.minLength(1))),
});
const memoryUpsertInputSchema = v.object({
  scope: memoryScopeSchema,
  key: v.pipe(v.string(), v.minLength(1)),
  value: v.pipe(v.unknown(), v.check(isJsonValue, 'Value must be JSON-safe.')),
});
const memoryDeleteInputSchema = v.object({
  scope: memoryScopeSchema,
  key: v.pipe(v.string(), v.minLength(1)),
  confirm: v.optional(v.boolean()),
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
    'List durable Neondeck structured memories by optional scope and key.',
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

export const memoryUpsertAction = defineAction({
  name: 'neondeck_memory_upsert',
  description:
    'Create or update durable structured memory for user preferences, project/repo conventions, session notes, or watch notes.',
  input: memoryUpsertInputSchema,
  output: memoryActionOutputSchema,
  async run({ input }) {
    return upsertMemory(input);
  },
});

export const memoryDeleteAction = defineAction({
  name: 'neondeck_memory_delete',
  description:
    'Delete one durable Neondeck structured memory entry after explicit confirmation.',
  input: memoryDeleteInputSchema,
  output: memoryActionOutputSchema,
  async run({ input }) {
    return deleteMemory(input);
  },
});

export const neondeckMemoryActions = [
  memoryListAction,
  memoryUpsertAction,
  memoryDeleteAction,
];

export async function listMemories(
  input: v.InferInput<typeof memoryListInputSchema> = {},
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    const filters: string[] = [];
    const params: string[] = [];
    if (input.scope) {
      filters.push('scope = ?');
      params.push(input.scope);
    }
    if (input.key) {
      filters.push('key = ?');
      params.push(input.key);
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
  input: v.InferInput<typeof memoryUpsertInputSchema>,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryUpsertInputSchema, input);
  if (!parsed.success) {
    return failedMemoryMutation('memory_upsert', v.summarize(parsed.issues));
  }

  const now = new Date().toISOString();
  const value = asJsonValue(parsed.output.value);
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    const existing = database
      .prepare(
        `
        SELECT *
        FROM memories
        WHERE scope = ? AND key = ?;
      `,
      )
      .get(parsed.output.scope, parsed.output.key);
    const id =
      existing && typeof existing === 'object' && 'id' in existing
        ? String(existing.id)
        : randomUUID();

    database
      .prepare(
        `
        INSERT INTO memories (
          id,
          scope,
          key,
          value_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at;
      `,
      )
      .run(
        id,
        parsed.output.scope,
        parsed.output.key,
        JSON.stringify(value),
        now,
        now,
      );
    recordMemoryEvent(
      database,
      'upsert',
      parsed.output.scope,
      parsed.output.key,
      now,
    );

    const memory = database
      .prepare(
        `
        SELECT *
        FROM memories
        WHERE scope = ? AND key = ?;
      `,
      )
      .get(parsed.output.scope, parsed.output.key);

    return {
      ok: true,
      action: 'memory_upsert',
      changed: true,
      memory: readMemoryRow(memory),
      appliesAfter: 'new-session',
      message:
        'Updated durable memory. Active agent context will pick this up on a new session.',
    };
  } finally {
    database.close();
  }
}

export async function deleteMemory(
  input: v.InferInput<typeof memoryDeleteInputSchema>,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryDeleteInputSchema, input);
  if (!parsed.success) {
    return failedMemoryMutation('memory_delete', v.summarize(parsed.issues));
  }

  if (parsed.output.confirm !== true) {
    return {
      ok: false,
      action: 'memory_delete',
      changed: false,
      requires: ['confirm'],
      message: `Deleting memory "${parsed.output.scope}:${parsed.output.key}" requires confirmation.`,
    };
  }

  const database = new DatabaseSync(paths.neondeckDatabase);
  const now = new Date().toISOString();

  try {
    const result = database
      .prepare(
        `
        DELETE FROM memories
        WHERE scope = ? AND key = ?;
      `,
      )
      .run(parsed.output.scope, parsed.output.key);
    if (result.changes > 0) {
      recordMemoryEvent(
        database,
        'delete',
        parsed.output.scope,
        parsed.output.key,
        now,
      );
    }

    return {
      ok: true,
      action: 'memory_delete',
      changed: result.changes > 0,
      appliesAfter: 'new-session',
      message:
        result.changes > 0
          ? 'Deleted durable memory. Active agent context will pick this up on a new session.'
          : 'No matching memory entry existed.',
    };
  } finally {
    database.close();
  }
}

export function memoryInstructionsSync(paths = runtimePaths()) {
  try {
    const database = new DatabaseSync(paths.neondeckDatabase, {
      readOnly: true,
    });

    try {
      const memories = database
        .prepare(
          `
          SELECT *
          FROM memories
          ORDER BY scope ASC, updated_at DESC, key ASC
          LIMIT 40;
        `,
        )
        .all()
        .map(readMemoryRow);

      if (memories.length === 0) {
        return 'Structured memory: no durable memories are currently loaded for this session.';
      }

      const byScope = new Map<MemoryScope, MemoryRecord[]>();
      for (const memory of memories) {
        byScope.set(memory.scope, [
          ...(byScope.get(memory.scope) ?? []),
          memory,
        ]);
      }

      const lines = ['Structured memory loaded at session start:'];
      for (const scope of ['user', 'project', 'session', 'watch'] as const) {
        const scoped = byScope.get(scope);
        if (!scoped?.length) continue;
        lines.push(`${scope}:`);
        for (const memory of scoped.slice(0, 10)) {
          lines.push(`- ${memory.key}: ${memoryValuePreview(memory.value)}`);
        }
      }
      lines.push(
        'Memory updates during this session are durable immediately but do not change this loaded context until a new session.',
      );
      return lines.join('\n');
    } finally {
      database.close();
    }
  } catch {
    return 'Structured memory: unavailable for this session.';
  }
}

function failedMemoryMutation(action: string, message: string) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
  };
}

function recordMemoryEvent(
  database: DatabaseSync,
  action: 'upsert' | 'delete',
  scope: MemoryScope,
  key: string,
  changedAt: string,
) {
  database
    .prepare(
      `
      INSERT INTO memory_events (
        action,
        scope,
        key,
        changed_at
      )
      VALUES (?, ?, ?, ?);
    `,
    )
    .run(action, scope, key, changedAt);
}

function readMemoryRow(row: unknown): MemoryRecord {
  if (!row || typeof row !== 'object') {
    throw new Error('Memory row is missing.');
  }
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    scope: v.parse(memoryScopeSchema, record.scope),
    key: String(record.key),
    value: JSON.parse(String(record.value_json)) as JsonValue,
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
  };
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
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

function memoryValuePreview(value: JsonValue) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}
