import * as v from 'valibot';
import {
  codingRunRecordSchema,
  type CodingRunRecord,
} from '../../../shared/coding-runs';
import { codingRunRowSchema } from './schemas';

const terminal = (r: CodingRunRecord) =>
  ['candidate', 'failed', 'cancelled'].includes(r.status);

/** Pure canonical persisted-row validation; grants no execution authority. */
export function decodeCodingRunRow(row: unknown) {
  const stored = v.parse(codingRunRowSchema, row);
  const record = v.parse(codingRunRecordSchema, JSON.parse(stored.record_json));
  if (
    stored.run_id !== record.runId ||
    stored.attempt_id !== record.attemptId ||
    stored.worktree_id !== (record.workspace?.worktreeId ?? null) ||
    stored.request_id !== record.snapshot.requestId ||
    stored.work_item_id !== record.snapshot.workItemId ||
    stored.release_id !== record.snapshot.releaseId ||
    (stored.writer_slot === null) !== terminal(record)
  )
    throw new Error('Corrupt coding run identity');
  return { sequence: stored.sequence, record };
}
