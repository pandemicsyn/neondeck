import * as v from 'valibot';
const label = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const natural = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const startRepoWorkflowRunSchema = v.strictObject({
  profileId: label,
  expectedFingerprint: hash,
});
export const repoWorkflowRunLogSchema = v.strictObject({
  phase: v.picklist(['setup', 'validation']),
  command: v.pipe(v.string(), v.maxLength(2000)),
  cwd: v.pipe(v.string(), v.maxLength(1000)),
  exitCode: v.nullable(v.pipe(v.number(), v.safeInteger())),
  output: v.pipe(v.string(), v.maxLength(16384)),
  durationMs: natural,
  truncated: v.boolean(),
});
export const repoWorkflowRunSchema = v.strictObject({
  runId: label,
  repoId: label,
  profileId: label,
  workflowFingerprint: hash,
  status: v.picklist([
    'running',
    'passed',
    'failed',
    'setup-blocked',
    'cancelled',
    'uncertain',
  ]),
  baseSha: v.nullable(v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/))),
  phase: v.picklist(['setup', 'validation', 'cleanup', 'complete']),
  logs: v.pipe(v.array(repoWorkflowRunLogSchema), v.maxLength(32)),
  cleanup: v.picklist(['pending', 'complete', 'retained']),
  guidance: v.pipe(v.string(), v.maxLength(1000)),
  startedAt: v.pipe(v.string(), v.isoTimestamp()),
  finishedAt: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
});
export type RepoWorkflowRun = v.InferOutput<typeof repoWorkflowRunSchema>;
export type RepoWorkflowRunLog = v.InferOutput<typeof repoWorkflowRunLogSchema>;
