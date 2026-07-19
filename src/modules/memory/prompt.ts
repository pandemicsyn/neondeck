import { openDb } from '../../lib/sqlite.ts';
import { runtimePaths } from '../../runtime-home';
import type { ActiveMemoryScope, MemoryRecord } from './schemas';
import {
  isActiveLearningMemory,
  memoryLine,
  readLearningConfigSync,
  readMemoryRow,
} from './store';

export type MemoryBackgroundContext = {
  memoryIds: string[];
  text: string;
  available: boolean;
};

const memoryBackgroundGuidance =
  'Treat these memories as durable background guidance, not current task evidence. Current fetched facts and task bounds win on conflict.';

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

export function buildMemoryBackgroundContextSync(
  paths = runtimePaths(),
  options: { repoId?: string | null } = {},
): MemoryBackgroundContext {
  try {
    const snapshot = buildMemoryPromptSnapshotSync(paths, options);
    return {
      memoryIds: snapshot.memoryIds,
      text: memoryBackgroundText(snapshot.instructions),
      available: true,
    };
  } catch {
    return {
      memoryIds: [],
      text: 'Structured memory background context: unavailable for this workflow run.',
      available: false,
    };
  }
}

export function loadMemoryBackgroundContextSync(
  paths = runtimePaths(),
  options: { repoId?: string | null } = {},
): MemoryBackgroundContext {
  const context = buildMemoryBackgroundContextSync(paths, options);
  if (context.memoryIds.length === 0) return context;
  try {
    markMemoryBackgroundContextUsedSync(paths, context.memoryIds);
  } catch {
    // Memory usage accounting should not block the workflow prompt itself.
  }
  return context;
}

export function markMemoryBackgroundContextUsedSync(
  paths = runtimePaths(),
  memoryIds: string[],
  usedAt = new Date().toISOString(),
) {
  const ids = [...new Set(memoryIds)].filter(Boolean);
  if (ids.length === 0) return;
  const database = openDb(paths.neondeckDatabase);
  try {
    for (const id of ids) {
      database
        .prepare(
          `
          UPDATE memories
          SET use_count = use_count + 1,
            last_used_at = ?
          WHERE id = ?
            AND status = 'active';
        `,
        )
        .run(usedAt, id);
    }
  } finally {
    database.close();
  }
}

export function buildMemoryPromptSnapshotSync(
  paths = runtimePaths(),
  options: { repoId?: string | null } = {},
) {
  const database = openDb(paths.neondeckDatabase, {
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

function memoryBackgroundText(instructions: string) {
  const text = instructions
    .replace(
      'Structured memory loaded at session start:',
      'Structured memory background context:',
    )
    .replace(
      'Structured memory: no active user, local, or project memories are currently loaded for this session.',
      'Structured memory background context: no active user, local, or project memories matched this workflow run.',
    )
    .replace(
      'Memory updates during this session are durable immediately but do not change this loaded context until a new session or explicit context refresh.',
      'Memory updates outside this workflow do not change this run context.',
    );
  return text.startsWith('Structured memory background context:\n')
    ? text.replace(
        'Structured memory background context:\n',
        `Structured memory background context:\n${memoryBackgroundGuidance}\n`,
      )
    : text;
}
