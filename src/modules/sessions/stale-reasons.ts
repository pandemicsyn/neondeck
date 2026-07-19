import type { DatabaseSync } from 'node:sqlite';
import type { NeonSessionStaleReason } from './schemas';

export type ConfigHistoryChange = {
  id: number;
  action: string;
  target: string | null;
  changedAt: string;
};

export type MemoryEventChange = {
  rowId: number;
  id: string;
  memoryId: string | null;
  action: string;
  createdAt: string;
  target: string | null;
};

export type StaleReasonCursor = {
  configHistoryId?: number;
  activatedAt?: string;
  memoryEventAt?: string | null;
  memoryEventId?: string | null;
  memoryEventRowId?: number;
  contextMemoryIds?: string[];
  ignoredConfigActions?: string[];
};

/**
 * Reads every config and relevant memory row after an explicit baseline. The
 * detailed rows are intentionally retained for durable-agent drift decisions;
 * callers may collapse the human-facing reasons without losing audit facts.
 */
export function readStaleReasonChanges(
  database: DatabaseSync,
  cursor: StaleReasonCursor,
) {
  const ignoredConfigActions = [...new Set(cursor.ignoredConfigActions ?? [])];
  const ignoredConfigClause = ignoredConfigActions.length
    ? `AND action NOT IN (${ignoredConfigActions.map(() => '?').join(', ')})`
    : '';
  const configChanges = database
    .prepare(
      cursor.configHistoryId !== undefined
        ? `SELECT id, action, target, changed_at FROM config_history
           WHERE id > ? ${ignoredConfigClause} ORDER BY id ASC;`
        : `SELECT id, action, target, changed_at FROM config_history
           WHERE changed_at > ? ${ignoredConfigClause}
           ORDER BY changed_at ASC, id ASC;`,
    )
    .all(
      cursor.configHistoryId ?? cursor.activatedAt ?? '',
      ...ignoredConfigActions,
    )
    .map(readConfigChange);

  const memoryIds = [...new Set(cursor.contextMemoryIds ?? [])];
  const memoryPredicate = memoryIds.length
    ? `AND memory_id IN (${memoryIds.map(() => '?').join(', ')})`
    : '';
  const memoryChanges = database
    .prepare(
      cursor.memoryEventRowId !== undefined
        ? `SELECT rowid AS event_rowid, id, memory_id, action, before_json, after_json, created_at
           FROM memory_events WHERE rowid > ? ${memoryPredicate}
           ORDER BY rowid ASC;`
        : `SELECT rowid AS event_rowid, id, memory_id, action, before_json, after_json, created_at
           FROM memory_events
           WHERE (created_at > ? OR (created_at = ? AND id > ?)) ${memoryPredicate}
           ORDER BY created_at ASC, id ASC;`,
    )
    .all(
      ...(cursor.memoryEventRowId !== undefined
        ? [cursor.memoryEventRowId]
        : [
            cursor.memoryEventAt ?? cursor.activatedAt ?? '',
            cursor.memoryEventAt ?? cursor.activatedAt ?? '',
            cursor.memoryEventId ?? '',
          ]),
      ...memoryIds,
    )
    .map(readMemoryChange);

  const reasons = [
    ...configChanges.map(configStaleReason),
    ...memoryChanges.map(memoryStaleReason),
  ].sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt));
  const lastMemory = memoryChanges.at(-1);
  return {
    reasons,
    configChanges,
    memoryChanges,
    configHighWaterId: configChanges.at(-1)?.id ?? cursor.configHistoryId ?? 0,
    memoryHighWaterAt: lastMemory?.createdAt ?? cursor.memoryEventAt ?? null,
    memoryHighWaterId: lastMemory?.id ?? cursor.memoryEventId ?? null,
    memoryHighWaterRowId: lastMemory?.rowId ?? cursor.memoryEventRowId ?? 0,
  };
}

export function staleReasonType(
  action: string,
  target: string | null,
): NeonSessionStaleReason['type'] {
  if (target === 'models' || action.includes('agent_models')) return 'model';
  if (target?.startsWith('providers.') || action.includes('provider')) {
    return 'provider';
  }
  if (target === 'skillRoots' || action.includes('skill')) return 'skill';
  if (
    action === 'config_add_repo' ||
    action === 'config_update_repo' ||
    action === 'config_update_repo_autopilot_policy' ||
    action === 'config_remove_repo'
  ) {
    return 'repo';
  }
  if (target === 'soul' || action.includes('soul')) return 'soul';
  return 'config';
}

function readConfigChange(row: unknown): ConfigHistoryChange {
  const value = row as Record<string, unknown>;
  return {
    id: Number(value.id),
    action: String(value.action),
    target: typeof value.target === 'string' ? value.target : null,
    changedAt: String(value.changed_at),
  };
}

function readMemoryChange(row: unknown): MemoryEventChange {
  const value = row as Record<string, unknown>;
  return {
    rowId: Number(value.event_rowid),
    id: String(value.id),
    memoryId: typeof value.memory_id === 'string' ? value.memory_id : null,
    action: String(value.action),
    createdAt: String(value.created_at),
    target: memoryEventTarget(value.after_json, value.before_json),
  };
}

function configStaleReason(
  change: ConfigHistoryChange,
): NeonSessionStaleReason {
  const type = staleReasonType(change.action, change.target);
  return {
    type,
    message: `${staleReasonLabel(type, change.target)} changed after the context baseline.`,
    changedAt: change.changedAt,
    target: change.target,
  };
}

function memoryStaleReason(change: MemoryEventChange): NeonSessionStaleReason {
  return {
    type: 'memory',
    message: `Memory ${change.target ?? 'unknown'} ${change.action} after the context baseline.`,
    changedAt: change.createdAt,
    target: change.target ?? change.memoryId,
  };
}

function staleReasonLabel(
  type: NeonSessionStaleReason['type'],
  target: string | null,
) {
  if (type === 'model') return 'Model configuration';
  if (type === 'provider') return 'Provider configuration';
  if (type === 'repo') return 'Repository configuration';
  if (type === 'skill') return 'Runtime skill configuration';
  if (type === 'soul') return 'SOUL context';
  if (type === 'memory') return 'Memory';
  return target ?? 'Runtime config';
}

function memoryEventTarget(afterJson: unknown, beforeJson: unknown) {
  const snapshot =
    parseMemoryEventSnapshot(afterJson) ?? parseMemoryEventSnapshot(beforeJson);
  return snapshot ? `${snapshot.scope}:${snapshot.key}` : null;
}

function parseMemoryEventSnapshot(value: unknown) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null;
    const record = parsed as Record<string, unknown>;
    return typeof record.scope === 'string' && typeof record.key === 'string'
      ? { scope: record.scope, key: record.key }
      : null;
  } catch {
    return null;
  }
}
