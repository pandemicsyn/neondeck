import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { readStaleReasonChanges } from '../../sessions';
import type { AutopilotPrOwner } from '../coordination/schemas';

const inPlaceConfigActions = new Set([
  'config_update_execution_policy',
  'config_update_learning',
  'config_update_worktree_policy',
]);
const irrelevantConfigActions = new Set([
  'briefing_profile_update',
  'config_apply_dashboard_preset',
  'config_update_dashboard_layout',
  'config_update_handoff',
]);

export type OwnerDriftDecision = {
  kind: 'initial' | 'none' | 'reground' | 'rotate' | 'block';
  reasons: string[];
  configHistoryId: number;
  memoryEventAt: string | null;
  memoryEventId: string | null;
  memoryEventSequence: number;
  memoryIds: string[];
  staleReasons: ReturnType<typeof readStaleReasonChanges>['reasons'];
};

export function classifyAutopilotOwnerDrift(
  database: DatabaseSync,
  input: { owner: AutopilotPrOwner; selectedMemoryIds: string[] },
): OwnerDriftDecision {
  const selectedMemoryIds = [...new Set(input.selectedMemoryIds)].sort();
  const changes = readStaleReasonChanges(database, {
    configHistoryId: input.owner.groundingConfigHistoryId,
    memoryEventAt: input.owner.groundingMemoryEventAt,
    memoryEventId: input.owner.groundingMemoryEventId,
    memoryEventSequence: input.owner.groundingMemoryEventSequence,
    contextMemoryIds: [
      ...new Set([...input.owner.groundingMemoryIds, ...selectedMemoryIds]),
    ],
  });
  const initial = !input.owner.flueInstanceId;
  if (initial) {
    return decision(
      'initial',
      ['initial-grounding'],
      changes,
      selectedMemoryIds,
    );
  }

  const reasons: string[] = [];
  let kind: OwnerDriftDecision['kind'] = 'none';
  for (const change of changes.configChanges) {
    const classification = classifyAutopilotOwnerConfigChange(
      change,
      input.owner.repoId,
    );
    kind = strongerDrift(kind, classification);
    if (classification !== 'none') {
      reasons.push(
        `${classification === 'block' && !isKnownBlockingChange(change, input.owner.repoId) ? 'unknown:' : ''}${change.action}:${change.target ?? 'general'}`,
      );
    }
  }
  if (
    changes.memoryChanges.length > 0 ||
    !sameIds(input.owner.groundingMemoryIds, selectedMemoryIds)
  ) {
    if (kind === 'none') kind = 'reground';
    reasons.push(
      ...changes.memoryChanges.map(
        (change) => `memory:${change.memoryId ?? change.target ?? change.id}`,
      ),
    );
    if (!sameIds(input.owner.groundingMemoryIds, selectedMemoryIds)) {
      reasons.push(`selected-memory:${selectedMemoryIds.join(',') || 'none'}`);
    }
  }
  return decision(kind, reasons, changes, selectedMemoryIds);
}

export function classifyAutopilotOwnerConfigChange(
  change: { action: string; target: string | null },
  repoId: string,
): 'none' | 'reground' | 'rotate' | 'block' {
  if (
    change.action.includes('agent_models') ||
    change.action.includes('provider') ||
    change.action.includes('skill') ||
    change.action.includes('soul') ||
    change.target === 'models' ||
    change.target === 'skillRoots' ||
    change.target?.startsWith('providers.') ||
    change.target === 'soul'
  ) {
    return 'rotate';
  }
  if (change.action === 'config_update_repo_autopilot_policy') {
    return change.target === repoId ? 'reground' : 'none';
  }
  if (
    change.action === 'config_add_repo' ||
    change.action === 'config_update_repo' ||
    change.action === 'config_remove_repo'
  ) {
    return change.target === repoId ? 'block' : 'none';
  }
  if (irrelevantConfigActions.has(change.action)) return 'none';
  if (inPlaceConfigActions.has(change.action)) return 'reground';
  return 'block';
}

export function stableJsonHash(value: unknown) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function decision(
  kind: OwnerDriftDecision['kind'],
  reasons: string[],
  changes: ReturnType<typeof readStaleReasonChanges>,
  memoryIds: string[],
): OwnerDriftDecision {
  return {
    kind,
    reasons,
    configHistoryId: changes.configHighWaterId,
    memoryEventAt: changes.memoryHighWaterAt,
    memoryEventId: changes.memoryHighWaterId,
    memoryEventSequence: changes.memoryHighWaterSequence,
    memoryIds,
    staleReasons: changes.reasons,
  };
}

function sameIds(left: string[], right: string[]) {
  return [...left].sort().join('\0') === [...right].sort().join('\0');
}

function strongerDrift(
  current: OwnerDriftDecision['kind'],
  next: 'none' | 'reground' | 'rotate' | 'block',
): OwnerDriftDecision['kind'] {
  const rank = { initial: 0, none: 0, reground: 1, rotate: 2, block: 3 };
  return rank[next] > rank[current] ? next : current;
}

function isKnownBlockingChange(
  change: { action: string; target: string | null },
  repoId: string,
) {
  return (
    ['config_add_repo', 'config_update_repo', 'config_remove_repo'].includes(
      change.action,
    ) && change.target === repoId
  );
}
