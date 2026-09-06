import { deliveryMaxCheckCommands } from '../../../shared/factory-delivery';
import * as v from 'valibot';
import { candidateCheckEnvironmentSchema } from './verification-process';
const natural = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const sha = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/));
const command = v.pipe(v.string(), v.minLength(1), v.maxLength(2000));
const exitCode = v.nullable(v.pipe(v.number(), v.safeInteger()));

/** Persisted verifier output, shared by producer, reviewer, and bounded reader. */
export const candidateVerificationSchema = v.strictObject({
  evidenceDigest: hash,
  revision: sha,
  passed: v.boolean(),
  noWriter: v.literal(true),
  durationMs: natural,
  checks: v.pipe(
    v.array(
      v.strictObject({
        command,
        passed: v.boolean(),
        exitCode,
        truncated: v.boolean(),
        durationMs: natural,
        evidenceRef: v.nullable(v.string()),
        outputHash: v.nullable(hash),
        environment: v.optional(candidateCheckEnvironmentSchema),
      }),
    ),
    v.maxLength(deliveryMaxCheckCommands),
  ),
});
export const candidateCheckLogSchema = v.strictObject({
  command,
  evidenceDigest: hash,
  treeSha: sha,
  exitCode,
  stdout: v.pipe(v.string(), v.maxLength(1048576)),
  stderr: v.pipe(v.string(), v.maxLength(1048576)),
  stdoutTruncated: v.boolean(),
  stderrTruncated: v.boolean(),
  durationMs: natural,
  mutation: v.optional(
    v.nullable(
      v.strictObject({
        reason: v.literal('Check changed certified checkout contents'),
        expectedTreeSha: sha,
        actualTreeSha: sha,
      }),
    ),
  ),
  environment: v.optional(candidateCheckEnvironmentSchema),
});
