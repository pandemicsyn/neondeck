import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { safeReference } from './repo-reference';

const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const proposalFields = {
  inputHash: hash,
  result: v.strictObject({
    version: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    hash,
  }),
};
const readFields = {
  path: v.pipe(v.string(), v.check(safeReference)),
  commit: v.pipe(v.string(), v.regex(/^[a-f0-9]{40,64}$/)),
};
export const triageTokensSchema = v.pipe(v.number(), v.finite(), v.minValue(0));
export const planningEffectSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('proposal'), ...proposalFields }),
  v.strictObject({ kind: v.literal('repo-read'), ...readFields }),
  v.strictObject({
    kind: v.literal('triage-usage'),
    tokens: triageTokensSchema,
  }),
]);
export type PlanningEffect = v.InferOutput<typeof planningEffectSchema>;
const legacyProposalSchema = v.strictObject(proposalFields);
const legacyReadSchema = v.strictObject(readFields);

/** Existing receipts had no tag. Accept only their exact validated shapes;
 * unknown tags, mixed variants and corrupt records fail closed, without rewriting history. */
export function decodePlanningEffect(record: unknown): PlanningEffect {
  const value: unknown = JSON.parse(v.parse(v.string(), record));
  const proposal = v.safeParse(legacyProposalSchema, value);
  if (proposal.success) return { kind: 'proposal', ...proposal.output };
  const read = v.safeParse(legacyReadSchema, value);
  if (read.success) return { kind: 'repo-read', ...read.output };
  return v.parse(planningEffectSchema, value);
}
export function readPlanningEffect(
  db: DatabaseSync,
  id: string,
  intentId: string,
) {
  const row = db
    .prepare(
      'SELECT record FROM factory_planning_effects WHERE id=? AND intent_id=?',
    )
    .get(id, intentId);
  return row ? decodePlanningEffect(row.record) : null;
}
export function readPlanningEffects(db: DatabaseSync, intentId: string) {
  return db
    .prepare('SELECT record FROM factory_planning_effects WHERE intent_id=?')
    .all(intentId)
    .map((row) => decodePlanningEffect(row.record));
}
export function writePlanningEffect(
  db: DatabaseSync,
  id: string,
  intentId: string,
  effect: PlanningEffect,
  idempotent = false,
) {
  const validated = v.parse(planningEffectSchema, effect);
  if (idempotent) {
    const previous = readPlanningEffect(db, id, intentId);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(validated))
        throw new Error('Planning effect retry differs from retained receipt.');
      return;
    }
  }
  db.prepare(
    'INSERT INTO factory_planning_effects (id,intent_id,record) VALUES (?,?,?)',
  ).run(id, intentId, JSON.stringify(validated));
}
