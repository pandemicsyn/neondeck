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

it('skips confirmed and awaiting echoes before selecting external, legacy and deletion context', () => {
  dbRun(setup.paths, (db) => {
    putComment(db, comment('confirmed', { echo: 'confirmed' }));
    putComment(db, comment('awaiting', { echo: 'awaiting-receipt' }));
    putComment(db, comment('external', { echo: 'external' }));
    const legacy = comment('legacy');
    // Persist the old format directly, omitting the schema output defaults.
    db.prepare(
      'INSERT INTO factory_github_comments(id,work_id,record) VALUES(?,?,?)',
    ).run(
      legacy.id,
      workId,
      JSON.stringify({ ...legacy, echo: undefined, authorId: undefined }),
    );
    putComment(db, comment('deletion', { echo: 'external', deleted: true }));

    expect(pendingGitHubComments(db, workId).map((row) => row.id)).toEqual([
      'external',
    ]);
    putComment(db, comment('external', { intentId: 'external-intent' }));
    expect(pendingGitHubComments(db, workId)).toEqual([
      expect.objectContaining({
        id: 'legacy',
        echo: 'external',
        authorId: null,
      }),
    ]);
    putComment(db, comment('legacy', { intentId: 'legacy-intent' }));
    expect(pendingGitHubComments(db, workId)).toEqual([
      expect.objectContaining({
        id: 'deletion',
        echo: 'external',
        deleted: true,
      }),
    ]);
    putComment(
      db,
      comment('deletion', { deleted: true, intentId: 'deletion-intent' }),
    );
    expect(pendingGitHubComments(db, workId)).toEqual([]);
    // Queue traversal does not resolve, mark handled or otherwise mutate echoes.
    const echoes = db
      .prepare(
        "SELECT record FROM factory_github_comments WHERE id IN ('confirmed','awaiting') ORDER BY rowid",
      )
      .all()
      .map((row) =>
        v.parse(
          commentRecordSchema,
          JSON.parse(v.parse(v.string(), row.record)),
        ),
      );
    expect(echoes).toEqual([
      comment('confirmed', { echo: 'confirmed' }),
      comment('awaiting', { echo: 'awaiting-receipt' }),
    ]);
  });
});

it('does not decode excluded echo rows ahead of an eligible external comment', () => {
  dbRun(setup.paths, (db) => {
    const insert = db.prepare(
      'INSERT INTO factory_github_comments(id,work_id,record) VALUES(?,?,?)',
    );
    // These would fail full schema decoding; SQL must exclude both before LIMIT.
    insert.run(
      'confirmed-poison',
      workId,
      JSON.stringify({ echo: 'confirmed', intentId: null }),
    );
    insert.run(
      'awaiting-poison',
      workId,
      JSON.stringify({ echo: 'awaiting-receipt', intentId: '' }),
    );
    putComment(db, comment('external'));
    expect(pendingGitHubComments(db, workId).map((row) => row.id)).toEqual([
      'external',
    ]);
  });
});
