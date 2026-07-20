import type { JsonValue } from '@flue/runtime';

export type AutopilotOwnerEnvelope = {
  schema: 'neondeck.autopilot-owner-envelope.v1';
  watchId: string;
  repoId: string;
  repoFullName: string;
  prNumber: number;
  worktreeId: string;
  worktreePath: string;
  headSha: string;
  baseSha: string;
  eventFingerprint: string;
  mode: string;
  facts: JsonValue;
  availableCapabilities: string[];
};

/**
 * Builds the transport envelope for a continuing PR owner without persisting a
 * grounding snapshot, cursor, generation, lease, or queue record.
 */
export function buildAutopilotOwnerEnvelope(
  input: Omit<AutopilotOwnerEnvelope, 'schema'>,
): AutopilotOwnerEnvelope {
  return {
    schema: 'neondeck.autopilot-owner-envelope.v1',
    ...input,
    availableCapabilities: [...input.availableCapabilities],
  };
}
export function serializeAutopilotOwnerEnvelope(
  envelope: AutopilotOwnerEnvelope,
) {
  return JSON.stringify(envelope);
}
