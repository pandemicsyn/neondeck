import type { PrWatch } from '../../watches';

export type AutopilotOwnerTurnSource = 'watch-event' | 'direct-human';

type PendingAutopilotTurn = {
  eventFingerprint?: string;
  mode: PrWatch['autopilotMode'];
  source: AutopilotOwnerTurnSource;
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
  pendingTurns.set(key(home, instanceId), { eventFingerprint, mode, source });
}

export function readPendingAutopilotTurn(home: string, instanceId: string) {
  return pendingTurns.get(key(home, instanceId));
}

export function clearPendingAutopilotTurn(home: string, instanceId: string) {
  pendingTurns.delete(key(home, instanceId));
}

export function resetPendingAutopilotTurnsForTests() {
  pendingTurns.clear();
}
