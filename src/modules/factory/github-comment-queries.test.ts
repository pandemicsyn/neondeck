import { afterEach, beforeEach, expect, it } from 'vitest';
import * as v from 'valibot';
import { dbRun, submitFactoryWork } from './service';
import { fixture } from './testing/github-fixture';
import {
  missingGitHubComments,
  pendingGitHubComments,
  putComment,
  commentRecordSchema,
  type CommentRecord,
} from './github-store';

let setup: ReturnType<typeof fixture>;
let workId: string;
let otherWorkId: string;
beforeEach(() => {
  setup = fixture();
  const submit = (key: string) =>
    submitFactoryWork(
      { requestKey: key, title: key, body: '', repoId: null },
      { kind: 'human', id: 'local-operator' },
      setup.paths,
    ).work.id;
  workId = submit('current');
  otherWorkId = submit('other');
});
afterEach(() => setup.dispose());
const comment = (
  id: string,
  fields: Partial<CommentRecord> = {},
): CommentRecord =>
  v.parse(commentRecordSchema, {
    id,
    workId,
    remoteId: id,
    body: 'Synthetic comment',
    author: 'fixture',
    remoteUpdatedAt: '2026-09-01T00:00:00Z',
    fingerprint: id,
    version: 1,
    deleted: false,
    seenScan: 'old',
    intentId: null,
    ...fields,
  });

it('confirms only the first undeleted comment missing from the current work scan', () => {
  dbRun(setup.paths, (db) => {
    putComment(db, comment('other', { workId: otherWorkId }));
    putComment(db, comment('deleted', { deleted: true }));
    putComment(db, comment('seen', { seenScan: 'current' }));
    putComment(db, comment('first', { intentId: 'already-delivered' }));
    putComment(db, comment('second'));
    expect(
      missingGitHubComments(db, workId, 'current').map((row) => row.id),
    ).toEqual(['first']);
    putComment(
      db,
      comment('first', { seenScan: 'current', intentId: 'already-delivered' }),
    );
    expect(
      missingGitHubComments(db, workId, 'current').map((row) => row.id),
    ).toEqual(['second']);
    putComment(db, comment('second', { deleted: true }));
    expect(missingGitHubComments(db, workId, 'current')).toEqual([]);
  });
});

it('delivers one pending revision in insertion order including deletion and empty intent ids', () => {
  dbRun(setup.paths, (db) => {
    putComment(db, comment('other', { workId: otherWorkId }));
    putComment(db, comment('handled', { intentId: 'retained-intent' }));
    putComment(db, comment('deleted', { deleted: true, seenScan: 'current' }));
    putComment(db, comment('empty', { intentId: '' }));
    expect(pendingGitHubComments(db, workId).map((row) => row.id)).toEqual([
      'deleted',
    ]);
    putComment(
      db,
      comment('deleted', { deleted: true, intentId: 'deletion-intent' }),
    );
    expect(pendingGitHubComments(db, workId).map((row) => row.id)).toEqual([
      'empty',
    ]);
    putComment(db, comment('empty', { intentId: 'now-handled' }));
    expect(pendingGitHubComments(db, workId)).toEqual([]);
  });
});

it('does not decode unrelated, ineligible or beyond-limit records', () => {
  dbRun(setup.paths, (db) => {
    const insert = db.prepare(
      'INSERT INTO factory_github_comments(id,work_id,record) VALUES(?,?,?)',
    );
    insert.run('other-poison', otherWorkId, 'invalid-json');
    // Valid JSON with invalid schema: only eligibility fields may be inspected.
    insert.run(
      'ineligible-poison',
      workId,
      JSON.stringify({ deleted: true, seenScan: 'current', intentId: 'done' }),
    );
    putComment(db, comment('candidate'));
    insert.run(
      'later-poison',
      workId,
      JSON.stringify({ deleted: false, seenScan: 'old', intentId: null }),
    );
    expect(
      missingGitHubComments(db, workId, 'current').map((row) => row.id),
    ).toEqual(['candidate']);
    expect(pendingGitHubComments(db, workId).map((row) => row.id)).toEqual([
      'candidate',
    ]);
  });
});

it('rejects a selected record that fails the full comment schema', () => {
  dbRun(setup.paths, (db) => {
    db.prepare(
      'INSERT INTO factory_github_comments(id,work_id,record) VALUES(?,?,?)',
    ).run(
      'invalid',
      workId,
      JSON.stringify({ deleted: false, seenScan: 'old', intentId: null }),
    );
    expect(() => missingGitHubComments(db, workId, 'current')).toThrow(
      v.ValiError,
    );
    expect(() => pendingGitHubComments(db, workId)).toThrow(v.ValiError);
  });
});
