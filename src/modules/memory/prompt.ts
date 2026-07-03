import { DatabaseSync } from 'node:sqlite';
import { runtimePaths } from '../../runtime-home';
import type { ActiveMemoryScope, MemoryRecord } from './schemas';
import {
  isActiveLearningMemory,
  memoryLine,
  readLearningConfigSync,
  readMemoryRow,
} from './store';

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
