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
  if (input.dispatchOwner) {
    return input.dispatchOwner({
      agent: 'pr-autopilot-owner',
      id: instanceId,
      input: serializeAutopilotOwnerEnvelope(input.envelope),
    });
  }
  return dispatchOwnerAgent({
    id: instanceId,
    message: {
      kind: 'signal',
      type: 'neondeck.autopilot.watch-event',
      tagName: 'autopilot-watch-event',
      body: serializeAutopilotOwnerEnvelope(input.envelope),
      attributes: {
        watchId: input.envelope.watchId,
        repoId: input.envelope.repoId,
        prNumber: String(input.envelope.prNumber),
        eventFingerprint: input.envelope.eventFingerprint,
        mode: input.envelope.mode,
        headSha: input.envelope.headSha,
      },
    },
  });
}

export async function dispatchAutopilotOwnerMessage(request: {
  agent: 'pr-autopilot-owner';
  id: string;
  input: string;
}) {
  return dispatchOwnerAgent({ id: request.id, message: request.input });
}

async function dispatchOwnerAgent(request: {
  id: string;
  message: Parameters<typeof dispatch>[1]['message'];
}) {
  const { PrAutopilotOwner } =
    await import('../../../agents/pr-autopilot-owner');
  return dispatch(PrAutopilotOwner, request);
}
