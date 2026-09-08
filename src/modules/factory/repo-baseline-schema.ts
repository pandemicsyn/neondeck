import * as v from 'valibot';

export const commitSchema = v.pipe(
  v.string(),
  v.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
);
export const retainedRefSchema = v.pipe(
  v.string(),
  v.regex(/^refs\/neondeck\/factory\/commits\/(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
);
export const temporaryRefSchema = v.pipe(
  v.string(),
  v.regex(/^refs\/neondeck\/factory\/fetch\/[a-f0-9-]{36}$/),
);
export const factoryRepoBaselineSchema = v.object({
  source: v.picklist(['origin', 'local-default-branch']),
  branch: v.pipe(v.string(), v.minLength(1)),
  ref: v.optional(retainedRefSchema),
});
export type FactoryRepoBaseline = {
  repoCommit: string | null;
  repoBaseline?: v.InferOutput<typeof factoryRepoBaselineSchema>;
};
