import { createHash } from 'node:crypto';
import * as v from 'valibot';
import {
  progressEvidenceInputSchema,
  progressEvidencePacketSchema,
  type ProgressEvidencePacket,
} from '../../../shared/factory-progress-packet';
export * from '../../../shared/factory-progress-packet';
export function progressDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function snapshotProgressEvidence(raw: unknown): ProgressEvidencePacket {
  const input = v.parse(progressEvidenceInputSchema, raw);
  if (
    !input.candidates.some(
      (c) => progressDigest(c.revision) === progressDigest(input.revision),
    )
  )
    throw new Error('Current revision missing from progress history');
  if (
    new Set(input.candidates.map((c) => progressDigest(c.revision))).size !==
    input.candidates.length
  )
    throw new Error('Duplicate progress candidate');
  if (
    input.priorRepairs.length !== input.repairOrdinal - 1 ||
    input.priorRepairs.some((r, i) => r.ordinal !== i + 1)
  )
    throw new Error('Progress repair history ordinal mismatch');
  const scope = (revision: ProgressEvidencePacket['revision']) =>
    progressDigest([
      revision.releaseId,
      revision.specVersion,
      revision.specHash,
      revision.baseSha,
    ]);
  if (
    [
      ...input.candidates.map((c) => c.revision),
      ...input.priorRepairs.map((r) => r.revision),
    ].some((r) => scope(r) !== scope(input.revision))
  )
    throw new Error('Progress history released scope mismatch');
  const refs = input.candidates.flatMap((c) =>
    c.observations.map((o) => o.ref),
  );
  if (new Set(refs).size !== refs.length)
    throw new Error('Ambiguous progress evidence references');
  const bound = {
    ...input,
    fingerprints: input.candidates.map((c) => ({
      revision: c.revision,
      candidate: progressDigest(c.revision.treeSha),
      failures: progressDigest(c.observations.map((o) => o.fingerprint).sort()),
    })),
  };
  if (Buffer.byteLength(JSON.stringify(bound)) > 512000)
    throw new Error('Progress packet exceeds bounded history budget');
  return freeze(
    v.parse(progressEvidencePacketSchema, {
      ...bound,
      evidenceDigest: progressDigest(bound),
    }),
  );
}
export function validateProgressPacket(raw: unknown) {
  const packet = v.parse(progressEvidencePacketSchema, raw);
  const {
    fingerprints: _fingerprints,
    evidenceDigest: _digest,
    ...input
  } = packet;
  const expected = snapshotProgressEvidence(input);
  if (JSON.stringify(expected) !== JSON.stringify(packet))
    throw new Error('Progress snapshot digest or fingerprints mismatch');
  return expected;
}
export function progressEvidenceRefs(packet: ProgressEvidencePacket) {
  return [
    'released-brief',
    'proposed-instructions',
    'remaining-budget',
    ...packet.candidates.flatMap((c) => [
      `candidate:${c.revision.candidateDigest}`,
      ...c.observations.map((o) => o.ref),
    ]),
    ...packet.priorRepairs.map((r) => `repair:${r.ordinal}`),
    ...packet.missingEvidence.map((_, i) => `missing:${i}`),
    ...packet.omittedEvidence.map((_, i) => `omitted:${i}`),
  ];
}
