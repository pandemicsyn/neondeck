import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';

export const autopilotOwnerInitialDataSchema = v.object({
  schema: v.literal('neondeck.autopilot-owner-instance.v2'),
  watchId: v.string(),
});

export type AutopilotOwnerInitialData = v.InferOutput<
  typeof autopilotOwnerInitialDataSchema
>;

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

export function autopilotOwnerInitialData(
  envelope: AutopilotOwnerEnvelope,
): AutopilotOwnerInitialData {
  return {
    schema: 'neondeck.autopilot-owner-instance.v2',
    watchId: envelope.watchId,
  };
}

export function parseAutopilotOwnerEnvelope(value: string) {
  const parsed = JSON.parse(value) as AutopilotOwnerEnvelope;
  if (
    parsed.schema !== 'neondeck.autopilot-owner-envelope.v1' ||
    !parsed.watchId ||
    !parsed.repoId ||
    !parsed.repoFullName ||
    !Number.isInteger(parsed.prNumber) ||
    !parsed.eventFingerprint
  ) {
    throw new Error('Invalid Autopilot owner delivery envelope.');
  }
  return parsed;
}
