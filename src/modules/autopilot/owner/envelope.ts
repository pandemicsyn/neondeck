import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import { prEventJsonValueSchema } from '../../pr-events';

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

const autopilotOwnerEnvelopeSchema = v.object({
  schema: v.literal('neondeck.autopilot-owner-envelope.v1'),
  watchId: v.pipe(v.string(), v.minLength(1)),
  repoId: v.pipe(v.string(), v.minLength(1)),
  repoFullName: v.pipe(v.string(), v.minLength(1)),
  prNumber: v.pipe(v.number(), v.integer()),
  worktreeId: v.string(),
  worktreePath: v.string(),
  headSha: v.string(),
  baseSha: v.string(),
  eventFingerprint: v.pipe(v.string(), v.minLength(1)),
  mode: v.string(),
  facts: prEventJsonValueSchema,
  availableCapabilities: v.array(v.string()),
});

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
  return v.parse(autopilotOwnerEnvelopeSchema, JSON.parse(value));
}
