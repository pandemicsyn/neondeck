import { randomUUID } from 'node:crypto';
import type { PrWatch } from '../../watches';

export type AutopilotOwnerTurnSource = 'watch-event' | 'direct-human';

type PendingAutopilotTurn = {
  correlationId?: string;
  eventFingerprint?: string;
  learningMemoryAvailable: boolean;
  learningMemoryLoaded: boolean;
  learningMemoryIds: string[];
  learningMemoryText: string | null;
  mode: PrWatch['autopilotMode'];
  settling: boolean;
  source: AutopilotOwnerTurnSource;
  turnId: string;
};

const pendingTurns = new Map<string, PendingAutopilotTurn>();

function key(home: string, instanceId: string) {
  return `${home}\0${instanceId}`;
}

export function registerPendingAutopilotTurn(
  home: string,
  instanceId: string,
  eventFingerprint: string | undefined,
  mode: PrWatch['autopilotMode'],
  source: AutopilotOwnerTurnSource,
) {
  const pending = {
    eventFingerprint,
    learningMemoryAvailable: false,
    learningMemoryLoaded: false,
    learningMemoryIds: [],
    learningMemoryText: null,
    mode,
    settling: false,
    source,
    turnId: randomUUID(),
  };
  pendingTurns.set(key(home, instanceId), pending);
  return pending;
}

export function readPendingAutopilotTurn(home: string, instanceId: string) {
  return pendingTurns.get(key(home, instanceId));
}

export function recordPendingAutopilotTurnLearningMemoryContext(
  home: string,
  instanceId: string,
  turnId: string,
  learningMemoryIds: string[],
  learningMemoryText: string,
  learningMemoryAvailable: boolean,
) {
  const pending = readPendingAutopilotTurn(home, instanceId);
  if (!pending || pending.turnId !== turnId) return null;
  if (pending.learningMemoryLoaded) return pending;
  pending.learningMemoryAvailable = learningMemoryAvailable;
  pending.learningMemoryLoaded = true;
  pending.learningMemoryIds = [...new Set(learningMemoryIds)];
  pending.learningMemoryText = learningMemoryText;
  return pending;
}

export function recordPendingAutopilotTurnCorrelationId(
  home: string,
  instanceId: string,
  turnId: string,
  correlationId: string,
) {
  const pending = readPendingAutopilotTurn(home, instanceId);
  if (!pending || pending.turnId !== turnId || !correlationId) return null;
  pending.correlationId ??= correlationId;
  return pending;
}

export function claimPendingAutopilotTurnSettlement(
  home: string,
  instanceId: string,
) {
  const pending = readPendingAutopilotTurn(home, instanceId);
  if (!pending || pending.settling) return null;
  pending.settling = true;
  return pending;
}

export function clearPendingAutopilotTurn(home: string, instanceId: string) {
  pendingTurns.delete(key(home, instanceId));
}

export function clearPendingAutopilotTurnIfMatches(
  home: string,
  instanceId: string,
  turnId: string,
) {
  const pendingKey = key(home, instanceId);
  const pending = pendingTurns.get(pendingKey);
  if (!pending || pending.turnId !== turnId) return false;
  pendingTurns.delete(pendingKey);
  return true;
}

export function resetPendingAutopilotTurnsForTests() {
  pendingTurns.clear();
}
