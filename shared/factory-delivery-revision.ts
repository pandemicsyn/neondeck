import * as v from 'valibot';
const label = v.pipe(v.string(), v.minLength(1), v.maxLength(500));
const version = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const sha = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/));
export const deliveryRevisionSchema = v.strictObject({
  runId: label,
  attemptId: label,
  releaseId: label,
  specVersion: version,
  specHash: hash,
  candidateDigest: hash,
  baseSha: sha,
  headSha: sha,
  treeSha: sha,
});
