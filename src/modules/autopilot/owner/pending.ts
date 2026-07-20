import type { PrWatch } from '../../watches';

type PendingAutopilotTurn = {
  eventFingerprint: string;
  mode: PrWatch['autopilotMode'];
};

const pendingTurns = new Map<string, PendingAutopilotTurn>();

function key(home: string, instanceId: string) {
  return `${home}\0${instanceId}`;
}

export function registerPendingAutopilotTurn(
  home: string,
  instanceId: string,
  eventFingerprint: string,
  mode: PrWatch['autopilotMode'],
) {
  pendingTurns.set(key(home, instanceId), { eventFingerprint, mode });
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
