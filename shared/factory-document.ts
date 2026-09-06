import type { FactoryRevision, FactorySpec } from './factory';
import type { FactoryDiscussionReference } from './factory-planning';

export const factorySections = [
  ['outcome', 'Outcome'],
  ['scope', 'Scope'],
  ['nonGoals', 'Non-goals'],
  ['approach', 'Approach'],
  ['constraints', 'Constraints'],
  ['assumptions', 'Assumptions'],
] as const;
export function factoryDiscussionText(
  spec: FactorySpec,
  ref: Pick<FactoryDiscussionReference, 'kind' | 'id'>,
) {
  if (ref.kind === 'section') {
    const section = factorySections.find(([id]) => id === ref.id);
    return section ? { label: section[1], text: spec[section[0]] } : null;
  }
  if (ref.kind === 'criterion') {
    const criterion = spec.acceptanceCriteria.find((c) => c.id === ref.id);
    return criterion
      ? { label: `Criterion ${criterion.id}`, text: criterion.text }
      : null;
  }
  const decision = spec.decisions.find((d) => d.id === ref.id);
  return decision
    ? {
        label: `Decision ${decision.id}`,
        text: `${decision.question}\n${decision.answer ?? 'Unresolved'}`,
      }
    : null;
}
export function factoryDiscussionReference(
  revision: FactoryRevision,
  kind: FactoryDiscussionReference['kind'],
  id: string,
): FactoryDiscussionReference {
  return { version: revision.version, hash: revision.hash, kind, id };
}
