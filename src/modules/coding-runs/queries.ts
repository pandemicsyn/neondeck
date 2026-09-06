import * as v from 'valibot';
import { codingLabelSchema } from '../../../shared/coding-runs';
import type { RuntimePaths } from '../../runtime-home';
import { getCodingRun, listCodingRuns } from './store';
import { openDb } from '../../lib/sqlite';
type Paths = Pick<RuntimePaths, 'neondeckDatabase'>;

/** Reuse the bounded, indexed and validated store query; no history scan. */
export function latestCodingRunForWorkItem(
  workItemId: unknown,
  paths: Pick<RuntimePaths, 'neondeckDatabase'>,
) {
  const id = v.parse(codingLabelSchema, workItemId);
  return (
    listCodingRuns({ workItemId: id, order: 'desc', limit: 1 }, paths)[0]
      ?.record ?? null
  );
}

function selectRun(
  column: 'writer_slot' | 'release_id',
  value: string | number,
  paths: Paths,
) {
  const database = openDb(
    v.parse(v.pipe(v.string(), v.minLength(1)), paths.neondeckDatabase),
  );
  let runId: string | null = null;
  try {
    // Both columns have unique indexes. Fetch only the ID, not historical snapshots.
    const row = database
      .prepare(`SELECT run_id FROM coding_runs WHERE ${column} = ? LIMIT 1`)
      .get(value);
    if (row)
      runId = v.parse(v.object({ run_id: codingLabelSchema }), row).run_id;
  } finally {
    database.close();
  }
  return runId === null ? null : getCodingRun(runId, paths);
}

/** Includes quarantined ownership; elapsed time never makes the slot available. */
export function getActiveCodingRun(paths: Paths) {
  return selectRun('writer_slot', 1, paths);
}

/** Exact release identity lookup, including completed attempts. */
export function getCodingRunForRelease(releaseId: unknown, paths: Paths) {
  return selectRun('release_id', v.parse(codingLabelSchema, releaseId), paths);
}
