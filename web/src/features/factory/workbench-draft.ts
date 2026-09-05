import * as v from 'valibot';
import { saveSpecSchema } from '../../../../shared/factory';
import { discussionReferenceSchema } from '../../../../shared/factory-planning';
// Editor drafts may be incomplete (for example a newly added blank criterion).
// Validate their shape, but only the normal spec API validates a saved revision.
const draftSpecSchema = v.object({
  outcome: v.string(),
  scope: v.string(),
  nonGoals: v.string(),
  approach: v.string(),
  constraints: v.string(),
  assumptions: v.string(),
  acceptanceCriteria: v.array(v.object({ id: v.string(), text: v.string() })),
  decisions: v.array(
    v.object({
      id: v.string(),
      question: v.string(),
      blocking: v.boolean(),
      answer: v.nullable(v.string()),
    }),
  ),
  references: v.array(
    v.object({ path: v.string(), commit: v.string(), note: v.string() }),
  ),
});
const savedWorkbenchSchema = v.object({
  viewedVersion: v.number(),
  compareVersion: v.number(),
  compare: v.boolean(),
  workbenchView: v.picklist(['chat', 'brief']),
  discussion: v.optional(discussionReferenceSchema),
  editor: v.nullable(
    v.object({
      spec: draftSpecSchema,
      version: saveSpecSchema.entries.expectedVersion,
      specVersion: saveSpecSchema.entries.expectedSpecVersion,
      repoFingerprint: saveSpecSchema.entries.expectedRepoFingerprint,
    }),
  ),
});
export type WorkbenchDraft = v.InferOutput<typeof savedWorkbenchSchema>;
const key = (id: string) => `factory-workbench:${id}`;
export function readWorkbenchDraft(id: string): WorkbenchDraft | undefined {
  try {
    const stored = sessionStorage.getItem(key(id));
    return stored
      ? v.parse(savedWorkbenchSchema, JSON.parse(stored))
      : undefined;
  } catch {
    return undefined;
  }
}
export function writeWorkbenchDraft(id: string, value: WorkbenchDraft) {
  try {
    sessionStorage.setItem(key(id), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
