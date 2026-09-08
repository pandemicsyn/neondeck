import * as v from 'valibot';
import {
  storedRepoWorkflowProposalSchema,
  repoWorkflowsSnapshotSchema,
} from '../../../../shared/repo-workflows';

// Drafts can be incomplete while typing; saved configuration uses the stricter
// shared schema. Storage validates only a bounded, versioned editing shape.
const text = v.pipe(v.string(), v.maxLength(20000));
const command = v.strictObject({ command: text, cwd: text });
const workflows = v.strictObject({
  defaultProfileId: v.nullable(text),
  profiles: v.pipe(
    v.array(
      v.strictObject({
        id: text,
        name: text,
        setupCommands: v.pipe(v.array(command), v.maxLength(16)),
        validationCommands: v.pipe(v.array(command), v.maxLength(16)),
        setupTimeoutMs: v.number(),
        validationTimeoutMs: v.number(),
        runtime: v.strictObject({
          node: v.optional(text),
          packageManager: v.optional(
            v.strictObject({
              name: v.picklist(['npm', 'pnpm', 'yarn', 'bun']),
              version: v.optional(text),
            }),
          ),
        }),
        environmentRefs: v.pipe(v.array(text), v.maxLength(64)),
      }),
    ),
    v.minLength(1),
    v.maxLength(8),
  ),
});
export const workflowDraftSchema = v.strictObject({
  version: v.literal(1),
  base: repoWorkflowsSnapshotSchema,
  draft: v.nullable(workflows),
  profileIndex: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(7)),
  proposal: v.nullable(storedRepoWorkflowProposalSchema),
});
export type WorkflowDraft = v.InferOutput<typeof workflowDraftSchema>;
const key = (repoId: string) => `factory-workflow-draft:${repoId}`;
const maxBytes = 256000;
export function readWorkflowDraft(
  repoId: string,
):
  | { status: 'missing' }
  | { status: 'loaded'; value: WorkflowDraft }
  | { status: 'failed' } {
  try {
    const raw = sessionStorage.getItem(key(repoId));
    if (raw === null) return { status: 'missing' };
    if (raw.length > maxBytes) return { status: 'failed' };
    const value = v.parse(workflowDraftSchema, JSON.parse(raw));
    if (value.base.repoId !== repoId) return { status: 'failed' };
    return { status: 'loaded', value };
  } catch {
    return { status: 'failed' };
  }
}
export function writeWorkflowDraft(repoId: string, input: WorkflowDraft) {
  try {
    const value = v.parse(workflowDraftSchema, input);
    if (value.base.repoId !== repoId) return false;
    const raw = JSON.stringify(value);
    if (raw.length > maxBytes) return false;
    sessionStorage.setItem(key(repoId), raw);
    return true;
  } catch {
    return false;
  }
}
export function clearWorkflowDraft(repoId: string) {
  try {
    sessionStorage.removeItem(key(repoId));
    return true;
  } catch {
    return false;
  }
}
