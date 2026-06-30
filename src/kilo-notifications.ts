import { type JsonValue } from '@flue/runtime';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import {
  addNotification,
  resolveNotification,
  type NotificationLevel,
  type NotificationRecord,
} from './app-state';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from './runtime-home';

export type KiloNotificationState =
  | 'started'
  | 'progress'
  | 'waiting-approval'
  | 'completed'
  | 'failed'
  | 'timed-out'
  | 'needs-review'
  | 'verified'
  | 'promote-blocked'
  | 'promoted';

export type KiloNotificationFact = Pick<
  NotificationRecord,
  | 'id'
  | 'level'
  | 'title'
  | 'message'
  | 'readAt'
  | 'resolvedAt'
  | 'occurrenceCount'
  | 'updatedAt'
> & {
  taskId: string;
  state: KiloNotificationState;
};

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));

const kiloNotificationInputSchema = v.object({
  taskId: nonEmptyStringSchema,
  state: v.picklist([
    'started',
    'progress',
    'waiting-approval',
    'completed',
    'failed',
    'timed-out',
    'needs-review',
    'verified',
    'promote-blocked',
    'promoted',
  ]),
  title: v.optional(nonEmptyStringSchema),
  message: nonEmptyStringSchema,
  repoId: v.optional(v.nullable(v.string())),
  repoFullName: v.optional(v.nullable(v.string())),
  worktreeId: v.optional(v.nullable(v.string())),
  sessionId: v.optional(v.nullable(v.string())),
  preparedDiffId: v.optional(v.nullable(v.string())),
  workflow: v.optional(v.nullable(v.string())),
  pendingApprovals: v.optional(v.array(v.unknown())),
  data: v.optional(v.unknown()),
});

const notificationRowSchema = v.object({
  id: v.string(),
  level: v.picklist(['info', 'ready', 'attention', 'urgent']),
  title: v.string(),
  message: v.string(),
  source_id: v.string(),
  read_at: v.nullable(v.string()),
  resolved_at: v.nullable(v.string()),
  occurrence_count: v.number(),
  updated_at: v.string(),
});

type KiloNotificationInput = v.InferOutput<typeof kiloNotificationInputSchema>;

export async function notifyKiloState(
  rawInput: KiloNotificationInput,
  paths: RuntimePaths = runtimePaths(),
) {
  const input = v.parse(kiloNotificationInputSchema, rawInput);
  if (
    ['started', 'progress'].includes(input.state) &&
    (await hasActiveTerminalNotification(input.taskId, paths))
  ) {
    return null;
  }
  if (!['started', 'progress'].includes(input.state)) {
    await resolveKiloNotifications(
      input.taskId,
      ['started', 'progress'],
      paths,
    );
  }
  return addNotification(
    {
      level: levelForKiloState(input.state),
      title: input.title ?? titleForKiloState(input.state),
      message: input.message,
      source: 'kilo',
      sourceId: sourceIdForKiloState(input.taskId, input.state),
      data: {
        policy: 'kilo-v1',
        taskId: input.taskId,
        state: input.state,
        repoId: input.repoId ?? null,
        repoFullName: input.repoFullName ?? null,
        worktreeId: input.worktreeId ?? null,
        sessionId: input.sessionId ?? null,
        preparedDiffId: input.preparedDiffId ?? null,
        workflow: input.workflow ?? null,
        pendingApprovals: input.pendingApprovals ?? [],
        details: input.data === undefined ? null : asJsonValue(input.data),
      },
    },
    paths,
  );
}

export async function listKiloNotificationFacts(
  taskIds: string[],
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const ids = [...new Set(taskIds)].filter(Boolean);
  if (ids.length === 0) return new Map<string, KiloNotificationFact[]>();
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  const facts = new Map<string, KiloNotificationFact[]>(
    ids.map((id) => [id, []]),
  );
  try {
    const sourceIds = ids.flatMap((id) =>
      kiloNotificationStates.map((state) => sourceIdForKiloState(id, state)),
    );
    const rows = chunk(sourceIds).flatMap((sourceIdChunk) => {
      const placeholders = sourceIdChunk.map(() => '?').join(', ');
      return database
        .prepare(
          `
          SELECT id, level, title, message, source_id, read_at, resolved_at,
                 occurrence_count, updated_at
          FROM notifications
          WHERE source = 'kilo'
            AND resolved_at IS NULL
            AND source_id IN (${placeholders})
          ORDER BY updated_at DESC;
        `,
        )
        .all(...sourceIdChunk);
    });
    for (const row of rows) {
      const fact = readNotificationFact(row);
      const bucket = facts.get(fact.taskId);
      if (bucket) bucket.push(fact);
    }
    return facts;
  } finally {
    database.close();
  }
}

export async function readKiloNotificationFacts(
  taskId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  const facts = await listKiloNotificationFacts([taskId], paths);
  return facts.get(taskId) ?? [];
}

export async function resolveKiloNotifications(
  taskId: string,
  states: KiloNotificationState[] = kiloNotificationStates,
  paths: RuntimePaths = runtimePaths(),
) {
  const facts = (await readKiloNotificationFacts(taskId, paths)).filter(
    (fact) => states.includes(fact.state),
  );
  await Promise.all(facts.map((fact) => resolveNotification(fact.id, paths)));
  return facts.length;
}

const kiloNotificationStates: KiloNotificationState[] = [
  'started',
  'progress',
  'waiting-approval',
  'completed',
  'failed',
  'timed-out',
  'needs-review',
  'verified',
  'promote-blocked',
  'promoted',
];

const terminalNotificationStates: KiloNotificationState[] = [
  'completed',
  'failed',
  'timed-out',
  'needs-review',
  'waiting-approval',
  'verified',
  'promote-blocked',
  'promoted',
];

const notificationSourceIdChunkSize = 800;

function sourceIdForKiloState(taskId: string, state: KiloNotificationState) {
  return `task:${taskId}:${state}`;
}

async function hasActiveTerminalNotification(
  taskId: string,
  paths: RuntimePaths,
) {
  const facts = await readKiloNotificationFacts(taskId, paths);
  return facts.some((fact) => terminalNotificationStates.includes(fact.state));
}

function chunk<T>(items: T[], size = notificationSourceIdChunkSize) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function levelForKiloState(state: KiloNotificationState): NotificationLevel {
  if (state === 'completed' || state === 'verified' || state === 'promoted') {
    return 'ready';
  }
  if (state === 'started' || state === 'progress') return 'info';
  return 'attention';
}

function titleForKiloState(state: KiloNotificationState) {
  if (state === 'started') return 'Kilo handoff started';
  if (state === 'progress') return 'Kilo handoff progress';
  if (state === 'waiting-approval') return 'Kilo handoff waiting for approval';
  if (state === 'completed') return 'Kilo handoff completed';
  if (state === 'failed') return 'Kilo handoff failed';
  if (state === 'timed-out') return 'Kilo handoff timed out';
  if (state === 'needs-review') return 'Kilo result needs review';
  if (state === 'verified') return 'Kilo result verified';
  if (state === 'promote-blocked') return 'Kilo promotion blocked';
  return 'Kilo result promoted';
}

function readNotificationFact(row: unknown): KiloNotificationFact {
  const parsed = v.parse(notificationRowSchema, row);
  const parts = parsed.source_id.split(':');
  const taskId = parts[1] ?? '';
  const state = v.parse(
    v.picklist(kiloNotificationStates),
    parts[2] ?? 'progress',
  );
  return {
    id: parsed.id,
    taskId,
    state,
    level: parsed.level,
    title: parsed.title,
    message: parsed.message,
    readAt: parsed.read_at,
    resolvedAt: parsed.resolved_at,
    occurrenceCount: parsed.occurrence_count,
    updatedAt: parsed.updated_at,
  };
}

function asJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(asJsonValue);
  if (typeof value === 'object' && value) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, asJsonValue(entry)]),
    );
  }
  return null;
}
