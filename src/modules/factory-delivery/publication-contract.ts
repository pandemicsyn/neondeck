import * as v from 'valibot';
export const label = v.pipe(v.string(), v.minLength(1), v.maxLength(4096));
export const sha = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/));
export const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
export const branch = v.pipe(
  v.string(),
  v.regex(/^agent\/factory-[a-f0-9]{64}$/),
);
export const publicationWorkspaceSchema = v.strictObject({
  pipelineId: hash,
  repoId: label,
  worktreeId: label,
  root: label,
  storageRoot: label,
  sourceRoot: label,
  branch: v.pipe(
    v.string(),
    v.regex(/^agent\/factory-[a-f0-9]{64}-revision-[a-f0-9]{64}$/),
  ),
  originalHeadSha: sha,
  treeSha: sha,
});
export type PublicationWorkspace = v.InferOutput<
  typeof publicationWorkspaceSchema
>;
export const publicationCommitSchema = v.strictObject({
  ...publicationWorkspaceSchema.entries,
  publishedHeadSha: sha,
});
export type PublicationCommit = v.InferOutput<typeof publicationCommitSchema>;
export function publicationWorkspaceFrom(
  input: PublicationWorkspace | PublicationCommit,
): PublicationWorkspace {
  const value = v.parse(
    v.union([publicationWorkspaceSchema, publicationCommitSchema]),
    input,
  );
  return v.parse(v.object(publicationWorkspaceSchema.entries), value);
}
export const publicationPushReceiptSchema = v.strictObject({
  publishedHeadSha: sha,
  remoteSha: sha,
  targetFingerprint: hash,
  alreadyPublished: v.boolean(),
});
export const publicationPushTargetSchema = v.strictObject({
  remote: v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)),
  url: label,
  repoFullName: label,
  branch,
  fingerprint: hash,
});
export type PublicationPushTarget = v.InferOutput<
  typeof publicationPushTargetSchema
>;
/** The delivery service must check the live reservation, lease, exact revision,
 * grant and effect phase. This is a mandatory server callback, never tool input.
 */
export type AssertPublicationAuthority = () => Promise<void>;
