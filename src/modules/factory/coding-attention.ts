import { statSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { factoryCodingAttentionSchema } from '../../../shared/factory-coding';
import { openDb } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';
import { codingAuthority, codingDigest } from './coding-context';
import { publishFactoryChange } from './events';
const key = (workId: string) => `factory-coding-attention:${workId}`;
export function readCodingAttention(workId: string, paths: RuntimePaths) {
  const db = openDb(paths.neondeckDatabase);
  try {
    const row = db
      .prepare('SELECT value FROM app_metadata WHERE key=?')
      .get(key(workId));
    return row
      ? v.parse(
          factoryCodingAttentionSchema,
          JSON.parse(v.parse(v.string(), row.value)),
        )
      : null;
  } finally {
    db.close();
  }
}
export function saveCodingAttention(
  workId: string,
  inputFingerprint: string,
  reason: string,
  paths: RuntimePaths,
) {
  const attention = v.parse(factoryCodingAttentionSchema, {
    workId,
    inputFingerprint,
    reason,
    updatedAt: new Date().toISOString(),
  });
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare(
      'INSERT INTO app_metadata(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
    ).run(key(workId), JSON.stringify(attention), attention.updatedAt);
  } finally {
    db.close();
  }
  publishFactoryChange();
}
export function clearCodingAttention(workId: string, paths: RuntimePaths) {
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare('DELETE FROM app_metadata WHERE key=?').run(key(workId));
  } finally {
    db.close();
  }
}
function stamp(path: string) {
  try {
    const stat = statSync(path);
    return { mtime: stat.mtimeMs, size: stat.size, ino: stat.ino };
  } catch {
    return null;
  }
}
/** Cheap retry key. No Git subprocess or skill/memory content reads. A deliberate
 * context refresh/new release retries changed selections; unrelated learning does not. */
export function codingAdmissionFingerprint(
  workId: string,
  paths: RuntimePaths,
) {
  const { release, current, repo, coding } = codingAuthority(workId, paths);
  return codingDigest({
    release,
    source: current.source,
    repo,
    coding,
    files: [
      repo.path,
      join(repo.path, '.git'),
      join(repo.path, '.git', 'HEAD'),
      join(repo.path, '.git', 'packed-refs'),
      join(repo.path, '.git', 'refs', 'heads'),
      join(repo.path, '.git', 'refs', 'heads', repo.defaultBranch),
      paths.skills,
      coding.executable ?? '',
    ].map(stamp),
  });
}
export function currentCodingAttention(workId: string, paths: RuntimePaths) {
  const attention = readCodingAttention(workId, paths);
  if (!attention) return null;
  try {
    return attention.inputFingerprint ===
      codingAdmissionFingerprint(workId, paths)
      ? attention
      : null;
  } catch {
    return null;
  }
}
