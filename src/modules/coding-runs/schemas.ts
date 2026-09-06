import * as v from 'valibot';
import { codingLabelSchema } from '../../../shared/coding-runs';
export const codingRunRowSchema = v.object({
  sequence: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  run_id: codingLabelSchema,
  attempt_id: codingLabelSchema,
  request_id: codingLabelSchema,
  work_item_id: codingLabelSchema,
  release_id: codingLabelSchema,
  worktree_id: v.nullable(codingLabelSchema),
  writer_slot: v.nullable(v.literal(1)),
  record_json: v.string(),
});
