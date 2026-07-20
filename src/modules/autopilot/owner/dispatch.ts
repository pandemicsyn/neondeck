import { dispatch, type DispatchReceipt } from '@flue/runtime';
import {
  serializeAutopilotOwnerEnvelope,
  type AutopilotOwnerEnvelope,
} from './envelope';

export type AutopilotOwnerDispatcher = (request: {
  agent: 'pr-autopilot-owner';
  id: string;
  input: string;
}) => Promise<DispatchReceipt>;

/**
 * Thin stable-instance Flue dispatch seam. PR 1 deliberately leaves it
 * disconnected from watch polling; the minimal loop will decide when and with
 * which capabilities to call it.
 */
export function dispatchAutopilotOwnerTurn(input: {
  instanceId: string;
  envelope: AutopilotOwnerEnvelope;
  dispatchOwner?: AutopilotOwnerDispatcher;
}) {
  const instanceId = input.instanceId.trim();
  if (!instanceId) throw new Error('Autopilot owner instance id is required.');
  return (input.dispatchOwner ?? dispatch)({
    agent: 'pr-autopilot-owner',
    id: instanceId,
    input: serializeAutopilotOwnerEnvelope(input.envelope),
  });
}
